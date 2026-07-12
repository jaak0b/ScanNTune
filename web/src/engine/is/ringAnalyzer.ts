import { Matrix, solve, inverse } from 'ml-matrix'
import type { TracedLine } from './lineTracer'

// Fits the ringing model to a traced line and pools the per-line fits into a per-axis
// estimate, with refusal gates at every step. The stages, each an established method:
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
// 5. Uncertainty: the asymptotic covariance of the nonlinear least-squares estimate,
//    sigma^2 (J^T J)^-1 (Seber & Wild, "Nonlinear Regression", 1989), which for Gaussian
//    noise attains the Cramer-Rao bound of the damped-sinusoid model (Yao & Pandit, IEEE
//    Trans. Signal Processing 43(11), 1995).
//
// Model, t measured from the fit-window start:
//   lateral(t) = c0 + c1 * t                                  (background line: drift)
//              + exp(-2 pi f zeta t) * (a * cos(2 pi f sqrt(1 - zeta^2) t)
//                                     + b * sin(2 pi f sqrt(1 - zeta^2) t))
// The damped quadrature pair is the free response of the second-order underdamped machine
// axis; reported amplitude is sqrt(a^2 + b^2) and phase atan2(-b, a).

export { F_MIN_HZ, F_MAX_HZ } from './types'
import { F_MIN_HZ, F_MAX_HZ } from './types'
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
/** Minimum coefficient of determination of the model fit on the detrended trace. */
export const MIN_R2 = 0.5
/** Minimum accepted line fits per axis before pooling is meaningful. */
export const MIN_ACCEPTED_LINES = 3
/**
 * Replicate agreement and speed invariance tolerance: the larger of 2 Hz and 5% of the
 * median frequency. Klipper-style input shapers keep their vibration suppression within
 * roughly +/-5-10% of the target frequency, so replicates scattered wider than 5% would
 * already defeat the shaper the result is meant to configure.
 */
const AGREEMENT_REL = 0.05
const AGREEMENT_MIN_HZ = 2
/**
 * Confidence gate: the pooled 95% confidence halfwidth must stay under 10% of the
 * frequency. The EI shaper family suppresses vibration below its 5% tolerance only within
 * roughly +/-10-15% of its target frequency, so a wider interval cannot guarantee the true
 * resonance lies inside the configured shaper's stopband.
 */
const MAX_CI95_REL = 0.1
/** Normal-consistency factor for the MAD (sigma = 1.4826 * MAD for Gaussian data). */
const MAD_TO_SIGMA = 1.4826
/** Asymptotic standard error of the median is 1.2533 * sigma / sqrt(n) for Gaussian data. */
const MEDIAN_EFFICIENCY = 1.2533

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

export interface LineFit {
  accepted: boolean
  refusalReason: string | null
  refusalCategory: LineFitRefusalCategory | null
  params: RingModelParams | null
  r2: number
  noiseRmsMm: number
  /** Cramer-Rao standard error of the frequency, Hz (asymptotic NLS covariance). */
  frequencySeHz: number | null
}

export interface AxisPool {
  accepted: boolean
  refusals: string[]
  frequencyHz: number | null
  dampingRatio: number | null
  /** 95% confidence halfwidth of the pooled frequency, Hz. */
  frequencyCi95Hz: number | null
  amplitudeMm: number | null
  linesUsed: number
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

function medianOf(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  const n = sorted.length
  if (n === 0) return 0
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
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

  const noFit = (reason: string): LineFit => ({
    accepted: false,
    refusalReason: reason,
    refusalCategory: 'irregular-trace',
    params: null,
    r2: 0,
    noiseRmsMm,
    frequencySeHz: null,
  })

  // Forced-transient exclusion: fit only the free ringdown after the corner-overshoot peak.
  const start = freeResponseStart(y)
  if (start === null) {
    return noFit(
      'The trace never settles from the corner transient into a free ringdown, so there is ' +
        'no resonance to fit. The trace may be corrupted by print defects or scan artifacts.',
    )
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

  // Variable projection grid over (f, zeta) inside the seed's basin, then LM polish.
  let best: { v: number[]; ssr: number } | null = null
  for (let f = fLo; f <= fHi; f += PERIODOGRAM_GRID_HZ) {
    for (const zeta of ZETA_GRID) {
      const trial = varproSolve(f, zeta, tw, yw)
      if (trial && (best === null || trial.ssr < best.ssr)) best = trial
    }
  }
  if (best === null) {
    return noFit(
      'The ringing model could not be fit to the traced line. The trace may be corrupted by ' +
        'print defects or scan artifacts.',
    )
  }
  const fit = levenbergMarquardt(best.v, tw, yw)
  const params = vectorToParams(fit.v)

  let sst = 0
  const mean = Array.from(yw).reduce((a, b) => a + b, 0) / wN
  for (let i = 0; i < wN; i++) sst += (yw[i] - mean) * (yw[i] - mean)
  const r2 = sst > 0 ? 1 - fit.ssr / sst : 0

  const refuse = (reason: string, category: LineFitRefusalCategory): LineFit => ({
    accepted: false,
    refusalReason: reason,
    refusalCategory: category,
    params,
    r2,
    noiseRmsMm,
    frequencySeHz: null,
  })

  // Gate order matters: an amplitude below the detection threshold means there is no ring to
  // fit, so it must be reported as such before any fit-quality verdict.
  if (!(params.ringAmpMm >= AMPLITUDE_DETECTION_K * noiseRmsMm) || !(params.ringAmpMm > 0)) {
    return refuse(
      'The ringing amplitude on this line is below the detection threshold (4 times the noise floor), ' +
        'so the line was skipped.',
      'weak-ringing',
    )
  }
  if (r2 < MIN_R2) {
    return refuse(
      'The ringing model does not fit the traced line (low coefficient of determination). ' +
        'The trace may be corrupted by print defects or scan artifacts.',
      'irregular-trace',
    )
  }
  if (
    params.frequencyHz <= F_MIN_HZ + BOUND_MARGIN_HZ ||
    params.frequencyHz >= F_MAX_HZ - BOUND_MARGIN_HZ
  ) {
    return refuse(
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
    return refuse(
      'The model fit and the spectrum of the trace disagree on the ringing frequency, so the ' +
        'fit cannot be trusted. The trace may be corrupted by print defects or scan artifacts.',
      'irregular-trace',
    )
  }
  if (params.dampingRatio <= ZETA_MIN || params.dampingRatio >= ZETA_MAX) {
    return refuse(
      'The fitted damping ratio sits at the edge of the physically plausible range, so the fit cannot be trusted.',
      'irregular-trace',
    )
  }

  // Cramer-Rao standard error of the frequency from the asymptotic NLS covariance
  // sigma^2 (J^T J)^-1 at the solution.
  let frequencySeHz: number | null = null
  const dof = wN - PARAM_COUNT
  if (dof > 0) {
    const sigma2 = fit.ssr / dof
    try {
      const cov = inverse(fit.jacobian.transpose().mmul(fit.jacobian)).mul(sigma2)
      const varF = cov.get(FREQ_INDEX, FREQ_INDEX)
      if (varF > 0 && Number.isFinite(varF)) frequencySeHz = Math.sqrt(varF)
    } catch {
      // A singular information matrix leaves the CRB undefined; the pooled MAD-based
      // uncertainty still applies, so the fit is kept with a null per-line standard error.
      frequencySeHz = null
    }
  }

  return { accepted: true, refusalReason: null, refusalCategory: null, params, r2, noiseRmsMm, frequencySeHz }
}

/**
 * Pools the per-line fits of one axis: replicate-agreement and speed-invariance gates, median
 * frequency and damping, and the confidence gate on the pooled frequency.
 */
export function poolAxisFits(fits: LineFit[], speedsMmS: number[], lineSpeeds: number[]): AxisPool {
  const refused: LineFit[] = []
  const accepted: { fit: LineFit; speed: number }[] = []
  for (let i = 0; i < fits.length; i++) {
    if (fits[i].accepted) accepted.push({ fit: fits[i], speed: lineSpeeds[i] })
    else refused.push(fits[i])
  }

  // The pool's refusals carry only the axis-level verdict; the per-line reasons travel with
  // the per-line outcomes, where the UI summarizes them by category.
  const refuse = (reason: string): AxisPool => ({
    accepted: false,
    refusals: [reason],
    frequencyHz: null,
    dampingRatio: null,
    frequencyCi95Hz: null,
    amplitudeMm: null,
    linesUsed: accepted.length,
  })

  if (accepted.length < MIN_ACCEPTED_LINES) {
    // The advice depends on why the lines were refused: a majority of amplitude-gate refusals
    // means the traced ringing is too weak (a weak print, or lamp shadow attenuating the
    // signal), a majority of band-edge refusals means the resonance is probably outside the
    // searchable band, and anything else most often points at the scanner's lamp shadow
    // crossing the measured edges.
    const amplitudeCount = refused.filter((f) => f.refusalCategory === 'weak-ringing').length
    const bandEdgeCount = refused.filter((f) => f.refusalCategory === 'out-of-band').length
    let advice =
      `When most lines of a scan are refused, the scanner's lamp shadow is often falling ` +
      `across the measured edges; rescan with the coupon rotated a half turn on the glass.`
    if (amplitudeCount * 2 > refused.length) {
      advice =
        'The ringing amplitude is below the detection threshold on most lines. Rescan with ' +
        'the coupon rotated a half turn on the glass, since lamp shadow can weaken the traced ' +
        'ringing; if it still reads too weak, raise the corner speed or the acceleration and reprint.'
    } else if (bandEdgeCount * 2 > refused.length) {
      advice = 'The true resonance likely lies outside the measurable range.'
    }
    return refuse(
      `Only ${accepted.length} of the axis's lines produced a usable ringing fit (at least ` +
        `${MIN_ACCEPTED_LINES} are needed for a trustworthy estimate). ` +
        advice,
    )
  }

  const freqs = accepted.map((a) => a.fit.params!.frequencyHz)
  const fMedian = medianOf(freqs)
  const tolerance = Math.max(AGREEMENT_MIN_HZ, AGREEMENT_REL * fMedian)

  // Speed invariance: the ringing frequency is a machine property, independent of the print
  // speed, so the per-tier medians must agree. A disagreement flags a wavelength misreading
  // (for example aliasing at one tier). Checked before the replicate gate: a tier mismatch
  // also widens the overall spread, and the tier-specific reason is the actionable one.
  if (speedsMmS.length > 1) {
    const tierMedians: number[] = []
    for (const v of speedsMmS) {
      const tier = accepted.filter((a) => a.speed === v).map((a) => a.fit.params!.frequencyHz)
      if (tier.length > 0) tierMedians.push(medianOf(tier))
    }
    if (tierMedians.length > 1 && Math.max(...tierMedians) - Math.min(...tierMedians) > tolerance) {
      return refuse(
        'The speed tiers disagree on the ringing frequency. A true machine resonance is ' +
          'speed-independent, so the measurement cannot be trusted; the trace of one tier was ' +
          'probably misread.',
      )
    }
  }

  // Replicate agreement: the robust spread of the per-line frequencies.
  const mad = medianOf(freqs.map((f) => Math.abs(f - fMedian)))
  const robustSigma = MAD_TO_SIGMA * mad
  if (robustSigma > tolerance) {
    return refuse(
      'The lines of this axis disagree on the ringing frequency (the replicate spread exceeds ' +
        'the shaper tolerance). The print or scan is too inconsistent to trust a single value.',
    )
  }

  // Pooled uncertainty: the larger of the replicate-based standard error of the median and the
  // Cramer-Rao-based one, each shrunk by sqrt(n) for the pooling.
  const n = accepted.length
  const seReplicate = (MEDIAN_EFFICIENCY * robustSigma) / Math.sqrt(n)
  const crbSes = accepted.map((a) => a.fit.frequencySeHz).filter((s): s is number => s !== null)
  const seCrb = crbSes.length > 0 ? medianOf(crbSes) / Math.sqrt(n) : 0
  const se = Math.max(seReplicate, seCrb)
  const ci95 = 1.96 * se
  if (ci95 > MAX_CI95_REL * fMedian) {
    return refuse(
      'The pooled frequency estimate is too uncertain to configure an input shaper: its 95% ' +
        'confidence interval is wider than the stopband of the shaper it would set. Reprint or ' +
        'rescan the coupon.',
    )
  }

  return {
    accepted: true,
    refusals: [],
    frequencyHz: fMedian,
    dampingRatio: medianOf(accepted.map((a) => a.fit.params!.dampingRatio)),
    frequencyCi95Hz: ci95,
    amplitudeMm: medianOf(accepted.map((a) => a.fit.params!.ringAmpMm)),
    linesUsed: n,
  }
}
