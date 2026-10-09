// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { analyzeTracedLine, poolAxisFits, poolCouponAxes } from '../../../src/engine/is/ringAnalyzer'
import type { LineFit } from '../../../src/engine/is/ringAnalyzer'
import { defaultIsTestRequest, fitSpecToPrinter } from '../../../src/engine/is/types'
import type { IsAxis, IsTestSpec } from '../../../src/engine/is/types'
import { defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'
import { simulateAxis } from '../../helpers/isTraceSim'
import type { SimRing, TraceSimOptions } from '../../helpers/isTraceSim'

// The joint X/Y model of the along-track lag (ringAnalyzer.poolCouponAxes) on simulated coupons
// whose two axes are physically consistent: each group's lines are deposited by a nozzle lagging
// by the other group's ring (tests/helpers/isTraceSim.ts, alongTrack), and every ring is about the
// free response c / w_d of the 100 mm/s top-rung corner. Scan noise is iid, 0.1 px per sample.
//
// Measured once over four seeds: without the lag the analysis reads X (45 Hz) with a standard
// error of 0.0064 to 0.0078 Hz and Y (60 Hz) with 0.0145 to 0.0184 Hz. With the lag but without
// the correction (poolAxisFits) it reads X 0.34 to 0.55 Hz high and Y up to 0.43 Hz high, with
// standard errors of about 0.3 Hz, a spurious second mode near 105 Hz (the sum of the two
// frequencies), and some axes refused by the replicate check. A corrected estimate must lie
// within 3.29 of its standard errors of the truth (two-sided 0.001, the flow's false-alarm
// level), with a standard error under twice the largest no-lag one: 0.0156 Hz on X, 0.0368 Hz on Y.

const profile = defaultPrinterProfile()
/** The default two-axis coupon: tiers 90 and 150 mm/s, six rungs each. */
const twoAxes: IsTestSpec = fitSpecToPrinter(defaultIsTestRequest(profile), profile).spec
/** A one-tier two-axis coupon at 150 mm/s. */
const oneTier: IsTestSpec = fitSpecToPrinter({ ...defaultIsTestRequest(profile), speedsMmS: [150] }, profile).spec
const IID = { model: 'iid' as const, sigmaPx: 0.1 }
/** About the free response of the 100 mm/s corner, c / w_d: 0.354 mm at 45 Hz, 0.266 mm at 60 Hz. */
const X_RING: SimRing = { frequencyHz: 45, dampingRatio: 0.05, ampMm: 0.35, phaseRad: -Math.PI / 2 }
const Y_RING: SimRing = { frequencyHz: 60, dampingRatio: 0.05, ampMm: 0.27, phaseRad: -Math.PI / 2 }

/** One group's line fits, its lines deposited under the lag the other axis's ring causes. */
function groupFits(
  spec: IsTestSpec,
  axis: IsAxis,
  options: Omit<TraceSimOptions, 'spec' | 'seed' | 'axis' | 'noise'>,
  seed: number,
): LineFit[] {
  return simulateAxis({ seed, spec, axis, noise: IID, ...options }).map((l) => analyzeTracedLine(l.trace))
}

/** A coupon whose X group is traced with its lateral coordinate against the run-up. */
function consistentCoupon(spec: IsTestSpec, xRing: SimRing, yRing: SimRing, seed: number): LineFit[][] {
  return [
    groupFits(spec, 'x', { ring: xRing, alongTrack: yRing, lateralTowardRunUp: -1 }, seed),
    groupFits(spec, 'y', { ring: yRing, alongTrack: xRing }, seed + 1),
  ]
}

describe('poolCouponAxes', () => {
  it(
    'corrects both axes for the ring of the other axis along their lines',
    () => {
      const [x, y] = poolCouponAxes(consistentCoupon(twoAxes, X_RING, Y_RING, 4001), twoAxes.speedsMmS)
      expect(x.alongTrackLag).toBe('corrected')
      expect(y.alongTrackLag).toBe('corrected')
      expect(x.accepted).toBe(true)
      expect(y.accepted).toBe(true)
      expect(x.frequencySeHz!).toBeLessThan(0.0156)
      expect(y.frequencySeHz!).toBeLessThan(0.0368)
      expect(Math.abs(x.frequencyHz! - 45)).toBeLessThanOrEqual(3.29 * x.frequencySeHz!)
      expect(Math.abs(y.frequencyHz! - 60)).toBeLessThanOrEqual(3.29 * y.frequencySeHz!)
      // The sideband the uncorrected lag leaves at the sum of the frequencies is gone.
      expect(x.secondMode).toBeNull()
      expect(y.secondMode).toBeNull()
    },
    240_000,
  )

  it(
    'recovers an axis ringing at twice the frequency of the other, whose uncorrected read is the sideband',
    () => {
      // The 70 Hz ring is read with a phase error up to about 1.9 rad on the top rung, so on the
      // commanded time base its own frequency keeps less amplitude than the sideband at 105 Hz:
      // uncorrected, the axis reads about 106 Hz or is refused by the speed check. The 70 Hz
      // ring's standard error measured 0.020 to 0.026 Hz corrected.
      const slow: SimRing = { frequencyHz: 35, dampingRatio: 0.05, ampMm: 0.45, phaseRad: -Math.PI / 2 }
      const fast: SimRing = { frequencyHz: 70, dampingRatio: 0.05, ampMm: 0.23, phaseRad: -Math.PI / 2 }
      const [x, y] = poolCouponAxes(consistentCoupon(twoAxes, slow, fast, 4011), twoAxes.speedsMmS)
      expect(y.alongTrackLag).toBe('corrected')
      expect(y.accepted).toBe(true)
      expect(y.speedCheck.state).toBe('confirmed')
      expect(Math.abs(y.frequencyHz! - 70)).toBeLessThanOrEqual(3.29 * y.frequencySeHz!)
      expect(x.alongTrackLag).toBe('corrected')
      expect(Math.abs(x.frequencyHz! - 35)).toBeLessThanOrEqual(3.29 * x.frequencySeHz!)
    },
    240_000,
  )

  it(
    'corrects a one-tier coupon the same way',
    () => {
      const [x, y] = poolCouponAxes(consistentCoupon(oneTier, X_RING, Y_RING, 4021), oneTier.speedsMmS)
      expect(x.alongTrackLag).toBe('corrected')
      expect(y.alongTrackLag).toBe('corrected')
      expect(x.speedCheck.state).toBe('not-assessed')
      expect(Math.abs(x.frequencyHz! - 45)).toBeLessThanOrEqual(3.29 * x.frequencySeHz!)
      expect(Math.abs(y.frequencyHz! - 60)).toBeLessThanOrEqual(3.29 * y.frequencySeHz!)
    },
    240_000,
  )

  it(
    'keeps the commanded-time-base estimate when the other axis shows no ringing',
    () => {
      // No ring on X, so nothing moves the nozzle along the Y lines and there is nothing to
      // correct with: X is refused before its estimate, Y stands as analyzed alone.
      const xFits = groupFits(twoAxes, 'x', {}, 4031)
      const yFits = groupFits(twoAxes, 'y', { ring: Y_RING }, 4032)
      const [x, y] = poolCouponAxes([xFits, yFits], twoAxes.speedsMmS)
      expect(x.accepted).toBe(false)
      expect(x.alongTrackLag).toBeNull()
      expect(y.alongTrackLag).toBe('other-axis-not-measured')
      expect(y.frequencyHz).toBe(poolAxisFits(yFits, twoAxes.speedsMmS).frequencyHz)
    },
    240_000,
  )

  it(
    'has nothing to correct with on a coupon with one group',
    () => {
      const [y] = poolCouponAxes([groupFits(twoAxes, 'y', { ring: Y_RING }, 4041)], twoAxes.speedsMmS)
      expect(y.accepted).toBe(true)
      expect(y.alongTrackLag).toBe('other-axis-not-measured')
    },
    240_000,
  )

  it(
    'keeps the commanded-time-base estimates when the iteration has no pass left to settle',
    () => {
      const coupon = consistentCoupon(twoAxes, X_RING, Y_RING, 4001)
      const [x] = poolCouponAxes(coupon, twoAxes.speedsMmS, 1)
      expect(x.alongTrackLag).toBe('joint-fit-failed')
      expect(x.frequencyHz).toBe(poolAxisFits(coupon[0], twoAxes.speedsMmS).frequencyHz)
    },
    240_000,
  )
})
