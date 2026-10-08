import { expect, it } from 'vitest'
import type { IsTestSpec } from '../../src/engine/is/types'
import type { SimNoise } from '../helpers/isTraceSim'
import { statisticCase } from './statsSupport'

/**
 * S1, per-point chi-square calibration: under H0 (scan noise only) the production statistic
 * Q = sum_l D_l at the fixed point 60 Hz, zeta 0.05 over the 10 lines is chi2_20 whatever the
 * noise model, because every column is whitened by the line's exact noise model. Of 2,000 fixed
 * seeds, the count above the chi2_20 95% point 31.410 must lie in [68, 132] and the count above
 * the 99% point 37.566 at most 35 (each a binomial 0.001 tail for a correct implementation).
 */
export function chiSquareCalibrationCase(name: string, spec: IsTestSpec, noise: SimNoise, seedBase: number): void {
  it(`keeps the statistic at a fixed point chi2_20 under ${name}`, () => {
    let above95 = 0
    let above99 = 0
    for (let seed = 1; seed <= 2000; seed++) {
      const q = statisticCase(spec, { noise }, seedBase + seed, 60, 0.05)
      if (q > 31.41) above95++
      if (q > 37.566) above99++
    }
    console.log(`S1 ${name}: above chi2_20(0.95) ${above95} of 2000, above chi2_20(0.99) ${above99}`)
    expect(above95).toBeGreaterThanOrEqual(68)
    expect(above95).toBeLessThanOrEqual(132)
    expect(above99).toBeLessThanOrEqual(35)
  })
}
