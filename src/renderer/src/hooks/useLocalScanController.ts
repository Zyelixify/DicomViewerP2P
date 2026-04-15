import type { EvaluationEventPayload, SeriesMetadata } from '../../../shared/types'
import type { AppScreen, StudyContextByWorkflow, StudyTelemetryContext, WorkflowPhase } from '../types/ui'
import { devLogger } from '../utils/logger'
import { toErrorMessage } from '../utils/viewerUtils'

type UseLocalScanControllerParams = {
  setScreen: (screen: AppScreen) => void
  setError: (value: string | null) => void
  setIsLoading: (value: boolean) => void
  setWorkflowPhase: (phase: WorkflowPhase) => void
  setWorkflowMessage: (message: string) => void
  setViewerStatus: (message: string) => void
  setLastLoadMetrics: (value: { firstImageMs: number; fullStackMs: number; instanceCount: number } | null) => void
  setConfidenceFeedback: (value: 'adequate' | 'inadequate' | null) => void
  setLocalScanResult: (value: Awaited<ReturnType<typeof window.appApi.pickAndScanFolder>>) => void
  setReceivedScanResult: (value: Awaited<ReturnType<typeof window.appApi.scanTransferInbox>>) => void
  setActiveSeriesUID: (value: string | null) => void
  setPendingSeriesToOpen: (value: SeriesMetadata | null) => void
  setCurrentImageIndex: (value: number) => void
  setCurrentStackSize: (value: number) => void
  setCurrentVoiRange: (value: { lower: number; upper: number } | null) => void
  setViewportAspectRatio: (value: number | null) => void
  resetSeriesThumbnails: () => void
  imageIdMapRef: React.MutableRefObject<Map<string, string>>
  loadedImageIdsRef: React.MutableRefObject<string[]>
  openReceivedStudies: () => Promise<Awaited<ReturnType<typeof window.appApi.scanTransferInbox>> | null>
  logEvaluationEvent: (payload: EvaluationEventPayload) => void
  currentScanWorkflowMode: 'local' | 'p2p_receive'
  studyContexts: StudyContextByWorkflow
  setCurrentScanWorkflowMode: (workflowMode: 'local' | 'p2p_receive') => void
  setStudyContexts: (value: StudyContextByWorkflow | ((previous: StudyContextByWorkflow) => StudyContextByWorkflow)) => void
  setSelectedStudyTelemetry: (value: StudyTelemetryContext | null) => void
  setSeriesSelectedAt: (value: number | null) => void
}

export function useLocalScanController({
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
}: UseLocalScanControllerParams) {
  const resetViewerTransientState = () => {
    setActiveSeriesUID(null)
    setPendingSeriesToOpen(null)
    imageIdMapRef.current.clear()
    loadedImageIdsRef.current = []
    setCurrentImageIndex(0)
    setCurrentStackSize(0)
    setCurrentVoiRange(null)
    setViewportAspectRatio(null)
  }

  const handlePickFolder = async () => {
    setError(null)
    setIsLoading(true)
    setWorkflowPhase('scanning')
    setWorkflowMessage('Scanning folder and indexing studies…')
    setViewerStatus('Scanning folder…')
    setLastLoadMetrics(null)
    setConfidenceFeedback(null)
    resetSeriesThumbnails()

    try {
      const result = await window.appApi.pickAndScanFolder()
      setLocalScanResult(result)
      resetViewerTransientState()
      setSelectedStudyTelemetry(null)
      setStudyContexts({
        local: null,
        p2p_receive: null
      })
      setCurrentScanWorkflowMode('local')
      setViewerStatus(result ? 'Scan complete' : 'Scan canceled')
      setWorkflowPhase(result ? 'series-ready' : 'idle')
      setWorkflowMessage(result ? 'Studies are ready. Select a series to open.' : 'Scan canceled')
      setScreen(result ? 'series' : 'pick')

      if (result) {
        const localStudyId = result.studyId
        if (!localStudyId) {
          throw new Error('Main process did not provide local studyId')
        }
        setStudyContexts({
          local: { workflowMode: 'local', studyId: localStudyId },
          p2p_receive: null
        })

        logEvaluationEvent({
          eventType: 'scan_completed',
          workflowMode: 'local',
          studyId: localStudyId,
          elapsedMs: result.elapsedMs,
          studyCount: result.studies.length,
          seriesCount: result.studies.reduce((total, study) => total + study.series.length, 0),
          instanceCount: result.dicomFileCount
        })
      }
    } catch (scanError) {
      devLogger.warn('[useLocalScanController] Folder scan failed', scanError)
      setError(toErrorMessage(scanError, 'Could not scan the folder. Please try again.'))
      setViewerStatus('Scan failed')
      setWorkflowPhase('error')
      setWorkflowMessage('Scan failed. Verify folder access, then try again.')
      logEvaluationEvent({
        eventType: 'scan_error',
        workflowMode: 'local',
        errorType: 'scan',
        details: { message: toErrorMessage(scanError, 'Scan failed') }
      })
    } finally {
      setIsLoading(false)
    }
  }

  const openSeriesInViewer = (series: SeriesMetadata) => {
    const studyTelemetry =
      currentScanWorkflowMode === 'p2p_receive' && studyContexts.p2p_receive
        ? studyContexts.p2p_receive
        : currentScanWorkflowMode === 'local' && studyContexts.local
          ? studyContexts.local
          : null

    setError(null)
    setSeriesSelectedAt(performance.now())
    setSelectedStudyTelemetry(studyTelemetry)
    setConfidenceFeedback(null)
    setWorkflowPhase('loading-series')
    setWorkflowMessage('Opening selected series…')
    setPendingSeriesToOpen(series)
    setScreen('viewer')

    if (studyTelemetry?.studyId) {
      logEvaluationEvent({
        eventType: 'study_selected',
        workflowMode: studyTelemetry.workflowMode,
        studyId: studyTelemetry.studyId,
        seriesCount: 1,
        instanceCount: series.instances.length,
        details: {
          seriesInstanceUID: series.seriesInstanceUID,
          modality: series.modality,
          instanceCount: series.instances.length,
          availableInstanceCount: series.availableInstanceCount ?? series.instances.length,
          expectedInstanceCount: series.expectedInstanceCount ?? series.instances.length
        }
      })
    }
  }

  const scanReceivedStudies = async () => {
    const result = await openReceivedStudies()
    if (!result) {
      return null
    }

    setReceivedScanResult(result)
    return result
  }

  const handleOpenReceivedStudies = async () => {
    setError(null)
    setIsLoading(true)

    try {
      const result = await scanReceivedStudies()
      if (!result) {
        return null
      }

      resetViewerTransientState()
      setSelectedStudyTelemetry(null)
      setCurrentScanWorkflowMode('p2p_receive')
      setStudyContexts((previous) => ({
        ...previous,
        local: null
      }))
      setWorkflowPhase('series-ready')
      setWorkflowMessage('Received studies are ready. Select a series to open.')
      setScreen('series')
      return result
    } finally {
      setIsLoading(false)
    }
  }

  const goToSeriesScreen = () => {
    setError(null)
    setWorkflowPhase('series-ready')
    setWorkflowMessage('Studies are ready. Select a series to open.')
    setScreen('series')
    setPendingSeriesToOpen(null)
  }

  return {
    handlePickFolder,
    openSeriesInViewer,
    scanReceivedStudies,
    handleOpenReceivedStudies,
    goToSeriesScreen
  }
}
