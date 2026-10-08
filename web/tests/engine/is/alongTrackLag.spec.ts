import { describe, expect, it } from 'vitest'
import { depositTimesUnder, responseAt, unitResponseMode } from '../../../src/engine/is/alongTrackLag'
import { isCouponGeometry } from '../../../src/engine/is/couponGeometry'
import type { IsSegment } from '../../../src/engine/is/couponGeometry'
import { defaultIsTestRequest, fitSpecToPrinter } from '../../../src/engine/is/types'
import { defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'

// The expected values were computed once outside the tests by an independent script: the
// trapezoid arc length c t + a t^2 / 2 (then cruise), the damped response, and a 200-step
// bisection of s_cmd(t) - lag(t) = s.

const MOTION = { cornerSpeedMmS: 100, speedMmS: 150, accelMmS2: 3000 }

describe('unitResponseMode', () => {
  it('turns each line toward its run-up before regressing on the corner speed', () => {
    // Three lines of one response, 0.0001 and 0.0005 mm per mm/s toward the run-up; the middle
    // line is traced with its lateral coordinate against the run-up, so its coefficients are
    // negated. Ignoring the sign would shrink the response.
    const mode = unitResponseMode(
      [
        { cornerSpeedMmS: 20, lateralTowardRunUp: 1, a: 0.002, b: 0.01 },
        { cornerSpeedMmS: 50, lateralTowardRunUp: -1, a: -0.005, b: -0.025 },
        { cornerSpeedMmS: 100, lateralTowardRunUp: 1, a: 0.01, b: 0.05 },
      ],
      45,
      0.05,
    )
    expect(mode).not.toBeNull()
    expect(mode!.frequencyHz).toBe(45)
    expect(mode!.dampingRatio).toBe(0.05)
    expect(mode!.cosCoefficient).toBeCloseTo(0.0001, 12)
    expect(mode!.sinCoefficient).toBeCloseTo(0.0005, 12)
  })

  it('weights each line by its corner speed, the least squares line through the origin', () => {
    // (20 * 0.003 + 100 * 0.01) / (20^2 + 100^2) = 1.06 / 10400.
    const mode = unitResponseMode(
      [
        { cornerSpeedMmS: 20, lateralTowardRunUp: 1, a: 0.003, b: 0 },
        { cornerSpeedMmS: 100, lateralTowardRunUp: 1, a: 0.01, b: 0 },
      ],
      45,
      0.05,
    )
    expect(mode!.cosCoefficient).toBeCloseTo(0.000101923077, 12)
  })

  it('has no response without a line', () => {
    expect(unitResponseMode([], 45, 0.05)).toBeNull()
  })
})

describe('responseAt', () => {
  it('scales the unit response by the corner speed', () => {
    const undamped = { modes: [{ frequencyHz: 50, dampingRatio: 0, cosCoefficient: 0, sinCoefficient: 0.001 }] }
    expect(responseAt(undamped, 100, 0.005)).toBeCloseTo(0.1, 12)
    expect(responseAt(undamped, 100, 0.0025)).toBeCloseTo(0.0707106781, 9)
  })

  it('decays the response and mixes its cosine and sine terms', () => {
    const damped = { modes: [{ frequencyHz: 40, dampingRatio: 0.1, cosCoefficient: 0.002, sinCoefficient: -0.001 }] }
    expect(responseAt(damped, 50, 0.01)).toBeCloseTo(-0.0855943638, 9)
  })
})

describe('depositTimesUnder', () => {
  const lag = { modes: [{ frequencyHz: 45, dampingRatio: 0.05, cosCoefficient: 0, sinCoefficient: 0.0035 }] }

  it('finds when the lagging nozzle reaches each commanded position', () => {
    // At these times the response is negative, the nozzle runs ahead, so it reaches every
    // position before its commanded time; the middle sample lies past the end of the ramp.
    const times = depositTimesUnder({ ...MOTION, tS: Float64Array.from([0.012, 0.02, 0.035]) }, lag)
    expect(times[0]).toBeCloseTo(0.011666434026, 11)
    expect(times[1]).toBeCloseTo(0.018409953079, 11)
    expect(times[2]).toBeCloseTo(0.034538118188, 11)
  })

  it('returns the commanded times when the other axis does not move', () => {
    const still = { modes: [{ frequencyHz: 45, dampingRatio: 0.05, cosCoefficient: 0, sinCoefficient: 0 }] }
    const times = depositTimesUnder({ ...MOTION, tS: Float64Array.from([0.012, 0.02]) }, still)
    expect(times[0]).toBeCloseTo(0.012, 12)
    expect(times[1]).toBeCloseTo(0.02, 12)
  })

  it('keeps the corner time for a position the nozzle had already passed at the corner', () => {
    // A response of -0.5 mm at the corner puts the nozzle 0.5 mm ahead; the sample at 0.1015 mm
    // was behind it from the start.
    const ahead = { modes: [{ frequencyHz: 45, dampingRatio: 0.05, cosCoefficient: -0.005, sinCoefficient: 0 }] }
    const times = depositTimesUnder({ ...MOTION, tS: Float64Array.from([0.001]) }, ahead)
    expect(times[0]).toBe(0)
  })
})

describe('the coupon layout the lag rests on', () => {
  const direction = (seg: IsSegment) => ({ dx: Math.sign(seg.x1 - seg.x0), dy: Math.sign(seg.y1 - seg.y0) })

  it('runs each group against the run-up of the other group, so both corners step the shared axis alike', () => {
    // The X axis is stopped from a -X run-up at the X group's corners and started along +X at the
    // Y group's corners: the same velocity change, so the same response in both groups.
    const profile = defaultPrinterProfile()
    const g = isCouponGeometry(fitSpecToPrinter(defaultIsTestRequest(profile), profile).spec)
    const x = g.groups.find((group) => group.axis === 'x')!
    const y = g.groups.find((group) => group.axis === 'y')!
    for (const line of y.lines) {
      expect(direction(line.runUp)).toEqual({ dx: 0, dy: 1 })
      expect(direction(line.measured)).toEqual({ dx: 1, dy: 0 })
    }
    for (const line of x.lines) {
      expect(direction(line.runUp)).toEqual({ dx: -1, dy: 0 })
      expect(direction(line.measured)).toEqual({ dx: 0, dy: -1 })
    }
  })
})
