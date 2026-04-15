export const IPC_CHANNELS = {
  pickAndScanFolder: 'folder:pick-and-scan',
  openFolderInSystem: 'folder:open-in-system',
  scanTransferInbox: 'transfer:scan-inbox',
  clearTransferInbox: 'transfer:clear-inbox',
  readDicomFile: 'dicom:read-file',
  startPeerDiscovery: 'peer:start-discovery',
  stopPeerDiscovery: 'peer:stop-discovery',
  getPeerDiscoveryState: 'peer:get-state',
  startTransferServer: 'transfer:start-server',
  stopTransferServer: 'transfer:stop-server',
  getTransferSessionState: 'transfer:get-state',
  connectToTransferPeer: 'transfer:connect-peer',
  disconnectTransferPeer: 'transfer:disconnect-peer',
  sendStudyOffer: 'transfer:send-study-offer',
  acceptStudyOffer: 'transfer:accept-study-offer',
  transferStateUpdated: 'transfer:state-updated',
  getEvaluationExportReadiness: 'metrics:get-export-readiness',
  getSurveyLink: 'survey:get-link',
  openSurveyLink: 'survey:open-link',
  logEvaluationEvent: 'metrics:log-event',
  exportEvaluationSession: 'metrics:export-session'
} as const

export const TRANSFER_STATE_UPDATED_EVENT = 'transfer-state-updated'
