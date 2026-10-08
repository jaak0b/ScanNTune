import type { PrinterProfile } from '../gcode/profileTypes'

/** Switches input shaping and pressure advance off, so the test's corners ring unmasked. */
export const DISABLE_SHAPING_COMMANDS: readonly string[] = [
  'SET_INPUT_SHAPER SHAPER_FREQ_X=0 SHAPER_FREQ_Y=0',
  'SET_PRESSURE_ADVANCE ADVANCE=0',
]

/**
 * A zero-length dwell that brings the motion planner to a full stop: Klipper's G4 flushes the
 * lookahead queue so the last queued move decelerates to zero (toolhead.dwell ->
 * get_last_move_time -> lookahead.flush). The next move then starts from rest under the
 * corner limit in force when it is queued, like the first move of any print.
 */
export const PLANNER_STOP = 'G4 P0'

/** A persisted speed factor scales every commanded feed rate, which would scale the measured
 *  ringing frequency of both tiers alike; M220 S100 resets it. */
export const SPEED_FACTOR_RESET = 'M220 S100'

/**
 * The fastest corner Klipper's planner lets a 90 degree junction take between moves of the
 * given length, rounded down to 0.1 mm/s. Klipper's Move.calc_junction limits every junction
 * by the "approximated centripetal velocity" of both moves,
 * v^2 <= 0.5 * move_d * accel * tan(theta / 2) ("approximated circle must contact moves no
 * further than mid-move"), which at 90 degrees (tan 45 = 1) is v^2 <= 0.5 * d * a. The binding
 * move is the shortest run-up leg (the prime-to-corner move); the measured segment after the
 * corner is far longer.
 */
export function klipperCentripetalCornerCapMmS(legMm: number, accelMmS2: number): number {
  return Math.floor(Math.sqrt(0.5 * legMm * accelMmS2) * 10) / 10
}

/** A limit value rounded UP to 3 decimals and printed without trailing zeros, so the printed
 *  limit is never below the speed it has to pass. */
function limitText(v: number): string {
  return String(Math.ceil(v * 1000 - 1e-9) / 1000)
}

/**
 * The command that sets Klipper's corner limit to pass a 90 degree corner at exactly
 * `cornerSpeedMmS` without braking; the single home of that mapping, used for the test's
 * per-line raise and for setting the profile's own value back. SET_VELOCITY_LIMIT
 * SQUARE_CORNER_VELOCITY is the native semantics: a 90 degree junction entered at or below it
 * passes unbraked. Each queued move keeps the junction deviation current when it was queued
 * (Move.__init__), and the command does not flush. The value is rounded up, so the printed
 * limit never brakes the commanded corner.
 */
export function junctionLimitCommands(cornerSpeedMmS: number): string[] {
  return [`SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=${limitText(cornerSpeedMmS)}`]
}

/**
 * Motion limits set once in the test's preamble. The acceleration is set as Klipper's ACCEL,
 * which is itself the maximum acceleration, and MINIMUM_CRUISE_RATIO=0 keeps its ramps the
 * plain trapezoids the analysis models. The maximum velocity is raised to the fastest
 * commanded move of the print (rounded up to a whole mm/s), so a configured maximum below a
 * tier speed can never clamp a commanded feedrate. The speed factor is reset to 100%. The
 * corner limit is the profile's own square corner velocity: the preamble, the base layers, the
 * band perimeters and the band raster all run at it, and each test line raises it to its own
 * corner speed only for its run-up, corner and measured segment.
 */
export function isMotionLimitCommands(
  profile: PrinterProfile,
  accelMmS2: number,
  maxSpeedMmS: number,
): string[] {
  const vMax = Math.ceil(maxSpeedMmS)
  return [
    `SET_VELOCITY_LIMIT VELOCITY=${vMax} ACCEL=${accelMmS2} MINIMUM_CRUISE_RATIO=0`,
    SPEED_FACTOR_RESET,
    ...junctionLimitCommands(profile.squareCornerVelocityMmS),
  ]
}
