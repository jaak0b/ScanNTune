/**
 * Autoregressive models of correlated measurement noise: fitting, order selection, exact
 * prewhitening, and the fitted model's second-order structure. Pure functions on plain number
 * arrays, shared by every flow whose along-line samples carry serially correlated noise.
 *
 * Convention: an AR(p) model is x_t = phi_1 x_{t-1} + ... + phi_p x_{t-p} + e_t with e_t white,
 * zero mean, variance sigma^2. The series is used as given (no mean is removed); callers pass
 * residuals of a fit that already carries a constant term.
 */

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
  const n = x.length
  const f = x.slice()
  const b = x.slice()
  let coefficients: number[] = []
  let variance = x.reduce((s, v) => s + v * v, 0) / n
  const path: BurgPath = [{ coefficients, noiseVariance: variance }]
  for (let m = 1; m <= maxOrder; m++) {
    let num = 0
    let den = 0
    for (let t = m; t < n; t++) {
      num += f[t] * b[t - 1]
      den += f[t] * f[t] + b[t - 1] * b[t - 1]
    }
    const k = den > 0 ? (2 * num) / den : 0
    // Descending t keeps b[t - 1] unmodified until stage t - 1 has read it.
    for (let t = n - 1; t >= m; t--) {
      const ft = f[t]
      const bt1 = b[t - 1]
      f[t] = ft - k * bt1
      b[t] = bt1 - k * ft
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
  const path = burgPath(x, maxOrder)
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
