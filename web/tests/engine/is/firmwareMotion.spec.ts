import { describe, expect, it } from 'vitest'
import { defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'
import type { Firmware, PrinterProfile } from '../../../src/engine/gcode/profileTypes'
import {
  isMotionLimitCommands,
  junctionLimitCommands,
  klipperCentripetalCornerCapMmS,
  marlinJunctionDeviationMm,
  maxCornerSpeedMmS,
  minAccelForCornerSpeedMmS2,
  PLANNER_STOP,
} from '../../../src/engine/is/firmwareMotion'

function profileWith(firmware: Firmware): PrinterProfile {
  // The default profile's own corner limit is a 5 mm/s square corner velocity.
  return { ...defaultPrinterProfile(), firmware }
}

describe('isMotionLimitCommands', () => {
  it('sets the Klipper ceiling and acceleration, resets the speed factor, and keeps the profile corner limit', () => {
    // The 160.4 mm/s fastest commanded move rounds up to a whole 161 mm/s ceiling. ACCEL is
    // Klipper's maximum acceleration itself, so no separate per-axis limit exists.
    expect(isMotionLimitCommands(profileWith('Klipper'), 4000, 160.4)).toEqual([
      'SET_VELOCITY_LIMIT VELOCITY=161 ACCEL=4000 MINIMUM_CRUISE_RATIO=0',
      'M220 S100',
      'SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=5',
    ])
  })
  it('emits the Marlin ceiling, per-axis acceleration, speed factor, and the profile jerk with its junction deviation', () => {
    // The profile's 5 mm/s corner at 4000 mm/s^2 would need J = 25 / (4000 * 2.41421) =
    // 0.0026 mm, below the 0.01 mm M205 J accepts, so the lowest accepted value is emitted.
    expect(isMotionLimitCommands(profileWith('Marlin'), 4000, 160.4)).toEqual([
      'M203 X161 Y161',
      'M201 X4000 Y4000',
      'M204 P4000 T4000',
      'M220 S100',
      'M205 X5 Y5',
      'M205 J0.010',
    ])
  })
  it('emits the RepRapFirmware ceiling and acceleration and the profile jerk in mm/min', () => {
    // The M203 velocity ceiling is 161 mm/s, 9660 mm/min; the profile's 5 mm/s corner is
    // 300 mm/min of M566 jerk; M201 takes mm/s^2.
    expect(isMotionLimitCommands(profileWith('RepRapFirmware'), 4000, 160.4)).toEqual([
      'M203 X9660 Y9660',
      'M201 X4000 Y4000',
      'M204 P4000 T4000',
      'M220 S100',
      'M566 X300 Y300',
    ])
  })
  it('raises the per-axis maximum before the print and travel acceleration on Marlin and RepRapFirmware', () => {
    for (const firmware of ['Marlin', 'RepRapFirmware'] as const) {
      const lines = isMotionLimitCommands(profileWith(firmware), 20000, 160.4)
      expect(lines.indexOf('M201 X20000 Y20000')).toBeGreaterThanOrEqual(0)
      expect(lines.indexOf('M201 X20000 Y20000')).toBeLessThan(lines.indexOf('M204 P20000 T20000'))
    }
  })
})

describe('junctionLimitCommands', () => {
  it('sets the Klipper square corner velocity to the corner speed', () => {
    expect(junctionLimitCommands(profileWith('Klipper'), 75, 3000)).toEqual([
      'SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=75',
    ])
  })
  it('sets the Marlin jerk and, on its own line, the junction deviation that passes the corner', () => {
    // 50 mm/s at 4000 mm/s^2: J = 2500 / (4000 * 2.41421356) = 0.25888 mm, rounded UP to 0.259
    // so the printed J never brakes the corner.
    expect(junctionLimitCommands(profileWith('Marlin'), 50, 4000)).toEqual([
      'M205 X50 Y50',
      'M205 J0.259',
    ])
    // 29.9 mm/s at 3000 mm/s^2 needs 0.12344 mm: rounded up to 0.124, not down to 0.123.
    expect(junctionLimitCommands(profileWith('Marlin'), 29.9, 3000)).toEqual([
      'M205 X29.9 Y29.9',
      'M205 J0.124',
    ])
  })
  it('rounds a fractional corner speed up, never below the commanded corner', () => {
    // A rung fed at F2683 runs at 44.716667 mm/s; the printed limits are 44.717 mm/s and
    // 2683 mm/min, and its junction deviation 0.27608 mm prints as 0.277.
    const v = 2683 / 60
    expect(junctionLimitCommands(profileWith('Klipper'), v, 3000)).toEqual([
      'SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=44.717',
    ])
    expect(junctionLimitCommands(profileWith('Marlin'), v, 3000)).toEqual([
      'M205 X44.717 Y44.717',
      'M205 J0.277',
    ])
    expect(junctionLimitCommands(profileWith('RepRapFirmware'), v, 3000)).toEqual([
      'M566 X2683 Y2683',
    ])
  })
  it('stops the planner with a zero-length dwell', () => {
    expect(PLANNER_STOP).toBe('G4 P0')
  })
})

describe('marlinJunctionDeviationMm', () => {
  it('inverts the planner junction formula for a 90 degree corner inside the accepted range', () => {
    // J = v^2 / (a * (sqrt(2) + 1)) = (sqrt(2) - 1) * 50^2 / 4000 = 0.2588834765 mm,
    // hand-derived from Marlin's vmax_junction^2 = a * J * sin_theta_d2 / (1 - sin_theta_d2)
    // with sin_theta_d2 = 1 / sqrt(2).
    expect(marlinJunctionDeviationMm(50, 4000)).toBeCloseTo(0.2588834765, 9)
  })
  it('never leaves the 0.01 to 0.3 mm range M205 J accepts', () => {
    // 100 mm/s at 4000 mm/s^2 would need 1.0355 mm, which Marlin rejects; 20 mm/s at
    // 20000 mm/s^2 needs 0.0083 mm. Raising the low value only loosens an upper bound.
    expect(marlinJunctionDeviationMm(100, 4000)).toBe(0.3)
    expect(marlinJunctionDeviationMm(20, 20000)).toBe(0.01)
  })
})

describe('maxCornerSpeedMmS', () => {
  it('caps Marlin at the corner speed a 0.3 mm junction deviation expresses, rounded down', () => {
    // sqrt(0.3 * a * (sqrt(2) + 1)), hand-derived: 53.82 mm/s at 4000 mm/s^2 and
    // 120.35 mm/s at 20000 mm/s^2, rounded down to 0.1 mm/s.
    expect(maxCornerSpeedMmS(profileWith('Marlin'), 4000)).toBe(53.8)
    expect(maxCornerSpeedMmS(profileWith('Marlin'), 20000)).toBe(120.3)
  })
  it('keeps the emitted J inside the accepted range at the cap', () => {
    // At the 3000 mm/s^2 cap of 46.6 mm/s the exact requirement is 0.29983 mm, printed as
    // 0.300: inside the range, never above it.
    expect(junctionLimitCommands(profileWith('Marlin'), 46.6, 3000)).toContain('M205 J0.300')
    for (const accel of [600, 3000, 4000, 7777, 20000]) {
      const cap = maxCornerSpeedMmS(profileWith('Marlin'), accel)!
      const lines = junctionLimitCommands(profileWith('Marlin'), cap, accel)
      const j = lines.find((l) => l.startsWith('M205 J'))!
      expect(Number(j.replace('M205 J', '')), `${accel} mm/s^2`).toBeLessThanOrEqual(0.3)
    }
  })
  it('sets no cap on Klipper or RepRapFirmware', () => {
    expect(maxCornerSpeedMmS(profileWith('Klipper'), 4000)).toBeNull()
    expect(maxCornerSpeedMmS(profileWith('RepRapFirmware'), 4000)).toBeNull()
  })
})

describe('klipperCentripetalCornerCapMmS', () => {
  it("caps a Klipper 90 degree corner at sqrt(0.5 * leg * accel), calc_junction's centripetal term", () => {
    // 14 mm leg: sqrt(7000) = 83.67 mm/s at 1000 mm/s^2 and sqrt(21000) = 144.91 mm/s at
    // 3000 mm/s^2, rounded down to 0.1 mm/s (hand-derived).
    expect(klipperCentripetalCornerCapMmS(profileWith('Klipper'), 14, 1000)).toBe(83.6)
    expect(klipperCentripetalCornerCapMmS(profileWith('Klipper'), 14, 3000)).toBe(144.9)
  })
  it('sets no centripetal cap on Marlin or RepRapFirmware', () => {
    expect(klipperCentripetalCornerCapMmS(profileWith('Marlin'), 14, 1000)).toBeNull()
    expect(klipperCentripetalCornerCapMmS(profileWith('RepRapFirmware'), 14, 1000)).toBeNull()
  })
})

describe('minAccelForCornerSpeedMmS2', () => {
  it('inverts the Marlin cap, rounded up to a whole mm/s^2', () => {
    // 20^2 / (0.3 * (sqrt(2) + 1)) = 552.28 mm/s^2, and the cap there reaches 20 mm/s again.
    expect(minAccelForCornerSpeedMmS2(profileWith('Marlin'), 20)).toBe(553)
    expect(maxCornerSpeedMmS(profileWith('Marlin'), 553)).toBe(20)
    expect(maxCornerSpeedMmS(profileWith('Marlin'), 552)).toBe(19.9)
  })
  it('is null where the firmware sets no bound', () => {
    expect(minAccelForCornerSpeedMmS2(profileWith('Klipper'), 20)).toBeNull()
  })
})
