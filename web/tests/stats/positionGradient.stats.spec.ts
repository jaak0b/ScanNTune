import { describe, expect, it } from 'vitest'
import { NOISE, TWO_TIER, analyzeCase } from './statsSupport'

describe('Balanced tiers', () => {
  it('keeps the speed check confirmed when the frequency drifts along the axis', () => {
    // The ring frequency changes by 0.02 Hz per mm of field position (belt stiffness changing
    // toward a travel end). Blocked tiers 12.5 mm apart would read 0.25 Hz apart, about ten of
    // the speed check's standard errors at 0.03 mm; the interleaved tiers share their mean
    // position to half a millimetre. At least 54 of 60 seeds must confirm (binomial 0.03 tail at
    // power 0.95).
    let confirmed = 0
    const states = new Map<string, number>()
    for (let seed = 1; seed <= 60; seed++) {
      const ring = { frequencyHz: 60, dampingRatio: 0.05, ampMm: 0.03, frequencyGradientHzPerMm: 0.02 }
      const pool = analyzeCase(TWO_TIER, { noise: NOISE.iid, ring }, 9_100_000 + seed)
      states.set(pool.speedCheck.state, (states.get(pool.speedCheck.state) ?? 0) + 1)
      if (pool.speedCheck.state === 'confirmed') confirmed++
    }
    console.log(`Position gradient: speed check states ${JSON.stringify([...states])}`)
    expect(confirmed).toBeGreaterThanOrEqual(54)
  })
})
