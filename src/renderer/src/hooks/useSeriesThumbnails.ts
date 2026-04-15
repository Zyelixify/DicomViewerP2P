import { useCallback, useEffect, useRef, useState } from 'react'
import { imageLoader } from '@cornerstonejs/core'
import type { SeriesMetadata } from '../../../shared/types'
import { initializeCornerstone } from '../utils/cornerstoneInit'
import { devLogger } from '../utils/logger'
import { withTimeout } from '../utils/viewerUtils'

const THUMBNAIL_SIZE = { width: 280, height: 190 }
const THUMBNAIL_CONCURRENCY = 4
const MAX_THUMBNAIL_CACHE_ENTRIES = 300

type SeriesEntry = {
  studyInstanceUID: string
  patientName: string
  series: SeriesMetadata
}

type UseSeriesThumbnailsParams = {
  enabled: boolean
  seriesEntries: SeriesEntry[]
  perFileTimeoutMs: number
  getImageIdForFilePath: (filePath: string) => Promise<string>
}

const createThumbnailDataUrl = (image: unknown): string | null => {
  const imageLike = image as {
    getCanvas?: () => HTMLCanvasElement
    color?: boolean
    getPixelData?: () => ArrayLike<number>
    width?: number
    height?: number
    minPixelValue?: number
    maxPixelValue?: number
    photometricInterpretation?: string
  }

  const canvas = document.createElement('canvas')
  canvas.width = THUMBNAIL_SIZE.width
  canvas.height = THUMBNAIL_SIZE.height
  const context = canvas.getContext('2d')
  if (!context) {
    return null
  }

  context.fillStyle = '#070b14'
  context.fillRect(0, 0, canvas.width, canvas.height)

  if (typeof imageLike.getCanvas === 'function') {
    const sourceCanvas = imageLike.getCanvas()
    const fitScale = Math.min(canvas.width / sourceCanvas.width, canvas.height / sourceCanvas.height)
    const targetWidth = sourceCanvas.width * fitScale
    const targetHeight = sourceCanvas.height * fitScale
    const targetX = (canvas.width - targetWidth) / 2
    const targetY = (canvas.height - targetHeight) / 2
    context.drawImage(sourceCanvas, targetX, targetY, targetWidth, targetHeight)
    return canvas.toDataURL('image/jpeg', 0.78)
  }

  const pixelData = imageLike.getPixelData?.()
  const width = imageLike.width ?? 0
  const height = imageLike.height ?? 0
  if (!pixelData || width <= 0 || height <= 0 || imageLike.color) {
    return null
  }

  const sourceCanvas = document.createElement('canvas')
  sourceCanvas.width = width
  sourceCanvas.height = height
  const sourceContext = sourceCanvas.getContext('2d')
  if (!sourceContext) {
    return null
  }

  const imageData = sourceContext.createImageData(width, height)
  const min = imageLike.minPixelValue ?? 0
  const max = imageLike.maxPixelValue ?? 1
  const range = Math.max(1, max - min)
  const invert = imageLike.photometricInterpretation === 'MONOCHROME1'

  for (let index = 0; index < pixelData.length; index += 1) {
    const raw = Number(pixelData[index] ?? 0)
    const normalized = Math.max(0, Math.min(255, Math.round(((raw - min) / range) * 255)))
    const value = invert ? 255 - normalized : normalized
    const offset = index * 4
    imageData.data[offset] = value
    imageData.data[offset + 1] = value
    imageData.data[offset + 2] = value
    imageData.data[offset + 3] = 255
  }

  sourceContext.putImageData(imageData, 0, 0)
  const fitScale = Math.min(canvas.width / sourceCanvas.width, canvas.height / sourceCanvas.height)
  const targetWidth = sourceCanvas.width * fitScale
  const targetHeight = sourceCanvas.height * fitScale
  const targetX = (canvas.width - targetWidth) / 2
  const targetY = (canvas.height - targetHeight) / 2
  context.drawImage(sourceCanvas, targetX, targetY, targetWidth, targetHeight)
  return canvas.toDataURL('image/jpeg', 0.78)
}

export function useSeriesThumbnails({
  enabled,
  seriesEntries,
  perFileTimeoutMs,
  getImageIdForFilePath
}: UseSeriesThumbnailsParams) {
  const [seriesThumbnails, setSeriesThumbnails] = useState<Record<string, string>>({})
  const [isPreparingThumbnails, setIsPreparingThumbnails] = useState(false)
  const [preparedThumbnailsCount, setPreparedThumbnailsCount] = useState(0)
  const seriesThumbnailsRef = useRef<Record<string, string>>({})
  const thumbnailSourceKeyRef = useRef<Map<string, string>>(new Map())

  const resetSeriesThumbnails = useCallback(() => {
    seriesThumbnailsRef.current = {}
    thumbnailSourceKeyRef.current.clear()
    setSeriesThumbnails({})
    setIsPreparingThumbnails(false)
    setPreparedThumbnailsCount(0)
  }, [])

  useEffect(() => {
    seriesThumbnailsRef.current = seriesThumbnails
  }, [seriesThumbnails])

  useEffect(() => {
    if (!enabled || seriesEntries.length === 0) {
      setIsPreparingThumbnails(false)
      setPreparedThumbnailsCount(0)
      return
    }

    let cancelled = false

    const run = async () => {
      const sourceKeyBySeriesId = new Map<string, string>()
      for (const entry of seriesEntries) {
        const firstInstance = entry.series.instances[0]

        if (firstInstance) {
          sourceKeyBySeriesId.set(entry.series.seriesInstanceUID, `${entry.series.seriesInstanceUID}:${firstInstance.filePath}`)
        }
      }

      const missingEntries = seriesEntries.filter((entry) => {
        const seriesId = entry.series.seriesInstanceUID
        const nextSourceKey = sourceKeyBySeriesId.get(seriesId)
        if (!nextSourceKey) {
          return false
        }

        return (
          !seriesThumbnailsRef.current[seriesId] ||
          thumbnailSourceKeyRef.current.get(seriesId) !== nextSourceKey
        )
      })

      setPreparedThumbnailsCount(seriesEntries.length - missingEntries.length)
      setIsPreparingThumbnails(missingEntries.length > 0)

      if (missingEntries.length === 0) {
        return
      }

      try {
        await initializeCornerstone()

        const workers = Array.from({ length: Math.min(THUMBNAIL_CONCURRENCY, missingEntries.length) }, (_, workerIndex) =>
          (async () => {
            for (let index = workerIndex; index < missingEntries.length; index += THUMBNAIL_CONCURRENCY) {
              if (cancelled) {
                return
              }

              const entry = missingEntries[index]
              const firstInstance = entry.series.instances[0]

              if (!firstInstance) {
                continue
              }

              try {
                const imageId = await withTimeout(getImageIdForFilePath(firstInstance.filePath), perFileTimeoutMs)
                const image = await withTimeout(imageLoader.loadAndCacheImage(imageId), perFileTimeoutMs)
                const thumb = createThumbnailDataUrl(image)
                if (thumb && !cancelled) {
                  const seriesId = entry.series.seriesInstanceUID
                  const sourceKey = sourceKeyBySeriesId.get(seriesId)
                  if (!sourceKey) {
                    continue
                  }

                  thumbnailSourceKeyRef.current.set(seriesId, sourceKey)
                  setSeriesThumbnails((previous) => {
                    const nextEntries = [...Object.entries(previous).filter(([key]) => key !== seriesId), [seriesId, thumb]]
                    if (nextEntries.length > MAX_THUMBNAIL_CACHE_ENTRIES) {
                      nextEntries.splice(0, nextEntries.length - MAX_THUMBNAIL_CACHE_ENTRIES)
                    }

                    return Object.fromEntries(nextEntries)
                  })
                  setPreparedThumbnailsCount((previous) => previous + 1)
                }
              } catch (error) {
                devLogger.debug(
                  `[useSeriesThumbnails] Failed preparing thumbnail for ${entry.series.seriesInstanceUID}`,
                  error
                )
              }
            }
          })()
        )

        await Promise.all(workers)
      } finally {
        if (!cancelled) {
          setIsPreparingThumbnails(false)
        }
      }
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [enabled, seriesEntries, perFileTimeoutMs, getImageIdForFilePath])

  return {
    seriesThumbnails,
    isPreparingThumbnails,
    preparedThumbnailsCount,
    totalSeriesCount: seriesEntries.length,
    resetSeriesThumbnails
  }
}
