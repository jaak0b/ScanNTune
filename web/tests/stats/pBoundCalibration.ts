import { expect, it } from 'vitest'
import type { SimNoise } from '../helpers/isTraceSim'
import { TWO_TIER, analyzeCase } from './statsSupport'

/**
 * pBound calibration (I11 c) and S2 false acceptance under scan noise alone. The axis detection
 * bound is a Bonferroni bound, so it must reject at most at its nominal level: of 400 fixed-seed
 * nulls, at most 35 may reach pBound <= 0.05 and at most 11 pBound <= 0.01 (the counts a test of
 * exact size exceeds with probability 0.001; the 5 noise models together make the 2,000 nulls).
 * S2: of the first 60 nulls at most 1 may be accepted as a measured axis.
 */
export function pBoundCalibrationCase(name: string, noise: SimNoise, seedBase: number): void {
  it(`keeps the detection bound at its level and accepts no axis under ${name}`, () => {
    let at05 = 0
    let at01 = 0
    let acceptedFirst60 = 0
    for (let seed = 1; seed <= 400; seed++) {
      const pool = analyzeCase(TWO_TIER, { noise }, seedBase + seed)
      if (pool.detectionPBound! <= 0.05) at05++
      if (pool.detectionPBound! <= 0.01) at01++
      if (seed <= 60 && pool.accepted) acceptedFirst60++
    }
    console.log(`pBound ${name}: <= 0.05 ${at05} of 400, <= 0.01 ${at01}; S2 accepted ${acceptedFirst60} of 60`)
    expect(at05).toBeLessThanOrEqual(35)
    expect(at01).toBeLessThanOrEqual(11)
    expect(acceptedFirst60).toBeLessThanOrEqual(1)
  })
}
