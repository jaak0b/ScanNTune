import { describe, expect, it } from 'vitest'
import { NOISE, TWO_TIER, analyzeCase } from './statsSupport'

describe('S7 two modes', () => {
  it('reports a spurious second mode on single-mode axes at most at the false-alarm rate', () => {
    // One 60 Hz mode, damping 0.05, 0.03 mm, iid scan noise: the second-mode search runs at the
    // flow's level 0.001, so of 200 fixed seeds at most 2 may report a second mode (a test of
    // exact size exceeds that with probability 0.0011; binomial).
    let spurious = 0
    let accepted = 0
    for (let seed = 1; seed <= 200; seed++) {
      const pool = analyzeCase(TWO_TIER, { noise: NOISE.iid, ring: { frequencyHz: 60, dampingRatio: 0.05, ampMm: 0.03 } }, 9_300_000 + seed)
      if (pool.accepted) accepted++
      if (pool.secondMode !== null) spurious++
    }
    console.log(`S7 single mode: accepted ${accepted} of 200, spurious second mode ${spurious}`)
    expect(spurious).toBeLessThanOrEqual(2)
  })
})
