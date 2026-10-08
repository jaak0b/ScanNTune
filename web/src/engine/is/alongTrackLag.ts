import { timeAtDistance } from './couponGeometry'
import type { SampleTimes } from './ringRegressors'

// The along-track time warp of the input shaper coupon and its correction.
//
// At a line's corner the axis along the measured line takes a velocity step too: it starts from
// rest and is commanded to the corner speed c. That axis rings like the measured one, so the
// nozzle runs behind and ahead of its commanded position by the axis's own response to the step,
// lag(t). The bead at commanded arc position s is therefore deposited at the time t that solves
// s_cmd(t) - lag(t) = s, not at the commanded time T(s) the tracer assigns to it. Read on the
// commanded time base, the lateral ring is phase modulated (an index up to about c / v, near 1 rad
// on the top rung) and its fitted frequency is biased by up to about 1%, by the same fraction on
// both speed tiers, so the speed check cannot see it.
//
// The axis along one group's lines is the measured axis of the other group, and the coupon gives
// it the same input there: the Y group's lines run along +X out of a +Y run-up, the X group's
// along -Y out of a -X run-up, so each group's direction of travel is opposite to the other
// group's run-up and both groups change that axis's velocity by +c along the same direction. For
// a linear time-invariant axis, the model the ring fit itself rests on (the free response to the
// velocity step, input proportional), the response to the same step is the same function of time
// in both groups. Hence the lag of one group's nozzle behind its commanded position equals the
// other group's fitted ring at the same corner speed, as a displacement along that group's
// run-up: the axis keeps moving the way it moved before its corner. The response per unit corner
// speed is estimated from all of the other group's lines by least squares through the origin
// (the output-error model of input proportionality, L. Ljung, "System Identification: Theory for
// the User", 2nd ed., Prentice Hall 1999, s4.2), so a missing or damaged line at one rung does not
// leave that rung uncorrected.

/** One mode of an axis's response to a unit corner speed step: the displacement along the
 *  direction the axis moved before its corner, per mm/s of corner speed (see responseAt). */
export interface ResponseMode {
  frequencyHz: number
  dampingRatio: number
  /** Coefficients of e^(-zeta w t) cos(w_d t) and e^(-zeta w t) sin(w_d t), mm per mm/s. */
  cosCoefficient: number
  sinCoefficient: number
}

/** An axis's fitted response to a unit corner speed step: the sum of its modes. */
export interface CornerResponse {
  modes: ResponseMode[]
}

/** One line's fitted ring, as the estimation of an axis produced it. */
export interface FittedLineRing {
  cornerSpeedMmS: number
  /** The trace's lateral sign relative to the run-up (lineTracer.TracedLine). */
  lateralTowardRunUp: 1 | -1
  /** Coefficients of the raw ring columns e^(-zeta w t) cos(w_d t) and sin(w_d t), mm. */
  a: number
  b: number
}

/**
 * The response mode per unit corner speed at (f, zeta) from the lines' fitted ring coefficients:
 * each line's coefficients turned toward its run-up, regressed on its corner speed through the
 * origin, sum_l c_l x_l / sum_l c_l^2. Null without a line with a positive corner speed.
 */
export function unitResponseMode(lines: FittedLineRing[], frequencyHz: number, dampingRatio: number): ResponseMode | null {
  let cc = 0
  let ca = 0
  let cb = 0
  for (const line of lines) {
    const c = line.cornerSpeedMmS
    cc += c * c
    ca += c * line.lateralTowardRunUp * line.a
    cb += c * line.lateralTowardRunUp * line.b
  }
  if (!(cc > 0)) return null
  return { frequencyHz, dampingRatio, cosCoefficient: ca / cc, sinCoefficient: cb / cc }
}

/** The displacement of the response to a corner speed step c at time t after the corner, mm. */
export function responseAt(response: CornerResponse, cornerSpeedMmS: number, tS: number): number {
  let sum = 0
  for (const mode of response.modes) {
    const omega = 2 * Math.PI * mode.frequencyHz
    const damped = omega * Math.sqrt(Math.max(0, 1 - mode.dampingRatio * mode.dampingRatio))
    const envelope = Math.exp(-mode.dampingRatio * omega * tS)
    sum += envelope * (mode.cosCoefficient * Math.cos(damped * tS) + mode.sinCoefficient * Math.sin(damped * tS))
  }
  return cornerSpeedMmS * sum
}

/** A bound of |responseAt| over t >= 0 for corner speed c: every mode's envelope is at most 1. */
function responseBound(response: CornerResponse, cornerSpeedMmS: number): number {
  return cornerSpeedMmS * response.modes.reduce((s, m) => s + Math.hypot(m.cosCoefficient, m.sinCoefficient), 0)
}

/** Commanded arc length from the corner at time t on the trapezoid (the inverse of
 *  couponGeometry.timeAtDistance). */
function commandedArcLengthMm(t: number, rec: SampleTimes): number {
  const c = rec.cornerSpeedMmS
  const v = rec.speedMmS
  const a = rec.accelMmS2
  const tRamp = Math.max(0, (v - c) / a)
  if (t <= tRamp) return c * t + 0.5 * a * t * t
  return c * tRamp + 0.5 * a * tRamp * tRamp + v * (t - tRamp)
}

/** Bisection steps of the deposit time: the bracket is at most a few milliseconds wide, so 60
 *  halvings reach the floating-point resolution of the time. */
const BISECTION_STEPS = 60

/**
 * The deposit time of every sample of a record whose nozzle lags its commanded position by the
 * along axis's response `lag` at the record's corner speed: per sample, the root of
 * s_cmd(t) - lag(t) = s at the sample's commanded arc length s, by bisection on t >= 0. With the
 * lag bounded by L, the root lies between the commanded times of s - L and s + L; the nozzle's
 * position s_cmd - lag rises monotonically while the lag changes more slowly than the commanded
 * speed, which a response no larger than the free response of the step guarantees. A sample the
 * nozzle had already passed at the corner keeps the corner time.
 */
export function depositTimesUnder(rec: SampleTimes, lag: CornerResponse): Float64Array {
  const c = rec.cornerSpeedMmS
  const bound = responseBound(lag, c)
  const out = new Float64Array(rec.tS.length)
  for (let i = 0; i < rec.tS.length; i++) {
    const s = commandedArcLengthMm(rec.tS[i], rec)
    const excess = (t: number) => commandedArcLengthMm(t, rec) - responseAt(lag, c, t) - s
    let lo = timeAtDistance(Math.max(0, s - bound), c, rec.speedMmS, rec.accelMmS2)
    let hi = timeAtDistance(s + bound, c, rec.speedMmS, rec.accelMmS2)
    if (excess(lo) >= 0) {
      out[i] = lo
      continue
    }
    for (let k = 0; k < BISECTION_STEPS; k++) {
      const mid = 0.5 * (lo + hi)
      if (excess(mid) < 0) lo = mid
      else hi = mid
    }
    out[i] = 0.5 * (lo + hi)
  }
  return out
}
