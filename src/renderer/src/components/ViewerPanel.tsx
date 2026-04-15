import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { SeriesMetadata } from '../../../shared/types'

type ViewerPanelProps = {
  viewerStatus: string
  currentVoiRange: { lower: number; upper: number } | null
  currentImageIndex: number
  currentStackSize: number
  isSeriesLoading: boolean
  seriesLoadProgress: { loaded: number; total: number } | null
  isWindowLevelDragging: boolean
  viewportAspectRatio: number | null
  viewportElementRef: React.RefObject<HTMLDivElement>
  rangeToWindowLevel: (range: { lower: number; upper: number } | null) => { width: number; center: number } | null
  onPrevSlice: () => void
  onNextSlice: () => void
  onSliderChange: (index: number) => void
  onViewportPointerDown: React.PointerEventHandler<HTMLDivElement>
  onViewportPointerMove: React.PointerEventHandler<HTMLDivElement>
  onViewportPointerUp: React.PointerEventHandler<HTMLDivElement>
  onViewportPointerCancel: React.PointerEventHandler<HTMLDivElement>
  onViewportWheelDelta: (deltaY: number) => boolean
  onBackToSeries: () => void
  confidenceFeedback: 'adequate' | 'inadequate' | null
  isConfidencePromptVisible: boolean
  onConfidenceFeedback: (value: 'adequate' | 'inadequate') => void
  onDismissConfidencePrompt: () => void
  activeSeries: SeriesMetadata | null
  sourceLabel: string
}

export function ViewerPanel({
  viewerStatus,
  currentVoiRange,
  currentImageIndex,
  currentStackSize,
  isSeriesLoading,
  seriesLoadProgress,
  isWindowLevelDragging,
  viewportAspectRatio,
  viewportElementRef,
  rangeToWindowLevel,
  onPrevSlice,
  onNextSlice,
  onSliderChange,
  onViewportPointerDown,
  onViewportPointerMove,
  onViewportPointerUp,
  onViewportPointerCancel,
  onViewportWheelDelta,
  onBackToSeries,
  confidenceFeedback,
  isConfidencePromptVisible,
  onConfidenceFeedback,
  onDismissConfidencePrompt,
  activeSeries,
  sourceLabel
}: ViewerPanelProps) {
  const wl = rangeToWindowLevel(currentVoiRange)
  const [feedbackToast, setFeedbackToast] = useState<string | null>(null)
  const feedbackToastTimeoutRef = useRef<number | null>(null)
  const viewportFrameRef = useRef<HTMLDivElement>(null)
  const receiveProgressLabel =
    activeSeries?.receiveProgressStatus === 'complete'
      ? 'Complete'
      : activeSeries?.receiveProgressStatus === 'partial'
        ? 'Partial'
        : activeSeries?.receiveProgressStatus === 'failed'
          ? 'Failed'
          : activeSeries?.receiveProgressStatus === 'receiving'
            ? 'Receiving'
            : null
  const hasBlockingSeriesLoad = isSeriesLoading && (currentStackSize === 0 || seriesLoadProgress !== null)
  const shouldShowLoadingChip = hasBlockingSeriesLoad

  const showFeedbackToast = (value: 'adequate' | 'inadequate') => {
    if (feedbackToastTimeoutRef.current) {
      window.clearTimeout(feedbackToastTimeoutRef.current)
    }

    setFeedbackToast(`Adequacy saved: ${value === 'adequate' ? 'Adequate' : 'Inadequate'}`)
    feedbackToastTimeoutRef.current = window.setTimeout(() => {
      setFeedbackToast(null)
      feedbackToastTimeoutRef.current = null
    }, 2000)
  }

  useEffect(() => {
    return () => {
      if (feedbackToastTimeoutRef.current) {
        window.clearTimeout(feedbackToastTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const frame = viewportFrameRef.current
    if (!frame) {
      return
    }

    const onWheel = (event: WheelEvent) => {
      const consumed = onViewportWheelDelta(event.deltaY)
      if (consumed) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    frame.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      frame.removeEventListener('wheel', onWheel)
    }
  }, [onViewportWheelDelta])

  return (
    <section className="viewer-panel viewer-main">
      <div className="viewer-main-canvas">
        <div ref={viewportFrameRef} className="viewer-viewport-frame">
          <div className="viewer-overlay viewer-overlay-top" aria-live="polite">
            <button className="viewer-overlay-button secondary-button" onClick={onBackToSeries}>
              Back to Series
            </button>
            <div className="viewer-status-chips">
              <span>{sourceLabel}</span>
              <span>Status: {viewerStatus}</span>
              {receiveProgressLabel ? (
                <span className={`viewer-progress-chip is-${activeSeries?.receiveProgressStatus}`}>{receiveProgressLabel}</span>
              ) : null}
              {wl ? <span>W/L {Math.round(wl.width)}/{Math.round(wl.center)}</span> : null}
              {shouldShowLoadingChip ? (
                <span>Loading… {seriesLoadProgress ? `${seriesLoadProgress.loaded}/${seriesLoadProgress.total}` : ''}</span>
              ) : null}
            </div>
          </div>

          <div
            ref={viewportElementRef}
            className={`viewer-element ${isWindowLevelDragging ? 'viewer-element-dragging' : ''}`}
            style={viewportAspectRatio ? { aspectRatio: `${viewportAspectRatio}` } : undefined}
            onPointerDown={onViewportPointerDown}
            onPointerMove={onViewportPointerMove}
            onPointerUp={onViewportPointerUp}
            onPointerCancel={onViewportPointerCancel}
          />

          {isConfidencePromptVisible ? (
            <aside className="viewer-confidence-prompt" aria-live="polite">
              <button className="viewer-confidence-close" onClick={onDismissConfidencePrompt} aria-label="Close prompt">
                x
              </button>
              <p>Was the currently available image set adequate for the task?</p>
              <div className="viewer-confidence-actions">
                <button
                  disabled={hasBlockingSeriesLoad}
                  className={confidenceFeedback === 'adequate' ? 'secondary-button is-selected' : 'secondary-button'}
                  onClick={() => {
                    onConfidenceFeedback('adequate')
                    onDismissConfidencePrompt()
                    showFeedbackToast('adequate')
                  }}
                >
                  Adequate
                </button>
                <button
                  disabled={hasBlockingSeriesLoad}
                  className={confidenceFeedback === 'inadequate' ? 'secondary-button is-selected' : 'secondary-button'}
                  onClick={() => {
                    onConfidenceFeedback('inadequate')
                    onDismissConfidencePrompt()
                    showFeedbackToast('inadequate')
                  }}
                >
                  Inadequate
                </button>
              </div>
            </aside>
          ) : null}

          {feedbackToast ? (
            <div className="viewer-feedback-toast" role="status" aria-live="polite">
              {feedbackToast}
            </div>
          ) : null}
        </div>

        <div className="viewer-bottom-controls">
          <div className="viewer-controls">
            <button
              className="secondary-button"
              disabled={hasBlockingSeriesLoad || currentStackSize <= 0 || currentImageIndex <= 0}
              onClick={onPrevSlice}
            >
              Previous Slice
            </button>
            <span className="viewer-slice-label">
              Slice {currentStackSize > 0 ? currentImageIndex + 1 : 0} / {currentStackSize}
            </span>
            <button
              className="secondary-button"
              disabled={hasBlockingSeriesLoad || currentStackSize <= 0 || currentImageIndex >= currentStackSize - 1}
              onClick={onNextSlice}
            >
              Next Slice
            </button>
          </div>

          <input
            className="slice-slider"
            type="range"
            min={0}
            max={Math.max(0, currentStackSize - 1)}
            step={1}
            value={currentImageIndex}
            disabled={hasBlockingSeriesLoad || currentStackSize <= 0}
            onChange={(event) => {
              onSliderChange(Number(event.target.value))
            }}
          />

          <p className="muted viewer-controls-hint">Drag to adjust window/level. Use the mouse wheel or controls to change slices.</p>
        </div>
      </div>
    </section>
  )
}
