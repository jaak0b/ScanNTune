import type { Mat, OpenCv } from '../opencv'
import type { PaTestSpec } from './types'
import { couponGeometry } from './types'
import type { PaAlignment } from './fiducialAligner'
import { mmToPx } from './fiducialAligner'
import { median } from '../math'
import { assessMeasurementBackdrop, MIN_BACKDROP_CONTRAST } from '../measurementBackdrop'
import type { BackdropAssessment } from '../measurementBackdrop'
import { EDGE_REFINE_WINDOW_PX, bilinear, gradientCentroid } from '../subpixelEdge'

// Profiles a PA test line's extruded width along its length to sub-pixel precision. Every 0.25 mm
// along the line (skipping the ragged 2 mm at each end), a perpendicular intensity profile is
// extracted by bilinear interpolation, and the line's two edges are located by the half-amplitude
// (50 percent contrast) crossing: walking outward from the profile extremum (the point deviating
// most from the base tone, so lines darker or brighter than the base measure identically) to the
// first crossing of the level midway between the extremum and the base median, refined by a
// gradient centroid (center-of-gravity, the same local sub-pixel edge pattern as the EM gap
// measurer's refineEdge). The search and the centroid window are both bounded to the flank next
// to the extremum, so a strong gradient elsewhere on the base (glossy infill ridges, dust) cannot
// capture the edge. Width is converted to mm with the alignment's local scale along the
// perpendicular, so rotation, flip, and scanner anisotropy are all accounted for by the affine
// itself.

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
// How far from the extremum an edge may sit, as a multiple of the nominal line width: covers the
// widest physical bulge a PA transient produces while excluding the neighbouring base texture.
const EDGE_BOUND_WIDTH_FACTOR = 1.6

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
  const boundSamples = Math.round(
    (EDGE_BOUND_WIDTH_FACTOR * spec.lineWidthMm * perpPxPerMm) / PROFILE_STEP_PX,
  )
  const samples: WidthSample[] = []
  const profile = new Float64Array(profileLen)
  for (let xMm = END_SKIP_MM; xMm <= lineLenMm - END_SKIP_MM + 1e-9; xMm += SAMPLE_STEP_MM) {
    const centre = mmToPx(alignment, g.lineStartXMm + xMm, yMm)
    const widthMm =
      measureAt(data, cols, rows, centre.x, centre.y, ux, uy, s0, profileLen, profile, boundSamples) /
      perpPxPerMm
    samples.push({ xMm, widthMm })
  }
  return samples
}

/** Scan-pixel positions (fractional, bilinear-read) the line backdrop gate samples. */
export interface LineGatePositions {
  line: { x: number; y: number }[]
  base: { x: number; y: number }[]
}

// The gate's sample positions: base tone samples half a line pitch off each line's centreline
// (between the lines, always on the base), line tone samples on the line centrelines, all
// through the solved affine. Computed once per scan and shared by the per-candidate tone
// assessment and the BGR class sampling the discriminant plane is built from, so both read the
// same scene points.
export function lineGatePositions(alignment: PaAlignment, spec: PaTestSpec): LineGatePositions {
  if (!alignment.success) throw new Error('Cannot assess the backdrop without a successful alignment.')
  const g = couponGeometry(spec)
  const lineLenMm = 2 * spec.slowSegmentMm + spec.fastSegmentMm
  const line: { x: number; y: number }[] = []
  const base: { x: number; y: number }[] = []
  for (let i = 0; i < spec.lineCount; i++) {
    const yMm = g.lineStartYMm(i)
    // A 1 mm step (coarser than the width profiler's 0.25 mm) suffices here: the medians only
    // need a representative tone sample, not sub-pixel coverage.
    for (let xMm = END_SKIP_MM; xMm <= lineLenMm - END_SKIP_MM + 1e-9; xMm += 1) {
      line.push(mmToPx(alignment, g.lineStartXMm + xMm, yMm))
      base.push(mmToPx(alignment, g.lineStartXMm + xMm, yMm + spec.linePitchMm / 2))
    }
  }
  return { line, base }
}

// Assesses the printed base as the measurement backdrop behind the test lines, reading the gate
// positions' tones off one candidate measurement plane. Both medians are robust order
// statistics, so a few gap or transition samples cannot bias them. The judgment (polarity-free
// contrast plus base tone uniformity) is the shared measurement-backdrop gate.
export function assessLineBackdrop(
  cv: OpenCv,
  gray: Mat,
  positions: LineGatePositions,
): BackdropAssessment {
  if (!gray || gray.empty()) throw new Error('Image is null or empty.')
  if (gray.type() !== cv.CV_8UC1) {
    throw new Error('assessLineBackdrop expects a CV_8UC1 (single-channel 8-bit) image.')
  }

  const data = gray.data as Uint8Array
  const cols = gray.cols
  const rows = gray.rows
  const read = (points: { x: number; y: number }[]) =>
    points.map((p) => bilinear(data, cols, rows, p.x, p.y)).filter(Number.isFinite)
  return assessMeasurementBackdrop(read(positions.line), read(positions.base))
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
  boundSamples: number,
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

  // Half-amplitude (50 percent contrast) level between the extremum and the base median, the
  // classic threshold-crossing edge definition; the gradient centroid then refines each crossing.
  const halfLevel = (profile[extIdx] + med) / 2
  const grad = (k: number) => Math.abs(profile[k + 1] - profile[k - 1])
  const winS = Math.round(EDGE_REFINE_WINDOW_PX / PROFILE_STEP_PX)
  const left = subPixLocal(profile, grad, extIdx, -1, 1, profileLen - 2, boundSamples, halfLevel, winS)
  const right = subPixLocal(profile, grad, extIdx, 1, 1, profileLen - 2, boundSamples, halfLevel, winS)
  if (Number.isNaN(left) || Number.isNaN(right)) return NaN
  return (right - left) * PROFILE_STEP_PX
}

// Local half-amplitude edge: walking outward from the profile extremum in direction dir, the
// first crossing of the half-contrast level, refined by the gradient centroid in a window around
// the crossing. Both the walk and the centroid window are clamped to the flank (at most
// boundSamples from the extremum), so a stronger gradient beyond the edge (base texture) cannot
// pull the estimate; the crossing sample itself is the fallback when the window carries no
// gradient weight. NaN when no crossing exists inside the bound.
function subPixLocal(
  profile: Float64Array,
  grad: (k: number) => number,
  extIdx: number,
  dir: -1 | 1,
  kLo: number,
  kHi: number,
  boundSamples: number,
  halfLevel: number,
  winS: number,
): number {
  const to = dir < 0 ? Math.max(kLo, extIdx - boundSamples) : Math.min(kHi, extIdx + boundSamples)
  const extSide = Math.sign(profile[extIdx] - halfLevel) // which side of the level the line sits on
  for (let k = extIdx + dir; dir < 0 ? k >= to : k <= to; k += dir) {
    if (Math.sign(profile[k] - halfLevel) !== extSide) {
      // Crossing between k-dir and k; centroid window clamped to the flank.
      const flankLo = dir < 0 ? to : extIdx + 1
      const flankHi = dir < 0 ? extIdx - 1 : to
      const seed = k - (dir < 0 ? 0 : dir) // sample just inside the crossing pair
      return gradientCentroid(grad, Math.min(Math.max(seed, flankLo), flankHi), winS, flankLo, flankHi) ?? seed
    }
  }
  return NaN
}
