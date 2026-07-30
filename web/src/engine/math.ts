// Median of a list (average of the two central values for even length). Returns 0 for an empty list.
export function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  const n = sorted.length
  if (n === 0) return 0
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
}

/** Normal-consistency factor for the MAD (sigma = 1.4826 * MAD for Gaussian data). */
export const MAD_TO_SIGMA = 1.4826
/** Asymptotic standard error of the median is 1.2533 * sigma / sqrt(n) for Gaussian data. */
export const MEDIAN_EFFICIENCY = 1.2533

/** Median absolute deviation of a list about its own median. Returns 0 for an empty list. */
export function mad(values: number[]): number {
  const center = median(values)
  return median(values.map((v) => Math.abs(v - center)))
}

/**
 * Asymptotic standard error of the median of a list, with the spread estimated robustly:
 * 1.2533 * 1.4826 * MAD / sqrt(n). Returns 0 for an empty list.
 */
export function medianStandardError(values: number[]): number {
  if (values.length === 0) return 0
  return (MEDIAN_EFFICIENCY * MAD_TO_SIGMA * mad(values)) / Math.sqrt(values.length)
}

/**
 * Hampel identifier (moving-window median/MAD outlier detector): a sample is flagged when it
 * deviates from the median of its window by more than nSigma robust sigmas (1.4826 * MAD).
 * Returns a boolean mask, true where the sample is an outlier. Non-finite samples pass through
 * unflagged (they are gaps, not outliers) but are excluded from every window. Windows with fewer
 * than 5 finite samples flag nothing (the local statistics are meaningless there). The sigma
 * floor of 0.005 guards the degenerate zero-MAD case (a locally constant signal), where any
 * deviation at all would otherwise be infinite sigmas out.
 */
export function hampelOutliers(values: number[], halfWindow: number, nSigma: number): boolean[] {
  const rejected = new Array<boolean>(values.length).fill(false)
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) continue
    const local: number[] = []
    for (let j = Math.max(0, i - halfWindow); j <= Math.min(values.length - 1, i + halfWindow); j++) {
      if (Number.isFinite(values[j])) local.push(values[j])
    }
    if (local.length < 5) continue
    const center = median(local)
    const sigma = Math.max(MAD_TO_SIGMA * median(local.map((v) => Math.abs(v - center))), 0.005)
    if (Math.abs(values[i] - center) > nSigma * sigma) rejected[i] = true
  }
  return rejected
}

/**
 * Log-gamma function by the Lanczos approximation (Lanczos 1964, coefficients as tabulated in
 * Numerical Recipes, g = 5, 6 terms), accurate to better than 2e-10 for positive arguments.
 */
export function logGamma(x: number): number {
  const coefficients = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ]
  const y = x
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5)
  let series = 1.000000000190015
  for (let j = 0; j < 6; j++) series += coefficients[j] / (y + 1 + j)
  return -tmp + Math.log((2.5066282746310005 * series) / x)
}

// Continued-fraction evaluation for the incomplete beta function (the standard betacf routine
// of Numerical Recipes, modified Lentz's method).
function betaContinuedFraction(a: number, b: number, x: number): number {
  const MAX_ITER = 200
  const EPS = 3e-14
  const FPMIN = 1e-300
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < FPMIN) d = FPMIN
  d = 1 / d
  let h = d
  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return h
}

/**
 * Regularized incomplete beta function I_x(a, b) (the beta distribution CDF), computed by the
 * standard continued-fraction expansion (Numerical Recipes "betai"/"betacf"), using the
 * symmetry I_x(a, b) = 1 - I_{1-x}(b, a) to keep the fraction in its fast-converging region.
 */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (!(a > 0) || !(b > 0)) return NaN
  if (x <= 0) return 0
  if (x >= 1) return 1
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  )
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b
}

/**
 * Upper critical value of the F distribution: the value f with P(F(d1, d2) > f) = alpha. The
 * F survival function is P(F > f) = I_{d2 / (d2 + d1 f)}(d2/2, d1/2); the critical value is
 * found by bisection on that monotone function.
 */
export function fCriticalValue(d1: number, d2: number, alpha: number): number {
  if (!(d1 > 0) || !(d2 > 0) || !(alpha > 0) || !(alpha < 1)) return NaN
  const survival = (f: number) => regularizedIncompleteBeta(d2 / (d2 + d1 * f), d2 / 2, d1 / 2)
  let lo = 0
  let hi = 1
  while (survival(hi) > alpha) {
    hi *= 2
    if (hi > 1e12) return hi
  }
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (survival(mid) > alpha) lo = mid
    else hi = mid
    if (hi - lo < 1e-10 * Math.max(1, hi)) break
  }
  return (lo + hi) / 2
}

/**
 * Seedable deterministic PRNG (mulberry32, Tommy Ettinger's public-domain generator): a 32-bit
 * state hashed through two rounds of multiply-xorshift per draw, returning uniform floats in
 * [0, 1). Used wherever a reproducible random stream is needed (bootstrap resampling, synthetic
 * fixtures).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
