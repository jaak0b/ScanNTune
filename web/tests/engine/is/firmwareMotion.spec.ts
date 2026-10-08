import { describe, expect, it } from 'vitest'
import { defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'
import {
  isMotionLimitCommands,
  junctionLimitCommands,
  klipperCentripetalCornerCapMmS,
  PLANNER_STOP,
} from '../../../src/engine/is/firmwareMotion'

describe('isMotionLimitCommands', () => {
  it('sets the Klipper ceiling and acceleration, resets the speed factor, and keeps the profile corner limit', () => {
    // The 160.4 mm/s fastest commanded move rounds up to a whole 161 mm/s ceiling. ACCEL is
    // Klipper's maximum acceleration itself, so no separate per-axis limit exists. The default
    // profile's own corner limit is a 5 mm/s square corner velocity.
    expect(isMotionLimitCommands(defaultPrinterProfile(), 4000, 160.4)).toEqual([
      'SET_VELOCITY_LIMIT VELOCITY=161 ACCEL=4000 MINIMUM_CRUISE_RATIO=0',
      'M220 S100',
      'SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=5',
    ])
  })
})

describe('junctionLimitCommands', () => {
  it('sets the Klipper square corner velocity to the corner speed', () => {
    expect(junctionLimitCommands(75)).toEqual(['SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=75'])
  })
  it('rounds a fractional corner speed up, never below the commanded corner', () => {
    // A rung fed at F2683 runs at 44.716667 mm/s; the printed limit is 44.717 mm/s.
    expect(junctionLimitCommands(2683 / 60)).toEqual([
      'SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=44.717',
    ])
  })
  it('stops the planner with a zero-length dwell', () => {
    expect(PLANNER_STOP).toBe('G4 P0')
  })
})

describe('klipperCentripetalCornerCapMmS', () => {
  it("caps a Klipper 90 degree corner at sqrt(0.5 * leg * accel), calc_junction's centripetal term", () => {
    // 14 mm leg: sqrt(7000) = 83.67 mm/s at 1000 mm/s^2 and sqrt(21000) = 144.91 mm/s at
    // 3000 mm/s^2, rounded down to 0.1 mm/s (hand-derived).
    expect(klipperCentripetalCornerCapMmS(14, 1000)).toBe(83.6)
    expect(klipperCentripetalCornerCapMmS(14, 3000)).toBe(144.9)
  })
})
