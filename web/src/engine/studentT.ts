// Student-t distribution support for the confidence ranges of the N-scan error separation.
// Pure TypeScript, no dependencies. The quantile is found by inverting the t CDF numerically
// (bisection on a bracketed root, an established monotone-inversion approach); the CDF itself is
// the standard relation to the regularized incomplete beta function,
//   P(T <= t) = 1 - I_x(nu/2, 1/2) / 2  with  x = nu / (nu + t^2)  for t >= 0,
// evaluated with the modified Lentz continued fraction (Numerical Recipes "betacf", equivalent to
// Algorithm AS 63) and a Lanczos log-gamma. All constants below are the published coefficients of
// those algorithms.

import { normalCdf } from './math'

// Lanczos approximation coefficients (g = 7, n = 9), as published by Godfrey/Press et al.
const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
]

function logGamma(z: number): number {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z)
  const zm = z - 1
  let x = 0.99999999999980993
  for (let i = 0; i < LANCZOS.length; i++) x += LANCZOS[i] / (zm + i + 1)
  const t = zm + LANCZOS.length - 0.5
  return 0.5 * Math.log(2 * Math.PI) + (zm + 0.5) * Math.log(t) - t + Math.log(x)
}

// Continued fraction for the incomplete beta function, modified Lentz's method (NR "betacf").
function betaContinuedFraction(x: number, a: number, b: number): number {
  const FPMIN = 1e-300
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < FPMIN) d = FPMIN
  d = 1 / d
  let h = d
  for (let m = 1; m <= 300; m++) {
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
    if (Math.abs(del - 1) < 3e-15) break
  }
  return h
}

/** Regularized incomplete beta function I_x(a, b). */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const lnFront =
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  // Use the continued fraction directly where it converges fastest, else via the symmetry relation.
  if (x < (a + 1) / (a + b + 2)) return (Math.exp(lnFront) * betaContinuedFraction(x, a, b)) / a
  return 1 - (Math.exp(lnFront) * betaContinuedFraction(1 - x, b, a)) / b
}

/** CDF of Student's t distribution with dof degrees of freedom. */
export function tCdf(t: number, dof: number): number {
  if (dof <= 0) throw new Error(`Student-t needs positive degrees of freedom, got ${dof}.`)
  if (t === 0) return 0.5
  const x = dof / (dof + t * t)
  const halfTail = 0.5 * regularizedIncompleteBeta(x, dof / 2, 0.5)
  return t > 0 ? 1 - halfTail : halfTail
}

/**
 * Quantile (inverse CDF) of Student's t distribution: the t with P(T <= t) = p. Inverted by
 * bisection on the monotone CDF after doubling out an upper bracket.
 */
export function tQuantile(p: number, dof: number): number {
  if (dof <= 0) throw new Error(`Student-t needs positive degrees of freedom, got ${dof}.`)
  if (!(p > 0 && p < 1)) throw new Error(`Student-t quantile needs 0 < p < 1, got ${p}.`)
  if (p === 0.5) return 0
  if (p < 0.5) return -tQuantile(1 - p, dof)
  let lo = 0
  let hi = 1
  while (tCdf(hi, dof) < p && hi < 1e12) hi *= 2
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi)
    if (tCdf(mid, dof) < p) lo = mid
    else hi = mid
    if (hi - lo < 1e-12 * Math.max(1, hi)) break
  }
  return 0.5 * (lo + hi)
}

/**
 * Power of the two-sided Student t test with critical value `critical` against the noncentral t
 * with `dof` degrees of freedom and noncentrality `delta`: P(|T| > critical) for
 * T = (Z + delta) / S, Z standard normal and S = sqrt(V / dof) with V chi-square on dof degrees of
 * freedom, independent (the noncentral t of N. L. Johnson, S. Kotz and N. Balakrishnan,
 * "Continuous Univariate Distributions", vol. 2, 2nd ed., 1995, ch. 31). Given S = s the event is
 * a pair of normal tails, Phi(delta - c s) + Phi(-delta - c s), integrated over the density of S,
 * 2 (dof / 2)^(dof / 2) s^(dof - 1) e^(-dof s^2 / 2) / Gamma(dof / 2), by composite Simpson's rule
 * out to 14 standard deviations of S beyond 1.
 */
export function noncentralTPower(delta: number, dof: number, critical: number): number {
  if (dof <= 0) throw new Error(`Student-t needs positive degrees of freedom, got ${dof}.`)
  const half = dof / 2
  const logFront = Math.log(2) + half * Math.log(half) - logGamma(half)
  const top = 1 + 14 / Math.sqrt(2 * dof)
  const intervals = 4000
  const h = top / intervals
  let sum = 0
  for (let i = 0; i <= intervals; i++) {
    const s = i * h
    const density = s === 0 ? (dof === 1 ? Math.exp(logFront) : 0) : Math.exp(logFront + (dof - 1) * Math.log(s) - half * s * s)
    const tails = normalCdf(delta - critical * s) + normalCdf(-delta - critical * s)
    const weight = i === 0 || i === intervals ? 1 : i % 2 === 1 ? 4 : 2
    sum += weight * density * tails
  }
  return Math.min(1, (sum * h) / 3)
}
