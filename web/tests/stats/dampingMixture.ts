import { expect, it } from 'vitest'
import { NOISE, TWO_TIER, analyzeCase, binomialBounds } from './statsSupport'

/**
 * S6, damping-test mixture calibration: with an undamped ring (zeta = 0, 0.01 mm on the top rung,
 * 60 Hz) the boundary likelihood-ratio statistic follows 0.5 chi2_0 + 0.5 chi2_1, which exceeds
 * 2.706 with probability 0.05. Of the 200 fixed seeds' fitted axes the count must lie within the
 * binomial 0.001 tails of the number fitted ([2, 21] when all 200 are). A seed whose ring the null
 * noise model absorbs is not fitted, is reported, and does not count.
 */
export function dampingMixtureCase(seedBase: number): void {
  it('calibrates the zeta = 0 boundary test to its chi-square mixture', () => {
    let above = 0
    let fitted = 0
    for (let seed = 1; seed <= 200; seed++) {
      const ring = { frequencyHz: 60, dampingRatio: 0, ampMm: 0.01 }
      const pool = analyzeCase(TWO_TIER, { noise: NOISE.iid, ring }, seedBase + seed)
      if (pool.decayStatistic === null) continue
      fitted++
      if (pool.decayStatistic > 2.706) above++
    }
    const { lower, upper } = binomialBounds(fitted, 0.05, 0.001)
    console.log(`S6 seeds from ${seedBase}: fitted ${fitted} of 200, above 2.706 ${above}, allowed [${lower}, ${upper}]`)
    expect(above).toBeGreaterThanOrEqual(lower)
    expect(above).toBeLessThanOrEqual(upper)
  })
}
