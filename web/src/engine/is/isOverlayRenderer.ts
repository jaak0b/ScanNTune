import type { Mat, OpenCv } from '../opencv'
import type { IsAlignment } from './isFiducialAligner'
import { mmToPx } from './isFiducialAligner'
import type { IsTestSpec } from './types'
import { isCouponGeometry, tierRampMm } from './couponGeometry'
import type { IsLine } from './couponGeometry'
import { measuredDirection } from './lineTracer'
import type { IsAxisResult, IsLineOutcome, IsPointPx } from './resultTypes'

// Draws the input shaper trace outcomes over a copy of ONE scan, as a debugging view of what
// the analysis actually read: each line's traced stretch colored by its verdict (green =
// measured, red = skipped), a corner dot and a read-window bracket per line, and for skipped
// lines the line's number next to its corner. A line that could not be traced at all is drawn
// at its EXPECTED position from the coupon geometry, with a cross at its midpoint, so a
// damaged or missing line is still pointed at. Only the axes measured from this scan are
// drawn. Feature placement goes through the alignment affine, so it follows any rotation or
// flip; the finished overlay is cropped to the coupon's outline plus a small margin. Uses only
// OpenCV drawing (no image codec). Colours are BGR. The caller deletes the result.

const ACCEPTED_COLOR = [0, 255, 0, 255] // green
const REFUSED_COLOR = [0, 0, 255, 255] // red
const CORNER_COLOR = [0, 255, 255, 255] // yellow
const BRACKET_COLOR = [255, 255, 0, 255] // cyan
const FIDUCIAL_COLOR = [0, 255, 255, 255] // yellow

const SHIFT = 3
const SCALE = 1 << SHIFT

// Margin around the coupon's pixel bounding box, as a fraction of the box's larger side.
const CROP_MARGIN_FRACTION = 0.05
/** Half-length of a read-window bracket tick, mm. */
const BRACKET_HALF_MM = 1.5
/** Arm half-length of the cross marking an untraced line's expected midpoint, mm. */
const CROSS_HALF_MM = 2
/** Target cap height of the skipped-line number, mm. */
const LABEL_HEIGHT_MM = 3

export function renderIsOverlayMat(
  cv: OpenCv,
  image: Mat,
  alignment: IsAlignment,
  spec: IsTestSpec,
  axes: IsAxisResult[],
  scanIndex: 0 | 1,
): Mat {
  // A failed alignment has no affine to place anything with; fail before allocating the
  // canvas so the throw cannot leak a Mat.
  if (!alignment.success || !alignment.affine) {
    throw new Error('Overlay rendering requires a successful alignment')
  }
  const canvas = toBgr(cv, image)
  const thickness = strokeThickness(image)
  const g = isCouponGeometry(spec)
  const pxPerMm = Math.hypot(alignment.affine.a, alignment.affine.c)

  for (const axis of axes) {
    if (axis.scanIndex !== scanIndex) continue
    const group = g.groups.find((gr) => gr.axis === axis.axis)
    if (!group) continue
    for (const outcome of axis.lines) {
      const line = group.lines[outcome.lineIndex]
      if (!line || !outcome.startPx || !outcome.endPx) continue
      drawLineOutcome(cv, canvas, alignment, spec, line, outcome, pxPerMm, thickness)
    }
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

  return cropToCoupon(cv, canvas, alignment, g.couponWidthMm, g.couponHeightMm)
}

function drawLineOutcome(
  cv: OpenCv,
  canvas: Mat,
  alignment: IsAlignment,
  spec: IsTestSpec,
  line: IsLine,
  outcome: IsLineOutcome,
  pxPerMm: number,
  thickness: number,
): void {
  const color = new cv.Scalar(...(outcome.accepted ? ACCEPTED_COLOR : REFUSED_COLOR))
  const start = outcome.startPx!
  const end = outcome.endPx!

  // The traced stretch, colored by the verdict.
  cv.line(canvas, fixedPoint(cv, start), fixedPoint(cv, end), color, thickness, cv.LINE_AA, SHIFT)

  // Unit direction of the line in image pixels and its perpendicular, for the ticks.
  const len = Math.hypot(end.x - start.x, end.y - start.y)
  if (!(len > 0)) return
  const ux = (end.x - start.x) / len
  const uy = (end.y - start.y) / len
  const px = -uy
  const py = ux

  // The ringing corner.
  const corner = mmToPx(alignment, line.measured.x0, line.measured.y0)
  const cornerColor = new cv.Scalar(...CORNER_COLOR)
  cv.circle(canvas, fixedPoint(cv, corner), thickness * 3 * SCALE, cornerColor, thickness, cv.LINE_AA, SHIFT)

  // Read-window bracket: perpendicular ticks where the clean read starts (after the
  // acceleration ramp) and where it ends.
  const dir = measuredDirection(line)
  const rampMm = tierRampMm(spec, line.speedMmS, line.cornerSpeedMmS)
  const bracketColor = new cv.Scalar(...BRACKET_COLOR)
  for (const sMm of [rampMm, rampMm + spec.measuredLineMm]) {
    const at = mmToPx(alignment, line.measured.x0 + dir.dx * sMm, line.measured.y0 + dir.dy * sMm)
    const half = BRACKET_HALF_MM * pxPerMm
    const a = { x: at.x - px * half, y: at.y - py * half }
    const b = { x: at.x + px * half, y: at.y + py * half }
    cv.line(canvas, fixedPoint(cv, a), fixedPoint(cv, b), bracketColor, thickness, cv.LINE_AA, SHIFT)
  }

  // A line that was never traced gets a cross at its expected midpoint.
  if (!outcome.traced) {
    const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
    const arm = CROSS_HALF_MM * pxPerMm
    const crossColor = new cv.Scalar(...REFUSED_COLOR)
    for (const [dx, dy] of [
      [1, 1],
      [1, -1],
    ]) {
      const a = { x: mid.x - dx * arm, y: mid.y - dy * arm }
      const b = { x: mid.x + dx * arm, y: mid.y + dy * arm }
      cv.line(canvas, fixedPoint(cv, a), fixedPoint(cv, b), crossColor, thickness + 1, cv.LINE_AA, SHIFT)
    }
  }

  // Skipped lines carry their number next to the corner, offset away from the traced stretch
  // so the label does not sit on the bead.
  if (!outcome.accepted) {
    const offset = (BRACKET_HALF_MM + 1) * pxPerMm
    const org = new cv.Point(
      Math.round(corner.x - ux * offset + px * offset),
      Math.round(corner.y - uy * offset + py * offset),
    )
    // FONT_HERSHEY_SIMPLEX renders about 22 px of cap height at font scale 1.
    const fontScale = (LABEL_HEIGHT_MM * pxPerMm) / 22
    cv.putText(
      canvas,
      String(outcome.lineIndex + 1),
      org,
      cv.FONT_HERSHEY_SIMPLEX,
      fontScale,
      new cv.Scalar(...REFUSED_COLOR),
      Math.max(1, thickness),
      cv.LINE_AA,
    )
  }
}

/**
 * The crop rectangle the overlay is reduced to: the axis-aligned bounding box of the coupon's
 * four outline corners in scan pixels, expanded by CROP_MARGIN_FRACTION and clamped to the
 * image. Exported so tests can translate expected scan positions into overlay positions.
 */
export function couponCropRect(
  alignment: IsAlignment,
  couponWidthMm: number,
  couponHeightMm: number,
  cols: number,
  rows: number,
): { x: number; y: number; width: number; height: number } {
  const corners = [
    mmToPx(alignment, 0, 0),
    mmToPx(alignment, couponWidthMm, 0),
    mmToPx(alignment, couponWidthMm, couponHeightMm),
    mmToPx(alignment, 0, couponHeightMm),
  ]
  const xs = corners.map((p) => p.x)
  const ys = corners.map((p) => p.y)
  const margin =
    Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) *
    CROP_MARGIN_FRACTION
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - margin))
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - margin))
  const x1 = Math.min(cols, Math.ceil(Math.max(...xs) + margin))
  const y1 = Math.min(rows, Math.ceil(Math.max(...ys) + margin))
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

// Presentation only: no measurement depends on this. Consumes the input canvas and returns a
// new Mat (or the canvas itself when the crop rectangle is degenerate).
function cropToCoupon(
  cv: OpenCv,
  canvas: Mat,
  alignment: IsAlignment,
  couponWidthMm: number,
  couponHeightMm: number,
): Mat {
  const r = couponCropRect(alignment, couponWidthMm, couponHeightMm, canvas.cols, canvas.rows)
  if (r.width <= 0 || r.height <= 0) return canvas
  const roi = canvas.roi(new cv.Rect(r.x, r.y, r.width, r.height))
  // copyTo, not clone: OpenCV.js clone() of a ROI keeps the source's row stride, which leaves
  // the flat `data` view misaligned. copyTo always allocates a continuous Mat.
  const cropped = new cv.Mat()
  roi.copyTo(cropped)
  roi.delete()
  canvas.delete()
  return cropped
}

// An axis-aligned coupon-frame rectangle, drawn as four lines because the affine may rotate it
// in scan pixels.
function drawMmRect(
  cv: OpenCv,
  canvas: Mat,
  alignment: IsAlignment,
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
  ].map((p) => fixedPoint(cv, p))
  for (let i = 0; i < 4; i++) {
    cv.line(canvas, corners[i], corners[(i + 1) % 4], color, thickness, cv.LINE_AA, SHIFT)
  }
}

function fixedPoint(cv: OpenCv, p: IsPointPx) {
  return new cv.Point(Math.round(p.x * SCALE), Math.round(p.y * SCALE))
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
