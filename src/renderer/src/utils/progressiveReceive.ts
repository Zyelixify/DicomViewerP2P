import type {
  ScanResult,
  SeriesMetadata,
  TransferFileDescriptor,
  TransferFileProgress,
  TransferSessionState
} from '../../../shared/types'

export type ProgressiveReceiveSeriesEntry = {
  studyInstanceUID: string
  patientName: string
  series: SeriesMetadata
}

export type ProgressiveReceiveOfferSummary = {
  offerId: string
  studyCount: number
  seriesCount: number
  expectedInstanceCount: number
  availableInstanceCount: number
  hasOpenableSeries: boolean
  isComplete: boolean
  hasErrors: boolean
}

export type ProgressiveReceiveViewModel = {
  rootFolder: string
  studyCount: number
  seriesCount: number
  scannedFileCount: number
  availableDicomFileCount: number
  expectedDicomFileCount?: number
  elapsedMs: number
  seriesEntries: ProgressiveReceiveSeriesEntry[]
  offers: ProgressiveReceiveOfferSummary[]
}

type SeriesEntryMapValue = {
  entry: ProgressiveReceiveSeriesEntry
  order: number
}

function normalizeForSort(value?: string) {
  return (value ?? '').trim().toLowerCase()
}

function compareTransferFileProgress(a: TransferFileProgress, b: TransferFileProgress) {
  const statusOrder = new Map([
    ['complete', 0],
    ['receiving', 1],
    ['retrying', 2],
    ['error', 3]
  ])

  const aOrder = statusOrder.get(a.status) ?? 99
  const bOrder = statusOrder.get(b.status) ?? 99
  if (aOrder !== bOrder) {
    return aOrder - bOrder
  }

  return normalizeForSort(a.fileName).localeCompare(normalizeForSort(b.fileName))
}

function createSeriesKey(studyInstanceUID: string, seriesInstanceUID: string) {
  return `${studyInstanceUID}::${seriesInstanceUID}`
}

function createEmptyScanResult(transferState: TransferSessionState | null): ScanResult {
  return {
    rootFolder: transferState?.inboxDirectory ?? '',
    studies: [],
    scannedFileCount: 0,
    dicomFileCount: 0,
    elapsedMs: 0
  }
}

function buildReceivedSeriesEntryMap(scanResult: ScanResult) {
  const map = new Map<string, SeriesEntryMapValue>()
  let order = 0

  for (const study of scanResult.studies) {
    for (const series of study.series) {
      map.set(createSeriesKey(study.studyInstanceUID, series.seriesInstanceUID), {
        entry: {
          studyInstanceUID: study.studyInstanceUID,
          patientName: study.patientName,
          series
        },
        order
      })
      order += 1
    }
  }

  return map
}

function createInstancePool(instances: SeriesMetadata['instances']) {
  const pool = new Map<string, SeriesMetadata['instances']>()

  for (const instance of instances) {
    const existing = pool.get(instance.sopInstanceUID)
    if (existing) {
      existing.push(instance)
      continue
    }

    pool.set(instance.sopInstanceUID, [instance])
  }

  return pool
}

function sortDescriptors(descriptors: TransferFileDescriptor[]) {
  return [...descriptors].sort((a, b) => {
    const aNumber = a.instanceNumber ?? Number.MAX_SAFE_INTEGER
    const bNumber = b.instanceNumber ?? Number.MAX_SAFE_INTEGER
    if (aNumber !== bNumber) {
      return aNumber - bNumber
    }

    const bySop = normalizeForSort(a.sopInstanceUID).localeCompare(normalizeForSort(b.sopInstanceUID))
    if (bySop !== 0) {
      return bySop
    }

    return normalizeForSort(a.fileName).localeCompare(normalizeForSort(b.fileName))
  })
}

function buildAvailableInstances(
  descriptors: TransferFileDescriptor[],
  scannedInstances: SeriesMetadata['instances'],
  progressByFileId: Map<string, TransferFileProgress>
) {
  const instancePool = createInstancePool(scannedInstances)
  const availableInstances: SeriesMetadata['instances'] = []
  let transientInstanceCount = 0

  for (const descriptor of descriptors) {
    const instancesForSop = instancePool.get(descriptor.sopInstanceUID)
    const matchedInstance = instancesForSop?.shift()
    if (matchedInstance) {
      availableInstances.push(matchedInstance)
      continue
    }

    const progress = progressByFileId.get(descriptor.fileId)
    if (progress?.status !== 'complete' || !progress.savedToPath) {
      continue
    }

    availableInstances.push({
      sopInstanceUID: descriptor.sopInstanceUID,
      filePath: progress.savedToPath,
      transferFileId: descriptor.fileId,
      transferSyntaxUID: descriptor.transferSyntaxUID,
      instanceNumber: descriptor.instanceNumber
    })
    transientInstanceCount += 1
  }

  return {
    availableInstances,
    transientInstanceCount
  }
}

function buildProgressByOfferId(transferState: TransferSessionState | null) {
  const progressByOfferId = new Map<string, Map<string, TransferFileProgress>>()

  if (!transferState) {
    return progressByOfferId
  }

  for (const transfer of transferState.inboundFileTransfers) {
    let transfersForOffer = progressByOfferId.get(transfer.offerId)
    if (!transfersForOffer) {
      transfersForOffer = new Map<string, TransferFileProgress>()
      progressByOfferId.set(transfer.offerId, transfersForOffer)
    }

    const existing = transfersForOffer.get(transfer.fileId)
    if (!existing || compareTransferFileProgress(transfer, existing) < 0) {
      transfersForOffer.set(transfer.fileId, transfer)
    }
  }

  return progressByOfferId
}

export function buildProgressiveReceiveViewModel(
  receivedScanResult: ScanResult | null,
  transferState: TransferSessionState | null
): ProgressiveReceiveViewModel {
  const stableScanResult = receivedScanResult ?? createEmptyScanResult(transferState)
  const seriesEntriesByKey = buildReceivedSeriesEntryMap(stableScanResult)
  const progressByOfferId = buildProgressByOfferId(transferState)
  const offers: ProgressiveReceiveOfferSummary[] = []
  let nextOrder = seriesEntriesByKey.size
  let extraAvailableInstanceCount = 0
  let remainingExpectedInstanceCount = 0

  for (const manifest of transferState?.inboundStudyManifests ?? []) {
    const progressByFileId = progressByOfferId.get(manifest.offerId) ?? new Map<string, TransferFileProgress>()
    let offerAvailableCount = 0
    let offerHasErrors = false
    let offerHasOpenableSeries = false
    let offerIsComplete = true

    for (const study of manifest.payload.studies) {
      for (const summarySeries of study.series) {
        const descriptors = sortDescriptors(
          manifest.payload.files.filter(
            (file) =>
              file.studyInstanceUID === study.studyInstanceUID &&
              file.seriesInstanceUID === summarySeries.seriesInstanceUID
          )
        )

        const seriesKey = createSeriesKey(study.studyInstanceUID, summarySeries.seriesInstanceUID)
        const existingEntry = seriesEntriesByKey.get(seriesKey)
        const scannedInstances = existingEntry?.entry.series.instances ?? []
        const { availableInstances, transientInstanceCount } =
          descriptors.length > 0
            ? buildAvailableInstances(descriptors, scannedInstances, progressByFileId)
            : { availableInstances: scannedInstances, transientInstanceCount: 0 }
        const expectedInstanceCount =
          summarySeries.instanceCount > 0
            ? summarySeries.instanceCount
            : Math.max(availableInstances.length, descriptors.length, scannedInstances.length)
        const availableInstanceCount = availableInstances.length
        const failedInstanceCount = descriptors.filter((descriptor) => progressByFileId.get(descriptor.fileId)?.status === 'error').length
        const activeInstanceCount = descriptors.filter((descriptor) => {
          const status = progressByFileId.get(descriptor.fileId)?.status
          return status === 'receiving' || status === 'retrying'
        }).length
        const isTerminalPartial =
          availableInstanceCount > 0 &&
          availableInstanceCount < expectedInstanceCount &&
          failedInstanceCount > 0 &&
          activeInstanceCount === 0
        const receiveProgressStatus =
          expectedInstanceCount > 0
            ? availableInstanceCount >= expectedInstanceCount && failedInstanceCount === 0 && activeInstanceCount === 0
              ? 'complete'
              : isTerminalPartial
                ? 'partial'
                : failedInstanceCount > 0 && activeInstanceCount === 0 && availableInstanceCount === 0
                  ? 'failed'
                  : 'receiving'
            : undefined

        offerAvailableCount += availableInstanceCount
        offerHasErrors = offerHasErrors || failedInstanceCount > 0
        offerHasOpenableSeries = offerHasOpenableSeries || availableInstanceCount > 0
        offerIsComplete =
          offerIsComplete &&
          expectedInstanceCount > 0 &&
          availableInstanceCount >= expectedInstanceCount &&
          failedInstanceCount === 0 &&
          activeInstanceCount === 0
        extraAvailableInstanceCount += transientInstanceCount
        remainingExpectedInstanceCount += Math.max(0, expectedInstanceCount - availableInstanceCount)

        const nextEntry: ProgressiveReceiveSeriesEntry = {
          studyInstanceUID: study.studyInstanceUID,
          patientName: existingEntry?.entry.patientName || study.patientName,
          series: {
            seriesInstanceUID: summarySeries.seriesInstanceUID,
            modality: existingEntry?.entry.series.modality || summarySeries.modality,
            seriesDescription: existingEntry?.entry.series.seriesDescription || summarySeries.seriesDescription,
            instances: availableInstances,
            expectedInstanceCount,
            availableInstanceCount,
            receiveProgressStatus,
            receiveOfferId: manifest.offerId
          }
        }

        seriesEntriesByKey.set(seriesKey, {
          entry: nextEntry,
          order: existingEntry?.order ?? nextOrder
        })

        if (!existingEntry) {
          nextOrder += 1
        }
      }
    }

    offers.push({
      offerId: manifest.offerId,
      studyCount: manifest.payload.studyCount,
      seriesCount: manifest.payload.seriesCount,
      expectedInstanceCount: manifest.payload.instanceCount,
      availableInstanceCount: offerAvailableCount,
      hasOpenableSeries: offerHasOpenableSeries,
      isComplete:
        manifest.payload.instanceCount > 0 &&
        offerAvailableCount >= manifest.payload.instanceCount &&
        offerIsComplete,
      hasErrors: offerHasErrors
    })
  }

  const seriesEntries = [...seriesEntriesByKey.values()]
    .sort((a, b) => a.order - b.order)
    .map((value) => value.entry)

  return {
    rootFolder: stableScanResult.rootFolder,
    studyCount: new Set(seriesEntries.map((entry) => entry.studyInstanceUID)).size,
    seriesCount: seriesEntries.length,
    scannedFileCount: stableScanResult.scannedFileCount,
    availableDicomFileCount: stableScanResult.dicomFileCount + extraAvailableInstanceCount,
    expectedDicomFileCount:
      remainingExpectedInstanceCount > 0
        ? stableScanResult.dicomFileCount + extraAvailableInstanceCount + remainingExpectedInstanceCount
        : undefined,
    elapsedMs: stableScanResult.elapsedMs,
    seriesEntries,
    offers
  }
}
