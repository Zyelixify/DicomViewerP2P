import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import type {
  ReceivedStudyManifest,
  StudyOfferPayload,
  StudyOfferSummary,
  TransferManifestPayload,
  TransferSessionState
} from '../shared/types'
import { devLogger } from './logger'

const DEFAULT_TRANSFER_PORT = 37862
const PROTOCOL = 'p2p-dicom-viewer-transfer'
const CHUNK_SIZE = 512 * 1024
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024
const MAX_RECEIVE_BUFFER_BYTES = 8 * 1024 * 1024
const MAX_FILE_BYTES = 1024 * 1024 * 1024
const MAX_TOTAL_CHUNKS = 131072
const MAX_CHUNK_RESEND_REQUEST = 2048
const MAX_INBOUND_TRACKED_TRANSFERS = 30000
const SOCKET_HIGH_WATERMARK_BYTES = 1024 * 1024
const TRANSFER_STATE_NOTIFY_THROTTLE_MS = 250
const MAX_PORT_BIND_ATTEMPTS = 24
const FINALIZED_FILE_READINESS_BYTES = 220

type ResolvedOutboundTransferFileInput = {
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

type ResolvedStudyOfferPayload = Omit<StudyOfferPayload, 'files'> & {
  files: ResolvedOutboundTransferFileInput[]
}

type SessionMessage =
  | { type: 'hello'; protocol: string; peerId: string; displayName: string }
  | {
      type: 'studyOffer'
      payload: {
        offerId: string
        rootLabel: string
        studyCount: number
        seriesCount: number
        instanceCount: number
        createdAt: number
      }
    }
  | { type: 'studyAccept'; offerId: string }
  | { type: 'manifestRequest'; offerId: string }
  | {
      type: 'manifestResponse'
      offerId: string
      payload: TransferManifestPayload
    }
  | {
      type: 'fileOffer'
      transferId: string
      offerId: string
      fileId: string
      fileName: string
      totalBytes: number
      totalChunks: number
      sha256?: string
    }
  | {
      type: 'fileChunkBinary'
      transferId: string
      chunkIndex: number
      byteLength: number
    }
  | {
      type: 'fileComplete'
      transferId: string
      sha256?: string
    }
  | {
      type: 'fileChunkRequest'
      transferId: string
      chunkIndexes: number[]
    }

const localPeerId = randomUUID()
const localDisplayName = os.hostname()
let transferPort = DEFAULT_TRANSFER_PORT

let server: net.Server | null = null
let activeSocket: net.Socket | null = null
let activeRemoteAddress = ''
let activeRemoteDisplayName = 'Unknown peer'
let activeRemotePeerId = ''
let connectedAt = 0
let lastEvent = 'idle'
let inboxDirectory = path.join(process.cwd(), 'transfer-inbox')
let transferStateListener: ((state: TransferSessionState) => void) | null = null
let transferChunkMetricsListener: ((input: { offerId: string; byteLength: number }) => void) | null = null
let transferOfferCompletedListener:
  | ((input: { workflowMode: 'p2p_send' | 'p2p_receive'; offerId: string; transferId: string; totalBytes?: number }) => void)
  | null = null
let transferOfferFailedListener:
  | ((input: { workflowMode: 'p2p_send' | 'p2p_receive'; offerId: string; transferId?: string; reason: string }) => void)
  | null = null
let activeOutboundOfferId: string | null = null
let notifyThrottleTimer: NodeJS.Timeout | null = null
const terminalOfferNotifications = new Set<string>()
let lastTerminalOffer: TransferSessionState['lastTerminalOffer'] = null

const inboundStudyOffers = new Map<string, StudyOfferSummary>()
const outboundOfferPayloads = new Map<string, TransferManifestPayload>()
const outboundOfferFiles = new Map<string, ResolvedOutboundTransferFileInput[]>()
const inboundStudyManifests = new Map<string, ReceivedStudyManifest>()
type InboundTransferState = {
  transferId: string
  fileId: string
  offerId: string
  fileName: string
  totalBytes: number
  receivedBytes: number
  totalChunks: number
  receivedChunks: number
  status: 'receiving' | 'retrying' | 'complete' | 'error'
  expectedSha256?: string
  computedSha256?: string
  retryCount: number
  tempPath: string
  outputPath: string
  fileHandle?: Awaited<ReturnType<typeof fs.open>>
  rollingHash?: ReturnType<typeof createHash>
  hashSequential: boolean
  expectedNextChunkIndex: number
  receivedChunkBitmap: boolean[]
  savedToPath?: string
}

const inboundFileTransfers = new Map<string, InboundTransferState>()
const outboundTransfers = new Map<
  string,
  {
    transferId: string
    offerId: string
    fileId: string
    fileName: string
    transferFileId: string
    sourcePath: string
    totalBytes: number
    sentBytes: number
    totalChunks: number
    sentChunks: number
    sha256: string
    status: 'pending' | 'streaming' | 'complete' | 'error'
  }
>()

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => {
      hash.update(chunk)
    })
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

async function readFileChunkFromHandle(fileHandle: Awaited<ReturnType<typeof fs.open>>, chunkIndex: number) {
  const start = chunkIndex * CHUNK_SIZE
  const chunkBuffer = Buffer.alloc(CHUNK_SIZE)
  const readResult = await fileHandle.read(chunkBuffer, 0, CHUNK_SIZE, start)
  return chunkBuffer.subarray(0, readResult.bytesRead)
}

async function writeMessage(socket: net.Socket, message: SessionMessage) {
  const payload = `${JSON.stringify(message)}\n`
  if (Buffer.byteLength(payload, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new Error('Protocol message exceeds max size')
  }

  if (socket.writableLength > SOCKET_HIGH_WATERMARK_BYTES) {
    await new Promise<void>((resolve, reject) => {
      socket.once('drain', () => resolve())
      socket.once('error', reject)
    })
  }

  const isWritten = socket.write(payload)
  if (!isWritten) {
    await new Promise<void>((resolve, reject) => {
      socket.once('drain', () => resolve())
      socket.once('error', reject)
    })
  }
}

async function writeBinaryChunk(socket: net.Socket, transferId: string, chunkIndex: number, chunk: Buffer) {
  await writeMessage(socket, {
    type: 'fileChunkBinary',
    transferId,
    chunkIndex,
    byteLength: chunk.length
  })

  if (socket.writableLength > SOCKET_HIGH_WATERMARK_BYTES) {
    await new Promise<void>((resolve, reject) => {
      socket.once('drain', () => resolve())
      socket.once('error', reject)
    })
  }

  const isWritten = socket.write(chunk)
  if (!isWritten) {
    await new Promise<void>((resolve, reject) => {
      socket.once('drain', () => resolve())
      socket.once('error', reject)
    })
  }
}

async function closeFileHandleQuietly(
  fileHandle: InboundTransferState['fileHandle'],
  context: string
) {
  await fileHandle?.close().catch((error) => {
    devLogger.debug(`[transferSession] ${context}`, error)
  })
}

async function ensureFinalizedFileReadable(filePath: string) {
  const fileHandle = await fs.open(filePath, 'r')
  try {
    const previewBuffer = Buffer.alloc(FINALIZED_FILE_READINESS_BYTES)
    await fileHandle.read(previewBuffer, 0, previewBuffer.length, 0)
  } finally {
    await fileHandle.close()
  }
}

function notifyTransferChunkMetrics(offerId: string, byteLength: number) {
  if (!transferChunkMetricsListener) {
    return
  }

  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    return
  }

  try {
    transferChunkMetricsListener({ offerId, byteLength })
  } catch (error) {
    devLogger.debug('[transferSession] Transfer chunk metrics listener failed', error)
  }
}

function notifyTransferOfferCompleted(input: {
  workflowMode: 'p2p_send' | 'p2p_receive'
  offerId: string
  transferId: string
  totalBytes?: number
}) {
  if (!transferOfferCompletedListener) {
    return
  }

  try {
    transferOfferCompletedListener(input)
  } catch (error) {
    devLogger.debug('[transferSession] Transfer completion listener failed', error)
  }
}

function notifyTransferOfferFailed(input: {
  workflowMode: 'p2p_send' | 'p2p_receive'
  offerId: string
  transferId?: string
  reason: string
}) {
  if (!transferOfferFailedListener) {
    return
  }

  try {
    transferOfferFailedListener(input)
  } catch (error) {
    devLogger.debug('[transferSession] Transfer failure listener failed', error)
  }
}

function getOfferTerminalKey(workflowMode: 'p2p_send' | 'p2p_receive', offerId: string) {
  return `${workflowMode}:${offerId}`
}

function hasOfferTerminal(workflowMode: 'p2p_send' | 'p2p_receive', offerId: string) {
  return terminalOfferNotifications.has(getOfferTerminalKey(workflowMode, offerId))
}

function markOfferTerminal(workflowMode: 'p2p_send' | 'p2p_receive', offerId: string) {
  terminalOfferNotifications.add(getOfferTerminalKey(workflowMode, offerId))
}

function clearOfferTerminal(workflowMode: 'p2p_send' | 'p2p_receive', offerId: string) {
  terminalOfferNotifications.delete(getOfferTerminalKey(workflowMode, offerId))
}

function pruneOfferTransferState(workflowMode: 'p2p_send' | 'p2p_receive', offerId: string) {
  if (workflowMode === 'p2p_receive') {
    inboundStudyOffers.delete(offerId)
    inboundStudyManifests.delete(offerId)

    for (const [transferId, transfer] of inboundFileTransfers.entries()) {
      if (transfer.offerId !== offerId) {
        continue
      }

      void closeFileHandleQuietly(transfer.fileHandle, `Failed closing inbound handle for ${transfer.fileName}`)
      transfer.fileHandle = undefined
      inboundFileTransfers.delete(transferId)
    }

    clearOfferTerminal(workflowMode, offerId)
    return
  }

  outboundOfferFiles.delete(offerId)
  outboundOfferPayloads.delete(offerId)
  for (const [transferId, transfer] of outboundTransfers.entries()) {
    if (transfer.offerId === offerId) {
      outboundTransfers.delete(transferId)
    }
  }

  if (activeOutboundOfferId === offerId) {
    activeOutboundOfferId = null
  }

  clearOfferTerminal(workflowMode, offerId)
}

function maybeNotifyOfferFailed(input: {
  workflowMode: 'p2p_send' | 'p2p_receive'
  offerId: string
  reason: string
  transferId?: string
}) {
  if (hasOfferTerminal(input.workflowMode, input.offerId)) {
    return
  }

  markOfferTerminal(input.workflowMode, input.offerId)
  lastEvent = `offer failed (${input.workflowMode}:${input.offerId})`
  lastTerminalOffer = {
    workflowMode: input.workflowMode,
    offerId: input.offerId,
    status: 'failed',
    transferId: input.transferId,
    reason: input.reason,
    at: Date.now()
  }
  notifyTransferOfferFailed(input)
  pruneOfferTransferState(input.workflowMode, input.offerId)
}

function maybeNotifyReceiveOfferCompleted(offerId: string, transferId: string) {
  if (hasOfferTerminal('p2p_receive', offerId)) {
    return
  }

  const manifest = inboundStudyManifests.get(offerId)
  const expectedFileCount = manifest?.payload.instanceCount
  if (typeof expectedFileCount !== 'number' || expectedFileCount <= 0) {
    return
  }

  const transfersForOffer = [...inboundFileTransfers.values()].filter((item) => item.offerId === offerId)
  if (transfersForOffer.length < expectedFileCount) {
    return
  }

  const allComplete = transfersForOffer.every((item) => item.status === 'complete')
  if (!allComplete) {
    return
  }

  const totalBytes = transfersForOffer.reduce((total, transfer) => total + transfer.totalBytes, 0)
  markOfferTerminal('p2p_receive', offerId)
  lastEvent = `offer completed (p2p_receive:${offerId})`
  lastTerminalOffer = {
    workflowMode: 'p2p_receive',
    offerId,
    status: 'completed',
    transferId,
    at: Date.now()
  }
  notifyTransferOfferCompleted({
    workflowMode: 'p2p_receive',
    offerId,
    transferId,
    totalBytes
  })
  pruneOfferTransferState('p2p_receive', offerId)
}

function maybeNotifySendOfferCompleted(offerId: string, transferId: string) {
  if (hasOfferTerminal('p2p_send', offerId)) {
    return
  }

  const expectedFiles = outboundOfferFiles.get(offerId)
  if (!expectedFiles || expectedFiles.length === 0) {
    return
  }

  const transfersForOffer = [...outboundTransfers.values()].filter((item) => item.offerId === offerId)
  if (transfersForOffer.length < expectedFiles.length) {
    return
  }

  const allComplete = transfersForOffer.every((item) => item.status === 'complete')
  if (!allComplete) {
    return
  }

  const totalBytes = transfersForOffer.reduce((total, transfer) => total + transfer.totalBytes, 0)
  markOfferTerminal('p2p_send', offerId)
  lastEvent = `offer completed (p2p_send:${offerId})`
  lastTerminalOffer = {
    workflowMode: 'p2p_send',
    offerId,
    status: 'completed',
    transferId,
    at: Date.now()
  }
  notifyTransferOfferCompleted({
    workflowMode: 'p2p_send',
    offerId,
    transferId,
    totalBytes
  })
  pruneOfferTransferState('p2p_send', offerId)
}

function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function getReceivedFileCacheDirectory() {
  return path.join(inboxDirectory, 'received-files-cache')
}

async function ensureReceivedFilePath(fileId: string, fileName: string) {
  const cacheDirectory = getReceivedFileCacheDirectory()
  await fs.mkdir(cacheDirectory, { recursive: true })

  const extension = path.extname(fileName)
  const safeExtension = extension ? extension : '.dcm'
  return path.join(cacheDirectory, `${sanitizeFileName(fileId)}${safeExtension}`)
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      devLogger.debug(`[transferSession] Failed access check: ${filePath}`, error)
    }
    return false
  }
}

function toSocketErrorEvent(error: unknown) {
  if (!error || typeof error !== 'object') {
    return 'socket error'
  }

  const candidate = error as NodeJS.ErrnoException
  const code = typeof candidate.code === 'string' ? candidate.code : ''
  const message = typeof candidate.message === 'string' ? candidate.message : ''

  if (code && message) {
    return `socket error (${code}: ${message})`
  }

  if (code) {
    return `socket error (${code})`
  }

  if (message) {
    return `socket error (${message})`
  }

  return 'socket error'
}

function clearConnectionState(reason?: string) {
  const receiveOfferIds = new Set<string>()
  for (const offerId of inboundStudyOffers.keys()) {
    receiveOfferIds.add(offerId)
  }
  for (const offerId of inboundStudyManifests.keys()) {
    receiveOfferIds.add(offerId)
  }
  for (const transfer of inboundFileTransfers.values()) {
    receiveOfferIds.add(transfer.offerId)
  }

  const sendOfferIds = new Set<string>()
  for (const offerId of outboundOfferFiles.keys()) {
    sendOfferIds.add(offerId)
  }
  for (const transfer of outboundTransfers.values()) {
    sendOfferIds.add(transfer.offerId)
  }
  if (activeOutboundOfferId) {
    sendOfferIds.add(activeOutboundOfferId)
  }

  activeSocket = null
  activeRemoteAddress = ''
  activeRemoteDisplayName = 'Unknown peer'
  activeRemotePeerId = ''
  connectedAt = 0

  for (const transfer of inboundFileTransfers.values()) {
    if (transfer.status === 'receiving' || transfer.status === 'retrying') {
      transfer.status = 'error'
    }
    void closeFileHandleQuietly(transfer.fileHandle, `Failed closing inbound handle for ${transfer.fileName}`)
    transfer.fileHandle = undefined
  }

  for (const transfer of outboundTransfers.values()) {
    if (transfer.status === 'pending' || transfer.status === 'streaming') {
      transfer.status = 'error'
    }
  }

  inboundStudyOffers.clear()
  outboundOfferPayloads.clear()
  outboundOfferFiles.clear()
  activeOutboundOfferId = null

  const failureReason = reason?.trim() || 'connection closed before transfer completion'
  for (const offerId of receiveOfferIds) {
    maybeNotifyOfferFailed({
      workflowMode: 'p2p_receive',
      offerId,
      reason: failureReason
    })
  }

  for (const offerId of sendOfferIds) {
    maybeNotifyOfferFailed({
      workflowMode: 'p2p_send',
      offerId,
      reason: failureReason
    })
  }

  if (notifyThrottleTimer) {
    clearTimeout(notifyThrottleTimer)
    notifyThrottleTimer = null
  }
}

function buildState(): TransferSessionState {
  return {
    isServerRunning: Boolean(server),
    serverPort: transferPort,
    localPeerId,
    connectedPeer:
      activeSocket && activeRemoteAddress
        ? {
            peerId: activeRemotePeerId || 'unknown',
            displayName: activeRemoteDisplayName,
            address: activeRemoteAddress,
            connectedAt
          }
        : null,
    activeOutboundOfferId,
    outboundFileTransfers: [...outboundTransfers.values()]
      .map((item) => ({
        transferId: item.transferId,
        offerId: item.offerId,
        fileId: item.fileId,
        fileName: item.fileName,
        totalBytes: item.totalBytes,
        sentBytes: item.sentBytes,
        totalChunks: item.totalChunks,
        sentChunks: item.sentChunks,
        status: item.status
      }))
      .sort((a, b) => a.fileName.localeCompare(b.fileName)),
    inboundStudyOffers: [...inboundStudyOffers.values()].sort((a, b) => b.createdAt - a.createdAt),
    inboundStudyManifests: [...inboundStudyManifests.values()].sort((a, b) => b.receivedAt - a.receivedAt),
    inboundFileTransfers: [...inboundFileTransfers.values()]
      .map((item) => ({
        transferId: item.transferId,
        fileId: item.fileId,
        offerId: item.offerId,
        fileName: item.fileName,
        totalBytes: item.totalBytes,
        receivedBytes: item.receivedBytes,
        totalChunks: item.totalChunks,
        receivedChunks: item.receivedChunks,
        status: item.status,
        savedToPath: item.savedToPath,
        expectedSha256: item.expectedSha256,
        computedSha256: item.computedSha256,
        retryCount: item.retryCount
      }))
      .sort((a, b) => b.receivedBytes - a.receivedBytes),
    inboxDirectory,
    lastEvent,
    lastTerminalOffer
  }
}

function notifyTransferStateChanged() {
  if (!transferStateListener) {
    return
  }

  try {
    transferStateListener(buildState())
  } catch (error) {
    devLogger.debug('[transferSession] Transfer state listener failed', error)
  }
}

function notifyTransferStateChangedThrottled(delayMs = TRANSFER_STATE_NOTIFY_THROTTLE_MS) {
  if (notifyThrottleTimer) {
    return
  }

  notifyThrottleTimer = setTimeout(() => {
    notifyThrottleTimer = null
    notifyTransferStateChanged()
  }, delayMs)
}

function detachExistingSocket() {
  if (!activeSocket) {
    return
  }

  activeSocket.removeAllListeners()
  activeSocket.destroy()
  clearConnectionState('disconnected')
}

function pruneCompletedOutboundOffers() {
  for (const [transferId, transfer] of outboundTransfers.entries()) {
    if (transfer.status === 'complete' || transfer.status === 'error') {
      outboundTransfers.delete(transferId)
    }
  }

  for (const offerId of [...outboundOfferFiles.keys()]) {
    const hasActiveTransfers = [...outboundTransfers.values()].some((transfer) => transfer.offerId === offerId)
    if (!hasActiveTransfers) {
      outboundOfferFiles.delete(offerId)
      outboundOfferPayloads.delete(offerId)
      if (activeOutboundOfferId === offerId) {
        activeOutboundOfferId = null
      }
    }
  }
}

async function streamOfferFiles(socket: net.Socket, offerId: string) {
  const files = outboundOfferFiles.get(offerId)
  if (!files || files.length === 0) {
    lastEvent = `no files to stream (${offerId})`
    return
  }

  const plannedTransfers = await Promise.all(
    files.map(async (file) => {
      const transferId = randomUUID()
      const fileStat = await fs.stat(file.sourcePath)
      const totalBytes = fileStat.size
      const totalChunks = totalBytes > 0 ? Math.max(1, Math.ceil(totalBytes / CHUNK_SIZE)) : 0

      let initialStatus: 'pending' | 'error' = 'pending'
      let initialEvent: string | null = null

      if (totalBytes > MAX_FILE_BYTES) {
        initialStatus = 'error'
        initialEvent = `failed streaming ${file.fileName}: file exceeds size limit`
      } else if (totalChunks > MAX_TOTAL_CHUNKS) {
        initialStatus = 'error'
        initialEvent = `failed streaming ${file.fileName}: chunk limit exceeded`
      }

      outboundTransfers.set(transferId, {
        transferId,
        offerId,
        fileId: file.fileId,
        fileName: file.fileName,
        transferFileId: file.transferFileId,
        sourcePath: file.sourcePath,
        totalBytes,
        sentBytes: 0,
        totalChunks,
        sentChunks: 0,
        sha256: '',
        status: initialStatus
      })

      return {
        transferId,
        file,
        totalBytes,
        totalChunks,
        skip: initialStatus === 'error',
        initialEvent
      }
    })
  )

  notifyTransferStateChanged()

  for (const planned of plannedTransfers) {
    const { transferId, file, totalBytes, totalChunks, skip, initialEvent } = planned

    if (skip) {
      if (initialEvent) {
        lastEvent = initialEvent
        maybeNotifyOfferFailed({
          workflowMode: 'p2p_send',
          offerId,
          transferId,
          reason: initialEvent
        })
        notifyTransferStateChanged()
      }
      continue
    }

    try {
      await writeMessage(socket, {
        type: 'fileOffer',
        transferId,
        offerId,
        fileId: file.fileId,
        fileName: file.fileName,
        totalBytes,
        totalChunks,
        sha256: undefined
      })

      const fileHandle = await fs.open(file.sourcePath, 'r')
      try {
        const fileHash = createHash('sha256')
        const outboundTransfer = outboundTransfers.get(transferId)
        if (outboundTransfer) {
          outboundTransfer.status = 'streaming'
          notifyTransferStateChanged()
        }

        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
          const chunk = await readFileChunkFromHandle(fileHandle, chunkIndex)
          fileHash.update(chunk)
          await writeBinaryChunk(socket, transferId, chunkIndex, chunk)
          notifyTransferChunkMetrics(offerId, chunk.length)

          const outboundTransfer = outboundTransfers.get(transferId)
          if (outboundTransfer) {
            const expectedChunkBytes = chunk.length

            outboundTransfer.sentChunks = Math.min(totalChunks, outboundTransfer.sentChunks + 1)
            outboundTransfer.sentBytes = Math.min(totalBytes, outboundTransfer.sentBytes + expectedChunkBytes)
            notifyTransferStateChangedThrottled()
          }
        }

        const computedSha256 = fileHash.digest('hex')
        const completedTransfer = outboundTransfers.get(transferId)
        if (completedTransfer) {
          completedTransfer.sha256 = computedSha256
        }

        await writeMessage(socket, {
          type: 'fileComplete',
          transferId,
          sha256: computedSha256
        })
      } finally {
        await fileHandle.close()
      }

      const outboundTransfer = outboundTransfers.get(transferId)
      if (outboundTransfer) {
        outboundTransfer.sentBytes = outboundTransfer.totalBytes
        outboundTransfer.sentChunks = outboundTransfer.totalChunks
        outboundTransfer.status = 'complete'
      }

      maybeNotifySendOfferCompleted(offerId, transferId)

      lastEvent = `streamed file ${file.fileName}`
      notifyTransferStateChanged()
    } catch (error) {
      devLogger.warn(`[transferSession] Failed streaming file: ${file.fileName}`, error)
      const failedTransfer = [...outboundTransfers.values()].find(
        (item) => item.offerId === offerId && item.fileId === file.fileId && item.status !== 'complete'
      )
      if (failedTransfer) {
        failedTransfer.status = 'error'
        maybeNotifyOfferFailed({
          workflowMode: 'p2p_send',
          offerId,
          transferId: failedTransfer.transferId,
          reason: `failed streaming ${file.fileName}`
        })
      }
      lastEvent = `failed streaming ${file.fileName}`
      notifyTransferStateChanged()
    }
  }
}

async function requestMissingChunks(socket: net.Socket, transferId: string, chunkIndexes: number[]) {
  if (chunkIndexes.length === 0) {
    return
  }

  if (chunkIndexes.length > MAX_CHUNK_RESEND_REQUEST) {
    throw new Error('Chunk resend request exceeds protocol limit')
  }

  await writeMessage(socket, {
    type: 'fileChunkRequest',
    transferId,
    chunkIndexes
  })

}

async function finalizeInboundTransfer(socket: net.Socket, transferId: string) {
  const transfer = inboundFileTransfers.get(transferId)
  if (!transfer || transfer.status === 'complete' || transfer.status === 'error') {
    return
  }

  const missingIndexes: number[] = []
  for (let index = 0; index < transfer.receivedChunkBitmap.length; index += 1) {
    if (!transfer.receivedChunkBitmap[index]) {
      missingIndexes.push(index)
    }
  }

  if (missingIndexes.length > 0) {
    transfer.hashSequential = false
    transfer.rollingHash = undefined

    if (transfer.retryCount >= 3) {
      transfer.status = 'error'
      await closeFileHandleQuietly(transfer.fileHandle, `Failed closing inbound handle for ${transfer.fileName}`)
      transfer.fileHandle = undefined
      lastEvent = `transfer failed (missing chunks ${transfer.fileName})`
      maybeNotifyOfferFailed({
        workflowMode: 'p2p_receive',
        offerId: transfer.offerId,
        transferId,
        reason: lastEvent
      })
      notifyTransferStateChanged()
      return
    }

    transfer.retryCount += 1
    transfer.status = 'retrying'
    await requestMissingChunks(socket, transferId, missingIndexes)
    lastEvent = `requested ${missingIndexes.length} missing chunks (${transfer.fileName})`
    notifyTransferStateChanged()
    return
  }

  if (transfer.fileHandle) {
    await closeFileHandleQuietly(transfer.fileHandle, `Failed closing inbound handle for ${transfer.fileName}`)
    transfer.fileHandle = undefined
  }

  const shouldVerifyHash = Boolean(transfer.expectedSha256)

  if (shouldVerifyHash) {
    const computedSha256 =
      transfer.hashSequential && transfer.rollingHash
        ? transfer.rollingHash.digest('hex')
        : await sha256File(transfer.tempPath)

    transfer.rollingHash = undefined
    transfer.computedSha256 = computedSha256

    if (transfer.expectedSha256 && transfer.expectedSha256 !== computedSha256) {
      if (transfer.retryCount >= 3) {
        transfer.status = 'error'
        lastEvent = `transfer failed (hash mismatch ${transfer.fileName})`
        maybeNotifyOfferFailed({
          workflowMode: 'p2p_receive',
          offerId: transfer.offerId,
          transferId,
          reason: lastEvent
        })
        notifyTransferStateChanged()
        return
      }

      transfer.retryCount += 1
      transfer.status = 'retrying'
      await requestMissingChunks(
        socket,
        transferId,
        Array.from({ length: transfer.totalChunks }, (_item, index) => index)
      )
      transfer.receivedChunkBitmap = Array.from({ length: transfer.totalChunks }, () => false)
      transfer.receivedChunks = 0
      transfer.receivedBytes = 0
      transfer.fileHandle = await fs.open(transfer.tempPath, 'w+')
      transfer.rollingHash = createHash('sha256')
      transfer.hashSequential = true
      transfer.expectedNextChunkIndex = 0
      lastEvent = `requested full resend (hash mismatch ${transfer.fileName})`
      notifyTransferStateChanged()
      return
    }
  }

  const outputPath = transfer.outputPath
  if (await pathExists(outputPath)) {
    await fs.unlink(outputPath)
  }

  await fs.rename(transfer.tempPath, outputPath)
  await ensureFinalizedFileReadable(outputPath)

  transfer.status = 'complete'
  transfer.savedToPath = outputPath
  transfer.receivedChunkBitmap = []
  lastEvent = `file saved (${transfer.fileName})`
  maybeNotifyReceiveOfferCompleted(transfer.offerId, transfer.transferId)
  notifyTransferStateChanged()
}

function attachSocket(socket: net.Socket) {
  detachExistingSocket()

  activeSocket = socket
  activeRemoteAddress = socket.remoteAddress || 'unknown'
  connectedAt = Date.now()
  lastEvent = 'connected'

  let socketFailureEvent: string | null = null

  let receiveBuffer = Buffer.alloc(0)
  let pendingBinaryChunk: { transferId: string; chunkIndex: number; byteLength: number } | null = null
  let messageProcessingChain = Promise.resolve()

  const queueChunkWrite = (transferId: string, chunkIndex: number, buffer: Buffer) => {
    messageProcessingChain = messageProcessingChain.then(async () => {
      if (socket.destroyed) {
        return
      }

      const transfer = inboundFileTransfers.get(transferId)
      if (
        !transfer ||
        transfer.status === 'error' ||
        chunkIndex < 0 ||
        chunkIndex >= transfer.totalChunks ||
        transfer.receivedChunkBitmap[chunkIndex]
      ) {
        return
      }

      const expectedStart = chunkIndex * CHUNK_SIZE
      if (expectedStart + buffer.length > transfer.totalBytes) {
        transfer.status = 'error'
        await closeFileHandleQuietly(transfer.fileHandle, `Failed closing inbound handle for ${transfer.fileName}`)
        transfer.fileHandle = undefined
        lastEvent = `invalid chunk boundaries (${transfer.fileName})`
        maybeNotifyOfferFailed({
          workflowMode: 'p2p_receive',
          offerId: transfer.offerId,
          transferId,
          reason: lastEvent
        })
        notifyTransferStateChanged()
        return
      }

      if (!transfer.fileHandle) {
        transfer.fileHandle = await fs.open(transfer.tempPath, 'r+')
      }

      await transfer.fileHandle.write(buffer, 0, buffer.length, expectedStart)

      if (transfer.hashSequential && transfer.rollingHash && chunkIndex === transfer.expectedNextChunkIndex) {
        transfer.rollingHash.update(buffer)
        transfer.expectedNextChunkIndex += 1
      } else {
        transfer.hashSequential = false
        transfer.rollingHash = undefined
      }

      transfer.receivedChunkBitmap[chunkIndex] = true
      transfer.receivedChunks += 1
      transfer.receivedBytes += buffer.length
      notifyTransferChunkMetrics(transfer.offerId, buffer.length)
      if (transfer.status === 'retrying') {
        transfer.status = 'receiving'
      }

      lastEvent = `file chunk received (${transfer.fileName} ${transfer.receivedChunks}/${transfer.totalChunks})`
      notifyTransferStateChangedThrottled()
    }).catch((error) => {
      devLogger.debug(`[transferSession] Failed writing inbound chunk (${transferId})`, error)
      const transfer = inboundFileTransfers.get(transferId)
      if (transfer) {
        transfer.status = 'error'
        void closeFileHandleQuietly(transfer.fileHandle, `Failed closing inbound handle for ${transfer.fileName}`)
        transfer.fileHandle = undefined
        lastEvent = `failed writing chunk (${transfer.fileName})`
        maybeNotifyOfferFailed({
          workflowMode: 'p2p_receive',
          offerId: transfer.offerId,
          transferId,
          reason: lastEvent
        })
      } else {
        lastEvent = `failed writing chunk (${transferId})`
      }
      notifyTransferStateChanged()
    })
  }

  socket.on('data', (chunk: Buffer) => {
    const nextChunk = Buffer.from(chunk)
    receiveBuffer = receiveBuffer.length === 0 ? nextChunk : Buffer.concat([receiveBuffer, nextChunk])
    if (receiveBuffer.length > MAX_RECEIVE_BUFFER_BYTES) {
      lastEvent = 'socket dropped: receive buffer exceeded'
      notifyTransferStateChanged()
      socket.destroy()
      return
    }

    while (true) {
      if (pendingBinaryChunk) {
        if (receiveBuffer.length < pendingBinaryChunk.byteLength) {
          break
        }

        const binaryChunk = Buffer.from(receiveBuffer.subarray(0, pendingBinaryChunk.byteLength))
        receiveBuffer = receiveBuffer.subarray(pendingBinaryChunk.byteLength)
        queueChunkWrite(pendingBinaryChunk.transferId, pendingBinaryChunk.chunkIndex, binaryChunk)
        pendingBinaryChunk = null
        continue
      }

      const newLineIndex = receiveBuffer.indexOf(0x0a)
      if (newLineIndex === -1) {
        break
      }

      const lineBuffer = receiveBuffer.subarray(0, newLineIndex)
      receiveBuffer = receiveBuffer.subarray(newLineIndex + 1)

      if (lineBuffer.length > MAX_MESSAGE_BYTES) {
        lastEvent = 'socket dropped: message exceeded limit'
        notifyTransferStateChanged()
        socket.destroy()
        return
      }

      const line = lineBuffer.toString('utf8').trim()
      if (!line) {
        continue
      }

      let parsedMessage: SessionMessage | null = null
      try {
        parsedMessage = JSON.parse(line) as SessionMessage
      } catch (error) {
        devLogger.debug('[transferSession] Failed parsing socket message', error)
        parsedMessage = null
      }

      if (!parsedMessage) {
        continue
      }

      if (parsedMessage.type === 'fileChunkBinary') {
        if (parsedMessage.byteLength < 0 || parsedMessage.byteLength > MAX_MESSAGE_BYTES) {
          lastEvent = 'socket dropped: binary chunk exceeded limit'
          notifyTransferStateChanged()
          socket.destroy()
          return
        }

        pendingBinaryChunk = {
          transferId: parsedMessage.transferId,
          chunkIndex: parsedMessage.chunkIndex,
          byteLength: parsedMessage.byteLength
        }
        continue
      }

      const queuedMessage = parsedMessage
      messageProcessingChain = messageProcessingChain.then(async () => {
        try {
          if (socket.destroyed) {
            return
          }

          const message = queuedMessage
          let didMutateState = false

          if (message.type === 'hello' && message.protocol === PROTOCOL) {
            activeRemotePeerId = message.peerId || 'unknown'
            activeRemoteDisplayName = message.displayName || 'Unknown peer'
            lastEvent = `hello from ${activeRemoteDisplayName}`
            didMutateState = true
          }

          if (message.type === 'studyOffer') {
            const nextOffer: StudyOfferSummary = {
              offerId: message.payload.offerId,
              senderPeerId: activeRemotePeerId || 'unknown',
              senderDisplayName: activeRemoteDisplayName,
              rootLabel: message.payload.rootLabel,
              studyCount: message.payload.studyCount,
              seriesCount: message.payload.seriesCount,
              instanceCount: message.payload.instanceCount,
              createdAt: message.payload.createdAt
            }
            inboundStudyOffers.set(nextOffer.offerId, nextOffer)
            lastEvent = `study offer received (${nextOffer.studyCount} studies)`
            didMutateState = true
          }

          if (message.type === 'studyAccept') {
            lastEvent = `study offer accepted (${message.offerId})`
            didMutateState = true
          }

          if (message.type === 'manifestRequest') {
            const payload = outboundOfferPayloads.get(message.offerId)
            if (!payload) {
              lastEvent = `manifest request ignored (${message.offerId})`
              didMutateState = true
            } else {
              await writeMessage(socket, {
                type: 'manifestResponse',
                offerId: message.offerId,
                payload
              })
              lastEvent = `manifest sent (${message.offerId})`
              await streamOfferFiles(socket, message.offerId)
              didMutateState = true
            }
          }

          if (message.type === 'manifestResponse') {
            inboundStudyManifests.set(message.offerId, {
              offerId: message.offerId,
              senderPeerId: activeRemotePeerId || 'unknown',
              senderDisplayName: activeRemoteDisplayName,
              payload: message.payload,
              receivedAt: Date.now()
            })
            lastEvent = `manifest received (${message.offerId})`
            didMutateState = true
          }

          if (message.type === 'fileOffer') {
            if (message.totalBytes > MAX_FILE_BYTES || message.totalChunks > MAX_TOTAL_CHUNKS) {
              lastEvent = `file offer rejected (${message.fileName})`
              didMutateState = true
              if (didMutateState) {
                notifyTransferStateChanged()
              }
              return
            }

            if (inboundFileTransfers.size >= MAX_INBOUND_TRACKED_TRANSFERS) {
              lastEvent = 'file offer rejected: inbound transfer limit reached'
              didMutateState = true
              if (didMutateState) {
                notifyTransferStateChanged()
              }
              return
            }

            const outputPath = await ensureReceivedFilePath(message.fileId, message.fileName)
            const tempPath = `${outputPath}.${message.transferId}.part`
            const fileHandle = await fs.open(tempPath, 'w+')

            inboundFileTransfers.set(message.transferId, {
              transferId: message.transferId,
              fileId: message.fileId,
              offerId: message.offerId,
              fileName: message.fileName,
              totalBytes: message.totalBytes,
              receivedBytes: 0,
              totalChunks: message.totalChunks,
              receivedChunks: 0,
              status: 'receiving',
              expectedSha256: message.sha256,
              retryCount: 0,
              tempPath,
              outputPath,
              fileHandle,
              rollingHash: createHash('sha256'),
              hashSequential: true,
              expectedNextChunkIndex: 0,
              receivedChunkBitmap: Array.from({ length: message.totalChunks }, () => false)
            })
            lastEvent = `file offer received (${message.fileName})`
            didMutateState = true
          }

          if (message.type === 'fileComplete') {
            const transfer = inboundFileTransfers.get(message.transferId)
            if (transfer && message.sha256) {
              transfer.expectedSha256 = message.sha256
            }

            await finalizeInboundTransfer(socket, message.transferId).catch((error) => {
              devLogger.debug(
                `[transferSession] Failed finalizing inbound transfer (${message.transferId})`,
                error
              )
              const transfer = inboundFileTransfers.get(message.transferId)
              if (transfer) {
                transfer.status = 'error'
                void closeFileHandleQuietly(transfer.fileHandle, `Failed closing inbound handle for ${transfer.fileName}`)
                transfer.fileHandle = undefined
                lastEvent = `failed finalizing ${transfer.fileName}`
                maybeNotifyOfferFailed({
                  workflowMode: 'p2p_receive',
                  offerId: transfer.offerId,
                  transferId: message.transferId,
                  reason: lastEvent
                })
                notifyTransferStateChanged()
              }
            })
          }

          if (message.type === 'fileChunkRequest') {
            if (message.chunkIndexes.length > MAX_CHUNK_RESEND_REQUEST) {
              lastEvent = 'chunk resend request rejected: too many chunk indexes'
              didMutateState = true
              if (didMutateState) {
                notifyTransferStateChanged()
              }
              return
            }

            const outbound = outboundTransfers.get(message.transferId)
            if (outbound) {
              const sourceHandle = await fs.open(outbound.sourcePath, 'r')
              try {
              for (const chunkIndex of message.chunkIndexes) {
                if (chunkIndex < 0 || chunkIndex >= outbound.totalChunks) {
                  continue
                }

                const chunk = await readFileChunkFromHandle(sourceHandle, chunkIndex)
                await writeBinaryChunk(socket, message.transferId, chunkIndex, chunk)
                notifyTransferChunkMetrics(outbound.offerId, chunk.length)
              }
              } finally {
                await sourceHandle.close()
              }

              await writeMessage(socket, {
                type: 'fileComplete',
                transferId: message.transferId,
                sha256: outbound.sha256 || undefined
              })
              lastEvent = `resent ${message.chunkIndexes.length} chunks (${outbound.fileName})`
              didMutateState = true
            }
          }

          if (didMutateState) {
            notifyTransferStateChanged()
          }
        } catch (error) {
          devLogger.warn('[transferSession] Failed processing inbound message', error)
          lastEvent = 'failed processing inbound message'
          notifyTransferStateChanged()
        }
      })
    }
  })

  socket.on('close', () => {
    if (socket === activeSocket) {
      clearConnectionState(socketFailureEvent ?? 'disconnected')
      lastEvent = socketFailureEvent ?? 'disconnected'
      notifyTransferStateChanged()
    }
  })

  socket.on('error', (error: Error) => {
    if (socket === activeSocket) {
      socketFailureEvent = toSocketErrorEvent(error)
      lastEvent = socketFailureEvent
      notifyTransferStateChanged()
    }
  })

  void writeMessage(socket, {
    type: 'hello',
    protocol: PROTOCOL,
    peerId: localPeerId,
    displayName: localDisplayName
  }).catch((error) => {
    devLogger.debug('[transferSession] Failed sending hello message', error)
  })
}

export async function startTransferServer() {
  if (server) {
    return buildState()
  }

  const nextServer = net.createServer((socket) => {
    attachSocket(socket)
  })

  let lastListenError: Error | null = null

  for (let attempt = 0; attempt < MAX_PORT_BIND_ATTEMPTS; attempt += 1) {
    const candidatePort = transferPort + attempt

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          nextServer.off('listening', onListening)
          reject(error)
        }

        const onListening = () => {
          nextServer.off('error', onError)
          resolve()
        }

        nextServer.once('error', onError)
        nextServer.once('listening', onListening)
        nextServer.listen(candidatePort)
      })

      transferPort = candidatePort
      break
    } catch (error) {
      const candidateError = error instanceof Error ? error : new Error('Failed to bind transfer server')
      const errorCode = (error as NodeJS.ErrnoException | null)?.code
      if (errorCode !== 'EADDRINUSE' || attempt === MAX_PORT_BIND_ATTEMPTS - 1) {
        throw candidateError
      }

      lastListenError = candidateError
    }
  }

  if (nextServer.listening !== true) {
    throw lastListenError ?? new Error('Failed to bind transfer server')
  }

  server = nextServer
  lastEvent = `server listening on ${transferPort}`
  notifyTransferStateChanged()

  return buildState()
}

export async function stopTransferServer() {
  detachExistingSocket()

  if (!server) {
    lastEvent = 'server stopped'
    notifyTransferStateChanged()
    return buildState()
  }

  const serverToClose = server
  server = null

  await new Promise<void>((resolve) => {
    serverToClose.close(() => resolve())
  })

  lastEvent = 'server stopped'
  notifyTransferStateChanged()
  return buildState()
}

export async function connectToTransferPeer(address: string, port = transferPort) {
  const socket = net.createConnection({ host: address, port })

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })

  attachSocket(socket)
  lastEvent = `connected to ${address}:${port}`
  notifyTransferStateChanged()
  return buildState()
}

export async function disconnectTransferPeer() {
  if (!activeSocket) {
    lastEvent = 'no active connection'
    notifyTransferStateChanged()
    return buildState()
  }

  const socketToClose = activeSocket
  detachExistingSocket()

  await new Promise<void>((resolve) => {
    socketToClose.end(() => resolve())
  })

  lastEvent = 'peer disconnected'
  notifyTransferStateChanged()
  return buildState()
}

export async function sendStudyOffer(payload: ResolvedStudyOfferPayload) {
  if (!activeSocket) {
    lastEvent = 'study offer skipped: not connected'
    notifyTransferStateChanged()
    return buildState()
  }

  if (activeSocket.destroyed || !activeSocket.writable || activeSocket.writableEnded) {
    detachExistingSocket()
    lastEvent = 'study offer skipped: connection closed'
    notifyTransferStateChanged()
    return buildState()
  }

  pruneCompletedOutboundOffers()

  const offerId = randomUUID()
  activeOutboundOfferId = offerId
  outboundOfferPayloads.set(offerId, {
    rootLabel: payload.rootLabel,
    studyCount: payload.studyCount,
    seriesCount: payload.seriesCount,
    instanceCount: payload.instanceCount,
    studies: payload.studies,
    files: payload.files.map((file) => ({
      fileId: file.fileId,
      fileName: file.fileName,
      sizeBytes: file.sizeBytes,
      studyInstanceUID: file.studyInstanceUID,
      seriesInstanceUID: file.seriesInstanceUID,
      sopInstanceUID: file.sopInstanceUID,
      transferSyntaxUID: file.transferSyntaxUID,
      instanceNumber: file.instanceNumber
    }))
  })
  outboundOfferFiles.set(offerId, payload.files)

  try {
    await writeMessage(activeSocket, {
      type: 'studyOffer',
      payload: {
        offerId,
        rootLabel: payload.rootLabel,
        studyCount: payload.studyCount,
        seriesCount: payload.seriesCount,
        instanceCount: payload.instanceCount,
        createdAt: Date.now()
      }
    })
  } catch (error) {
    devLogger.warn('[transferSession] Failed sending study offer', error)
    detachExistingSocket()
    lastEvent = 'study offer failed: connection reset'
    notifyTransferStateChanged()
    return buildState()
  }

  lastEvent = `study offer sent (${payload.studyCount} studies)`
  notifyTransferStateChanged()
  return buildState()
}

export async function acceptStudyOffer(offerId: string): Promise<{ ok: boolean; offerId: string }> {
  if (!activeSocket) {
    lastEvent = 'accept skipped: not connected'
    notifyTransferStateChanged()
    return {
      ok: false,
      offerId
    }
  }

  const offerToAccept = inboundStudyOffers.get(offerId)
  if (!offerToAccept) {
    lastEvent = 'accept skipped: offer not found'
    notifyTransferStateChanged()
    return {
      ok: false,
      offerId
    }
  }

  inboundStudyOffers.delete(offerId)

  try {
    await writeMessage(activeSocket, { type: 'studyAccept', offerId })

    await writeMessage(activeSocket, {
      type: 'manifestRequest',
      offerId
    })

    lastEvent = `study offer accepted and manifest requested (${offerId})`
    notifyTransferStateChanged()
    return {
      ok: true,
      offerId
    }
  } catch (error) {
    devLogger.warn(`[transferSession] Failed accepting study offer: ${offerId}`, error)
    inboundStudyOffers.set(offerId, offerToAccept)

    if (activeSocket.destroyed || !activeSocket.writable || activeSocket.writableEnded) {
      detachExistingSocket()
    }

    lastEvent = `accept failed (${offerId})`
    notifyTransferStateChanged()
    return {
      ok: false,
      offerId
    }
  }
}

export function configureTransferInboxDirectory(nextDirectory: string) {
  inboxDirectory = nextDirectory
  notifyTransferStateChanged()
}

export function configureTransferServerPort(nextPort: number) {
  if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) {
    throw new Error(`Invalid transfer server port: ${nextPort}`)
  }

  transferPort = nextPort
  notifyTransferStateChanged()
}

export function setTransferStateListener(listener: ((state: TransferSessionState) => void) | null) {
  transferStateListener = listener
  notifyTransferStateChanged()
}

export function setTransferChunkMetricsListener(
  listener: ((input: { offerId: string; byteLength: number }) => void) | null
) {
  transferChunkMetricsListener = listener
}

export function setTransferOfferCompletedListener(
  listener: ((input: { workflowMode: 'p2p_send' | 'p2p_receive'; offerId: string; transferId: string; totalBytes?: number }) => void) | null
) {
  transferOfferCompletedListener = listener
}

export function setTransferOfferFailedListener(
  listener: ((input: { workflowMode: 'p2p_send' | 'p2p_receive'; offerId: string; transferId?: string; reason: string }) => void) | null
) {
  transferOfferFailedListener = listener
}

export function getTransferSessionState() {
  return buildState()
}

export async function clearTransferInbox() {
  const hasActiveInboundTransfer = [...inboundFileTransfers.values()].some(
    (transfer) => transfer.status === 'receiving' || transfer.status === 'retrying'
  )
  if (hasActiveInboundTransfer) {
    throw new Error('Cannot clear the received cache while files are still being received')
  }

  for (const transfer of inboundFileTransfers.values()) {
    await closeFileHandleQuietly(transfer.fileHandle, `Failed closing inbound handle for ${transfer.fileName}`)
    transfer.fileHandle = undefined
  }

  await fs.rm(inboxDirectory, { recursive: true, force: true })
  await fs.mkdir(inboxDirectory, { recursive: true })

  inboundStudyOffers.clear()
  inboundStudyManifests.clear()
  inboundFileTransfers.clear()

  lastEvent = 'transfer inbox cleared'
  notifyTransferStateChanged()

  return buildState()
}
