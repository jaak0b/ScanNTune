import { Matrix, solve, inverse } from 'ml-matrix'
import type { TracedLine } from './lineTracer'

// Fits the ringing model to each traced line, screens the lines, and estimates the axis's
// frequency and damping by a JOINT fit across all screened lines: the resonance is one
// machine property shared by every line, so the lines share the nonlinear parameters
// (f, zeta) while each keeps its own linear background and ring amplitude/phase. A weak or
// noisy line that could not carry a per-line verdict still contributes its share of the
// pooled information. The stages, each an established method:
//
// 1. Detrend: a Gaussian regression filter (ISO 16610-21 profile filtering), the standard
//    surface-metrology separation of waviness from the signal band, as high-frequency
//    conditioning. Drift slower than the record length passes this filter almost unchanged,
//    which is why the model below carries its own first-order polynomial background term
//    (standard background modeling in nonlinear regression) instead of a stronger filter,
//    whose transmission skirt would reach into the ring band and bias the estimate.
// 2. Forced-transient exclusion: the corner produces a large FORCED overshoot (the command
//    response), roughly three times the free-ring amplitude and not described by the free
//    decay whose frequency and damping are wanted. The fit window starts at the first zero
//    crossing after the overshoot peak, where the free ringdown begins; only the free
//    response is fit.
// 3. Frequency seed: maximization of the periodogram evaluated on a dense frequency grid
//    (Rife & Boorstyn 1974, the maximum-likelihood frequency estimator for a sinusoid in
//    white Gaussian noise), computed on the trimmed, linearly detrended window, with the
//    direct DTFT sums handling the slightly non-uniform sample times.
// 4. Fit: variable projection (Golub & Pereyra 1973). With the ring written in quadrature
//    form its amplitude/phase and the background line are LINEAR parameters, solved exactly
//    per (f, zeta) by least squares; only (f, zeta) are searched, on a grid around the seed
//    (+/-20%, so the fit stays in the periodogram's basin instead of side lobes), then
//    polished by Levenberg-Marquardt over all six parameters (Levenberg 1944, Marquardt
//    1963; multiplicative lambda control as in Madsen, Nielsen & Tingleff, "Methods for
//    Non-Linear Least Squares Problems").
// 5. Joint estimation: variable projection across records with shared nonlinear parameters
//    (Golub & Pereyra 1973): for fixed (f, zeta) the linear solve is block-diagonal (one
//    exact least-squares solve per line), so the projected functional is the sum of per-line
//    residual sums. (f, zeta) are searched on a grid around the joint seed, then polished by
//    Levenberg-Marquardt on the reduced two-parameter functional, whose Jacobian is a forward
//    difference of the fully re-solved projected residual: a numerical form of the exact
//    Golub-Pereyra variable projection Jacobian, not Kaufman's simplification of it.
// 6. Acceptance: an extra-sum-of-squares F-test of the joint ring model against the nested
//    per-line drift-only null (Seber & Wild, "Nonlinear Regression", 1989, ch. 5), so the
//    axis verdict is a single significance test over all pooled samples instead of per-line
//    amplitude or fit-quality gates.
// 7. Uncertainty: the asymptotic covariance of the nonlinear least-squares estimate,
//    sigma^2 (J^T J)^-1 on the full stacked Jacobian (Seber & Wild 1989), which for Gaussian
//    noise attains the Cramer-Rao bound of the damped-sinusoid model (Yao & Pandit, IEEE
//    Trans. Signal Processing 43(11), 1995).
//
// Model, t measured from the fit-window start:
//   lateral(t) = c0 + c1 * t                                  (background line: drift)
//              + exp(-2 pi f zeta t) * (a * cos(2 pi f sqrt(1 - zeta^2) t)
//                                     + b * sin(2 pi f sqrt(1 - zeta^2) t))
// The damped quadrature pair is the free response of the second-order underdamped machine
// axis; reported amplitude is sqrt(a^2 + b^2) and phase atan2(-b, a).

export { F_MIN_HZ, F_MAX_HZ, MIN_ACCEPTED_LINES } from './types'
import { DETECTION_ALPHA, F_MIN_HZ, F_MAX_HZ, MAX_CI95_REL, MIN_ACCEPTED_LINES } from './types'
/** Grid step of the periodogram seed search. */
export const PERIODOGRAM_GRID_HZ = 0.5
/**
 * At-bounds margin: two periodogram grid steps. A true resonance just outside the search
 * range seeds at the range edge and the refinement follows it back to the boundary region,
 * so anything within two seed-grid steps of an edge is treated as "at the bound" rather than
 * a trustworthy interior optimum.
 */
export const BOUND_MARGIN_HZ = 2 * PERIODOGRAM_GRID_HZ
export const ZETA_MIN = 0.001
export const ZETA_MAX = 0.4
/**
 * Detection threshold: the fitted ring amplitude must exceed this multiple of the noise
 * floor RMS. The envelope of Gaussian noise is Rayleigh distributed (Rice 1944); it exceeds
 * 4 sigma with probability exp(-8) ~ 3e-4 per independent sample, so an amplitude at 4x the
 * noise RMS is a detection rather than a noise excursion, with margin over the plain
 * 3-sigma rule.
 */
export const AMPLITUDE_DETECTION_K = 4
/** Coefficient-of-determination floor below which a per-line fit is labeled 'low-r2'
 *  (a screening label and diagnostic; it does not decide the axis). */
export const MIN_R2 = 0.5
/** Significance level of the axis-acceptance F-test: the flow's detection level. */
export const F_TEST_ALPHA = DETECTION_ALPHA
/**
 * Conservative resolvability guard on the pooled ring amplitude, in scan pixels. Sub-pixel
 * centroid estimators carry systematic pixel-locking (peak-locking) position errors on the
 * order of 0.05 to 0.1 px (the figures documented in the particle image velocimetry
 * literature), and those errors are coherent across parallel traced lines, so a pooled
 * amplitude at or below that scale cannot be told apart from a coherent sampling artifact
 * even when it is statistically significant. This is not a model of the bias; it is the
 * scale below which an amplitude is not accepted as a measurement.
 */
export const AMPLITUDE_RESOLUTION_PX = 0.05
/**
 * Replicate agreement and speed invariance tolerance: the larger of 2 Hz and 5% of the
 * median frequency. Klipper-style input shapers keep their vibration suppression within
 * roughly +/-5-10% of the target frequency, so replicates scattered wider than 5% would
 * already defeat the shaper the result is meant to configure.
 */
const AGREEMENT_REL = 0.05
const AGREEMENT_MIN_HZ = 2
import { MAD_TO_SIGMA, fCriticalValue, mad, median } from '../math'

export interface RingModelParams {
  /** Background line at the fit-window start, mm. */
  backgroundMm: number
  /** Background line slope, mm per second. */
  backgroundSlopeMmPerS: number
  ringAmpMm: number
  frequencyHz: number
  dampingRatio: number
  phaseRad: number
}

/**
 * Why a traced line's fit was refused, as a category: 'weak-ringing' is an amplitude below
 * the detection threshold (the line looks smooth), 'irregular-trace' is a trace that wiggles
 * but not like a decaying ring (print defect or scan artifact), 'out-of-band' is a fit at
 * the edge of the frequency search range (the resonance likely lies outside it).
 */
export type LineFitRefusalCategory = 'weak-ringing' | 'irregular-trace' | 'out-of-band'

/**
 * Screening classification of one traced line, deciding joint-fit membership. 'clean',
 * 'weak-ringing', 'low-r2', and 'fit-failed' lines ENTER the joint fit: a weak or poorly
 * fitting line still carries the shared resonance, and the joint estimate rescues it. The
 * remaining categories are exclusions whose traces contradict the model or the spectrum, so
 * they never influence the axis verdict.
 */
export type LineScreening =
  | 'clean'
  | 'weak-ringing'
  | 'low-r2'
  | 'fit-failed'
  | 'no-free-response'
  | 'out-of-band'
  | 'seed-disagreement'
  | 'zeta-at-bound'

/** Why a line was excluded from the joint fit: the excluding screening categories plus the
 *  pool-level Hampel frequency-outlier screen. */
export type LineJointExclusion =
  | 'no-free-response'
  | 'out-of-band'
  | 'seed-disagreement'
  | 'zeta-at-bound'
  | 'frequency-outlier'

/** One line's free-ringdown fit window: the joint fit's per-line record. */
export interface JointFitRecord {
  /** Seconds since the fit-window start. */
  tS: Float64Array
  /** Detrended lateral deviation, mm. */
  y: Float64Array
}

export interface LineFit {
  /** True when the per-line fit passed every per-line gate. Diagnostic only: the axis
   *  verdict is the joint fit's F-test, not any per-line gate. */
  accepted: boolean
  screening: LineScreening
  refusalReason: string | null
  refusalCategory: LineFitRefusalCategory | null
  params: RingModelParams | null
  r2: number
  noiseRmsMm: number
  /** Cramer-Rao standard error of the per-line frequency, Hz (diagnostic). */
  frequencySeHz: number | null
  /** The line's fit window, consumed by the joint fit; null only when the trace has no
   *  free-response window. */
  window: JointFitRecord | null
}

/** Joint-fit membership of one line, aligned with `poolAxisFits`'s fits argument. */
export type LineJointStatus =
  | { usedInJointFit: true; amplitudeMm: number | null }
  | { usedInJointFit: false; exclusion: LineJointExclusion }

export interface AxisPool {
  accepted: boolean
  /** The axis-level verdict of a refused axis; empty when accepted. */
  refusals: string[]
  /**
   * The generic rescan remedy that goes with a refusal (the scanner's lamp shadow is the
   * usual cause), kept apart from the verdict so a remedy specific to the coupon can replace
   * it; null when the refusal carries none.
   */
  rescanAdvice: string | null
  frequencyHz: number | null
  dampingRatio: number | null
  /** 95% confidence halfwidth of the jointly fitted frequency, Hz. */
  frequencyCi95Hz: number | null
  /** Standard error of the jointly fitted frequency, Hz (asymptotic NLS covariance). */
  frequencySeHz: number | null
  /** Extra-sum-of-squares F statistic of the joint ring model against drift only. */
  fStatistic: number | null
  amplitudeMm: number | null
  linesUsed: number
  /** Joint-fit membership per input fit, aligned with the fits argument. */
  lineJoint: LineJointStatus[]
}

/** The ringing model evaluated at time t (seconds since the fit-window start). */
export function ringModel(p: RingModelParams, t: number): number {
  const omega = 2 * Math.PI * p.frequencyHz
  const damped = omega * Math.sqrt(Math.max(0, 1 - p.dampingRatio * p.dampingRatio))
  return (
    p.backgroundMm +
    p.backgroundSlopeMmPerS * t +
    p.ringAmpMm * Math.exp(-omega * p.dampingRatio * t) * Math.cos(damped * t + p.phaseRad)
  )
}

/**
 * Gaussian regression filter trend (ISO 16610-21 style, zeroth order): a Gaussian-weighted
 * moving average with per-sample weight normalization (the regression form, which keeps the
 * trend unbiased at the profile ends). `cutoffS` is the period at which the trend's
 * transmission is 50%; alpha = sqrt(ln 2 / pi) per the standard.
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

/** Periodogram-maximization frequency seed (Rife & Boorstyn 1974) on a dense grid. */
function seedFrequency(tS: Float64Array, y: Float64Array): { fHz: number; phase: number; amp: number } {
  const n = y.length
  let bestF = F_MIN_HZ
  let bestP = -1
  let bestRe = 0
  let bestIm = 0
  for (let f = F_MIN_HZ; f <= F_MAX_HZ; f += PERIODOGRAM_GRID_HZ) {
    const w = 2 * Math.PI * f
    let re = 0
    let im = 0
    for (let k = 0; k < n; k++) {
      re += y[k] * Math.cos(w * tS[k])
      im -= y[k] * Math.sin(w * tS[k])
    }
    const p = re * re + im * im
    if (p > bestP) {
      bestP = p
      bestF = f
      bestRe = re
      bestIm = im
    }
  }
  return {
    fHz: bestF,
    phase: Math.atan2(bestIm, bestRe),
    amp: (2 * Math.sqrt(bestP)) / n,
  }
}

// Internal quadrature parameter vector: [c0, c1, a, b, f, zeta]. The first four are the
// linear parameters of the variable projection; f sits at FREQ_INDEX for the covariance.
const PARAM_COUNT = 6
const FREQ_INDEX = 4

function quadratureModel(v: number[], t: number): number {
  const omega = 2 * Math.PI * v[4]
  const zeta = v[5]
  const damped = omega * Math.sqrt(Math.max(0, 1 - zeta * zeta))
  const env = Math.exp(-omega * zeta * t)
  return v[0] + v[1] * t + env * (v[2] * Math.cos(damped * t) + v[3] * Math.sin(damped * t))
}

function vectorToParams(v: number[]): RingModelParams {
  return {
    backgroundMm: v[0],
    backgroundSlopeMmPerS: v[1],
    ringAmpMm: Math.hypot(v[2], v[3]),
    frequencyHz: v[4],
    dampingRatio: v[5],
    phaseRad: Math.atan2(-v[3], v[2]),
  }
}

function residuals(v: number[], tS: Float64Array, y: Float64Array): Float64Array {
  const r = new Float64Array(y.length)
  for (let i = 0; i < y.length; i++) r[i] = y[i] - quadratureModel(v, tS[i])
  return r
}

/**
 * The variable projection inner step (Golub & Pereyra 1973): for fixed (f, zeta) the model is
 * linear in [c0, c1, a, b], solved exactly by least squares on the normal equations. Returns
 * the full parameter vector and its residual sum of squares.
 */
function varproSolve(
  fHz: number,
  zeta: number,
  tS: Float64Array,
  y: Float64Array,
): { v: number[]; ssr: number } | null {
  const n = y.length
  const omega = 2 * Math.PI * fHz
  const damped = omega * Math.sqrt(Math.max(0, 1 - zeta * zeta))
  const basis = new Array<Float64Array>(4)
  for (let j = 0; j < 4; j++) basis[j] = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const t = tS[i]
    const env = Math.exp(-omega * zeta * t)
    basis[0][i] = 1
    basis[1][i] = t
    basis[2][i] = env * Math.cos(damped * t)
    basis[3][i] = env * Math.sin(damped * t)
  }
  const ata = Matrix.zeros(4, 4)
  const atb = Matrix.zeros(4, 1)
  for (let j = 0; j < 4; j++) {
    for (let k = j; k < 4; k++) {
      let s = 0
      for (let i = 0; i < n; i++) s += basis[j][i] * basis[k][i]
      ata.set(j, k, s)
      ata.set(k, j, s)
    }
    let s = 0
    for (let i = 0; i < n; i++) s += basis[j][i] * y[i]
    atb.set(j, 0, s)
  }
  let lin: number[]
  try {
    lin = solve(ata, atb).to1DArray()
  } catch {
    // A singular basis (e.g. the envelope decayed to zero over the window) has no unique
    // linear solution; the caller skips this grid point.
    return null
  }
  const v = [lin[0], lin[1], lin[2], lin[3], fHz, zeta]
  return { v, ssr: ssr(residuals(v, tS, y)) }
}

function ssr(r: Float64Array): number {
  let s = 0
  for (let i = 0; i < r.length; i++) s += r[i] * r[i]
  return s
}

/**
 * Levenberg-Marquardt refinement of all model parameters (multiplicative lambda control,
 * forward-difference Jacobian). Returns the refined parameter vector and the Jacobian at the
 * solution for the covariance estimate.
 */
function levenbergMarquardt(
  v0: number[],
  tS: Float64Array,
  y: Float64Array,
): { v: number[]; jacobian: Matrix; ssr: number } {
  let v = v0.slice()
  let r = residuals(v, tS, y)
  let cost = ssr(r)
  let lambda = 1e-3
  let jac = numericJacobian(v, tS, y)

  for (let iter = 0; iter < 200; iter++) {
    const J = jac
    const JtJ = J.transpose().mmul(J)
    const Jtr = J.transpose().mmul(Matrix.columnVector(Array.from(r)))
    // Marquardt scaling: damp by lambda times the diagonal of JtJ.
    const damped = JtJ.clone()
    for (let i = 0; i < PARAM_COUNT; i++) {
      damped.set(i, i, JtJ.get(i, i) * (1 + lambda) + 1e-12)
    }
    let step: number[]
    try {
      step = solve(damped, Jtr).to1DArray()
    } catch {
      // A singular normal matrix at this damping: raise lambda and retry next iteration.
      lambda *= 10
      if (lambda > 1e12) break
      continue
    }
    const trial = v.map((vi, i) => vi + step[i])
    const rTrial = residuals(trial, tS, y)
    const costTrial = ssr(rTrial)
    if (costTrial < cost) {
      const improvement = (cost - costTrial) / Math.max(cost, 1e-300)
      v = trial
      r = rTrial
      cost = costTrial
      lambda = Math.max(lambda / 10, 1e-12)
      jac = numericJacobian(v, tS, y)
      if (improvement < 1e-10) break
    } else {
      lambda *= 10
      if (lambda > 1e12) break
    }
  }
  return { v, jacobian: jac, ssr: cost }
}

// Forward-difference Jacobian of the model (not the residual: d r / d p = -d model / d p,
// and the sign cancels in the normal equations as written above with r = y - model).
function numericJacobian(v: number[], tS: Float64Array, y: Float64Array): Matrix {
  const n = y.length
  const base = residuals(v, tS, y)
  const J = Matrix.zeros(n, PARAM_COUNT)
  for (let j = 0; j < PARAM_COUNT; j++) {
    const h = Math.max(1e-7, Math.abs(v[j]) * 1e-6)
    const vh = v.slice()
    vh[j] += h
    const rh = residuals(vh, tS, y)
    for (let i = 0; i < n; i++) J.set(i, j, (base[i] - rh[i]) / h)
  }
  return J
}

/** RMS of a slice. */
function rms(y: Float64Array, from: number, to: number): number {
  let s = 0
  let c = 0
  for (let i = from; i < to; i++) {
    s += y[i] * y[i]
    c++
  }
  return c > 0 ? Math.sqrt(s / c) : 0
}

/** Damping grid of the variable projection search (log-spaced over the physical range). */
const ZETA_GRID = [0.001, 0.002, 0.005, 0.01, 0.02, 0.035, 0.05, 0.075, 0.1, 0.15, 0.22, 0.3, 0.4]
/** Half-width of the frequency search around the periodogram seed, as a fraction. */
const SEED_BAND_REL = 0.2

/**
 * Fit-window start: the free ringdown begins at the first zero crossing after the forced
 * corner-overshoot peak (the largest excursion of the early trace). Returns null when the
 * trace never crosses zero in its first half, i.e. there is no free response to fit.
 */
function freeResponseStart(y: Float64Array): number | null {
  const n = y.length
  const peakSearchEnd = Math.floor(n / 4)
  // A trace too short to even search for the transient peak has no fit window either way.
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

/** Least-squares line through (t, y), used only to condition the periodogram seed input. */
function linearDetrend(tS: Float64Array, y: Float64Array): Float64Array {
  const n = y.length
  let st = 0
  let sy = 0
  let stt = 0
  let sty = 0
  for (let i = 0; i < n; i++) {
    st += tS[i]
    sy += y[i]
    stt += tS[i] * tS[i]
    sty += tS[i] * y[i]
  }
  const det = n * stt - st * st
  const slope = det !== 0 ? (n * sty - st * sy) / det : 0
  const icept = (sy - slope * st) / n
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) out[i] = y[i] - icept - slope * tS[i]
  return out
}

/**
 * Analyzes one traced line: Gaussian-filter detrend, forced-transient exclusion, periodogram
 * seed, variable projection grid, Levenberg-Marquardt polish, and the per-line refusal gates.
 */
export function analyzeTracedLine(line: TracedLine): LineFit {
  const tS = line.tS
  const n = tS.length

  // Detrend with the Gaussian regression filter; the cutoff period sits a factor 3 below the
  // lowest search frequency so the trend cannot eat the ring band. Drift slower than the
  // record survives this filter and is carried by the model's background line instead.
  const cutoffS = 3 / F_MIN_HZ
  const trend = gaussianTrend(tS, line.lateralMm, cutoffS)
  const y = new Float64Array(n)
  for (let i = 0; i < n; i++) y[i] = line.lateralMm[i] - trend[i]

  // Noise floor from the trace tail (the ring has decayed there), with the tail's own
  // least-squares line removed first: residual drift the Gaussian filter passes would
  // otherwise masquerade as noise and inflate the detection threshold.
  const noiseRmsMm = rms(
    linearDetrend(tS.subarray(line.noiseWindowStart), y.subarray(line.noiseWindowStart)),
    0,
    n - line.noiseWindowStart,
  )

  // Forced-transient exclusion: fit only the free ringdown after the corner-overshoot peak.
  const start = freeResponseStart(y)
  if (start === null) {
    return {
      accepted: false,
      screening: 'no-free-response',
      refusalReason:
        'The trace never settles from the corner transient into a free ringdown, so there is ' +
        'no resonance to fit. The trace may be corrupted by print defects or scan artifacts.',
      refusalCategory: 'irregular-trace',
      params: null,
      r2: 0,
      noiseRmsMm,
      frequencySeHz: null,
      window: null,
    }
  }
  const wN = n - start
  const t0 = tS[start]
  const tw = new Float64Array(wN)
  const yw = new Float64Array(wN)
  for (let i = 0; i < wN; i++) {
    tw[i] = tS[start + i] - t0
    yw[i] = y[start + i]
  }

  // Periodogram seed on the trimmed, linearly detrended window; the drift would otherwise
  // dominate the spectrum and pull the seed to the low band edge.
  const seed = seedFrequency(tw, linearDetrend(tw, yw))
  const fLo = Math.max(F_MIN_HZ, seed.fHz * (1 - SEED_BAND_REL))
  const fHi = Math.min(F_MAX_HZ, seed.fHz * (1 + SEED_BAND_REL))

  const window: JointFitRecord = { tS: tw, y: yw }

  // Variable projection grid over (f, zeta) inside the seed's basin, then LM polish.
  let best: { v: number[]; ssr: number } | null = null
  for (let f = fLo; f <= fHi; f += PERIODOGRAM_GRID_HZ) {
    for (const zeta of ZETA_GRID) {
      const trial = varproSolve(f, zeta, tw, yw)
      if (trial && (best === null || trial.ssr < best.ssr)) best = trial
    }
  }
  if (best === null) {
    // No per-line fit exists; the line still enters the joint fit, seeded by the joint seed.
    return {
      accepted: false,
      screening: 'fit-failed',
      refusalReason:
        'The ringing model could not be fit to this line on its own; the line was measured ' +
        'through the joint fit of the axis instead.',
      refusalCategory: 'irregular-trace',
      params: null,
      r2: 0,
      noiseRmsMm,
      frequencySeHz: null,
      window,
    }
  }
  const fit = levenbergMarquardt(best.v, tw, yw)
  const params = vectorToParams(fit.v)

  let sst = 0
  const mean = Array.from(yw).reduce((a, b) => a + b, 0) / wN
  for (let i = 0; i < wN; i++) sst += (yw[i] - mean) * (yw[i] - mean)
  const r2 = sst > 0 ? 1 - fit.ssr / sst : 0

  // Cramer-Rao standard error of the frequency from the asymptotic NLS covariance
  // sigma^2 (J^T J)^-1 at the solution (diagnostic; the axis uncertainty is the joint fit's).
  let frequencySeHz: number | null = null
  const dof = wN - PARAM_COUNT
  if (dof > 0) {
    const sigma2 = fit.ssr / dof
    try {
      const cov = inverse(fit.jacobian.transpose().mmul(fit.jacobian)).mul(sigma2)
      const varF = cov.get(FREQ_INDEX, FREQ_INDEX)
      if (varF > 0 && Number.isFinite(varF)) frequencySeHz = Math.sqrt(varF)
    } catch {
      // A singular information matrix leaves the CRB undefined; the joint fit carries the
      // axis uncertainty, so the fit is kept with a null per-line standard error.
      frequencySeHz = null
    }
  }

  const classify = (
    screening: LineScreening,
    reason: string | null,
    category: LineFitRefusalCategory | null,
  ): LineFit => ({
    accepted: screening === 'clean',
    screening,
    refusalReason: reason,
    refusalCategory: category,
    params,
    r2,
    noiseRmsMm,
    frequencySeHz,
    window,
  })

  // Detectability first: below the detection threshold the per-line fit chased noise, so
  // its frequency and damping carry no information to judge. The line is labeled weak and
  // enters the joint fit, where the shared model reads whatever ring it carries.
  if (!(params.ringAmpMm >= AMPLITUDE_DETECTION_K * noiseRmsMm) || !(params.ringAmpMm > 0)) {
    return classify(
      'weak-ringing',
      'The ringing amplitude on this line is below the detection threshold (4 times the noise ' +
        'floor), so the line was measured through the joint fit of the axis.',
      'weak-ringing',
    )
  }

  // Exclusions next: a detectable fit contradicting the search band, the spectrum, or the
  // physical damping range invalidates the whole line, so it never enters the joint fit.
  if (
    params.frequencyHz <= F_MIN_HZ + BOUND_MARGIN_HZ ||
    params.frequencyHz >= F_MAX_HZ - BOUND_MARGIN_HZ
  ) {
    return classify(
      'out-of-band',
      `The frequency fitted on this line sits at the edge of the ${F_MIN_HZ} to ${F_MAX_HZ} Hz ` +
        'search range, so it cannot be trusted.',
      'out-of-band',
    )
  }
  // A polish that walks to the edge of the seed's search band contradicts the spectrum: the
  // periodogram and the least-squares fit disagree on where the ring is.
  if (
    (fLo > F_MIN_HZ && params.frequencyHz <= fLo + BOUND_MARGIN_HZ) ||
    (fHi < F_MAX_HZ && params.frequencyHz >= fHi - BOUND_MARGIN_HZ)
  ) {
    return classify(
      'seed-disagreement',
      'The model fit and the spectrum of the trace disagree on the ringing frequency, so the ' +
        'fit cannot be trusted. The trace may be corrupted by print defects or scan artifacts.',
      'irregular-trace',
    )
  }
  if (params.dampingRatio <= ZETA_MIN || params.dampingRatio >= ZETA_MAX) {
    return classify(
      'zeta-at-bound',
      'The fitted damping ratio sits at the edge of the physically plausible range, so the fit cannot be trusted.',
      'irregular-trace',
    )
  }

  // A poorly fitting line is still a valid joint-fit record; the label is a diagnostic,
  // not a verdict.
  if (r2 < MIN_R2) {
    return classify(
      'low-r2',
      'The ringing model does not fit this line well on its own (low coefficient of ' +
        'determination), so the line was measured through the joint fit of the axis.',
      'irregular-trace',
    )
  }

  return classify('clean', null, null)
}

/** Result of the joint variable-projection fit across one axis's screened lines. */
export interface JointAxisFitResult {
  frequencyHz: number
  dampingRatio: number
  /** Residual sum of squares of the joint ring model over all records. */
  ssr: number
  /** Residual sum of squares of the nested per-line drift-only null model. */
  ssrNull: number
  nTotal: number
  /** Extra-sum-of-squares F statistic; null when the residual degrees of freedom vanish. */
  fStatistic: number | null
  /** Upper critical value of F at the F_TEST_ALPHA level; null with the statistic. */
  fCritical: number | null
  /** True when the joint ring model is significantly better than drift alone. */
  significant: boolean
  /** Standard error of the joint frequency from the full stacked-Jacobian covariance. */
  frequencySeHz: number | null
  /** Per-record fitted ring amplitude, mm, aligned with the records argument. */
  amplitudesMm: number[]
}

// The projected joint functional: for fixed (f, zeta) the linear solve is block-diagonal,
// one exact per-record least-squares solve, and the joint SSR is the sum. A record whose
// basis is singular at this (f, zeta) invalidates the grid point.
function jointProjectedSolve(
  fHz: number,
  zeta: number,
  records: JointFitRecord[],
): { ssr: number; solves: { v: number[]; ssr: number }[] } | null {
  const solves: { v: number[]; ssr: number }[] = []
  let total = 0
  for (const rec of records) {
    const s = varproSolve(fHz, zeta, rec.tS, rec.y)
    if (s === null) return null
    solves.push(s)
    total += s.ssr
  }
  return { ssr: total, solves }
}

// Stacked residual vector of the projected joint model at (f, zeta).
function jointStackedResiduals(
  solves: { v: number[]; ssr: number }[],
  records: JointFitRecord[],
  nTotal: number,
): Float64Array {
  const r = new Float64Array(nTotal)
  let at = 0
  for (let i = 0; i < records.length; i++) {
    const ri = residuals(solves[i].v, records[i].tS, records[i].y)
    r.set(ri, at)
    at += ri.length
  }
  return r
}

// Standard error of the joint frequency from the asymptotic NLS covariance on the FULL
// stacked Jacobian over all 2 + 4N parameters (Seber & Wild 1989): global columns (f, zeta)
// plus each record's linear block, accumulated into the (2 + 4N) x (2 + 4N) normal matrix.
function jointFrequencySe(
  solves: { v: number[]; ssr: number }[],
  records: JointFitRecord[],
  ssrJoint: number,
  nTotal: number,
): number | null {
  const N = records.length
  const p = 2 + 4 * N
  const dof = nTotal - p
  if (dof <= 0) return null
  const JtJ = Matrix.zeros(p, p)
  for (let i = 0; i < N; i++) {
    const Ji = numericJacobian(solves[i].v, records[i].tS, records[i].y)
    // Local parameter order is [c0, c1, a, b, f, zeta]; f and zeta map to the shared global
    // columns 0 and 1, the linear block to this record's own columns.
    const gcol = (j: number) => (j === FREQ_INDEX ? 0 : j === FREQ_INDEX + 1 ? 1 : 2 + 4 * i + j)
    for (let a = 0; a < PARAM_COUNT; a++) {
      for (let b = a; b < PARAM_COUNT; b++) {
        let s = 0
        for (let k = 0; k < Ji.rows; k++) s += Ji.get(k, a) * Ji.get(k, b)
        const ga = gcol(a)
        const gb = gcol(b)
        JtJ.set(ga, gb, JtJ.get(ga, gb) + s)
        if (ga !== gb) JtJ.set(gb, ga, JtJ.get(gb, ga) + s)
      }
    }
  }
  const sigma2 = ssrJoint / dof
  try {
    const cov = inverse(JtJ).mul(sigma2)
    const varF = cov.get(0, 0)
    return varF > 0 && Number.isFinite(varF) ? Math.sqrt(varF) : null
  } catch {
    // A singular joint information matrix leaves the standard error undefined; the caller
    // treats a null standard error as an unquantifiable (refused) uncertainty.
    return null
  }
}

/**
 * Joint variable-projection fit of the ringing model across an axis's screened lines: all
 * records share (f, zeta), each keeps its own background line and ring quadrature pair. Grid
 * search over the seed's basin, Levenberg-Marquardt polish of the reduced two-parameter
 * projected functional, extra-sum-of-squares F-test against the per-line drift-only null,
 * and the stacked-Jacobian frequency standard error. Returns null when no (f, zeta) in the
 * search band yields a solvable projected system. `seedBandRel` is the half-width of the
 * grid band around the seed as a fraction; callers refining an already-solved optimum (the
 * per-tier sub-fits) pass a narrow band so the grid is not repeated over the full basin.
 */
export function jointAxisFit(
  records: JointFitRecord[],
  seedFHz: number,
  seedBandRel = SEED_BAND_REL,
): JointAxisFitResult | null {
  if (records.length === 0) return null
  let nTotal = 0
  for (const rec of records) nTotal += rec.y.length

  const fLo = Math.max(F_MIN_HZ, seedFHz * (1 - seedBandRel))
  const fHi = Math.min(F_MAX_HZ, seedFHz * (1 + seedBandRel))
  let best: { f: number; zeta: number; ssr: number } | null = null
  // The joint grid only has to land inside the optimum's basin (a few hertz wide); the
  // Levenberg-Marquardt polish resolves the rest, so a coarser step than the seed grid
  // keeps the N-record sweep affordable.
  const jointGridHz = 2 * PERIODOGRAM_GRID_HZ
  for (let f = fLo; f <= fHi; f += jointGridHz) {
    for (const zeta of ZETA_GRID) {
      const trial = jointProjectedSolve(f, zeta, records)
      if (trial && (best === null || trial.ssr < best.ssr)) best = { f, zeta, ssr: trial.ssr }
    }
  }
  if (best === null) return null

  // Levenberg-Marquardt polish of (f, zeta) on the reduced projected functional: the
  // Jacobian is a forward difference that re-solves the block linear systems at every
  // perturbation, so it differentiates the full projected residual (the exact Golub-Pereyra
  // Jacobian, approximated numerically, not Kaufman's simplification that drops one of its
  // terms), with the same multiplicative lambda control as the per-line polish.
  const clampTheta = (t: number[]): number[] => [
    Math.min(F_MAX_HZ, Math.max(F_MIN_HZ, t[0])),
    Math.min(ZETA_MAX, Math.max(ZETA_MIN, t[1])),
  ]
  let theta = clampTheta([best.f, best.zeta])
  let current = jointProjectedSolve(theta[0], theta[1], records)!
  let r = jointStackedResiduals(current.solves, records, nTotal)
  let lambda = 1e-3
  for (let iter = 0; iter < 60; iter++) {
    // Forward-difference Jacobian of the projected residual in (f, zeta).
    const cols: Float64Array[] = []
    let singular = false
    for (let j = 0; j < 2; j++) {
      const h = Math.max(1e-6, Math.abs(theta[j]) * 1e-5)
      const th = theta.slice()
      th[j] += h
      const perturbed = jointProjectedSolve(th[0], th[1], records)
      if (perturbed === null) {
        singular = true
        break
      }
      const rh = jointStackedResiduals(perturbed.solves, records, nTotal)
      const col = new Float64Array(nTotal)
      for (let k = 0; k < nTotal; k++) col[k] = (r[k] - rh[k]) / h
      cols.push(col)
    }
    if (singular) break
    let j00 = 0
    let j01 = 0
    let j11 = 0
    let g0 = 0
    let g1 = 0
    for (let k = 0; k < nTotal; k++) {
      j00 += cols[0][k] * cols[0][k]
      j01 += cols[0][k] * cols[1][k]
      j11 += cols[1][k] * cols[1][k]
      g0 += cols[0][k] * r[k]
      g1 += cols[1][k] * r[k]
    }
    const d00 = j00 * (1 + lambda) + 1e-12
    const d11 = j11 * (1 + lambda) + 1e-12
    const det = d00 * d11 - j01 * j01
    if (!(Math.abs(det) > 0)) {
      lambda *= 10
      if (lambda > 1e12) break
      continue
    }
    const step0 = (d11 * g0 - j01 * g1) / det
    const step1 = (d00 * g1 - j01 * g0) / det
    const trialTheta = clampTheta([theta[0] + step0, theta[1] + step1])
    const trial = jointProjectedSolve(trialTheta[0], trialTheta[1], records)
    if (trial !== null && trial.ssr < current.ssr) {
      const improvement = (current.ssr - trial.ssr) / Math.max(current.ssr, 1e-300)
      theta = trialTheta
      current = trial
      r = jointStackedResiduals(current.solves, records, nTotal)
      lambda = Math.max(lambda / 10, 1e-12)
      if (improvement < 1e-10) break
    } else {
      lambda *= 10
      if (lambda > 1e12) break
    }
  }

  // Nested null model: each record keeps only its drift line (c0 + c1 t), solved by linear
  // least squares; its residuals come straight from the least-squares detrend.
  let ssrNull = 0
  for (const rec of records) ssrNull += ssr(linearDetrend(rec.tS, rec.y))

  // Extra-sum-of-squares F-test (Seber & Wild 1989, ch. 5): p_null = 2N, p_ring = 4N + 2.
  const N = records.length
  const pRing = 4 * N + 2
  const dfNum = pRing - 2 * N
  const dfDen = nTotal - pRing
  let fStatistic: number | null = null
  let fCritical: number | null = null
  let significant = false
  if (dfDen > 0) {
    fCritical = fCriticalValue(dfNum, dfDen, F_TEST_ALPHA)
    const denom = current.ssr / dfDen
    fStatistic = denom > 0 ? (ssrNull - current.ssr) / dfNum / denom : Number.POSITIVE_INFINITY
    significant = fStatistic > fCritical
  }

  return {
    frequencyHz: theta[0],
    dampingRatio: theta[1],
    ssr: current.ssr,
    ssrNull,
    nTotal,
    fStatistic,
    fCritical,
    significant,
    frequencySeHz: jointFrequencySe(current.solves, records, current.ssr, nTotal),
    amplitudesMm: current.solves.map((s) => Math.hypot(s.v[2], s.v[3])),
  }
}

// Joint periodogram seed: the maximizer of the SUM of the per-record periodograms (each on
// its linearly detrended record), the multi-record form of the Rife & Boorstyn estimator.
// Used when no screened line produced a per-line fit to take a median seed from.
function jointPeriodogramSeed(records: JointFitRecord[]): number {
  const detrended = records.map((rec) => linearDetrend(rec.tS, rec.y))
  let bestF = F_MIN_HZ
  let bestP = -1
  for (let f = F_MIN_HZ; f <= F_MAX_HZ; f += PERIODOGRAM_GRID_HZ) {
    const w = 2 * Math.PI * f
    let p = 0
    for (let i = 0; i < records.length; i++) {
      const tS = records[i].tS
      const y = detrended[i]
      let re = 0
      let im = 0
      for (let k = 0; k < y.length; k++) {
        re += y[k] * Math.cos(w * tS[k])
        im -= y[k] * Math.sin(w * tS[k])
      }
      p += re * re + im * im
    }
    if (p > bestP) {
      bestP = p
      bestF = f
    }
  }
  return bestF
}

// Screening categories that exclude a line from the joint fit; every other category enters.
const EXCLUSION_BY_SCREENING: Partial<Record<LineScreening, LineJointExclusion>> = {
  'no-free-response': 'no-free-response',
  'out-of-band': 'out-of-band',
  'seed-disagreement': 'seed-disagreement',
  'zeta-at-bound': 'zeta-at-bound',
}

/**
 * The axis estimate: screens the per-line fits (exclusions plus a Hampel identifier on the
 * per-line fitted frequencies), runs the joint variable-projection fit over the surviving
 * lines, and gates the result with the F-test, the per-tier joint sub-fit invariance check,
 * the replicate-agreement check, and the confidence gate on the joint frequency.
 * `amplitudeFloorMm` is the scan's amplitude resolvability floor (AMPLITUDE_RESOLUTION_PX
 * priced through the scan's px/mm); a pooled amplitude below it is refused as unresolvable.
 */
export function poolAxisFits(
  fits: LineFit[],
  speedsMmS: number[],
  lineSpeeds: number[],
  amplitudeFloorMm = 0,
): AxisPool {
  const statuses: LineJointStatus[] = fits.map((f) => {
    const exclusion = EXCLUSION_BY_SCREENING[f.screening]
    return exclusion !== undefined
      ? { usedInJointFit: false, exclusion }
      : { usedInJointFit: true, amplitudeMm: null }
  })

  // A line's per-line fitted frequency counts as a replicate figure only when the ring was
  // detectable on that line alone: a weak or unfittable line's frequency chased noise and
  // must not steer the seed, the outlier screen, or the replicate-agreement check.
  const informativeFreq = (f: LineFit): number =>
    f.params !== null && f.screening !== 'weak-ringing' && f.screening !== 'fit-failed'
      ? f.params.frequencyHz
      : NaN

  // Hampel identifier (median/MAD, 3 robust sigmas) over the per-line fitted frequencies of
  // the joint-fit candidates: a wildly different fitted frequency marks a corrupted trace,
  // not a replicate, and is excluded before it can bias the joint fit. The outlier distance
  // is floored at the replicate agreement tolerance: lines inside the shaper's agreement
  // band are replicates by definition, never outliers. Lines without an informative
  // per-line frequency pass through as gaps.
  const candidateIndices = fits.map((_, i) => i).filter((i) => statuses[i].usedInJointFit)
  const candidateFreqs = candidateIndices.map((i) => informativeFreq(fits[i]))
  const finiteFreqs = candidateFreqs.filter((f) => Number.isFinite(f))
  if (finiteFreqs.length >= 3) {
    const center = median(finiteFreqs)
    const threshold = Math.max(
      3 * MAD_TO_SIGMA * mad(finiteFreqs),
      Math.max(AGREEMENT_MIN_HZ, AGREEMENT_REL * center),
    )
    candidateIndices.forEach((i, k) => {
      if (Number.isFinite(candidateFreqs[k]) && Math.abs(candidateFreqs[k] - center) > threshold) {
        statuses[i] = { usedInJointFit: false, exclusion: 'frequency-outlier' }
      }
    })
  }

  const included = fits.map((_, i) => i).filter((i) => statuses[i].usedInJointFit)
  const records = included.map((i) => fits[i].window!)

  const base = {
    frequencyHz: null,
    dampingRatio: null,
    frequencyCi95Hz: null,
    frequencySeHz: null,
    fStatistic: null,
    amplitudeMm: null,
    linesUsed: included.length,
    lineJoint: statuses,
    rescanAdvice: null,
  }
  // The pool's refusals carry only the axis-level verdict; the per-line reasons travel with
  // the per-line outcomes, where the UI summarizes them by category.
  const refuse = (reason: string, extras: Partial<AxisPool> = {}): AxisPool => ({
    accepted: false,
    refusals: [reason],
    ...base,
    ...extras,
  })

  if (included.length < MIN_ACCEPTED_LINES) {
    // The remedy depends on why lines were excluded: a majority of band-edge exclusions
    // means the resonance is probably outside the searchable band, and anything else most
    // often points at the scanner's lamp shadow crossing the measured edges.
    const excluded = fits.filter((_, i) => !statuses[i].usedInJointFit)
    const bandEdgeCount = excluded.filter((f) => f.screening === 'out-of-band').length
    const verdict =
      `Only ${included.length} of the axis's lines produced a usable ringing trace (at least ` +
      `${MIN_ACCEPTED_LINES} are needed for a trustworthy estimate).`
    if (bandEdgeCount * 2 > excluded.length) {
      return refuse(`${verdict} The true resonance likely lies outside the measurable range.`)
    }
    return refuse(verdict, {
      rescanAdvice:
        `When most lines of a scan are refused, the scanner's lamp shadow is often falling ` +
        `across the measured edges; rescan with the coupon rotated a half turn on the glass.`,
    })
  }

  // Joint seed: the median per-line fitted frequency of the surviving lines, or the joint
  // periodogram maximizer when no line produced a per-line fit.
  const survivingSeeds = included
    .map((i) => informativeFreq(fits[i]))
    .filter((f) => Number.isFinite(f))
  const seed = survivingSeeds.length > 0 ? median(survivingSeeds) : jointPeriodogramSeed(records)

  const joint = jointAxisFit(records, seed)
  if (joint === null) {
    return refuse(
      `The shared ringing model could not be fit to the axis's lines. The traces may be ` +
        'corrupted by print defects or scan artifacts.',
    )
  }
  // The per-line fitted amplitudes are diagnostics regardless of the later gates.
  included.forEach((i, k) => {
    statuses[i] = { usedInJointFit: true, amplitudeMm: joint.amplitudesMm[k] }
  })
  const extras: Partial<AxisPool> = { fStatistic: joint.fStatistic }

  // Acceptance: the extra-sum-of-squares F-test against the per-line drift-only null.
  if (!joint.significant) {
    // No excitation advice here: whether raising the corner speed would help is decided
    // by the ladder split of the per-line amplitudes, judged where the rungs are known,
    // and that remedy then replaces this generic rescan advice.
    return refuse(
      'No statistically significant ringing was found on this axis: across all its lines, ' +
        'the ringing model fits no better than plain drift.',
      {
        ...extras,
        rescanAdvice:
          'Rescan with the coupon rotated a half turn on the glass, since lamp shadow can ' +
          'weaken the traced ringing.',
      },
    )
  }

  // Practical significance: a statistically significant shared component below the traced
  // edges' sub-pixel resolvability floor is a sampling artifact (pixel locking), not
  // printed ringing, and a printer whose ringing cannot be resolved needs no shaper.
  if (median(joint.amplitudesMm) < amplitudeFloorMm) {
    return refuse(
      'The ringing measured across this axis is smaller than the scan can resolve, so it ' +
        'cannot be told apart from the scanner\'s own sub-pixel artifacts. Ringing this ' +
        'small does not need an input shaper.',
      extras,
    )
  }

  // A jointly fitted frequency or damping at a bound of its search range is not a resolved
  // interior optimum: the shared structure the fit latched onto (for example a residue of
  // the forced corner transient) is not a trustworthy resonance.
  if (
    joint.frequencyHz <= F_MIN_HZ + BOUND_MARGIN_HZ ||
    joint.frequencyHz >= F_MAX_HZ - BOUND_MARGIN_HZ
  ) {
    return refuse(
      `The frequency fitted across the axis's lines sits at the edge of the ${F_MIN_HZ} to ` +
        `${F_MAX_HZ} Hz search range, so it cannot be trusted. The true resonance likely ` +
        'lies outside the measurable range.',
      extras,
    )
  }
  if (joint.dampingRatio <= ZETA_MIN || joint.dampingRatio >= ZETA_MAX) {
    return refuse(
      'The damping ratio fitted across the axis\'s lines sits at the edge of the physically ' +
        'plausible range, so the fit cannot be trusted.',
      extras,
    )
  }

  const tolerance = Math.max(AGREEMENT_MIN_HZ, AGREEMENT_REL * joint.frequencyHz)

  // Speed invariance: the ringing frequency is a machine property, independent of the print
  // speed, so per-tier joint sub-fits must agree. A disagreement flags a wavelength
  // misreading (for example aliasing at one tier).
  if (speedsMmS.length > 1) {
    const tierFreqs: number[] = []
    for (const v of speedsMmS) {
      const tierIndices = included.filter((i) => lineSpeeds[i] === v)
      if (tierIndices.length === 0) continue
      const tierRecords = tierIndices.map((i) => fits[i].window!)
      // Each sub-fit refines with a narrow grid band (the agreement tolerance) instead of
      // re-sweeping the full basin, seeded from the tier's own per-line median frequency so
      // a genuinely disagreeing tier starts in its own basin; the axis-level optimum is the
      // fallback seed for a tier with no informative per-line fit.
      const tierSeeds = tierIndices
        .map((i) => informativeFreq(fits[i]))
        .filter((f) => Number.isFinite(f))
      const tierSeed = tierSeeds.length > 0 ? median(tierSeeds) : joint.frequencyHz
      const sub = jointAxisFit(tierRecords, tierSeed, AGREEMENT_REL)
      if (sub !== null) tierFreqs.push(sub.frequencyHz)
    }
    if (tierFreqs.length > 1 && Math.max(...tierFreqs) - Math.min(...tierFreqs) > tolerance) {
      return refuse(
        'The speed tiers disagree on the ringing frequency. A true machine resonance is ' +
          'speed-independent, so the measurement cannot be trusted; the trace of one tier was ' +
          'probably misread.',
        extras,
      )
    }
  }

  // Replicate agreement: the robust spread of the per-line fitted frequencies. Lines without
  // a per-line fit carry no replicate figure and are skipped here.
  if (survivingSeeds.length > 1 && MAD_TO_SIGMA * mad(survivingSeeds) > tolerance) {
    return refuse(
      'The lines of this axis disagree on the ringing frequency (the replicate spread exceeds ' +
        'the shaper tolerance). The print or scan is too inconsistent to trust a single value.',
      extras,
    )
  }

  // Confidence gate on the joint frequency's standard error.
  const se = joint.frequencySeHz
  const ci95 = se !== null ? 1.96 * se : null
  if (ci95 === null || ci95 > MAX_CI95_REL * joint.frequencyHz) {
    return refuse(
      'The pooled frequency estimate is too uncertain to configure an input shaper: its 95% ' +
        'confidence interval is wider than the stopband of the shaper it would set. Reprint or ' +
        'rescan the coupon.',
      extras,
    )
  }

  return {
    accepted: true,
    refusals: [],
    frequencyHz: joint.frequencyHz,
    dampingRatio: joint.dampingRatio,
    frequencyCi95Hz: ci95,
    frequencySeHz: se,
    fStatistic: joint.fStatistic,
    amplitudeMm: median(joint.amplitudesMm),
    linesUsed: included.length,
    lineJoint: statuses,
    rescanAdvice: null,
  }
}
