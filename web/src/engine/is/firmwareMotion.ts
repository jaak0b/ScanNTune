import type { PrinterProfile } from '../gcode/profileTypes'

export function disableShapingCommands(profile: PrinterProfile): string[] {
  if (profile.firmware === 'Marlin') {
    return ['M593 F0', 'M900 K0']
  }
  if (profile.firmware === 'RepRapFirmware') {
    return ['M593 P"none"', 'M572 D0 S0']
  }
  return ['SET_INPUT_SHAPER SHAPER_FREQ_X=0 SHAPER_FREQ_Y=0', 'SET_PRESSURE_ADVANCE ADVANCE=0']
}

/**
 * Marlin's planner junction deviation formula (planner.cpp): the fastest speed a junction is
 * taken at satisfies vmax_junction^2 = a * J * sin_theta_d2 / (1 - sin_theta_d2), with
 * sin_theta_d2 = sqrt(0.5 * (1 - cos_theta)) and cos_theta the cosine between the reversed
 * previous move direction and the current one. The test's corner is 90 degrees, so
 * cos_theta = 0, sin_theta_d2 = 1 / sqrt(2), and the factor below is sqrt(2) + 1:
 * v^2 = a * J * (sqrt(2) + 1). The junction acceleration a is the test acceleration, which
 * the emitted M204 and per-axis M201 limits both set.
 */
const RIGHT_ANGLE_SIN_THETA_D2 = Math.sqrt(0.5 * (1 - 0))
const MARLIN_RIGHT_ANGLE_JUNCTION_FACTOR =
  RIGHT_ANGLE_SIN_THETA_D2 / (1 - RIGHT_ANGLE_SIN_THETA_D2)
/** Marlin's M205 J accepts only this range (mm) and answers "?J out of range" otherwise. */
const MARLIN_JD_MIN_MM = 0.01
const MARLIN_JD_MAX_MM = 0.3

/**
 * The junction deviation Marlin needs to take a 90 degree corner at `cornerSpeedMmS` without
 * braking: the planner's junction formula solved for J, J = v^2 / (a * (sqrt(2) + 1)), held
 * inside the range M205 J accepts. The upper end is never reached by a fitted spec (see
 * maxCornerSpeedMmS); raising a value below the lower end only loosens an upper bound, so the
 * corner still passes unbraked.
 */
export function marlinJunctionDeviationMm(cornerSpeedMmS: number, accelMmS2: number): number {
  const jd =
    (cornerSpeedMmS * cornerSpeedMmS) / (accelMmS2 * MARLIN_RIGHT_ANGLE_JUNCTION_FACTOR)
  return Math.min(MARLIN_JD_MAX_MM, Math.max(MARLIN_JD_MIN_MM, jd))
}

/**
 * The fastest corner speed the firmware's corner limit can express at `accelMmS2`, or null
 * when it sets no bound. Klipper's square corner velocity and RepRapFirmware's M566 jerk take
 * any value. Marlin's junction deviation tops out at 0.3 mm, which by the planner's junction
 * formula caps a 90 degree corner at sqrt(0.3 * accel * (sqrt(2) + 1)); the cap is rounded
 * down to 0.1 mm/s so the emitted J stays inside the accepted range after rounding.
 * Classic-jerk Marlin builds get the same corner speed, so the printed corner never depends
 * on the build.
 */
export function maxCornerSpeedMmS(profile: PrinterProfile, accelMmS2: number): number | null {
  if (profile.firmware !== 'Marlin') return null
  const exact = Math.sqrt(MARLIN_JD_MAX_MM * accelMmS2 * MARLIN_RIGHT_ANGLE_JUNCTION_FACTOR)
  return Math.floor(exact * 10) / 10
}

/**
 * The lowest acceleration at which the firmware's corner limit can express `cornerSpeedMmS`,
 * rounded up to a whole mm/s^2, or null when the firmware sets no bound: the inverse of
 * maxCornerSpeedMmS.
 */
export function minAccelForCornerSpeedMmS2(
  profile: PrinterProfile,
  cornerSpeedMmS: number,
): number | null {
  if (profile.firmware !== 'Marlin') return null
  return Math.ceil(
    (cornerSpeedMmS * cornerSpeedMmS) / (MARLIN_JD_MAX_MM * MARLIN_RIGHT_ANGLE_JUNCTION_FACTOR),
  )
}

/**
 * Motion limits for the test, per firmware, derived from the spec's corner speed (the TOP
 * rung of the corner-speed excitation ladder) so every run-up cruise passes its corner
 * without deceleration; the limit is an upper bound, so the ladder's slower rungs pass
 * unbraked under the same single override on all three firmwares:
 * - Klipper: SQUARE_CORNER_VELOCITY is the native semantics; any junction entered at or
 *   below it passes unbraked, so it is set to the corner speed.
 * - Marlin classic jerk: M205 X/Y is the allowed instantaneous per-axis velocity change
 *   in mm/s. For an exact 90 degree corner the per-axis delta-v equals the corner speed,
 *   so X/Y jerk set to the corner speed coincides with it. Junction-deviation
 *   builds ignore X/Y jerk, so the junction deviation that passes the same corner is also
 *   emitted (see marlinJunctionDeviationMm), on its own M205 line so a classic build
 *   rejecting J does not take the jerk values with it. The corner speed passed in must already respect
 *   maxCornerSpeedMmS, which the spec fit guarantees.
 * - RepRapFirmware: M566 is classic per-axis jerk in mm/min; the same 90 degree
 *   coincidence applies, so the value is the corner speed times 60.
 * The acceleration is set as the print and travel acceleration (Klipper ACCEL, M204 P/T)
 * and, on Marlin and RepRapFirmware, also as the per-axis maximum (M201 X/Y in mm/s^2):
 * the per-axis maximum caps every move on those firmwares, so a stock value below the test
 * acceleration would stretch the modelled ramps. Klipper's ACCEL is itself the maximum.
 * The maximum velocity is raised to the fastest commanded move of the print (rounded up
 * to a whole mm/s), so a configured maximum below a tier speed or a sweep chord can
 * never clamp a commanded feedrate: Klipper VELOCITY, Marlin M203 in mm/s, and
 * RepRapFirmware M203 in mm/min.
 */
export function isMotionLimitCommands(
  profile: PrinterProfile,
  accelMmS2: number,
  cornerSpeedMmS: number,
  maxSpeedMmS: number,
): string[] {
  const scv = cornerSpeedMmS
  const vMax = Math.ceil(maxSpeedMmS)
  if (profile.firmware === 'Marlin') {
    return [
      `M203 X${vMax} Y${vMax}`,
      `M201 X${accelMmS2} Y${accelMmS2}`,
      `M204 P${accelMmS2} T${accelMmS2}`,
      `M205 X${scv} Y${scv}`,
      `M205 J${marlinJunctionDeviationMm(scv, accelMmS2).toFixed(3)}`,
    ]
  }
  if (profile.firmware === 'RepRapFirmware') {
    return [
      `M203 X${vMax * 60} Y${vMax * 60}`,
      `M201 X${accelMmS2} Y${accelMmS2}`,
      `M204 P${accelMmS2} T${accelMmS2}`,
      `M566 X${scv * 60} Y${scv * 60}`,
    ]
  }
  return [
    `SET_VELOCITY_LIMIT VELOCITY=${vMax} ACCEL=${accelMmS2} SQUARE_CORNER_VELOCITY=${scv} ` +
      'MINIMUM_CRUISE_RATIO=0',
  ]
}
