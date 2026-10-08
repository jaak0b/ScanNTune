import { describe, expect, it } from 'vitest'
import { thresholdAmplitudeMm } from './powerSupport'
import { NOISE, SHORT_LINES, analyzeCase } from './statsSupport'

describe('Input proportionality power', () => {
  it('accepts a lightly damped low ring on short lines, the case a damping gate would refuse', () => {
    // 30 Hz at damping 0.02 on 21 mm lines, three times the detection threshold amplitude: the
    // ring grows with the corner speed, so the proportionality gate fails it at most at its
    // 0.001 level (at most 1 of 60 seeds), and at least 57 of 60 seeds are accepted.
    const amp = 3 * thresholdAmplitudeMm(SHORT_LINES, NOISE.iid, 30, 0.02, 9_000_000)
    let accepted = 0
    let gateFailed = 0
    const reasons = new Map<string, number>()
    for (let seed = 1; seed <= 60; seed++) {
      const ring = { frequencyHz: 30, dampingRatio: 0.02, ampMm: amp }
      const pool = analyzeCase(SHORT_LINES, { noise: NOISE.iid, ring }, 9_001_000 + seed)
      if (pool.accepted) accepted++
      else {
        const reason = pool.refusals[0].slice(0, 48)
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
      }
      if (pool.proportionality === 'failed') gateFailed++
    }
    console.log(
      `Proportionality: amplitude ${amp.toFixed(5)} mm, accepted ${accepted} of 60, gate failed ` +
        `${gateFailed}, refusals ${JSON.stringify([...reasons])}`,
    )
    expect(gateFailed).toBeLessThanOrEqual(1)
    expect(accepted).toBeGreaterThanOrEqual(57)
  })
})
