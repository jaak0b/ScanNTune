import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../../src/engine/math'
import {
  arWhitener,
  autocovariance,
  burgAr,
  burgArSegments,
  defaultMaxArOrder,
  latticeSegments,
  prewhiten,
  selectOrderAicc,
  selectOrderAiccSegments,
  spectralDensity,
} from '../../src/engine/correlatedNoise'

// Synthetic ground truth: AR series are generated from known coefficients and unit innovation
// variance, and the estimators must recover them. Tolerances are the methods' sampling noise:
// at n = 4000, the asymptotic standard error of an AR(2) coefficient is sqrt((1 - phi_2^2) / n)
// = 0.01508 for phi_2 = -0.3 (the diagonal of sigma^2 Gamma_2^{-1} / n, the asymptotic
// covariance Burg's estimator shares with Yule-Walker's; Brockwell and Davis 1991, s8.1), so
// three standard errors are 0.045; a sample variance of unit-variance Gaussian data has standard error
// sqrt(2 / n) = 0.02236, three of which are 0.067; and a sample autocorrelation of white noise
// has standard error 1 / sqrt(n), three of which are 0.0474 (all hand-computed).

/** Standard normal draws by the Box-Muller transform over a seeded mulberry32 stream. */
function gaussianStream(seed: number): () => number {
  const uniform = mulberry32(seed)
  return () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform())
}

/** n samples of a unit-innovation AR process, after a burn-in that forgets the zero start. */
function simulateAr(phi: number[], n: number, seed: number, burnIn = 1000): number[] {
  const noise = gaussianStream(seed)
  const x: number[] = []
  for (let t = 0; t < burnIn + n; t++) {
    x.push(phi.reduce((s, c, j) => s + c * (x[t - 1 - j] ?? 0), noise()))
  }
  return x.slice(burnIn)
}

/** Sample autocorrelation of a series at one lag (the standard biased estimator). */
function sampleAutocorrelation(w: number[], lag: number): number {
  const mean = w.reduce((s, v) => s + v, 0) / w.length
  let num = 0
  let den = 0
  for (let t = 0; t < w.length; t++) {
    den += (w[t] - mean) ** 2
    if (t + lag < w.length) num += (w[t] - mean) * (w[t + lag] - mean)
  }
  return num / den
}

const seeds = Array.from({ length: 100 }, (_, i) => i + 1)

describe('burgAr', () => {
  it('recovers the AR(2) coefficients [0.6, -0.3] within three standard errors at n = 4000', () => {
    const fit = burgAr(simulateAr([0.6, -0.3], 4000, 1), 2)
    expect(fit.coefficients).toHaveLength(2)
    expect(Math.abs(fit.coefficients[0] - 0.6)).toBeLessThanOrEqual(0.045)
    expect(Math.abs(fit.coefficients[1] + 0.3)).toBeLessThanOrEqual(0.045)
    expect(Math.abs(fit.noiseVariance - 1)).toBeLessThanOrEqual(0.067)
  })
  it('matches the hand-computed order-1 fit of a short series', () => {
    // x = [1, 2, 3]: k = 2 (2*1 + 3*2) / ((4 + 1) + (9 + 4)) = 16 / 18 = 0.8888889, and
    // sigma^2 = (14 / 3) (1 - (8/9)^2) = 238 / 243 = 0.9794239 (hand-computed).
    const fit = burgAr([1, 2, 3], 1)
    expect(fit.coefficients[0]).toBeCloseTo(0.8888889, 7)
    expect(fit.noiseVariance).toBeCloseTo(0.9794239, 7)
  })
  it('matches an exact-rational Burg recursion at order 3', () => {
    // Independent oracle: Burg's recursion in exact fractions (Python fractions.Fraction) on
    // x = [1, 2, 4, 3, 5, 2, 0, 1]: phi = [0.7424608256, 0.1216960805, -0.0646819738],
    // sigma^2 = 2.7141884811.
    const fit = burgAr([1, 2, 4, 3, 5, 2, 0, 1], 3)
    expect(fit.coefficients[0]).toBeCloseTo(0.7424608256, 9)
    expect(fit.coefficients[1]).toBeCloseTo(0.1216960805, 9)
    expect(fit.coefficients[2]).toBeCloseTo(-0.0646819738, 9)
    expect(fit.noiseVariance).toBeCloseTo(2.7141884811, 9)
  })
  it('keeps the previous fit once the prediction errors vanish', () => {
    // An alternating series is predicted exactly at order 1 (phi = -1, zero error), so the
    // order-2 stage has nothing left to model (hand-computed; same in the exact oracle).
    const fit = burgAr([1, -1, 1, -1, 1], 2)
    expect(fit.coefficients[0]).toBe(-1)
    expect(fit.coefficients[1]).toBe(0)
    expect(fit.noiseVariance).toBe(0)
  })
  it('returns the mean square as the order-0 innovation variance', () => {
    // (1 + 4 + 9) / 3 = 4.6666667 (hand-computed).
    const fit = burgAr([1, 2, 3], 0)
    expect(fit.coefficients).toEqual([])
    expect(fit.noiseVariance).toBeCloseTo(4.6666667, 7)
  })
  it('throws on an order the series cannot support', () => {
    expect(() => burgAr([1, 2, 3], 3)).toThrow(
      'The AR order must be an integer from 0 to 2, got 3',
    )
    expect(() => burgAr([1, 2, 3], -1)).toThrow(/integer from 0 to 2/)
    expect(() => burgAr([1, 2, 3], 1.5)).toThrow(/integer from 0 to 2/)
    expect(() => burgAr([], 0)).toThrow(/at least one sample/)
  })
})

describe('selectOrderAicc', () => {
  it('searches up to floor(10 log10 n), below n - 2', () => {
    // floor(10 log10 4000) = floor(36.02) = 36; floor(10 log10 100) = 20; at n = 5 the
    // n - 3 = 2 cap binds below floor(6.99) = 6 (hand-computed).
    expect(defaultMaxArOrder(4000)).toBe(36)
    expect(defaultMaxArOrder(100)).toBe(20)
    expect(defaultMaxArOrder(5)).toBe(2)
  })
  it('selects order 2 for an AR(2) at least as often as AIC-type selection guarantees', () => {
    // AIC-type criteria never stop overfitting as n grows: the asymptotic probability of
    // selecting exactly the true order is 0.7117 (Shibata 1976, Biometrika 63, from Spitzer's
    // random-walk formula exp(-sum_k P(chi2_k > 2k) / k)). Over 100 seeds the 0.001 lower
    // binomial quantile of that rate is 57 (hand-computed with scipy.stats.binom). At
    // n = 4000 these coefficients are far above the noise, so no seed may underfit.
    const orders = seeds.map(
      (seed) => selectOrderAicc(simulateAr([0.6, -0.3], 4000, seed)).coefficients.length,
    )
    expect(orders.filter((p) => p === 2).length).toBeGreaterThanOrEqual(57)
    expect(Math.min(...orders)).toBe(2)
  })
  it('selects order 0 for white noise at least as often as AIC-type selection guarantees', () => {
    // Same asymptotic rate and binomial bound as the AR(2) case.
    const orders = seeds.map(
      (seed) => selectOrderAicc(simulateAr([], 4000, seed)).coefficients.length,
    )
    expect(orders.filter((p) => p === 0).length).toBeGreaterThanOrEqual(57)
  })
  it('applies the small-sample correction that keeps a short noisy series at order 0', () => {
    // Independent oracle (an exact-rational Burg recursion with AICc, in Python): on this 13-sample
    // series AICc selects order 0 with a margin of 2.81 over the runner-up, while the
    // uncorrected AIC n ln sigma^2 + 2p selects order 9.
    const series = [5, -5, 9, 8, 4, -9, -4, -7, 3, -9, -3, -9, 5]
    expect(selectOrderAicc(series).coefficients).toHaveLength(0)
  })
  it('throws when the search order leaves AICc undefined, and accepts the largest valid one', () => {
    expect(() => selectOrderAicc([1, 2, 3, 4, 5], 3)).toThrow(
      'AICc needs the AR order below n - 2 (3), got 3',
    )
    expect(() => selectOrderAicc([1, 2, 3, 4, 5], 2)).not.toThrow()
  })
})

describe('prewhiten', () => {
  it('whitens an AR(1) series to lag 1 to 10 autocorrelations within 3 / sqrt(n), first sample included', () => {
    const x = simulateAr([0.8], 4000, 2)
    const w = prewhiten(x, burgAr(x, 1))
    expect(w).toHaveLength(4000)
    for (const lag of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(Math.abs(sampleAutocorrelation(w, lag)), `lag ${lag}`).toBeLessThanOrEqual(0.0474)
    }
    const variance = w.reduce((s, v) => s + v * v, 0) / w.length
    expect(Math.abs(variance - 1)).toBeLessThanOrEqual(0.067)
  })
  it('gives the first p samples unit variance and no correlation through the lower-order predictors', () => {
    // 4000 independent stationary AR(2) windows of three samples, whitened under the true
    // model: samples 0 and 1 use the order-0 and order-1 predictors, sample 2 the full model.
    const model = { coefficients: [0.6, -0.3], noiseVariance: 1 }
    const windows = Array.from({ length: 4000 }, (_, r) =>
      prewhiten(simulateAr([0.6, -0.3], 3, 10_000 + r, 200), model),
    )
    const meanSquare = (t: number) => windows.reduce((s, w) => s + w[t] * w[t], 0) / 4000
    const meanProduct = (a: number, b: number) =>
      windows.reduce((s, w) => s + w[a] * w[b], 0) / 4000
    expect(Math.abs(meanSquare(0) - 1), 'sample 0').toBeLessThanOrEqual(0.067)
    expect(Math.abs(meanSquare(1) - 1), 'sample 1').toBeLessThanOrEqual(0.067)
    expect(Math.abs(meanSquare(2) - 1), 'sample 2').toBeLessThanOrEqual(0.067)
    expect(Math.abs(meanProduct(0, 1)), 'samples 0 and 1').toBeLessThanOrEqual(0.0474)
    expect(Math.abs(meanProduct(1, 2)), 'samples 1 and 2').toBeLessThanOrEqual(0.0474)
    expect(Math.abs(meanProduct(0, 2)), 'samples 0 and 2').toBeLessThanOrEqual(0.0474)
  })
  it('only rescales a series under a white noise model', () => {
    expect(prewhiten([2, -4, 6], { coefficients: [], noiseVariance: 4 })).toEqual([1, -2, 3])
  })
  it('throws on a non-positive innovation variance', () => {
    expect(() => prewhiten([1, 2], { coefficients: [0.5], noiseVariance: 0 })).toThrow(
      /positive innovation variance/,
    )
  })
})

describe('autocovariance', () => {
  it('matches the AR(1) autocovariance phi^h / (1 - phi^2)', () => {
    // phi = 0.8, sigma^2 = 1: 2.7777778, 2.2222222, 1.7777778, 1.4222222 (hand-computed,
    // confirmed by the MA(infinity) weight sum sigma^2 sum_j psi_j psi_{j+h}).
    const gamma = autocovariance({ coefficients: [0.8], noiseVariance: 1 }, 3)
    expect(gamma).toHaveLength(4)
    expect(gamma[0]).toBeCloseTo(2.7777778, 7)
    expect(gamma[1]).toBeCloseTo(2.2222222, 7)
    expect(gamma[2]).toBeCloseTo(1.7777778, 7)
    expect(gamma[3]).toBeCloseTo(1.4222222, 7)
  })
  it('matches the AR(2) autocovariance from its MA(infinity) weights', () => {
    // phi = [0.6, -0.3], sigma^2 = 1, from sigma^2 sum_j psi_j psi_{j+h} (numpy, 5000 terms).
    const gamma = autocovariance({ coefficients: [0.6, -0.3], noiseVariance: 1 }, 4)
    expect(gamma[0]).toBeCloseTo(1.396348, 6)
    expect(gamma[1]).toBeCloseTo(0.6444683, 6)
    expect(gamma[2]).toBeCloseTo(-0.0322234, 6)
    expect(gamma[3]).toBeCloseTo(-0.2126745, 6)
    expect(gamma[4]).toBeCloseTo(-0.1179377, 6)
  })
  it('matches the AR(3) autocovariance from its MA(infinity) weights', () => {
    // phi = [0.5, -0.2, 0.1], sigma^2 = 1, from sigma^2 sum_j psi_j psi_{j+h} (numpy, 6000
    // terms); order 3 exercises every index of the step-down and the Levinson identity.
    const gamma = autocovariance({ coefficients: [0.5, -0.2, 0.1], noiseVariance: 1 }, 5)
    expect(gamma[0]).toBeCloseTo(1.2566138, 6)
    expect(gamma[1]).toBeCloseTo(0.5291005, 6)
    expect(gamma[2]).toBeCloseTo(0.0661376, 6)
    expect(gamma[3]).toBeCloseTo(0.0529101, 6)
    expect(gamma[4]).toBeCloseTo(0.0661376, 6)
    expect(gamma[5]).toBeCloseTo(0.0291005, 6)
  })
  it('is the variance at lag 0 and zero beyond it for white noise', () => {
    expect(autocovariance({ coefficients: [], noiseVariance: 2.5 }, 2)).toEqual([2.5, 0, 0])
  })
  it('throws on a non-stationary model', () => {
    expect(() => autocovariance({ coefficients: [1], noiseVariance: 1 }, 2)).toThrow(
      /not stationary/,
    )
  })
})

describe('spectralDensity', () => {
  it('equals the variance at every frequency for white noise', () => {
    const white = { coefficients: [], noiseVariance: 2.5 }
    expect(spectralDensity(white, 0)).toBe(2.5)
    expect(spectralDensity(white, 0.13)).toBe(2.5)
    expect(spectralDensity(white, 0.25)).toBe(2.5)
    expect(spectralDensity(white, 0.5)).toBe(2.5)
  })
  it('matches the AR(1) and AR(2) densities at hand-computed frequencies', () => {
    // AR(1) phi = 0.8: 1 / (1 - 0.8)^2 = 25 at f = 0, 1 / 1.8^2 = 0.3086420 at f = 0.5,
    // 1 / (1 + 0.64) = 0.6097561 at f = 0.25 (hand-computed).
    const ar1 = { coefficients: [0.8], noiseVariance: 1 }
    expect(spectralDensity(ar1, 0)).toBeCloseTo(25, 9)
    expect(spectralDensity(ar1, 0.5)).toBeCloseTo(0.308642, 6)
    expect(spectralDensity(ar1, 0.25)).toBeCloseTo(0.6097561, 7)
    // AR(2) phi = [0.6, -0.3] at f = 0.1: 2.6784972 (numpy complex evaluation).
    expect(spectralDensity({ coefficients: [0.6, -0.3], noiseVariance: 1 }, 0.1)).toBeCloseTo(
      2.6784972,
      7,
    )
  })
})

describe('burgArSegments', () => {
  it('never predicts across the boundary between two segments', () => {
    // Segments [1, 2] and [3, 4] at order 1: k = 2 (2*1 + 4*3) / ((4 + 1) + (16 + 9)) =
    // 28 / 30 = 0.9333333, sigma^2 = 7.5 (1 - k^2) = 0.9666667 (hand-computed). The joined
    // series [1, 2, 3, 4] would also pair 3 with 2 and give k = 40 / 43 = 0.9302326.
    const fit = burgArSegments([[1, 2], [3, 4]], 1)
    expect(fit.coefficients[0]).toBeCloseTo(0.9333333, 7)
    expect(fit.noiseVariance).toBeCloseTo(0.9666667, 7)
  })
  it('recovers the AR(2) coefficients from 20 separated segments within three standard errors', () => {
    // 4000 samples of AR(2) [0.6, -0.3] cut into 20 independent segments of 200: the same
    // n = 4000 standard errors as the single series (3 SE = 0.045, see the header).
    const segments = Array.from({ length: 20 }, (_, g) => simulateAr([0.6, -0.3], 200, 500 + g))
    const fit = selectOrderAiccSegments(segments)
    expect(fit.coefficients.length).toBeGreaterThanOrEqual(2)
    expect(Math.abs(fit.coefficients[0] - 0.6)).toBeLessThanOrEqual(0.045)
    expect(Math.abs(fit.coefficients[1] + 0.3)).toBeLessThanOrEqual(0.045)
  })
})

describe('latticeSegments', () => {
  it('splits observed values at every skipped lattice position', () => {
    expect(latticeSegments([10, 11, 13, 14, 15, 19], [0, 1, 3, 4, 5, 9])).toEqual([
      [10, 11],
      [13, 14, 15],
      [19],
    ])
  })
})

describe('arWhitener', () => {
  it('whitens across an unread sample with the two-step predictor and its variance', () => {
    // AR(1) phi = 0.5, sigma^2 = 1, values 1, 2, 3 read at lattice 0, 1, 3 (2 unread):
    // e0 = 1 / sqrt(gamma0) with gamma0 = 1 / (1 - 0.25) = 4/3, so 0.8660254;
    // e1 = (2 - 0.5 * 1) / 1 = 1.5; e3 predicts x3 from x1 over two steps: 0.25 * 2 = 0.5 with
    // variance 1 + 0.25 = 1.25, so (3 - 0.5) / sqrt(1.25) = 2.2360680. The log determinant is
    // ln(4/3) + ln 1 + ln 1.25 = 0.5108256 (all hand-computed).
    const w = arWhitener({ coefficients: [0.5], noiseVariance: 1 }, [0, 1, 3])
    const e = w.whiten([1, 2, 3])
    expect(e[0]).toBeCloseTo(0.8660254, 7)
    expect(e[1]).toBeCloseTo(1.5, 12)
    expect(e[2]).toBeCloseTo(2.236068, 6)
    expect(w.logDet).toBeCloseTo(0.5108256, 7)
    expect(Array.from(w.regular)).toEqual([0, 1, 0])
  })
  it('equals the gapless exact prewhitening when every lattice position is read', () => {
    const model = { coefficients: [0.6, -0.3], noiseVariance: 1.3 }
    const x = simulateAr([0.6, -0.3], 50, 77)
    const lattice = x.map((_, i) => i)
    const viaOperator = Array.from(arWhitener(model, lattice).whiten(x))
    const viaPrewhiten = prewhiten(x, model)
    viaOperator.forEach((v, i) => expect(v).toBeCloseTo(viaPrewhiten[i], 12))
  })
  it('leaves the values after isolated unread samples uncorrelated with unit variance', () => {
    // AR(1) phi = 0.9 with about 10% isolated unread samples in 20000. Under the model the
    // whitened value right after each gap has unit variance and no correlation with the one
    // right before the gap; restarting the predictor after the gap instead would leave a
    // correlation near phi^2 sqrt(1 - phi^2) = 0.35. Tolerances: three standard errors over the
    // roughly 1800 gaps, sqrt(2 / 1800) * 3 = 0.10 and 3 / sqrt(1800) = 0.071 (hand-computed).
    const x = simulateAr([0.9], 20000, 31)
    const rand = mulberry32(99)
    const read: boolean[] = x.map(() => true)
    for (let k = 2; k < x.length - 2; k++) if (read[k - 1] && rand() < 0.1) read[k] = false
    const lattice = x.map((_, k) => k).filter((k) => read[k])
    const e = arWhitener({ coefficients: [0.9], noiseVariance: 1 }, lattice).whiten(
      lattice.map((k) => x[k]),
    )
    const after: number[] = []
    const before: number[] = []
    for (let i = 1; i < lattice.length; i++) {
      if (lattice[i] !== lattice[i - 1] + 1) {
        after.push(e[i])
        before.push(e[i - 1])
      }
    }
    expect(after.length).toBeGreaterThan(1700)
    const meanSquare = after.reduce((s, v) => s + v * v, 0) / after.length
    const meanProduct = after.reduce((s, v, i) => s + v * before[i], 0) / after.length
    expect(Math.abs(meanSquare - 1)).toBeLessThanOrEqual(0.1)
    expect(Math.abs(meanProduct)).toBeLessThanOrEqual(0.071)
  })
  it('throws on lattice positions that do not increase', () => {
    expect(() => arWhitener({ coefficients: [0.5], noiseVariance: 1 }, [0, 2, 2])).toThrow(
      /increase strictly/,
    )
  })
})
