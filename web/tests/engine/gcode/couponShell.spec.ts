import { describe, expect, it } from 'vitest'
import {
  defaultFilamentProfile,
  defaultPrinterProfile,
  type Firmware,
  type PrinterProfile,
} from '../../../src/engine/gcode/profileTypes'
import {
  couponOverriddenSettings,
  finishCoupon,
  restartNoteComments,
  restartNoteText,
} from '../../../src/engine/gcode/couponShell'
import { newEmitter } from '../../../src/engine/gcode/emitter'
import { PA_OVERRIDDEN_SETTINGS } from '../../../src/engine/pa/gcodeGenerator'
import { EM_OVERRIDDEN_SETTINGS } from '../../../src/engine/em/gcodeGenerator'
import { IS_OVERRIDDEN_SETTINGS } from '../../../src/engine/is/gcodeGenerator'

function profileWith(firmware: Firmware): PrinterProfile {
  return { ...defaultPrinterProfile(), firmware }
}

describe('restartNoteComments', () => {
  it('names how shaping and pressure advance come back, the same on every firmware', () => {
    for (const firmware of ['Klipper', 'Marlin', 'RepRapFirmware'] as const) {
      expect(restartNoteComments(profileWith(firmware), ['inputShaping', 'pressureAdvance'])).toEqual([
        '; input shaping resumes with the next firmware restart or saved configuration',
        '; pressure advance resumes with the next firmware restart or saved configuration',
      ])
    }
  })

  it('names the per-firmware way to bring the configured motion limits back, as a comment only', () => {
    expect(restartNoteComments(profileWith('Klipper'), ['motionLimits'])).toEqual([
      '; run FIRMWARE_RESTART to restore your configured motion limits',
    ])
    expect(restartNoteComments(profileWith('Marlin'), ['motionLimits'])).toEqual([
      '; restart the printer or run M501 to restore your configured motion limits',
    ])
    expect(restartNoteComments(profileWith('RepRapFirmware'), ['motionLimits'])).toEqual([
      '; run M98 P"config.g" or restart the printer to restore your configured motion limits',
    ])
  })

  it('names the M221 flow percentage', () => {
    expect(restartNoteComments(profileWith('Marlin'), ['flowPercentage'])).toEqual([
      '; the M221 flow percentage resumes with the next firmware restart',
    ])
  })

  it('keeps the order it is given', () => {
    const lines = restartNoteComments(profileWith('Klipper'), ['motionLimits', 'pressureAdvance'])
    expect(lines[0]).toContain('motion limits')
    expect(lines[1]).toContain('pressure advance')
  })
})

describe('restartNoteText', () => {
  it('names a single setting with a singular value', () => {
    expect(restartNoteText(['pressureAdvance'])).toBe(
      'Restart the firmware after the print finishes. The test overrides the printer\'s ' +
        'pressure advance, and the restart restores the configured value.',
    )
    expect(restartNoteText(['flowPercentage'])).toBe(
      'Restart the firmware after the print finishes. The test overrides the printer\'s ' +
        'flow percentage, and the restart restores the configured value.',
    )
  })

  it('lists several settings and speaks of values', () => {
    expect(restartNoteText(['inputShaping', 'pressureAdvance', 'motionLimits'])).toBe(
      'Restart the firmware after the print finishes. The test overrides the printer\'s ' +
        'input shaping, pressure advance, and motion limits, and the restart restores the ' +
        'configured values.',
    )
    expect(restartNoteText(['motionLimits'])).toContain('configured values.')
  })

  it('refuses an empty list instead of printing a note about nothing', () => {
    expect(() => restartNoteText([])).toThrow(/at least one/)
  })
})

describe('couponOverriddenSettings', () => {
  it('adds the motion limits every coupon preamble sets after the test\'s own overrides', () => {
    expect(couponOverriddenSettings(['pressureAdvance'])).toEqual(['pressureAdvance', 'motionLimits'])
    expect(couponOverriddenSettings(['flowPercentage'])).toEqual(['flowPercentage', 'motionLimits'])
  })

  it('gives every flow a restart note that names the motion limits', () => {
    expect(restartNoteText(PA_OVERRIDDEN_SETTINGS)).toBe(
      'Restart the firmware after the print finishes. The test overrides the printer\'s ' +
        'pressure advance and motion limits, and the restart restores the configured values.',
    )
    expect(restartNoteText(EM_OVERRIDDEN_SETTINGS)).toBe(
      'Restart the firmware after the print finishes. The test overrides the printer\'s ' +
        'flow percentage and motion limits, and the restart restores the configured values.',
    )
    expect(restartNoteText(IS_OVERRIDDEN_SETTINGS)).toBe(
      'Restart the firmware after the print finishes. The test overrides the printer\'s ' +
        'input shaping, pressure advance, and motion limits, and the restart restores the ' +
        'configured values.',
    )
  })
})

describe('finishCoupon', () => {
  it('emits the restart comments, then the final retract, then the filament and printer end G-code', () => {
    const profile = profileWith('Klipper')
    const filament = { ...defaultFilamentProfile(), endGcode: '; filament end' }
    const e = newEmitter()
    finishCoupon(e, profile, filament, ['pressureAdvance'])
    expect(e.lines).toEqual([
      '; pressure advance resumes with the next firmware restart or saved configuration',
      `G1 E-${profile.retractMm.toFixed(3)} F${profile.retractSpeedMmS * 60}`,
      '; filament end',
      ...profile.endGcode.split('\n'),
    ])
  })
})
