import { expect, it } from 'vitest'
import type { SimRing } from '../helpers/isTraceSim'
import { NOISE, TWO_AXES, analyzeAxisAlone, analyzeCouponCase } from './statsSupport'

/**
 * S10, the along-track lag: a coupon whose two axes ring with about the free response c / w_d of
 * the 100 mm/s top-rung corner, each group's lines deposited by a nozzle lagging by the other
 * group's ring (the simulator's alongTrack), iid scan noise. The X group is traced with its
 * lateral coordinate against the run-up on every second seed.
 *
 * Without the correction (the first 10 seeds, each axis analyzed alone) a case with a
 * `biasedAxis` must show the bias it exists for: that axis's mean error rejects zero in a
 * two-sided t test at 0.001 (t_0.9995,9 = 4.781). A case without one (rings too faint for the lag
 * to bias them beyond their precision) checks the calibration of the joint path alone.
 *
 * Corrected (40 seeds, poolCouponAxes), per axis:
 * - its interval f +/- 1.96 SE covers the truth at least 33 times of 40 (an exact 95% interval
 *   covers 32 or fewer with probability 0.0007; binomial);
 * - the mean error does not reject zero in a two-sided t test at 0.001 (t_0.9995,39 = 3.558);
 * - the spread of the estimates matches the reported standard error: SD over mean SE within
 *   [0.66, 1.34] (three standard errors of an SD ratio at n = 40).
 * Over both axes, at least 77 of 80 are accepted (five checks at the flow's level 0.001 refuse a
 * real ring with probability up to 0.005 each axis; four or more refusals have probability
 * 0.0007), and at most 2 report a second mode (the search's false-alarm level 0.001; three or more
 * have probability 0.0001). An accepted axis whose partner is refused keeps its uncorrected
 * estimate by design; the corrected count is reported.
 */
export function alongTrackLagCase(name: string, xRing: SimRing, yRing: SimRing, biasedAxis: 'x' | 'y' | null, seedBase: number): void {
  it(`corrects the frequency for the other axis's ring along the lines, ${name}`, () => {
    const truth = { x: xRing.frequencyHz, y: yRing.frequencyHz }
    const options = (seed: number) => ({
      x: { noise: NOISE.iid, ring: xRing, alongTrack: yRing, lateralTowardRunUp: seed % 2 === 0 ? (-1 as const) : (1 as const) },
      y: { noise: NOISE.iid, ring: yRing, alongTrack: xRing },
    })

    const uncorrected: number[] = []
    for (let seed = 1; biasedAxis !== null && seed <= 10; seed++) {
      const o = options(seed)
      const pool = analyzeAxisAlone(TWO_AXES, biasedAxis, o[biasedAxis], seedBase + seed)
      if (pool.frequencyHz !== null) uncorrected.push(pool.frequencyHz - truth[biasedAxis])
    }

    const errors = { x: [] as number[], y: [] as number[] }
    const ses = { x: [] as number[], y: [] as number[] }
    const cover = { x: 0, y: 0 }
    let accepted = 0
    let corrected = 0
    let secondModes = 0
    for (let seed = 1; seed <= 40; seed++) {
      const o = options(seed)
      const [x, y] = analyzeCouponCase(TWO_AXES, o.x, o.y, seedBase + seed)
      for (const [axis, pool] of [['x', x], ['y', y]] as const) {
        if (pool.accepted) accepted++
        if (pool.accepted && pool.alongTrackLag === 'corrected') corrected++
        if (pool.secondMode !== null) secondModes++
        if (pool.frequencyHz === null || pool.frequencySeHz === null) continue
        const error = pool.frequencyHz - truth[axis]
        errors[axis].push(error)
        ses[axis].push(pool.frequencySeHz)
        if (Math.abs(error) <= 1.959964 * pool.frequencySeHz) cover[axis]++
      }
    }

    const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length
    const sd = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + (x - mean(v)) ** 2, 0) / (v.length - 1))
    const t = (v: number[]) => mean(v) / (sd(v) / Math.sqrt(v.length))
    const summary = (axis: 'x' | 'y') =>
      `${axis}: covered ${cover[axis]} of 40, fitted ${errors[axis].length}, mean error ` +
      `${mean(errors[axis]).toFixed(4)} Hz (t ${t(errors[axis]).toFixed(2)}), SD ${sd(errors[axis]).toFixed(4)} Hz, ` +
      `mean SE ${mean(ses[axis]).toFixed(4)} Hz, ratio ${(sd(errors[axis]) / mean(ses[axis])).toFixed(3)}`
    const biasText =
      biasedAxis === null
        ? 'no uncorrected run'
        : `uncorrected ${biasedAxis} mean error ${mean(uncorrected).toFixed(4)} Hz (t ${t(uncorrected).toFixed(2)}, ` +
          `${uncorrected.length} fitted of 10)`
    console.log(
      `S10 ${name}: ${biasText}; accepted ${accepted} of 80, corrected ${corrected}, second modes ` +
        `${secondModes}; ${summary('x')}; ${summary('y')}`,
    )
    if (biasedAxis !== null) expect(Math.abs(t(uncorrected))).toBeGreaterThan(4.781)
    expect(accepted).toBeGreaterThanOrEqual(77)
    expect(secondModes).toBeLessThanOrEqual(2)
    for (const axis of ['x', 'y'] as const) {
      expect(cover[axis]).toBeGreaterThanOrEqual(33)
      expect(Math.abs(t(errors[axis]))).toBeLessThanOrEqual(3.558)
      expect(sd(errors[axis]) / mean(ses[axis])).toBeGreaterThanOrEqual(0.66)
      expect(sd(errors[axis]) / mean(ses[axis])).toBeLessThanOrEqual(1.34)
    }
  })
}
