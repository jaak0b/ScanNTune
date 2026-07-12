import type { Mat, OpenCv } from '../opencv'
import type { PaTestSpec } from './types'
import { couponGeometry } from './types'
import type { PaAlignment } from './fiducialAligner'
import { mmToPx } from './fiducialAligner'
import { median } from '../math'
import { assessMeasurementBackdrop, MIN_BACKDROP_CONTRAST } from '../measurementBackdrop'
import type { BackdropAssessment } from '../measurementBackdrop'
import { EDGE_REFINE_WINDOW_PX, gradientCentroid } from '../subpixelEdge'

// Profiles a PA test line's extruded width along its length to sub-pixel precision. Every 0.25 mm
// along the line (skipping the ragged 2 mm at each end), a perpendicular intensity profile is
// extracted by bilinear interpolation, and the line's two edges are located as the strongest
// intensity-gradient peak on each side of the profile's extremum (the point deviating most from
// the base tone, so lines darker or brighter than the base measure identically), refined by a
// gradient centroid (center-of-gravity, the same sub-pixel edge estimator the EM gap measurer
// uses). Width is converted to mm
// with the alignment's local scale along the perpendicular, so rotation, flip, and scanner
// anisotropy are all accounted for by the affine itself.

export interface WidthSample {
  xMm: number // line-local x
  widthMm: number // sub-pixel measured width, NaN where no edge pair found
}

const SAMPLE_STEP_MM = 0.25
const END_SKIP_MM = 2
const PROFILE_STEP_PX = 0.25
// Minimum contrast between the line and the base for a line to be present at all: the profile
// extremum must deviate at least this far from the profile median (in either direction), else the
// sample is a gap. The same brightness-separation floor as the shared backdrop gate.
export const MIN_LINE_CONTRAST = MIN_BACKDROP_CONTRAST
// Noise floor for a genuine edge, matching the card measurer's gradient gate.
const MIN_EDGE_GRADIENT = 8

export function measureLineWidthProfile(
  cv: OpenCv,
  gray: Mat,
  alignment: PaAlignment,
  spec: PaTestSpec,
  lineIndex: number,
): WidthSample[] {
  if (!gray || gray.empty()) throw new Error('Image is null or empty.')
  if (gray.channels() !== 1) throw new Error('measureLineWidthProfile expects a single-channel image.')
  if (gray.type() !== cv.CV_8UC1) {
    throw new Error('measureLineWidthProfile expects a CV_8UC1 (single-channel 8-bit) image.')
  }
  if (!alignment.success) throw new Error('Cannot profile lines without a successful alignment.')
  if (lineIndex < 0 || lineIndex >= spec.lineCount) throw new Error('Line index out of range.')

  const data = gray.data as Uint8Array
  const cols = gray.cols

  const g = couponGeometry(spec)
  const lineLenMm = 2 * spec.slowSegmentMm + spec.fastSegmentMm
  const yMm = g.lineStartYMm(lineIndex)

  // The perpendicular to the line (coupon +Y) mapped through the affine's linear part; its length
  // is the local px-per-mm along the profile direction.
  const perpPxPerMm = Math.hypot(alignment.b, alignment.d)
  if (perpPxPerMm <= 0) throw new Error('The alignment is degenerate (zero scale).')
  const ux = alignment.b / perpPxPerMm
  const uy = alignment.d / perpPxPerMm

  const halfRangePx = (spec.linePitchMm / 2) * perpPxPerMm
  const profileLen = 2 * Math.floor(halfRangePx / PROFILE_STEP_PX) + 1
  const s0 = -Math.floor(halfRangePx / PROFILE_STEP_PX) * PROFILE_STEP_PX

  const rows = gray.rows
  const samples: WidthSample[] = []
  const profile = new Float64Array(profileLen)
  for (let xMm = END_SKIP_MM; xMm <= lineLenMm - END_SKIP_MM + 1e-9; xMm += SAMPLE_STEP_MM) {
    const centre = mmToPx(alignment, g.lineStartXMm + xMm, yMm)
    const widthMm =
      measureAt(data, cols, rows, centre.x, centre.y, ux, uy, s0, profileLen, profile) / perpPxPerMm
    samples.push({ xMm, widthMm })
  }
  return samples
}

// Assesses the printed base as the measurement backdrop behind the test lines. Base tone samples
// are taken half a line pitch off each line's centreline (between the lines, always on the base);
// line tone samples sit on the line centrelines. Both medians are robust order statistics, so a
// few gap or transition samples cannot bias them. The judgment (polarity-free contrast plus base
// tone uniformity) is the shared measurement-backdrop gate.
export function assessLineBackdrop(
  cv: OpenCv,
  gray: Mat,
  alignment: PaAlignment,
  spec: PaTestSpec,
): BackdropAssessment {
  if (!gray || gray.empty()) throw new Error('Image is null or empty.')
  if (gray.type() !== cv.CV_8UC1) {
    throw new Error('assessLineBackdrop expects a CV_8UC1 (single-channel 8-bit) image.')
  }
  if (!alignment.success) throw new Error('Cannot assess the backdrop without a successful alignment.')

  const data = gray.data as Uint8Array
  const cols = gray.cols
  const rows = gray.rows
  const g = couponGeometry(spec)
  const lineLenMm = 2 * spec.slowSegmentMm + spec.fastSegmentMm

  const lineSamples: number[] = []
  const baseSamples: number[] = []
  for (let i = 0; i < spec.lineCount; i++) {
    const yMm = g.lineStartYMm(i)
    // A 1 mm step (coarser than the width profiler's 0.25 mm) suffices here: the medians only
    // need a representative tone sample, not sub-pixel coverage.
    for (let xMm = END_SKIP_MM; xMm <= lineLenMm - END_SKIP_MM + 1e-9; xMm += 1) {
      const onLine = mmToPx(alignment, g.lineStartXMm + xMm, yMm)
      const offLine = mmToPx(alignment, g.lineStartXMm + xMm, yMm + spec.linePitchMm / 2)
      const vLine = bilinear(data, cols, rows, onLine.x, onLine.y)
      const vBase = bilinear(data, cols, rows, offLine.x, offLine.y)
      if (Number.isFinite(vLine)) lineSamples.push(vLine)
      if (Number.isFinite(vBase)) baseSamples.push(vBase)
    }
  }
  return assessMeasurementBackdrop(lineSamples, baseSamples)
}

// Width in px of the line crossing the profile centred at (cx, cy), or NaN when no line or no
// edge pair is found there. The line may be darker or brighter than the base.
function measureAt(
  data: Uint8Array,
  cols: number,
  rows: number,
  cx: number,
  cy: number,
  ux: number,
  uy: number,
  s0: number,
  profileLen: number,
  profile: Float64Array,
): number {
  for (let k = 0; k < profileLen; k++) {
    const s = s0 + k * PROFILE_STEP_PX
    const v = bilinear(data, cols, rows, cx + ux * s, cy + uy * s)
    if (Number.isNaN(v)) return NaN
    profile[k] = v
  }

  // The profile median is the base tone (the line occupies a minority of the profile); the line
  // centre is the point deviating most from it, in either direction, so both polarities work.
  const med = median(Array.from(profile))
  let extIdx = 0
  for (let k = 1; k < profileLen; k++) {
    if (Math.abs(profile[k] - med) > Math.abs(profile[extIdx] - med)) extIdx = k
  }
  if (Math.abs(profile[extIdx] - med) < MIN_LINE_CONTRAST) return NaN // no line here: a gap

  // Gradient magnitude (central difference); the strongest peak on each flank of the extremum is
  // the edge, refined with a gradient centroid around the peak.
  const grad = (k: number) => Math.abs(profile[k + 1] - profile[k - 1])
  const left = subPixEdge(grad, 1, extIdx - 1)
  const right = subPixEdge(grad, extIdx + 1, profileLen - 2)
  if (Number.isNaN(left) || Number.isNaN(right)) return NaN
  return (right - left) * PROFILE_STEP_PX
}

// Sub-pixel index of the strongest gradient peak within [kLo, kHi], refined by the gradient
// centroid (center-of-gravity) over a window around the peak: the first moment of the gradient
// magnitude. For a symmetric edge-spread function the centroid is the true edge position, and
// unlike a parabolic fit of the peak it stays continuous where bilinear resampling makes the
// gradient piecewise constant (the same estimator the EM gap measurer uses). NaN when the window
// is empty or the peak is below the noise floor.
function subPixEdge(grad: (k: number) => number, kLo: number, kHi: number): number {
  if (kHi < kLo) return NaN
  let best = -1
  let bk = -1
  for (let k = kLo; k <= kHi; k++) {
    const gk = grad(k)
    if (gk > best) {
      best = gk
      bk = k
    }
  }
  if (bk < 0 || best < MIN_EDGE_GRADIENT) return NaN

  const windowSamples = Math.round(EDGE_REFINE_WINDOW_PX / PROFILE_STEP_PX)
  return gradientCentroid(grad, bk, windowSamples, kLo, kHi) ?? bk
}

// Bilinear intensity at a fractional pixel position; NaN outside the image.
function bilinear(data: Uint8Array, cols: number, rows: number, x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  if (x0 < 0 || y0 < 0 || x0 + 1 >= cols || y0 + 1 >= rows) return NaN
  const fx = x - x0
  const fy = y - y0
  const p = (yy: number, xx: number) => data[yy * cols + xx]
  return (
    p(y0, x0) * (1 - fx) * (1 - fy) +
    p(y0, x0 + 1) * fx * (1 - fy) +
    p(y0 + 1, x0) * (1 - fx) * fy +
    p(y0 + 1, x0 + 1) * fx * fy
  )
}
