import { describe, expect, it } from 'vitest'
import { NOISE, TWO_TIER, analyzeCase } from './statsSupport'

describe('S5 speed check', () => {
  it('refuses an arc-length artifact present at both tiers in every seed', () => {
    // A 2 mm belt-tooth pattern, 0.002 mm on every line: 80 of 80 fixed seeds refused.
    let accepted = 0
    const states = new Map<string, number>()
    for (let seed = 1; seed <= 80; seed++) {
      const artifacts = { beltTooth: { periodMm: 2, ampMm: 0.002 } }
      const pool = analyzeCase(TWO_TIER, { noise: NOISE.iid, artifacts }, 7_100_000 + seed)
      states.set(pool.speedCheck.state, (states.get(pool.speedCheck.state) ?? 0) + 1)
      if (pool.accepted) accepted++
    }
    console.log(`S5 artifact: accepted ${accepted} of 80, speed check states ${JSON.stringify([...states])}`)
    expect(accepted).toBe(0)
  })
})
