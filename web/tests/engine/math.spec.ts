import { describe, expect, it } from 'vitest'
import {
  chiSquareSurvival,
  chiSquareSurvivalEvenDof,
  hampelOutliers,
  mad,
  median,
  medianStandardError,
  mulberry32,
  normalQuantile,
} from '../../src/engine/math'

describe('median', () => {
  it('averages the two central values for an even-length list', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
  it('returns the central value for an odd-length list', () => {
    expect(median([9, 1, 5])).toBe(5)
  })
})

describe('mad', () => {
  it('is robust to a single gross outlier', () => {
    // Hand-computed: median of [1, 2, 3, 4, 100] is 3; absolute deviations are
    // [2, 1, 0, 1, 97], whose median is 1.
    expect(mad([1, 2, 3, 4, 100])).toBe(1)
  })
  it('returns 0 for an empty list', () => {
    expect(mad([])).toBe(0)
  })
})

describe('hampelOutliers', () => {
  it('flags a gross outlier and keeps the surrounding samples', () => {
    const values = [1, 1.01, 0.99, 1, 5, 1.02, 0.98, 1, 1.01]
    const rejected = hampelOutliers(values, 4, 4)
    expect(rejected[4]).toBe(true)
    expect(rejected.filter(Boolean)).toHaveLength(1)
  })
  it('passes NaN gaps through unflagged and excludes them from the windows', () => {
    const values = [1, NaN, 1.01, 0.99, 5, 1, NaN, 1.02, 0.98]
    const rejected = hampelOutliers(values, 4, 4)
    expect(rejected[1]).toBe(false)
    expect(rejected[6]).toBe(false)
    expect(rejected[4]).toBe(true)
  })
  it('flags nothing when a window has fewer than 5 finite samples', () => {
    expect(hampelOutliers([1, 1, 100, 1], 1, 4)).toEqual([false, false, false, false])
  })
  it('does not flag ordinary noise on a locally constant signal (sigma floor)', () => {
    // All-equal neighbourhood: MAD is 0, so without the 0.005 floor the 1.003 sample
    // would be infinitely many sigmas out.
    const values = [1, 1, 1, 1, 1.003, 1, 1, 1, 1]
    expect(hampelOutliers(values, 4, 4).some(Boolean)).toBe(false)
  })
})

describe('normalQuantile', () => {
  it('matches the standard normal quantiles in the central region |p - 0.5| <= 0.425', () => {
    // scipy.stats.norm.ppf: 0.9 -> 1.2815515655, 0.75 -> 0.6744897502, 0.3 -> -0.5244005127.
    expect(normalQuantile(0.9)).toBeCloseTo(1.2815515655, 9)
    expect(normalQuantile(0.75)).toBeCloseTo(0.6744897502, 9)
    expect(normalQuantile(0.3)).toBeCloseTo(-0.5244005127, 9)
    expect(normalQuantile(0.5)).toBe(0)
  })
  it('matches the published standard normal percentage points in the intermediate tail', () => {
    // Standard normal table: z_0.975 = 1.959964, z_0.95 = 1.644854, z_0.999 = 3.090232.
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 6)
    expect(normalQuantile(0.95)).toBeCloseTo(1.644854, 6)
    expect(normalQuantile(0.025)).toBeCloseTo(-1.959964, 6)
    expect(normalQuantile(0.999)).toBeCloseTo(3.090232, 6)
    // scipy.stats.norm.ppf(1e-10) = -6.361340902404056.
    expect(normalQuantile(1e-10)).toBeCloseTo(-6.3613409024, 9)
  })
  it('matches the far tail beyond r = 5', () => {
    // scipy.stats.norm.ppf: 1e-15 -> -7.941345326170998, 1e-300 -> -37.0470962993612.
    expect(normalQuantile(1e-15)).toBeCloseTo(-7.9413453262, 9)
    expect(normalQuantile(1e-300)).toBeCloseTo(-37.0470962994, 9)
    expect(normalQuantile(1 - 1e-15)).toBeCloseTo(7.94, 1)
  })
  it('returns infinities at 0 and 1 and NaN outside [0, 1]', () => {
    expect(normalQuantile(0)).toBe(-Infinity)
    expect(normalQuantile(1)).toBe(Infinity)
    expect(normalQuantile(1.5)).toBeNaN()
    expect(normalQuantile(-0.1)).toBeNaN()
    expect(normalQuantile(NaN)).toBeNaN()
  })
})

describe('chiSquareSurvivalEvenDof', () => {
  it('returns the tail probability of the published chi-square critical values', () => {
    // Chi-square table critical values to six decimals: chi2_2(0.95) = 5.991465 and
    // chi2_20(0.999) = 45.314746; their upper tails are 0.05000 and 0.001000 (4 digits).
    expect(chiSquareSurvivalEvenDof(5.991465, 2)).toBeCloseTo(0.05, 5)
    expect(chiSquareSurvivalEvenDof(45.314746, 20)).toBeCloseTo(0.001, 6)
  })
  it('matches the closed form at a hand-computed point', () => {
    // 4 dof at x = 2: e^{-1} (1 + 1) = 2 / e = 0.7357589 (hand-computed).
    expect(chiSquareSurvivalEvenDof(2, 4)).toBeCloseTo(0.7357589, 7)
  })
  it('stays accurate deep in the tail and near 1 for many degrees of freedom', () => {
    // scipy.stats.chi2.sf(300, 60) = 1.2835090407158946e-33 and sf(100, 200) = 0.99999999968.
    expect(chiSquareSurvivalEvenDof(300, 60) / 1.2835090407158946e-33).toBeCloseTo(1, 8)
    expect(chiSquareSurvivalEvenDof(100, 200)).toBeCloseTo(0.99999999968, 10)
  })
  it('keeps the log-space sum finite when the terms span more than the double range', () => {
    // 2000 dof at x = 4000: the summed terms span about e^1688, beyond any double ratio.
    // scipy.stats.chi2.sf(4000, 2000) = 6.847349459617758e-136.
    expect(chiSquareSurvivalEvenDof(4000, 2000) / 6.847349459617758e-136).toBeCloseTo(1, 8)
  })
  it('is 1 at and below zero and 0 at infinity', () => {
    expect(chiSquareSurvivalEvenDof(0, 2)).toBe(1)
    expect(chiSquareSurvivalEvenDof(-3, 6)).toBe(1)
    expect(chiSquareSurvivalEvenDof(Infinity, 6)).toBe(0)
  })
  it('throws on degrees of freedom that are not a positive even integer', () => {
    expect(() => chiSquareSurvivalEvenDof(1, 3)).toThrow(/even dof/)
    expect(() => chiSquareSurvivalEvenDof(1, 0)).toThrow(/even dof/)
    expect(() => chiSquareSurvivalEvenDof(1, 2.5)).toThrow(/even dof/)
  })
})

describe('chiSquareSurvival', () => {
  it('returns the tail probability of the published odd-dof chi-square critical values', () => {
    // Chi-square table critical values to six decimals: chi2_1(0.95) = 3.841459,
    // chi2_1(0.999) = 10.827566, chi2_3(0.95) = 7.814728, chi2_9(0.999) = 27.877165.
    expect(chiSquareSurvival(3.841459, 1)).toBeCloseTo(0.05, 6)
    expect(chiSquareSurvival(10.827566, 1)).toBeCloseTo(0.001, 7)
    expect(chiSquareSurvival(7.814728, 3)).toBeCloseTo(0.05, 6)
    expect(chiSquareSurvival(27.877165, 9)).toBeCloseTo(0.001, 7)
  })
  it('matches erfc on both sides of the series and continued-fraction split', () => {
    // 1 dof: P(X >= x) = erfc(sqrt(x / 2)); Python math.erfc(0.5) = 0.4795001221869534 and
    // math.erfc(2) = 0.004677734981047265.
    expect(chiSquareSurvival(0.5, 1)).toBeCloseTo(0.4795001221869535, 12)
    expect(chiSquareSurvival(8, 1)).toBeCloseTo(0.004677734981047266, 13)
  })
  it('stays accurate deep in the tail for odd degrees of freedom', () => {
    // P(chi2_31 >= 200) = 1.296916789468431e-26, by Simpson integration of the chi-square
    // density over [200, 1200] in 10^6 steps (Python, math.lgamma), independent of the series.
    expect(chiSquareSurvival(200, 31) / 1.296916789468431e-26).toBeCloseTo(1, 8)
  })
  it('agrees with the even closed form for even dof', () => {
    // 4 dof at x = 2: 2 / e = 0.7357589 (hand-computed, as above).
    expect(chiSquareSurvival(2, 4)).toBeCloseTo(0.7357589, 7)
  })
  it('is 1 at zero, 0 at infinity, and throws on a non-integer dof', () => {
    expect(chiSquareSurvival(0, 3)).toBe(1)
    expect(chiSquareSurvival(Infinity, 3)).toBe(0)
    expect(() => chiSquareSurvival(1, 1.5)).toThrow(/positive integer dof/)
  })
})

describe('mulberry32', () => {
  it('is deterministic for a given seed and uniform in [0, 1)', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const draws: number[] = []
    for (let i = 0; i < 100; i++) {
      const v = a()
      expect(b()).toBe(v)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      draws.push(v)
    }
    expect(new Set(draws).size).toBeGreaterThan(90)
  })
})

describe('medianStandardError', () => {
  it('matches the hand-computed asymptotic standard error of the median', () => {
    // Hand-computed for [1, 2, 3, 4, 100]: MAD = 1 (see above), so
    // 1.2533 * 1.4826 * 1 / sqrt(5) = 1.8581422 / 2.2360680 = 0.8309867.
    expect(medianStandardError([1, 2, 3, 4, 100])).toBeCloseTo(0.8309867, 6)
  })
  it('returns 0 for an empty list', () => {
    expect(medianStandardError([])).toBe(0)
  })
})
