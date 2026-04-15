import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { IPC_CHANNELS } from '../shared/ipc'
import { scanDicomFolder } from './dicomScanner'
import { runtimeInstanceConfig } from './runtimeInstance'
import {
  configureEvaluationMetrics,
  exportEvaluationSession,
  getEvaluationExportReadiness,
  logEvaluationEvent,
  recordTransferChunkBytes
} from './evaluationMetrics'
import { configurePeerDiscovery, getPeerDiscoveryState, startPeerDiscovery, stopPeerDiscovery } from './peerDiscovery'
import {
  acceptStudyOffer,
  clearTransferInbox,
  configureTransferInboxDirectory,
  configureTransferServerPort,
  connectToTransferPeer,
  disconnectTransferPeer,
  getTransferSessionState,
  setTransferOfferCompletedListener,
  setTransferOfferFailedListener,
  setTransferStateListener,
  sendStudyOffer,
  setTransferChunkMetricsListener,
  startTransferServer,
  stopTransferServer
} from './transferSession'
import type { EvaluationExportResult, StudyManifestSummary, TransferSessionState } from '../shared/types'
import { devLogger } from './logger'

const isLocalDevLaunch = Boolean(process.env.ELECTRON_RENDERER_URL)
const autoIsolatedLocalInstanceId =
  !runtimeInstanceConfig.instanceId && isLocalDevLaunch && !app.requestSingleInstanceLock()
    ? `local-${process.pid}`
    : null

const effectiveInstanceId = runtimeInstanceConfig.instanceId ?? autoIsolatedLocalInstanceId
const effectiveDisplaySuffix = effectiveInstanceId ? ` [${effectiveInstanceId}]` : ''
const effectivePreferredTransferPort =
  runtimeInstanceConfig.instanceId === effectiveInstanceId
    ? runtimeInstanceConfig.preferredTransferPort
    : runtimeInstanceConfig.preferredTransferPort + (process.pid % 100)

if (effectiveInstanceId) {
  const effectiveUserDataPath = path.join(app.getPath('userData'), `instance-${effectiveInstanceId}`)
  app.setPath('userData', effectiveUserDataPath)
  app.setPath('sessionData', path.join(effectiveUserDataPath, 'session-data'))
}

let mainWindow: BrowserWindow | null = null
let allowedLocalDicomPaths = new Set<string>()
let allowedReceivedDicomPaths = new Set<string>()
let allowedTransferFiles = new Map<string, string>()
let dicomReadCache = new Map<string, Uint8Array>()
const receiveOfferStudyIds = new Map<string, string>()
const sendOfferStudyIds = new Map<string, string>()
const authoritativeStudyIdsByCorrelation = new Map<string, string>()

const MAX_STUDIES_PER_OFFER = 300
const MAX_SERIES_PER_OFFER = 5000
const MAX_FILES_PER_OFFER = 30000
const MAX_LABEL_LENGTH = 256
const MAX_TEXT_FIELD_LENGTH = 512
const MAX_DICOM_READ_CACHE_ENTRIES = 128
const MAX_DICOM_READ_CACHE_FILE_SIZE_BYTES = 8 * 1024 * 1024

type ResolvedOfferFileInput = {
  fileId: string
  fileName: string
  sizeBytes: number
  transferFileId: string
  sourcePath: string
  studyInstanceUID: string
  seriesInstanceUID: string
  sopInstanceUID: string
  transferSyntaxUID?: string
  instanceNumber?: number
}

function issueAuthoritativeStudyId(
  workflowMode: 'local' | 'p2p_send' | 'p2p_receive',
  correlationId?: string
) {
  const key =
    typeof correlationId === 'string' && correlationId.trim().length > 0
      ? `${workflowMode}:${correlationId.trim()}`
      : undefined

  if (key) {
    const existing = authoritativeStudyIdsByCorrelation.get(key)
    if (existing) {
      return existing
    }
  }

  const created = `${workflowMode}-${randomUUID()}`
  if (key) {
    authoritativeStudyIdsByCorrelation.set(key, created)
  }

  return created
}

function assertString(value: unknown, fieldName: string, maxLength = MAX_TEXT_FIELD_LENGTH): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${fieldName}`)
  }

  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`Invalid ${fieldName}`)
  }

  return normalized
}

function assertNonNegativeInteger(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${fieldName}`)
  }

  return value
}

function assertOptionalString(value: unknown, fieldName: string, maxLength = MAX_TEXT_FIELD_LENGTH) {
  if (typeof value === 'undefined') {
    return undefined
  }

  return assertString(value, fieldName, maxLength)
}

function assertPossiblyEmptyString(value: unknown, fieldName: string, maxLength = MAX_TEXT_FIELD_LENGTH): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${fieldName}`)
  }

  const normalized = value.trim()
  if (normalized.length > maxLength) {
    throw new Error(`Invalid ${fieldName}`)
  }

  return normalized
}

function assertOptionalTrimmedString(value: unknown, fieldName: string, maxLength = MAX_TEXT_FIELD_LENGTH) {
  if (typeof value === 'undefined') {
    return undefined
  }

  const normalized = assertPossiblyEmptyString(value, fieldName, maxLength)
  return normalized.length > 0 ? normalized : undefined
}

function validatePort(port: unknown): number | undefined {
  if (typeof port === 'undefined') {
    return undefined
  }

  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid transfer peer port')
  }

  return port
}

function validateAddress(address: unknown): string {
  const normalized = assertString(address, 'transfer peer address', 255)
  const hostOrIp = /^[a-zA-Z0-9.:-]+$/
  if (!hostOrIp.test(normalized)) {
    throw new Error('Invalid transfer peer address')
  }

  return normalized
}

function validateStudySummaries(input: unknown): StudyManifestSummary[] {
  if (!Array.isArray(input)) {
    throw new Error('Invalid studies payload')
  }

  if (input.length > MAX_STUDIES_PER_OFFER) {
    throw new Error('Study offer exceeds study limit')
  }

  return input.map((study, studyIndex) => {
    const candidate = study as Record<string, unknown>
    const series = candidate.series
    if (!Array.isArray(series)) {
      throw new Error(`Invalid studies[${studyIndex}].series`)
    }

    if (series.length > MAX_SERIES_PER_OFFER) {
      throw new Error('Study offer exceeds series limit')
    }

    return {
      studyInstanceUID: assertString(candidate.studyInstanceUID, `studies[${studyIndex}].studyInstanceUID`),
      patientName: assertPossiblyEmptyString(candidate.patientName, `studies[${studyIndex}].patientName`),
      series: series.map((seriesItem, seriesIndex) => {
        const seriesCandidate = seriesItem as Record<string, unknown>
        return {
          seriesInstanceUID: assertString(
            seriesCandidate.seriesInstanceUID,
            `studies[${studyIndex}].series[${seriesIndex}].seriesInstanceUID`
          ),
          modality: assertPossiblyEmptyString(
            seriesCandidate.modality,
            `studies[${studyIndex}].series[${seriesIndex}].modality`,
            64
          ),
          seriesDescription: assertOptionalTrimmedString(
            seriesCandidate.seriesDescription,
            `studies[${studyIndex}].series[${seriesIndex}].seriesDescription`
          ),
          instanceCount: assertNonNegativeInteger(
            seriesCandidate.instanceCount,
            `studies[${studyIndex}].series[${seriesIndex}].instanceCount`
          )
        }
      })
    }
  })
}

async function resolveOfferFiles(input: unknown): Promise<ResolvedOfferFileInput[]> {
  if (!Array.isArray(input)) {
    throw new Error('Invalid files payload')
  }

  if (input.length > MAX_FILES_PER_OFFER) {
    throw new Error('Study offer exceeds file limit')
  }

  const seenTransferFileIds = new Set<string>()

  return Promise.all(input.map(async (file, fileIndex) => {
    const candidate = file as Record<string, unknown>
    if ('sourcePath' in candidate || 'fileName' in candidate || 'sizeBytes' in candidate || 'fileId' in candidate) {
      throw new Error('Renderer payload must not include resolved file descriptors')
    }

    const transferFileId = assertString(candidate.transferFileId, `files[${fileIndex}].transferFileId`)
    if (seenTransferFileIds.has(transferFileId)) {
      throw new Error(`Duplicate transfer file id: ${transferFileId}`)
    }

    seenTransferFileIds.add(transferFileId)

    const sourcePath = allowedTransferFiles.get(transferFileId)
    if (!sourcePath) {
      throw new Error(`Unknown transfer file id: ${transferFileId}`)
    }

    const fileStat = await fs.stat(sourcePath)
    if (!fileStat.isFile()) {
      throw new Error(`Transfer source is not a file: ${transferFileId}`)
    }

    const fileName = path.basename(sourcePath)

    return {
      fileId: transferFileId,
      fileName,
      sizeBytes: fileStat.size,
      transferFileId,
      sourcePath,
      studyInstanceUID: assertString(candidate.studyInstanceUID, `files[${fileIndex}].studyInstanceUID`),
      seriesInstanceUID: assertString(candidate.seriesInstanceUID, `files[${fileIndex}].seriesInstanceUID`),
      sopInstanceUID: assertString(candidate.sopInstanceUID, `files[${fileIndex}].sopInstanceUID`),
      transferSyntaxUID: assertOptionalString(candidate.transferSyntaxUID, `files[${fileIndex}].transferSyntaxUID`, 128),
      instanceNumber:
        typeof candidate.instanceNumber === 'number'
          ? assertNonNegativeInteger(candidate.instanceNumber, `files[${fileIndex}].instanceNumber`)
          : undefined
    }
  }))
}

async function validateStudyOfferPayload(input: unknown) {
  const candidate = input as Record<string, unknown>
  const studies = validateStudySummaries(candidate.studies)
  const files = await resolveOfferFiles(candidate.files)

  const studyCount = assertNonNegativeInteger(candidate.studyCount, 'studyCount')
  const seriesCount = assertNonNegativeInteger(candidate.seriesCount, 'seriesCount')
  const instanceCount = assertNonNegativeInteger(candidate.instanceCount, 'instanceCount')

  const derivedSeriesCount = studies.reduce((total, study) => total + study.series.length, 0)
  const derivedInstanceCount = studies.reduce(
    (total, study) => total + study.series.reduce((seriesTotal, series) => seriesTotal + series.instanceCount, 0),
    0
  )

  if (studyCount !== studies.length) {
    throw new Error('Study count mismatch')
  }

  if (seriesCount !== derivedSeriesCount) {
    throw new Error('Series count mismatch')
  }

  if (instanceCount !== derivedInstanceCount) {
    throw new Error('Instance count mismatch against studies payload')
  }

  if (instanceCount !== files.length) {
    throw new Error('Instance count mismatch against files payload')
  }

  const allowedStudySeries = new Map<string, Set<string>>()
  for (const study of studies) {
    allowedStudySeries.set(
      study.studyInstanceUID,
      new Set(study.series.map((series) => series.seriesInstanceUID))
    )
  }

  for (const file of files) {
    const seriesForStudy = allowedStudySeries.get(file.studyInstanceUID)
    if (!seriesForStudy || !seriesForStudy.has(file.seriesInstanceUID)) {
      throw new Error(`File ${file.fileId} does not match the declared study/series manifest`)
    }
  }

  return {
    rootLabel: assertString(candidate.rootLabel, 'rootLabel', MAX_LABEL_LENGTH),
    studyCount,
    seriesCount,
    instanceCount,
    studies,
    files
  }
}

function collectAllowedDicomPathsFromScan(scanResult: Awaited<ReturnType<typeof scanDicomFolder>>) {
  const nextAllowedPaths = new Set<string>()
  const newAllowedTransferFiles = new Map<string, string>()
  for (const study of scanResult.studies) {
    for (const series of study.series) {
      for (const instance of series.instances) {
        const resolvedPath = path.resolve(instance.filePath)
        nextAllowedPaths.add(resolvedPath)
        if (instance.transferFileId) {
          newAllowedTransferFiles.set(instance.transferFileId, resolvedPath)
        }
      }
    }
  }

  return {
    nextAllowedPaths,
    newAllowedTransferFiles
  }
}

function updateAllowedLocalScanPaths(scanResult: Awaited<ReturnType<typeof scanDicomFolder>>) {
  const { nextAllowedPaths, newAllowedTransferFiles } = collectAllowedDicomPathsFromScan(scanResult)
  allowedLocalDicomPaths = nextAllowedPaths
  allowedTransferFiles = newAllowedTransferFiles
  dicomReadCache.clear()
}

function updateAllowedReceivedScanPaths(scanResult: Awaited<ReturnType<typeof scanDicomFolder>>) {
  const { nextAllowedPaths } = collectAllowedDicomPathsFromScan(scanResult)
  allowedReceivedDicomPaths = nextAllowedPaths
  dicomReadCache.clear()
}

function mergeAllowedReceivedDicomPaths(transferState: TransferSessionState | null) {
  if (!transferState || transferState.inboundFileTransfers.length === 0) {
    return
  }

  let didAddPath = false
  const nextAllowedPaths = new Set(allowedReceivedDicomPaths)

  for (const transfer of transferState.inboundFileTransfers) {
    if (transfer.status !== 'complete' || !transfer.savedToPath) {
      continue
    }

    const normalizedPath = path.resolve(transfer.savedToPath)
    if (!nextAllowedPaths.has(normalizedPath)) {
      nextAllowedPaths.add(normalizedPath)
      didAddPath = true
    }
  }

  if (didAddPath) {
    allowedReceivedDicomPaths = nextAllowedPaths
  }
}

function isPathWithinDirectory(candidatePath: string, directoryPath: string) {
  const relativePath = path.relative(directoryPath, candidatePath)
  return relativePath.length === 0 || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

function isReadableReceivedInboxPath(candidatePath: string, inboxDirectoryPath: string) {
  if (!isPathWithinDirectory(candidatePath, inboxDirectoryPath)) {
    return false
  }

  return !candidatePath.toLowerCase().endsWith('.part')
}

function cacheDicomRead(normalizedPath: string, content: Uint8Array) {
  if (content.byteLength > MAX_DICOM_READ_CACHE_FILE_SIZE_BYTES) {
    return
  }

  if (dicomReadCache.has(normalizedPath)) {
    dicomReadCache.delete(normalizedPath)
  }

  dicomReadCache.set(normalizedPath, content)

  while (dicomReadCache.size > MAX_DICOM_READ_CACHE_ENTRIES) {
    const oldestKey = dicomReadCache.keys().next().value
    if (!oldestKey) {
      break
    }

    dicomReadCache.delete(oldestKey)
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: `Peer-to-Peer DICOM Viewer${effectiveDisplaySuffix}`,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) {
      event.preventDefault()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle(IPC_CHANNELS.pickAndScanFolder, async () => {
  if (!mainWindow) {
    return null
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select DICOM Folder',
    properties: ['openDirectory']
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  const folderPath = result.filePaths[0]
  const scanResult = await scanDicomFolder(folderPath)
  updateAllowedLocalScanPaths(scanResult)

  const localStudyId = issueAuthoritativeStudyId('local')
  return {
    ...scanResult,
    studyId: localStudyId
  }
})

ipcMain.handle(IPC_CHANNELS.openFolderInSystem, async (_event, folderPath: string) => {
  const normalizedPath = path.resolve(assertString(folderPath, 'folderPath', 1024))
  const stats = await fs.stat(normalizedPath)
  if (!stats.isDirectory()) {
    throw new Error('Requested path is not a directory')
  }

  const shellError = await shell.openPath(normalizedPath)
  if (shellError) {
    throw new Error(shellError)
  }
})

ipcMain.handle(IPC_CHANNELS.scanTransferInbox, async () => {
  const transferState = getTransferSessionState()
  await fs.mkdir(transferState.inboxDirectory, { recursive: true })
  const scanResult = await scanDicomFolder(transferState.inboxDirectory)
  updateAllowedReceivedScanPaths(scanResult)

  return scanResult
})

ipcMain.handle(IPC_CHANNELS.clearTransferInbox, async () => {
  const nextState = await clearTransferInbox()
  allowedReceivedDicomPaths = new Set<string>()
  dicomReadCache.clear()
  return nextState
})

ipcMain.handle(IPC_CHANNELS.readDicomFile, async (_event, filePath: string) => {
  const normalizedPath = path.resolve(assertString(filePath, 'filePath', 2048))
  const isAllowedPath =
    allowedLocalDicomPaths.has(normalizedPath) || allowedReceivedDicomPaths.has(normalizedPath)

  if (!isAllowedPath) {
    const transferState = getTransferSessionState()
    const normalizedInboxDirectory = path.resolve(transferState.inboxDirectory)
    mergeAllowedReceivedDicomPaths(transferState)

    const isReceivedInboxPath = isReadableReceivedInboxPath(normalizedPath, normalizedInboxDirectory)
    if (isReceivedInboxPath) {
      allowedReceivedDicomPaths = new Set(allowedReceivedDicomPaths).add(normalizedPath)
    }

    if (!allowedLocalDicomPaths.has(normalizedPath) && !allowedReceivedDicomPaths.has(normalizedPath)) {
      throw new Error('Access denied for requested file path')
    }
  }

  const cached = dicomReadCache.get(normalizedPath)
  if (cached) {
    return cached
  }

  const buffer = await fs.readFile(normalizedPath)
  const typedBuffer = new Uint8Array(buffer)
  cacheDicomRead(normalizedPath, typedBuffer)
  return typedBuffer
})

ipcMain.handle(IPC_CHANNELS.startPeerDiscovery, async () => {
  return startPeerDiscovery()
})

ipcMain.handle(IPC_CHANNELS.stopPeerDiscovery, async () => {
  return stopPeerDiscovery()
})

ipcMain.handle(IPC_CHANNELS.getPeerDiscoveryState, () => {
  return getPeerDiscoveryState()
})

ipcMain.handle(IPC_CHANNELS.startTransferServer, async () => {
  const nextState = await startTransferServer()
  configurePeerDiscovery({
    displayNameSuffix: effectiveDisplaySuffix,
    transferPort: nextState.serverPort
  })
  return nextState
})

ipcMain.handle(IPC_CHANNELS.stopTransferServer, async () => {
  const nextState = await stopTransferServer()
  configurePeerDiscovery({
    displayNameSuffix: effectiveDisplaySuffix,
    transferPort: effectivePreferredTransferPort
  })
  return nextState
})

ipcMain.handle(IPC_CHANNELS.getTransferSessionState, () => {
  return getTransferSessionState()
})

ipcMain.handle(IPC_CHANNELS.connectToTransferPeer, async (_event, address: string, port?: number) => {
  return connectToTransferPeer(validateAddress(address), validatePort(port))
})

ipcMain.handle(IPC_CHANNELS.disconnectTransferPeer, async () => {
  return disconnectTransferPeer()
})

ipcMain.handle(
  IPC_CHANNELS.sendStudyOffer,
  async (_event, payload: unknown) => {
    const validatedPayload = await validateStudyOfferPayload(payload)
    const resolvedStudyId = issueAuthoritativeStudyId('p2p_send')

    const nextState = await sendStudyOffer(validatedPayload)

    const activeOfferId = nextState.activeOutboundOfferId
    if (activeOfferId) {
      sendOfferStudyIds.set(activeOfferId, resolvedStudyId)

      await logEvaluationEvent({
        eventType: 'transfer_started',
        workflowMode: 'p2p_send',
        studyId: resolvedStudyId,
        studyCount: validatedPayload.studyCount,
        seriesCount: validatedPayload.seriesCount,
        instanceCount: validatedPayload.instanceCount,
        details: {
          offerId: activeOfferId
        }
      })
    }

    return {
      state: nextState,
      studyId: resolvedStudyId
    }
  }
)

ipcMain.handle(IPC_CHANNELS.acceptStudyOffer, async (_event, offerId: string) => {
  const resolvedOfferId = assertString(offerId, 'offerId', 128)

  const acceptance = await acceptStudyOffer(resolvedOfferId)

  if (!acceptance.ok) {
    await logEvaluationEvent({
      eventType: 'transfer_failed',
      workflowMode: 'p2p_receive',
      errorType: 'transfer',
      details: {
        offerId: acceptance.offerId,
        reason: 'accept_study_offer_failed'
      }
    })

    throw new Error('Failed to accept study offer')
  }

  const nextState = getTransferSessionState()

  const resolvedStudyId = issueAuthoritativeStudyId('p2p_receive', resolvedOfferId)

  receiveOfferStudyIds.set(resolvedOfferId, resolvedStudyId)

  await logEvaluationEvent({
    eventType: 'offer_accepted',
    workflowMode: 'p2p_receive',
    studyId: resolvedStudyId,
    details: { offerId: resolvedOfferId }
  })

  await logEvaluationEvent({
    eventType: 'transfer_started',
    workflowMode: 'p2p_receive',
    studyId: resolvedStudyId,
    details: { offerId: resolvedOfferId }
  })

  return {
    state: nextState,
    studyId: resolvedStudyId
  }
})

ipcMain.handle(IPC_CHANNELS.getEvaluationExportReadiness, async () => {
  return getEvaluationExportReadiness()
})

ipcMain.handle(IPC_CHANNELS.getSurveyLink, async () => {
  const surveyLink = process.env.SURVEY_LINK?.trim()
  return surveyLink && surveyLink.length > 0 ? surveyLink : null
})

ipcMain.handle(IPC_CHANNELS.openSurveyLink, async () => {
  const surveyLink = process.env.SURVEY_LINK?.trim()
  if (!surveyLink || surveyLink.length === 0) {
    throw new Error('Survey link is not configured')
  }

  try {
    const parsedUrl = new URL(surveyLink)
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('Invalid survey URL protocol')
    }
  } catch (error) {
    devLogger.debug('[main] Invalid survey link configuration', error)
    throw new Error('Invalid survey link')
  }

  await shell.openExternal(surveyLink)
})

ipcMain.handle(IPC_CHANNELS.logEvaluationEvent, async (_event, payload: unknown) => {
  const candidate = payload as Record<string, unknown>
  const eventType = assertString(candidate.eventType, 'eventType', 128)
  const workflowMode = assertString(candidate.workflowMode, 'workflowMode', 32)
  if (workflowMode !== 'local' && workflowMode !== 'p2p_send' && workflowMode !== 'p2p_receive') {
    throw new Error('Invalid workflowMode')
  }
  const studyId =
    typeof candidate.studyId === 'string' && candidate.studyId.trim().length > 0
      ? assertString(candidate.studyId, 'studyId', 128)
      : undefined

  if (eventType === 'viewer_confidence_feedback' && !studyId) {
    throw new Error('viewer_confidence_feedback requires studyId')
  }

  const normalizedPayload = {
    eventType,
    workflowMode: workflowMode as 'local' | 'p2p_send' | 'p2p_receive',
    studyId,
    screen: typeof candidate.screen === 'string' ? candidate.screen : undefined,
    studyCount: typeof candidate.studyCount === 'number' ? candidate.studyCount : undefined,
    seriesCount: typeof candidate.seriesCount === 'number' ? candidate.seriesCount : undefined,
    instanceCount: typeof candidate.instanceCount === 'number' ? candidate.instanceCount : undefined,
    elapsedMs: typeof candidate.elapsedMs === 'number' ? candidate.elapsedMs : undefined,
    errorType: typeof candidate.errorType === 'string' ? candidate.errorType : undefined,
    confidenceScore: typeof candidate.confidenceScore === 'number' ? candidate.confidenceScore : undefined,
    details:
      candidate.details && typeof candidate.details === 'object' && !Array.isArray(candidate.details)
        ? (candidate.details as Record<string, unknown>)
        : undefined
  }

  await logEvaluationEvent(normalizedPayload)
})

ipcMain.handle(IPC_CHANNELS.exportEvaluationSession, async () => {
  let exportPayload
  try {
    exportPayload = exportEvaluationSession()
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to prepare evaluation export'
    } satisfies EvaluationExportResult
  }

  const defaultPath = path.join(app.getPath('documents'), `evaluation-${exportPayload.sessionId}.json`)
  const saveDialogOptions = {
    title: 'Save Evaluation Data',
    defaultPath,
    filters: [{ name: 'JSON Files', extensions: ['json'] }]
  }

  const saveResult = mainWindow
    ? await dialog.showSaveDialog(mainWindow, saveDialogOptions)
    : await dialog.showSaveDialog(saveDialogOptions)

  if (saveResult.canceled || !saveResult.filePath) {
    return {
      ok: false,
      canceled: true,
      error: 'Save canceled'
    } satisfies EvaluationExportResult
  }

  try {
    await fs.writeFile(saveResult.filePath, JSON.stringify(exportPayload, null, 2), 'utf8')
    return {
      ok: true,
      filePath: saveResult.filePath
    } satisfies EvaluationExportResult
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to write evaluation export file'
    } satisfies EvaluationExportResult
  }
})

app.whenReady().then(() => {
  configureTransferServerPort(effectivePreferredTransferPort)
  configurePeerDiscovery({
    displayNameSuffix: effectiveDisplaySuffix,
    transferPort: effectivePreferredTransferPort
  })
  void configureEvaluationMetrics(path.join(app.getPath('userData'), 'evaluation-logs'))
  configureTransferInboxDirectory(path.join(app.getPath('userData'), 'incoming-transfers'))
  setTransferChunkMetricsListener((input) => {
    recordTransferChunkBytes(input)
  })
  setTransferOfferCompletedListener((input) => {
    const mappedStudyId = input.workflowMode === 'p2p_receive'
      ? receiveOfferStudyIds.get(input.offerId)
      : sendOfferStudyIds.get(input.offerId)

    if (!mappedStudyId) {
      return
    }

    void logEvaluationEvent({
      eventType: 'transfer_completed',
      workflowMode: input.workflowMode,
      studyId: mappedStudyId,
      details: {
        offerId: input.offerId,
        transferId: input.transferId,
        totalBytes: input.totalBytes
      }
    })

    if (input.workflowMode === 'p2p_receive') {
      receiveOfferStudyIds.delete(input.offerId)
    } else {
      sendOfferStudyIds.delete(input.offerId)
    }
  })
  setTransferOfferFailedListener((input) => {
    const mappedStudyId = input.workflowMode === 'p2p_receive'
      ? receiveOfferStudyIds.get(input.offerId)
      : sendOfferStudyIds.get(input.offerId)

    if (!mappedStudyId) {
      return
    }

    void logEvaluationEvent({
      eventType: 'transfer_failed',
      workflowMode: input.workflowMode,
      studyId: mappedStudyId,
      errorType: 'transfer',
      details: {
        offerId: input.offerId,
        transferId: input.transferId,
        reason: input.reason
      }
    })

    if (input.workflowMode === 'p2p_receive') {
      receiveOfferStudyIds.delete(input.offerId)
    } else {
      sendOfferStudyIds.delete(input.offerId)
    }
  })
  setTransferStateListener((state) => {
    mergeAllowedReceivedDicomPaths(state)

    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
      return
    }

    mainWindow.webContents.send(IPC_CHANNELS.transferStateUpdated, state)
  })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  void stopPeerDiscovery()
  void stopTransferServer()
})
