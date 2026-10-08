import { describe, expect, it } from 'vitest'
import { thresholdAmplitudeMm } from './powerSupport'
import { NOISE, TWO_TIER, analyzeCase } from './statsSupport'

describe('S4 power', () => {
  it('detects a ring at the detection threshold amplitude with power 0.95', () => {
    // At the threshold amplitude the statistic at the true point alone detects with probability
    // 0.95. Of 70 fixed seeds at least 60 must be detected: a correct implementation detects
    // fewer with probability 0.0007 (binomial, widened from 64 so that it fails at most 0.1%).
    const amp = thresholdAmplitudeMm(TWO_TIER, NOISE.iid, 60, 0.05, 6_000_000)
    let detected = 0
    for (let seed = 1; seed <= 70; seed++) {
      const ring = { frequencyHz: 60, dampingRatio: 0.05, ampMm: amp }
      const pool = analyzeCase(TWO_TIER, { noise: NOISE.iid, ring }, 6_001_000 + seed)
      if (pool.detectionPBound! <= 0.001) detected++
    }
    console.log(`S4: threshold amplitude ${amp.toFixed(5)} mm, detected ${detected} of 70`)
    expect(detected).toBeGreaterThanOrEqual(60)
  })
})
