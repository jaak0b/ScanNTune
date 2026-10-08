import { expect, it } from 'vitest'
import { NOISE, TWO_TIER, analyzeCase } from './statsSupport'

/**
 * S6, damping-test mixture calibration: with an undamped ring (zeta = 0, 0.01 mm on the top rung,
 * 60 Hz) the boundary likelihood-ratio statistic follows 0.5 chi2_0 + 0.5 chi2_1, which exceeds
 * 2.706 with probability 0.05. Of the 200 fixed seeds' fitted axes the count must lie in [2, 21]
 * (binomial 0.001 tails). A seed whose ring the null noise model absorbs is not fitted and is
 * reported.
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
    console.log(`S6 seeds from ${seedBase}: fitted ${fitted} of 200, above 2.706 ${above}`)
    expect(above).toBeGreaterThanOrEqual(2)
    expect(above).toBeLessThanOrEqual(21)
  })
}
