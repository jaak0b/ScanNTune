import type { TracedLine } from './lineTracer'
import type { AlongTrackLagState, CheckState, SpeedCheck, TierCheck } from './resultTypes'
import {
  DETECTION_ALPHA,
  F_MAX_HZ,
  F_MIN_HZ,
  MAX_CI95_REL,
  MIN_ACCEPTED_LINES,
  MIN_TWO_TIER_LINE_SPEED_MM_S,
} from './types'
import {
  DETECTION_GRID,
  DRIFT_CUTOFF_HZ,
  FREQUENCY_GRID_HZ,
  ZETA_GRID,
  ZETA_MAX,
  arcLengthMm,
  cornerColumns,
  covariateAt,
  dampingMeasured,
  varianceCovariate,
  depositTimes,
  ringColumns,
} from './ringRegressors'
import { depositTimesUnder, unitResponseMode } from './alongTrackLag'
import type { CornerResponse, FittedLineRing } from './alongTrackLag'
import {
  NoMeasurableNoiseError,
  fitNoise,
  fixedNullColumns,
  glsNullSsr,
  levenbergMarquardt,
  lineBasis,
  noiseModel,
  minimizeOverLogTau,
  nullDesign,
  olsNull,
  olsNullSsr,
  parameterVariances,
  pooledVarianceSlope,
  projectRing,
  rawFullResidual,
  ringScratch,
} from './ringGls'
import type { LineBasis, LineNoise, LineRecord, LmResult, NullDesign, RingProjection, VarianceLine } from './ringGls'
import {
  cruiseSampleIntervalS,
  heldNoiseStatistic,
  noiseSpectrumPeaks,
  nullHypothesisFit,
  ringLikelihoodRatio,
} from './ringLikelihood'
import type { NullFit, RingPoint, RingRatio } from './ringLikelihood'
import { gridCandidates, knownCandidates, searchStage } from './artifactSearch'
import { cornerLockingShown, decayShown } from './cornerTransient'
import type { CornerPhasor } from './cornerTransient'
import type { DetectedArtifact } from './artifactSearch'
import type { CornerModelKind, VarianceCovariate } from './ringRegressors'
import { defaultMaxArOrder } from '../correlatedNoise'
import type { ArFit } from '../correlatedNoise'
import { MAD_TO_SIGMA, chiSquareSurvival, chiSquareSurvivalEvenDof, mad, median, normalQuantile } from '../math'
import { tQuantile } from '../studentT'

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
//    prefilter applied identically to the data and every column; the corner model, either the
//    first-order flow lag of the commanded flow (its particular solution and its homogeneous
//    term for the flow state at the corner) or the bead dragged at the corner, exp(-s / lambda)
//    in commanded arc length, whichever null model has the lower pooled AICc (Hurvich and Tsai
//    1989), its one scale per axis chosen by golden-section search on a log scale (Kiefer 1953);
//    the arc-length patterns the pattern search detected (artifactSearch.ts: belt teeth, JPEG
//    blocks, pixel locking, other stationary patterns of the print or the scan), searched before
//    the detection and again with the fitted ring in the null design; the damped quadrature ring
//    pair; and AR(p) noise on the sample lattice.
// 3. Noise: per line AR(p) by Burg's method over the runs of read samples (Burg 1975; de Waele
//    and Broersen 2000), order by AICc (Hurvich and Tsai 1989) up to floor(10 log10 n), and the
//    exact innovations whitening of data and every column with missing observations handled by
//    the Kalman filter of the AR state space (Jones 1980): two-step feasible GLS (Aitken 1935;
//    Cochrane and Orcutt 1949). The innovations carry the axis's multiplicative variance
//    function of the flow-lag deficit (Harvey 1976; ringGls.ts), one slope shared by the lines,
//    applied only when its likelihood ratio test rejects a constant variance at DETECTION_ALPHA,
//    both under the null and with each line's strongest ring candidate removed.
// 4. Detection field: per line the generalized likelihood ratio statistic of the ring at theta
//    with the AR noise model refitted under each hypothesis (ringLikelihood.ts), chi2_2 under H0
//    at a fixed theta; their sum Q over the K lines is chi2_2K. A noise model fitted under the
//    null alone would absorb a component that persists over the window. The refit is costly, so
//    the field holds a lower bound of each line's statistic: the ratio with the null noise model
//    held fixed at every grid point, and the refitted ratio at the null spectrum's in-band peaks
//    (where an absorbed component shows) and wherever a maximum is taken, since every maximum
//    the analysis uses is evaluated with the refitted model. The look-elsewhere effect over the
//    grid G (FREQUENCY_GRID_HZ x ZETA_GRID, |G| = 181 x 13 = 2,353) is paid by the Bonferroni
//    bound pBound = min(1, |G| P(chi2_2K >= max_G Q)) (Dunn 1961); a lower bound of Q can only
//    raise pBound, so the bound stays valid. Per-line labels use the same bound on each line's own
//    statistic.
// 5. Estimation: seed at argmax_G Q, then generalized least squares variable projection (Golub
//    and Pereyra 1973) over (f, zeta, log tau) with each line's noise model refitted under the
//    alternative at the seed, polished by Levenberg-Marquardt (Levenberg 1944; Marquardt 1963),
//    then the noise model refitted to the full-fit residuals with its order chosen again (the
//    second feasible GLS step), in the model that encompasses both corner models so the interval
//    does not rest on their AICc choice (Leeb and Potscher 2005). The frequency interval is the
//    profile-likelihood interval (Bates and Watts 1988); zeta is bounded to [0, ZETA_MAX]. A
//    second mode is then searched with the first one in the null design (sequential forward
//    detection, Quinn and Hannan 2001) and, when detected, both are fitted jointly.
// 6. Checks, each at DETECTION_ALPHA:
//    - Corner transient (cornerTransient.ts): the response is ringing only when it is shown to be
//      the transient the corner starts, locked to the corner (a randomization test of the lines'
//      phases, Barnard 1963, Hope 1968) or decaying (the boundary likelihood ratio test of
//      zeta = 0, Self and Liang 1987), each at DETECTION_ALPHA / 2 (Bonferroni, Dunn 1961). A
//      forced tone, such as a fan, is neither.
//    - Speed check with two tiers: a nested likelihood ratio test (Wilks 1938) of the log ratio
//      d = ln(f_slow / f_fast), one extra parameter of the joint fit, against d = 0, chi2_1 at
//      DETECTION_ALPHA; the unrestricted fit starts from no change and from the two arc-length
//      pattern images. Changed with speed when d = 0 is rejected; confirmed when it is not and the
//      pattern hypothesis d = -ln rho is rejected one-sided by the Wald test of the unrestricted
//      fit; otherwise not confirmed. Only a change with speed refuses the axis.
//    - One tier: the detection is tested again with each single line deleted (a leave-one-out
//      influence check).
//    - Replicate check: Cochran's Q homogeneity test (Cochran 1954) on the inverse-variance
//      weighted per-line frequencies of the detected lines.
// 7. Screening and guards: a Hampel identifier on the per-line frequencies of the detected lines,
//    the band-edge guard, at least MIN_ACCEPTED_LINES lines, and the
//    MAX_CI95_REL confidence gate.
// 8. Along-track lag (poolCouponAxes; alongTrackLag.ts): the axis along a group's lines is the
//    other group's axis, and it rings after the corner too, so the nozzle lags its commanded
//    position by that axis's response and every sample is deposited at a shifted time. A coupon's
//    two axes are estimated jointly by the nonlinear Gauss-Seidel iteration, each axis's ring and
//    flow-lag columns on the deposit times the other axis's fitted ring gives; the detection stays
//    on the commanded time base, the screening and the estimation run again on the deposit times.

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
/** Critical value of a chi2_1 likelihood ratio test at the detection level, 10.83: the test of a
 *  constant innovation variance and the speed check's test of the tiers' frequency ratio. */
const CHI2_1_CRITICAL = normalQuantile(1 - DETECTION_ALPHA / 2) ** 2

/**
 * Why a traced line could not enter the analysis on its own, as a category: 'irregular-trace' is
 * a trace without a free ringdown, 'out-of-band' a detected ring at the edge of the frequency
 * search range.
 */
export type LineFitRefusalCategory = 'irregular-trace' | 'out-of-band'

/** Why a line was excluded from the joint fit. */
export type LineJointExclusion = 'no-free-response' | 'out-of-band' | 'frequency-outlier'

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
  /** The line's own fitted damping ratio, a diagnostic only: one line cannot identify its damping,
   *  so a value at ZETA_MAX is the fit's limit and does not screen the line. Set for a detected
   *  line of a screened axis. */
  ownDampingRatio?: number
  /** Joint-fit ring amplitude at the line's fit-window start, mm; null outside the joint fit. */
  amplitudeMm: number | null
}

/** A second mode of an accepted axis: detected with the first mode in the null design, then
 *  fitted jointly with it. */
export interface SecondMode {
  frequencyHz: number
  dampingRatio: number
  /** Standard error of the frequency from the two-mode fit, Hz; null when not estimable. */
  frequencySeHz: number | null
  /** Median over the lines of the mode's amplitude at the fit-window start, mm. */
  amplitudeMm: number
  /** True when this mode's amplitudes are shown to be locked to the corner (cornerTransient.ts);
   *  false marks a steady tone, not a mode. */
  cornerLocked: boolean
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
  /** Boundary LRT of zeta = 0 rejected at the corner-transient gate's level; null when the axis
   *  was not fitted. */
  decayDemonstrated: boolean | null
  /** The boundary LRT statistic of zeta = 0 (0.5 chi2_0 + 0.5 chi2_1 under an undamped ring). */
  decayStatistic: number | null
  /** True when the ring's amplitudes are shown to be locked to the corner (cornerTransient.ts);
   *  null when the axis was not fitted. */
  cornerLocked: boolean | null
  speedCheck: SpeedCheck
  replicateCheck: CheckState
  /** One-tier leave-one-line-out influence check of the detection. */
  influenceCheck: CheckState
  /** Bonferroni bound of the search for a second mode (first mode in the null design); null when
   *  the axis was not accepted. */
  secondModePBound: number | null
  /** The second mode, when its search detected one; the axis's own figures are then the
   *  dominant mode's from the two-mode fit. */
  secondMode: SecondMode | null
  /** Arc-length artifacts the search detected and the analysis carried in its null design. */
  artifacts: DetectedArtifact[]
  /** The corner model the pooled AICc chose and its scale (the flow-lag time constant in
   *  seconds, or the bead-drag length in millimetres; the joint fit's when there is one); null
   *  with too few lines. */
  cornerModel: { kind: CornerModelKind; scale: number } | null
  /** The along-track lag correction of the estimate (poolCouponAxes); null when the axis was
   *  refused before its estimate or analyzed alone (poolAxisFits). */
  alongTrackLag: AlongTrackLagState | null
  lines: LineVerdict[]
}

/**
 * Gaussian regression filter trend (ISO 16610-21 style, zeroth order): a Gaussian-weighted
 * moving average with per-sample weight normalization (the regression form, which keeps the
 * trend unbiased at the profile ends). `cutoffS` is the period at which the trend's transmission
 * is 50%; alpha = sqrt(ln 2 / pi) per the standard. The trend is evaluated at the first `count`
 * samples. On the uniform cruise grid at the end of a trace a weight depends only on the sample
 * distance, so those weights come from one table instead of one exponential per pair. Used to
 * locate the free ringdown only.
 */
export function gaussianTrend(
  tS: Float64Array,
  y: Float64Array,
  cutoffS: number,
  count = y.length,
): Float64Array {
  const n = y.length
  const alpha = Math.sqrt(Math.log(2) / Math.PI)
  const denom = alpha * cutoffS
  const step = n > 1 ? tS[n - 1] - tS[n - 2] : 0
  let uniformFrom = n - 1
  while (uniformFrom > 0 && Math.abs(tS[uniformFrom] - tS[uniformFrom - 1] - step) <= 1e-9 * Math.abs(step)) {
    uniformFrom--
  }
  const table = new Float64Array(n)
  for (let d = 0; d < n; d++) {
    const u = (d * step) / denom
    table[d] = Math.exp(-Math.PI * u * u)
  }
  const trend = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    let w = 0
    let s = 0
    for (let j = 0; j < n; j++) {
      let wk: number
      if (i >= uniformFrom && j >= uniformFrom) {
        wk = table[i > j ? i - j : j - i]
      } else {
        const u = (tS[j] - tS[i]) / denom
        wk = Math.exp(-Math.PI * u * u)
      }
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

  // The free-ringdown search reads the first half of the trace only.
  const half = Math.floor(n / 2)
  const trend = gaussianTrend(line.tS, line.lateralMm, 1 / DRIFT_CUTOFF_HZ, half)
  const detrended = new Float64Array(n)
  for (let i = 0; i < half; i++) detrended[i] = line.lateralMm[i] - trend[i]
  const start = freeResponseStart(detrended)
  if (start === null) return refuse()

  const lattice: number[] = []
  for (let k = start; k < n; k++) if (line.observed[k]) lattice.push(k)
  const m = lattice.length
  if (m < 2) return refuse()
  const tS = Float64Array.from(lattice, (k) => line.tS[k])
  // The window must leave residual degrees of freedom after the null and ring columns and the
  // largest AR order the noise model may take.
  const record: LineRecord = {
    tS,
    lattice: Int32Array.from(lattice),
    y: Float64Array.from(lattice, (k) => line.lateralMm[k]),
    speedMmS: line.speedMmS,
    cornerSpeedMmS: line.cornerSpeedMmS,
    accelMmS2: line.accelMmS2,
    alongPxPerMm: line.alongPxPerMm,
    acrossImagePx: Float64Array.from(lattice, (k) => line.acrossImagePx[k]),
    acrossAxisPxPerMm: line.acrossAxisPxPerMm,
    lateralTowardRunUp: line.lateralTowardRunUp,
  }
  const columns = fixedNullColumns(record).length + 4
  if (m - columns - defaultMaxArOrder(m) - 2 <= 0) return refuse()
  return {
    screening: 'windowed',
    refusalReason: null,
    refusalCategory: null,
    window: record,
    offsetMm,
  }
}

/** One line's prepared model inside poolAxisFits. */
interface LineState {
  basis: LineBasis
  h0: NullFit
  /** Lower bound of the line's likelihood ratio statistic over DETECTION_GRID: the held-noise
   *  ratio everywhere, the refitted ratio wherever it was evaluated. */
  field: Float64Array
  /** The refitted ratios evaluated so far, by grid index. */
  refitted: Map<number, RingRatio>
}

/** The search range of the corner-model scale: one sample interval to the longest window, in
 *  time for the flow lag and in commanded arc length for the bead drag. */
function tauRange(bases: LineBasis[]): [number, number] {
  const axis = bases.map((b) => (b.cornerModel === 'flow-lag' ? b.rec.tS : arcLengthMm(b.rec.tS, b.rec)))
  return [Math.min(...axis.map((x) => x[1] - x[0])), Math.max(...axis.map((x) => x[x.length - 1] - x[0]))]
}

/**
 * The null fits of the lines: tau by ordinary least squares, the AR order by AICc on each line's
 * ordinary least squares residual, tau again by GLS under those noise models, then each line's
 * AR refitted to its GLS residual by iterated Cochrane-Orcutt.
 */
function nullFits(bases: LineBasis[], tauBounds: [number, number], fixedModes: RingPoint[] = []): NullFit[] {
  const tauOls = olsTau(bases, tauBounds)
  const initial = bases.map((b) => fitNoise(b, olsNull(b, tauOls).residual))
  const tau = minimizeOverLogTau(
    (t) => bases.reduce((s, b, l) => s + glsNullSsr(b, initial[l], t), 0),
    tauBounds[0],
    tauBounds[1],
  )
  const plain = bases.map((b, l) => nullHypothesisFit(b, initial[l].fit, tau, 0, null, fixedModes))
  const covariates = bases.map((b) => varianceCovariate(b.rec, b.cornerModel, tau))
  const nullColumns = bases.map((b, l) => meanColumns(b, tau, plain[l].fixedColumns))
  if (axisVarianceSlope(bases.map((b, l) => varianceLine(b, plain[l].noise, nullColumns[l], covariates[l]))) === 0) return plain
  // A ring the null model leaves in its residual also raises the early variance. The variance
  // function is kept only if its test still rejects once every line's own strongest ring
  // candidate (the maximum of its held-noise field) joins the mean model, and its slope is then
  // estimated in that model: a rougher bead does not go away with a ring.
  const slope = axisVarianceSlope(
    bases.map((b, l) => varianceLine(b, plain[l].noise, [...nullColumns[l], ...strongestRingColumns(b, plain[l])], covariates[l])),
  )
  if (slope === 0) return plain
  return bases.map((b, l) => nullHypothesisFit(b, plain[l].noise.fit, tau, slope, covariates[l], fixedModes))
}

/** The raw ring columns of a line's strongest held-noise ring candidate. */
function strongestRingColumns(basis: LineBasis, h0: NullFit): Float64Array[] {
  const field = heldNoiseField(basis, h0)
  let best = 0
  for (let g = 1; g < field.length; g++) if (field[g] > field[best]) best = g
  const point = DETECTION_GRID[best]
  return ringColumns(depositTimes(basis.rec), point.frequencyHz, point.dampingRatio)
}

/** The raw columns of a line's null mean model at the corner-model scale tauS: the fixed
 *  columns, the corner model's, and `extra` (the columns of modes already fitted, or a ring). */
function meanColumns(basis: LineBasis, tauS: number, extra: Float64Array[] = []): Float64Array[] {
  return [...basis.fixedColumns, ...cornerColumns(basis.rec, basis.cornerModel, tauS), ...extra]
}

/** A line's input to the variance function's fit: its data and mean-model columns whitened by
 *  the AR operator of `noise` (its innovations before any variance function), and the values of
 *  the covariate every noise model built with the fitted slope carries. */
function varianceLine(basis: LineBasis, noise: LineNoise, columns: Float64Array[], covariate: VarianceCovariate): VarianceLine {
  const { whitener } = noise
  return { y: whitener.whiten(basis.rec.y), columns: columns.map((c) => whitener.whiten(c)), covariate: covariate.values }
}

/** The flow-lag time constant of the axis's ordinary least squares null fits. */
function olsTau(bases: LineBasis[], tauBounds: [number, number]): number {
  return minimizeOverLogTau(
    (tau) => bases.reduce((s, b) => s + olsNullSsr(b, tau), 0),
    tauBounds[0],
    tauBounds[1],
  )
}

/**
 * The slope of the axis's innovation variance function (ringGls.pooledVarianceSlope, by
 * restricted likelihood over each line's mean model) against each line's covariate, or 0 when its
 * likelihood ratio test does not reject a constant variance at DETECTION_ALPHA. A nonzero slope
 * is valid only on these covariates, so every noise model built with it carries them.
 */
function axisVarianceSlope(lines: VarianceLine[]): number {
  const pooled = pooledVarianceSlope(lines)
  return pooled.statistic > CHI2_1_CRITICAL ? pooled.slope : 0
}

/**
 * The axis detection statistic Q(theta) = sum_l of the lines' likelihood ratio statistics at one
 * point, each with its noise model refitted under both hypotheses. Exposed for the statistical
 * calibration of the detection (chi2_2K at a fixed theta under H0, and the noncentrality of the
 * power cases).
 */
export function detectionStatisticAt(fits: LineFit[], frequencyHz: number, dampingRatio: number): number {
  const bases = fits.filter((f) => f.window).map((f) => lineBasis(f.window!))
  const h0 = nullFits(bases, tauRange(bases))
  return bases.reduce((sum, b, l) => sum + ringLikelihoodRatio(b, h0[l], { frequencyHz, dampingRatio }).statistic, 0)
}

/** Patterns carried in the null design: what was detected and each line's columns of them. */
interface CarriedArtifacts {
  artifacts: DetectedArtifact[]
  /** Per line, the column pairs of the detected patterns, flattened. */
  columns: Float64Array[][]
}

/** The line bases with the carried patterns as fixed null columns. */
function carriedBases(
  windows: LineRecord[],
  carried: CarriedArtifacts,
  cornerModel: CornerModelKind,
  extra: Float64Array[][] = [],
): LineBasis[] {
  return windows.map((w, l) => lineBasis(w, [], cornerModel, [...carried.columns[l], ...(extra[l] ?? [])]))
}

/**
 * The lines' bases and null fits with the patterns (artifactSearch.ts) the search detects beyond
 * `found`: the known patterns first, then the spatial-frequency grid, each stage at half the
 * false-alarm level and repeated with every detection in the null design. `fixedModes` are fitted
 * rings carried in the null design during the search; with `search` false the found patterns are
 * only built in.
 */
function withArtifacts(
  windows: LineRecord[],
  speedsMmS: number[],
  found: CarriedArtifacts | null = null,
  fixedModes: RingPoint[] = [],
  search = true,
  cornerModel: CornerModelKind = 'flow-lag',
): { bases: LineBasis[]; fits: NullFit[]; carried: CarriedArtifacts } {
  const carried: CarriedArtifacts = found
    ? { artifacts: found.artifacts.slice(), columns: found.columns.map((c) => c.slice()) }
    : { artifacts: [], columns: windows.map(() => []) }
  let bases = carriedBases(windows, carried, cornerModel)
  let fits = nullFits(bases, tauRange(bases), fixedModes)
  if (!search || speedsMmS.length < 2) return { bases, fits, carried }
  for (const known of [true, false]) {
    for (;;) {
      const candidates = known ? knownCandidates(bases) : gridCandidates(speedsMmS)
      const hit = searchStage(bases, fits, candidates, DETECTION_ALPHA / 2)
      if (hit === null) break
      const same = carried.artifacts.some(
        (a) => a.periodMm === hit.artifact.periodMm && a.pixelLockHarmonic === hit.artifact.pixelLockHarmonic,
      )
      if (same) break
      carried.artifacts.push(hit.artifact)
      hit.columns.forEach((pair, l) => carried.columns[l].push(...pair))
      bases = carriedBases(windows, carried, cornerModel)
      fits = nullFits(bases, tauRange(bases), fixedModes)
    }
  }
  return { bases, fits, carried }
}

/**
 * The pooled corrected Akaike information criterion of the lines' null fits (C. M. Hurvich and
 * C.-L. Tsai, Biometrika 76, 1989): the summed exact deviance plus 2 K N / (N - K - 1), with K the
 * parameters (each line's null columns, AR coefficients, innovation variance and variance slope,
 * and the one corner-model scale of the axis) and N the samples.
 */
function pooledAicc(fits: NullFit[], bases: LineBasis[]): number {
  const N = bases.reduce((s, b) => s + b.m, 0)
  const K = fits.reduce((s, f) => s + f.design.k + f.order + 1 + (f.noise.varianceSlope !== 0 ? 1 : 0), 0) + 1
  return fits.reduce((s, f) => s + f.deviance, 0) + (2 * K * N) / (N - K - 1)
}

/**
 * The corner model of an axis: the flow lag of the commanded flow (`flow`, already fitted) or the
 * bead dragged at the corner, whichever null model has the lower pooled AICc. Both carry the
 * detected artifacts.
 */
function chooseCornerModel(
  windows: LineRecord[],
  flow: { bases: LineBasis[]; fits: NullFit[]; carried: CarriedArtifacts },
): { bases: LineBasis[]; fits: NullFit[]; kind: CornerModelKind; beadScale: number } {
  const bases = carriedBases(windows, flow.carried, 'bead-drag')
  const fits = nullFits(bases, tauRange(bases))
  const beadScale = fits[0].tauS
  return pooledAicc(fits, bases) < pooledAicc(flow.fits, flow.bases)
    ? { bases, fits, kind: 'bead-drag', beadScale }
    : { bases: flow.bases, fits: flow.fits, kind: 'flow-lag', beadScale }
}

/** One line's detection state for a null fit (see detectionStates). */
function lineState(basis: LineBasis, h0: NullFit): LineState {
  const state: LineState = { basis, h0, field: heldNoiseField(basis, h0), refitted: new Map() }
  for (const f of noiseSpectrumPeaks(h0.noise.fit, cruiseSampleIntervalS(basis))) refine(state, gridIndex(f, ZETA_GRID[0]))
  return state
}

/** The ZETA_GRID value nearest a damping ratio on a log scale. */
function nearestGridZeta(dampingRatio: number): number {
  const target = Math.log(Math.max(dampingRatio, ZETA_GRID[0]))
  return ZETA_GRID.reduce((best, z) => (Math.abs(Math.log(z) - target) < Math.abs(Math.log(best) - target) ? z : best))
}

/** The grid index of (f, zeta) in DETECTION_GRID (frequency-major). */
function gridIndex(frequencyHz: number, dampingRatio: number): number {
  const fi = Math.round((frequencyHz - F_MIN_HZ) / FREQUENCY_GRID_HZ)
  return fi * ZETA_GRID.length + ZETA_GRID.indexOf(dampingRatio)
}

/** The likelihood ratio of every grid point with the null noise model held fixed. */
function heldNoiseField(basis: LineBasis, h0: NullFit): Float64Array {
  const field = new Float64Array(DETECTION_GRID.length)
  const scratch = ringScratch(basis.m)
  const pr = new Float64Array(h0.design.k)
  const pi = new Float64Array(h0.design.k)
  for (let g = 0; g < DETECTION_GRID.length; g++) {
    const point = DETECTION_GRID[g]
    const D = projectRing(basis, h0.noise, h0.design, point.frequencyHz, point.dampingRatio, scratch, pr, pi).D
    field[g] = heldNoiseStatistic(h0, basis.m, D)
  }
  return field
}

/** Evaluates the refitted ratio of one line at one grid point (once) into its field. */
function refine(state: LineState, g: number): RingRatio {
  let ratio = state.refitted.get(g)
  if (!ratio) {
    ratio = ringLikelihoodRatio(state.basis, state.h0, DETECTION_GRID[g])
    state.refitted.set(g, ratio)
    state.field[g] = Math.max(state.field[g], ratio.statistic)
  }
  return ratio
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

/**
 * The maximum of the summed field over `points`, evaluated with the refitted noise models: the
 * running maximum is refitted on every line until the maximum sits at a refitted point. Refits
 * only raise the field, so this ends, and every point left unrefitted is below the result.
 */
function refittedMaximum(
  states: LineState[],
  lines: number[],
  points: ArrayLike<number> | null = null,
): { index: number; value: number } {
  for (;;) {
    const top = fieldMaximum(states, lines, points)
    const pending = lines.filter((l) => !states[l].refitted.has(top.index))
    if (pending.length === 0) return top
    for (const l of pending) refine(states[l], top.index)
  }
}

/**
 * A line's own maximum: its held-noise field's maximum refitted first, since a point other lines
 * raised by refits can otherwise hide a larger refit of the line's own strongest candidate, then
 * the refitted maximum of its field.
 */
function ownMaximum(states: LineState[], l: number): { index: number; value: number } {
  const field = states[l].field
  let heldTop = 0
  for (let g = 1; g < field.length; g++) if (field[g] > field[heldTop] && !states[l].refitted.has(g)) heldTop = g
  if (!states[l].refitted.has(heldTop)) refine(states[l], heldTop)
  return refittedMaximum(states, [l])
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

/**
 * The 95% profile-likelihood interval of the joint frequency (D. M. Bates and D. G. Watts,
 * "Nonlinear Regression Analysis and Its Applications", Wiley 1988, s6.1): the frequencies whose
 * profile t statistic sign(f - f_hat) sqrt(SSR(f) - SSR_min) / s stays within the Student t
 * quantile t_(0.975, dof), with zeta and tau re-optimized at every fixed f. Unlike the
 * linearization sigma^2 (J'J)^-1, it follows the actual shape of the least squares surface, which
 * near the detection threshold is wider than its curvature at the optimum. Each side's end is
 * bracketed from the linearized interval and found by bisection on the profile t statistic to a
 * hundredth of the linearized standard error. Null when the linearized standard error is
 * unavailable or a side leaves the search band.
 */
function profileFrequencyInterval(
  bases: LineBasis[],
  noises: LineNoise[],
  joint: JointFit,
  tauBounds: [number, number],
): { lower: number; upper: number; critical: number } | null {
  const wald = frequencySe(joint)
  if (wald === null || !(joint.sigma2 > 0)) return null
  const critical = tQuantile(0.975, joint.dof)
  const s = Math.sqrt(joint.sigma2)
  const profileT = (f: number): number => {
    const fit = varproFit(bases, noises, [f, joint.dampingRatio, Math.log(joint.tauS)], [false, true, true], tauBounds)
    return Math.sqrt(Math.max(0, fit.lm.ssr - joint.lm.ssr)) / s
  }
  const side = (direction: 1 | -1): number | null => {
    let inside = joint.frequencyHz
    let step = critical * wald
    let outside = joint.frequencyHz + direction * step
    for (;;) {
      if (outside <= F_MIN_HZ || outside >= F_MAX_HZ) return null
      if (profileT(outside) >= critical) break
      inside = outside
      step *= 2
      outside = joint.frequencyHz + direction * step
    }
    while (Math.abs(outside - inside) > 0.01 * wald) {
      const mid = 0.5 * (inside + outside)
      if (profileT(mid) >= critical) outside = mid
      else inside = mid
    }
    return 0.5 * (inside + outside)
  }
  const upper = side(1)
  const lower = side(-1)
  if (upper === null || lower === null) return null
  return { lower, upper, critical }
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
 * with its record. One axis alone, on the commanded time base; a coupon's two axes are analyzed
 * together by poolCouponAxes.
 */
export function poolAxisFits(fits: LineFit[], speedsMmS: number[]): AxisPool {
  return analyzeAxis(fits, speedsMmS).pool()
}

/**
 * The axes of one coupon in the joint X/Y model of the along-track lag (alongTrackLag.ts). Each
 * axis is first analyzed on its commanded time base. When both axes pass their detection, the
 * model is estimated jointly by alternating between the axes (block coordinate descent, the
 * nonlinear Gauss-Seidel iteration; J. M. Ortega and W. C. Rheinboldt, "Iterative Solution of
 * Nonlinear Equations in Several Variables", Academic Press 1970, s7.4): each step refits one
 * axis's ring on the deposit times the other axis's latest fitted ring gives, until a sweep over
 * both axes moves no frequency by more than LAG_PASS_TOLERANCE of its standard error. The axis
 * whose ring the lag modulates more strongly goes first, because its first-pass estimate is the
 * less trustworthy and the other axis's the more (see firstToCorrect). The literal two-pass scheme
 * stops too early: the first pass's rings are fitted on the commanded time base, so the lag they
 * predict is itself biased, and its residual leaves a spurious mode at the sum of the two
 * frequencies. Each axis's first corrected step screens its lines again on the corrected time
 * base (the lag scatters the per-line frequencies by rung on the commanded one), and every axis
 * is finally estimated in full on its converged deposit times. The first pass's full estimate is
 * computed only where it is reported (the joint model needs only its joint fit). The detection
 * and its look-elsewhere bound are those of the commanded time base: the time base moves only the
 * ring and flow-lag columns, and a test at fixed columns keeps its null law. An axis keeps the
 * correction only when the other axis's corrected estimate is accepted, since the lag rests on
 * that axis's ring; otherwise its commanded-time-base estimate stands. `axes` are the line fits
 * of the coupon's groups; `maxPasses` is the iteration's safeguard.
 */
export function poolCouponAxes(axes: LineFit[][], speedsMmS: number[], maxPasses = MAX_LAG_PASSES): AxisPool[] {
  const first = axes.map((fits) => analyzeAxis(fits, speedsMmS))
  // The commanded-time-base estimates, computed only where they are reported.
  const keep = (state: AlongTrackLagState) => first.map((a) => uncorrectedPool(a, state))
  const uncorrected = () => keep('other-axis-not-measured')
  if (axes.length !== 2) return uncorrected()
  const detections = first.map((a) => a.detection)
  if (detections.some((d) => d === null)) return uncorrected()
  const lags = first.map(dominantLag)
  if (lags.every((r) => r === null)) return uncorrected()
  const deposit = (i: number) => detections[i]!.windows.map((w) => depositTimesUnder(w, lags[1 - i]!))
  // An axis whose first pass fitted no ring has no lag to give: it goes first, on the lag of the
  // other axis.
  const leader = lags[0] === null ? 0 : lags[1] === null ? 1 : firstToCorrect(lags as CornerResponse[])
  const order = leader === 0 ? [0, 1] : [1, 0]
  // The first corrected step of each axis screens its lines and seeds its fit on its corrected
  // time base and refits the noise models on the corrected residuals; the later steps hold them,
  // so each step is a smooth function of the other axis's ring and the iteration contracts
  // instead of cycling between AR orders the AICc selects anew.
  const screenings: AxisScreening[] = []
  const fits: JointFitResult[] = []
  for (const i of order) {
    const times = deposit(i)
    const screened = screenLines(detections[i]!, times)
    if ('refusal' in screened) return keep('joint-fit-failed')
    screenings[i] = screened.screening
    const zeta = lags[i]?.modes[0].dampingRatio ?? DETECTION_GRID[detections[i]!.axisMaxIndex].dampingRatio
    const seed = correctedSeed(detections[i]!, screenings[i].included, times, zeta)
    fits[i] = jointFit(detections[i]!, screenings[i].included, times, seed)
    lags[i] = lagResponse(fits[i])
    if (lags[i] === null) return keep('joint-fit-failed')
  }
  let converged = false
  for (let pass = 1; pass < maxPasses && !converged; pass++) {
    converged = true
    for (const i of order) {
      const next = jointRefit(detections[i]!, screenings[i].included, deposit(i), fits[i])
      const se = frequencySe(next.joint)
      // Without a standard error there is no precision to judge the convergence by.
      if (se === null) return keep('joint-fit-failed')
      if (Math.abs(next.joint.frequencyHz - fits[i].joint.frequencyHz) > LAG_PASS_TOLERANCE * se) converged = false
      fits[i] = next
      lags[i] = lagResponse(next)
      if (lags[i] === null) return keep('joint-fit-failed')
    }
  }
  if (!converged) return keep('joint-fit-failed')
  const corrected = detections.map((d, i) => {
    const point = { frequencyHz: fits[i].joint.frequencyHz, dampingRatio: fits[i].joint.dampingRatio }
    const times = deposit(i)
    const pool = completeAxis(d!, screenings[i], jointFit(d!, screenings[i].included, times, point), times)
    return { ...pool, alongTrackLag: 'corrected' as const }
  })
  return corrected.map((pool, i) => (corrected[1 - i].accepted ? pool : uncorrectedPool(first[i], 'other-axis-not-measured')))
}

/**
 * Which axis the joint iteration corrects first: the one whose ring the lag modulates more. The
 * lag of axis G's nozzle is the other axis H's response, of amplitude c |kappa_H| at corner speed
 * c, so G's ring of angular frequency w_G is read with a phase error up to w_G c |kappa_H| / v:
 * the modulation index grows with G's own frequency times H's response, and the axis with the
 * larger product has the more distorted first pass and the partner with the more trustworthy one.
 */
function firstToCorrect(responses: CornerResponse[]): 0 | 1 {
  const index = (i: number) => {
    const other = responses[1 - i].modes[0]
    return responses[i].modes[0].frequencyHz * Math.hypot(other.cosCoefficient, other.sinCoefficient)
  }
  return index(0) >= index(1) ? 0 : 1
}

/**
 * The lag an axis's first pass gives the other axis: its dominant mode's response to a unit corner
 * speed step. On the commanded time base the joint fit can settle on the sideband the lag puts at
 * the sum of the two frequencies; the second-mode search then finds the ring itself, and the
 * larger of the two is the ring, since a phase modulation keeps more amplitude in the carrier
 * than in either sideband below 1.4 rad (J0 above J1). Null when the axis has no joint fit.
 */
function dominantLag(analysis: AxisAnalysis): CornerResponse | null {
  if (analysis.fit === null || analysis.secondMode === null) return null
  const search = analysis.secondMode()
  if (search.modes === null) return lagResponse(analysis.fit)
  const { mode, rings } = search.modes.dominant
  const unit = unitResponseMode(fittedRings(analysis.fit.inBases, rings), mode.frequencyHz, mode.dampingRatio)
  return unit !== null ? { modes: [unit] } : null
}

/** Safeguard of the joint iteration (poolCouponAxes's default maxPasses): at most this many
 *  corrected passes, after which an axis pair that has not converged keeps its
 *  commanded-time-base estimates. Not a model parameter. */
const MAX_LAG_PASSES = 8
/** Convergence of the joint iteration: a pass that moves no frequency by more than a tenth of its
 *  standard error has settled, since a bias of a tenth of the standard error raises the mean
 *  squared error of the estimate by 1% (1 + 0.1^2); finer changes are below the precision the
 *  inner Levenberg-Marquardt fits settle to on a strongly modulated ring. A numerical tolerance of
 *  the iteration, not a model parameter. */
const LAG_PASS_TOLERANCE = 0.1

/**
 * The ring statistic over the detection grid's frequencies at one damping ratio, summed over
 * `lines` (indices into the windows), with each line on the deposit times and its null noise
 * model and corner-model scale held from the detection.
 */
function correctedScan(
  detection: AxisDetection,
  lines: number[],
  depositTimeS: Float64Array[],
  dampingRatio: number,
): Float64Array {
  const { carried, chosen, states } = detection
  const totals = new Float64Array(FREQUENCY_GRID_HZ_VALUES.length)
  for (const l of lines) {
    const rec = { ...detection.windows[l], depositTimeS: depositTimeS[l] }
    const basis = lineBasis(rec, [], chosen.kind, carried.columns[l])
    const h0 = states[l].h0
    const noise = noiseModel(basis, h0.noise.fit, h0.noise.varianceSlope, covariateAt(rec, h0.noise.covariate))
    const design = nullDesign(basis, noise, h0.tauS)
    const scratch = ringScratch(basis.m)
    const pr = new Float64Array(design.k)
    const pi = new Float64Array(design.k)
    FREQUENCY_GRID_HZ_VALUES.forEach((f, j) => (totals[j] += projectRing(basis, noise, design, f, dampingRatio, scratch, pr, pi).D))
  }
  return totals
}

/**
 * The seed of a fit on the deposit times: the frequency of the largest ring statistic of
 * `lines` on those times (correctedScan) at the grid damping nearest `dampingRatio`, among the
 * frequencies of the grid points `points` (indices into DETECTION_GRID) when given. A fit on the
 * commanded time base is no seed: read there, a ring phase modulated by more than about 1.4 rad (a
 * lateral axis twice as fast as the axis along its lines reaches 1.9 rad on the top rung) keeps
 * less amplitude at its own frequency than in the sideband at the sum of the two frequencies, J0
 * below J1 (the Jacobi-Anger expansion), so the fit finds the sideband.
 */
function correctedSeed(
  detection: AxisDetection,
  lines: number[],
  depositTimeS: Float64Array[],
  dampingRatio: number,
  points: number[] | null = null,
): RingPoint {
  const zeta = nearestGridZeta(dampingRatio)
  const totals = correctedScan(detection, lines, depositTimeS, zeta)
  const allowed = points ? new Set(points.map((g) => DETECTION_GRID[g].frequencyHz)) : null
  let best = -1
  for (let j = 0; j < totals.length; j++) {
    if (allowed && !allowed.has(FREQUENCY_GRID_HZ_VALUES[j])) continue
    if (best < 0 || totals[j] > totals[best]) best = j
  }
  return { frequencyHz: FREQUENCY_GRID_HZ_VALUES[best], dampingRatio: zeta }
}

/**
 * The unit white noise model: with it a generalized least squares fit is ordinary least squares,
 * the start of feasible GLS (the Cochrane-Orcutt procedure's first step) on deposit times, where
 * the detection's noise models, fitted with the ring on the commanded time base, absorbed the
 * lag's residual into their AR terms.
 */
const WHITE_START: ArFit = { coefficients: [], noiseVariance: 1 }

/** The detection grid's frequencies, Hz. */
const FREQUENCY_GRID_HZ_VALUES: number[] = [...new Set(DETECTION_GRID.map((p) => p.frequencyHz))]

/** The response to a unit corner speed step of a joint fit's ring (the lag it causes on the other
 *  axis); null when no line has a positive corner speed. The joint fit holds one mode, the
 *  dominant one: on the commanded time base a further mode can be the sideband the lag itself puts
 *  at the sum of the two axes' frequencies, which must not enter the lag meant to remove it. */
function lagResponse(fit: JointFitResult): CornerResponse | null {
  const mode = unitResponseMode(fittedRings(fit.inBases, fit.rings), fit.joint.frequencyHz, fit.joint.dampingRatio)
  return mode !== null ? { modes: [mode] } : null
}

/** An axis's analysis on the commanded time base: its detection (null when the detection refused
 *  the axis), its joint fit and that fit's second-mode search (null when refused before the fit),
 *  and its pool, estimated in full on first use. */
interface AxisAnalysis {
  pool: () => AxisPool
  detection: AxisDetection | null
  fit: JointFitResult | null
  secondMode: (() => SecondModeSearch) | null
}

/** The analysis of an axis with the patterns to carry given (`preset`, no search) or searched
 *  (null); repeated with more patterns when the search with the fitted ring finds more. A trace
 *  without measurable noise ends it in a refusal (noiseRefusal). */
function analyzeAxis(fits: LineFit[], speedsMmS: number[], preset: CarriedArtifacts | null = null): AxisAnalysis {
  try {
    const analysis = analyzeAxisUnguarded(fits, speedsMmS, preset)
    return { ...analysis, pool: () => noiseRefusal(fits, analysis.pool) }
  } catch (error) {
    if (!(error instanceof NoMeasurableNoiseError)) throw error
    return { pool: () => noiseRefusal(fits, () => { throw error }), detection: null, fit: null, secondMode: null }
  }
}

/** The pool `pool` computes, or the refusal of an axis whose traces carry no measurable noise. */
function noiseRefusal(fits: LineFit[], pool: () => AxisPool): AxisPool {
  try {
    return pool()
  } catch (error) {
    if (!(error instanceof NoMeasurableNoiseError)) throw error
    const verdicts: LineVerdict[] = fits.map((f) => ({
      usedInJointFit: false,
      exclusion: f.window ? null : 'no-free-response',
      detected: false,
      detectionPBound: null,
      frequencyHz: null,
      amplitudeMm: null,
    }))
    return refusal(emptyPool(verdicts), `${error.message} Rescan the coupon.`)
  }
}

function analyzeAxisUnguarded(fits: LineFit[], speedsMmS: number[], preset: CarriedArtifacts | null): AxisAnalysis {
  const detected = detectAxis(fits, speedsMmS, preset)
  if ('refusal' in detected) return { pool: () => detected.refusal, detection: null, fit: null, secondMode: null }
  const detection = detected.detection
  const screened = screenLines(detection, null)
  if ('refusal' in screened) return { pool: () => screened.refusal, detection, fit: null, secondMode: null }
  const fit = jointFit(detection, screened.screening.included, null, null)
  // A ring left out of the first artifact search leaks into the artifact columns on its own tier
  // and makes an artifact's amplitude grow with the corner speed: the search runs again with the
  // fitted ring in the null design, and the analysis is repeated with whatever more it finds.
  if (!detection.preset && speedsMmS.length >= 2) {
    const ring = [{ frequencyHz: fit.joint.frequencyHz, dampingRatio: fit.joint.dampingRatio }]
    const again = withArtifacts(detection.windows, speedsMmS, detection.carried, ring, true, detection.chosen.kind)
    if (again.carried.artifacts.length > detection.carried.artifacts.length) return analyzeAxisUnguarded(fits, speedsMmS, again.carried)
  }
  let search: SecondModeSearch | null = null
  const secondMode = () => (search ??= searchSecondMode(fit))
  let pool: AxisPool | null = null
  return { pool: () => (pool ??= completeAxis(detection, screened.screening, fit, null, secondMode())), detection, fit, secondMode }
}

/** An axis's commanded-time-base pool with the along-track lag state set when the axis has a
 *  detection to report it on. */
function uncorrectedPool(analysis: AxisAnalysis, state: AlongTrackLagState): AxisPool {
  const pool = analysis.pool()
  return analysis.detection === null ? pool : { ...pool, alongTrackLag: state }
}

/** What the screening and the estimation of an axis take over from its detection. */
interface AxisDetection {
  speedsMmS: number[]
  /** The patterns were given, not searched. */
  preset: boolean
  /** The pool with the detection's fields filled; its line verdicts are copied per screening. */
  base: AxisPool
  /** Index into the analysis's line fits of each windowed line. */
  windowed: number[]
  windows: LineRecord[]
  carried: CarriedArtifacts
  chosen: ReturnType<typeof chooseCornerModel>
  states: LineState[]
  /** Each line's own maximum of its field. */
  ownMaxima: { index: number; value: number }[]
  /** Grid index of the axis's field maximum. */
  axisMaxIndex: number
}

/** The lines of a detected axis that enter its joint fit, and every line's verdict. */
interface AxisScreening {
  verdicts: LineVerdict[]
  /** The windowed lines (indices into the windows) that entered the joint fit. */
  included: number[]
}

function emptyPool(verdicts: LineVerdict[]): AxisPool {
  return {
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
    decayStatistic: null,
    cornerLocked: null,
    speedCheck: NOT_ASSESSED_SPEED,
    replicateCheck: 'not-assessed',
    influenceCheck: 'not-assessed',
    secondModePBound: null,
    secondMode: null,
    artifacts: [],
    cornerModel: null,
    alongTrackLag: null,
    lines: verdicts,
  }
}

function refusal(base: AxisPool, reason: string, extras: Partial<AxisPool> = {}): AxisPool {
  return { ...base, ...extras, refusals: [reason] }
}

function tooFewLines(base: AxisPool, count: number, outOfBand: number, excluded: number): AxisPool {
  const verdict =
    `Only ${count} of the axis's lines produced a usable ringing trace (at least ` +
    `${MIN_ACCEPTED_LINES} are needed for a trustworthy estimate).`
  if (outOfBand * 2 > excluded) {
    return refusal(base, `${verdict} The true resonance likely lies outside the measurable range.`)
  }
  return refusal(base, verdict, {
    rescanAdvice:
      "When most lines of a scan are refused, the scanner's lamp shadow is often falling " +
      'across the measured edges; rescan with the coupon rotated a half turn on the glass.',
  })
}

/** The detection stage: the pattern search, the null fits, the likelihood ratio fields, the axis
 *  bound and the per-line labels; a refusal when it ends the analysis. */
function detectAxis(
  fits: LineFit[],
  speedsMmS: number[],
  preset: CarriedArtifacts | null,
): { refusal: AxisPool } | { detection: AxisDetection } {
  const verdicts: LineVerdict[] = fits.map((f) => ({
    usedInJointFit: false,
    exclusion: f.window ? null : 'no-free-response',
    detected: false,
    detectionPBound: null,
    frequencyHz: null,
    amplitudeMm: null,
  }))
  const windowed = fits.map((f, i) => (f.window ? i : -1)).filter((i) => i >= 0)
  const base = emptyPool(verdicts)
  if (windowed.length < MIN_ACCEPTED_LINES) {
    return { refusal: tooFewLines(base, windowed.length, 0, fits.length - windowed.length) }
  }

  const windows = windowed.map((i) => fits[i].window!)
  const searched = withArtifacts(windows, speedsMmS, preset, [], preset === null)
  const chosen = chooseCornerModel(windows, searched)
  const bases = chosen.bases
  const states = chosen.fits.map((h0, l) => lineState(bases[l], h0))
  base.artifacts = searched.carried.artifacts
  base.cornerModel = { kind: chosen.kind, scale: chosen.fits[0].tauS }
  const all = bases.map((_, l) => l)
  const G = DETECTION_GRID.length
  const axisMax = refittedMaximum(states, all)
  const pBound = bonferroni(G, axisMax.value, 2 * states.length)
  const ownMaxima = states.map((_, l) => ownMaximum(states, l))
  ownMaxima.forEach((own, l) => {
    const v = verdicts[windowed[l]]
    v.detectionPBound = bonferroni(G, own.value, 2)
    v.detected = v.detectionPBound <= DETECTION_ALPHA
  })
  base.detectionPBound = pBound
  base.linesDetected = verdicts.filter((v) => v.detected).length
  if (!(pBound <= DETECTION_ALPHA)) {
    return {
      refusal: refusal(
        base,
        'No ringing was found on this axis. Across all its lines, the traces match drift and ' +
          'scan noise.',
        {
          rescanAdvice:
            'Rescan with the coupon rotated a half turn on the glass, since lamp shadow can ' +
            'weaken the traced ringing.',
        },
      ),
    }
  }
  return {
    detection: {
      speedsMmS,
      preset: preset !== null,
      base,
      windowed,
      windows,
      carried: searched.carried,
      chosen,
      states,
      ownMaxima,
      axisMaxIndex: axisMax.index,
    },
  }
}

/**
 * The screening of a detected axis's lines: each detected line's own fit (its noise model refitted
 * under the alternative at its own maximum, the axis tau), the band-edge guard and a Hampel
 * identifier on the per-line frequencies; a refusal when fewer than
 * MIN_ACCEPTED_LINES remain. On the commanded time base each line's fit starts at its own field
 * maximum; on deposit times (`depositTimeS`, one array per window) it is an ordinary least squares
 * fit (WHITE_START) from the maximum of its own ring statistic on those times (correctedSeed), at
 * the damping of its own maximum.
 */
function screenLines(
  detection: AxisDetection,
  depositTimeS: Float64Array[] | null,
): { refusal: AxisPool } | { screening: AxisScreening } {
  const { windowed, states, ownMaxima, carried, chosen } = detection
  const verdicts = detection.base.lines.map((v) => ({ ...v }))
  const base: AxisPool = { ...detection.base, lines: verdicts }
  const tau0 = states[0].h0.tauS
  const tauBounds = tauRange(states.map((s) => s.basis))
  const lineFits = new Map<number, JointFit>()
  states.forEach((s, l) => {
    if (!verdicts[windowed[l]].detected) return
    const own = ownMaxima[l].index
    if (depositTimeS === null) {
      const seed = DETECTION_GRID[own]
      const noise = refine(s, own).fit.noise
      lineFits.set(l, varproFit([s.basis], [noise], [seed.frequencyHz, seed.dampingRatio, Math.log(tau0)], [true, true, false], tauBounds))
      return
    }
    const rec = { ...detection.windows[l], depositTimeS: depositTimeS[l] }
    const basis = lineBasis(rec, [], chosen.kind, carried.columns[l])
    const seed = correctedSeed(detection, [l], depositTimeS, DETECTION_GRID[own].dampingRatio)
    lineFits.set(l, varproFit([basis], [noiseModel(basis, WHITE_START)], [seed.frequencyHz, seed.dampingRatio, Math.log(tau0)], [true, true, false], tauBounds))
  })
  // Only a line's own frequency screens it. Its own damping ratio is no test of the line: one line
  // carries little information about the damping, so its fit often runs to the upper bound on a
  // good trace. That is a limit of what one line can identify, not evidence of a bad line, and the
  // axis damping is estimated from all lines jointly afterwards.
  lineFits.forEach((fit, l) => {
    const v = verdicts[windowed[l]]
    v.frequencyHz = fit.frequencyHz
    v.ownDampingRatio = fit.dampingRatio
    if (fit.frequencyHz <= F_MIN_HZ + BOUND_MARGIN_HZ || fit.frequencyHz >= F_MAX_HZ - BOUND_MARGIN_HZ) {
      v.exclusion = 'out-of-band'
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
  const included = states.map((_, l) => l).filter((l) => verdicts[windowed[l]].exclusion === null)
  if (included.length < MIN_ACCEPTED_LINES) {
    const excluded = verdicts.filter((v) => v.exclusion !== null)
    return {
      refusal: tooFewLines(
        base,
        included.length,
        excluded.filter((v) => v.exclusion === 'out-of-band').length,
        excluded.length,
      ),
    }
  }
  for (const l of included) verdicts[windowed[l]].usedInJointFit = true
  return { screening: { verdicts, included } }
}

/**
 * The estimation stage of a screened axis after its joint fit `fit`: the interval, the checks and
 * the verdict, with the fit's second-mode search (`secondMode`, searched here when not given).
 * With `depositTimeS` (one array per window, those the fit was made on) the ring and flow-lag
 * columns sit at the deposit times the along-track lag gives; without, on the commanded time base.
 */
function completeAxis(
  detection: AxisDetection,
  screening: AxisScreening,
  fit: JointFitResult,
  depositTimeS: Float64Array[] | null,
  secondMode: SecondModeSearch = searchSecondMode(fit),
): AxisPool {
  const { speedsMmS, windowed, chosen, states } = detection
  const { included } = screening
  const verdicts = screening.verdicts.map((v) => ({ ...v }))
  const base: AxisPool = { ...detection.base, lines: verdicts, linesUsed: included.length }
  const { inBases, estBounds, noise1, joint, rings } = fit
  base.cornerModel = { kind: chosen.kind, scale: chosen.kind === 'flow-lag' ? joint.tauS : chosen.beadScale }
  const interval = profileFrequencyInterval(inBases, noise1, joint, estBounds)
  const se = interval ? (interval.upper - interval.lower) / (2 * interval.critical) : null
  const ci95 = interval ? Math.max(interval.upper - joint.frequencyHz, joint.frequencyHz - interval.lower) : null
  const omega = 2 * Math.PI * joint.frequencyHz
  const amplitudes = rings.map((r, k) => Math.hypot(r.a, r.b) * Math.exp(-joint.dampingRatio * omega * depositTimes(inBases[k].rec)[0]))
  included.forEach((l, k) => (verdicts[windowed[l]].amplitudeMm = amplitudes[k]))
  Object.assign(base, {
    frequencyHz: joint.frequencyHz,
    dampingRatio: joint.dampingRatio,
    frequencySeHz: se,
    frequencyCi95Hz: ci95,
    amplitudeMm: median(amplitudes),
  })

  // Diagnostics and checks.
  base.decayStatistic = decayStatistic(inBases, noise1, joint, estBounds)
  base.decayDemonstrated = decayShown(base.decayStatistic)
  base.cornerLocked = cornerLockingShown(cornerPhasors(inBases, rings))
  // The speed and replicate checks judge the mode the axis reports: the two-mode fit's dominant
  // mode when the second-mode search found one that outgrows the joint fit's mode.
  const dominant = secondMode.modes?.swapped ? secondMode.modes.dominant.mode : null
  const checked: JointFit = dominant ? { ...joint, frequencyHz: dominant.frequencyHz, dampingRatio: dominant.dampingRatio } : joint
  // On deposit times each tier's fit starts from its own maximum on those times: on the commanded
  // time base a strongly modulated ring's local maximum can be its sideband.
  const tierSeed = depositTimeS
    ? (lines: number[], points: number[]) => correctedSeed(detection, lines, depositTimeS, checked.dampingRatio, points)
    : null
  base.speedCheck = speedCheck(states, included, inBases, noise1, checked, speedsMmS, estBounds, tierSeed)
  base.influenceCheck = speedsMmS.length === 1 ? influenceCheck(states) : 'not-assessed'
  const detectedK = included.map((l, k) => (verdicts[windowed[l]].detected ? k : -1)).filter((k) => k >= 0)
  const replicate = replicateCheck(
    detectedK.map((k) => inBases[k]),
    detectedK.map((k) => noise1[k]),
    checked,
    estBounds,
  )
  base.replicateCheck = replicate.state
  replicate.frequencies.forEach((f, j) => (verdicts[windowed[included[detectedK[j]]]].frequencyHz = f))

  // A second mode, searched before the verdict: an unmodeled second mode distorts the single-mode
  // fit's per-line amplitudes, so with one the dominant mode's corner locking comes from the
  // two-mode fit.
  Object.assign(base, withSecondMode(base, secondMode))
  return verdict(base)
}

/** The joint fit of an estimation and what the estimation goes on with. */
interface JointFitResult {
  inBases: LineBasis[]
  estBounds: [number, number]
  /** The noise models of the second feasible GLS step. */
  noise1: LineNoise[]
  joint: JointFit
  /** Each line's ring at the joint fit, aligned with inBases. */
  rings: RingProjection[]
}

/** The joint-fit bases of the `included` lines: on the deposit times when given, in the model
 *  that encompasses both corner models (see jointFit). */
function jointBases(detection: AxisDetection, included: number[], depositTimeS: Float64Array[] | null): LineBasis[] {
  const { carried, chosen } = detection
  return included.map((l) => {
    const rec = depositTimeS ? { ...detection.windows[l], depositTimeS: depositTimeS[l] } : detection.windows[l]
    return lineBasis(rec, [], 'flow-lag', [...carried.columns[l], ...cornerColumns(rec, 'bead-drag', chosen.beadScale)])
  })
}

/**
 * The joint fit of a detected axis's `included` lines: with `depositTimeS` (one array per window)
 * the ring and flow-lag columns sit at the deposit times the along-track lag gives, else on the
 * commanded time base; from `start`, else from the detection field's maximum.
 *
 * Joint variable projection with each line's noise model refitted under the alternative at the
 * seed, then the second feasible GLS step with the noise refitted to the full-fit residuals. On
 * deposit times the first step is ordinary least squares instead (WHITE_START), since the
 * detection's noise models were fitted with the ring on the commanded time base. The
 * ring is estimated in the model that encompasses both corner models (the flow-lag columns, their
 * time constant free, and the bead-drag lobe at its null-fit length), so its interval does not
 * rest on the AICc choice: an interval computed in the model a criterion selected is too narrow
 * (H. Leeb and B. M. Potscher, "Model selection and inference: facts and fiction", Econometric
 * Theory 21, 2005).
 */
function jointFit(
  detection: AxisDetection,
  included: number[],
  depositTimeS: Float64Array[] | null,
  start: RingPoint | null,
): JointFitResult {
  const { chosen, states } = detection
  const inBases = jointBases(detection, included, depositTimeS)
  const estBounds = tauRange(inBases)
  const seedIndex = start ? gridIndex(Math.round(start.frequencyHz), nearestGridZeta(start.dampingRatio)) : refittedMaximum(states, included).index
  const seed = start ?? DETECTION_GRID[seedIndex]
  // The variance slope of a detection noise model was estimated on the covariate of the detection's
  // own corner model, so it is carried with that covariate.
  const noiseAtSeed = included.map((l, k) => {
    if (depositTimeS) return noiseModel(inBases[k], WHITE_START)
    const noise = refine(states[l], seedIndex).fit.noise
    return noiseModel(inBases[k], noise.fit, noise.varianceSlope, noise.covariate)
  })
  // The time constant starts at its best value at the seed over the joint-fit lines alone (golden
  // section on a log scale), never at the detection's, which a line excluded by the screening
  // still moves.
  const cache = new Map<number, NullDesign[]>()
  const tauStart = minimizeOverLogTau(
    (tauS) => sumOfSquares(stackedResidual(inBases, noiseAtSeed, seed.frequencyHz, seed.dampingRatio, tauS, cache)),
    estBounds[0],
    estBounds[1],
  )
  const first = varproFit(
    inBases,
    noiseAtSeed,
    [seed.frequencyHz, seed.dampingRatio, Math.log(tauStart)],
    [true, true, true],
    estBounds,
  )
  const residuals1 = inBases.map((b, k) => {
    const design = nullDesign(b, noiseAtSeed[k], first.tauS)
    const ring = projectRing(b, noiseAtSeed[k], design, first.frequencyHz, first.dampingRatio, ringScratch(b.m), new Float64Array(design.k), new Float64Array(design.k))
    return rawFullResidual(b, noiseAtSeed[k], design, first.frequencyHz, first.dampingRatio, ring, ringScratch(b.m))
  })
  const ar1 = inBases.map((b, k) => fitNoise(b, residuals1[k]))
  const covariates = inBases.map((b) => jointCovariate(b.rec, chosen, first.tauS))
  const slope1 = axisVarianceSlope(
    inBases.map((b, k) =>
      varianceLine(b, ar1[k], meanColumns(b, first.tauS, ringColumns(depositTimes(b.rec), first.frequencyHz, first.dampingRatio)), covariates[k]),
    ),
  )
  const noise1 = slope1 === 0 ? ar1 : inBases.map((b, k) => noiseModel(b, ar1[k].fit, slope1, covariates[k]))
  const joint = varproFit(
    inBases,
    noise1,
    [first.frequencyHz, first.dampingRatio, Math.log(first.tauS)],
    [true, true, true],
    estBounds,
  )
  return { inBases, estBounds, noise1, joint, rings: jointRings(inBases, noise1, joint) }
}

/**
 * The joint fit of a detected axis's `included` lines on new deposit times with the noise models
 * of `held` (their AR fits, variance slope and the covariate the slope was estimated on, rebuilt
 * at the new deposit times), from held's estimate: one generalized least squares fit with the
 * covariance held, the mean model refitted.
 */
function jointRefit(detection: AxisDetection, included: number[], depositTimeS: Float64Array[], held: JointFitResult): JointFitResult {
  const inBases = jointBases(detection, included, depositTimeS)
  const tauS = held.joint.tauS
  const noise1 = inBases.map((b, k) =>
    noiseModel(b, held.noise1[k].fit, held.noise1[k].varianceSlope, covariateAt(b.rec, held.noise1[k].covariate)),
  )
  const joint = varproFit(
    inBases,
    noise1,
    [held.joint.frequencyHz, held.joint.dampingRatio, Math.log(tauS)],
    [true, true, true],
    held.estBounds,
  )
  return { inBases, estBounds: held.estBounds, noise1, joint, rings: jointRings(inBases, noise1, joint) }
}

/**
 * The covariate of a joint fit's variance function: the deficit of the corner model the detection
 * chose, the flow-lag deficit at the time constant `tauS` the caller gives (the first step's
 * `first.tauS`, not the joint fit's refitted one) or the bead-drag lobe at its null-fit length, so the estimation's variance function is the one the pooled AICc selected.
 */
function jointCovariate(rec: LineRecord, chosen: AxisDetection['chosen'], tauS: number): VarianceCovariate {
  return chosen.kind === 'flow-lag' ? varianceCovariate(rec, 'flow-lag', tauS) : varianceCovariate(rec, 'bead-drag', chosen.beadScale)
}

/** The sum of squares of a vector. */
function sumOfSquares(r: Float64Array): number {
  let s = 0
  for (const v of r) s += v * v
  return s
}

/** Each line's ring at a joint fit, aligned with the bases. */
function jointRings(inBases: LineBasis[], noises: LineNoise[], joint: JointFit): RingProjection[] {
  return inBases.map((b, k) => {
    const design = nullDesign(b, noises[k], joint.tauS)
    return projectRing(b, noises[k], design, joint.frequencyHz, joint.dampingRatio, ringScratch(b.m), new Float64Array(design.k), new Float64Array(design.k))
  })
}

/** The lines' rings for the corner-locking test, aligned with `bases`: each ring's precision is
 *  the mean of the diagonal of its Gram matrix, whose columns the line's noise model whitened to
 *  unit innovation variance. */
function cornerPhasors(bases: LineBasis[], rings: RingProjection[]): CornerPhasor[] {
  return bases.map((b, k) => ({
    a: rings[k].a,
    b: rings[k].b,
    precision: (rings[k].G11 + rings[k].G22) / 2,
    cornerSpeedMmS: b.rec.cornerSpeedMmS,
    lateralTowardRunUp: b.rec.lateralTowardRunUp,
  }))
}

/** The lines' fitted rings for the along-track response, aligned with `bases`. */
function fittedRings(bases: LineBasis[], rings: { a: number; b: number }[]): FittedLineRing[] {
  return bases.map((b, k) => ({
    cornerSpeedMmS: b.rec.cornerSpeedMmS,
    lateralTowardRunUp: b.rec.lateralTowardRunUp,
    a: rings[k].a,
    b: rings[k].b,
  }))
}

/** The verdict on an estimated axis, the most specific failing gate first. */
function verdict(result: AxisPool): AxisPool {
  // The dominant mode's figures: the two-mode fit's when a second mode was found.
  const f = result.frequencyHz!
  if (f <= F_MIN_HZ + BOUND_MARGIN_HZ || f >= F_MAX_HZ - BOUND_MARGIN_HZ) {
    return refusal(
      result,
      `The frequency fitted across the axis's lines sits at the edge of the ${F_MIN_HZ} to ` +
        `${F_MAX_HZ} Hz search range, so it cannot be trusted. The true resonance likely ` +
        'lies outside the measurable range.',
    )
  }
  // A damping ratio at ZETA_MAX is the fit's limit, not a measurement: the axis keeps its
  // frequency, and the shaper recommendation designs the shaper at Klipper's default damping ratio.
  const speed = result.speedCheck
  if (speed.state === 'changed') {
    return refusal(
      result,
      'The frequency changed with the line speed, the way a print or scan pattern does. ' +
        'Ringing of the machine keeps its frequency at every speed, so no shaper is recommended.',
    )
  }
  if (result.influenceCheck === 'failed') {
    return refusal(
      result,
      'The ringing found on this axis rests on a single line, so a print defect or dust on ' +
        'that line could have caused it. Rescan the coupon, or reprint it at a line speed of at ' +
        `least ${MIN_TWO_TIER_LINE_SPEED_MM_S} mm/s on a bed large enough for both speed tiers.`,
    )
  }
  if (!result.cornerLocked && !result.decayDemonstrated) {
    return refusal(
      result,
      'The pattern on this axis neither starts in step with the corner nor fades the way ringing ' +
        'of the machine does. A steady vibration, such as a fan, or a pattern in the print or the ' +
        'scan is the likely cause, so no shaper is recommended.',
    )
  }
  if (result.replicateCheck === 'failed') {
    return refusal(
      result,
      'The lines of this axis disagree on the ringing frequency by more than their measurement ' +
        'error. The print or scan is too inconsistent to trust a single value.',
    )
  }
  if (result.frequencyCi95Hz === null || result.frequencyCi95Hz > MAX_CI95_REL * f) {
    return refusal(
      result,
      'The pooled frequency estimate is too uncertain to configure an input shaper: its 95% ' +
        'confidence interval is wider than the stopband of the shaper it would set. Reprint or ' +
        'rescan the coupon.',
    )
  }
  return { ...result, accepted: true, refusals: [], rescanAdvice: null }
}

/**
 * Sequential forward detection of a second mode (B. G. Quinn and E. J. Hannan, "The Estimation
 * and Tracking of Frequency", Cambridge University Press 2001, ch. 5): the first mode's ring
 * columns join every line's null design, and the same likelihood ratio field, refits and
 * Bonferroni bound over the grid test for a further ring at DETECTION_ALPHA. On detection both
 * modes are fitted jointly by variable projection over (f1, zeta1, f2, zeta2, log tau) with each
 * line's linear terms, polished by Levenberg-Marquardt; covariance sigma^2 (J'J)^-1. The axis then
 * reports the dominant mode (the larger median amplitude) and the other as its second mode, with
 * the corner-locking test of that mode.
 */
function searchSecondMode(fit: JointFitResult): SecondModeSearch {
  const { inBases: bases, noise1: noises, joint, estBounds: tauBounds } = fit
  const mode1 = { frequencyHz: joint.frequencyHz, dampingRatio: joint.dampingRatio }
  // Each line's variance slope stays on the covariate it was estimated on (the joint fit's),
  // never the one the basis's own corner model would give.
  const states = bases.map((b, k) =>
    lineState(b, nullHypothesisFit(b, noises[k].fit, joint.tauS, noises[k].varianceSlope, noises[k].covariate, [mode1])),
  )
  const all = states.map((_, l) => l)
  const top = refittedMaximum(states, all)
  const pBound = bonferroni(DETECTION_GRID.length, top.value, 2 * states.length)
  if (!(pBound <= DETECTION_ALPHA)) return { pBound, modes: null }
  const seed = DETECTION_GRID[top.index]
  const two = twoModeFit(bases, noises, [joint.frequencyHz, joint.dampingRatio, seed.frequencyHz, seed.dampingRatio, Math.log(joint.tauS)], tauBounds)
  if (two === null) return { pBound, modes: null }
  return secondModeOutcome(pBound, two.modes)
}

/**
 * The outcome of a second-mode search from the two-mode fit's modes, the joint fit's mode first
 * and the mode the search found second: the dominant mode is the one with the larger amplitude.
 * A mode of the two-mode fit whose damping ratio sits at the bound of the fit is no measurement
 * of damping (the fit's limit). Whichever of the two it is, the found mode or the refitted joint
 * mode that a swap would report as the other mode, the fit is not trusted to describe two modes:
 * the single-mode fit stands and the search's p-value bound stays as its diagnostic.
 */
export function secondModeOutcome(pBound: number, modes: [FittedMode, FittedMode]): SecondModeSearch {
  const [jointMode, found] = modes
  if (!dampingMeasured(found.mode.dampingRatio) || !dampingMeasured(jointMode.mode.dampingRatio)) return { pBound, modes: null }
  const swapped = jointMode.mode.amplitudeMm < found.mode.amplitudeMm
  const [dominant, other] = swapped ? [found, jointMode] : [jointMode, found]
  return { pBound, modes: { dominant, other, swapped } }
}

/** The outcome of the second-mode search of a joint fit: its Bonferroni bound and, when it found
 *  a second mode, both modes of the two-mode fit, the dominant (larger amplitude) first, and
 *  whether the dominant one is the mode the search found rather than the joint fit's. */
export interface SecondModeSearch {
  pBound: number
  modes: { dominant: FittedMode; other: FittedMode; swapped: boolean } | null
}

/** A mode of the two-mode fit with each line's ring of it, aligned with the fit's bases. */
export interface FittedMode {
  mode: SecondMode
  rings: RingProjection[]
}

/** The pool fields of a second-mode search: the dominant mode's figures and the second mode. When
 *  the dominant mode has no standard error, the joint fit's interval stands in only for the joint
 *  fit's own mode; a swapped dominant mode then has no interval, so the confidence gate refuses. */
export function withSecondMode(pool: AxisPool, search: SecondModeSearch): Partial<AxisPool> {
  if (search.modes === null) return { secondModePBound: search.pBound }
  const m1 = search.modes.dominant.mode
  const m2 = search.modes.other.mode
  const pBound = search.pBound
  const fallbackCi95 = search.modes.swapped ? null : pool.frequencyCi95Hz
  return {
    frequencyHz: m1.frequencyHz,
    dampingRatio: m1.dampingRatio,
    frequencySeHz: m1.frequencySeHz,
    frequencyCi95Hz: m1.frequencySeHz !== null ? normalQuantile(0.975) * m1.frequencySeHz : fallbackCi95,
    amplitudeMm: m1.amplitudeMm,
    cornerLocked: m1.cornerLocked,
    secondModePBound: pBound,
    secondMode: m2,
  }
}

/** The joint fit of two modes, each with its lines' rings; null when the fit degenerates (both
 *  modes on one frequency). */
function twoModeFit(
  bases: LineBasis[],
  noises: LineNoise[],
  start: number[],
  tauBounds: [number, number],
): { modes: [FittedMode, FittedMode] } | null {
  const lower = [F_MIN_HZ, 0, F_MIN_HZ, 0, Math.log(tauBounds[0])]
  const upper = [F_MAX_HZ, ZETA_MAX, F_MAX_HZ, ZETA_MAX, Math.log(tauBounds[1])]
  const project = (theta: number[], which: 0 | 1, residualOut?: (k: number) => Float64Array) =>
    bases.map((b, k) => {
      const [fa, za, fb, zb] = which === 1 ? [theta[0], theta[1], theta[2], theta[3]] : [theta[2], theta[3], theta[0], theta[1]]
      const design = nullDesign(b, noises[k], Math.exp(theta[4]), ringColumns(depositTimes(b.rec), fa, za))
      return projectRing(b, noises[k], design, fb, zb, ringScratch(b.m), new Float64Array(design.k), new Float64Array(design.k), residualOut?.(k))
    })
  const total = bases.reduce((s, b) => s + b.m, 0)
  const residual = (theta: number[]) => {
    const out = new Float64Array(total)
    const parts = bases.map((b) => new Float64Array(b.m))
    project(theta, 1, (k) => parts[k])
    let at = 0
    parts.forEach((r) => {
      out.set(r, at)
      at += r.length
    })
    return out
  }
  const lm = levenbergMarquardt(start, lower, upper, residual)
  const theta = lm.theta
  const rings2 = project(theta, 1)
  const rings1 = project(theta, 0)
  if (rings1.every((r) => r.D === 0) || rings2.every((r) => r.D === 0)) return null
  const linear = bases.reduce((s, b, k) => s + nullDesign(b, noises[k], Math.exp(theta[4])).k + 4, 0)
  const dof = total - linear - 5
  const variances = dof > 0 ? parameterVariances(lm, lm.ssr / dof) : null
  const se = (j: number) => (variances && variances[j] !== null && variances[j]! > 0 ? Math.sqrt(variances[j]!) : null)
  const amplitude = (rings: RingProjection[], f: number, zeta: number) =>
    median(rings.map((r, k) => Math.hypot(r.a, r.b) * Math.exp(-zeta * 2 * Math.PI * f * depositTimes(bases[k].rec)[0])))
  const mode = (rings: RingProjection[], f: number, zeta: number, seIndex: number): FittedMode => ({
    mode: {
      frequencyHz: f,
      dampingRatio: zeta,
      frequencySeHz: se(seIndex),
      amplitudeMm: amplitude(rings, f, zeta),
      cornerLocked: cornerLockingShown(cornerPhasors(bases, rings)),
    },
    rings,
  })
  return { modes: [mode(rings1, theta[0], theta[1], 0), mode(rings2, theta[2], theta[3], 2)] }
}

/**
 * The boundary likelihood-ratio statistic of zeta = 0 (Self and Liang 1987): the whitened SSR of
 * the undamped fit (f and tau re-optimized) minus that of the full fit, over sigma^2; zero when
 * the fit already sits at zeta = 0.
 */
function decayStatistic(bases: LineBasis[], noises: LineNoise[], joint: JointFit, tauBounds: [number, number]): number {
  if (!(joint.dampingRatio > 0) || !(joint.sigma2 > 0)) return 0
  const undamped = varproFit(
    bases,
    noises,
    [joint.frequencyHz, 0, Math.log(joint.tauS)],
    [true, false, true],
    tauBounds,
  )
  return Math.max(0, (undamped.lm.ssr - joint.lm.ssr) / joint.sigma2)
}


/** Grid indices whose frequency lies within MAX_CI95_REL of any of the centers. */
function localGrid(centers: number[]): number[] {
  const out: number[] = []
  DETECTION_GRID.forEach((p, g) => {
    if (centers.some((c) => Math.abs(p.frequencyHz - c) <= MAX_CI95_REL * c)) out.push(g)
  })
  return out
}

/** The three-way two-tier speed check (closed testing on local grids, then the d test) on the
 *  joint-fit lines `included`: each tier's detection over its own lines' likelihood ratio fields,
 *  its frequency fitted on the lines' joint-fit windows `inBases` with their full-fit noise models
 *  `noise1` (both aligned with included), from the tier's own maximum over the local grid, or,
 *  given `tierSeed`, from the point it returns for the tier's lines and the local grid. */
function speedCheck(
  states: LineState[],
  included: number[],
  inBases: LineBasis[],
  noise1: LineNoise[],
  joint: JointFit,
  speedsMmS: number[],
  tauBounds: [number, number],
  tierSeed: ((lines: number[], points: number[]) => RingPoint) | null = null,
): SpeedCheck {
  if (speedsMmS.length < 2) return NOT_ASSESSED_SPEED
  const slow = Math.min(...speedsMmS)
  const fast = Math.max(...speedsMmS)
  const rho = fast / slow
  const points = localGrid([joint.frequencyHz, joint.frequencyHz * rho, joint.frequencyHz / rho])
  const tiers: TierCheck[] = [slow, fast].map((v) => {
    const members = included.map((l, k) => (states[l].basis.rec.speedMmS === v ? k : -1)).filter((k) => k >= 0)
    const blank: TierCheck = { speedMmS: v, detected: false, detectionPBound: null, frequencyHz: null, frequencySeHz: null }
    if (members.length === 0 || points.length === 0) return blank
    const local = refittedMaximum(states, members.map((k) => included[k]), points)
    const pBound = bonferroni(points.length, local.value, 2 * members.length)
    const detected = pBound <= DETECTION_ALPHA
    if (!detected) return { ...blank, detectionPBound: pBound }
    const seed = tierSeed ? tierSeed(members.map((k) => included[k]), points) : DETECTION_GRID[local.index]
    const fit = varproFit(
      members.map((k) => inBases[k]),
      members.map((k) => noise1[k]),
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

/** One tier: the detection must survive leaving out any single line, the detection test repeated
 *  with each line deleted in turn (a leave-one-out influence check). */
function influenceCheck(states: LineState[]): CheckState {
  const K = states.length
  if (K < 2) return 'failed'
  const G = DETECTION_GRID.length
  for (let left = 0; left < K; left++) {
    const others = states.map((_, l) => l).filter((l) => l !== left)
    if (bonferroni(G, refittedMaximum(states, others).value, 2 * (K - 1)) > DETECTION_ALPHA) return 'failed'
  }
  return 'passed'
}

/**
 * Cochran's Q over the detected joint-fit lines' own frequencies, each fitted with its full-fit
 * noise model and the axis tau, starting from the joint estimate: the check asks whether the
 * lines agree on the axis's mode, so every line's fit seeks the local optimum of that mode.
 * Returns the state and each line's frequency, aligned with `bases`.
 */
function replicateCheck(
  bases: LineBasis[],
  noises: LineNoise[],
  joint: JointFit,
  tauBounds: [number, number],
): { state: CheckState; frequencies: number[] } {
  const frequencies: number[] = []
  const estimates: { f: number; se: number }[] = []
  bases.forEach((basis, j) => {
    const fit = varproFit(
      [basis],
      [noises[j]],
      [joint.frequencyHz, joint.dampingRatio, Math.log(joint.tauS)],
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

