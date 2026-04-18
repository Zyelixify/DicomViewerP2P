export type ReceiveProgressStatus = 'receiving' | 'complete' | 'failed' | 'partial'

export type InstanceMetadata = {
  sopInstanceUID: string
  filePath: string
  transferFileId?: string
  transferSyntaxUID?: string
  instanceNumber?: number
}

export type SeriesMetadata = {
  seriesInstanceUID: string
  modality: string
  seriesDescription?: string
  instances: InstanceMetadata[]
  expectedInstanceCount?: number
  availableInstanceCount?: number
  receiveProgressStatus?: ReceiveProgressStatus
  receiveOfferId?: string
}

export type StudyMetadata = {
  studyInstanceUID: string
  patientName: string
  series: SeriesMetadata[]
}

export type ScanResult = {
  studyId?: string
  rootFolder: string
  studies: StudyMetadata[]
  scannedFileCount: number
  dicomFileCount: number
  elapsedMs: number
}

export type DiscoveredPeer = {
  peerId: string
  displayName: string
  address: string
  transferPort: number
  lastSeenAt: number
}

export type PeerDiscoveryState = {
  isRunning: boolean
  localPeerId: string
  displayName: string
  port: number
  transferPort: number
  peers: DiscoveredPeer[]
}

export type TransferSessionPeer = {
  peerId: string
  displayName: string
  address: string
  connectedAt: number
}

export type StudyOfferSummary = {
  offerId: string
  senderPeerId: string
  senderDisplayName: string
  rootLabel: string
  studyCount: number
  seriesCount: number
  instanceCount: number
  createdAt: number
}

export type SeriesManifestSummary = {
  seriesInstanceUID: string
  modality: string
  seriesDescription?: string
  instanceCount: number
}

export type StudyManifestSummary = {
  studyInstanceUID: string
  patientName: string
  series: SeriesManifestSummary[]
}

export type TransferManifestPayload = {
  rootLabel: string
  studyCount: number
  seriesCount: number
  instanceCount: number
  studies: StudyManifestSummary[]
  files: TransferFileDescriptor[]
}

export type TransferFileDescriptor = {
  fileId: string
  fileName: string
  sizeBytes: number
  studyInstanceUID: string
  seriesInstanceUID: string
  sopInstanceUID: string
  transferSyntaxUID?: string
  instanceNumber?: number
}

export type OutboundTransferFileInput = {
  transferFileId: string
  studyInstanceUID: string
  seriesInstanceUID: string
  sopInstanceUID: string
  transferSyntaxUID?: string
  instanceNumber?: number
}

export type StudyOfferPayload = {
  rootLabel: string
  studyCount: number
  seriesCount: number
  instanceCount: number
  studies: StudyManifestSummary[]
  files: OutboundTransferFileInput[]
}

export type ReceivedStudyManifest = {
  offerId: string
  senderPeerId: string
  senderDisplayName: string
  payload: TransferManifestPayload
  receivedAt: number
}

export type TransferFileProgress = {
  transferId: string
  fileId: string
  offerId: string
  fileName: string
  totalBytes: number
  receivedBytes: number
  totalChunks: number
  receivedChunks: number
  status: 'receiving' | 'retrying' | 'complete' | 'error'
  savedToPath?: string
  expectedSha256?: string
  computedSha256?: string
  retryCount: number
}

export type OutboundTransferFileProgress = {
  transferId: string
  offerId: string
  fileId: string
  fileName: string
  totalBytes: number
  sentBytes: number
  totalChunks: number
  sentChunks: number
  status: 'pending' | 'streaming' | 'complete' | 'error'
}

export type TransferSessionState = {
  isServerRunning: boolean
  serverPort: number
  localPeerId: string
  connectedPeer: TransferSessionPeer | null
  activeOutboundOfferId: string | null
  outboundFileTransfers: OutboundTransferFileProgress[]
  inboundStudyOffers: StudyOfferSummary[]
  inboundStudyManifests: ReceivedStudyManifest[]
  inboundFileTransfers: TransferFileProgress[]
  inboxDirectory: string
  lastEvent: string
  lastTerminalOffer:
    | {
        workflowMode: 'p2p_send' | 'p2p_receive'
        offerId: string
        status: 'completed' | 'failed'
        transferId?: string
        reason?: string
        at: number
      }
    | null
}

export type WorkflowMode = 'local' | 'p2p_send' | 'p2p_receive'

export interface StudyMetricsRecord {
  studyId: string
  workflowMode: WorkflowMode
  direction?: 'send' | 'receive'
  incomplete?: boolean
  incompleteReason?: 'local_timeout' | 'receive_timeout_after_transfer'
  ttfIMs?: number
  transferDurationMs?: number
  studyAvailableMs?: number
  firstReviewAvailabilityPercent?: number
  reviewStartedBeforeTransferComplete?: boolean
  waitAfterFirstReviewMs?: number
  transferBytesTotal?: number
  transportThroughputMbps?: number
  totalStudyInstanceCount?: number
  receivedInstanceCount?: number
  completenessPercent?: number
  totalBytes?: number
  errorCount: number
  confidenceScore?: number
  adequacyForTask?: 'adequate' | 'inadequate'
  outcome?: 'completed_reviewed' | 'completed_not_reviewed' | 'transfer_failed' | 'partial_reviewed' | 'failed_before_review'
  failureType?: 'transfer' | 'decode' | 'scan' | 'accept' | 'connect'
}

export type EvaluationRawEvent = {
  sessionId: string
  sequence: number
  timestamp: string
  eventType: string
  workflowMode: WorkflowMode
  studyId?: string
  screen?: string
  studyCount?: number
  seriesCount?: number
  instanceCount?: number
  elapsedMs?: number
  errorType?: string
  confidenceScore?: number
  details?: Record<string, unknown>
}

export type EvaluationEventPayload = {
  eventType: string
  workflowMode: WorkflowMode
  studyId?: string
  screen?: string
  studyCount?: number
  seriesCount?: number
  instanceCount?: number
  elapsedMs?: number
  errorType?: string
  confidenceScore?: number
  details?: Record<string, unknown>
}

export type EvaluationSessionSummary = {
  totalStudyCount: number
  sendStudyCount: number
  receiveStudyCount: number
  reviewedStudyCount: number
  reviewStartedBeforeTransferCompleteCount: number
  adequacyCounts: {
    adequate: number
    inadequate: number
    missing: number
  }
  outcomeCounts: Record<string, number>
  failureCounts: {
    transfer: number
    decode: number
    scan: number
    accept: number
    connect: number
  }
  receiveMetrics: {
    avgTTFIMs: number | null
    avgStudyAvailableMs: number | null
    avgTransferDurationMs: number | null
    avgTransportThroughputMbps: number | null
    avgFirstReviewAvailabilityPercent: number | null
    avgWaitAfterFirstReviewMs: number | null
    avgCompletenessPercent: number | null
  }
  sendMetrics: {
    avgTransferDurationMs: number | null
    avgTransportThroughputMbps: number | null
    avgCompletenessPercent: number | null
    totalBytesTransferred: number
  }
}

export type EvaluationSessionExportPayload = {
  sessionId: string
  exportedAt: string
  studies: StudyMetricsRecord[]
  sessionSummary: EvaluationSessionSummary
  rawEvents: EvaluationRawEvent[]
}

export type EvaluationExportReadiness = {
  hasSessionBegun: boolean
  finalizedStudyCount: number
  hasActiveP2PSendAccumulator: boolean
  hasActiveStudyAccumulator: boolean
}

export type EvaluationExportResult =
  | {
      ok: true
      filePath: string
    }
  | {
      ok: false
      canceled?: boolean
      error: string
    }

export type AppApi = {
  pickAndScanFolder: () => Promise<ScanResult | null>
  openFolderInSystem: (folderPath: string) => Promise<void>
  scanTransferInbox: () => Promise<ScanResult>
  clearTransferInbox: () => Promise<TransferSessionState>
  readDicomFile: (filePath: string) => Promise<ArrayBuffer>
  startPeerDiscovery: () => Promise<PeerDiscoveryState>
  stopPeerDiscovery: () => Promise<PeerDiscoveryState>
  getPeerDiscoveryState: () => Promise<PeerDiscoveryState>
  startTransferServer: () => Promise<TransferSessionState>
  stopTransferServer: () => Promise<TransferSessionState>
  getTransferSessionState: () => Promise<TransferSessionState>
  connectToTransferPeer: (address: string, port?: number) => Promise<TransferSessionState>
  disconnectTransferPeer: () => Promise<TransferSessionState>
  sendStudyOffer: (payload: StudyOfferPayload) => Promise<{ state: TransferSessionState; studyId: string }>
  acceptStudyOffer: (offerId: string) => Promise<{ state: TransferSessionState; studyId: string }>
  getEvaluationExportReadiness: () => Promise<EvaluationExportReadiness>
  getSurveyLink: () => Promise<string | null>
  openSurveyLink: () => Promise<void>
  logEvaluationEvent: (payload: EvaluationEventPayload) => Promise<void>
  exportEvaluationSession: () => Promise<EvaluationExportResult>
}
