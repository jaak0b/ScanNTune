import type { Mat, OpenCv } from '../opencv'
import type { PaAlignment } from './fiducialAligner'
import { mmToPx } from './fiducialAligner'
import type { PaResult, PaTestSpec } from './types'
import { couponGeometry } from './types'

// Draws the PA analysis over a copy of the scan: each measured test line gets a rectangle tinted by
// its normalized score (green = low deviation, red = high), the best line is highlighted in green,
// and the three fiducial holes are outlined. Rectangles are placed in coupon-frame millimetres and
// mapped to scan pixels through the alignment affine, so they follow any rotation or flip. The
// finished overlay is cropped to the coupon's outline (plus a small margin) so the UI shows the
// coupon, not the whole scan page. Uses only OpenCV drawing (no image codec). Colours are BGR. The
// caller deletes the result.

const FIDUCIAL_COLOR = [0, 255, 255, 255] // yellow
const BEST_COLOR = [0, 255, 0, 255] // green

const SHIFT = 3
const SCALE = 1 << SHIFT

// Margin around the coupon's pixel bounding box, as a fraction of the box's larger side.
const CROP_MARGIN_FRACTION = 0.05

export function renderPaOverlayMat(
  cv: OpenCv,
  image: Mat,
  alignment: PaAlignment,
  spec: PaTestSpec,
  result: PaResult,
): Mat {
  const canvas = toBgr(cv, image)
  const thickness = strokeThickness(image)
  const g = couponGeometry(spec)
  const [startXMm, endXMm] = g.lineExtentXsMm

  // Normalize the finite measured scores to [0, 1] for the green-to-red tint.
  const finite = result.lines.filter((l) => l.measured && Number.isFinite(l.score))
  const minScore = Math.min(...finite.map((l) => l.score))
  const maxScore = Math.max(...finite.map((l) => l.score))
  const range = maxScore - minScore

  const halfMm = spec.linePitchMm * 0.35
  for (const line of result.lines) {
    if (!line.measured) continue
    const t = range > 0 ? (line.score - minScore) / range : 0
    const isBest = line.index === result.bestLineIndex
    const color = isBest
      ? new cv.Scalar(...BEST_COLOR)
      : new cv.Scalar(0, Math.round(255 * (1 - t)), Math.round(255 * t), 255)
    const yMm = g.lineStartYMm(line.index)
    drawMmRect(
      cv,
      canvas,
      alignment,
      g.lineStartXMm + startXMm,
      yMm - halfMm,
      g.lineStartXMm + endXMm,
      yMm + halfMm,
      color,
      isBest ? thickness + 1 : thickness,
    )
  }

  const fidColor = new cv.Scalar(...FIDUCIAL_COLOR)
  const halfFidMm = g.fiducialSizeMm / 2
  for (const f of g.fiducials) {
    drawMmRect(
      cv,
      canvas,
      alignment,
      f.xMm - halfFidMm,
      f.yMm - halfFidMm,
      f.xMm + halfFidMm,
      f.yMm + halfFidMm,
      fidColor,
      thickness,
    )
  }

  return cropToCoupon(cv, canvas, alignment, g.baseWidthMm, g.baseHeightMm)
}

// Crops the canvas to the axis-aligned bounding box of the coupon's four outline corners mapped
// into scan pixels, expanded by CROP_MARGIN_FRACTION and clamped to the image. Presentation only:
// no measurement depends on this. Consumes the input canvas and returns a new Mat.
function cropToCoupon(
  cv: OpenCv,
  canvas: Mat,
  alignment: PaAlignment,
  baseWidthMm: number,
  baseHeightMm: number,
): Mat {
  const corners = [
    mmToPx(alignment, 0, 0),
    mmToPx(alignment, baseWidthMm, 0),
    mmToPx(alignment, baseWidthMm, baseHeightMm),
    mmToPx(alignment, 0, baseHeightMm),
  ]
  const xs = corners.map((p) => p.x)
  const ys = corners.map((p) => p.y)
  const margin = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * CROP_MARGIN_FRACTION
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - margin))
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - margin))
  const x1 = Math.min(canvas.cols, Math.ceil(Math.max(...xs) + margin))
  const y1 = Math.min(canvas.rows, Math.ceil(Math.max(...ys) + margin))
  if (x1 <= x0 || y1 <= y0) return canvas
  const roi = canvas.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0))
  // copyTo, not clone: OpenCV.js clone() of a ROI keeps the source's row stride, which leaves
  // the flat `data` view misaligned. copyTo always allocates a continuous Mat.
  const cropped = new cv.Mat()
  roi.copyTo(cropped)
  roi.delete()
  canvas.delete()
  return cropped
}

// An axis-aligned coupon-frame rectangle, drawn as four lines because the affine may rotate it in
// scan pixels.
function drawMmRect(
  cv: OpenCv,
  canvas: Mat,
  alignment: PaAlignment,
  x0Mm: number,
  y0Mm: number,
  x1Mm: number,
  y1Mm: number,
  color: InstanceType<OpenCv['Scalar']>,
  thickness: number,
): void {
  const corners = [
    mmToPx(alignment, x0Mm, y0Mm),
    mmToPx(alignment, x1Mm, y0Mm),
    mmToPx(alignment, x1Mm, y1Mm),
    mmToPx(alignment, x0Mm, y1Mm),
  ].map((p) => new cv.Point(Math.round(p.x * SCALE), Math.round(p.y * SCALE)))
  for (let i = 0; i < 4; i++) {
    cv.line(canvas, corners[i], corners[(i + 1) % 4], color, thickness, cv.LINE_AA, SHIFT)
  }
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
