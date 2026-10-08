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

/** Evaluates c[0] + c[1] r + ... + c[k] r^k by Horner's rule. */
function polynomial(c: readonly number[], r: number): number {
  let v = 0
  for (let i = c.length - 1; i >= 0; i--) v = v * r + c[i]
  return v
}

// Coefficients of Wichura's PPND16 (Applied Statistics algorithm AS 241), lowest order first.
// Central region |p - 0.5| <= 0.425: numerator a, denominator b (leading 1 implied first).
const AS241_A = [
  3.387132872796366608, 133.14166789178437745, 1971.5909503065514427, 13731.693765509461125,
  45921.953931549871457, 67265.770927008700853, 33430.575583588128105, 2509.0809287301226727,
]
const AS241_B = [
  1, 42.313330701600911252, 687.1870074920579083, 5394.1960214247511077,
  21213.794301586595867, 39307.89580009271061, 28729.085735721942674, 5226.495278852854561,
]
// Intermediate tail, r = sqrt(-ln(min(p, 1 - p))) <= 5, polynomials in r - 1.6.
const AS241_C = [
  1.42343711074968357734, 4.6303378461565452959, 5.7694972214606914055, 3.64784832476320460504,
  1.27045825245236838258, 0.24178072517745061177, 0.0227238449892691845833,
  7.7454501427834140764e-4,
]
const AS241_D = [
  1, 2.05319162663775882187, 1.6763848301838038494, 0.68976733498510000455,
  0.14810397642748007459, 0.0151986665636164571966, 5.475938084995344946e-4,
  1.05075007164441684324e-9,
]
// Far tail, r > 5, polynomials in r - 5.
const AS241_E = [
  6.6579046435011037772, 5.4637849111641143699, 1.7848265399172913358, 0.29656057182850489123,
  0.026532189526576123093, 0.0012426609473880784386, 2.71155556874348757815e-5,
  2.01033439929228813265e-7,
]
const AS241_F = [
  1, 0.59983220655588793769, 0.13692988092273580531, 0.0148753612908506148525,
  7.868691311456132591e-4, 1.8463183175100546818e-5, 1.4215117583164458887e-7,
  2.04426310338993978564e-15,
]

/**
 * Quantile function (inverse CDF) of the standard normal distribution: the z with
 * P(Z <= z) = p. Wichura's algorithm AS 241 (PPND16; M. J. Wichura, "The percentage points of
 * the normal distribution", Applied Statistics 37(3), 1988, 477-484): rational minimax
 * approximations in three regions, accurate to about 1 part in 10^16. Returns -Infinity at
 * p = 0, +Infinity at p = 1, and NaN outside [0, 1].
 */
export function normalQuantile(p: number): number {
  if (!(p >= 0 && p <= 1)) return NaN
  if (p === 0) return -Infinity
  if (p === 1) return Infinity
  const q = p - 0.5
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q
    return (q * polynomial(AS241_A, r)) / polynomial(AS241_B, r)
  }
  let r = Math.sqrt(-Math.log(q < 0 ? p : 1 - p))
  let z: number
  if (r <= 5) {
    r -= 1.6
    z = polynomial(AS241_C, r) / polynomial(AS241_D, r)
  } else {
    r -= 5
    z = polynomial(AS241_E, r) / polynomial(AS241_F, r)
  }
  return q < 0 ? -z : z
}

/**
 * Survival function P(X >= x) of the chi-square distribution with an even number of degrees
 * of freedom 2K, by its closed form e^{-x/2} sum_{j<K} (x/2)^j / j! (the Poisson-sum identity:
 * the chi-square with 2K degrees of freedom is the Gamma(K, 2) distribution, whose survival
 * function at x equals P(Poisson(x/2) < K)). The terms are accumulated in log space, so the
 * result stays exact for large x and K without overflow. Throws when the degrees of freedom
 * are not a positive even integer, because the closed form does not apply there.
 */
export function chiSquareSurvivalEvenDof(x: number, dof: number): number {
  if (!(Number.isInteger(dof) && dof > 0 && dof % 2 === 0)) {
    throw new Error(`chiSquareSurvivalEvenDof needs a positive even dof, got ${dof}`)
  }
  if (Number.isNaN(x)) return NaN
  if (x <= 0) return 1
  if (x === Infinity) return 0
  const half = x / 2
  const logHalf = Math.log(half)
  // log of each term e^{-x/2} (x/2)^j / j!, built up by the ratio between neighbours.
  const logTerms: number[] = [-half]
  for (let j = 1; j < dof / 2; j++) logTerms.push(logTerms[j - 1] + logHalf - Math.log(j))
  const top = Math.max(...logTerms)
  const sum = logTerms.reduce((s, t) => s + Math.exp(t - top), 0)
  return Math.min(1, Math.exp(top + Math.log(sum)))
}

/** ln Gamma(1/2) = ln sqrt(pi), exact. */
const LN_GAMMA_HALF = 0.5 * Math.log(Math.PI)

/**
 * Upper regularized incomplete gamma function Q(1/2, y) = erfc(sqrt(y)), by the series of the
 * lower function for y < 3/2 and the Legendre continued fraction of the upper function (modified
 * Lentz evaluation) otherwise (W. H. Press et al., "Numerical Recipes", 3rd ed., Cambridge 2007,
 * s6.2, routines gser and gcf), with Gamma(1/2) = sqrt(pi) exact, so no log-gamma approximation
 * enters.
 */
function upperGammaHalf(y: number): number {
  if (y <= 0) return 1
  const a = 0.5
  const front = Math.exp(-y + a * Math.log(y) - LN_GAMMA_HALF)
  if (y < a + 1) {
    let term = 1 / a
    let sum = term
    for (let n = 1; n < 500; n++) {
      term *= y / (a + n)
      sum += term
      if (Math.abs(term) < Math.abs(sum) * 1e-17) break
    }
    return 1 - sum * front
  }
  const FPMIN = 1e-300
  let b = y + 1 - a
  let c = 1 / FPMIN
  let d = 1 / b
  let h = d
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = b + an / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-16) break
  }
  return front * h
}

/**
 * Survival function P(X >= x) of the chi-square distribution with any positive integer number of
 * degrees of freedom. Even dof use the closed form of chiSquareSurvivalEvenDof. Odd dof 2K + 1 are
 * the upper regularized incomplete gamma Q(K + 1/2, x/2), reached from Q(1/2, y) = erfc(sqrt y)
 * by the upward recurrence Q(a + 1, y) = Q(a, y) + y^a e^{-y} / Gamma(a + 1) (M. Abramowitz and
 * I. A. Stegun, "Handbook of Mathematical Functions", 1964, 6.5.21 and 26.4.4), whose terms are
 * accumulated in log space with Gamma(j + 3/2) built exactly from Gamma(1/2) = sqrt(pi).
 */
export function chiSquareSurvival(x: number, dof: number): number {
  if (!(Number.isInteger(dof) && dof > 0)) {
    throw new Error(`chiSquareSurvival needs a positive integer dof, got ${dof}`)
  }
  if (dof % 2 === 0) return chiSquareSurvivalEvenDof(x, dof)
  if (Number.isNaN(x)) return NaN
  if (x <= 0) return 1
  if (x === Infinity) return 0
  const y = x / 2
  let q = upperGammaHalf(y)
  let logGammaNext = LN_GAMMA_HALF
  for (let j = 0; j < (dof - 1) / 2; j++) {
    // Gamma(j + 3/2) = (j + 1/2) Gamma(j + 1/2).
    logGammaNext += Math.log(j + 0.5)
    q += Math.exp((j + 0.5) * Math.log(y) - y - logGammaNext)
  }
  return Math.min(1, q)
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
