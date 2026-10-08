import type { TracedLine } from './lineTracer'
import type { CheckState, SpeedCheck, TierCheck } from './resultTypes'
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
  cornerDeficit,
  ringColumns,
} from './ringRegressors'
import {
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
import type { LineBasis, LineNoise, LineRecord, LmResult, NullDesign, RingProjection } from './ringGls'
import {
  cruiseSampleIntervalS,
  heldNoiseStatistic,
  noiseSpectrumPeaks,
  nullHypothesisFit,
  ringLikelihoodRatio,
} from './ringLikelihood'
import type { NullFit, RingPoint, RingRatio } from './ringLikelihood'
import { gridCandidates, knownCandidates, searchStage } from './artifactSearch'
import { proportionalityCheck } from './inputProportionality'
import type { DetectedArtifact } from './artifactSearch'
import type { CornerModelKind } from './ringRegressors'
import { defaultMaxArOrder } from '../correlatedNoise'
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
//    grid G (FREQUENCY_GRID_HZ x ZETA_GRID, |G| = 1,703) is paid by the Bonferroni bound
//    pBound = min(1, |G| P(chi2_2K >= max_G Q)) (Dunn 1961); a lower bound of Q can only raise
//    pBound, so the bound stays valid. Per-line labels use the same bound on each line's own
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
//    - Input proportionality (output-error model, Ljung 1999): the ring is the linear response
//      to the corner's velocity step, so each line's ring amplitude is its rung's corner speed
//      times one scale per speed tier, through zero. The intercept of the least squares
//      regression of the per-line amplitudes on the corner speeds is t-tested against zero with
//      the lines' own scatter as the error (Student 1908); a forced tone (rung-independent
//      amplitude) has a large intercept and fails it.
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

/** A second mode of an accepted axis: detected with the first mode in the null design, then
 *  fitted jointly with it. */
export interface SecondMode {
  frequencyHz: number
  dampingRatio: number
  /** Standard error of the frequency from the two-mode fit, Hz; null when not estimable. */
  frequencySeHz: number | null
  /** Median over the lines of the mode's amplitude at the fit-window start, mm. */
  amplitudeMm: number
  /** Input proportionality of this mode: 'failed' marks a steady tone, not a mode. */
  proportionality: CheckState
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
  /** The boundary LRT statistic of zeta = 0 (0.5 chi2_0 + 0.5 chi2_1 under an undamped ring). */
  decayStatistic: number | null
  /** Input-proportionality test: passed when the ring grows with the corner speed. */
  proportionality: CheckState
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
  const plain = bases.map((b, l) => nullHypothesisFit(b, initial[l].fit, tau, 0, fixedModes))
  const noises = plain.map((h) => h.noise)
  if (axisVarianceSlope(bases, noises, plain.map((h) => h.residual), tau) === 0) return plain
  // A ring the null model leaves in its residual also raises the early variance. The variance
  // function is kept only if its test still rejects once every line's own strongest ring
  // candidate (the maximum of its held-noise field) is removed by GLS, and its slope is then
  // estimated from those residuals: a rougher bead does not go away with a ring.
  const withoutRing = bases.map((b, l) => residualWithoutStrongestRing(b, plain[l]))
  const slope = axisVarianceSlope(bases, noises, withoutRing, tau)
  if (slope === 0) return plain
  return bases.map((b, l) => nullHypothesisFit(b, plain[l].noise.fit, tau, slope, fixedModes))
}

/** The raw residual of a line's null fit with its strongest held-noise ring candidate added. */
function residualWithoutStrongestRing(basis: LineBasis, h0: NullFit): Float64Array {
  const field = heldNoiseField(basis, h0)
  let best = 0
  for (let g = 1; g < field.length; g++) if (field[g] > field[best]) best = g
  const point = DETECTION_GRID[best]
  const scratch = ringScratch(basis.m)
  const ring = projectRing(basis, h0.noise, h0.design, point.frequencyHz, point.dampingRatio, scratch, new Float64Array(h0.design.k), new Float64Array(h0.design.k))
  return rawFullResidual(basis, h0.noise, h0.design, point.frequencyHz, point.dampingRatio, ring, scratch)
}

/** The flow-lag time constant of the axis's ordinary least squares null fits. */
function olsTau(bases: LineBasis[], tauBounds: [number, number]): number {
  return minimizeOverLogTau(
    (tau) => bases.reduce((s, b) => s + olsNullSsr(b, tau), 0),
    tauBounds[0],
    tauBounds[1],
  )
}

/** Critical value of the chi2_1 likelihood ratio test of a constant innovation variance. */
const VARIANCE_CRITICAL = normalQuantile(1 - DETECTION_ALPHA / 2) ** 2

/**
 * The slope of the axis's innovation variance function (ringGls.pooledVarianceSlope) from the
 * lines' raw residuals under their AR models, or 0 when the likelihood ratio test does not reject
 * a constant variance at DETECTION_ALPHA.
 */
function axisVarianceSlope(bases: LineBasis[], noises: LineNoise[], residuals: Float64Array[], tauS: number): number {
  const deficits = bases.map((b) => cornerDeficit(b.rec.tS, b.rec, b.cornerModel, tauS))
  const innovations = residuals.map((r, l) => noises[l].whitener.whiten(r))
  const pooled = pooledVarianceSlope(innovations, deficits)
  return pooled.statistic > VARIANCE_CRITICAL ? pooled.slope : 0
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
): { bases: LineBasis[]; fits: NullFit[]; kind: CornerModelKind; flowScale: number; beadScale: number } {
  const bases = carriedBases(windows, flow.carried, 'bead-drag')
  const fits = nullFits(bases, tauRange(bases))
  const scales = { flowScale: flow.fits[0].tauS, beadScale: fits[0].tauS }
  return pooledAicc(fits, bases) < pooledAicc(flow.fits, flow.bases)
    ? { bases, fits, kind: 'bead-drag', ...scales }
    : { bases: flow.bases, fits: flow.fits, kind: 'flow-lag', ...scales }
}

/** One line's detection state for a null fit (see detectionStates). */
function lineState(basis: LineBasis, h0: NullFit): LineState {
  const state: LineState = { basis, h0, field: heldNoiseField(basis, h0), refitted: new Map() }
  for (const f of noiseSpectrumPeaks(h0.noise.fit, cruiseSampleIntervalS(basis))) refine(state, gridIndex(f, ZETA_GRID[0]))
  return state
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
 * with its record.
 */
export function poolAxisFits(fits: LineFit[], speedsMmS: number[]): AxisPool {
  return poolWithArtifacts(fits, speedsMmS, null)
}

/** poolAxisFits with the patterns to carry given (`preset`, no search) or searched (null). */
function poolWithArtifacts(fits: LineFit[], speedsMmS: number[], preset: CarriedArtifacts | null): AxisPool {
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
    decayStatistic: null,
    proportionality: 'not-assessed',
    speedCheck: NOT_ASSESSED_SPEED,
    replicateCheck: 'not-assessed',
    influenceCheck: 'not-assessed',
    secondModePBound: null,
    secondMode: null,
    artifacts: [],
    cornerModel: null,
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

  // Detection stage: the artifact search, the null fits, the likelihood ratio fields, the axis
  // bound.
  const windows = windowed.map((i) => fits[i].window!)
  const searched = withArtifacts(windows, speedsMmS, preset, [], preset === null)
  const chosen = chooseCornerModel(windows, searched)
  const bases = chosen.bases
  const tauBounds = tauRange(bases)
  const states = chosen.fits.map((h0, l) => lineState(bases[l], h0))
  base.artifacts = searched.carried.artifacts
  base.cornerModel = { kind: chosen.kind, scale: chosen.fits[0].tauS }
  const tau0 = states[0].h0.tauS
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

  // Per-line fits of the detected lines (the line's noise model refitted under the alternative at
  // its own maximum, the axis tau), for screening.
  const lineFits = new Map<number, JointFit>()
  states.forEach((s, l) => {
    if (!verdicts[windowed[l]].detected) return
    const own = ownMaxima[l].index
    const seed = DETECTION_GRID[own]
    lineFits.set(
      l,
      varproFit([s.basis], [refine(s, own).fit.noise], [seed.frequencyHz, seed.dampingRatio, Math.log(tau0)], [true, true, false], tauBounds),
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

  // Joint variable projection with each line's noise model refitted under the alternative at the
  // seed, then the second feasible GLS step with the noise refitted to the full-fit residuals.
  // The ring is estimated in the model that encompasses both corner models (the flow-lag columns,
  // their time constant free, and the bead-drag lobe at its null-fit length), so its interval does
  // not rest on the AICc choice: an interval computed in the model a criterion selected is too
  // narrow (H. Leeb and B. M. Potscher, "Model selection and inference: facts and fiction",
  // Econometric Theory 21, 2005).
  const inBases = included.map((l) =>
    lineBasis(windows[l], [], 'flow-lag', [
      ...searched.carried.columns[l],
      ...cornerColumns(windows[l].tS, windows[l], 'bead-drag', chosen.beadScale),
    ]),
  )
  const estBounds = tauRange(inBases)
  const seedIndex = refittedMaximum(states, included).index
  const seed = DETECTION_GRID[seedIndex]
  const noiseAtSeed = included.map((l, k) => {
    const noise = refine(states[l], seedIndex).fit.noise
    return noiseModel(inBases[k], noise.fit, noise.varianceSlope, cornerDeficit(inBases[k].rec.tS, inBases[k].rec, 'flow-lag', chosen.flowScale))
  })
  const first = varproFit(
    inBases,
    noiseAtSeed,
    [seed.frequencyHz, seed.dampingRatio, Math.log(chosen.flowScale)],
    [true, true, true],
    estBounds,
  )
  const residuals1 = inBases.map((b, k) => {
    const design = nullDesign(b, noiseAtSeed[k], first.tauS)
    const ring = projectRing(b, noiseAtSeed[k], design, first.frequencyHz, first.dampingRatio, ringScratch(b.m), new Float64Array(design.k), new Float64Array(design.k))
    return rawFullResidual(b, noiseAtSeed[k], design, first.frequencyHz, first.dampingRatio, ring, ringScratch(b.m))
  })
  const ar1 = inBases.map((b, k) => fitNoise(b, residuals1[k]))
  const slope1 = axisVarianceSlope(inBases, ar1, residuals1, first.tauS)
  const noise1 =
    slope1 === 0
      ? ar1
      : inBases.map((b, k) => noiseModel(b, ar1[k].fit, slope1, cornerDeficit(b.rec.tS, b.rec, b.cornerModel, first.tauS)))
  const joint = varproFit(
    inBases,
    noise1,
    [first.frequencyHz, first.dampingRatio, Math.log(first.tauS)],
    [true, true, true],
    estBounds,
  )
  // A ring left out of the first artifact search leaks into the artifact columns on its own tier
  // and makes an artifact's amplitude grow with the corner speed: the search runs again with the
  // fitted ring in the null design, and the analysis is repeated with whatever more it finds.
  if (preset === null && speedsMmS.length >= 2) {
    const again = withArtifacts(windows, speedsMmS, searched.carried, [{ frequencyHz: joint.frequencyHz, dampingRatio: joint.dampingRatio }], true, chosen.kind)
    if (again.carried.artifacts.length > searched.carried.artifacts.length) return poolWithArtifacts(fits, speedsMmS, again.carried)
  }
  base.cornerModel = { kind: chosen.kind, scale: chosen.kind === 'flow-lag' ? joint.tauS : chosen.beadScale }
  const interval = profileFrequencyInterval(inBases, noise1, joint, estBounds)
  const se = interval ? (interval.upper - interval.lower) / (2 * interval.critical) : null
  const ci95 = interval ? Math.max(interval.upper - joint.frequencyHz, joint.frequencyHz - interval.lower) : null
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

  // Diagnostics and checks.
  base.decayStatistic = decayStatistic(inBases, noise1, joint, estBounds)
  base.decayDemonstrated = base.decayStatistic > DECAY_CRITICAL
  base.proportionality = proportionalityCheck(inBases, rings.map((r) => Math.hypot(r.a, r.b)))
  base.speedCheck = speedCheck(states, included, inBases, noise1, joint, speedsMmS, estBounds)
  base.influenceCheck = speedsMmS.length === 1 ? influenceCheck(states) : 'not-assessed'
  const detectedK = included.map((l, k) => (verdicts[windowed[l]].detected ? k : -1)).filter((k) => k >= 0)
  const replicate = replicateCheck(
    detectedK.map((k) => inBases[k]),
    detectedK.map((k) => noise1[k]),
    joint,
    estBounds,
  )
  base.replicateCheck = replicate.state
  replicate.frequencies.forEach((f, j) => (verdicts[windowed[included[detectedK[j]]]].frequencyHz = f))

  // A second mode, searched before the verdict: an unmodeled second mode distorts the single-mode
  // fit's per-line amplitudes, so with one the dominant mode's proportionality comes from the
  // two-mode fit.
  Object.assign(base, withSecondMode(base, inBases, noise1, joint, estBounds))

  // Verdict, the most specific failing gate first.
  const result = { ...base }
  // The dominant mode's figures: the two-mode fit's when a second mode was found.
  const f = result.frequencyHz!
  if (f <= F_MIN_HZ + BOUND_MARGIN_HZ || f >= F_MAX_HZ - BOUND_MARGIN_HZ) {
    return refuse(
      `The frequency fitted across the axis's lines sits at the edge of the ${F_MIN_HZ} to ` +
        `${F_MAX_HZ} Hz search range, so it cannot be trusted. The true resonance likely ` +
        'lies outside the measurable range.',
      result,
    )
  }
  if (result.dampingRatio! >= ZETA_MAX) {
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
        'that line could have caused it. Rescan the coupon, or reprint it at a line speed of at ' +
        `least ${MIN_TWO_TIER_LINE_SPEED_MM_S} mm/s on a bed large enough for both speed tiers.`,
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
  if (result.frequencyCi95Hz === null || result.frequencyCi95Hz > MAX_CI95_REL * f) {
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
 * Sequential forward detection of a second mode (B. G. Quinn and E. J. Hannan, "The Estimation
 * and Tracking of Frequency", Cambridge University Press 2001, ch. 5): the first mode's ring
 * columns join every line's null design, and the same likelihood ratio field, refits and
 * Bonferroni bound over the grid test for a further ring at DETECTION_ALPHA. On detection both
 * modes are fitted jointly by variable projection over (f1, zeta1, f2, zeta2, log tau) with each
 * line's linear terms, polished by Levenberg-Marquardt; covariance sigma^2 (J'J)^-1. The axis then
 * reports the dominant mode (the larger median amplitude) and the other as its second mode, with
 * the input-proportionality check of that mode.
 */
function withSecondMode(
  pool: AxisPool,
  bases: LineBasis[],
  noises: LineNoise[],
  joint: JointFit,
  tauBounds: [number, number],
): Partial<AxisPool> {
  const mode1 = { frequencyHz: joint.frequencyHz, dampingRatio: joint.dampingRatio }
  const states = bases.map((b, k) => lineState(b, nullHypothesisFit(b, noises[k].fit, joint.tauS, noises[k].varianceSlope, [mode1])))
  const all = states.map((_, l) => l)
  const top = refittedMaximum(states, all)
  const pBound = bonferroni(DETECTION_GRID.length, top.value, 2 * states.length)
  if (!(pBound <= DETECTION_ALPHA)) return { secondModePBound: pBound }
  const seed = DETECTION_GRID[top.index]
  const fit = twoModeFit(bases, noises, [joint.frequencyHz, joint.dampingRatio, seed.frequencyHz, seed.dampingRatio, Math.log(joint.tauS)], tauBounds)
  if (fit === null) return { secondModePBound: pBound }
  const [m1, m2] = fit.modes[0].amplitudeMm >= fit.modes[1].amplitudeMm ? fit.modes : [fit.modes[1], fit.modes[0]]
  return {
    frequencyHz: m1.frequencyHz,
    dampingRatio: m1.dampingRatio,
    frequencySeHz: m1.frequencySeHz,
    frequencyCi95Hz: m1.frequencySeHz !== null ? normalQuantile(0.975) * m1.frequencySeHz : pool.frequencyCi95Hz,
    amplitudeMm: m1.amplitudeMm,
    proportionality: m1.proportionality,
    secondModePBound: pBound,
    secondMode: m2,
  }
}

/** The joint fit of two modes; null when the fit degenerates (both modes on one frequency). */
function twoModeFit(
  bases: LineBasis[],
  noises: LineNoise[],
  start: number[],
  tauBounds: [number, number],
): { modes: [SecondMode, SecondMode] } | null {
  const lower = [F_MIN_HZ, 0, F_MIN_HZ, 0, Math.log(tauBounds[0])]
  const upper = [F_MAX_HZ, ZETA_MAX, F_MAX_HZ, ZETA_MAX, Math.log(tauBounds[1])]
  const project = (theta: number[], which: 0 | 1, residualOut?: (k: number) => Float64Array) =>
    bases.map((b, k) => {
      const [fa, za, fb, zb] = which === 1 ? [theta[0], theta[1], theta[2], theta[3]] : [theta[2], theta[3], theta[0], theta[1]]
      const design = nullDesign(b, noises[k], Math.exp(theta[4]), ringColumns(b.rec.tS, fa, za))
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
    median(rings.map((r, k) => Math.hypot(r.a, r.b) * Math.exp(-zeta * 2 * Math.PI * f * bases[k].rec.tS[0])))
  const mode = (rings: RingProjection[], f: number, zeta: number, seIndex: number): SecondMode => ({
    frequencyHz: f,
    dampingRatio: zeta,
    frequencySeHz: se(seIndex),
    amplitudeMm: amplitude(rings, f, zeta),
    proportionality: proportionalityCheck(bases, rings.map((r) => Math.hypot(r.a, r.b))),
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
 *  `noise1` (both aligned with included). */
function speedCheck(
  states: LineState[],
  included: number[],
  inBases: LineBasis[],
  noise1: LineNoise[],
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
    const members = included.map((l, k) => (states[l].basis.rec.speedMmS === v ? k : -1)).filter((k) => k >= 0)
    const blank: TierCheck = { speedMmS: v, detected: false, detectionPBound: null, frequencyHz: null, frequencySeHz: null }
    if (members.length === 0 || points.length === 0) return blank
    const local = refittedMaximum(states, members.map((k) => included[k]), points)
    const pBound = bonferroni(points.length, local.value, 2 * members.length)
    const detected = pBound <= DETECTION_ALPHA
    if (!detected) return { ...blank, detectionPBound: pBound }
    const seed = DETECTION_GRID[local.index]
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

/** One tier: the detection must survive leaving out any single line (Cook 1977). */
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
