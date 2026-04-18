import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type {
  EvaluationEventPayload,
  EvaluationExportReadiness,
  EvaluationRawEvent,
  EvaluationSessionExportPayload,
  EvaluationSessionSummary,
  StudyMetricsRecord,
  WorkflowMode
} from '../shared/types'

let metricsRoot = path.join(process.cwd(), 'evaluation-logs')
const sessionId = randomUUID()

type FailureType = NonNullable<StudyMetricsRecord['failureType']>
type IncompleteReason = NonNullable<StudyMetricsRecord['incompleteReason']>

type StudyMetricsAccumulator = {
  studyId: string
  workflowMode: WorkflowMode
  direction?: StudyMetricsRecord['direction']
  incompleteReason?: IncompleteReason
  errorCount: number
  confidenceScore?: number
  adequacyForTask?: StudyMetricsRecord['adequacyForTask']
  failureType?: FailureType
  transferBytesTotal?: number
  totalBytes?: number
  totalStudyInstanceCount?: number
  receivedInstanceCount?: number
  firstReviewAvailabilityPercent?: number
  reviewStartedBeforeTransferComplete?: boolean
  waitAfterFirstReviewMs?: number
  lastKnownAvailableInstanceCount?: number
  lastKnownExpectedInstanceCount?: number
  timestamps: {
    transferStartedAtMs?: number
    studyVisibleAtMs?: number
    studySelectedAtMs?: number
    firstImageRenderedAtMs?: number
    transferCompletedAtMs?: number
    transferFailedAtMs?: number
  }
}

const rawEvents: EvaluationRawEvent[] = []
const studyMetricsAccumulators = new Map<string, StudyMetricsAccumulator>()
const completedStudies = new Map<string, StudyMetricsRecord>()
const offerIdToStudyId = new Map<string, string>()
let sessionHasActivity = false
let rawEventSequence = 0

function getSessionFilePath() {
  return path.join(metricsRoot, `session-${sessionId}.jsonl`)
}

function toNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function toStringValue(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function toPositiveDuration(startMs: number | undefined, endMs: number | undefined) {
  if (typeof startMs !== 'number' || typeof endMs !== 'number' || endMs <= startMs) {
    return undefined
  }

  return endMs - startMs
}

function roundToTwoDecimalPlaces(value: number) {
  return Math.round(value * 100) / 100
}

function average(values: number[]) {
  if (values.length === 0) {
    return null
  }

  const total = values.reduce((sum, value) => sum + value, 0)
  return roundToTwoDecimalPlaces(total / values.length)
}

function pickNumbers(values: Array<number | undefined>) {
  return values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
}

function appendCount(counter: Record<string, number>, key: string | undefined) {
  if (!key) {
    return
  }

  counter[key] = (counter[key] ?? 0) + 1
}

function mapFailureType(payload: EvaluationEventPayload): FailureType | undefined {
  if (payload.eventType === 'transfer_failed') {
    return 'transfer'
  }

  if (payload.eventType === 'scan_error' || payload.errorType === 'scan') {
    return 'scan'
  }

  if (payload.eventType === 'decode_error' || payload.errorType === 'decode') {
    return 'decode'
  }

  if (payload.errorType === 'accept') {
    return 'accept'
  }

  if (payload.errorType === 'connect') {
    return 'connect'
  }

  return undefined
}

function appendRawEvent(payload: EvaluationEventPayload, timestampIso: string) {
  const rawEvent: EvaluationRawEvent = {
    sessionId,
    sequence: rawEventSequence + 1,
    timestamp: timestampIso,
    eventType: payload.eventType,
    workflowMode: payload.workflowMode,
    studyId: payload.studyId,
    screen: payload.screen,
    studyCount: payload.studyCount,
    seriesCount: payload.seriesCount,
    instanceCount: payload.instanceCount,
    elapsedMs: payload.elapsedMs,
    errorType: payload.errorType,
    confidenceScore: payload.confidenceScore,
    details: payload.details
  }

  rawEventSequence = rawEvent.sequence
  rawEvents.push(rawEvent)
  return rawEvent
}

async function appendEvaluationEvent(rawEvent: EvaluationRawEvent) {
  await fs.mkdir(metricsRoot, { recursive: true })
  await fs.appendFile(getSessionFilePath(), `${JSON.stringify(rawEvent)}\n`, 'utf8')
}

function getOrCreateStudyMetricsAccumulator(payload: EvaluationEventPayload) {
  if (!payload.studyId) {
    throw new Error('Study metrics accumulator requires studyId')
  }

  const existing = studyMetricsAccumulators.get(payload.studyId)
  if (existing) {
    return existing
  }

  const created: StudyMetricsAccumulator = {
    studyId: payload.studyId,
    workflowMode: payload.workflowMode,
    direction:
      payload.workflowMode === 'p2p_send' ? 'send' : payload.workflowMode === 'p2p_receive' ? 'receive' : undefined,
    errorCount: 0,
    timestamps: {}
  }

  studyMetricsAccumulators.set(payload.studyId, created)
  return created
}

function applyAvailabilityDetails(accumulator: StudyMetricsAccumulator, payload: EvaluationEventPayload) {
  const details = payload.details
  const availableInstanceCount = toNumber(details?.availableInstanceCount)
  const expectedInstanceCount = toNumber(details?.expectedInstanceCount) ?? toNumber(details?.instanceCount)

  if (typeof availableInstanceCount === 'number') {
    accumulator.lastKnownAvailableInstanceCount = availableInstanceCount
    accumulator.receivedInstanceCount = availableInstanceCount
  }

  if (typeof expectedInstanceCount === 'number') {
    accumulator.lastKnownExpectedInstanceCount = expectedInstanceCount
    accumulator.totalStudyInstanceCount = expectedInstanceCount
  }

  if (
    payload.eventType === 'study_selected' &&
    typeof availableInstanceCount === 'number' &&
    typeof expectedInstanceCount === 'number' &&
    expectedInstanceCount > 0
  ) {
    accumulator.firstReviewAvailabilityPercent = roundToTwoDecimalPlaces((availableInstanceCount / expectedInstanceCount) * 100)
  }
}

function updateStudyMetricsAccumulator(payload: EvaluationEventPayload, eventTimestampMs: number) {
  const accumulator = getOrCreateStudyMetricsAccumulator(payload)
  const details = payload.details
  const offerId = toStringValue(details?.offerId)

  if (offerId && (payload.eventType === 'transfer_started' || payload.eventType === 'offer_accepted')) {
    offerIdToStudyId.set(offerId, accumulator.studyId)
  }

  if (
    payload.eventType === 'scan_error' ||
    payload.eventType === 'decode_error' ||
    payload.eventType === 'transfer_failed' ||
    typeof payload.errorType === 'string'
  ) {
    accumulator.errorCount += 1
  }

  const failureType = mapFailureType(payload)
  if (failureType) {
    accumulator.failureType = failureType
  }

  if (typeof payload.confidenceScore === 'number') {
    // Keep the raw numeric feedback and the domain-facing adequacy label together on export.
    accumulator.confidenceScore = payload.confidenceScore
    accumulator.adequacyForTask = payload.confidenceScore >= 0.5 ? 'adequate' : 'inadequate'
  }

  if (typeof payload.instanceCount === 'number' && payload.instanceCount >= 0) {
    if (payload.workflowMode === 'local' && payload.eventType === 'scan_completed') {
      accumulator.totalStudyInstanceCount = payload.instanceCount
    }

    if (payload.workflowMode === 'p2p_send' && payload.eventType === 'transfer_started') {
      accumulator.totalStudyInstanceCount = payload.instanceCount
    }
  }

  const detailsTotalBytes = toNumber(details?.totalBytes)
  if (typeof detailsTotalBytes === 'number') {
    accumulator.totalBytes = detailsTotalBytes
  }

  applyAvailabilityDetails(accumulator, payload)

  if (payload.eventType === 'transfer_started') {
    accumulator.timestamps.transferStartedAtMs = accumulator.timestamps.transferStartedAtMs ?? eventTimestampMs
  }

  if (payload.eventType === 'study_visible') {
    accumulator.timestamps.studyVisibleAtMs = accumulator.timestamps.studyVisibleAtMs ?? eventTimestampMs
  }

  if (payload.eventType === 'study_selected') {
    accumulator.timestamps.studySelectedAtMs = accumulator.timestamps.studySelectedAtMs ?? eventTimestampMs
  }

  if (payload.eventType === 'first_image_rendered') {
    accumulator.timestamps.firstImageRenderedAtMs = accumulator.timestamps.firstImageRenderedAtMs ?? eventTimestampMs

    if (
      accumulator.workflowMode === 'p2p_receive' &&
      typeof accumulator.timestamps.transferCompletedAtMs !== 'number'
    ) {
      accumulator.reviewStartedBeforeTransferComplete = true
    }
  }

  if (payload.eventType === 'transfer_completed') {
    accumulator.timestamps.transferCompletedAtMs = accumulator.timestamps.transferCompletedAtMs ?? eventTimestampMs

    if (
      accumulator.workflowMode === 'p2p_receive' &&
      typeof accumulator.timestamps.firstImageRenderedAtMs === 'number' &&
      accumulator.timestamps.firstImageRenderedAtMs < accumulator.timestamps.transferCompletedAtMs
    ) {
      accumulator.reviewStartedBeforeTransferComplete = true
      accumulator.waitAfterFirstReviewMs = accumulator.timestamps.transferCompletedAtMs - accumulator.timestamps.firstImageRenderedAtMs
    }

    if (accumulator.workflowMode === 'p2p_receive' && typeof accumulator.totalStudyInstanceCount === 'number') {
      accumulator.receivedInstanceCount = accumulator.totalStudyInstanceCount
    }
  }

  if (payload.eventType === 'transfer_failed') {
    accumulator.timestamps.transferFailedAtMs = accumulator.timestamps.transferFailedAtMs ?? eventTimestampMs
  }
}

function shouldFinalizeStudy(accumulator: StudyMetricsAccumulator) {
  if (accumulator.workflowMode === 'p2p_send') {
    return (
      typeof accumulator.timestamps.transferCompletedAtMs === 'number' ||
      typeof accumulator.timestamps.transferFailedAtMs === 'number'
    )
  }

  if (accumulator.workflowMode === 'local') {
    return typeof accumulator.adequacyForTask === 'string'
  }

  if (accumulator.workflowMode === 'p2p_receive') {
    const hasTerminalTransfer =
      typeof accumulator.timestamps.transferCompletedAtMs === 'number' ||
      typeof accumulator.timestamps.transferFailedAtMs === 'number'

    if (!hasTerminalTransfer) {
      return false
    }

    if (typeof accumulator.timestamps.firstImageRenderedAtMs === 'number') {
      return typeof accumulator.adequacyForTask === 'string'
    }

    return true
  }

  return false
}

function buildStudyMetricsRecord(accumulator: StudyMetricsAccumulator): StudyMetricsRecord {
  const transferStartedAtMs = accumulator.timestamps.transferStartedAtMs
  const studyVisibleAtMs = accumulator.timestamps.studyVisibleAtMs
  const studySelectedAtMs = accumulator.timestamps.studySelectedAtMs
  const firstImageRenderedAtMs = accumulator.timestamps.firstImageRenderedAtMs
  const transferCompletedAtMs = accumulator.timestamps.transferCompletedAtMs
  const transferFailedAtMs = accumulator.timestamps.transferFailedAtMs

  // Design rule: retain unique metrics; remove only redundant timing measures.
  const ttfIMs = toPositiveDuration(studySelectedAtMs, firstImageRenderedAtMs)
  const transferDurationMs = toPositiveDuration(transferStartedAtMs, transferCompletedAtMs)
  const studyAvailableMs = toPositiveDuration(transferStartedAtMs, studyVisibleAtMs)

  const totalStudyInstanceCount = accumulator.totalStudyInstanceCount ?? accumulator.lastKnownExpectedInstanceCount
  let receivedInstanceCount = accumulator.receivedInstanceCount ?? accumulator.lastKnownAvailableInstanceCount

  if (
    accumulator.workflowMode === 'p2p_receive' &&
    typeof receivedInstanceCount !== 'number' &&
    typeof totalStudyInstanceCount === 'number' &&
    typeof transferCompletedAtMs === 'number'
  ) {
    receivedInstanceCount = totalStudyInstanceCount
  }

  const completenessPercent =
    accumulator.workflowMode === 'p2p_receive' &&
    typeof totalStudyInstanceCount === 'number' &&
    totalStudyInstanceCount > 0 &&
    typeof receivedInstanceCount === 'number'
      ? roundToTwoDecimalPlaces((receivedInstanceCount / totalStudyInstanceCount) * 100)
      : accumulator.workflowMode === 'p2p_send' && typeof transferCompletedAtMs === 'number'
        ? 100
        : accumulator.workflowMode === 'p2p_send' && typeof transferFailedAtMs === 'number'
          ? 0
          : undefined

  const transportThroughputMbps =
    typeof accumulator.transferBytesTotal === 'number' &&
    typeof transferDurationMs === 'number' &&
    transferDurationMs > 0
      ? roundToTwoDecimalPlaces((accumulator.transferBytesTotal * 8) / transferDurationMs / 1000)
      : undefined

  const reviewStartedBeforeTransferComplete =
    accumulator.workflowMode === 'p2p_receive'
      ? accumulator.reviewStartedBeforeTransferComplete ??
        (typeof firstImageRenderedAtMs === 'number' &&
        typeof transferCompletedAtMs === 'number' &&
        firstImageRenderedAtMs < transferCompletedAtMs
          ? true
          : undefined)
      : undefined

  const waitAfterFirstReviewMs =
    accumulator.workflowMode === 'p2p_receive'
      ? accumulator.waitAfterFirstReviewMs ??
        toPositiveDuration(firstImageRenderedAtMs, transferCompletedAtMs)
      : undefined

  let outcome: StudyMetricsRecord['outcome']
  if (accumulator.workflowMode === 'p2p_send') {
    outcome =
      typeof transferFailedAtMs === 'number'
        ? 'transfer_failed'
        : typeof transferCompletedAtMs === 'number'
          ? 'completed_not_reviewed'
          : undefined
  } else if (accumulator.workflowMode === 'local') {
    outcome =
      typeof firstImageRenderedAtMs === 'number'
        ? 'completed_reviewed'
        : accumulator.failureType
          ? 'failed_before_review'
          : undefined
  } else {
    outcome =
      typeof transferFailedAtMs === 'number'
        ? typeof firstImageRenderedAtMs === 'number'
          ? 'partial_reviewed'
          : 'failed_before_review'
        : typeof transferCompletedAtMs === 'number'
          ? typeof firstImageRenderedAtMs === 'number'
            ? 'completed_reviewed'
            : 'completed_not_reviewed'
          : typeof firstImageRenderedAtMs === 'number'
            ? 'partial_reviewed'
            : undefined
  }

  const record: StudyMetricsRecord = {
    studyId: accumulator.studyId,
    workflowMode: accumulator.workflowMode,
    direction: accumulator.direction,
    incomplete: Boolean(accumulator.incompleteReason),
    incompleteReason: accumulator.incompleteReason,
    ttfIMs,
    transferDurationMs,
    studyAvailableMs,
    firstReviewAvailabilityPercent: accumulator.firstReviewAvailabilityPercent,
    reviewStartedBeforeTransferComplete,
    waitAfterFirstReviewMs,
    transferBytesTotal: accumulator.transferBytesTotal,
    transportThroughputMbps,
    totalStudyInstanceCount,
    receivedInstanceCount,
    completenessPercent,
    totalBytes: accumulator.totalBytes,
    errorCount: accumulator.errorCount,
    confidenceScore: accumulator.confidenceScore,
    adequacyForTask: accumulator.adequacyForTask,
    outcome,
    failureType: accumulator.failureType
  }

  if (accumulator.workflowMode === 'local') {
    delete record.studyAvailableMs
    delete record.reviewStartedBeforeTransferComplete
    delete record.waitAfterFirstReviewMs
    delete record.receivedInstanceCount
    delete record.completenessPercent
  }

  return record
}

function finalizeStudy(studyId: string) {
  if (completedStudies.has(studyId)) {
    return
  }

  const accumulator = studyMetricsAccumulators.get(studyId)
  if (!accumulator) {
    return
  }

  completedStudies.set(studyId, buildStudyMetricsRecord(accumulator))
  studyMetricsAccumulators.delete(studyId)

  for (const [offerId, mappedStudyId] of offerIdToStudyId.entries()) {
    if (mappedStudyId === studyId) {
      offerIdToStudyId.delete(offerId)
    }
  }
}

function maybeFinalizeStudy(studyId: string) {
  const accumulator = studyMetricsAccumulators.get(studyId)
  if (!accumulator || !shouldFinalizeStudy(accumulator)) {
    return
  }

  finalizeStudy(studyId)
}

function buildSessionSummaryFromStudies(studies: StudyMetricsRecord[]): EvaluationSessionSummary {
  const receiveStudies = studies.filter((study) => study.workflowMode === 'p2p_receive')
  const sendStudies = studies.filter((study) => study.workflowMode === 'p2p_send')
  const adequacyEligibleStudies = studies.filter((study) => study.workflowMode !== 'p2p_send')
  const reviewedStudies = studies.filter(
    (study) =>
      typeof study.ttfIMs === 'number' ||
      study.outcome === 'completed_reviewed' ||
      study.outcome === 'partial_reviewed'
  )

  const outcomeCounts: Record<string, number> = {}
  for (const study of studies) {
    appendCount(outcomeCounts, study.outcome)
  }

  const failureCounts = {
    transfer: studies.filter((study) => study.failureType === 'transfer').length,
    decode: studies.filter((study) => study.failureType === 'decode').length,
    scan: studies.filter((study) => study.failureType === 'scan').length,
    accept: studies.filter((study) => study.failureType === 'accept').length,
    connect: studies.filter((study) => study.failureType === 'connect').length
  }

  return {
    totalStudyCount: studies.length,
    sendStudyCount: sendStudies.length,
    receiveStudyCount: receiveStudies.length,
    reviewedStudyCount: reviewedStudies.length,
    reviewStartedBeforeTransferCompleteCount: receiveStudies.filter((study) => study.reviewStartedBeforeTransferComplete).length,
    adequacyCounts: {
      adequate: adequacyEligibleStudies.filter((study) => study.adequacyForTask === 'adequate').length,
      inadequate: adequacyEligibleStudies.filter((study) => study.adequacyForTask === 'inadequate').length,
      missing: adequacyEligibleStudies.filter((study) => !study.adequacyForTask).length
    },
    outcomeCounts,
    failureCounts,
    receiveMetrics: {
      avgTTFIMs: average(pickNumbers(receiveStudies.map((study) => study.ttfIMs))),
      avgStudyAvailableMs: average(pickNumbers(receiveStudies.map((study) => study.studyAvailableMs))),
      avgTransferDurationMs: average(pickNumbers(receiveStudies.map((study) => study.transferDurationMs))),
      avgTransportThroughputMbps: average(pickNumbers(receiveStudies.map((study) => study.transportThroughputMbps))),
      avgFirstReviewAvailabilityPercent: average(
        pickNumbers(receiveStudies.map((study) => study.firstReviewAvailabilityPercent))
      ),
      avgWaitAfterFirstReviewMs: average(pickNumbers(receiveStudies.map((study) => study.waitAfterFirstReviewMs))),
      avgCompletenessPercent: average(pickNumbers(receiveStudies.map((study) => study.completenessPercent)))
    },
    sendMetrics: {
      avgTransferDurationMs: average(pickNumbers(sendStudies.map((study) => study.transferDurationMs))),
      avgTransportThroughputMbps: average(pickNumbers(sendStudies.map((study) => study.transportThroughputMbps))),
      avgCompletenessPercent: average(pickNumbers(sendStudies.map((study) => study.completenessPercent))),
      totalBytesTransferred: sendStudies.reduce(
        (total, study) => total + (typeof study.transferBytesTotal === 'number' ? study.transferBytesTotal : 0),
        0
      )
    }
  }
}

function autoFinalizeActiveStudiesForExport() {
  for (const accumulator of studyMetricsAccumulators.values()) {
    if (accumulator.workflowMode === 'local' && typeof accumulator.timestamps.firstImageRenderedAtMs !== 'number') {
      accumulator.incompleteReason = 'local_timeout'
    }

    if (
      accumulator.workflowMode === 'p2p_receive' &&
      typeof accumulator.timestamps.transferCompletedAtMs !== 'number' &&
      typeof accumulator.timestamps.transferFailedAtMs !== 'number'
    ) {
      accumulator.incompleteReason = 'receive_timeout_after_transfer'
    }

    if (
      accumulator.workflowMode === 'p2p_send' &&
      typeof accumulator.timestamps.transferCompletedAtMs !== 'number' &&
      typeof accumulator.timestamps.transferFailedAtMs !== 'number'
    ) {
      accumulator.failureType = accumulator.failureType ?? 'transfer'
    }
  }

  for (const studyId of [...studyMetricsAccumulators.keys()]) {
    finalizeStudy(studyId)
  }
}

export async function configureEvaluationMetrics(rootDirectory: string) {
  metricsRoot = rootDirectory
  await fs.mkdir(metricsRoot, { recursive: true })
}

export function recordTransferChunkBytes(input: { offerId: string; byteLength: number }) {
  if (!Number.isFinite(input.byteLength) || input.byteLength <= 0) {
    return
  }

  const studyId = offerIdToStudyId.get(input.offerId)
  if (!studyId) {
    return
  }

  const accumulator = studyMetricsAccumulators.get(studyId)
  if (!accumulator) {
    return
  }

  accumulator.transferBytesTotal = (accumulator.transferBytesTotal ?? 0) + input.byteLength
}

export async function logEvaluationEvent(payload: EvaluationEventPayload) {
  sessionHasActivity = true

  const eventTimestampMs = Date.now()
  const eventTimestampIso = new Date(eventTimestampMs).toISOString()
  const rawEvent = appendRawEvent(payload, eventTimestampIso)
  await appendEvaluationEvent(rawEvent)

  if (!payload.studyId || completedStudies.has(payload.studyId)) {
    return
  }

  updateStudyMetricsAccumulator(payload, eventTimestampMs)
  maybeFinalizeStudy(payload.studyId)
}

export function getEvaluationExportReadiness(): EvaluationExportReadiness {
  const hasActiveP2PSendAccumulator = [...studyMetricsAccumulators.values()].some(
    (accumulator) =>
      accumulator.workflowMode === 'p2p_send' &&
      typeof accumulator.timestamps.transferCompletedAtMs !== 'number' &&
      typeof accumulator.timestamps.transferFailedAtMs !== 'number'
  )

  return {
    hasSessionBegun: sessionHasActivity || rawEvents.length > 0 || completedStudies.size > 0 || studyMetricsAccumulators.size > 0,
    finalizedStudyCount: completedStudies.size,
    hasActiveP2PSendAccumulator,
    hasActiveStudyAccumulator: studyMetricsAccumulators.size > 0
  }
}

export function exportEvaluationSession(): EvaluationSessionExportPayload {
  autoFinalizeActiveStudiesForExport()

  const studies = [...completedStudies.values()]
  const sessionSummary = buildSessionSummaryFromStudies(studies)

  return {
    sessionId,
    exportedAt: new Date().toISOString(),
    studies,
    sessionSummary,
    rawEvents: [...rawEvents]
  }
}
