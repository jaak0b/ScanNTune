import { describe, expect, it } from 'vitest'
import { mad, median, medianStandardError } from '../../src/engine/math'

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
