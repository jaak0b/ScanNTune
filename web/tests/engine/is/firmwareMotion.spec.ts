import { describe, expect, it } from 'vitest'
import { defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'
import type { Firmware, PrinterProfile } from '../../../src/engine/gcode/profileTypes'
import {
  isMotionLimitCommands,
  marlinJunctionDeviationMm,
  maxCornerSpeedMmS,
  minAccelForCornerSpeedMmS2,
} from '../../../src/engine/is/firmwareMotion'

function profileWith(firmware: Firmware): PrinterProfile {
  return { ...defaultPrinterProfile(), firmware }
}

describe('isMotionLimitCommands', () => {
  it('uses native square corner velocity semantics on Klipper, with the raised ceiling', () => {
    // The 160.4 mm/s fastest commanded move rounds up to a whole 161 mm/s ceiling. ACCEL is
    // Klipper's maximum acceleration itself, so no separate per-axis limit exists.
    expect(isMotionLimitCommands(profileWith('Klipper'), 4000, 75, 160.4)).toEqual([
      'SET_VELOCITY_LIMIT VELOCITY=161 ACCEL=4000 SQUARE_CORNER_VELOCITY=75 MINIMUM_CRUISE_RATIO=0',
    ])
  })
  it('emits Marlin per-axis acceleration, classic jerk, and the junction deviation on separate lines', () => {
    // Marlin's planner takes a 90 degree junction at v^2 = a * J * (sqrt(2) + 1), so a 50 mm/s
    // corner at 4000 mm/s^2 needs J = 2500 / (4000 * 2.41421356) = 0.25888 mm (hand-derived),
    // printed as 0.259 and inside the 0.01 to 0.3 mm range M205 J accepts; on its own M205
    // line so a classic build rejecting J keeps the X/Y jerk values. M203 is the velocity
    // ceiling in mm/s, M201 the per-axis maximum acceleration in mm/s^2.
    expect(isMotionLimitCommands(profileWith('Marlin'), 4000, 50, 160.4)).toEqual([
      'M203 X161 Y161',
      'M201 X4000 Y4000',
      'M204 P4000 T4000',
      'M205 X50 Y50',
      'M205 J0.259',
    ])
  })
  it('emits RepRapFirmware per-axis acceleration and jerk in mm/min matching the corner velocity', () => {
    // Classic jerk: a 90 degree corner at 75 mm/s is a 75 mm/s per-axis velocity change,
    // in M566 units 4500 mm/min; the M203 velocity ceiling is 161 mm/s, 9660 mm/min; M201
    // takes mm/s^2.
    expect(isMotionLimitCommands(profileWith('RepRapFirmware'), 4000, 75, 160.4)).toEqual([
      'M203 X9660 Y9660',
      'M201 X4000 Y4000',
      'M204 P4000 T4000',
      'M566 X4500 Y4500',
    ])
  })
  it('raises the per-axis maximum before the print and travel acceleration on Marlin and RepRapFirmware', () => {
    for (const firmware of ['Marlin', 'RepRapFirmware'] as const) {
      const lines = isMotionLimitCommands(profileWith(firmware), 20000, 75, 160.4)
      expect(lines.indexOf('M201 X20000 Y20000')).toBeGreaterThanOrEqual(0)
      expect(lines.indexOf('M201 X20000 Y20000')).toBeLessThan(lines.indexOf('M204 P20000 T20000'))
    }
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
    // At the 4000 mm/s^2 cap the exact requirement is 0.29973 mm, printed as 0.300: inside
    // the range, never above it.
    expect(isMotionLimitCommands(profileWith('Marlin'), 4000, 53.8, 150)).toContain('M205 J0.300')
    for (const accel of [600, 3000, 4000, 7777, 20000]) {
      const cap = maxCornerSpeedMmS(profileWith('Marlin'), accel)!
      const lines = isMotionLimitCommands(profileWith('Marlin'), accel, cap, 150)
      const j = lines.find((l) => l.startsWith('M205 J'))!
      expect(Number(j.replace('M205 J', '')), `${accel} mm/s^2`).toBeLessThanOrEqual(0.3)
    }
  })
  it('sets no cap on Klipper or RepRapFirmware', () => {
    expect(maxCornerSpeedMmS(profileWith('Klipper'), 4000)).toBeNull()
    expect(maxCornerSpeedMmS(profileWith('RepRapFirmware'), 4000)).toBeNull()
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
