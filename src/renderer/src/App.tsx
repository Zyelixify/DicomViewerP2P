import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Enums, RenderingEngine, type Types } from '@cornerstonejs/core'
import dicomImageLoader from '@cornerstonejs/dicom-image-loader'
import type { DiscoveredPeer, EvaluationEventPayload, ScanResult, SeriesMetadata } from '../../shared/types'
import { SeriesBrowser } from './components/SeriesBrowser'
import { ViewerPanel } from './components/ViewerPanel'
import { WorkflowStatusRail } from './components/WorkflowStatusRail'
import { DiscoveryModal } from './components/DiscoveryModal'
import type { AppScreen, SeriesViewMode, StudyContextByWorkflow, StudyTelemetryContext, WorkflowPhase } from './types/ui'
import { initializeCornerstone } from './utils/cornerstoneInit'
import { useSeriesThumbnails } from './hooks/useSeriesThumbnails'
import { usePeerTransferController } from './hooks/usePeerTransferController'
import { useViewerViewportController } from './hooks/useViewerViewportController'
import { useLocalScanController } from './hooks/useLocalScanController'
import { useSeriesLoadController } from './hooks/useSeriesLoadController'
import {
  buildSelectedStudyOfferPayload,
  buildSendStudyOptions,
  buildSeriesEntries,
  buildStudyOfferPayload,
  getActiveReceivedSeriesEntry,
  type SeriesEntry
} from './utils/appSelectors'
import { devLogger } from './utils/logger'
import { buildProgressiveReceiveViewModel } from './utils/progressiveReceive'
import { rangeToWindowLevel } from './utils/viewerUtils'

const VIEWPORT_ID = 'primary-stack-viewport'
const RENDERING_ENGINE_ID = 'primary-rendering-engine'
const SERIES_LOAD_CONCURRENCY = 6
const PER_FILE_TIMEOUT_MS = 10000
const SET_STACK_TIMEOUT_MS = 15000
const RETRY_SET_STACK_TIMEOUT_MS = 45000
const FALLBACK_SINGLE_IMAGE_TIMEOUT_MS = 60000
const PROGRESSIVE_VIEWER_REFRESH_BATCH_SIZE = 2
const UI_DEBOUNCE_MS = 300
const SEND_COMPLETION_CLOSE_DELAY_MS = 1400

 type ReceiveOfferPrompt = {
   offerId: string
   senderDisplayName: string
   studyCount: number
   seriesCount: number
   instanceCount: number
 }

export function App() {
  const [screen, setScreen] = useState<AppScreen>('pick')
  const [seriesViewMode, setSeriesViewMode] = useState<SeriesViewMode>('local')
  const [workflowPhase, setWorkflowPhase] = useState<WorkflowPhase>('idle')
  const [workflowMessage, setWorkflowMessage] = useState('Ready to open a local folder')
  const [isLoading, setIsLoading] = useState(false)
  const [isSeriesLoading, setIsSeriesLoading] = useState(false)
  const [localScanResult, setLocalScanResult] = useState<ScanResult | null>(null)
  const [receivedScanResult, setReceivedScanResult] = useState<ScanResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeSeriesUID, setActiveSeriesUID] = useState<string | null>(null)
  const [pendingSeriesToOpen, setPendingSeriesToOpen] = useState<SeriesMetadata | null>(null)
  const [seriesLoadProgress, setSeriesLoadProgress] = useState<{ loaded: number; total: number } | null>(null)
  const [viewerStatus, setViewerStatus] = useState<string>('Idle')
  const [lastLoadMetrics, setLastLoadMetrics] = useState<{
    firstImageMs: number
    fullStackMs: number
    instanceCount: number
  } | null>(null)
  const [isDiscoveryModalOpen, setIsDiscoveryModalOpen] = useState(false)
  const [selectedStudyInstanceUIDs, setSelectedStudyInstanceUIDs] = useState<string[]>([])
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null)
  const [isReceiveModeActive, setIsReceiveModeActive] = useState(false)
  const [receiveStatusMessage, setReceiveStatusMessage] = useState('Receive mode is inactive')
  const [seriesSelectedAt, setSeriesSelectedAt] = useState<number | null>(null)
  const [confidenceFeedback, setConfidenceFeedback] = useState<'adequate' | 'inadequate' | null>(null)
  const [isConfidencePromptVisible, setIsConfidencePromptVisible] = useState(true)
  const [metricsWarning, setMetricsWarning] = useState<string | null>(null)
  const [currentScanWorkflowMode, setCurrentScanWorkflowMode] = useState<'local' | 'p2p_receive'>('local')
  const [studyContexts, setStudyContexts] = useState<StudyContextByWorkflow>({
    local: null,
    p2p_receive: null
  })
  const [selectedStudyTelemetry, setSelectedStudyTelemetry] = useState<StudyTelemetryContext | null>(null)
  const [activeReceiveOfferId, setActiveReceiveOfferId] = useState<string | null>(null)
  const [receiveOfferQueueVersion, setReceiveOfferQueueVersion] = useState(0)
  const [isFinishEvaluationModalOpen, setIsFinishEvaluationModalOpen] = useState(false)
  const [isEvaluationExporting, setIsEvaluationExporting] = useState(false)
  const [evaluationExportFeedback, setEvaluationExportFeedback] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)
  const [surveyLink, setSurveyLink] = useState<string | null>(null)
  const [hasEvaluationSessionBegun, setHasEvaluationSessionBegun] = useState(false)
  const [finalizedStudyCount, setFinalizedStudyCount] = useState(0)
  const [hasActiveP2PSendAccumulator, setHasActiveP2PSendAccumulator] = useState(false)
  const [sendCompletionMessage, setSendCompletionMessage] = useState<string | null>(null)

  const viewportElementRef = useRef<HTMLDivElement>(null)
  const renderingEngineRef = useRef<RenderingEngine | null>(null)
  const imageIdMapRef = useRef<Map<string, string>>(new Map())
  const acceptedOfferIdsRef = useRef<Set<string>>(new Set())
  const acceptingOfferIdsRef = useRef<Set<string>>(new Set())
  const dismissedOfferIdsRef = useRef<Set<string>>(new Set())
  const lastHandledTerminalOfferRef = useRef<string>('')
  const earlyReceiveAvailabilityOfferIdsRef = useRef<Set<string>>(new Set())
  const firstOpenableSeriesOfferIdsRef = useRef<Set<string>>(new Set())
  const droppedMetricEventsRef = useRef(0)
  const progressiveViewerRefreshTimerRef = useRef<number | null>(null)
  const evaluationReadinessRefreshTimerRef = useRef<number | null>(null)
  const sendCompletionCloseTimerRef = useRef<number | null>(null)

  const bumpReceiveOfferQueueVersion = useCallback(() => {
    setReceiveOfferQueueVersion((value) => value + 1)
  }, [])

  const refreshEvaluationExportReadiness = useCallback(() => {
    void window.appApi
      .getEvaluationExportReadiness()
      .then((readiness) => {
        setHasEvaluationSessionBegun(readiness.hasSessionBegun)
        setFinalizedStudyCount(readiness.finalizedStudyCount)
        setHasActiveP2PSendAccumulator(readiness.hasActiveP2PSendAccumulator)
      })
      .catch((error) => {
        devLogger.debug('[App] Failed to refresh evaluation readiness', error)
      })
  }, [])

  const queueEvaluationExportReadinessRefresh = useCallback(() => {
    if (evaluationReadinessRefreshTimerRef.current !== null) {
      window.clearTimeout(evaluationReadinessRefreshTimerRef.current)
    }

    evaluationReadinessRefreshTimerRef.current = window.setTimeout(() => {
      evaluationReadinessRefreshTimerRef.current = null
      refreshEvaluationExportReadiness()
    }, UI_DEBOUNCE_MS)
  }, [refreshEvaluationExportReadiness])

  const logEvaluationEvent = useCallback(
    (payload: EvaluationEventPayload) => {
      setHasEvaluationSessionBegun(true)
      void window.appApi.logEvaluationEvent(payload).catch((error) => {
        devLogger.debug('[App] Failed recording evaluation event', error)
        droppedMetricEventsRef.current += 1
        setMetricsWarning(`Metrics logging degraded: ${droppedMetricEventsRef.current} event(s) not recorded`)
      })

      queueEvaluationExportReadinessRefresh()
    },
    [queueEvaluationExportReadinessRefresh]
  )

  useEffect(() => {
    refreshEvaluationExportReadiness()
    void window.appApi
      .getSurveyLink()
      .then((value) => {
        setSurveyLink(value && value.trim().length > 0 ? value : null)
      })
      .catch((error) => {
        devLogger.debug('[App] Failed to load survey link', error)
        setSurveyLink(null)
      })
  }, [refreshEvaluationExportReadiness])
  const localSourceResult = localScanResult

  const localSeriesEntries = useMemo<SeriesEntry[]>(() => buildSeriesEntries(localSourceResult), [localSourceResult])

  const currentScanOfferPayload = useMemo(() => {
    if (!localSourceResult) {
      return null
    }

    return buildStudyOfferPayload(localSourceResult.rootFolder, localSourceResult.studies)
  }, [localSourceResult])

  const sendStudyOptions = useMemo(() => buildSendStudyOptions(localSourceResult), [localSourceResult])

  const {
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
  } = usePeerTransferController({
    currentScanOfferPayload,
    isDiscoveryModalOpen,
    isReceiveModeActive,
    onReceiveStudyContextCreated: (context) => {
      setCurrentScanWorkflowMode('p2p_receive')
      setSelectedStudyTelemetry(context)
      setStudyContexts({
        local: null,
        p2p_receive: context
      })
    },
    logEvaluationEvent
  })

  const receivedLibraryView = useMemo(
    () => buildProgressiveReceiveViewModel(receivedScanResult, transferState),
    [receivedScanResult, transferState]
  )
  const receivedSeriesEntries = receivedLibraryView.seriesEntries
  const displayedSeriesEntries = seriesViewMode === 'received' ? receivedSeriesEntries : localSeriesEntries
  const displayedRootFolder =
    seriesViewMode === 'received'
      ? receivedLibraryView.rootFolder
      : localSourceResult?.rootFolder ?? ''
  const displayedScannedFileCount =
    seriesViewMode === 'received' ? receivedLibraryView.scannedFileCount : localSourceResult?.scannedFileCount ?? 0
  const displayedDicomFileCount =
    seriesViewMode === 'received' ? receivedLibraryView.availableDicomFileCount : localSourceResult?.dicomFileCount ?? 0
  const displayedExpectedDicomFileCount = seriesViewMode === 'received' ? receivedLibraryView.expectedDicomFileCount : undefined
  const displayedElapsedMs = seriesViewMode === 'received' ? receivedLibraryView.elapsedMs : localSourceResult?.elapsedMs ?? 0
  const displayedStudyCount =
    seriesViewMode === 'received' ? receivedLibraryView.studyCount : localSourceResult?.studies.length ?? 0

  const {
    currentImageIndex,
    currentStackSize,
    currentVoiRange,
    viewportAspectRatio,
    isWindowLevelDragging,
    loadedImageIdsRef,
    setCurrentImageIndex,
    setCurrentStackSize,
    setCurrentVoiRange,
    setViewportAspectRatio,
    setViewportIndex,
    navigateStack,
    handleViewportPointerDown,
    handleViewportPointerMove,
    handleViewportPointerUp,
    handleViewportWheelDelta
  } = useViewerViewportController({
    renderingEngineRef,
    viewportId: VIEWPORT_ID,
    isSeriesLoading
  })

  const ensureViewportReady = async () => {
    await initializeCornerstone()

    const targetElement = viewportElementRef.current
    if (!targetElement) {
      throw new Error('Viewer is not ready')
    }

    let renderingEngine = renderingEngineRef.current

    if (!renderingEngine) {
      renderingEngine = new RenderingEngine(RENDERING_ENGINE_ID)
      renderingEngineRef.current = renderingEngine
    }

    const existingViewport = renderingEngine.getViewport(VIEWPORT_ID) as
      | (Types.IStackViewport & { element?: HTMLDivElement })
      | undefined

    if (existingViewport?.element !== targetElement) {
      if (existingViewport) {
        try {
          renderingEngine.disableElement(VIEWPORT_ID)
        } catch (error) {
          devLogger.debug('[App] Failed to disable existing viewport', error)
        }
      }

      renderingEngine.enableElement({
        viewportId: VIEWPORT_ID,
        type: Enums.ViewportType.STACK,
        element: targetElement
      })
    }

    return renderingEngine
  }

  useEffect(() => {
    return () => {
      renderingEngineRef.current?.destroy()
      renderingEngineRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      if (progressiveViewerRefreshTimerRef.current !== null) {
        window.clearTimeout(progressiveViewerRefreshTimerRef.current)
        progressiveViewerRefreshTimerRef.current = null
      }
      if (evaluationReadinessRefreshTimerRef.current !== null) {
        window.clearTimeout(evaluationReadinessRefreshTimerRef.current)
        evaluationReadinessRefreshTimerRef.current = null
      }
      if (sendCompletionCloseTimerRef.current !== null) {
        window.clearTimeout(sendCompletionCloseTimerRef.current)
        sendCompletionCloseTimerRef.current = null
      }
    }
  }, [])

  const getImageIdForFilePath = useCallback(async (filePath: string): Promise<string> => {
    const cached = imageIdMapRef.current.get(filePath)
    if (cached) {
      return cached
    }

    const buffer = await window.appApi.readDicomFile(filePath)
    const fileName = filePath.split(/[\\/]/).pop() || 'image.dcm'
    const file = new File([buffer], fileName, { type: 'application/dicom' })
    const imageId = dicomImageLoader.wadouri.fileManager.add(file)
    imageIdMapRef.current.set(filePath, imageId)
    return imageId
  }, [])

  const { seriesThumbnails, isPreparingThumbnails, preparedThumbnailsCount, totalSeriesCount, resetSeriesThumbnails } =
    useSeriesThumbnails({
    enabled: displayedSeriesEntries.length > 0 && screen === 'series',
    seriesEntries: displayedSeriesEntries,
    perFileTimeoutMs: PER_FILE_TIMEOUT_MS,
    getImageIdForFilePath
    })

  const {
    handlePickFolder,
    openSeriesInViewer,
    scanReceivedStudies,
    handleOpenReceivedStudies,
    goToSeriesScreen: baseGoToSeriesScreen
  } = useLocalScanController({
    setScreen,
    setError,
    setIsLoading,
    setWorkflowPhase,
    setWorkflowMessage,
    setViewerStatus,
    setLastLoadMetrics,
    setConfidenceFeedback,
    setLocalScanResult,
    setReceivedScanResult,
    setActiveSeriesUID,
    setPendingSeriesToOpen,
    setCurrentImageIndex,
    setCurrentStackSize,
    setCurrentVoiRange,
    setViewportAspectRatio,
    resetSeriesThumbnails,
    imageIdMapRef,
    loadedImageIdsRef,
    openReceivedStudies,
    logEvaluationEvent,
    currentScanWorkflowMode,
    studyContexts,
    setCurrentScanWorkflowMode,
    setStudyContexts,
    setSelectedStudyTelemetry,
    setSeriesSelectedAt
  })

  const { invalidateLoadSession } = useSeriesLoadController({
    screen,
    pendingSeriesToOpen,
    setPendingSeriesToOpen,
    setError,
    setWorkflowPhase,
    activeSeriesUID,
    setActiveSeriesUID,
    setIsSeriesLoading,
    setSeriesLoadProgress,
    setViewerStatus,
    setWorkflowMessage,
    setLastLoadMetrics,
    getImageIdForFilePath,
    ensureViewportReady,
    viewportId: VIEWPORT_ID,
    loadedImageIdsRef,
    currentImageIndex,
    setCurrentImageIndex,
    setCurrentStackSize,
    setCurrentVoiRange,
    setViewportAspectRatio,
    seriesSelectedAt,
    selectedStudyTelemetry,
    perFileTimeoutMs: PER_FILE_TIMEOUT_MS,
    setStackTimeoutMs: SET_STACK_TIMEOUT_MS,
    retrySetStackTimeoutMs: RETRY_SET_STACK_TIMEOUT_MS,
    fallbackSingleImageTimeoutMs: FALLBACK_SINGLE_IMAGE_TIMEOUT_MS,
    concurrency: SERIES_LOAD_CONCURRENCY,
    logEvaluationEvent
  })

  const goToSeriesScreen = () => {
    invalidateLoadSession()
    setSelectedStudyTelemetry(null)
    baseGoToSeriesScreen()
  }

  const availableReceivingPeers = (peerState?.peers || []).map((peer) => ({
    ...peer,
    displayName: peer.displayName?.trim() || `Device ${peer.peerId.slice(0, 8)}`
  }))

  const canSendCurrentStudy = Boolean(currentScanOfferPayload)

  const pendingReceiveOffer = useMemo<ReceiveOfferPrompt | null>(() => {
    if (!isReceiveModeActive || isPeerActionBusy) {
      return null
    }

    const nextOffer = transferState?.inboundStudyOffers.find(
      (offer) =>
        !acceptedOfferIdsRef.current.has(offer.offerId) &&
        !acceptingOfferIdsRef.current.has(offer.offerId) &&
        !dismissedOfferIdsRef.current.has(offer.offerId)
    )

    if (!nextOffer) {
      return null
    }

    return {
      offerId: nextOffer.offerId,
      senderDisplayName: nextOffer.senderDisplayName,
      studyCount: nextOffer.studyCount,
      seriesCount: nextOffer.seriesCount,
      instanceCount: nextOffer.instanceCount
    }
  }, [isPeerActionBusy, isReceiveModeActive, receiveOfferQueueVersion, transferState?.inboundStudyOffers])

  const outboundTransferProgress = useMemo(() => {
    if (!transferState || transferState.outboundFileTransfers.length === 0) {
      return null
    }

    const activeOfferId = transferState.activeOutboundOfferId ?? transferState.outboundFileTransfers[0]?.offerId
    if (!activeOfferId) {
      return null
    }

    const transfersForOffer = transferState.outboundFileTransfers.filter((item) => item.offerId === activeOfferId)
    if (transfersForOffer.length === 0) {
      return null
    }

    const totalBytes = transfersForOffer.reduce((total, item) => total + item.totalBytes, 0)
    const sentBytes = transfersForOffer.reduce(
      (total, item) => total + (item.status === 'complete' ? item.totalBytes : item.sentBytes),
      0
    )
    const totalFiles = transfersForOffer.length
    const sentFiles = transfersForOffer.filter((item) => item.status === 'complete').length
    const hasError = transfersForOffer.some((item) => item.status === 'error')
    const percent = totalBytes > 0 ? Math.min(100, Math.round((sentBytes / totalBytes) * 100)) : 0
    const isComplete = totalFiles > 0 && sentFiles >= totalFiles && !hasError

    return {
      sentBytes: Math.min(sentBytes, totalBytes),
      totalBytes,
      sentFiles,
      totalFiles,
      percent,
      hasError,
      isComplete
    }
  }, [transferState])

  const activeLocalSeriesEntry =
    localSeriesEntries.find((entry) => entry.series.seriesInstanceUID === activeSeriesUID) ?? null

  const activeReceivedSeriesEntry = getActiveReceivedSeriesEntry(
    receivedSeriesEntries,
    activeSeriesUID,
    activeReceiveOfferId
  )

  const activeViewerSeries = seriesViewMode === 'received' ? activeReceivedSeriesEntry?.series ?? null : activeLocalSeriesEntry?.series ?? null

  const handleBackToPick = () => {
    setError(null)
    setScreen('pick')
    setWorkflowPhase('idle')
    setWorkflowMessage('Ready to open a local folder')
  }

  const handleOpenLocalFolder = async () => {
    setSeriesViewMode('local')
    await handlePickFolder()
  }

  const handleOpenReceiveBrowser = async () => {
    setSeriesViewMode('received')
    const hasStableReceivedLibrary = Boolean(receivedScanResult)
    const hasLiveReceiveState = receivedLibraryView.offers.length > 0

    if (!hasStableReceivedLibrary && !hasLiveReceiveState) {
      await handleOpenReceivedStudies()
      return
    }

      setCurrentScanWorkflowMode('p2p_receive')
      setWorkflowPhase('series-ready')
      setWorkflowMessage(
        receivedLibraryView.offers.some((offer) => offer.hasOpenableSeries)
        ? 'Received studies are visible. Review can begin before transfer completes.'
        : receivedLibraryView.offers.length > 0
          ? 'Incoming studies are visible. Review unlocks as images arrive.'
          : 'Received studies are ready. Select a series to open.'
    )
    setScreen('series')
  }

  const handleEnableReceiveMode = async () => {
    logEvaluationEvent({
      eventType: 'receive_clicked',
      workflowMode: 'p2p_receive'
    })

    setPeerError(null)
    setStudyContexts((previous) => ({
      ...previous,
      p2p_receive: null
    }))
    earlyReceiveAvailabilityOfferIdsRef.current.clear()
    firstOpenableSeriesOfferIdsRef.current.clear()
    lastHandledTerminalOfferRef.current = ''
    acceptingOfferIdsRef.current.clear()
    dismissedOfferIdsRef.current.clear()
    bumpReceiveOfferQueueVersion()
    setActiveReceiveOfferId(null)
    setReceiveStatusMessage('Entering receive mode…')
    try {
      await startReceiveMode()
      setIsReceiveModeActive(true)
      setReceiveStatusMessage('Waiting for an incoming study…')
    } catch (error) {
      devLogger.debug('[App] Failed to enter receive mode', error)
      setIsReceiveModeActive(false)
      setReceiveStatusMessage('Could not enter receive mode')
    }
  }

  const handleDisableReceiveMode = async () => {
    setPeerError(null)
    setReceiveStatusMessage('Stopping receive mode…')
    try {
      await stopReceiveMode()
      setIsReceiveModeActive(false)
      acceptedOfferIdsRef.current.clear()
      acceptingOfferIdsRef.current.clear()
      dismissedOfferIdsRef.current.clear()
      earlyReceiveAvailabilityOfferIdsRef.current.clear()
      firstOpenableSeriesOfferIdsRef.current.clear()
      bumpReceiveOfferQueueVersion()
      setStudyContexts((previous) => ({
        ...previous,
        p2p_receive: null
      }))
      setActiveReceiveOfferId(null)
      setReceiveStatusMessage('Receive mode is inactive')
    } catch (error) {
      devLogger.debug('[App] Failed to exit receive mode', error)
      setReceiveStatusMessage('Could not stop receive mode')
    }
  }

  const handleClearReceivedCache = async () => {
    setPeerError(null)
    setReceiveStatusMessage('Clearing received cache…')

    try {
      await window.appApi.clearTransferInbox()
      setReceivedScanResult(null)
      acceptedOfferIdsRef.current.clear()
      acceptingOfferIdsRef.current.clear()
      earlyReceiveAvailabilityOfferIdsRef.current.clear()
      firstOpenableSeriesOfferIdsRef.current.clear()
      bumpReceiveOfferQueueVersion()
      setReceiveStatusMessage('Received cache cleared')
    } catch (error) {
      devLogger.debug('[App] Failed to clear received cache', error)
      setReceiveStatusMessage('Could not clear received cache')
    }
  }

  const handleOpenSendStudy = async () => {
    logEvaluationEvent({
      eventType: 'send_clicked',
      workflowMode: 'p2p_send'
    })

    setPeerError(null)
    setSendCompletionMessage(null)
    if (sendCompletionCloseTimerRef.current !== null) {
      window.clearTimeout(sendCompletionCloseTimerRef.current)
      sendCompletionCloseTimerRef.current = null
    }
    setIsDiscoveryModalOpen(true)
    setSelectedStudyInstanceUIDs([])
    setSelectedPeerId(null)
    await refreshPeerState()
  }

  const handleCloseSendStudy = async () => {
    if (sendCompletionCloseTimerRef.current !== null) {
      window.clearTimeout(sendCompletionCloseTimerRef.current)
      sendCompletionCloseTimerRef.current = null
    }

    setSendCompletionMessage(null)
    setIsDiscoveryModalOpen(false)
    setSelectedStudyInstanceUIDs([])
    setSelectedPeerId(null)

    if (!isReceiveModeActive) {
      await stopSendDiscovery()
    }
  }

  const handleSendStudyToPeer = async (peer: DiscoveredPeer) => {
    if (!canSendCurrentStudy) {
      return
    }

    setPeerError(null)

    const selectedOfferPayload = buildSelectedStudyOfferPayload(localSourceResult, selectedStudyInstanceUIDs)
    if (!selectedOfferPayload || selectedOfferPayload.instanceCount <= 0) {
      setPeerError('Select at least one study with transferable DICOM files before sending.')
      return
    }

    setSelectedPeerId(peer.peerId)
    setSendCompletionMessage(null)
    try {
      await sendStudyToPeer(peer, selectedOfferPayload)
    } catch (error) {
      devLogger.debug(`[App] Failed sending studies to ${peer.peerId}`, error)
      setSelectedPeerId(null)
    }
  }

  useEffect(() => {
    if (outboundTransferProgress?.isComplete || outboundTransferProgress?.hasError) {
      setSelectedPeerId(null)
    }
  }, [outboundTransferProgress?.hasError, outboundTransferProgress?.isComplete])

  const handleAcceptReceiveOffer = async () => {
    if (!pendingReceiveOffer) {
      return
    }

    const offerId = pendingReceiveOffer.offerId
    earlyReceiveAvailabilityOfferIdsRef.current.delete(offerId)
    acceptingOfferIdsRef.current.add(offerId)
    bumpReceiveOfferQueueVersion()
    setPeerError(null)

    try {
      await acceptIncomingOffer(offerId)
      acceptedOfferIdsRef.current.add(offerId)
      bumpReceiveOfferQueueVersion()
      setActiveReceiveOfferId(offerId)
      setReceiveStatusMessage('Receiving files…')
    } finally {
      acceptingOfferIdsRef.current.delete(offerId)
      bumpReceiveOfferQueueVersion()
    }
  }

  const activeReceiveOfferSummary =
    receivedLibraryView.offers.find((offer) => offer.offerId === activeReceiveOfferId) ?? null

  useEffect(() => {
    if (!isReceiveModeActive || !activeReceiveOfferId || !studyContexts.p2p_receive || !activeReceiveOfferSummary) {
      return
    }

    if (!earlyReceiveAvailabilityOfferIdsRef.current.has(activeReceiveOfferId)) {
      logEvaluationEvent({
        eventType: 'study_visible',
        workflowMode: 'p2p_receive',
        studyId: studyContexts.p2p_receive.studyId,
        details: {
          offerId: activeReceiveOfferId,
          availableInstanceCount: activeReceiveOfferSummary.availableInstanceCount,
          expectedInstanceCount: activeReceiveOfferSummary.expectedInstanceCount
        }
      })
      earlyReceiveAvailabilityOfferIdsRef.current.add(activeReceiveOfferId)
    }

    if (!activeReceiveOfferSummary.hasOpenableSeries) {
      return
    }

    const hasAlreadyAnnouncedOpenableSeries = firstOpenableSeriesOfferIdsRef.current.has(activeReceiveOfferId)

    if (!hasAlreadyAnnouncedOpenableSeries) {
      setReceiveStatusMessage('First files received. You can review while transfer continues.')

      if (screen !== 'viewer') {
        setWorkflowPhase('series-ready')
        setWorkflowMessage('Incoming study is ready for progressive review.')
      }

      if (screen === 'pick') {
        setSeriesViewMode('received')
        setCurrentScanWorkflowMode('p2p_receive')
        setScreen('series')
      }

      firstOpenableSeriesOfferIdsRef.current.add(activeReceiveOfferId)
      logEvaluationEvent({
        eventType: 'first_openable_series_available',
        workflowMode: 'p2p_receive',
        studyId: studyContexts.p2p_receive.studyId,
        details: {
          offerId: activeReceiveOfferId,
          availableInstanceCount: activeReceiveOfferSummary.availableInstanceCount,
          expectedInstanceCount: activeReceiveOfferSummary.expectedInstanceCount
        }
      })
    }
  }, [
    activeReceiveOfferId,
    activeReceiveOfferSummary,
    isReceiveModeActive,
    logEvaluationEvent,
    screen,
    studyContexts
  ])

  useEffect(() => {
    if (!transferState?.lastTerminalOffer) {
      return
    }

    const terminal = transferState.lastTerminalOffer
    const token = `${terminal.workflowMode}:${terminal.offerId}:${terminal.status}:${terminal.at}`
    if (token === lastHandledTerminalOfferRef.current) {
      return
    }
    lastHandledTerminalOfferRef.current = token

    if (terminal.workflowMode === 'p2p_send' && terminal.status === 'completed' && isDiscoveryModalOpen) {
      setSelectedPeerId(null)
      setSendCompletionMessage('Transfer complete. Closing…')

      if (sendCompletionCloseTimerRef.current !== null) {
        window.clearTimeout(sendCompletionCloseTimerRef.current)
      }

      sendCompletionCloseTimerRef.current = window.setTimeout(() => {
        sendCompletionCloseTimerRef.current = null
        void handleCloseSendStudy()
      }, SEND_COMPLETION_CLOSE_DELAY_MS)
    }

    if (terminal.workflowMode === 'p2p_receive' && terminal.status === 'completed') {
      void scanReceivedStudies()
    }

    if (terminal.workflowMode === 'p2p_receive' && terminal.offerId === activeReceiveOfferId) {
      if (terminal.status === 'completed') {
        setReceiveStatusMessage('Receive complete')

        if (screen !== 'viewer') {
          setSeriesViewMode('received')
          setCurrentScanWorkflowMode('p2p_receive')
          setWorkflowPhase('series-ready')
          setWorkflowMessage('Receive complete. Received studies are ready to review.')
          setScreen('series')
        }
        setActiveReceiveOfferId(null)
      } else {
        setActiveReceiveOfferId(null)
        setReceiveStatusMessage('Receive finished with errors')
      }
    }
  }, [
    activeReceiveOfferId,
    isDiscoveryModalOpen,
    handleCloseSendStudy,
    scanReceivedStudies,
    screen,
    transferState?.lastTerminalOffer
  ])

  useEffect(() => {
    if (transferState?.lastEvent !== 'transfer inbox cleared') {
      return
    }

    setReceivedScanResult(null)
  }, [transferState?.lastEvent])

  useEffect(() => {
    if (progressiveViewerRefreshTimerRef.current !== null) {
      window.clearTimeout(progressiveViewerRefreshTimerRef.current)
      progressiveViewerRefreshTimerRef.current = null
    }

    if (screen !== 'viewer' || seriesViewMode !== 'received' || !activeReceivedSeriesEntry?.series || isSeriesLoading) {
      return
    }

    const nextSeries = activeReceivedSeriesEntry.series

    if (pendingSeriesToOpen?.seriesInstanceUID === nextSeries.seriesInstanceUID) {
      return
    }

    const availableInstanceCount = nextSeries.instances.length
    const loadedInstanceCount = loadedImageIdsRef.current.length
    if (availableInstanceCount === 0 || availableInstanceCount <= loadedInstanceCount) {
      return
    }

    const expectedInstanceCount = nextSeries.expectedInstanceCount ?? availableInstanceCount
    const hasReachedRefreshBatch = availableInstanceCount - loadedInstanceCount >= PROGRESSIVE_VIEWER_REFRESH_BATCH_SIZE
    const isSeriesComplete = expectedInstanceCount > 0 && availableInstanceCount >= expectedInstanceCount
    const queueViewerRefresh = () => {
      const latestLoadedCount = loadedImageIdsRef.current.length
      if (latestLoadedCount >= nextSeries.instances.length || isSeriesLoading) {
        return
      }

      setPendingSeriesToOpen(nextSeries)
    }

    const scheduleViewerRefresh = (delayMs: number) => {
      progressiveViewerRefreshTimerRef.current = window.setTimeout(() => {
        progressiveViewerRefreshTimerRef.current = null
        queueViewerRefresh()
      }, delayMs)
    }

    if (hasReachedRefreshBatch || isSeriesComplete) {
      queueViewerRefresh()
      return
    }

    scheduleViewerRefresh(UI_DEBOUNCE_MS)

    return () => {
      if (progressiveViewerRefreshTimerRef.current !== null) {
        window.clearTimeout(progressiveViewerRefreshTimerRef.current)
        progressiveViewerRefreshTimerRef.current = null
      }
    }
  }, [activeReceivedSeriesEntry, isSeriesLoading, loadedImageIdsRef, pendingSeriesToOpen, screen, seriesViewMode])

  useEffect(() => {
    if (!lastLoadMetrics || !selectedStudyTelemetry) {
      return
    }

    logEvaluationEvent({
      eventType: 'viewer_series_loaded',
      workflowMode: selectedStudyTelemetry.workflowMode,
      studyId: selectedStudyTelemetry.studyId,
      elapsedMs: Math.round(lastLoadMetrics.fullStackMs),
      seriesCount: 1,
      instanceCount: lastLoadMetrics.instanceCount,
      details: {
        firstImageMs: lastLoadMetrics.firstImageMs,
        fullStackMs: lastLoadMetrics.fullStackMs,
        instanceCount: lastLoadMetrics.instanceCount
      }
    })
  }, [lastLoadMetrics, logEvaluationEvent, selectedStudyTelemetry])

  useEffect(() => {
    if (screen !== 'viewer') {
      setIsConfidencePromptVisible(true)
    }
  }, [screen])

  const submitConfidenceFeedback = (value: 'adequate' | 'inadequate') => {
    setConfidenceFeedback(value)
    if (!selectedStudyTelemetry) {
      return
    }

    logEvaluationEvent({
      eventType: 'viewer_confidence_feedback',
      workflowMode: selectedStudyTelemetry.workflowMode,
      studyId: selectedStudyTelemetry.studyId,
      confidenceScore: value === 'adequate' ? 1 : 0,
      details: { value }
    })
  }

  const handleOpenSeriesFolder = async (folderPath: string) => {
    try {
      await window.appApi.openFolderInSystem(folderPath)
    } catch (error) {
      devLogger.debug(`[App] Failed opening folder in system explorer: ${folderPath}`, error)
      setError('Could not open folder in the system file explorer.')
    }
  }

  const shouldHideWorkflowRail =
    (screen === 'viewer' && workflowPhase === 'viewer-ready') ||
    (screen === 'pick' && workflowPhase === 'idle') ||
    (screen === 'series' && workflowPhase === 'series-ready') ||
    workflowPhase === 'scanning'

  const canFinishEvaluation = finalizedStudyCount > 0 || hasEvaluationSessionBegun
  const isFinishEvaluationDisabled = hasActiveP2PSendAccumulator

  const handleDownloadEvaluationJson = async () => {
    setIsEvaluationExporting(true)
    setEvaluationExportFeedback(null)

    try {
      const result = await window.appApi.exportEvaluationSession()
      if (result.ok) {
        setEvaluationExportFeedback({
          type: 'success',
          message: `Evaluation data saved to ${result.filePath}`
        })
      } else if (!result.canceled) {
        setEvaluationExportFeedback({
          type: 'error',
          message: result.error
        })
      }
    } catch (error) {
      devLogger.debug('[App] Failed exporting evaluation session', error)
      setEvaluationExportFeedback({
        type: 'error',
        message: 'Could not export evaluation data'
      })
    } finally {
      setIsEvaluationExporting(false)
      refreshEvaluationExportReadiness()
    }
  }

  const handleOpenSurvey = async () => {
    try {
      await window.appApi.openSurveyLink()
    } catch (error) {
      devLogger.debug('[App] Failed opening survey link', error)
      setEvaluationExportFeedback({
        type: 'error',
        message: 'Could not open survey link'
      })
    }
  }

  const receivedBrowserStatusMessage =
    activeReceiveOfferSummary?.hasErrors
      ? activeReceiveOfferSummary.hasOpenableSeries
        ? 'Partial study available'
        : 'Transfer finished with errors'
      : activeReceiveOfferSummary && !activeReceiveOfferSummary.isComplete
        ? 'Transfer in progress'
        : receiveStatusMessage

  const seriesBrowserHeaderActions =
    seriesViewMode === 'received'
      ? [
          {
            id: 'receive-toggle',
            label: isReceiveModeActive ? 'Stop Receiving' : 'Start Receiving',
            disabled: isPeerActionBusy,
            onClick: () => {
              void (isReceiveModeActive ? handleDisableReceiveMode() : handleEnableReceiveMode())
            }
          },
          {
            id: 'refresh-received',
            label: 'Refresh Received Studies',
            variant: 'secondary' as const,
            disabled: isPeerActionBusy || isLoading,
            onClick: () => {
              void handleOpenReceivedStudies()
            }
          },
          {
            id: 'clear-cache',
            label: 'Clear Received Cache',
            variant: 'secondary' as const,
            disabled: isPeerActionBusy,
            onClick: () => {
              void handleClearReceivedCache()
            }
          }
        ]
      : [
          {
            id: 'send-study',
            label: 'Send Study',
            disabled: !canSendCurrentStudy || isPeerActionBusy,
            onClick: () => {
              void handleOpenSendStudy()
            }
          }
        ]

  return (
    <main className="page">
      <header className="app-header">
        <div>
          <h1>Peer-to-Peer DICOM Viewer</h1>
          <p className="screen-subtitle">Peer-to-peer DICOM viewing and sharing</p>
        </div>
        <div className="app-header-actions">
          {canFinishEvaluation ? (
            <button
              className="primary-button"
              disabled={isFinishEvaluationDisabled}
              onClick={() => {
                if (isFinishEvaluationDisabled) {
                  return
                }
                setEvaluationExportFeedback(null)
                setIsFinishEvaluationModalOpen(true)
              }}
            >
              Finish Evaluation
            </button>
          ) : null}
        </div>
      </header>

      {!shouldHideWorkflowRail ? (
        <WorkflowStatusRail
          phase={workflowPhase}
          message={workflowMessage}
          elapsedMs={screen === 'series' ? displayedElapsedMs || undefined : undefined}
          progress={isSeriesLoading ? seriesLoadProgress : null}
        />
      ) : null}

      {error ? <p className="error">{error}</p> : null}
      {peerError && !isDiscoveryModalOpen ? <p className="error">{peerError}</p> : null}
      {metricsWarning ? <p className="error">{metricsWarning}</p> : null}

      {isFinishEvaluationModalOpen ? (
        <div className="discovery-modal-overlay" role="dialog" aria-modal="true" aria-label="Finish evaluation">
          <section className="discovery-modal finish-evaluation-modal">
            <header>
              <h3>Finish Evaluation</h3>
            </header>

            <section className="transfer-progress-panel finish-evaluation-section">
              <h4>Export Evaluation Data</h4>
              <p className="muted">Download your evaluation data as a JSON file.</p>
              <p className="muted">You will upload this file in the survey form.</p>
              <button
                className="primary-button"
                disabled={isEvaluationExporting}
                onClick={() => {
                  void handleDownloadEvaluationJson()
                }}
              >
                {isEvaluationExporting ? 'Saving…' : 'Download JSON'}
              </button>
            </section>

            {surveyLink ? (
              <section className="transfer-progress-panel finish-evaluation-section">
                <h4>Complete Online Survey</h4>
                <p className="muted">After saving your evaluation file, please complete the survey.</p>
                <button
                  className="secondary-button"
                  onClick={() => {
                    void handleOpenSurvey()
                  }}
                >
                  Open Survey
                </button>
              </section>
            ) : null}

            {evaluationExportFeedback ? (
              <p className={evaluationExportFeedback.type === 'error' ? 'error' : 'status-banner'}>
                {evaluationExportFeedback.message}
              </p>
            ) : null}

            <div className="discovery-modal-actions">
              <button
                className="secondary-button"
                onClick={() => {
                  setIsFinishEvaluationModalOpen(false)
                }}
              >
                Close
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingReceiveOffer ? (
        <div className="discovery-modal-overlay" role="dialog" aria-modal="true" aria-label="Incoming study transfer request">
          <section className="discovery-modal">
            <header>
              <h3>Incoming Study Transfer</h3>
              <p className="muted">{pendingReceiveOffer.senderDisplayName || 'Unknown sender'} wants to send studies to this device.</p>
            </header>
            <section className="transfer-progress-panel" aria-live="polite">
              <p className="muted">
                {pendingReceiveOffer.studyCount} studies · {pendingReceiveOffer.seriesCount} series · {pendingReceiveOffer.instanceCount} instances
              </p>
            </section>
            <div className="discovery-modal-actions">
              <button
                className="secondary-button"
                disabled={isPeerActionBusy}
                onClick={() => {
                  dismissedOfferIdsRef.current.add(pendingReceiveOffer.offerId)
                  bumpReceiveOfferQueueVersion()
                  setReceiveStatusMessage('Transfer request declined')
                }}
              >
                Decline
              </button>
              <button className="primary-button" disabled={isPeerActionBusy} onClick={() => { void handleAcceptReceiveOffer() }}>
                Accept
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {screen === 'pick' ? (
        <section className="pick-screen">
          <h2>Open a DICOM study folder</h2>
          <p className="screen-subtitle">Open a local folder or browse previously received studies.</p>
          <div className="pick-actions">
            <button
              disabled={isLoading}
              className="primary-button"
              onClick={() => {
                void handleOpenLocalFolder()
              }}
            >
              {isLoading ? 'Scanning folder…' : 'Open Local Folder'}
            </button>
            <button
              disabled={isLoading}
              className="secondary-button"
              onClick={() => {
                void handleOpenReceiveBrowser()
              }}
            >
              Open Received Studies
            </button>
          </div>
        </section>
      ) : null}

      {screen === 'series' ? (
        <SeriesBrowser
          title={seriesViewMode === 'received' ? 'Received Studies' : 'Series Browser'}
          rootFolder={displayedRootFolder}
          scannedFileCount={displayedScannedFileCount}
          dicomFileCount={displayedDicomFileCount}
          expectedDicomFileCount={displayedExpectedDicomFileCount}
          elapsedMs={displayedElapsedMs}
          studyCount={displayedStudyCount}
          seriesEntries={displayedSeriesEntries}
          thumbnails={seriesThumbnails}
          isPreparingThumbnails={isPreparingThumbnails}
          preparedThumbnailsCount={preparedThumbnailsCount}
          totalSeriesCount={totalSeriesCount}
          activeSeriesUID={activeSeriesUID}
          isSeriesLoading={isSeriesLoading}
          statusMessage={seriesViewMode === 'received' ? receivedBrowserStatusMessage : undefined}
          headerActions={seriesBrowserHeaderActions}
          onLoadSeries={openSeriesInViewer}
          onOpenFolder={handleOpenSeriesFolder}
          onBack={handleBackToPick}
        />
      ) : null}

      {screen === 'viewer' ? (
        <section className="viewer-screen">
          <ViewerPanel
            viewerStatus={viewerStatus}
            currentVoiRange={currentVoiRange}
            currentImageIndex={currentImageIndex}
            currentStackSize={currentStackSize}
            isSeriesLoading={isSeriesLoading}
            seriesLoadProgress={seriesLoadProgress}
            isWindowLevelDragging={isWindowLevelDragging}
            viewportAspectRatio={viewportAspectRatio}
            viewportElementRef={viewportElementRef}
            rangeToWindowLevel={rangeToWindowLevel}
            onPrevSlice={() => {
              void navigateStack('prev')
            }}
            onNextSlice={() => {
              void navigateStack('next')
            }}
            onSliderChange={(index) => {
              void setViewportIndex(index)
            }}
            onViewportPointerDown={handleViewportPointerDown}
            onViewportPointerMove={handleViewportPointerMove}
            onViewportPointerUp={handleViewportPointerUp}
            onViewportPointerCancel={handleViewportPointerUp}
            onViewportWheelDelta={handleViewportWheelDelta}
            onBackToSeries={goToSeriesScreen}
            confidenceFeedback={confidenceFeedback}
            isConfidencePromptVisible={isConfidencePromptVisible}
            onConfidenceFeedback={submitConfidenceFeedback}
            onDismissConfidencePrompt={() => {
              setIsConfidencePromptVisible(false)
            }}
            activeSeries={activeViewerSeries}
            sourceLabel={seriesViewMode === 'received' ? 'Received series' : 'Local series'}
          />
        </section>
      ) : null}

      <DiscoveryModal
        isOpen={isDiscoveryModalOpen}
        devices={availableReceivingPeers}
        studies={sendStudyOptions.map((study) => ({
          ...study,
          selected: selectedStudyInstanceUIDs.includes(study.studyInstanceUID)
        }))}
        selectedPeerId={selectedPeerId}
        transferProgress={outboundTransferProgress}
        completionMessage={sendCompletionMessage}
        isBusy={isPeerActionBusy}
        errorMessage={peerError}
        onToggleStudy={(studyInstanceUID) => {
          setSelectedStudyInstanceUIDs((previous) =>
            previous.includes(studyInstanceUID)
              ? previous.filter((item) => item !== studyInstanceUID)
              : [...previous, studyInstanceUID]
          )
        }}
        onClose={() => {
          void handleCloseSendStudy()
        }}
        onRefresh={() => {
          void refreshPeerState()
        }}
        onSelectDevice={(peer) => {
          void handleSendStudyToPeer(peer)
        }}
      />
    </main>
  )
}
