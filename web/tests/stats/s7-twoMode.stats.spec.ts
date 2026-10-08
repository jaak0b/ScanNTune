import { describe, expect, it } from 'vitest'
import { NOISE, TWO_TIER, analyzeCase } from './statsSupport'

describe('S7 two modes', () => {
  it('recovers and covers both modes of a two-mode axis', () => {
    // Modes at 45 Hz (0.03 mm on the top rung) and 62 Hz (0.02 mm), damping 0.05 each, iid scan
    // noise. Of 60 fixed seeds at least 57 must report a second mode, and each mode's interval
    // f +/- 1.96 SE must cover its truth at least 51 times (an exact 95% interval covers 50 or
    // fewer with probability 0.0007; binomial).
    let found = 0
    let cover45 = 0
    let cover62 = 0
    for (let seed = 1; seed <= 60; seed++) {
      const pool = analyzeCase(
        TWO_TIER,
        {
          noise: NOISE.iid,
          ring: { frequencyHz: 45, dampingRatio: 0.05, ampMm: 0.03 },
          extraModes: [{ frequencyHz: 62, dampingRatio: 0.05, ampMm: 0.02 }],
        },
        9_200_000 + seed,
      )
      const second = pool.secondMode
      if (!pool.accepted || second === null) continue
      found++
      const modes = [
        { f: pool.frequencyHz!, se: pool.frequencySeHz },
        { f: second.frequencyHz, se: second.frequencySeHz },
      ].sort((a, b) => a.f - b.f)
      if (modes[0].se !== null && Math.abs(modes[0].f - 45) <= 1.959964 * modes[0].se) cover45++
      if (modes[1].se !== null && Math.abs(modes[1].f - 62) <= 1.959964 * modes[1].se) cover62++
    }
    console.log(`S7 two modes: second mode found ${found} of 60, 45 Hz covered ${cover45}, 62 Hz covered ${cover62}`)
    expect(found).toBeGreaterThanOrEqual(57)
    expect(cover45).toBeGreaterThanOrEqual(51)
    expect(cover62).toBeGreaterThanOrEqual(51)
  })
})
