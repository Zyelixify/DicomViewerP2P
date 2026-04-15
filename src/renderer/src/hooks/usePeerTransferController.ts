import { useEffect, useRef, useState } from 'react'
import { TRANSFER_STATE_UPDATED_EVENT } from '../../../shared/ipc'
import type {
  DiscoveredPeer,
  EvaluationEventPayload,
  ScanResult,
  StudyOfferPayload,
  TransferSessionState
} from '../../../shared/types'
import { devLogger } from '../utils/logger'
import { toErrorMessage } from '../utils/viewerUtils'

type UsePeerTransferControllerParams = {
  currentScanOfferPayload: StudyOfferPayload | null
  isDiscoveryModalOpen: boolean
  isReceiveModeActive: boolean
  onReceiveStudyContextCreated: (context: { workflowMode: 'p2p_receive'; studyId: string }) => void
  logEvaluationEvent: (payload: EvaluationEventPayload) => void
}

function hasLiveTransferActivity(transferState: TransferSessionState | null) {
  return Boolean(
    transferState &&
      (
        transferState.activeOutboundOfferId ||
        transferState.inboundStudyOffers.length > 0 ||
        [...transferState.inboundFileTransfers, ...transferState.outboundFileTransfers].some(
          (transfer) => transfer.status !== 'complete' && transfer.status !== 'error'
        )
      )
  )
}

export function usePeerTransferController({
  currentScanOfferPayload,
  isDiscoveryModalOpen,
  isReceiveModeActive,
  onReceiveStudyContextCreated,
  logEvaluationEvent
}: UsePeerTransferControllerParams) {
  const transferStateLastUpdatedAtRef = useRef(Date.now())

  const [peerState, setPeerState] = useState<Awaited<ReturnType<typeof window.appApi.getPeerDiscoveryState>> | null>(null)
  const [transferState, setTransferState] = useState<TransferSessionState | null>(null)
  const [isPeerActionBusy, setIsPeerActionBusy] = useState(false)
  const [peerError, setPeerError] = useState<string | null>(null)

  const applyTransferState = (nextTransferState: TransferSessionState) => {
    transferStateLastUpdatedAtRef.current = Date.now()
    setTransferState(nextTransferState)
  }

  const shouldPollBackgroundState =
    isDiscoveryModalOpen || isReceiveModeActive || hasLiveTransferActivity(transferState)

  useEffect(() => {
    let cancelled = false

    const initializePeerState = async () => {
      try {
        const [nextState, nextTransferState] = await Promise.all([
          window.appApi.getPeerDiscoveryState(),
          window.appApi.getTransferSessionState()
        ])
        if (!cancelled) {
          setPeerState(nextState)
          applyTransferState(nextTransferState)
        }
      } catch (initializationError) {
        if (!cancelled) {
          devLogger.warn('[usePeerTransferController] Failed initializing peer state', initializationError)
          setPeerError(toErrorMessage(initializationError, 'Could not read peer state'))
        }
      }
    }

    void initializePeerState()

    if (!shouldPollBackgroundState) {
      return () => {
        cancelled = true
      }
    }

    const peerInterval = window.setInterval(() => {
      void window.appApi
        .getPeerDiscoveryState()
        .then((nextState) => {
          if (!cancelled) {
            setPeerState(nextState)
          }
        })
        .catch((error) => {
          devLogger.debug('[usePeerTransferController] Failed polling peer discovery state', error)
        })
    }, 2000)

    const transferFallbackInterval = window.setInterval(() => {
      if (Date.now() - transferStateLastUpdatedAtRef.current < 30000) {
        return
      }

      void window.appApi
        .getTransferSessionState()
        .then((nextTransferState) => {
          if (!cancelled) {
            applyTransferState(nextTransferState)
          }
        })
        .catch((error) => {
          devLogger.debug('[usePeerTransferController] Failed polling transfer state', error)
        })
    }, 5000)

    return () => {
      cancelled = true
      window.clearInterval(peerInterval)
      window.clearInterval(transferFallbackInterval)
    }
  }, [shouldPollBackgroundState])

  useEffect(() => {
    const onTransferStateUpdated = (event: WindowEventMap[typeof TRANSFER_STATE_UPDATED_EVENT]) => {
      applyTransferState(event.detail)
    }

    window.addEventListener(TRANSFER_STATE_UPDATED_EVENT, onTransferStateUpdated)

    return () => {
      window.removeEventListener(TRANSFER_STATE_UPDATED_EVENT, onTransferStateUpdated)
    }
  }, [])

  const refreshPeerState = async () => {
    try {
      const [nextState, nextTransferState] = await Promise.all([
        window.appApi.getPeerDiscoveryState(),
        window.appApi.getTransferSessionState()
      ])
      const resolvedPeerState = nextState.isRunning ? nextState : await window.appApi.startPeerDiscovery()
      setPeerState(resolvedPeerState)

      applyTransferState(nextTransferState)
    } catch (refreshError) {
      devLogger.warn('[usePeerTransferController] Failed refreshing peer state', refreshError)
      setPeerError(toErrorMessage(refreshError, 'Could not refresh receiving devices'))
    }
  }

  const stopSendDiscovery = async () => {
    try {
      const nextState = await window.appApi.getPeerDiscoveryState()
      const resolvedPeerState = nextState.isRunning ? await window.appApi.stopPeerDiscovery() : nextState
      setPeerState(resolvedPeerState)
    } catch (error) {
      devLogger.debug('[usePeerTransferController] Failed stopping send discovery', error)
    }
  }

  const startReceiveMode = async () => {
    setPeerError(null)
    setIsPeerActionBusy(true)

    let transferServerStarted = false

    try {
      const nextTransferState = await window.appApi.startTransferServer()
      applyTransferState(nextTransferState)
      transferServerStarted = true
      const nextPeerState = await window.appApi.startPeerDiscovery()
      setPeerState(nextPeerState)
    } catch (startError) {
      if (transferServerStarted) {
        await window.appApi.stopTransferServer().then(applyTransferState).catch((error) => {
          devLogger.debug('[usePeerTransferController] Failed rolling back transfer server start', error)
        })
      }

      setPeerError(toErrorMessage(startError, 'Could not enter receive mode'))
      throw startError
    } finally {
      setIsPeerActionBusy(false)
    }
  }

  const stopReceiveMode = async () => {
    setPeerError(null)
    setIsPeerActionBusy(true)

    let firstStopError: unknown = null

    const rememberStopError = (error: unknown) => {
      if (!firstStopError) {
        firstStopError = error
      }
    }

    try {
      try {
        const nextTransferState = await window.appApi.disconnectTransferPeer()
        applyTransferState(nextTransferState)
      } catch (disconnectError) {
        rememberStopError(disconnectError)
      }

      try {
        const stoppedServerState = await window.appApi.stopTransferServer()
        applyTransferState(stoppedServerState)
      } catch (stopServerError) {
        rememberStopError(stopServerError)
      }

      try {
        const nextPeerState = await window.appApi.stopPeerDiscovery()
        setPeerState(nextPeerState)
      } catch (stopDiscoveryError) {
        rememberStopError(stopDiscoveryError)
      }

      if (firstStopError) {
        throw firstStopError
      }
    } catch (stopError) {
      setPeerError(toErrorMessage(stopError, 'Could not exit receive mode'))
      throw stopError
    } finally {
      setIsPeerActionBusy(false)
    }
  }

  const sendStudyToPeer = async (
    peer: DiscoveredPeer,
    providedOfferPayload?: StudyOfferPayload
  ) => {
    setPeerError(null)
    setIsPeerActionBusy(true)

    try {
      const connectedState = await window.appApi.connectToTransferPeer(peer.address, peer.transferPort)
      applyTransferState(connectedState)

      const offerPayloadInput = providedOfferPayload ?? currentScanOfferPayload

      if (!offerPayloadInput) {
        throw new Error('No scanned study is available to send')
      }

      let latestState = connectedState
      const offerResult = await window.appApi.sendStudyOffer(offerPayloadInput)
      latestState = offerResult.state
      applyTransferState(offerResult.state)

      logEvaluationEvent({
        eventType: 'device_selected',
        workflowMode: 'p2p_send',
        studyId: offerResult.studyId,
        details: {
          peerId: peer.peerId,
          peerName: peer.displayName
        }
      })

      let activeOfferId = latestState.activeOutboundOfferId
      if (!activeOfferId) {
        const refreshedTransferState = await window.appApi.getTransferSessionState()
        applyTransferState(refreshedTransferState)
        activeOfferId = refreshedTransferState.activeOutboundOfferId
      }

      if (!activeOfferId) {
        const transportReason = transferState?.lastEvent?.trim() || latestState.lastEvent?.trim()
        const reasonSuffix = transportReason ? ` (${transportReason})` : ''
        throw new Error(
          `Transfer connection was lost before the receiving device acknowledged the study offer${reasonSuffix}. ` +
            'This can be caused by firewall/network blocking or the receiver no longer listening.'
        )
      }

    } catch (sendError) {
      devLogger.warn(`[usePeerTransferController] Failed sending study offer to ${peer.peerId}`, sendError)
      setPeerError(toErrorMessage(sendError, 'Could not send studies to the selected device'))
      throw sendError
    } finally {
      setIsPeerActionBusy(false)
    }
  }

  const acceptIncomingOffer = async (offerId: string) => {
    setPeerError(null)
    setIsPeerActionBusy(true)

    try {
      const acceptance = await window.appApi.acceptStudyOffer(offerId)
      applyTransferState(acceptance.state)

      const studyId = acceptance.studyId

      onReceiveStudyContextCreated({ workflowMode: 'p2p_receive', studyId })

      return studyId
    } catch (acceptError) {
      devLogger.warn(`[usePeerTransferController] Failed accepting offer ${offerId}`, acceptError)
      setPeerError(toErrorMessage(acceptError, 'Could not accept study offer'))
      throw acceptError
    } finally {
      setIsPeerActionBusy(false)
    }
  }

  const openReceivedStudies = async (): Promise<ScanResult | null> => {
    setPeerError(null)

    try {
      return await window.appApi.scanTransferInbox()
    } catch (scanError) {
      devLogger.warn('[usePeerTransferController] Failed scanning received studies', scanError)
      setPeerError(toErrorMessage(scanError, 'Could not scan the received transfer inbox'))
      return null
    }
  }

  return {
    peerState,
    transferState,
    isPeerActionBusy,
    peerError,
    setPeerError,
    refreshPeerState,
    stopSendDiscovery,
    startReceiveMode,
    stopReceiveMode,
    sendStudyToPeer,
    acceptIncomingOffer,
    openReceivedStudies
  }
}
