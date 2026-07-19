import { describe, expect, it } from 'vitest'
import { defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'
import type { Firmware, PrinterProfile } from '../../../src/engine/gcode/profileTypes'
import {
  isMotionLimitCommands,
  restoreMotionLimitNote,
  restoreShapingCommands,
} from '../../../src/engine/is/firmwareMotion'

function profileWith(firmware: Firmware): PrinterProfile {
  return { ...defaultPrinterProfile(), firmware }
}

describe('isMotionLimitCommands', () => {
  it('uses native square corner velocity semantics on Klipper, with the raised ceiling', () => {
    // The 160.4 mm/s fastest commanded move rounds up to a whole 161 mm/s ceiling.
    expect(isMotionLimitCommands(profileWith('Klipper'), 4000, 75, 160.4)).toEqual([
      'SET_VELOCITY_LIMIT VELOCITY=161 ACCEL=4000 SQUARE_CORNER_VELOCITY=75 MINIMUM_CRUISE_RATIO=0',
    ])
  })
  it('emits Marlin classic jerk and the equivalent junction deviation on separate lines', () => {
    // junction_deviation_mm = 0.4 * jerk^2 / accel (documented Marlin conversion):
    // 0.4 * 75^2 / 4000 = 0.5625 mm; on its own M205 line so a classic build rejecting J
    // keeps the X/Y jerk values. M203 is the velocity ceiling in mm/s.
    expect(isMotionLimitCommands(profileWith('Marlin'), 4000, 75, 160.4)).toEqual([
      'M203 X161 Y161',
      'M204 P4000 T4000',
      'M205 X75 Y75',
      'M205 J0.563',
    ])
  })
  it('emits RepRapFirmware per-axis jerk in mm/min matching the corner velocity', () => {
    // Classic jerk: a 90 degree corner at 75 mm/s is a 75 mm/s per-axis velocity change,
    // in M566 units 4500 mm/min; the M203 velocity ceiling is 161 mm/s, 9660 mm/min.
    expect(isMotionLimitCommands(profileWith('RepRapFirmware'), 4000, 75, 160.4)).toEqual([
      'M203 X9660 Y9660',
      'M204 P4000 T4000',
      'M566 X4500 Y4500',
    ])
  })
})

describe('restoreShapingCommands', () => {
  const firmwares: Firmware[] = ['Klipper', 'Marlin', 'RepRapFirmware']

  it.each(firmwares)('emits only the restore comments for %s', (firmware) => {
    const lines = restoreShapingCommands(profileWith(firmware))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^; input shaping resumes/)
    expect(lines[1]).toMatch(/^; pressure advance resumes/)
  })
})

describe('restoreMotionLimitNote', () => {
  it('names the per-firmware way to bring the configured limits back, as a comment only', () => {
    expect(restoreMotionLimitNote(profileWith('Klipper'))).toEqual([
      '; run FIRMWARE_RESTART to restore your configured motion limits',
    ])
    expect(restoreMotionLimitNote(profileWith('Marlin'))).toEqual([
      '; restart the printer or run M501 to restore your configured motion limits',
    ])
    expect(restoreMotionLimitNote(profileWith('RepRapFirmware'))).toEqual([
      '; run M98 P"config.g" or restart the printer to restore your configured motion limits',
    ])
  })
})
