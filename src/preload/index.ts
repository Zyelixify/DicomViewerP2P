import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, TRANSFER_STATE_UPDATED_EVENT } from '../shared/ipc'
import type { AppApi, EvaluationEventPayload, StudyOfferPayload } from '../shared/types'

const api: AppApi = {
  pickAndScanFolder: () => ipcRenderer.invoke(IPC_CHANNELS.pickAndScanFolder),
  openFolderInSystem: (folderPath: string) => ipcRenderer.invoke(IPC_CHANNELS.openFolderInSystem, folderPath),
  scanTransferInbox: () => ipcRenderer.invoke(IPC_CHANNELS.scanTransferInbox),
  clearTransferInbox: () => ipcRenderer.invoke(IPC_CHANNELS.clearTransferInbox),
  readDicomFile: (filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.readDicomFile, filePath),
  startPeerDiscovery: () => ipcRenderer.invoke(IPC_CHANNELS.startPeerDiscovery),
  stopPeerDiscovery: () => ipcRenderer.invoke(IPC_CHANNELS.stopPeerDiscovery),
  getPeerDiscoveryState: () => ipcRenderer.invoke(IPC_CHANNELS.getPeerDiscoveryState),
  startTransferServer: () => ipcRenderer.invoke(IPC_CHANNELS.startTransferServer),
  stopTransferServer: () => ipcRenderer.invoke(IPC_CHANNELS.stopTransferServer),
  getTransferSessionState: () => ipcRenderer.invoke(IPC_CHANNELS.getTransferSessionState),
  connectToTransferPeer: (address: string, port?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.connectToTransferPeer, address, port),
  disconnectTransferPeer: () => ipcRenderer.invoke(IPC_CHANNELS.disconnectTransferPeer),
  sendStudyOffer: (payload: StudyOfferPayload) => ipcRenderer.invoke(IPC_CHANNELS.sendStudyOffer, payload),
  acceptStudyOffer: (offerId: string) => ipcRenderer.invoke(IPC_CHANNELS.acceptStudyOffer, offerId),
  getEvaluationExportReadiness: () => ipcRenderer.invoke(IPC_CHANNELS.getEvaluationExportReadiness),
  getSurveyLink: () => ipcRenderer.invoke(IPC_CHANNELS.getSurveyLink),
  openSurveyLink: () => ipcRenderer.invoke(IPC_CHANNELS.openSurveyLink),
  logEvaluationEvent: (payload: EvaluationEventPayload) => ipcRenderer.invoke(IPC_CHANNELS.logEvaluationEvent, payload),
  exportEvaluationSession: () => ipcRenderer.invoke(IPC_CHANNELS.exportEvaluationSession)
}

contextBridge.exposeInMainWorld('appApi', api)

ipcRenderer.on(IPC_CHANNELS.transferStateUpdated, (_event, state) => {
  window.dispatchEvent(new CustomEvent(TRANSFER_STATE_UPDATED_EVENT, { detail: state }))
})
