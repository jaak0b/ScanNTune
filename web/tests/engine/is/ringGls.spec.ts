// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { pooledVarianceSlope } from '../../../src/engine/is/ringGls'

describe('pooledVarianceSlope', () => {
  it('recovers the variance ratio of two groups of innovations as e^b', () => {
    // Four innovations of square 1 at g = 0 and four of square 4 at g = 1: the likelihood is
    // maximized where the variance ratio e^b equals the ratio of mean squares, 4, so b = ln 4 =
    // 1.386294; the likelihood ratio of b = 0 is 8 ln(20 / 8) - 4 ln 4 = 1.785148 (hand-computed).
    const result = pooledVarianceSlope([[1, -1, 1, -1, 2, -2, 2, -2]], [[0, 0, 0, 0, 1, 1, 1, 1]])
    expect(result.slope).toBeCloseTo(1.386294, 5)
    expect(result.statistic).toBeCloseTo(1.785148, 5)
  })

  it('pools the lines, each with its own level', () => {
    // The same pattern on two lines whose levels differ by a factor 100 in variance: the shared
    // slope is still ln 4 and the statistic doubles.
    const result = pooledVarianceSlope(
      [[1, -1, 1, -1, 2, -2, 2, -2], [10, -10, 10, -10, 20, -20, 20, -20]],
      [[0, 0, 0, 0, 1, 1, 1, 1], [0, 0, 0, 0, 1, 1, 1, 1]],
    )
    expect(result.slope).toBeCloseTo(1.386294, 5)
    expect(result.statistic).toBeCloseTo(3.570297, 5)
  })

  it('reports no slope and no evidence when the deficit vanishes', () => {
    expect(pooledVarianceSlope([[1, -2, 3]], [[0, 0, 0]])).toEqual({ slope: 0, statistic: 0 })
  })
})
