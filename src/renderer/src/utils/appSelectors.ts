import type { ScanResult, SeriesMetadata, StudyOfferPayload } from '../../../shared/types'

export type SeriesEntry = {
  studyInstanceUID: string
  patientName: string
  series: SeriesMetadata
}

export type SendStudyOption = {
  studyInstanceUID: string
  label: string
  seriesCount: number
  instanceCount: number
}

function compareTransferInstances(a: SeriesMetadata['instances'][number], b: SeriesMetadata['instances'][number]) {
  const aNumber = a.instanceNumber ?? Number.MAX_SAFE_INTEGER
  const bNumber = b.instanceNumber ?? Number.MAX_SAFE_INTEGER
  if (aNumber !== bNumber) {
    return aNumber - bNumber
  }

  return a.sopInstanceUID.localeCompare(b.sopInstanceUID)
}

function orderStudySeriesForTransfer(study: ScanResult['studies'][number]) {
  const [prioritySeries] = [...study.series].sort((a, b) => {
    if (b.instances.length !== a.instances.length) {
      return b.instances.length - a.instances.length
    }

    return a.seriesInstanceUID.localeCompare(b.seriesInstanceUID)
  })

  if (!prioritySeries) {
    return []
  }

  return [prioritySeries, ...study.series.filter((series) => series.seriesInstanceUID !== prioritySeries.seriesInstanceUID)]
}

export function buildSeriesEntries(scanResult: ScanResult | null): SeriesEntry[] {
  if (!scanResult) {
    return []
  }

  return scanResult.studies.flatMap((study) =>
    study.series.map((series) => ({
      studyInstanceUID: study.studyInstanceUID,
      patientName: study.patientName,
      series
    }))
  )
}

export function buildSendStudyOptions(scanResult: ScanResult | null): SendStudyOption[] {
  if (!scanResult) {
    return []
  }

  return scanResult.studies.map((study) => ({
    studyInstanceUID: study.studyInstanceUID,
    label: study.patientName?.trim() || 'Unknown Patient',
    seriesCount: study.series.length,
    instanceCount: study.series.reduce((total, series) => total + series.instances.length, 0)
  }))
}

export function buildStudyOfferPayload(rootLabel: string, studies: ScanResult['studies']): StudyOfferPayload | null {
  if (studies.length === 0) {
    return null
  }

  const orderedStudies = studies.map((study) => {
    const orderedSeries = orderStudySeriesForTransfer(study)
    const files: StudyOfferPayload['files'] = []
    let instanceCount = 0

    for (const series of orderedSeries) {
      for (const instance of [...series.instances].sort(compareTransferInstances)) {
        if (!instance.transferFileId) {
          continue
        }

        instanceCount += 1
        files.push({
          transferFileId: instance.transferFileId,
          studyInstanceUID: study.studyInstanceUID,
          seriesInstanceUID: series.seriesInstanceUID,
          sopInstanceUID: instance.sopInstanceUID,
          transferSyntaxUID: instance.transferSyntaxUID,
          instanceNumber: instance.instanceNumber
        })
      }
    }

    return {
      study,
      orderedSeries,
      instanceCount,
      files
    }
  })

  return {
    rootLabel,
    studyCount: orderedStudies.length,
    seriesCount: orderedStudies.reduce((total, item) => total + item.orderedSeries.length, 0),
    instanceCount: orderedStudies.reduce((total, item) => total + item.instanceCount, 0),
    studies: orderedStudies.map(({ study, orderedSeries }) => ({
      studyInstanceUID: study.studyInstanceUID,
      patientName: study.patientName,
      series: orderedSeries.map((series) => ({
        seriesInstanceUID: series.seriesInstanceUID,
        modality: series.modality,
        seriesDescription: series.seriesDescription,
        instanceCount: series.instances.length
      }))
    })),
    files: orderedStudies.flatMap((item) => item.files)
  }
}

export function buildSelectedStudyOfferPayload(
  scanResult: ScanResult | null,
  selectedStudyInstanceUIDs: string[]
): StudyOfferPayload | null {
  if (!scanResult) {
    return null
  }

  const selectedSet = new Set(selectedStudyInstanceUIDs)
  const selectedStudies = scanResult.studies.filter((study) => selectedSet.has(study.studyInstanceUID))
  if (selectedStudies.length === 0) {
    return null
  }

  return buildStudyOfferPayload(scanResult.rootFolder, selectedStudies)
}

export function getActiveReceivedSeriesEntry(
  seriesEntries: SeriesEntry[],
  activeSeriesUID: string | null,
  activeReceiveOfferId: string | null
) {
  const matchingEntries = seriesEntries.filter((entry) => entry.series.seriesInstanceUID === activeSeriesUID)

  return (
    matchingEntries.find((entry) => entry.series.receiveOfferId === activeReceiveOfferId) ??
    matchingEntries[0] ??
    null
  )
}
