import { useEffect, useRef } from 'react'
import { type RenderingEngine, type Types } from '@cornerstonejs/core'
import type { EvaluationEventPayload, SeriesMetadata } from '../../../shared/types'
import type { AppScreen, StudyTelemetryContext, WorkflowPhase } from '../types/ui'
import {
  isOrderedStackExtension,
  tryExtendStackViewportInPlace
} from '../utils/cornerstoneStackViewportAdapter'
import { devLogger } from '../utils/logger'
import {
  applyBestEffortDisplaySettings,
  formatMs,
  getImageDisplayAspectRatio,
  isCompressedTransferSyntax,
  toErrorMessage,
  withTimeout
} from '../utils/viewerUtils'

type UseSeriesLoadControllerParams = {
  screen: AppScreen
  pendingSeriesToOpen: SeriesMetadata | null
  setPendingSeriesToOpen: (value: SeriesMetadata | null) => void
  setError: (value: string | null) => void
  setWorkflowPhase: (value: WorkflowPhase) => void
  activeSeriesUID: string | null
  setActiveSeriesUID: (value: string | null) => void
  setIsSeriesLoading: (value: boolean) => void
  setSeriesLoadProgress: (value: { loaded: number; total: number } | null) => void
  setViewerStatus: (value: string) => void
  setWorkflowMessage: (value: string) => void
  setLastLoadMetrics: (value: { firstImageMs: number; fullStackMs: number; instanceCount: number } | null) => void
  getImageIdForFilePath: (filePath: string) => Promise<string>
  ensureViewportReady: () => Promise<RenderingEngine>
  viewportId: string
  loadedImageIdsRef: React.MutableRefObject<string[]>
  currentImageIndex: number
  setCurrentImageIndex: (value: number) => void
  setCurrentStackSize: (value: number) => void
  setCurrentVoiRange: (value: { lower: number; upper: number } | null) => void
  setViewportAspectRatio: (value: number | null) => void
  seriesSelectedAt: number | null
  selectedStudyTelemetry: StudyTelemetryContext | null
  perFileTimeoutMs: number
  setStackTimeoutMs: number
  retrySetStackTimeoutMs: number
  fallbackSingleImageTimeoutMs: number
  concurrency: number
  logEvaluationEvent: (payload: EvaluationEventPayload) => void
}

export function useSeriesLoadController({
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
  viewportId,
  loadedImageIdsRef,
  currentImageIndex,
  setCurrentImageIndex,
  setCurrentStackSize,
  setCurrentVoiRange,
  setViewportAspectRatio,
  seriesSelectedAt,
  selectedStudyTelemetry,
  perFileTimeoutMs,
  setStackTimeoutMs,
  retrySetStackTimeoutMs,
  fallbackSingleImageTimeoutMs,
  concurrency,
  logEvaluationEvent
}: UseSeriesLoadControllerParams) {
  const loadSessionRef = useRef(0)

  const invalidateLoadSession = () => {
    loadSessionRef.current += 1
  }

  const loadSeries = async (series: SeriesMetadata) => {
    const loadSession = ++loadSessionRef.current
    const isStale = () => loadSession !== loadSessionRef.current
    const existingImageIds = [...loadedImageIdsRef.current]
    const currentVisibleImageId = existingImageIds[currentImageIndex] ?? existingImageIds[existingImageIds.length - 1] ?? null
    const sortedInstances = [...series.instances].sort((a, b) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0))
    const isProgressiveRefresh =
      screen === 'viewer' &&
      activeSeriesUID === series.seriesInstanceUID &&
      existingImageIds.length > 0 &&
      existingImageIds.length < sortedInstances.length

    setError(null)
    setActiveSeriesUID(series.seriesInstanceUID)
    setIsSeriesLoading(!isProgressiveRefresh)
    setSeriesLoadProgress(
      isProgressiveRefresh
        ? null
        : {
            loaded: 0,
            total: sortedInstances.length
          }
    )

    if (isProgressiveRefresh) {
      setWorkflowPhase('viewer-ready')
    } else {
      setWorkflowPhase('loading-series')
      setViewerStatus('Preparing series…')
      setWorkflowMessage('Preparing series for first image')
      setLastLoadMetrics(null)
    }

    try {
      const renderingEngine = await ensureViewportReady()
      if (isStale()) {
        return
      }
      const viewport = renderingEngine.getViewport(viewportId) as Types.IStackViewport | undefined
      if (!viewport) {
        throw new Error('Viewer is not ready')
      }

      const loadStartedAt = performance.now()

      const transferSyntaxes = new Set(series.instances.map((item) => item.transferSyntaxUID || 'unknown'))
      const hasCompressedSyntax = series.instances.some((instance) => isCompressedTransferSyntax(instance.transferSyntaxUID))
      const imageIds: string[] = []

      const firstInstance = sortedInstances[0]
      if (!firstInstance) {
        throw new Error('Series has no instances')
      }

      let firstImageMs: number | undefined

      if (!isProgressiveRefresh) {
        setViewerStatus('Loading first image preview…')
        const firstImageId = await withTimeout(getImageIdForFilePath(firstInstance.filePath), perFileTimeoutMs)
        imageIds[0] = firstImageId

        await withTimeout(viewport.setStack([firstImageId], 0), setStackTimeoutMs)
        if (isStale()) {
          return
        }
        const firstRange = await applyBestEffortDisplaySettings(viewport, firstImageId, series.modality)
        const firstAspectRatio = await getImageDisplayAspectRatio(firstImageId)
        viewport.render()
        setCurrentImageIndex(0)
        setCurrentStackSize(1)
        setCurrentVoiRange(firstRange)
        setViewportAspectRatio(firstAspectRatio)
        loadedImageIdsRef.current = [firstImageId]

        firstImageMs = performance.now() - loadStartedAt
        setViewerStatus(`First image shown in ${formatMs(firstImageMs)}. Loading remaining images…`)
        setWorkflowMessage(`First image shown in ${formatMs(firstImageMs)}. Loading remaining images…`)

        if (seriesSelectedAt && selectedStudyTelemetry) {
          const elapsedMs = Math.max(0, performance.now() - seriesSelectedAt)

          logEvaluationEvent({
            eventType: 'first_image_rendered',
            workflowMode: selectedStudyTelemetry.workflowMode,
            studyId: selectedStudyTelemetry.studyId,
            elapsedMs
          })
        }
      }

      let cursor = isProgressiveRefresh ? 0 : 1
      let loadedCount = isProgressiveRefresh ? 0 : 1
      if (!isProgressiveRefresh) {
        setSeriesLoadProgress({ loaded: loadedCount, total: sortedInstances.length })
      }

      const workers = Array.from({ length: Math.min(concurrency, sortedInstances.length) }, async () => {
        while (cursor < sortedInstances.length) {
          const index = cursor
          cursor += 1

          const instance = sortedInstances[index]
          if (!instance) {
            continue
          }

          try {
            const imageId = await withTimeout(getImageIdForFilePath(instance.filePath), perFileTimeoutMs)
            imageIds[index] = imageId
          } catch (error) {
            devLogger.debug(`[useSeriesLoadController] Failed loading image for ${instance.filePath}`, error)
            imageIds[index] = ''
          } finally {
            loadedCount += 1
            if (!isProgressiveRefresh) {
              setSeriesLoadProgress({ loaded: loadedCount, total: sortedInstances.length })
            }
          }
        }
      })

      await Promise.all(workers)
      if (isStale()) {
        return
      }

      const filteredImageIds = imageIds.filter((item) => item.length > 0)

      if (filteredImageIds.length === 0) {
        throw new Error('No loadable images found')
      }

      const canExtendStackInPlace =
        isProgressiveRefresh &&
        isOrderedStackExtension(existingImageIds, filteredImageIds)
      const nextProgressiveIndex = Math.min(currentImageIndex, Math.max(0, filteredImageIds.length - 1))

      if (canExtendStackInPlace && tryExtendStackViewportInPlace(viewport, filteredImageIds, nextProgressiveIndex)) {
        const nextIndex = nextProgressiveIndex
        loadedImageIdsRef.current = filteredImageIds
        setCurrentImageIndex(nextIndex)
        setCurrentStackSize(filteredImageIds.length)
        setViewerStatus(`Viewing ${filteredImageIds.length}/${sortedInstances.length} received images`)
        setWorkflowPhase('viewer-ready')
        setWorkflowMessage('Viewer remains available while transfer continues.')
        return
      }

      const targetImageIndex =
        isProgressiveRefresh && currentVisibleImageId
          ? Math.max(
              0,
              filteredImageIds.indexOf(currentVisibleImageId) >= 0
                ? filteredImageIds.indexOf(currentVisibleImageId)
                : Math.min(currentImageIndex, Math.max(0, filteredImageIds.length - 1))
            )
          : isProgressiveRefresh
            ? Math.min(currentImageIndex, Math.max(0, filteredImageIds.length - 1))
            : 0

      const renderFullStack = async (timeoutMs: number) => {
        await withTimeout(viewport.setStack(filteredImageIds, targetImageIndex), timeoutMs)
        if (isStale()) {
          return
        }
        viewport.render()
        setCurrentImageIndex(targetImageIndex)
        setCurrentStackSize(filteredImageIds.length)
        loadedImageIdsRef.current = filteredImageIds
      }

      try {
        if (!isProgressiveRefresh) {
          setViewerStatus('Decoding and rendering…')
        }
        await renderFullStack(setStackTimeoutMs)
        const fullStackMs = performance.now() - loadStartedAt
        if (typeof firstImageMs === 'number') {
          setLastLoadMetrics({
            firstImageMs,
            fullStackMs,
            instanceCount: filteredImageIds.length
          })
        }
        if (!isProgressiveRefresh) {
          setViewerStatus(`Loaded ${filteredImageIds.length} images (first: ${formatMs(firstImageMs ?? 0)}, full: ${formatMs(fullStackMs)})`)
          setWorkflowPhase('viewer-ready')
          setWorkflowMessage(`Viewer ready (${filteredImageIds.length} images loaded)`)
        }
      } catch (initialRenderError) {
        const initialMessage = toErrorMessage(initialRenderError, 'Unknown rendering error')
        devLogger.warn(`[Series Load] Initial render failed: ${initialMessage}`)

        try {
          if (!isProgressiveRefresh) {
            setViewerStatus('Decode slow, retrying with extended timeout…')
          }
          await renderFullStack(retrySetStackTimeoutMs)
          const fullStackMs = performance.now() - loadStartedAt
          if (typeof firstImageMs === 'number') {
            setLastLoadMetrics({
              firstImageMs,
              fullStackMs,
              instanceCount: filteredImageIds.length
            })
          }
          if (!isProgressiveRefresh) {
            setViewerStatus(`Loaded ${filteredImageIds.length} images after retry (first: ${formatMs(firstImageMs ?? 0)}, full: ${formatMs(fullStackMs)})`)
            setWorkflowPhase('viewer-ready')
            setWorkflowMessage(`Viewer ready after retry (${filteredImageIds.length} images loaded)`)
          }
        } catch (retryError) {
          const retryMessage = toErrorMessage(retryError, 'Unknown rendering error')
          devLogger.error(`[Series Load] Retry render failed: ${retryMessage}`)

          if (!isProgressiveRefresh && hasCompressedSyntax && filteredImageIds.length > 0) {
            try {
              setViewerStatus('Compressed syntax fallback: trying first frame preview…')
              await withTimeout(viewport.setStack([filteredImageIds[0]], 0), fallbackSingleImageTimeoutMs)
              if (isStale()) {
                return
              }
              const fallbackRange = await applyBestEffortDisplaySettings(viewport, filteredImageIds[0], series.modality)
              const fallbackAspectRatio = await getImageDisplayAspectRatio(filteredImageIds[0])
              viewport.render()
              setCurrentImageIndex(0)
              setCurrentStackSize(1)
              setCurrentVoiRange(fallbackRange)
              setViewportAspectRatio(fallbackAspectRatio)
              loadedImageIdsRef.current = [filteredImageIds[0]]
              setError(
                `Compressed transfer syntax fallback applied. Showing first frame only. Transfer Syntaxes: ${Array.from(transferSyntaxes).join(', ')}`
              )
              setViewerStatus('Fallback active: first frame preview only')
              setWorkflowPhase('viewer-ready')
              setWorkflowMessage('Viewer ready with first-frame fallback')
            } catch (fallbackError) {
              const fallbackMessage = toErrorMessage(fallbackError, 'Unknown rendering error')
              setViewerStatus('Decode failed after retries')
              throw new Error(
                `Decode failed after retry and fallback. Transfer Syntaxes: ${Array.from(transferSyntaxes).join(', ')}. Details: ${fallbackMessage}`
              )
            }
          } else {
            if (!isProgressiveRefresh) {
              setViewerStatus('Decode failed after retries')
            }
            throw new Error(
              `Series render failed after retry. Transfer Syntaxes: ${Array.from(transferSyntaxes).join(', ')}. Details: ${retryMessage}`
            )
          }
        }
      }

      if (filteredImageIds.length < sortedInstances.length) {
        setError(
          `Loaded ${filteredImageIds.length}/${sortedInstances.length} instances. Some files were skipped due to read/timeout issues.`
        )
      }
      } catch (scanError) {
      const fallbackMessage =
        'Failed to load selected series in Cornerstone viewer. If this persists, image decode may be failing for this transfer syntax.'
      if (isProgressiveRefresh) {
        devLogger.warn(`[Series Load] Progressive refresh skipped: ${toErrorMessage(scanError, fallbackMessage)}`)
        setError('Newly received images were not ready for refresh yet. Current images remain available.')
        setWorkflowPhase('viewer-ready')
        setWorkflowMessage('Viewer remains available while transfer continues.')
        return
      }

      setError(toErrorMessage(scanError, fallbackMessage))
      setViewerStatus('Load failed')
      setWorkflowPhase('error')
      setWorkflowMessage('Series load failed. Please choose another series or folder.')
      if (selectedStudyTelemetry) {
        logEvaluationEvent({
          eventType: 'decode_error',
          workflowMode: selectedStudyTelemetry.workflowMode,
          studyId: selectedStudyTelemetry.studyId,
          errorType: 'decode',
          details: { message: toErrorMessage(scanError, fallbackMessage) }
        })
      }
    } finally {
      setIsSeriesLoading(false)
      setSeriesLoadProgress(null)
    }
  }

  useEffect(() => {
    if (screen !== 'viewer' || !pendingSeriesToOpen) {
      return
    }

    let cancelled = false

    const run = async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve())
      })

      if (cancelled) {
        return
      }

      await loadSeries(pendingSeriesToOpen)

      if (!cancelled) {
        setPendingSeriesToOpen(null)
      }
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [screen, pendingSeriesToOpen])

  return {
    invalidateLoadSession
  }
}
