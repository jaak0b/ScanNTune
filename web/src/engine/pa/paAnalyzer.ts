import type { Mat, OpenCv } from '../opencv'
import type { PaLineScore, PaResult, PaTestSpec } from './types'
import { couponGeometry, paValueForLine } from './types'
import type { PaProgressCallback } from './types'
import { alignPaCoupon } from './fiducialAligner'
import type { PaAlignment } from './fiducialAligner'
import { assessLineBackdrop, measureLineWidthProfile } from './lineMeasurer'
import type { WidthSample } from './lineMeasurer'
import { valueChannel } from '../cvUtils'
import { median } from '../math'
import { evaluateScanSetResolution } from '../resolutionGate'

// Turns an aligned PA coupon scan into a pressure-advance estimate. Each test line is profiled
// with measureLineWidthProfile and scored by the RMS width deviation inside +/- 2 mm windows
// around the two speed transitions, relative to the line's steady-state median width outside the
// windows. The best PA is the discrete argmin over lines refined by three-point parabolic vertex
// interpolation over (paValue, score), the same vertex model the sub-pixel edge refinement uses.

const WINDOW_HALF_MM = 2

export function scoreLine(
  samples: WidthSample[],
  transitionXsMm: [number, number],
  nominalWidthMm: number,
): { score: number; medianWidthMm: number } {
  const inWindow = (x: number) => transitionXsMm.some((t) => Math.abs(x - t) <= WINDOW_HALF_MM)
  const steady = samples.filter((s) => !inWindow(s.xMm) && Number.isFinite(s.widthMm))
  const med = median(steady.map((s) => s.widthMm))
  const windowSamples = samples.filter((s) => inWindow(s.xMm))
  let sum = 0
  for (const s of windowSamples) {
    // A gap (NaN) inside a window is maximal evidence of a defect: count the full nominal width.
    const dev = Number.isFinite(s.widthMm) ? s.widthMm - med : nominalWidthMm
    sum += dev * dev
  }
  return { score: Math.sqrt(sum / Math.max(windowSamples.length, 1)), medianWidthMm: med }
}

/**
 * Three-point parabolic vertex fit (Lagrange form), clamped to the [x0, x2] bracket. Returns the
 * middle x when the points are collinear, coincident, or the parabola opens downward.
 */
export function parabolicMinimum(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const denom = (x0 - x1) * (x0 - x2) * (x1 - x2)
  if (Math.abs(denom) < 1e-12) return x1
  const a = (x2 * (y1 - y0) + x1 * (y0 - y2) + x0 * (y2 - y1)) / denom
  const b = (x2 * x2 * (y0 - y1) + x1 * x1 * (y2 - y0) + x0 * x0 * (y1 - y2)) / denom
  if (a <= 0) return x1
  const v = -b / (2 * a)
  return Math.min(Math.max(v, Math.min(x0, x2)), Math.max(x0, x2))
}

/**
 * Analyzes a PA coupon scan. `alignmentHolder`, when given, receives the solved fiducial alignment
 * (successful or not) so callers such as the overlay renderer can place coupon-frame geometry in
 * scan pixels without re-running the aligner.
 */
export function analyzePaCoupon(
  cv: OpenCv,
  image: Mat,
  spec: PaTestSpec,
  alignmentHolder?: { alignment?: PaAlignment },
  onProgress?: PaProgressCallback,
): PaResult {
  if (!image || image.empty()) throw new Error('Image is null or empty.')

  onProgress?.({ stage: 'align' })
  const alignment = alignPaCoupon(cv, image, spec)
  if (alignmentHolder) alignmentHolder.alignment = alignment
  if (!alignment.success) {
    return failure(alignment.failureReason ?? 'The coupon could not be aligned.')
  }

  // The local scale along the width-profile direction prices the scan's resolution; a scan too
  // coarse for the sub-pixel width readout is refused before any numbers come out of it.
  const perpPxPerMm = Math.hypot(alignment.b, alignment.d)
  const [resolution] = evaluateScanSetResolution([{ pxPerMm: perpPxPerMm }])
  if (!resolution.ok) {
    return {
      ...failure(resolution.reason!),
      measuredPxPerMm: perpPxPerMm,
      flipped: alignment.flipped,
      rotationQuarterTurns: alignment.rotationQuarterTurns,
    }
  }

  const g = couponGeometry(spec)
  const gray = valueChannel(cv, image)
  const lines: PaLineScore[] = []
  try {
    // Measurement-backdrop gate: without enough brightness separation between the lines and the
    // base, or with an uneven base tone, the width profiles cannot locate the line edges reliably.
    const backdrop = assessLineBackdrop(cv, gray, alignment, spec)
    if (backdrop.failure) {
      return {
        ...failure(
          backdrop.failure === 'low-contrast'
            ? 'The test lines are too similar in brightness to the base. Print the lines in a filament that contrasts more with the base.'
            : 'The base behind the test lines is too uneven in brightness to measure against. Print the base in a single plain filament and rescan.',
        ),
        measuredPxPerMm: perpPxPerMm,
        flipped: alignment.flipped,
        rotationQuarterTurns: alignment.rotationQuarterTurns,
      }
    }
    for (let i = 0; i < spec.lineCount; i++) {
      onProgress?.({ stage: 'measure', line: i, lineCount: spec.lineCount })
      const samples = measureLineWidthProfile(cv, gray, alignment, spec, i)
      const nanCount = samples.filter((s) => !Number.isFinite(s.widthMm)).length
      if (samples.length === 0 || nanCount > samples.length / 2) {
        lines.push({
          index: i,
          paValue: paValueForLine(spec, i),
          score: Infinity,
          medianWidthMm: NaN,
          measured: false,
        })
        continue
      }
      const { score, medianWidthMm } = scoreLine(samples, g.transitionXsMm, spec.lineWidthMm)
      lines.push({ index: i, paValue: paValueForLine(spec, i), score, medianWidthMm, measured: true })
    }
  } finally {
    gray.delete()
  }

  onProgress?.({ stage: 'score' })
  const measured = lines.filter((l) => l.measured)
  if (measured.length < 3) {
    return {
      ...failure('Too few readable lines were found on the coupon to estimate pressure advance.'),
      lines,
      measuredPxPerMm: perpPxPerMm,
      flipped: alignment.flipped,
      rotationQuarterTurns: alignment.rotationQuarterTurns,
    }
  }

  let bestLineIndex = measured[0].index
  for (const l of measured) if (l.score < lines[bestLineIndex].score) bestLineIndex = l.index

  // At a sweep edge (or next to an unmeasured neighbour) there is no bracket to interpolate in;
  // report the discrete value. The UI can detect the edge case via bestLineIndex itself.
  let bestPa = lines[bestLineIndex].paValue
  const lo = lines[bestLineIndex - 1]
  const hi = lines[bestLineIndex + 1]
  if (lo?.measured && hi?.measured) {
    bestPa = parabolicMinimum(
      lo.paValue,
      lo.score,
      lines[bestLineIndex].paValue,
      lines[bestLineIndex].score,
      hi.paValue,
      hi.score,
    )
  }

  return {
    success: true,
    failureReason: null,
    lines,
    bestLineIndex,
    bestPa,
    measuredPxPerMm: perpPxPerMm,
    flipped: alignment.flipped,
    rotationQuarterTurns: alignment.rotationQuarterTurns,
  }
}

function failure(reason: string): PaResult {
  return {
    success: false,
    failureReason: reason,
    lines: [],
    bestLineIndex: null,
    bestPa: null,
    measuredPxPerMm: null,
    flipped: false,
    rotationQuarterTurns: 0,
  }
}
