import { imageLoader, type Types } from '@cornerstonejs/core'
import { devLogger } from './logger'

const UNCOMPRESSED_TRANSFER_SYNTAXES = new Set([
  '1.2.840.10008.1.2',
  '1.2.840.10008.1.2.1',
  '1.2.840.10008.1.2.1.99',
  '1.2.840.10008.1.2.2'
])

export const toErrorMessage = (value: unknown, fallback: string): string => {
  if (value instanceof Error && value.message) {
    return value.message
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return value
  }

  return fallback
}

export const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error('Timed out while reading DICOM file'))
        }, timeoutMs)
      })
    ])
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
    }
  }
}

export const isCompressedTransferSyntax = (uid?: string) => {
  if (!uid) {
    return false
  }

  return !UNCOMPRESSED_TRANSFER_SYNTAXES.has(uid)
}

export const toNumeric = (value: number | number[] | undefined): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (Array.isArray(value)) {
    const first = value.find((item) => Number.isFinite(item))
    return typeof first === 'number' ? first : null
  }

  return null
}

export const applyBestEffortDisplaySettings = async (
  viewport: Types.IStackViewport,
  imageId: string,
  modality?: string
): Promise<{ lower: number; upper: number } | null> => {
  try {
    const image = await imageLoader.loadAndCacheImage(imageId)
    const windowCenter = toNumeric(image.windowCenter)
    const windowWidth = toNumeric(image.windowWidth)

    const hasReliableWindowLevel =
      windowCenter !== null &&
      windowWidth !== null &&
      Number.isFinite(windowCenter) &&
      Number.isFinite(windowWidth) &&
      windowWidth >= 20

    const imageMin = Math.min(image.minPixelValue, image.maxPixelValue)
    const imageMax = Math.max(image.minPixelValue, image.maxPixelValue)
    const imageRange = Math.max(1, imageMax - imageMin)

    let lower = imageMin
    let upper = imageMax

    if (hasReliableWindowLevel && windowCenter !== null && windowWidth !== null) {
      lower = windowCenter - windowWidth / 2
      upper = windowCenter + windowWidth / 2
    } else if (modality === 'CT') {
      const fallbackCenter = 300
      const fallbackWidth = 2000
      lower = fallbackCenter - fallbackWidth / 2
      upper = fallbackCenter + fallbackWidth / 2
    } else {
      const adaptiveWidth = Math.max(256, imageRange * 0.35)
      const adaptiveCenter = imageMin + imageRange * 0.45
      lower = adaptiveCenter - adaptiveWidth / 2
      upper = adaptiveCenter + adaptiveWidth / 2
    }

    const shouldInvert = image.photometricInterpretation === 'MONOCHROME1'

    if (upper > lower && !image.color) {
      const appliedRange = {
        lower,
        upper
      }
      viewport.setProperties({
        voiRange: appliedRange,
        invert: shouldInvert
      })
      return appliedRange
    }

    return null
  } catch (error) {
    devLogger.debug(`[viewerUtils] Failed applying display settings for ${imageId}`, error)
    return null
  }
}

export const getImageDisplayAspectRatio = async (imageId: string): Promise<number | null> => {
  try {
    const image = await imageLoader.loadAndCacheImage(imageId)
    const width = Number(image.width ?? image.columns ?? 0)
    const height = Number(image.height ?? image.rows ?? 0)

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null
    }

    const columnSpacing = Number.isFinite(image.columnPixelSpacing)
      ? Number(image.columnPixelSpacing)
      : 1
    const rowSpacing = Number.isFinite(image.rowPixelSpacing)
      ? Number(image.rowPixelSpacing)
      : 1

    const safeColumnSpacing = columnSpacing > 0 ? columnSpacing : 1
    const safeRowSpacing = rowSpacing > 0 ? rowSpacing : 1

    const ratio = (width * safeColumnSpacing) / (height * safeRowSpacing)
    return Number.isFinite(ratio) && ratio > 0 ? ratio : null
  } catch (error) {
    devLogger.debug(`[viewerUtils] Failed reading image aspect ratio for ${imageId}`, error)
    return null
  }
}

export const formatMs = (value: number) => `${Math.max(0, Math.round(value))} ms`

export const rangeToWindowLevel = (range: { lower: number; upper: number } | null) => {
  if (!range) {
    return null
  }

  const width = range.upper - range.lower
  const center = (range.upper + range.lower) / 2

  return {
    width,
    center
  }
}
