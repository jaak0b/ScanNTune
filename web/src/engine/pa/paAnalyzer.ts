import type { Mat, OpenCv } from '../opencv'
import type { PaLineScore, PaResult, PaTestSpec } from './types'
import { couponGeometry, paValueForLine } from './types'
import type { PaProgressCallback } from './types'
import { alignPaCoupon } from './fiducialAligner'
import type { PaAlignment } from './fiducialAligner'
import { assessLineBackdrop, lineGatePositions, measureLineWidthProfile } from './lineMeasurer'
import type { WidthSample } from './lineMeasurer'
import { sampleBgrTriples, selectMeasurementChannel } from '../cvUtils'
import { hampelOutliers, median, mulberry32 } from '../math'
import { evaluateScanSetResolution } from '../resolutionGate'

// Turns an aligned PA coupon scan into a pressure-advance estimate. Each test line is profiled
// with measureLineWidthProfile, its width samples are cleaned with a Hampel identifier (isolated
// scan artifacts such as dust or infill glare reject; NaN gaps pass through as gaps), and the
// line is scored by the RMS width deviation inside +/- 2 mm windows around the two speed
// transitions, relative to the line's steady-state median width outside the windows. The best PA
// is the discrete argmin over lines refined by three-point parabolic vertex interpolation over
// (paValue, score), the same vertex model the sub-pixel edge refinement uses.

const WINDOW_HALF_MM = 2
// Hampel identifier parameters over the 0.25 mm-stepped width series: a +/- 2 mm local window
// (matching the transition-window scale) and a conservative 4-sigma rejection threshold.
const HAMPEL_HALF_WINDOW = 8
const HAMPEL_N_SIGMA = 4

export function scoreLine(
  samples: WidthSample[],
  transitionXsMm: [number, number],
  nominalWidthMm: number,
  rejected?: boolean[],
): { score: number; medianWidthMm: number } {
  const inWindow = (x: number) => transitionXsMm.some((t) => Math.abs(x - t) <= WINDOW_HALF_MM)
  const isRejected = (i: number) => rejected?.[i] === true
  const steady: number[] = []
  for (let i = 0; i < samples.length; i++) {
    if (!inWindow(samples[i].xMm) && Number.isFinite(samples[i].widthMm) && !isRejected(i)) {
      steady.push(samples[i].widthMm)
    }
  }
  const med = median(steady)
  let sum = 0
  let n = 0
  for (let i = 0; i < samples.length; i++) {
    if (!inWindow(samples[i].xMm)) continue
    // A cleaned outlier is a scan artifact, not print evidence: excluded, never a defect.
    if (isRejected(i)) continue
    // A gap (NaN) inside a window is maximal evidence of a defect: count the full nominal width.
    const dev = Number.isFinite(samples[i].widthMm) ? samples[i].widthMm - med : nominalWidthMm
    sum += dev * dev
    n++
  }
  return { score: Math.sqrt(sum / Math.max(n, 1)), medianWidthMm: med }
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
  bootstrapSeed: number = BOOTSTRAP_SEED,
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
  // Measurement-backdrop gate doubling as channel selection: without enough separation between
  // the lines and the base in the measured plane, or with an uneven base tone, the width
  // profiles cannot locate the line edges reliably. Lines whose color differs from the base but
  // matches it in brightness separate in saturation instead of value, and lines matched in both
  // only in the Fisher discriminant plane, so the gate judges all candidate planes and the
  // profiling runs on the one it accepts. The same gate positions feed both the per-candidate
  // tone assessment and the BGR class samples the discriminant is built from.
  const positions = lineGatePositions(alignment, spec)
  const { gray, assessment: backdrop } = selectMeasurementChannel(
    cv,
    image,
    (candidate) => assessLineBackdrop(cv, candidate, positions),
    {
      feature: sampleBgrTriples(image, positions.line),
      backdrop: sampleBgrTriples(image, positions.base),
    },
  )
  const lines: PaLineScore[] = []
  // Per-line cleaned width series, kept for the bulge diagnostic and the bootstrap; index-aligned
  // with `lines`, null where a line was unmeasured.
  const cleaned: ({ samples: WidthSample[]; rejected: boolean[] } | null)[] = []
  try {
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
        cleaned.push(null)
        continue
      }
      const rejected = hampelOutliers(
        samples.map((s) => s.widthMm),
        HAMPEL_HALF_WINDOW,
        HAMPEL_N_SIGMA,
      )
      const { score, medianWidthMm } = scoreLine(samples, g.transitionXsMm, spec.lineWidthMm, rejected)
      lines.push({ index: i, paValue: paValueForLine(spec, i), score, medianWidthMm, measured: true })
      cleaned.push({ samples, rejected })
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
  let sePa: number | null = null
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
    sePa = bootstrapSePa(
      [lo.index, bestLineIndex, hi.index].map((i) => ({
        paValue: lines[i].paValue,
        medianWidthMm: lines[i].medianWidthMm,
        line: cleaned[i]!,
      })),
      g.transitionXsMm,
      spec.lineWidthMm,
      bootstrapSeed,
    )
  }

  const bulges = cleaned.map((c) => (c ? transitionBulge(c.samples, c.rejected, g.transitionXsMm) : NaN))

  return {
    success: true,
    failureReason: null,
    lines,
    bestLineIndex,
    bestPa,
    sweepBracket: classifySweepBracket(bulges),
    sePa,
    measuredPxPerMm: perpPxPerMm,
    flipped: alignment.flipped,
    rotationQuarterTurns: alignment.rotationQuarterTurns,
  }
}

/**
 * Signed median transition bulge of a line: the deceleration-window median width deviation minus
 * the acceleration-window one, both relative to the steady-state median, over the cleaned finite
 * samples. Too-low PA bulges at the deceleration transition (positive), too-high PA starves it
 * (negative), so the sign points at where the optimum lies. NaN when a window or the steady
 * region has no usable samples.
 */
function transitionBulge(
  samples: WidthSample[],
  rejected: boolean[],
  transitionXsMm: [number, number],
): number {
  const usable = (i: number) => Number.isFinite(samples[i].widthMm) && !rejected[i]
  const pick = (t: number) => {
    const v: number[] = []
    for (let i = 0; i < samples.length; i++) {
      if (Math.abs(samples[i].xMm - t) <= WINDOW_HALF_MM && usable(i)) v.push(samples[i].widthMm)
    }
    return v
  }
  const steady: number[] = []
  for (let i = 0; i < samples.length; i++) {
    if (!transitionXsMm.some((t) => Math.abs(samples[i].xMm - t) <= WINDOW_HALF_MM) && usable(i)) {
      steady.push(samples[i].widthMm)
    }
  }
  const [t1, t2] = transitionXsMm
  const w1 = pick(t1)
  const w2 = pick(t2)
  if (w1.length === 0 || w2.length === 0 || steady.length === 0) return NaN
  const sMed = median(steady)
  return (median(w2) - sMed) - (median(w1) - sMed)
}

/**
 * Sign test over the per-line bulges: a bulge column that never changes sign means the sweep did
 * not bracket the optimum (all positive: the true value lies above the range; all negative:
 * below it). Fewer than 3 finite bulges is too little evidence to claim anything but bracketed.
 */
function classifySweepBracket(bulges: number[]): 'bracketed' | 'above-range' | 'below-range' {
  const finite = bulges.filter((b) => Number.isFinite(b) && b !== 0)
  if (finite.length < 3) return 'bracketed'
  if (finite.every((b) => b > 0)) return 'above-range'
  if (finite.every((b) => b < 0)) return 'below-range'
  return 'bracketed'
}

// Nonparametric bootstrap (Efron 1979) of the parabolic vertex: B = 200 replicates, the textbook
// choice for standard-error estimation (Efron and Tibshirani, ch. 6). Per replicate, each bracket
// line's in-window deviations are resampled with replacement (counts preserved, steady medians
// held fixed), the three RMS scores recomputed, and the vertex re-solved; the reported standard
// error is the sample standard deviation of the replicate vertices. Clamped vertices stay in the
// sample: the clamp is part of the estimator being bootstrapped. The RNG seed defaults to a fixed
// value so a given scan reports the same value by default, but is a parameter so tests can vary it.
const BOOTSTRAP_REPLICATES = 200
const BOOTSTRAP_SEED = 1234567

function bootstrapSePa(
  bracket: { paValue: number; medianWidthMm: number; line: { samples: WidthSample[]; rejected: boolean[] } }[],
  transitionXsMm: [number, number],
  nominalWidthMm: number,
  bootstrapSeed: number = BOOTSTRAP_SEED,
): number | null {
  const inWindow = (x: number) => transitionXsMm.some((t) => Math.abs(x - t) <= WINDOW_HALF_MM)
  // Per bracket line, the deviations the RMS score consumes: cleaned in-window samples relative
  // to the (fixed) steady median, a gap counting the full nominal width.
  const devs = bracket.map(({ medianWidthMm, line }) => {
    const d: number[] = []
    for (let i = 0; i < line.samples.length; i++) {
      if (!inWindow(line.samples[i].xMm) || line.rejected[i]) continue
      d.push(
        Number.isFinite(line.samples[i].widthMm)
          ? line.samples[i].widthMm - medianWidthMm
          : nominalWidthMm,
      )
    }
    return d
  })
  if (devs.some((d) => d.length === 0)) return null

  const rand = mulberry32(bootstrapSeed)
  const vertices: number[] = []
  for (let b = 0; b < BOOTSTRAP_REPLICATES; b++) {
    const scores = devs.map((d) => {
      let sum = 0
      for (let i = 0; i < d.length; i++) {
        const v = d[Math.floor(rand() * d.length)]
        sum += v * v
      }
      return Math.sqrt(sum / d.length)
    })
    vertices.push(
      parabolicMinimum(
        bracket[0].paValue,
        scores[0],
        bracket[1].paValue,
        scores[1],
        bracket[2].paValue,
        scores[2],
      ),
    )
  }
  const mean = vertices.reduce((a, v) => a + v, 0) / vertices.length
  const variance = vertices.reduce((a, v) => a + (v - mean) ** 2, 0) / (vertices.length - 1)
  return Math.sqrt(variance)
}

function failure(reason: string): PaResult {
  return {
    success: false,
    failureReason: reason,
    lines: [],
    bestLineIndex: null,
    bestPa: null,
    sweepBracket: null,
    sePa: null,
    measuredPxPerMm: null,
    flipped: false,
    rotationQuarterTurns: 0,
  }
}
