import type { TracedLine } from './lineTracer'
import type { CheckState, SpeedCheck, TierCheck } from './resultTypes'
import {
  DETECTION_ALPHA,
  F_MAX_HZ,
  F_MIN_HZ,
  MAX_CI95_REL,
  MIN_ACCEPTED_LINES,
} from './types'
import {
  DETECTION_GRID,
  DRIFT_CUTOFF_HZ,
  FREQUENCY_GRID_HZ,
  ZETA_MAX,
  driftBasis,
} from './ringRegressors'
import {
  fitNoise,
  levenbergMarquardt,
  noiseModel,
  lineBasis,
  minimizeOverLogTau,
  nullDesign,
  olsNull,
  parameterVariances,
  projectRing,
  rawFullResidual,
  ringScratch,
} from './ringGls'
import type { LineBasis, LineNoise, LineRecord, LmResult, NullDesign } from './ringGls'
import { defaultMaxArOrder } from '../correlatedNoise'
import type { ArFit } from '../correlatedNoise'
import { MAD_TO_SIGMA, chiSquareSurvival, chiSquareSurvivalEvenDof, mad, median, normalQuantile } from '../math'

// Detects and measures the ringing of one machine axis from its traced lines. The resonance is
// one machine property shared by every line, so the lines share the nonlinear parameters while
// each keeps its own linear terms. Every decision is a hypothesis test at the flow's false-alarm
// level DETECTION_ALPHA; no amplitude threshold, fit-quality gate or damping floor decides
// anything. The stages, each an established method:
//
// 1. Fit window: the free ringdown, from the first zero crossing after the forced corner
//    overshoot (found on the ISO 16610-21 Gaussian-detrended trace), never before the earliest
//    exactly timed sample. Only samples the tracer actually read enter the statistics; the
//    tracer's gap fill serves the window search alone.
// 2. Model per line (ringGls.ts): a discrete cosine drift basis below DRIFT_CUTOFF_HZ (the SPM
//    regression high-pass; Friston et al. 2007), which by Frisch-Waugh-Lovell acts as one linear
//    prefilter applied identically to the data and every column; the first-order flow lag of the
//    commanded flow, its particular solution and its homogeneous term for the flow state at the
//    corner (one time constant tau shared per axis, chosen by golden-section search on log tau;
//    Kiefer 1953); the damped quadrature ring pair; and AR(p) noise on the sample lattice.
// 3. Noise: per line AR(p) by Burg's method over the runs of read samples (Burg 1975; de Waele
//    and Broersen 2000), order by AICc (Hurvich and Tsai 1989) up to floor(10 log10 n), and the
//    exact innovations whitening of data and every column with missing observations handled by
//    the Kalman filter of the AR state space (Jones 1980): two-step feasible GLS (Aitken 1935;
//    Cochrane and Orcutt 1949).
// 4. Detection field: D_l(theta), the whitened SSR reduction from adding the two ring columns to
//    line l's null design (Frisch-Waugh-Lovell), chi2_2 under H0 for fixed theta; Q = sum_l D_l
//    is chi2_2K. The look-elsewhere effect over the grid G (FREQUENCY_GRID_HZ x ZETA_GRID,
//    |G| = 1,703) is paid by the Bonferroni bound pBound = min(1, |G| P(chi2_2K >= max_G Q))
//    (Dunn 1961). The noise model of this test is the one fitted under the null, so its size is
//    exact (see DetectionNoise for the calibration that chose it). Per-line labels use the same
//    bound on max_G D_l; after a detection they, and the tier tests, use the noise model refitted
//    to the full-fit residuals, because the null fit models a long-lived ring partly as noise.
// 5. Estimation: seed at argmax_G Q, then generalized least squares variable projection (Golub
//    and Pereyra 1973) over (f, zeta, log tau), polished by Levenberg-Marquardt (Levenberg 1944;
//    Marquardt 1963), with the noise model refitted to the full-fit residuals (the second
//    feasible GLS step); covariance sigma^2 (J'J)^-1 on the whitened stacked Jacobian (Seber and
//    Wild 1989); zeta is bounded to [0, ZETA_MAX].
// 6. Checks, each at DETECTION_ALPHA:
//    - Input proportionality (output-error model, Ljung 1999): the ring is the linear response
//      to the corner's velocity step, so each line's complex ring amplitude is its rung's corner
//      speed times one complex scale per speed tier. Nested likelihood-ratio test against free
//      per-line amplitudes; a forced tone (rung-independent amplitude, random phase) fails it.
//    - Speed check with two tiers: each tier is tested on its own lines only on a local grid
//      around the axis estimate and its arc-length artifact images f rho^(+/-1) (closed testing,
//      Marcus, Peritz and Gabriel 1976), then fitted on its own; d = ln(f_slow / f_fast) with the
//      delta-method standard error. Confirmed when the artifact hypothesis d = -ln rho is
//      rejected one-sided and d = 0 is not rejected two-sided; changed with speed when d = 0 is
//      rejected; otherwise not confirmed.
//    - One tier: leave-one-line-out influence check of the detection (Cook 1977).
//    - Replicate check: Cochran's Q homogeneity test (Cochran 1954) on the inverse-variance
//      weighted per-line frequencies of the detected lines.
//    - Damping diagnostic: boundary likelihood-ratio test of zeta = 0 (Self and Liang 1987),
//      null law 0.5 chi2_0 + 0.5 chi2_1, reported, never a gate.
// 7. Screening and guards: a Hampel identifier on the per-line frequencies of the detected lines,
//    the band-edge and damping-bound guards, at least MIN_ACCEPTED_LINES lines, and the
//    MAX_CI95_REL confidence gate.

export { F_MIN_HZ, F_MAX_HZ, MIN_ACCEPTED_LINES } from './types'
export { DETECTION_GRID, ZETA_GRID, ZETA_MAX } from './ringRegressors'

/**
 * At-bounds margin: two grid steps. A true resonance just outside the search range is found at
 * the range edge and the refinement follows it back to the boundary region, so anything within
 * two grid steps of an edge is treated as "at the bound" rather than a trustworthy optimum.
 */
export const BOUND_MARGIN_HZ = 2 * FREQUENCY_GRID_HZ
/**
 * Outlier-screen floor: the larger of 2 Hz and 5% of the median frequency. Klipper-style input
 * shapers keep their vibration suppression within roughly +/-5-10% of the target frequency, so
 * lines inside that band are replicates by definition, never outliers.
 */
const AGREEMENT_REL = 0.05
const AGREEMENT_MIN_HZ = 2
/** z_(1-alpha): one-sided critical value at the detection level. */
const Z_ONE_SIDED = normalQuantile(1 - DETECTION_ALPHA)
/** z_(1-alpha/2): two-sided critical value at the detection level. */
const Z_TWO_SIDED = normalQuantile(1 - DETECTION_ALPHA / 2)
/** Critical value of the zeta = 0 boundary LRT: P(0.5 chi2_0 + 0.5 chi2_1 > c) = alpha gives
 *  c = z_(1-alpha)^2 (9.5495 at alpha 0.001). */
const DECAY_CRITICAL = Z_ONE_SIDED * Z_ONE_SIDED

/**
 * Why a traced line could not enter the analysis on its own, as a category: 'irregular-trace' is
 * a trace without a free ringdown, 'out-of-band' a detected ring at the edge of the frequency
 * search range.
 */
export type LineFitRefusalCategory = 'irregular-trace' | 'out-of-band'

/** Why a line was excluded from the joint fit. */
export type LineJointExclusion = 'no-free-response' | 'out-of-band' | 'zeta-at-bound' | 'frequency-outlier'

/** One traced line prepared for the axis analysis: its fit window, or why it has none. */
export interface LineFit {
  screening: 'windowed' | 'no-free-response'
  refusalReason: string | null
  refusalCategory: LineFitRefusalCategory | null
  window: LineRecord | null
  /** Median lateral deviation of the line's read samples from the nominal centerline, mm; null
   *  when the tracer read none. */
  offsetMm: number | null
}

/** The analysis's verdict on one line, aligned with poolAxisFits's fits argument. */
export interface LineVerdict {
  usedInJointFit: boolean
  exclusion: LineJointExclusion | null
  /** True when the ring is detected on this line alone (its pBound at DETECTION_ALPHA). */
  detected: boolean
  /** Bonferroni bound of the line's own detection statistic; null without a fit window. */
  detectionPBound: number | null
  /** The line's own fitted frequency, Hz; null for a line without a detected ring. */
  frequencyHz: number | null
  /** Joint-fit ring amplitude at the line's fit-window start, mm; null outside the joint fit. */
  amplitudeMm: number | null
}

export interface AxisPool {
  accepted: boolean
  /** The axis-level verdict of a refused axis; empty when accepted. */
  refusals: string[]
  /**
   * The generic rescan remedy that goes with a refusal, kept apart from the verdict so a remedy
   * specific to the coupon can replace it; null when the refusal carries none.
   */
  rescanAdvice: string | null
  frequencyHz: number | null
  dampingRatio: number | null
  /** 95% confidence halfwidth of the jointly fitted frequency, Hz (statistical error only). */
  frequencyCi95Hz: number | null
  frequencySeHz: number | null
  /** Median joint-fit ring amplitude at the fit-window start over the joint-fit lines, mm. */
  amplitudeMm: number | null
  /** Bonferroni bound of the axis detection; null when no line had a fit window. */
  detectionPBound: number | null
  linesDetected: number
  linesUsed: number
  /** Boundary LRT of zeta = 0 rejected; null when the axis was not fitted. */
  decayDemonstrated: boolean | null
  /** Input-proportionality test: passed when the ring grows with the corner speed. */
  proportionality: CheckState
  speedCheck: SpeedCheck
  replicateCheck: CheckState
  /** One-tier leave-one-line-out influence check of the detection. */
  influenceCheck: CheckState
  lines: LineVerdict[]
}

/**
 * Which residual the axis detection's noise model is fitted to: 'null' fits the AR to the
 * null-model residuals (the nuisance estimated under H0, as in a score test); 'full' fits it to
 * the residuals of a per-line ordinary least squares full fit at the line's own best grid point
 * (the two-step feasible GLS of the design); 'axis' refits it once after removing the ring of the
 * null field's pooled maximum from every line. Removing any in-band component lowers the AR's
 * estimate of the noise across the whole ring band, which on the tracer's half-pixel lattice lies
 * inside one AR resolution cell, so 'full' and 'axis' inflate the field under H0: the pBound
 * calibration in tests/stats measured them far above alpha on correlated scan noise and 'null'
 * within it, so 'null' is the production choice. The others stay selectable for that
 * calibration.
 */
export type DetectionNoise = 'null' | 'full' | 'axis'
export const DEFAULT_DETECTION_NOISE: DetectionNoise = 'null'

export interface PoolOptions {
  detectionNoise?: DetectionNoise
}

/**
 * Gaussian regression filter trend (ISO 16610-21 style, zeroth order): a Gaussian-weighted
 * moving average with per-sample weight normalization (the regression form, which keeps the
 * trend unbiased at the profile ends). `cutoffS` is the period at which the trend's transmission
 * is 50%; alpha = sqrt(ln 2 / pi) per the standard. Used to locate the free ringdown only.
 */
export function gaussianTrend(tS: Float64Array, y: Float64Array, cutoffS: number): Float64Array {
  const n = y.length
  const alpha = Math.sqrt(Math.log(2) / Math.PI)
  const denom = alpha * cutoffS
  const trend = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let w = 0
    let s = 0
    for (let j = 0; j < n; j++) {
      const u = (tS[j] - tS[i]) / denom
      const wk = Math.exp(-Math.PI * u * u)
      w += wk
      s += wk * y[j]
    }
    trend[i] = s / w
  }
  return trend
}

/**
 * Fit-window start: the free ringdown begins at the first zero crossing after the forced
 * corner-overshoot peak (the largest excursion of the early trace). Null when the trace never
 * crosses zero in its first half, i.e. there is no free response to fit.
 */
function freeResponseStart(y: Float64Array): number | null {
  const n = y.length
  const peakSearchEnd = Math.floor(n / 4)
  if (peakSearchEnd < 1) return null
  let peak = 0
  let peakAbs = -1
  for (let i = 0; i < peakSearchEnd; i++) {
    const a = Math.abs(y[i])
    if (a > peakAbs) {
      peakAbs = a
      peak = i
    }
  }
  for (let i = peak + 1; i < Math.floor(n / 2); i++) {
    if (y[i] * y[peak] < 0) return i
  }
  return null
}

const NO_FREE_RESPONSE_REASON =
  'The trace never settles from the corner transient into a free ringdown, so there is no ' +
  'resonance to fit. The trace may be corrupted by print defects or scan artifacts.'

/**
 * Prepares one traced line: its free-ringdown fit window over the samples the tracer read, and
 * its lateral offset. A line without a window is reported, not fitted.
 */
export function analyzeTracedLine(line: TracedLine): LineFit {
  const n = line.tS.length
  // The offset is read over the second half of the trace, where the corner's forced response
  // and most of the ring have decayed, so it does not grow with the rung.
  const read: number[] = []
  for (let k = Math.floor(n / 2); k < n; k++) if (line.observed[k]) read.push(line.lateralMm[k])
  const offsetMm = read.length > 0 ? median(read) : null
  const refuse = (): LineFit => ({
    screening: 'no-free-response',
    refusalReason: NO_FREE_RESPONSE_REASON,
    refusalCategory: 'irregular-trace',
    window: null,
    offsetMm,
  })

  const trend = gaussianTrend(line.tS, line.lateralMm, 1 / DRIFT_CUTOFF_HZ)
  const detrended = new Float64Array(n)
  for (let i = 0; i < n; i++) detrended[i] = line.lateralMm[i] - trend[i]
  const freeStart = freeResponseStart(detrended)
  const timedStart = line.tS.findIndex((t) => t >= line.fitStartMinS)
  if (freeStart === null || timedStart < 0) return refuse()
  const start = Math.max(freeStart, timedStart)

  const lattice: number[] = []
  for (let k = start; k < n; k++) if (line.observed[k]) lattice.push(k)
  const m = lattice.length
  if (m < 2) return refuse()
  const tS = Float64Array.from(lattice, (k) => line.tS[k])
  // The window must leave residual degrees of freedom after the null and ring columns and the
  // largest AR order the noise model may take.
  const columns = driftBasis(tS).length + 4
  if (m - columns - defaultMaxArOrder(m) - 2 <= 0) return refuse()
  return {
    screening: 'windowed',
    refusalReason: null,
    refusalCategory: null,
    window: {
      tS,
      lattice: Int32Array.from(lattice),
      y: Float64Array.from(lattice, (k) => line.lateralMm[k]),
      speedMmS: line.speedMmS,
      cornerSpeedMmS: line.cornerSpeedMmS,
      accelMmS2: line.accelMmS2,
    },
    offsetMm,
  }
}

/** One line's prepared model inside poolAxisFits. */
interface LineState {
  basis: LineBasis
  noise0: LineNoise
  design0: NullDesign
  /** D_l over DETECTION_GRID. */
  field: Float64Array
}

/** The white unit-variance noise model: its whitener is the identity, so the GLS stages reduce
 *  to ordinary least squares. */
const WHITE_UNIT: ArFit = { coefficients: [], noiseVariance: 1 }

/** The null designs at the GLS-optimal tau and the detection fields of lines with given noise. */
function detectionStates(
  bases: LineBasis[],
  noises: LineNoise[],
  tauBounds: [number, number],
): { states: LineState[]; tau: number } {
  const tau = minimizeOverLogTau(
    (t) => bases.reduce((s, b, l) => s + nullDesign(b, noises[l], t).ssr, 0),
    tauBounds[0],
    tauBounds[1],
  )
  const states = bases.map((b, l) => {
    const design0 = nullDesign(b, noises[l], tau)
    return { basis: b, noise0: noises[l], design0, field: detectionField(b, noises[l], design0) }
  })
  return { states, tau }
}

/** D_l over DETECTION_GRID. */
function detectionField(basis: LineBasis, noise: LineNoise, design: NullDesign): Float64Array {
  const field = new Float64Array(DETECTION_GRID.length)
  const scratch = ringScratch(basis.m)
  const pr = new Float64Array(design.k)
  const pi = new Float64Array(design.k)
  for (let g = 0; g < DETECTION_GRID.length; g++) {
    const point = DETECTION_GRID[g]
    field[g] = projectRing(basis, noise, design, point.frequencyHz, point.dampingRatio, scratch, pr, pi).D
  }
  return field
}

/** Index and value of the maximum of sum over `lines` of their fields, over `points`. */
function fieldMaximum(
  states: LineState[],
  lines: number[],
  points: ArrayLike<number> | null = null,
): { index: number; value: number } {
  let best = -1
  let bestValue = -Infinity
  const count = points ? points.length : DETECTION_GRID.length
  for (let q = 0; q < count; q++) {
    const g = points ? points[q] : q
    let s = 0
    for (const l of lines) s += states[l].field[g]
    if (s > bestValue) {
      bestValue = s
      best = g
    }
  }
  return { index: best, value: bestValue }
}

/** Bonferroni bound of a maximum of chi2_dof statistics over `count` grid points. */
function bonferroni(count: number, maximum: number, dof: number): number {
  return Math.min(1, count * chiSquareSurvivalEvenDof(Math.max(0, maximum), dof))
}

/** The axis estimate from a set of lines' noise models: nonlinear parameters and per-line fits. */
interface JointFit {
  lm: LmResult
  frequencyHz: number
  dampingRatio: number
  tauS: number
  sigma2: number
  dof: number
}

/** The stacked projected residual of `lines` at (f, zeta, tau), null designs rebuilt per tau. */
function stackedResidual(
  bases: LineBasis[],
  noises: LineNoise[],
  frequencyHz: number,
  dampingRatio: number,
  tauS: number,
  designCache: Map<number, NullDesign[]>,
): Float64Array {
  let designs = designCache.get(tauS)
  if (!designs) {
    designs = bases.map((b, i) => nullDesign(b, noises[i], tauS))
    if (designCache.size > 64) designCache.clear()
    designCache.set(tauS, designs)
  }
  const total = bases.reduce((s, b) => s + b.m, 0)
  const out = new Float64Array(total)
  let at = 0
  bases.forEach((b, i) => {
    const r = new Float64Array(b.m)
    const d = designs![i]
    projectRing(b, noises[i], d, frequencyHz, dampingRatio, ringScratch(b.m), new Float64Array(d.k), new Float64Array(d.k), r)
    out.set(r, at)
    at += b.m
  })
  return out
}

/**
 * Variable projection fit over the free parameters among (f, zeta, log tau); `fixed` pins the
 * others. Parameters: index 0 frequency, 1 damping ratio, 2 log tau.
 */
function varproFit(
  bases: LineBasis[],
  noises: LineNoise[],
  start: number[],
  free: boolean[],
  tauBounds: [number, number],
): JointFit {
  const lower = [F_MIN_HZ, 0, Math.log(tauBounds[0])]
  const upper = [F_MAX_HZ, ZETA_MAX, Math.log(tauBounds[1])]
  const freeIdx = free.map((f, i) => (f ? i : -1)).filter((i) => i >= 0)
  const full = (sub: number[]) => {
    const t = start.slice()
    freeIdx.forEach((j, k) => (t[j] = sub[k]))
    return t
  }
  const cache = new Map<number, NullDesign[]>()
  const residual = (sub: number[]) => {
    const t = full(sub)
    return stackedResidual(bases, noises, t[0], t[1], Math.exp(t[2]), cache)
  }
  const lm = levenbergMarquardt(
    freeIdx.map((j) => start[j]),
    freeIdx.map((j) => lower[j]),
    freeIdx.map((j) => upper[j]),
    residual,
  )
  const theta = full(lm.theta)
  const n = bases.reduce((s, b) => s + b.m, 0)
  const designs = cache.get(Math.exp(theta[2])) ?? bases.map((b, i) => nullDesign(b, noises[i], Math.exp(theta[2])))
  const linear = designs.reduce((s, d) => s + d.k + 2, 0)
  const dof = n - linear - freeIdx.length
  return {
    lm,
    frequencyHz: theta[0],
    dampingRatio: theta[1],
    tauS: Math.exp(theta[2]),
    sigma2: dof > 0 ? lm.ssr / dof : NaN,
    dof,
  }
}

/** Standard error of the frequency of a varpro fit whose first free parameter is f. */
function frequencySe(fit: JointFit): number | null {
  if (!(fit.dof > 0)) return null
  const v = parameterVariances(fit.lm, fit.sigma2)
  if (v === null || v[0] === null || !(v[0]! > 0) || !Number.isFinite(v[0]!)) return null
  return Math.sqrt(v[0]!)
}

const NOT_ASSESSED_SPEED: SpeedCheck = { state: 'not-assessed', tiers: [] }

/**
 * The axis estimate: detection over the whole grid, per-line labels and screening, the joint
 * variable projection fit, and the checks that decide whether the estimate is ringing of the
 * machine. `speedsMmS` are the coupon's speed tiers; each line's own speed and corner speed come
 * with its record.
 */
export function poolAxisFits(
  fits: LineFit[],
  speedsMmS: number[],
  options: PoolOptions = {},
): AxisPool {
  const detectionNoise = options.detectionNoise ?? DEFAULT_DETECTION_NOISE
  const verdicts: LineVerdict[] = fits.map((f) => ({
    usedInJointFit: false,
    exclusion: f.window ? null : 'no-free-response',
    detected: false,
    detectionPBound: null,
    frequencyHz: null,
    amplitudeMm: null,
  }))
  const windowed = fits.map((f, i) => (f.window ? i : -1)).filter((i) => i >= 0)
  const base: AxisPool = {
    accepted: false,
    refusals: [],
    rescanAdvice: null,
    frequencyHz: null,
    dampingRatio: null,
    frequencyCi95Hz: null,
    frequencySeHz: null,
    amplitudeMm: null,
    detectionPBound: null,
    linesDetected: 0,
    linesUsed: 0,
    decayDemonstrated: null,
    proportionality: 'not-assessed',
    speedCheck: NOT_ASSESSED_SPEED,
    replicateCheck: 'not-assessed',
    influenceCheck: 'not-assessed',
    lines: verdicts,
  }
  const refuse = (reason: string, extras: Partial<AxisPool> = {}): AxisPool => ({
    ...base,
    ...extras,
    refusals: [reason],
  })
  const tooFewLines = (count: number, outOfBand: number, excluded: number): AxisPool => {
    const verdict =
      `Only ${count} of the axis's lines produced a usable ringing trace (at least ` +
      `${MIN_ACCEPTED_LINES} are needed for a trustworthy estimate).`
    if (outOfBand * 2 > excluded) {
      return refuse(`${verdict} The true resonance likely lies outside the measurable range.`)
    }
    return refuse(verdict, {
      rescanAdvice:
        "When most lines of a scan are refused, the scanner's lamp shadow is often falling " +
        'across the measured edges; rescan with the coupon rotated a half turn on the glass.',
    })
  }
  if (windowed.length < MIN_ACCEPTED_LINES) {
    return tooFewLines(windowed.length, 0, fits.length - windowed.length)
  }

  // Detection stage: tau and the noise models under the null, then the field.
  const bases = windowed.map((i) => lineBasis(fits[i].window!))
  const tauMin = Math.min(...bases.map((b) => b.rec.tS[1] - b.rec.tS[0]))
  const tauMax = Math.max(...bases.map((b) => b.rec.tS[b.m - 1] - b.rec.tS[0]))
  const tauBounds: [number, number] = [tauMin, tauMax]
  const tauOls = minimizeOverLogTau(
    (tau) => bases.reduce((s, b) => s + olsNull(b, tau).ssr, 0),
    tauMin,
    tauMax,
  )
  let detection = detectionStates(
    bases,
    bases.map((b) =>
      detectionNoise === 'full'
        ? fitNoise(b, olsFullResidualAtArgmax(b, tauOls))
        : fitNoise(b, olsNull(b, tauOls).residual),
    ),
    tauBounds,
  )
  const all = bases.map((_, l) => l)
  if (detectionNoise === 'axis') {
    // One Cochrane-Orcutt step at the axis's single best candidate: the ring of the null
    // field's pooled maximum is removed from every line by GLS, the noise is refitted to what
    // remains, and the field is computed again with that noise.
    const star = DETECTION_GRID[fieldMaximum(detection.states, all).index]
    detection = detectionStates(
      bases,
      detection.states.map((st) => {
        const ring = projectRing(st.basis, st.noise0, st.design0, star.frequencyHz, star.dampingRatio, ringScratch(st.basis.m), new Float64Array(st.design0.k), new Float64Array(st.design0.k))
        return fitNoise(st.basis, rawFullResidual(st.basis, st.noise0, st.design0, star.frequencyHz, star.dampingRatio, ring, ringScratch(st.basis.m)))
      }),
      tauBounds,
    )
  }
  const { states, tau: tau0 } = detection
  const G = DETECTION_GRID.length
  const axisMax = fieldMaximum(states, all)
  const pBound = bonferroni(G, axisMax.value, 2 * states.length)
  states.forEach((s, l) => {
    let top = 0
    for (let g = 0; g < G; g++) top = Math.max(top, s.field[g])
    const v = verdicts[windowed[l]]
    v.detectionPBound = bonferroni(G, top, 2)
    v.detected = v.detectionPBound <= DETECTION_ALPHA
  })
  const linesDetected = verdicts.filter((v) => v.detected).length
  base.detectionPBound = pBound
  base.linesDetected = linesDetected
  if (!(pBound <= DETECTION_ALPHA)) {
    return refuse(
      'No ringing was found on this axis. Across all its lines, the traces match drift and ' +
        'scan noise.',
      {
        rescanAdvice:
          'Rescan with the coupon rotated a half turn on the glass, since lamp shadow can ' +
          'weaken the traced ringing.',
      },
    )
  }

  // Per-line fits of the detected lines (null noise model, the axis tau), for screening.
  const lineFits = new Map<number, JointFit>()
  states.forEach((s, l) => {
    if (!verdicts[windowed[l]].detected) return
    const own = fieldMaximum(states, [l])
    const seed = DETECTION_GRID[own.index]
    lineFits.set(
      l,
      varproFit([s.basis], [s.noise0], [seed.frequencyHz, seed.dampingRatio, Math.log(tau0)], [true, true, false], tauBounds),
    )
  })
  lineFits.forEach((fit, l) => {
    const v = verdicts[windowed[l]]
    v.frequencyHz = fit.frequencyHz
    if (fit.frequencyHz <= F_MIN_HZ + BOUND_MARGIN_HZ || fit.frequencyHz >= F_MAX_HZ - BOUND_MARGIN_HZ) {
      v.exclusion = 'out-of-band'
    } else if (fit.dampingRatio >= ZETA_MAX) {
      v.exclusion = 'zeta-at-bound'
    }
  })
  // Hampel identifier (median/MAD, 3 robust sigmas, floored at the shaper's agreement band)
  // over the per-line frequencies of the detected lines still in.
  const screened = [...lineFits.keys()].filter((l) => verdicts[windowed[l]].exclusion === null)
  if (screened.length >= 3) {
    const freqs = screened.map((l) => lineFits.get(l)!.frequencyHz)
    const center = median(freqs)
    const threshold = Math.max(3 * MAD_TO_SIGMA * mad(freqs), AGREEMENT_MIN_HZ, AGREEMENT_REL * center)
    screened.forEach((l, k) => {
      if (Math.abs(freqs[k] - center) > threshold) verdicts[windowed[l]].exclusion = 'frequency-outlier'
    })
  }
  const included = all.filter((l) => verdicts[windowed[l]].exclusion === null)
  if (included.length < MIN_ACCEPTED_LINES) {
    const excluded = verdicts.filter((v) => v.exclusion !== null)
    return tooFewLines(
      included.length,
      excluded.filter((v) => v.exclusion === 'out-of-band').length,
      excluded.length,
    )
  }
  for (const l of included) verdicts[windowed[l]].usedInJointFit = true
  base.linesUsed = included.length

  // Joint variable projection, then the second feasible GLS step with the noise refitted to the
  // full-fit residuals.
  const inBases = included.map((l) => states[l].basis)
  const seed = DETECTION_GRID[fieldMaximum(states, included).index]
  const first = varproFit(
    inBases,
    included.map((l) => states[l].noise0),
    [seed.frequencyHz, seed.dampingRatio, Math.log(tau0)],
    [true, true, true],
    tauBounds,
  )
  const noise1 = included.map((l) => {
    const s = states[l]
    const design = nullDesign(s.basis, s.noise0, first.tauS)
    const ring = projectRing(s.basis, s.noise0, design, first.frequencyHz, first.dampingRatio, ringScratch(s.basis.m), new Float64Array(design.k), new Float64Array(design.k))
    return fitNoise(s.basis, rawFullResidual(s.basis, s.noise0, design, first.frequencyHz, first.dampingRatio, ring, ringScratch(s.basis.m)))
  })
  const joint = varproFit(
    inBases,
    noise1,
    [first.frequencyHz, first.dampingRatio, Math.log(first.tauS)],
    [true, true, true],
    tauBounds,
  )
  const se = frequencySe(joint)
  const ci95 = se !== null ? normalQuantile(0.975) * se : null
  const designs1 = inBases.map((b, k) => nullDesign(b, noise1[k], joint.tauS))
  const rings = inBases.map((b, k) =>
    projectRing(b, noise1[k], designs1[k], joint.frequencyHz, joint.dampingRatio, ringScratch(b.m), new Float64Array(designs1[k].k), new Float64Array(designs1[k].k)),
  )
  const omega = 2 * Math.PI * joint.frequencyHz
  const amplitudes = rings.map((r, k) => Math.hypot(r.a, r.b) * Math.exp(-joint.dampingRatio * omega * inBases[k].rec.tS[0]))
  included.forEach((l, k) => (verdicts[windowed[l]].amplitudeMm = amplitudes[k]))
  Object.assign(base, {
    frequencyHz: joint.frequencyHz,
    dampingRatio: joint.dampingRatio,
    frequencySeHz: se,
    frequencyCi95Hz: ci95,
    amplitudeMm: median(amplitudes),
  })

  // After the detection, the line labels and the tier tests use the noise model of the full fit:
  // a long-lived ring is partly modeled as noise by the null fit, which costs those per-line and
  // per-tier tests their power, while the axis decision above keeps the exact null noise model.
  const states1: LineState[] = inBases.map((b, k) => ({
    basis: b,
    noise0: noise1[k],
    design0: designs1[k],
    field: detectionField(b, noise1[k], designs1[k]),
  }))
  states1.forEach((st, k) => {
    let top = 0
    for (let g = 0; g < G; g++) top = Math.max(top, st.field[g])
    const v = verdicts[windowed[included[k]]]
    v.detectionPBound = bonferroni(G, top, 2)
    v.detected = v.detectionPBound <= DETECTION_ALPHA
  })
  base.linesDetected = verdicts.filter((v) => v.detected).length

  // Diagnostics and checks.
  base.decayDemonstrated = decayTest(inBases, noise1, joint, tauBounds)
  base.proportionality = proportionalityCheck(inBases, rings, joint)
  base.speedCheck = speedCheck(states1, joint, speedsMmS, tauBounds)
  base.influenceCheck = speedsMmS.length === 1 ? influenceCheck(states) : 'not-assessed'
  const detectedK = included.map((l, k) => (verdicts[windowed[l]].detected ? k : -1)).filter((k) => k >= 0)
  const replicate = replicateCheck(
    detectedK.map((k) => states1[k]),
    detectedK.map((k) => lineFits.get(included[k]) ?? joint),
    joint,
    tauBounds,
  )
  base.replicateCheck = replicate.state
  replicate.frequencies.forEach((f, j) => (verdicts[windowed[included[detectedK[j]]]].frequencyHz = f))

  // Verdict, the most specific failing gate first.
  const result = { ...base }
  if (joint.frequencyHz <= F_MIN_HZ + BOUND_MARGIN_HZ || joint.frequencyHz >= F_MAX_HZ - BOUND_MARGIN_HZ) {
    return refuse(
      `The frequency fitted across the axis's lines sits at the edge of the ${F_MIN_HZ} to ` +
        `${F_MAX_HZ} Hz search range, so it cannot be trusted. The true resonance likely ` +
        'lies outside the measurable range.',
      result,
    )
  }
  if (joint.dampingRatio >= ZETA_MAX) {
    return refuse(
      "The damping ratio fitted across the axis's lines sits at the edge of the physically " +
        'plausible range, so the fit cannot be trusted.',
      result,
    )
  }
  const speed = result.speedCheck
  if (speed.state === 'changed') {
    return refuse(
      'The frequency changed with the line speed, the way a print or scan pattern does. ' +
        'Ringing of the machine keeps its frequency at every speed, so no shaper is recommended.',
      result,
    )
  }
  if (speed.state === 'not-confirmed') {
    const silent = speed.tiers.find((t) => !t.detected)
    return refuse(
      silent
        ? `The ${silent.speedMmS} mm/s lines alone show no ringing, so the frequency cannot be ` +
            'confirmed at both speeds. Reprint or rescan the coupon.'
        : 'The two speed tiers measured the frequency too imprecisely to confirm that it is ' +
            'the same at both speeds. Reprint or rescan the coupon.',
      result,
    )
  }
  if (result.influenceCheck === 'failed') {
    return refuse(
      'The ringing found on this axis rests on a single line, so a print defect or dust on ' +
        'that line could have caused it. Rescan the coupon, or reprint it with two speed tiers.',
      result,
    )
  }
  if (result.proportionality === 'failed') {
    return refuse(
      'The pattern on this axis does not grow with the corner speed the way ringing of the ' +
        'machine does. A steady vibration, such as a fan, or a pattern in the print or the scan ' +
        'is the likely cause, so no shaper is recommended.',
      result,
    )
  }
  if (result.replicateCheck === 'failed') {
    return refuse(
      'The lines of this axis disagree on the ringing frequency by more than their measurement ' +
        'error. The print or scan is too inconsistent to trust a single value.',
      result,
    )
  }
  if (ci95 === null || ci95 > MAX_CI95_REL * joint.frequencyHz) {
    return refuse(
      'The pooled frequency estimate is too uncertain to configure an input shaper: its 95% ' +
        'confidence interval is wider than the stopband of the shaper it would set. Reprint or ' +
        'rescan the coupon.',
      result,
    )
  }
  return { ...result, accepted: true, refusals: [], rescanAdvice: null }
}

/**
 * The 'full' detection noise residual: the line's ordinary least squares full fit at its own
 * best grid point (unweighted field), whose residual the design's two-step GLS fits the AR to.
 */
function olsFullResidualAtArgmax(basis: LineBasis, tauS: number): Float64Array {
  const identity = noiseModel(basis, WHITE_UNIT)
  const design = nullDesign(basis, identity, tauS)
  const field = detectionField(basis, identity, design)
  let best = 0
  for (let g = 1; g < field.length; g++) if (field[g] > field[best]) best = g
  const point = DETECTION_GRID[best]
  const scratch = ringScratch(basis.m)
  const ring = projectRing(basis, identity, design, point.frequencyHz, point.dampingRatio, scratch, new Float64Array(design.k), new Float64Array(design.k))
  return rawFullResidual(basis, identity, design, point.frequencyHz, point.dampingRatio, ring, scratch)
}

/** Boundary LRT of zeta = 0 (Self and Liang 1987): true when the decay is demonstrated. */
function decayTest(bases: LineBasis[], noises: LineNoise[], joint: JointFit, tauBounds: [number, number]): boolean {
  if (!(joint.dampingRatio > 0) || !(joint.sigma2 > 0)) return false
  const undamped = varproFit(
    bases,
    noises,
    [joint.frequencyHz, 0, Math.log(joint.tauS)],
    [true, false, true],
    tauBounds,
  )
  const lambda = (undamped.lm.ssr - joint.lm.ssr) / joint.sigma2
  return lambda > DECAY_CRITICAL
}

/**
 * Input proportionality: nested likelihood-ratio test of per-line complex ring amplitudes
 * proportional to the line's corner speed (one complex scale per speed tier) against free
 * per-line amplitudes, at the joint estimate. With each line's residualized whitened ring
 * columns C_l (Gram G_l, data products g_l), the free model removes sum_l g_l' G_l^-1 g_l and the
 * proportional one sum_T s_T' (sum_l c_l^2 G_l)^-1 s_T with s_T = sum_l c_l g_l; the difference
 * over sigma^2 is chi2 with 2 (K - T) degrees of freedom under proportionality.
 */
function proportionalityCheck(
  bases: LineBasis[],
  rings: ReturnType<typeof projectRing>[],
  joint: JointFit,
): CheckState {
  const tiers = new Map<number, number[]>()
  bases.forEach((b, k) => {
    const list = tiers.get(b.rec.speedMmS) ?? []
    list.push(k)
    tiers.set(b.rec.speedMmS, list)
  })
  const dof = 2 * (bases.length - tiers.size)
  if (dof <= 0 || !(joint.sigma2 > 0)) return 'not-assessed'
  let free = 0
  for (const r of rings) free += r.D
  let proportional = 0
  for (const members of tiers.values()) {
    let a11 = 0
    let a12 = 0
    let a22 = 0
    let s1 = 0
    let s2 = 0
    for (const k of members) {
      const c = bases[k].rec.cornerSpeedMmS
      const r = rings[k]
      a11 += c * c * r.G11
      a12 += c * c * r.G12
      a22 += c * c * r.G22
      s1 += c * r.gR
      s2 += c * r.gI
    }
    const det = a11 * a22 - a12 * a12
    if (!(det > 0)) return 'not-assessed'
    proportional += (a22 * s1 * s1 - 2 * a12 * s1 * s2 + a11 * s2 * s2) / det
  }
  const lr = Math.max(0, free - proportional) / joint.sigma2
  return chiSquareSurvival(lr, dof) > DETECTION_ALPHA ? 'passed' : 'failed'
}

/** Grid indices whose frequency lies within MAX_CI95_REL of any of the centers. */
function localGrid(centers: number[]): number[] {
  const out: number[] = []
  DETECTION_GRID.forEach((p, g) => {
    if (centers.some((c) => Math.abs(p.frequencyHz - c) <= MAX_CI95_REL * c)) out.push(g)
  })
  return out
}

/** The three-way two-tier speed check (closed testing on local grids, then the d test), on the
 *  joint-fit lines with their full-fit noise models. */
function speedCheck(
  states: LineState[],
  joint: JointFit,
  speedsMmS: number[],
  tauBounds: [number, number],
): SpeedCheck {
  if (speedsMmS.length < 2) return NOT_ASSESSED_SPEED
  const slow = Math.min(...speedsMmS)
  const fast = Math.max(...speedsMmS)
  const rho = fast / slow
  const points = localGrid([joint.frequencyHz, joint.frequencyHz * rho, joint.frequencyHz / rho])
  const tiers: TierCheck[] = [slow, fast].map((v) => {
    const members = states.map((st, k) => (st.basis.rec.speedMmS === v ? k : -1)).filter((k) => k >= 0)
    const blank: TierCheck = { speedMmS: v, detected: false, detectionPBound: null, frequencyHz: null, frequencySeHz: null }
    if (members.length === 0 || points.length === 0) return blank
    const local = fieldMaximum(states, members, points)
    const pBound = bonferroni(points.length, local.value, 2 * members.length)
    const detected = pBound <= DETECTION_ALPHA
    if (!detected) return { ...blank, detectionPBound: pBound }
    const seed = DETECTION_GRID[local.index]
    const fit = varproFit(
      members.map((k) => states[k].basis),
      members.map((k) => states[k].noise0),
      [seed.frequencyHz, seed.dampingRatio, Math.log(joint.tauS)],
      [true, true, false],
      tauBounds,
    )
    return { speedMmS: v, detected, detectionPBound: pBound, frequencyHz: fit.frequencyHz, frequencySeHz: frequencySe(fit) }
  })
  const [s, f] = tiers
  if (!s.detected || !f.detected || s.frequencySeHz === null || f.frequencySeHz === null) {
    return { state: 'not-confirmed', tiers }
  }
  const d = Math.log(s.frequencyHz! / f.frequencyHz!)
  const sd = Math.hypot(s.frequencySeHz / s.frequencyHz!, f.frequencySeHz / f.frequencyHz!)
  if (Math.abs(d) / sd > Z_TWO_SIDED) return { state: 'changed', tiers }
  if ((d + Math.log(rho)) / sd > Z_ONE_SIDED) return { state: 'confirmed', tiers }
  return { state: 'not-confirmed', tiers }
}

/** One tier: the detection must survive leaving out any single line (Cook 1977). */
function influenceCheck(states: LineState[]): CheckState {
  const K = states.length
  if (K < 2) return 'failed'
  const G = DETECTION_GRID.length
  for (let left = 0; left < K; left++) {
    let top = -Infinity
    for (let g = 0; g < G; g++) {
      let s = 0
      for (let l = 0; l < K; l++) if (l !== left) s += states[l].field[g]
      if (s > top) top = s
    }
    if (bonferroni(G, top, 2 * (K - 1)) > DETECTION_ALPHA) return 'failed'
  }
  return 'passed'
}

/**
 * Cochran's Q over the detected joint-fit lines' own frequencies, each fitted with its full-fit
 * noise model and the axis tau from its screening fit (or the joint estimate). Returns the state
 * and each line's frequency, aligned with `states`.
 */
function replicateCheck(
  states: LineState[],
  seeds: JointFit[],
  joint: JointFit,
  tauBounds: [number, number],
): { state: CheckState; frequencies: number[] } {
  const frequencies: number[] = []
  const estimates: { f: number; se: number }[] = []
  states.forEach((st, j) => {
    const fit = varproFit(
      [st.basis],
      [st.noise0],
      [seeds[j].frequencyHz, seeds[j].dampingRatio, Math.log(joint.tauS)],
      [true, true, false],
      tauBounds,
    )
    frequencies.push(fit.frequencyHz)
    const se = frequencySe(fit)
    if (se !== null) estimates.push({ f: fit.frequencyHz, se })
  })
  if (estimates.length < 3) return { state: 'not-assessed', frequencies }
  const w = estimates.map((e) => 1 / (e.se * e.se))
  const sumW = w.reduce((s, v) => s + v, 0)
  const mean = estimates.reduce((s, e, i) => s + w[i] * e.f, 0) / sumW
  const q = estimates.reduce((s, e, i) => s + w[i] * (e.f - mean) ** 2, 0)
  const p = chiSquareSurvival(q, estimates.length - 1)
  return { state: p > DETECTION_ALPHA ? 'passed' : 'failed', frequencies }
}

/** |G|, the number of grid points the detection bound pays for. */
export const DETECTION_GRID_SIZE = DETECTION_GRID.length
