import { expect, it } from 'vitest'
import { TWO_TIER, analyzeCase } from './statsSupport'
import type { CaseOptions } from './statsSupport'

/**
 * S2, false acceptance: an axis whose traces carry no ringing of the machine, only noise and an
 * artifact or mechanism, may be accepted as a measured axis at most once in 60 fixed seeds.
 */
export function falseAcceptanceCase(name: string, options: CaseOptions, seedBase: number): void {
  it(`accepts no axis that carries only ${name}`, () => {
    let accepted = 0
    const reasons = new Map<string, number>()
    for (let seed = 1; seed <= 60; seed++) {
      const pool = analyzeCase(TWO_TIER, options, seedBase + seed)
      if (pool.accepted) accepted++
      else {
        const reason = pool.refusals[0].slice(0, 48)
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
      }
    }
    console.log(`S2 ${name}: accepted ${accepted} of 60; refusals ${JSON.stringify([...reasons])}`)
    expect(accepted).toBeLessThanOrEqual(1)
  })
}
