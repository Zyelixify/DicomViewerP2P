import { init as initializeCornerstoneCore } from '@cornerstonejs/core'
import { init as initializeDicomImageLoader } from '@cornerstonejs/dicom-image-loader'

let cornerstoneInitialized = false

export async function initializeCornerstone() {
  if (cornerstoneInitialized) {
    return
  }

  await initializeCornerstoneCore()
  await initializeDicomImageLoader({
    maxWebWorkers: Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2))
  })

  cornerstoneInitialized = true
}
