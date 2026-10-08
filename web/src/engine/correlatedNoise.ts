/**
 * Autoregressive models of correlated measurement noise: fitting, order selection, exact
 * prewhitening, and the fitted model's second-order structure. Pure functions on plain number
 * arrays, shared by every flow whose along-line samples carry serially correlated noise.
 *
 * Convention: an AR(p) model is x_t = phi_1 x_{t-1} + ... + phi_p x_{t-p} + e_t with e_t white,
 * zero mean, variance sigma^2. The series is used as given (no mean is removed); callers pass
 * residuals of a fit that already carries a constant term.
 */

import { normalQuantile } from './math'

/** A fitted AR(p) model: `coefficients` are phi_1..phi_p (empty for white noise). */
export interface ArFit {
  coefficients: number[]
  /** Innovation variance sigma^2. */
  noiseVariance: number
}

/** The Burg fits of orders 0..maxOrder, indexed by order. */
type BurgPath = ArFit[]

/**
 * Burg's recursion (J. P. Burg, "Maximum entropy spectral analysis", PhD thesis, Stanford
 * University, 1975) from order 0 up to `maxOrder`, returning the fit at every order. Each
 * stage picks the reflection coefficient minimizing the summed forward and backward
 * prediction error power, k_m = 2 sum f(t) b(t-1) / sum (f(t)^2 + b(t-1)^2), extends the
 * coefficients by Levinson's update phi_{m,j} = phi_{m-1,j} - k_m phi_{m-1,m-j}, and updates the
 * innovation variance as sigma_m^2 = sigma_{m-1}^2 (1 - k_m^2) from sigma_0^2 = mean of x^2.
 * The reflection coefficients satisfy |k_m| <= 1 by the Cauchy-Schwarz inequality, so every
 * fitted model is stationary. A stage whose prediction errors are already all zero has nothing
 * left to model and keeps the previous fit (k_m = 0).
 */
function burgPath(x: readonly number[], maxOrder: number): BurgPath {
  return burgPathSegments([x], maxOrder)
}

/**
 * Burg's recursion over several segments of one process (S. de Waele and P. M. T. Broersen, "The
 * Burg algorithm for segments", IEEE Transactions on Signal Processing 48(10), 2000, 2876-2880):
 * the forward and backward prediction errors are kept per segment, and each stage's reflection
 * coefficient minimizes their power summed over all segments, so no prediction ever runs across
 * the boundary between two segments. A segment shorter than the stage order no longer
 * contributes. One segment is the plain Burg recursion.
 */
function burgPathSegments(segments: readonly (readonly number[])[], maxOrder: number): BurgPath {
  const f = segments.map((s) => s.slice())
  const b = segments.map((s) => s.slice())
  const total = segments.reduce((s, x) => s + x.length, 0)
  let coefficients: number[] = []
  let variance = segments.reduce((s, x) => s + x.reduce((t, v) => t + v * v, 0), 0) / total
  const path: BurgPath = [{ coefficients, noiseVariance: variance }]
  for (let m = 1; m <= maxOrder; m++) {
    let num = 0
    let den = 0
    for (let g = 0; g < f.length; g++) {
      const fg = f[g]
      const bg = b[g]
      for (let t = m; t < fg.length; t++) {
        num += fg[t] * bg[t - 1]
        den += fg[t] * fg[t] + bg[t - 1] * bg[t - 1]
      }
    }
    const k = den > 0 ? (2 * num) / den : 0
    for (let g = 0; g < f.length; g++) {
      const fg = f[g]
      const bg = b[g]
      // Descending t keeps b[t - 1] unmodified until stage t - 1 has read it.
      for (let t = fg.length - 1; t >= m; t--) {
        const ft = fg[t]
        const bt1 = bg[t - 1]
        fg[t] = ft - k * bt1
        bg[t] = bt1 - k * ft
      }
    }
    const prev = coefficients
    coefficients = prev.map((phi, j) => phi - k * prev[m - 2 - j])
    coefficients.push(k)
    variance *= 1 - k * k
    path.push({ coefficients, noiseVariance: variance })
  }
  return path
}

function checkSeries(x: readonly number[], order: number): void {
  if (x.length === 0) throw new Error('An AR model needs at least one sample')
  if (!(Number.isInteger(order) && order >= 0 && order < x.length)) {
    throw new Error(`The AR order must be an integer from 0 to ${x.length - 1}, got ${order}`)
  }
}

/** Fits an AR model of the given order to `x` by Burg's method (see burgPath). */
export function burgAr(x: readonly number[], order: number): ArFit {
  checkSeries(x, order)
  return burgPath(x, order)[order]
}

/**
 * The default largest AR order considered for `n` samples: floor(10 log10 n), the default
 * `order.max` of R's stats::ar (R Core Team, stats package documentation, function ar), held
 * below n - 2 so the AICc penalty stays finite.
 */
export function defaultMaxArOrder(n: number): number {
  return Math.max(0, Math.min(n - 3, Math.floor(10 * Math.log10(n))))
}

/**
 * Selects the AR order by the corrected Akaike information criterion of C. M. Hurvich and
 * C.-L. Tsai ("Regression and time series model selection in small samples", Biometrika 76(2),
 * 1989, 297-307), in its AR form AICc(p) = n ln sigma_p^2 + n (n + p) / (n - p - 2), over the
 * Burg fits of orders 0 to `maxOrder`, and returns the minimizing fit. Ties keep the lower
 * order.
 */
export function selectOrderAicc(
  x: readonly number[],
  maxOrder: number = defaultMaxArOrder(x.length),
): ArFit {
  checkSeries(x, maxOrder)
  const n = x.length
  if (maxOrder > n - 3) {
    throw new Error(`AICc needs the AR order below n - 2 (${n - 2}), got ${maxOrder}`)
  }
  return minimumAicc(burgPath(x, maxOrder), n)
}

/** The AICc-minimizing fit of a Burg path over n samples; ties keep the lower order. */
function minimumAicc(path: BurgPath, n: number): ArFit {
  let best = path[0]
  let bestScore = Infinity
  path.forEach((fit, p) => {
    const score = n * Math.log(fit.noiseVariance) + (n * (n + p)) / (n - p - 2)
    if (score < bestScore) {
      bestScore = score
      best = fit
    }
  })
  return best
}

/** Fits an AR model of the given order to several segments of one process (burgPathSegments). */
export function burgArSegments(segments: readonly (readonly number[])[], order: number): ArFit {
  const n = segments.reduce((s, x) => s + x.length, 0)
  if (n === 0) throw new Error('An AR model needs at least one sample')
  if (!(Number.isInteger(order) && order >= 0 && order < n)) {
    throw new Error(`The AR order must be an integer from 0 to ${n - 1}, got ${order}`)
  }
  return burgPathSegments(segments, order)[order]
}

/**
 * Selects the AR order by AICc (see selectOrderAicc) over the segment Burg fits of orders 0 to
 * `maxOrder` (see burgPathSegments), with n the total sample count of the segments. This is the
 * model of a series whose unreadable samples are left out: the segments are the runs of read
 * samples, and no filled-in value enters the fit.
 */
export function selectOrderAiccSegments(
  segments: readonly (readonly number[])[],
  maxOrder?: number,
): ArFit {
  const n = segments.reduce((s, x) => s + x.length, 0)
  if (n === 0) throw new Error('An AR model needs at least one sample')
  const order = maxOrder ?? defaultMaxArOrder(n)
  if (!(Number.isInteger(order) && order >= 0 && order <= n - 3)) {
    throw new Error(`AICc needs an integer AR order from 0 to ${n - 3}, got ${order}`)
  }
  return minimumAicc(burgPathSegments(segments, order), n)
}

/**
 * Splits observed values into the runs of consecutive lattice positions: the segments the
 * segment Burg recursion takes.
 */
export function latticeSegments(values: ArrayLike<number>, lattice: ArrayLike<number>): number[][] {
  const segments: number[][] = []
  let current: number[] = []
  for (let i = 0; i < values.length; i++) {
    if (i > 0 && lattice[i] !== lattice[i - 1] + 1) {
      segments.push(current)
      current = []
    }
    current.push(values[i])
  }
  if (current.length > 0) segments.push(current)
  return segments
}

/**
 * The predictors of every order 0..p implied by an AR(p) fit, with their one-step prediction
 * error variances: the Durbin-Levinson quantities (P. J. Brockwell and R. A. Davis, "Time
 * Series: Theory and Methods", 2nd ed., Springer 1991, s5.2) of the fitted process. They are
 * obtained by inverting the Durbin-Levinson coefficient update (the step-down recursion),
 * phi_{m-1,j} = (phi_{m,j} + k_m phi_{m,m-j}) / (1 - k_m^2) with k_m = phi_{m,m}, and
 * v_{m-1} = v_m / (1 - k_m^2) from v_p = sigma^2, so v_0 is the process variance gamma(0).
 * Throws when a reflection coefficient reaches 1 in magnitude (a non-stationary model).
 */
function levinsonPredictors(fit: ArFit): {
  phi: number[][]
  reflection: number[]
  predictionVariance: number[]
} {
  const p = fit.coefficients.length
  const phi: number[][] = new Array(p + 1)
  const reflection: number[] = new Array(p + 1).fill(0)
  const predictionVariance: number[] = new Array(p + 1)
  phi[p] = fit.coefficients.slice()
  predictionVariance[p] = fit.noiseVariance
  for (let m = p; m >= 1; m--) {
    const k = phi[m][m - 1]
    const shrink = 1 - k * k
    if (!(shrink > 0)) {
      throw new Error('The AR model is not stationary: a reflection coefficient reaches 1')
    }
    reflection[m] = k
    phi[m - 1] = Array.from(
      { length: m - 1 },
      (_, j) => (phi[m][j] + k * phi[m][m - 2 - j]) / shrink,
    )
    predictionVariance[m - 1] = predictionVariance[m] / shrink
  }
  return { phi, reflection, predictionVariance }
}

/**
 * Autocovariance gamma(0..maxLag) of the stationary process an AR fit describes. gamma(0) is
 * the order-0 prediction variance; the next p lags follow from the Durbin-Levinson identity
 * k_m v_{m-1} = gamma(m) - sum_{j<m} phi_{m-1,j} gamma(m-j) (Brockwell and Davis 1991, s5.2),
 * and the rest from the AR difference equation gamma(h) = sum_j phi_j gamma(h-j) (ibid. s3.3).
 */
export function autocovariance(fit: ArFit, maxLag: number): number[] {
  const { phi, reflection, predictionVariance } = levinsonPredictors(fit)
  const p = fit.coefficients.length
  const gamma: number[] = [predictionVariance[0]]
  for (let h = 1; h <= maxLag; h++) {
    if (h <= p) {
      let g = reflection[h] * predictionVariance[h - 1]
      phi[h - 1].forEach((c, j) => (g += c * gamma[h - 1 - j]))
      gamma.push(g)
    } else {
      gamma.push(fit.coefficients.reduce((s, c, j) => s + c * gamma[h - 1 - j], 0))
    }
  }
  return gamma
}

/**
 * Two-sided spectral density of an AR fit at `frequency` in cycles per sample,
 * S(f) = sigma^2 / |1 - sum_k phi_k e^{-i 2 pi f k}|^2 (Brockwell and Davis 1991, s4.4), so
 * that its integral over [-1/2, 1/2] equals gamma(0); white noise has S(f) = sigma^2.
 */
export function spectralDensity(fit: ArFit, frequency: number): number {
  let re = 1
  let im = 0
  fit.coefficients.forEach((c, j) => {
    const w = 2 * Math.PI * frequency * (j + 1)
    re -= c * Math.cos(w)
    im += c * Math.sin(w)
  })
  return fit.noiseVariance / (re * re + im * im)
}

/**
 * Exact prewhitening of `x` under an AR fit: each sample minus its best linear prediction from
 * all earlier samples, divided by that prediction's standard error. Sample t < p uses the
 * order-t Durbin-Levinson predictor and its variance v_t (Brockwell and Davis 1991, s5.2);
 * from t = p on the order-p predictor and sigma^2. This is the inverse Cholesky factor of the
 * model covariance matrix, so no sample is dropped and, when `x` follows the model, the output
 * is uncorrelated with unit variance. The filter is linear, so the same call whitens data and
 * regression columns alike. Throws when the innovation variance is not positive.
 */
export function prewhiten(x: readonly number[], fit: ArFit): number[] {
  if (!(fit.noiseVariance > 0)) {
    throw new Error('Prewhitening needs a positive innovation variance')
  }
  const { phi, predictionVariance } = levinsonPredictors(fit)
  const p = fit.coefficients.length
  return x.map((value, t) => {
    const order = Math.min(t, p)
    const coefficients = phi[order]
    let e = value
    for (let j = 0; j < order; j++) e -= coefficients[j] * x[t - 1 - j]
    return e / Math.sqrt(predictionVariance[order])
  })
}

/** One lattice step of an irregular stretch of the whitening recursion. */
interface StretchStep {
  /** Observed-sample index at this lattice position, or -1 when the position was not read. */
  sample: number
  /** Kalman gain of the update (observed steps only). */
  gain: Float64Array | null
  /** Standard error of the one-step prediction (observed steps only). */
  sd: number
}

/** A run of lattice positions whose predictors are not the plain order-p AR predictor. */
interface Stretch {
  /**
   * Observed-sample indices holding the known state x(t0 - 1), x(t0 - 2), ..., x(t0 - p) just
   * before the stretch's first position t0, or null at the start of the record, where the state
   * starts from the stationary prior (mean zero, covariance Gamma_p).
   */
  init: number[] | null
  steps: StretchStep[]
}

/**
 * The exact whitening (innovations) operator of an AR fit observed on a subset of an evenly
 * spaced lattice: each observed value minus its best linear prediction from ALL earlier observed
 * values, divided by that prediction's standard error. Under the model the outputs are iid
 * N(0, 1), so generalized least squares on whitened data and whitened regressor columns is exact
 * even when some lattice positions were not read; no value is filled in.
 */
export interface ArWhitener {
  readonly fit: ArFit
  /** Number of observed samples the operator acts on. */
  readonly length: number
  /**
   * True at an observed sample whose p preceding lattice positions were all observed (and lie in
   * the record): its predictor is the plain AR predictor over the samples just before it, with
   * error variance sigma^2.
   */
  readonly regular: Uint8Array
  /** Sum of the log prediction-error variances: the log determinant of the observed covariance. */
  readonly logDet: number
  /** Whitens a real column given on the observed samples. */
  whiten(x: ArrayLike<number>): Float64Array
  /** Writes the whitened value of every non-regular observed sample of x into out. */
  whitenIrregular(x: ArrayLike<number>, out: Float64Array): void
  /**
   * The inverse operator: the series whose whitened values are `e`. The innovations operator is
   * lower triangular with a positive diagonal (each output is its sample minus a prediction from
   * earlier samples, over a positive standard error), so it is solved forward sample by sample:
   * x = sd e + prediction. A residual known only in whitened form maps back to raw values this
   * way at O(n p) cost.
   */
  unwhiten(e: ArrayLike<number>): Float64Array
}

/**
 * Builds the whitening operator of an AR fit for samples observed at the given strictly
 * increasing lattice positions. Regular samples use the AR predictor directly. Elsewhere (the
 * first p samples of the record and the samples after an unread position) the predictor comes
 * from the Kalman filter of the AR model in state-space form, which skips the update at an unread
 * position (R. H. Jones, "Maximum likelihood fitting of ARMA models to time series with missing
 * observations", Technometrics 22(3), 1980, 389-395). Its gains do not depend on the data, so they
 * are computed once here and every column costs O(n p). The state is
 * (x_t, x_{t-1}, ..., x_{t-p+1}) with the companion transition; it is known exactly after p
 * consecutive observations, from where the plain predictor applies again. Without unread
 * positions the operator equals `prewhiten`.
 */
export function arWhitener(fit: ArFit, lattice: ArrayLike<number>): ArWhitener {
  const m = lattice.length
  if (m === 0) throw new Error('The whitening operator needs at least one observed sample')
  for (let i = 1; i < m; i++) {
    if (!(lattice[i] > lattice[i - 1])) throw new Error('Lattice positions must increase strictly')
  }
  if (!(fit.noiseVariance > 0)) throw new Error('Whitening needs a positive innovation variance')
  const p = fit.coefficients.length
  const phi = fit.coefficients
  const sigma = Math.sqrt(fit.noiseVariance)
  const first = lattice[0]
  const last = lattice[m - 1]
  // sampleAt[t - first] = observed-sample index at lattice position t, or -1.
  const sampleAt = new Int32Array(last - first + 1).fill(-1)
  for (let i = 0; i < m; i++) sampleAt[lattice[i] - first] = i
  const observedAt = (t: number) => t >= first && t <= last && sampleAt[t - first] >= 0

  const regular = new Uint8Array(m)
  for (let i = 0; i < m; i++) {
    const t = lattice[i]
    let ok = t - first >= p
    for (let j = 1; ok && j <= p; j++) ok = observedAt(t - j)
    regular[i] = ok ? 1 : 0
  }
  let logDet = 0
  for (let i = 0; i < m; i++) if (regular[i]) logDet += Math.log(fit.noiseVariance)

  const stretches: Stretch[] = []
  if (p > 0) {
    const gamma = autocovariance(fit, p - 1)
    // Walk the lattice. A stretch starts at the record start and at every unread position
    // reached from a known state, and ends once p consecutive observations make the state known.
    let t = first
    while (t <= last) {
      const atStart = t === first
      if (!atStart && observedAt(t)) {
        t++
        continue
      }
      const P: number[][] = Array.from({ length: p }, (_, r) =>
        Array.from({ length: p }, (_, c) => {
          if (atStart) return gamma[Math.abs(r - c)]
          return r === 0 && c === 0 ? fit.noiseVariance : 0
        }),
      )
      const init = atStart ? null : Array.from({ length: p }, (_, j) => sampleAt[t - 1 - j - first])
      const steps: StretchStep[] = []
      let known = false
      while (t <= last && !known) {
        const sample = observedAt(t) ? sampleAt[t - first] : -1
        if (sample >= 0) {
          const F = P[0][0]
          const col = P.map((row) => row[0])
          const gain = new Float64Array(p)
          for (let r = 0; r < p; r++) gain[r] = col[r] / F
          for (let r = 0; r < p; r++) for (let c = 0; c < p; c++) P[r][c] -= (col[r] * col[c]) / F
          steps.push({ sample, gain, sd: Math.sqrt(F) })
          logDet += Math.log(F)
          let all = t - first >= p - 1
          for (let j = 1; all && j < p; j++) all = observedAt(t - j)
          known = all
        } else {
          steps.push({ sample: -1, gain: null, sd: 0 })
        }
        predictCovariance(phi, P, fit.noiseVariance)
        t++
      }
      stretches.push({ init, steps })
    }
  }

  const whitenIrregular = (x: ArrayLike<number>, out: Float64Array): void => {
    const a = new Float64Array(p)
    const scratch = new Float64Array(p)
    for (const stretch of stretches) {
      if (stretch.init) {
        for (let j = 0; j < p; j++) a[j] = x[stretch.init[j]]
        // The known state sits one position before the stretch: predict it forward.
        companionStep(phi, a, scratch)
      } else {
        a.fill(0)
      }
      for (const step of stretch.steps) {
        if (step.sample >= 0) {
          const innovation = x[step.sample] - a[0]
          out[step.sample] = innovation / step.sd
          for (let j = 0; j < p; j++) a[j] += step.gain![j] * innovation
        }
        companionStep(phi, a, scratch)
      }
    }
  }

  const whiten = (x: ArrayLike<number>): Float64Array => {
    if (x.length !== m) throw new Error(`Expected ${m} observed values, got ${x.length}`)
    const out = new Float64Array(m)
    for (let i = 0; i < m; i++) {
      if (!regular[i]) continue
      let e = x[i]
      for (let j = 0; j < p; j++) e -= phi[j] * x[i - 1 - j]
      out[i] = e / sigma
    }
    whitenIrregular(x, out)
    return out
  }

  const unwhiten = (e: ArrayLike<number>): Float64Array => {
    if (e.length !== m) throw new Error(`Expected ${m} whitened values, got ${e.length}`)
    const x = new Float64Array(m)
    const a = new Float64Array(p)
    const scratch = new Float64Array(p)
    // Regular samples follow the plain predictor; the stretches, in lattice order, hold every
    // other sample, so the samples are solved in index order.
    let next = 0
    const solveRegularBefore = (end: number) => {
      for (; next < end; next++) {
        let v = sigma * e[next]
        for (let j = 0; j < p; j++) v += phi[j] * x[next - 1 - j]
        x[next] = v
      }
    }
    for (const stretch of stretches) {
      const firstStep = stretch.steps.find((s) => s.sample >= 0)
      if (!firstStep) continue
      solveRegularBefore(firstStep.sample)
      if (stretch.init) {
        for (let j = 0; j < p; j++) a[j] = x[stretch.init[j]]
        companionStep(phi, a, scratch)
      } else {
        a.fill(0)
      }
      for (const step of stretch.steps) {
        if (step.sample >= 0) {
          const innovation = e[step.sample] * step.sd
          x[step.sample] = a[0] + innovation
          for (let j = 0; j < p; j++) a[j] += step.gain![j] * innovation
          next = step.sample + 1
        }
        companionStep(phi, a, scratch)
      }
    }
    solveRegularBefore(m)
    return x
  }

  return { fit, length: m, regular, logDet, whiten, whitenIrregular, unwhiten }
}

/**
 * The additive-outlier statistic of every observed sample of a series with AR noise (W. Chang,
 * G. C. Tiao and C. Chen, "Estimation of time series parameters in the presence of outliers",
 * Technometrics 30(2), 1988, 193-204; C. Chen and L.-M. Liu, "Joint estimation of model parameters
 * and outlier effects in time series", Journal of the American Statistical Association 88(421),
 * 1993, 284-297). An additive outlier of size w at sample i (a speck of dust or a hair on the scan,
 * displacing that one reading) adds w e_i to the series and so w c_i to its whitened values, where
 * c_i is the whitened unit impulse: column i of the whitening operator, here the AR operator of
 * `whitener` followed by division by the per-sample innovation scale `scale` (null for a constant
 * scale). From the model's whitened residual r, the least squares estimate of w is
 * c_i' r / c_i' c_i, and the standardized statistic
 *
 *     lambda_i = c_i' r / (sigma ||c_i||)
 *
 * is N(0, 1) at every sample when the series has no outlier (ibid.). Where the samples i to i + p
 * are all regular, c_i is the impulse response of the AR filter, pi_0 = 1 and pi_j = -phi_j over
 * those samples, and lambda_i = sum_j pi_j r_(i+j) / (sigma sqrt(sum_j pi_j^2)), Chang, Tiao and
 * Chen's form; at the record's start and end and next to unread samples, c_i is taken from the
 * exact operator, which runs the Kalman filter there (Jones 1980), so the statistic stays exact.
 * sigma is the model's own innovation scale, its maximum likelihood estimate from r,
 * sqrt(r' r / m); the caller re-estimates it after setting outliers aside, which uncovers outliers
 * the larger ones masked (Chang, Tiao and Chen 1988).
 */
export function additiveOutlierStatistics(
  whitener: ArWhitener,
  residual: ArrayLike<number>,
  scale: ArrayLike<number> | null = null,
): Float64Array {
  const m = whitener.length
  if (residual.length !== m) throw new Error(`Expected ${m} whitened residuals, got ${residual.length}`)
  const phi = whitener.fit.coefficients
  const p = phi.length
  const sigma = Math.sqrt(whitener.fit.noiseVariance)
  const regular = whitener.regular
  const scaleAt = (k: number) => sigma * (scale ? scale[k] : 1)
  const statistic = new Float64Array(m)
  const unit = new Float64Array(m)
  // A sample's column is the plain AR impulse response when every row it reaches is regular.
  let irregularAhead = m
  for (let i = m - 1; i >= 0; i--) {
    if (!regular[i]) irregularAhead = i
    let num = 0
    let den = 0
    if (irregularAhead > Math.min(i + p, m - 1)) {
      for (let j = 0; j <= p && i + j < m; j++) {
        const c = (j === 0 ? 1 : -phi[j - 1]) / scaleAt(i + j)
        num += c * residual[i + j]
        den += c * c
      }
    } else {
      unit[i] = 1
      const c = whitener.whiten(unit)
      unit[i] = 0
      for (let k = i; k < m; k++) {
        const ck = scale ? c[k] / scale[k] : c[k]
        num += ck * residual[k]
        den += ck * ck
      }
    }
    statistic[i] = num / Math.sqrt(den)
  }
  let ss = 0
  for (let i = 0; i < m; i++) ss += residual[i] * residual[i]
  const sd = Math.sqrt(ss / m)
  if (!(sd > 0)) throw new Error('The whitened residual has no spread, so no sample can be judged an outlier')
  for (let i = 0; i < m; i++) statistic[i] /= sd
  return statistic
}

/**
 * The samples one pass of additive-outlier detection flags (Chen and Liu 1993, s3): those whose
 * statistic (additiveOutlierStatistics) exceeds the Bonferroni critical value of a two-sided test at
 * level `alpha` over the m samples, z_(1 - alpha / (2 m)) (O. J. Dunn, "Multiple comparisons among
 * means", JASA 56, 1961), so a series without outliers has a sample flagged with probability at
 * most alpha. An outlier also raises the statistics of the samples within the AR order `order` on
 * either side, whose columns overlap its own, so only the largest exceedance within that many
 * lattice positions is flagged in one pass; the caller sets the flagged samples aside, refits and
 * repeats until a pass flags nothing.
 */
export function additiveOutliers(
  statistic: ArrayLike<number>,
  lattice: ArrayLike<number>,
  order: number,
  alpha: number,
): number[] {
  const m = statistic.length
  const critical = normalQuantile(1 - alpha / (2 * m))
  const flagged: number[] = []
  for (let i = 0; i < m; i++) {
    const size = Math.abs(statistic[i])
    if (!(size > critical)) continue
    let largest = true
    for (let k = i - 1; largest && k >= 0 && lattice[i] - lattice[k] <= order; k--) {
      if (Math.abs(statistic[k]) >= size) largest = false
    }
    for (let k = i + 1; largest && k < m && lattice[k] - lattice[i] <= order; k++) {
      if (Math.abs(statistic[k]) > size) largest = false
    }
    if (largest) flagged.push(i)
  }
  return flagged
}

/** a <- T a for the AR companion matrix T (new first entry phi' a, the rest shifted down). */
function companionStep(phi: readonly number[], a: Float64Array, scratch: Float64Array): void {
  const p = phi.length
  let s = 0
  for (let k = 0; k < p; k++) s += phi[k] * a[k]
  scratch[0] = s
  for (let r = 1; r < p; r++) scratch[r] = a[r - 1]
  a.set(scratch)
}

/** P <- T P T' + sigma^2 e1 e1' for the AR companion matrix T, in place. */
function predictCovariance(phi: readonly number[], P: number[][], noiseVariance: number): void {
  const p = phi.length
  const TP: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0))
  for (let c = 0; c < p; c++) {
    let s = 0
    for (let k = 0; k < p; k++) s += phi[k] * P[k][c]
    TP[0][c] = s
    for (let r = 1; r < p; r++) TP[r][c] = P[r - 1][c]
  }
  for (let r = 0; r < p; r++) {
    let s = 0
    for (let k = 0; k < p; k++) s += TP[r][k] * phi[k]
    P[r][0] = s
    for (let c = 1; c < p; c++) P[r][c] = TP[r][c - 1]
  }
  P[0][0] += noiseVariance
}
