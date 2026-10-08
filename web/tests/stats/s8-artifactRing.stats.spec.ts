import { describe, expect, it } from 'vitest'
import { NOISE, TWO_TIER, analyzeCase } from './statsSupport'

describe('S8 artifact and ring', () => {
  it('measures the ring and identifies the arc-length artifact beside it', () => {
    // A 60 Hz ring (damping 0.05, 0.03 mm) and a 1.7 mm arc-length pattern (0.002 mm) on every
    // line. Of 60 fixed seeds at least 57 must be accepted with exactly one artifact within one
    // grid step (0.019 mm) of 1.7 mm, and the ring's interval f +/- 1.96 SE must cover 60 Hz at
    // least 51 times (an exact 95% interval covers 50 or fewer with probability 0.0007; binomial).
    let accepted = 0
    let identified = 0
    let covered = 0
    for (let seed = 1; seed <= 60; seed++) {
      const pool = analyzeCase(
        TWO_TIER,
        {
          noise: NOISE.iid,
          ring: { frequencyHz: 60, dampingRatio: 0.05, ampMm: 0.03 },
          artifacts: { beltTooth: { periodMm: 1.7, ampMm: 0.002 } },
        },
        9_400_000 + seed,
      )
      if (!pool.accepted) continue
      accepted++
      if (pool.artifacts.length === 1 && Math.abs(pool.artifacts[0].periodMm! - 1.7) <= 0.019) identified++
      if (pool.frequencySeHz !== null && Math.abs(pool.frequencyHz! - 60) <= 1.959964 * pool.frequencySeHz) covered++
    }
    console.log(`S8 artifact and ring: accepted ${accepted} of 60, artifact identified ${identified}, ring covered ${covered}`)
    expect(accepted).toBeGreaterThanOrEqual(57)
    expect(identified).toBeGreaterThanOrEqual(57)
    expect(covered).toBeGreaterThanOrEqual(51)
  })
})
