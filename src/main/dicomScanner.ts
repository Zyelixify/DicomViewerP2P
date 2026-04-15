import path from 'node:path'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import dicomParser from 'dicom-parser'
import type { ScanResult, StudyMetadata } from '../shared/types'
import { devLogger } from './logger'

const HEADER_READ_BYTES = 64 * 1024
const DICOM_MAGIC_OFFSET = 128
const DICOM_MAGIC_WORD = 'DICM'
const MAX_SCAN_CONCURRENCY = 4

type HeaderMetadata = {
  patientName: string
  studyInstanceUID: string
  seriesInstanceUID: string
  sopInstanceUID: string
  modality: string
  transferSyntaxUID?: string
  seriesDescription?: string
  instanceNumber?: number
}

type ParseCounters = {
  missingPreamble: number
  parseRejected: number
  accepted: number
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function collectFilesRecursively(rootFolder: string): Promise<string[]> {
  const queue = [rootFolder]
  const files: string[] = []

  while (queue.length > 0) {
    const currentDir = queue.pop()
    if (!currentDir) {
      continue
    }

    let entries
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true })
    } catch (error) {
      devLogger.debug(`[dicomScanner] Failed to read directory: ${currentDir}`, error)
      continue
    }

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name)
      if (!isPathWithinRoot(rootFolder, absolutePath) && absolutePath !== rootFolder) {
        continue
      }

      if (entry.isDirectory()) {
        queue.push(absolutePath)
        continue
      }

      if (entry.isFile()) {
        files.push(absolutePath)
      }
    }
  }

  return files
}

async function readPartialFile(filePath: string, byteCount: number): Promise<Buffer> {
  const fileHandle = await fs.open(filePath, 'r')
  try {
    const { size } = await fileHandle.stat()
    const length = Math.min(size, byteCount)
    const buffer = Buffer.alloc(length)
    await fileHandle.read(buffer, 0, length, 0)
    return buffer
  } finally {
    await fileHandle.close()
  }
}

function hasDicomPreamble(buffer: Buffer): boolean {
  if (buffer.length < DICOM_MAGIC_OFFSET + DICOM_MAGIC_WORD.length) {
    return false
  }

  return (
    buffer[DICOM_MAGIC_OFFSET] === 0x44 &&
    buffer[DICOM_MAGIC_OFFSET + 1] === 0x49 &&
    buffer[DICOM_MAGIC_OFFSET + 2] === 0x43 &&
    buffer[DICOM_MAGIC_OFFSET + 3] === 0x4d
  )
}

function parseMetadataFromBuffer(buffer: Buffer): HeaderMetadata | null {
  try {
    const dataset = dicomParser.parseDicom(new Uint8Array(buffer), {
      untilTag: 'x7fe00010'
    })

    const patientName = dataset.string('x00100010')?.trim() ?? ''
    const studyInstanceUID = dataset.string('x0020000d')?.trim() ?? ''
    const seriesInstanceUID = dataset.string('x0020000e')?.trim() ?? ''
    const sopInstanceUID = dataset.string('x00080018')?.trim() ?? ''
    const modality = dataset.string('x00080060')?.trim() ?? ''
    const transferSyntaxUID = dataset.string('x00020010')?.trim()

    if (!studyInstanceUID || !seriesInstanceUID || !sopInstanceUID) {
      return null
    }

    const seriesDescription = dataset.string('x0008103e')?.trim()
    const instanceNumberRaw = dataset.intString('x00200013')

    return {
      patientName,
      studyInstanceUID,
      seriesInstanceUID,
      sopInstanceUID,
      modality,
      transferSyntaxUID,
      seriesDescription,
      instanceNumber: Number.isNaN(instanceNumberRaw) ? undefined : instanceNumberRaw
    }
  } catch (error) {
    devLogger.debug(`[dicomScanner] Failed to parse DICOM metadata: ${error}`)
    return null
  }
}

export async function scanDicomFolder(rootFolder: string): Promise<ScanResult> {
  const resolvedRoot = path.resolve(rootFolder)
  const startedAt = Date.now()

  const files = await collectFilesRecursively(resolvedRoot)
  const studyMap = new Map<string, StudyMetadata>()
  let dicomFileCount = 0
  const counters: ParseCounters = {
    missingPreamble: 0,
    parseRejected: 0,
    accepted: 0
  }

  let cursor = 0
  const workerCount = Math.min(MAX_SCAN_CONCURRENCY, Math.max(1, files.length))

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const nextIndex = cursor
      cursor += 1

      if (nextIndex >= files.length) {
        return
      }

      const filePath = files[nextIndex]
      if (!isPathWithinRoot(resolvedRoot, filePath)) {
        continue
      }

      let buffer: Buffer
      try {
        buffer = await readPartialFile(filePath, HEADER_READ_BYTES)
      } catch (error) {
        devLogger.debug(`[dicomScanner] Failed to read file header: ${filePath}`, error)
        continue
      }

      if (!hasDicomPreamble(buffer)) {
        counters.missingPreamble += 1
        continue
      }

      const parsed = parseMetadataFromBuffer(buffer)
      if (!parsed) {
        counters.parseRejected += 1
        continue
      }

      dicomFileCount += 1
      counters.accepted += 1

      const existingStudy = studyMap.get(parsed.studyInstanceUID)
      const study =
        existingStudy ?? {
          studyInstanceUID: parsed.studyInstanceUID,
          patientName: parsed.patientName,
          series: []
        }

      if (!existingStudy) {
        studyMap.set(parsed.studyInstanceUID, study)
      }

      let series = study.series.find((item) => item.seriesInstanceUID === parsed.seriesInstanceUID)
      if (!series) {
        series = {
          seriesInstanceUID: parsed.seriesInstanceUID,
          modality: parsed.modality,
          seriesDescription: parsed.seriesDescription,
          instances: []
        }
        study.series.push(series)
      }

      series.instances.push({
        sopInstanceUID: parsed.sopInstanceUID,
        filePath,
        transferFileId: buildTransferFileId(
          parsed.studyInstanceUID,
          parsed.seriesInstanceUID,
          parsed.sopInstanceUID,
          filePath
        ),
        transferSyntaxUID: parsed.transferSyntaxUID,
        instanceNumber: parsed.instanceNumber
      })
    }
  })

  await Promise.all(workers)

  const studies = [...studyMap.values()]
    .map((study) => ({
      ...study,
      series: [...study.series]
        .map((series) => ({
          ...series,
          instances: [...series.instances].sort((a, b) => {
            const aInstance = a.instanceNumber ?? Number.MAX_SAFE_INTEGER
            const bInstance = b.instanceNumber ?? Number.MAX_SAFE_INTEGER
            if (aInstance !== bInstance) {
              return aInstance - bInstance
            }

            const bySop = normalizeForSort(a.sopInstanceUID).localeCompare(normalizeForSort(b.sopInstanceUID))
            if (bySop !== 0) {
              return bySop
            }

            return normalizeForSort(a.filePath).localeCompare(normalizeForSort(b.filePath))
          })
        }))
        .sort((a, b) => {
          const bySeriesUid = normalizeForSort(a.seriesInstanceUID).localeCompare(normalizeForSort(b.seriesInstanceUID))
          if (bySeriesUid !== 0) {
            return bySeriesUid
          }

          const aFirst = a.instances[0]?.instanceNumber ?? Number.MAX_SAFE_INTEGER
          const bFirst = b.instances[0]?.instanceNumber ?? Number.MAX_SAFE_INTEGER
          return aFirst - bFirst
        })
    }))
    .sort((a, b) => normalizeForSort(a.studyInstanceUID).localeCompare(normalizeForSort(b.studyInstanceUID)))

  const elapsedMs = Date.now() - startedAt
  const skippedFileCount = counters.missingPreamble + counters.parseRejected
  console.info(
    `[DICOM_SCAN] root=${resolvedRoot} scanned=${files.length} accepted=${counters.accepted} skipped=${skippedFileCount} elapsedMs=${elapsedMs}`
  )

  return {
    rootFolder: resolvedRoot,
    studies,
    scannedFileCount: files.length,
    dicomFileCount,
    elapsedMs
  }
}

function buildTransferFileId(studyInstanceUID: string, seriesInstanceUID: string, sopInstanceUID: string, filePath: string) {
  const key = `${studyInstanceUID}|${seriesInstanceUID}|${sopInstanceUID}|${path.resolve(filePath)}`
  return createHash('sha1').update(key).digest('hex')
}

function normalizeForSort(value?: string) {
  return (value ?? '').trim().toLowerCase()
}
