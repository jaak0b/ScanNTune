import type { Mat, OpenCv } from '../opencv'
import type { IsTestSpec } from './types'
import type { IsLine, IsLineGroup } from './couponGeometry'
import { tierRampMm } from './couponGeometry'
import type { IsAlignment } from './isFiducialAligner'
import { mmToPx } from './isFiducialAligner'
import { median } from '../math'
import { bilinear } from '../subpixelEdge'
import { isUsableReference, referenceAlongDirection } from '../scannerCalibration'
import type { ScaleReference } from '../scannerCalibration'

// Traces the centerline of each measured IS line to sub-pixel precision. For every sample
// position along the line's nominal direction, an intensity profile is taken perpendicular to
// it (bilinear-sampled, like the EM gap measurer), and the line's lateral position is the
// intensity-weighted centroid of the profile's deviation from the local background: the same
// first-moment (center-of-gravity) estimator this codebase already uses for ring centroids and
// EM edge refinement, here in its thresholded center-of-gravity form standard in laser-stripe /
// line-peak localization (weights below a fraction of the peak deviation are zeroed so
// background noise cannot pull the centroid toward the window center).
//
// Feature LOCATIONS come from the alignment affine, but every measured DISTANCE converts to
// true millimetres through the card-calibrated scanner reference along the direction it is
// measured in: arc length along the line's image direction, lateral deviation along the
// perpendicular. A per-axis (CCD) reference therefore contributes only the axis actually used.
//
// Sample distances are mapped to time since the corner with the commanded trapezoidal velocity
// profile (constant-acceleration kinematics): t(s) = (sqrt(v0^2 + 2 a s) - v0) / a inside the
// acceleration ramp from the corner speed to the tier speed, then linear at the cruise speed.

export interface TracedLine {
  speedMmS: number
  /** Time since the corner of each sample, seconds (trapezoidal velocity profile mapping). */
  tS: Float64Array
  /** Lateral deviation from the nominal centerline of each sample, true mm. */
  lateralMm: Float64Array
  /** Index where the noise-floor window starts: the last stretch of the clean read. */
  noiseWindowStart: number
}

export interface TracedGroup {
  axis: IsLineGroup['axis']
  /**
   * One entry per geometry line, in group order. A null entry is a line the tracer had to
   * drop because its trace left the image or showed no bead.
   */
  traces: (TracedLine | null)[]
}

/** Distance from the corner where tracing starts: clears the corner blob and keeps the
 *  perpendicular profile window off the run-up bead, which is colinear with the window at the
 *  corner itself. */
export const TRACE_START_MM = 1
/** Perpendicular half-window of the centroid profile. Must exceed the largest expected ring
 *  amplitude (about 0.64 mm at the default corner speed, see DEFAULT_CORNER_SPEED_MM_S) plus
 *  half a bead, and stay under the line pitch minus the same, so a neighbouring trace never
 *  enters the window. */
export const PROFILE_HALF_WINDOW_MM = 1.0
/** Step along the line in image px (sub-pixel sampling like the EM profiles). */
const ALONG_STEP_PX = 0.5
/** Step across the line in image px. */
const ACROSS_STEP_PX = 0.25
/** Weights below this fraction of the peak deviation are zeroed (thresholded centroid).
 *  0.5 of the local bead depth is the full-width-at-half-maximum localization level, the
 *  standard robust choice for asymmetric line profiles (see Fisher and Naidu, "A Comparison
 *  of Algorithms for Subpixel Peak Detection"); a low threshold lets a one-sided scanner
 *  lamp-shadow skirt above the threshold drag the intensity-weighted centroid toward the
 *  shadow, while the half-maximum level cuts that lever arm. */
const CENTROID_THRESHOLD = 0.5
/** Minimum peak deviation (gray levels) for a sample to count as seeing the bead at all. */
const MIN_PEAK_DEVIATION = 8
/** Fraction of samples that may fail before the whole line is dropped. */
const MAX_INVALID_FRACTION = 0.1
/** Last fraction of the clean read used as the noise-floor window (the ring has decayed
 *  there for any resonance and damping in the search range: at the slowest 20 Hz corner ring
 *  with damping 0.02, five read wavelengths in, the envelope is well below its start). */
const NOISE_WINDOW_FRACTION = 0.25

/** Time since the corner at arc distance sMm, per the commanded trapezoidal velocity profile. */
export function timeAtDistance(
  sMm: number,
  cornerSpeedMmS: number,
  tierSpeedMmS: number,
  accelMmS2: number,
): number {
  const rampMm = (tierSpeedMmS * tierSpeedMmS - cornerSpeedMmS * cornerSpeedMmS) / (2 * accelMmS2)
  if (sMm <= rampMm) {
    return (Math.sqrt(cornerSpeedMmS * cornerSpeedMmS + 2 * accelMmS2 * sMm) - cornerSpeedMmS) / accelMmS2
  }
  const tRamp = (tierSpeedMmS - cornerSpeedMmS) / accelMmS2
  return tRamp + (sMm - rampMm) / tierSpeedMmS
}

/** The unit coupon-frame direction of a line's measured segment. */
export function measuredDirection(line: IsLine): { dx: number; dy: number } {
  const dx = line.measured.x1 - line.measured.x0
  const dy = line.measured.y1 - line.measured.y0
  const n = Math.hypot(dx, dy)
  return { dx: dx / n, dy: dy / n }
}

/** The image-space unit direction a coupon-frame direction maps to under the alignment. */
export function imageDirection(
  alignment: IsAlignment,
  dir: { dx: number; dy: number },
): { ux: number; uy: number } {
  const A = alignment.affine
  if (!A) throw new Error('The alignment did not succeed, so there is no coupon-to-scan mapping.')
  const x = A.a * dir.dx + A.b * dir.dy
  const y = A.c * dir.dx + A.d * dir.dy
  const n = Math.hypot(x, y)
  if (!(n > 0)) throw new Error('The alignment is degenerate (zero scale).')
  return { ux: x / n, uy: y / n }
}

/**
 * Traces every line of one group. `gray` is the scan's value channel (CV_8UC1). Lines whose
 * trace leaves the image or shows no bead are dropped and counted, not fabricated.
 */
export function traceGroup(
  cv: OpenCv,
  gray: Mat,
  alignment: IsAlignment,
  spec: IsTestSpec,
  group: IsLineGroup,
  scanReference: ScaleReference,
): TracedGroup {
  if (!gray || gray.empty()) throw new Error('Image is null or empty.')
  if (gray.channels() !== 1 || gray.type() !== cv.CV_8UC1) {
    throw new Error('traceGroup expects a CV_8UC1 (single-channel 8-bit) image.')
  }
  if (!alignment.success || !alignment.affine) {
    throw new Error('Cannot trace lines without a successful alignment.')
  }
  if (!isUsableReference(scanReference)) {
    throw new Error('The scan reference must be a positive scanner calibration.')
  }

  const data = gray.data as Uint8Array
  const cols = gray.cols
  const rows = gray.rows

  const traces = group.lines.map((line) =>
    traceLine(data, cols, rows, alignment, spec, line, scanReference),
  )
  return { axis: group.axis, traces }
}

/**
 * Image-pixel endpoints of a line's traced stretch (TRACE_START_MM past the corner to the
 * end of the clean read), from the coupon geometry mapped through the alignment. This is
 * the nominal, undisturbed centerline span; the ring's lateral deviations are sub-millimetre
 * and irrelevant for pointing at the line.
 */
export function tracedSpanPx(
  alignment: IsAlignment,
  spec: IsTestSpec,
  line: IsLine,
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const dir = measuredDirection(line)
  const endMm = tierRampMm(spec, line.speedMmS) + spec.measuredLineMm
  const at = (sMm: number) =>
    mmToPx(alignment, line.measured.x0 + dir.dx * sMm, line.measured.y0 + dir.dy * sMm)
  return { start: at(TRACE_START_MM), end: at(endMm) }
}

function traceLine(
  data: Uint8Array,
  cols: number,
  rows: number,
  alignment: IsAlignment,
  spec: IsTestSpec,
  line: IsLine,
  scanReference: ScaleReference,
): TracedLine | null {
  const dir = measuredDirection(line)
  const { ux, uy } = imageDirection(alignment, dir)
  // Perpendicular image direction (sign is irrelevant; the model fits the phase).
  const px = -uy
  const py = ux

  // True px/mm along the trace and across it, from the card reference.
  const alongPxPerMm = referenceAlongDirection(scanReference, ux, uy)
  const acrossPxPerMm = referenceAlongDirection(scanReference, px, py)

  // Affine-implied px/mm along the trace, used only to LOCATE samples in the image.
  const A = alignment.affine!
  const locX = A.a * dir.dx + A.b * dir.dy
  const locY = A.c * dir.dx + A.d * dir.dy
  const affinePxPerMm = Math.hypot(locX, locY)
  if (!(affinePxPerMm > 0)) return null

  const rampMm = tierRampMm(spec, line.speedMmS)
  const traceEndMm = rampMm + spec.measuredLineMm
  const corner = mmToPx(alignment, line.measured.x0, line.measured.y0)

  const stepAlongMm = ALONG_STEP_PX / affinePxPerMm
  const count = Math.floor((traceEndMm - TRACE_START_MM) / stepAlongMm) + 1
  if (count < 16) return null

  const halfWindowPx = PROFILE_HALF_WINDOW_MM * affinePxPerMm
  const acrossCount = Math.floor((2 * halfWindowPx) / ACROSS_STEP_PX) + 1
  const profile = new Float64Array(acrossCount)

  const tS = new Float64Array(count)
  const lateralMm = new Float64Array(count)
  let invalid = 0
  const bgSamples: number[] = []
  for (let k = 0; k < count; k++) {
    // Nominal (affine-located) sample point on the undisturbed centerline.
    const sLocMm = TRACE_START_MM + k * stepAlongMm
    const cx = corner.x + ux * sLocMm * affinePxPerMm
    const cy = corner.y + uy * sLocMm * affinePxPerMm

    let valid = 0
    for (let j = 0; j < acrossCount; j++) {
      const d = -halfWindowPx + j * ACROSS_STEP_PX
      const v = bilinear(data, cols, rows, cx + px * d, cy + py * d)
      profile[j] = v
      if (Number.isFinite(v)) valid++
    }
    // True arc distance from the corner, converted with the card reference along the trace.
    const sTrueMm = (sLocMm * affinePxPerMm) / alongPxPerMm
    tS[k] = timeAtDistance(sTrueMm, spec.cornerSpeedMmS, line.speedMmS, spec.accelMmS2)

    if (valid < acrossCount) {
      lateralMm[k] = NaN
      invalid++
      continue
    }

    // Local background: median of the outer quarter of the window on each side (the bead and
    // its ring stay inside the central half by the pitch/window sizing).
    bgSamples.length = 0
    const edge = Math.max(1, Math.floor(acrossCount / 8))
    for (let j = 0; j < edge; j++) {
      bgSamples.push(profile[j], profile[acrossCount - 1 - j])
    }
    const bg = median(bgSamples)

    // Polarity-free deviation magnitude would double-count noise; use the dominant polarity:
    // the sign of the largest absolute deviation (the bead is the strongest feature in the
    // window by construction).
    let peak = 0
    let peakSigned = 0
    for (let j = 0; j < acrossCount; j++) {
      const dev = profile[j] - bg
      if (Math.abs(dev) > peak) {
        peak = Math.abs(dev)
        peakSigned = dev
      }
    }
    if (peak < MIN_PEAK_DEVIATION) {
      lateralMm[k] = NaN
      invalid++
      continue
    }
    const sign = Math.sign(peakSigned)

    // Thresholded center-of-gravity: first moment of the super-threshold deviation.
    const threshold = CENTROID_THRESHOLD * peak
    let weight = 0
    let moment = 0
    for (let j = 0; j < acrossCount; j++) {
      const w = sign * (profile[j] - bg) - threshold
      if (w <= 0) continue
      weight += w
      moment += w * j
    }
    if (weight <= 0) {
      lateralMm[k] = NaN
      invalid++
      continue
    }
    const centroidPx = -halfWindowPx + (moment / weight) * ACROSS_STEP_PX
    lateralMm[k] = centroidPx / acrossPxPerMm
  }

  if (invalid > MAX_INVALID_FRACTION * count) return null

  // Fill the few invalid samples by linear interpolation between valid neighbours so the
  // downstream fit sees a gapless series (the invalid fraction is bounded above).
  interpolateGaps(lateralMm)

  return {
    speedMmS: line.speedMmS,
    tS,
    lateralMm,
    noiseWindowStart: Math.floor(count * (1 - NOISE_WINDOW_FRACTION)),
  }
}

function interpolateGaps(y: Float64Array): void {
  const n = y.length
  let lastValid = -1
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(y[i])) {
      if (lastValid < i - 1) {
        const left = lastValid >= 0 ? y[lastValid] : y[i]
        for (let j = Math.max(lastValid + 1, 0); j < i; j++) {
          const f = lastValid >= 0 ? (j - lastValid) / (i - lastValid) : 1
          y[j] = left * (1 - f) + y[i] * f
        }
      }
      lastValid = i
    }
  }
  if (lastValid >= 0) for (let i = lastValid + 1; i < n; i++) y[i] = y[lastValid]
}
