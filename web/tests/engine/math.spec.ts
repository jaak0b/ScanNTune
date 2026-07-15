import { describe, expect, it } from 'vitest'
import { hampelOutliers, mad, median, medianStandardError, mulberry32 } from '../../src/engine/math'

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
