import type { Mat, OpenCv } from './opencv'
import type { AlignedResult, DetectedRing, Orientation } from './types'
import { median } from './math'

const radiusMedian = (rings: DetectedRing[]): number => median(rings.map((r) => r.radiusPx))

// Draws each detected ring (green outline plus a yellow centre dot), and for a full result the
// resolved origin (red) and +X axis arrow (cyan), over a copy of the scan cropped to the detected
// coupon. Uses only OpenCV drawing (no image codec). Colours are BGR. The caller deletes the result.

const RING_COLOR = [0, 255, 0, 255] // green
const CENTER_COLOR = [0, 255, 255, 255] // yellow
const ORIGIN_COLOR = [0, 0, 255, 255] // red
const AXIS_COLOR = [255, 255, 0, 255] // cyan

const SHIFT = 3
const SCALE = 1 << SHIFT

export function renderOverlayMat(cv: OpenCv, image: Mat, result: AlignedResult): Mat {
  const canvas = toBgr(cv, image)
  const thickness = strokeThickness(image)
  drawRings(cv, canvas, result.rings, thickness)

  const orientation = result.orientation
  const medR = radiusMedian(result.rings)
  let axisLength = medR * 6.0
  if (axisLength <= 0) axisLength = Math.max(image.cols, image.rows) * 0.15

  const origin = fixedPoint(cv, orientation.originX, orientation.originY)
  const axisEnd = fixedPoint(
    cv,
    orientation.originX + orientation.xAxisX * axisLength,
    orientation.originY + orientation.xAxisY * axisLength,
  )
  const originColor = new cv.Scalar(...ORIGIN_COLOR)
  const axisColor = new cv.Scalar(...AXIS_COLOR)
  cv.circle(canvas, origin, thickness * 3 * SCALE, originColor, thickness, cv.LINE_AA, SHIFT)
  cv.arrowedLine(canvas, origin, axisEnd, axisColor, thickness + 1, cv.LINE_AA, SHIFT, 0.2)

  return crop(cv, canvas, result.rings, orientation)
}

export function renderDetectionOverlayMat(cv: OpenCv, image: Mat, rings: DetectedRing[]): Mat {
  const canvas = toBgr(cv, image)
  drawRings(cv, canvas, rings, strokeThickness(image))
  return crop(cv, canvas, rings, null)
}

function toBgr(cv: OpenCv, image: Mat): Mat {
  const canvas = new cv.Mat()
  if (image.channels() === 1) cv.cvtColor(image, canvas, cv.COLOR_GRAY2BGR)
  else image.copyTo(canvas)
  return canvas
}

function strokeThickness(image: Mat): number {
  return Math.max(1, Math.round(Math.max(image.cols, image.rows) / 500.0))
}

function drawRings(cv: OpenCv, canvas: Mat, rings: DetectedRing[], thickness: number): void {
  const ringColor = new cv.Scalar(...RING_COLOR)
  const centerColor = new cv.Scalar(...CENTER_COLOR)
  for (const ring of rings) {
    const center = fixedPoint(cv, ring.centerX, ring.centerY)
    cv.circle(canvas, center, Math.round(ring.radiusPx * SCALE), ringColor, thickness, cv.LINE_AA, SHIFT)
    cv.circle(canvas, center, (thickness + 1) * SCALE, centerColor, -1, cv.LINE_AA, SHIFT)
  }
}

function fixedPoint(cv: OpenCv, x: number, y: number) {
  return new cv.Point(Math.round(x * SCALE), Math.round(y * SCALE))
}

// The tight content rectangle (rings, plus the origin/+X arrow for a full result) in image pixels.
// Exported so the threshold-mask view can be cropped to the exact same frame as the overlay, keeping
// the Scan/Threshold toggle from jumping. Assumes rings is non-empty (the caller shows the full frame
// when nothing was detected).
export function contentRect(
  rings: DetectedRing[],
  orientation: Orientation | null,
  cols: number,
  rows: number,
): { x: number; y: number; width: number; height: number } {
  const medR = radiusMedian(rings)
  let minX = Number.MAX_VALUE
  let minY = Number.MAX_VALUE
  let maxX = -Number.MAX_VALUE
  let maxY = -Number.MAX_VALUE
  for (const ring of rings) {
    minX = Math.min(minX, ring.centerX - ring.radiusPx)
    maxX = Math.max(maxX, ring.centerX + ring.radiusPx)
    minY = Math.min(minY, ring.centerY - ring.radiusPx)
    maxY = Math.max(maxY, ring.centerY + ring.radiusPx)
  }

  if (orientation) {
    const axisLength = medR * 6.0
    minX = Math.min(minX, orientation.originX)
    minY = Math.min(minY, orientation.originY)
    maxX = Math.max(maxX, orientation.originX + orientation.xAxisX * axisLength)
    maxY = Math.max(maxY, orientation.originY + orientation.xAxisY * axisLength)
  }

  const margin = Math.max(medR * 1.2, (maxX - minX) * 0.05)
  const x0 = clampInt(Math.floor(minX - margin), 0, cols - 1)
  const y0 = clampInt(Math.floor(minY - margin), 0, rows - 1)
  const x1 = clampInt(Math.ceil(maxX + margin), x0 + 1, cols)
  const y1 = clampInt(Math.ceil(maxY + margin), y0 + 1, rows)
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

// Crops to the content and takes ownership of the canvas: returns either the canvas (nothing
// detected) or a new cropped Mat, deleting the original in the latter case.
function crop(cv: OpenCv, canvas: Mat, rings: DetectedRing[], orientation: Orientation | null): Mat {
  if (rings.length === 0) return canvas
  const r = contentRect(rings, orientation, canvas.cols, canvas.rows)
  const roi = canvas.roi(new cv.Rect(r.x, r.y, r.width, r.height))
  const cropped = roi.clone()
  roi.delete()
  canvas.delete()
  return cropped
}

function clampInt(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}
