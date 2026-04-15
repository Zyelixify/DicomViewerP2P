import { utilities, type Types } from '@cornerstonejs/core'

type MutableStackViewportShape = {
  imageIds?: string[]
  currentImageIdIndex?: number
  targetImageIdIndex?: number
  imageKeyToIndexMap?: Map<string, number>
}

export function isOrderedStackExtension(existingImageIds: string[], nextImageIds: string[]) {
  if (nextImageIds.length < existingImageIds.length) {
    return false
  }

  return existingImageIds.every((imageId, index) => nextImageIds[index] === imageId)
}

// Cornerstone does not expose a public "append images to existing stack" API.
// This adapter isolates the minimal private-field update we rely on for
// progressive receive, so the rest of the viewer code can stay conventional.
export function tryExtendStackViewportInPlace(
  viewport: Types.IStackViewport,
  nextImageIds: string[],
  currentIndex: number
) {
  const stackViewport = viewport as unknown as MutableStackViewportShape

  if (!Array.isArray(stackViewport.imageIds) || !(stackViewport.imageKeyToIndexMap instanceof Map)) {
    return false
  }

  stackViewport.imageIds = nextImageIds
  stackViewport.currentImageIdIndex = currentIndex
  stackViewport.targetImageIdIndex = currentIndex
  stackViewport.imageKeyToIndexMap.clear()

  nextImageIds.forEach((imageId, index) => {
    stackViewport.imageKeyToIndexMap?.set(imageId, index)
    stackViewport.imageKeyToIndexMap?.set(utilities.imageIdToURI(imageId), index)
  })

  return true
}
