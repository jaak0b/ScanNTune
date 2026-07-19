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
 * Motion limits for the test, per firmware, derived from the spec's corner speed so the
 * run-up cruise passes the corner without deceleration:
 * - Klipper: SQUARE_CORNER_VELOCITY is the native semantics; any junction entered at or
 *   below it passes unbraked, so it is set to the corner speed.
 * - Marlin classic jerk: M205 X/Y is the allowed instantaneous per-axis velocity change
 *   in mm/s. For an exact 90 degree corner the per-axis delta-v equals the corner speed,
 *   so X/Y jerk set to the corner speed coincides with it. Junction-deviation
 *   builds ignore X/Y jerk, so the equivalent junction deviation is also emitted using
 *   the documented Marlin conversion junction_deviation_mm = 0.4 * jerk^2 / accel, on its
 *   own M205 line so a classic build rejecting J does not take the jerk values with it.
 * - RepRapFirmware: M566 is classic per-axis jerk in mm/min; the same 90 degree
 *   coincidence applies, so the value is the corner speed times 60.
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
    const junctionDeviationMm = (0.4 * scv * scv) / accelMmS2
    return [
      `M203 X${vMax} Y${vMax}`,
      `M204 P${accelMmS2} T${accelMmS2}`,
      `M205 X${scv} Y${scv}`,
      `M205 J${junctionDeviationMm.toFixed(3)}`,
    ]
  }
  if (profile.firmware === 'RepRapFirmware') {
    return [
      `M203 X${vMax * 60} Y${vMax * 60}`,
      `M204 P${accelMmS2} T${accelMmS2}`,
      `M566 X${scv * 60} Y${scv * 60}`,
    ]
  }
  return [
    `SET_VELOCITY_LIMIT VELOCITY=${vMax} ACCEL=${accelMmS2} SQUARE_CORNER_VELOCITY=${scv} ` +
      'MINIMUM_CRUISE_RATIO=0',
  ]
}

/**
 * Comment lines noting that the printer's own input shaper and pressure advance settings come
 * back with the next firmware restart or saved configuration; nothing is re-applied in G-code.
 */
export function restoreShapingCommands(_profile: PrinterProfile): string[] {
  return [
    '; input shaping resumes with the next firmware restart or saved configuration',
    '; pressure advance resumes with the next firmware restart or saved configuration',
  ]
}

/**
 * Comment line telling the user how to bring back their own motion limits after the test
 * overrode them; no numeric values are re-applied in G-code, so no printer settings need
 * to be stored for the restore.
 */
export function restoreMotionLimitNote(profile: PrinterProfile): string[] {
  if (profile.firmware === 'Marlin') {
    return ['; restart the printer or run M501 to restore your configured motion limits']
  }
  if (profile.firmware === 'RepRapFirmware') {
    return ['; run M98 P"config.g" or restart the printer to restore your configured motion limits']
  }
  return ['; run FIRMWARE_RESTART to restore your configured motion limits']
}
