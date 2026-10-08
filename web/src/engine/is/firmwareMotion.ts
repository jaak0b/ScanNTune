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
 * A zero-length dwell that brings the motion planner to a full stop: Klipper's G4 flushes the
 * lookahead queue so the last queued move decelerates to zero (toolhead.dwell ->
 * get_last_move_time -> lookahead.flush), Marlin's G4 calls planner.synchronize(), and
 * RepRapFirmware's G4 waits for standstill once motion was commanded (DoDwell). The next move
 * then starts from rest under the corner limit in force when it is queued, like the first move
 * of any print.
 */
export const PLANNER_STOP = 'G4 P0'

/** A persisted speed factor scales every commanded feed rate, which would scale the measured
 *  ringing frequency of both tiers alike; all three firmwares accept M220 S100. */
export const SPEED_FACTOR_RESET = 'M220 S100'

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
 * The fastest corner Klipper's planner lets a 90 degree junction take between moves of the
 * given length, rounded down to 0.1 mm/s, or null on other firmwares. Klipper's
 * Move.calc_junction limits every junction by the "approximated centripetal velocity" of both
 * moves, v^2 <= 0.5 * move_d * accel * tan(theta / 2) ("approximated circle must contact
 * moves no further than mid-move"), which at 90 degrees (tan 45 = 1) is v^2 <= 0.5 * d * a.
 * The binding move is the shortest run-up leg (the prime-to-corner move); the measured
 * segment after the corner is far longer.
 */
export function klipperCentripetalCornerCapMmS(
  profile: PrinterProfile,
  legMm: number,
  accelMmS2: number,
): number | null {
  if (profile.firmware !== 'Klipper') return null
  return Math.floor(Math.sqrt(0.5 * legMm * accelMmS2) * 10) / 10
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

/** A limit value rounded UP to 3 decimals and printed without trailing zeros, so the printed
 *  limit is never below the speed it has to pass. */
function limitText(v: number): string {
  return String(Math.ceil(v * 1000 - 1e-9) / 1000)
}

/**
 * The commands that set the firmware's corner limit to pass a 90 degree corner at exactly
 * `cornerSpeedMmS` without braking; the single home of that mapping, used for the test's
 * per-line raise and for setting the profile's own value back:
 * - Klipper: SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY is the native semantics; a 90 degree
 *   junction entered at or below it passes unbraked. Each queued move keeps the junction
 *   deviation current when it was queued (Move.__init__), and the command does not flush.
 * - Marlin classic jerk: M205 X/Y is the allowed instantaneous per-axis velocity change in
 *   mm/s, per motor on CoreXY. For an exact 90 degree corner the per-axis (Cartesian) change
 *   equals the corner speed, and on CoreXY the reversing motor counts max(|v_exit|, |v_entry|)
 *   = the corner speed by the planner's reversal rule, so X/Y jerk set to the corner speed
 *   passes it. Junction-deviation builds ignore X/Y jerk, so the junction deviation that passes
 *   the same corner is also emitted (see marlinJunctionDeviationMm), on its own M205 line so a
 *   classic build rejecting J does not take the jerk values with it. M205 does not
 *   synchronize; it applies to blocks planned after it.
 * - RepRapFirmware: M566 is per-axis jerk in mm/min, applied to the Cartesian move direction
 *   (DDA::MatchSpeeds works on the user-space direction vector, also on CoreXY), so the value
 *   is the corner speed times 60.
 * Values are rounded up, so the printed limit never brakes the commanded corner.
 */
export function junctionLimitCommands(
  profile: PrinterProfile,
  cornerSpeedMmS: number,
  accelMmS2: number,
): string[] {
  if (profile.firmware === 'Marlin') {
    const jd = Math.ceil(marlinJunctionDeviationMm(cornerSpeedMmS, accelMmS2) * 1000 - 1e-9) / 1000
    return [
      `M205 X${limitText(cornerSpeedMmS)} Y${limitText(cornerSpeedMmS)}`,
      `M205 J${jd.toFixed(3)}`,
    ]
  }
  if (profile.firmware === 'RepRapFirmware') {
    const perMinute = limitText(cornerSpeedMmS * 60)
    return [`M566 X${perMinute} Y${perMinute}`]
  }
  return [`SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=${limitText(cornerSpeedMmS)}`]
}

/**
 * Motion limits set once in the test's preamble. The acceleration is set as the print and
 * travel acceleration (Klipper ACCEL, M204 P/T) and, on Marlin and RepRapFirmware, also as
 * the per-axis maximum (M201 X/Y in mm/s^2): the per-axis maximum caps every move on those
 * firmwares, so a stock value below the test acceleration would stretch the modelled ramps.
 * Klipper's ACCEL is itself the maximum, and MINIMUM_CRUISE_RATIO=0 keeps its ramps the plain
 * trapezoids the analysis models. The maximum velocity is raised to the fastest commanded move
 * of the print (rounded up to a whole mm/s), so a configured maximum below a tier speed can
 * never clamp a commanded feedrate: Klipper VELOCITY, Marlin M203 in mm/s, and RepRapFirmware
 * M203 in mm/min. The speed factor is reset to 100%. The corner limit is the profile's own
 * square corner velocity (Marlin jerk plus derived junction deviation): the preamble, the base
 * layers, the band perimeters and the band raster all run at it, and each test line raises it
 * to its own corner speed only for its run-up, corner and measured segment.
 */
export function isMotionLimitCommands(
  profile: PrinterProfile,
  accelMmS2: number,
  maxSpeedMmS: number,
): string[] {
  const vMax = Math.ceil(maxSpeedMmS)
  const corner = junctionLimitCommands(profile, profile.squareCornerVelocityMmS, accelMmS2)
  if (profile.firmware === 'Marlin') {
    return [
      `M203 X${vMax} Y${vMax}`,
      `M201 X${accelMmS2} Y${accelMmS2}`,
      `M204 P${accelMmS2} T${accelMmS2}`,
      SPEED_FACTOR_RESET,
      ...corner,
    ]
  }
  if (profile.firmware === 'RepRapFirmware') {
    return [
      `M203 X${vMax * 60} Y${vMax * 60}`,
      `M201 X${accelMmS2} Y${accelMmS2}`,
      `M204 P${accelMmS2} T${accelMmS2}`,
      SPEED_FACTOR_RESET,
      ...corner,
    ]
  }
  return [
    `SET_VELOCITY_LIMIT VELOCITY=${vMax} ACCEL=${accelMmS2} MINIMUM_CRUISE_RATIO=0`,
    SPEED_FACTOR_RESET,
    ...corner,
  ]
}
