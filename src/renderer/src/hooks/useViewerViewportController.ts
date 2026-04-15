import { useRef, useState } from 'react'
import type React from 'react'
import type { RenderingEngine, Types } from '@cornerstonejs/core'
import { getImageDisplayAspectRatio } from '../utils/viewerUtils'

type UseViewerViewportControllerParams = {
  renderingEngineRef: React.MutableRefObject<RenderingEngine | null>
  viewportId: string
  isSeriesLoading: boolean
}

export function useViewerViewportController({
  renderingEngineRef,
  viewportId,
  isSeriesLoading
}: UseViewerViewportControllerParams) {
  const [currentImageIndex, setCurrentImageIndex] = useState(0)
  const [currentStackSize, setCurrentStackSize] = useState(0)
  const [currentVoiRange, setCurrentVoiRange] = useState<{ lower: number; upper: number } | null>(null)
  const [viewportAspectRatio, setViewportAspectRatio] = useState<number | null>(null)
  const [isWindowLevelDragging, setIsWindowLevelDragging] = useState(false)

  const loadedImageIdsRef = useRef<string[]>([])
  const wlDragRef = useRef<{
    startX: number
    startY: number
    startLower: number
    startUpper: number
    active: boolean
  }>({
    startX: 0,
    startY: 0,
    startLower: 0,
    startUpper: 1,
    active: false
  })

  const setViewportIndex = async (nextIndex: number) => {
    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    if (!viewport || currentStackSize <= 0) {
      return
    }

    const bounded = Math.max(0, Math.min(currentStackSize - 1, nextIndex))
    if (bounded === currentImageIndex) {
      return
    }

    await viewport.setImageIdIndex(bounded)
    const imageId = loadedImageIdsRef.current[bounded]
    if (imageId) {
      const aspectRatio = await getImageDisplayAspectRatio(imageId)
      setViewportAspectRatio(aspectRatio)
    }
    viewport.render()
    setCurrentImageIndex(bounded)
  }

  const navigateStack = async (direction: 'prev' | 'next') => {
    if (currentStackSize <= 0) {
      return
    }

    const nextIndex =
      direction === 'prev'
        ? Math.max(0, currentImageIndex - 1)
        : Math.min(currentStackSize - 1, currentImageIndex + 1)

    if (nextIndex === currentImageIndex) {
      return
    }

    await setViewportIndex(nextIndex)
  }

  const handleViewportPointerDown: React.PointerEventHandler<HTMLDivElement> = (event) => {
    if (event.button !== 0 || !currentVoiRange) {
      return
    }

    event.preventDefault()
    wlDragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startLower: currentVoiRange.lower,
      startUpper: currentVoiRange.upper,
      active: true
    }
    setIsWindowLevelDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handleViewportPointerMove: React.PointerEventHandler<HTMLDivElement> = (event) => {
    if (!wlDragRef.current.active) {
      return
    }

    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    if (!viewport) {
      return
    }

    const startWidth = Math.max(1, wlDragRef.current.startUpper - wlDragRef.current.startLower)
    const startCenter = (wlDragRef.current.startUpper + wlDragRef.current.startLower) / 2

    const deltaX = event.clientX - wlDragRef.current.startX
    const deltaY = event.clientY - wlDragRef.current.startY

    const widthSensitivity = Math.max(1, startWidth / 300)
    const centerSensitivity = Math.max(1, startWidth / 500)

    const nextWidth = Math.max(1, startWidth + deltaX * widthSensitivity)
    const nextCenter = startCenter + deltaY * centerSensitivity

    const nextRange = {
      lower: nextCenter - nextWidth / 2,
      upper: nextCenter + nextWidth / 2
    }

    viewport.setProperties({ voiRange: nextRange })
    viewport.render()
    setCurrentVoiRange(nextRange)
  }

  const handleViewportPointerUp: React.PointerEventHandler<HTMLDivElement> = (event) => {
    if (!wlDragRef.current.active) {
      return
    }

    wlDragRef.current.active = false
    setIsWindowLevelDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleViewportWheelDelta = (deltaY: number): boolean => {
    const step = Math.sign(deltaY)
    if (currentStackSize <= 0 || isSeriesLoading || step === 0) {
      return false
    }

    const isAtFirstSlice = currentImageIndex <= 0
    const isAtLastSlice = currentImageIndex >= currentStackSize - 1

    if ((step < 0 && isAtFirstSlice) || (step > 0 && isAtLastSlice)) {
      return false
    }

    void setViewportIndex(currentImageIndex + step)
    return true
  }

  return {
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
  }
}
