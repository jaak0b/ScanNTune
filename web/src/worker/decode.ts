import type { Mat, OpenCv } from '../engine/opencv'
import { rgbaToBgrMat } from '../engine/imageData'

// Decode image bytes off the main thread using the browser's own codecs (createImageBitmap +
// OffscreenCanvas), then hand a BGR Mat to the engine. Replaces SkiaSharp; no image codec needed in
// OpenCV.js. The caller deletes the returned Mat.
export async function decodeToBgr(cv: OpenCv, bytes: ArrayBuffer): Promise<Mat> {
  const bitmap = await createImageBitmap(new Blob([bytes]))
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get a 2D context to decode the image.')
    // Paint an opaque white background first so any alpha in the source composites over white (a
    // sensible scan background) rather than the canvas's default transparent black, keeping the BGR
    // the engine reads close to what Cv2.ImRead(Color) would give. Opaque scans are unaffected.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, bitmap.width, bitmap.height)
    ctx.drawImage(bitmap, 0, 0)
    const imgData = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    return rgbaToBgrMat(cv, { data: imgData.data, width: imgData.width, height: imgData.height })
  } finally {
    bitmap.close()
  }
}

// Convert a BGR overlay Mat into a transferable ImageBitmap the UI can draw straight to a canvas.
export async function matToImageBitmap(cv: OpenCv, bgr: Mat): Promise<ImageBitmap> {
  const rgba = new cv.Mat()
  cv.cvtColor(bgr, rgba, cv.COLOR_BGR2RGBA)
  try {
    return await rgbaMatToBitmap(rgba)
  } finally {
    rgba.delete()
  }
}

// Convert a single-channel Mat (e.g. the binary threshold mask the detector searches) into a
// transferable ImageBitmap.
export async function grayMatToImageBitmap(cv: OpenCv, gray: Mat): Promise<ImageBitmap> {
  const rgba = new cv.Mat()
  cv.cvtColor(gray, rgba, cv.COLOR_GRAY2RGBA)
  try {
    return await rgbaMatToBitmap(rgba)
  } finally {
    rgba.delete()
  }
}

async function rgbaMatToBitmap(rgba: Mat): Promise<ImageBitmap> {
  const clamped = new Uint8ClampedArray(rgba.data.length)
  clamped.set(rgba.data)
  const imgData = new ImageData(clamped, rgba.cols, rgba.rows)
  return await createImageBitmap(imgData)
}
