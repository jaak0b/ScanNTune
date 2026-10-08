import { describe, expect, it } from 'vitest'
import { DETECTION_GRID } from '../../src/engine/is/ringAnalyzer'
import { DETECTION_ALPHA, MAX_CI95_REL } from '../../src/engine/is/types'
import {
  NOISE,
  TWO_TIER,
  analyzeCase,
  chiSquareCritical,
  measuredNoncentralityPerMm2,
  noncentralityForPower,
} from './statsSupport'

describe('S5 speed check', () => {
  it('confirms a real ring at both speeds at the weakest amplitude both tier tests detect', () => {
    // The tier tests run on the local grid around 60 Hz and its artifact images 60 rho^(+/-1)
    // (rho = 150 / 106), every point within 10% of a center, over 5 lines (chi2_10). The
    // amplitude is the one at which the weaker tier's statistic at the true point passes its
    // local Bonferroni critical value with probability 0.95. At least 72 of 80 seeds must confirm.
    const rho = 150 / 106
    const centers = [60, 60 * rho, 60 / rho]
    const local = DETECTION_GRID.filter((p) =>
      centers.some((c) => Math.abs(p.frequencyHz - c) <= MAX_CI95_REL * c),
    ).length
    const perMm2 = Math.min(
      ...[106, 150].map((v) =>
        measuredNoncentralityPerMm2(TWO_TIER, { noise: NOISE.iid }, 0.015, 60, 0.05, 10, 20, 7_000_000 + v, (l) => l.speedMmS === v),
      ),
    )
    const critical = chiSquareCritical(10, DETECTION_ALPHA / local)
    const amp = Math.sqrt(noncentralityForPower(10, critical, 0.95) / perMm2)
    let confirmed = 0
    const states = new Map<string, number>()
    for (let seed = 1; seed <= 80; seed++) {
      const ring = { frequencyHz: 60, dampingRatio: 0.05, ampMm: amp }
      const pool = analyzeCase(TWO_TIER, { noise: NOISE.iid, ring }, 7_001_000 + seed)
      states.set(pool.speedCheck.state, (states.get(pool.speedCheck.state) ?? 0) + 1)
      if (pool.speedCheck.state === 'confirmed') confirmed++
    }
    console.log(`S5 real ring: local grid ${local} points, amplitude ${amp.toFixed(5)} mm, states ${JSON.stringify([...states])}`)
    expect(confirmed).toBeGreaterThanOrEqual(72)
  })
})
