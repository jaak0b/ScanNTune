import { describe, expect, it } from 'vitest'
import { defaultFilamentProfile, defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'
import {
  availableBedDepthMm,
  couponOrigin,
  couponOverriddenSettings,
  finishCoupon,
  restartNoteComments,
} from '../../../src/engine/gcode/couponShell'
import { newEmitter } from '../../../src/engine/gcode/emitter'
import { PA_OVERRIDDEN_SETTINGS } from '../../../src/engine/pa/gcodeGenerator'
import { EM_OVERRIDDEN_SETTINGS } from '../../../src/engine/em/gcodeGenerator'
import { IS_OVERRIDDEN_SETTINGS } from '../../../src/engine/is/gcodeGenerator'

describe('restartNoteComments', () => {
  it('names how shaping and pressure advance come back', () => {
    expect(restartNoteComments(['inputShaping', 'pressureAdvance'])).toEqual([
      '; input shaping resumes with the next firmware restart or saved configuration',
      '; pressure advance resumes with the next firmware restart or saved configuration',
    ])
  })

  it('names the FIRMWARE_RESTART that brings the configured motion limits back, as a comment only', () => {
    expect(restartNoteComments(['motionLimits'])).toEqual([
      '; run FIRMWARE_RESTART to restore your configured motion limits',
    ])
  })

  it('names the M221 flow percentage', () => {
    expect(restartNoteComments(['flowPercentage'])).toEqual([
      '; the M221 flow percentage resumes with the next firmware restart',
    ])
  })

  it('names the M220 speed factor', () => {
    expect(restartNoteComments(['speedFactor'])).toEqual([
      '; the M220 speed factor resumes with the next firmware restart',
    ])
  })

  it('keeps the order it is given', () => {
    const lines = restartNoteComments(['motionLimits', 'pressureAdvance'])
    expect(lines[0]).toContain('motion limits')
    expect(lines[1]).toContain('pressure advance')
  })
})

describe('couponOverriddenSettings', () => {
  it('adds the motion limits every coupon preamble sets after the test\'s own overrides', () => {
    expect(couponOverriddenSettings(['pressureAdvance'])).toEqual(['pressureAdvance', 'motionLimits'])
    expect(couponOverriddenSettings(['flowPercentage'])).toEqual(['flowPercentage', 'motionLimits'])
  })

  it('ends every flow\'s G-code with the motion limits restart comment', () => {
    for (const settings of [PA_OVERRIDDEN_SETTINGS, EM_OVERRIDDEN_SETTINGS, IS_OVERRIDDEN_SETTINGS]) {
      expect(restartNoteComments(settings).at(-1)).toBe(
        '; run FIRMWARE_RESTART to restore your configured motion limits',
      )
    }
  })
})

describe('finishCoupon', () => {
  it('emits the restart comments, then the final retract, then the filament and printer end G-code', () => {
    const profile = defaultPrinterProfile()
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

describe('placement on the bed', () => {
  // A 120 x 120 mm bed: the front and back placements keep a 10 mm margin to their edge.
  const bed = { ...defaultPrinterProfile(), bedWidthMm: 120, bedDepthMm: 120 }

  it('leaves the whole depth to a centered coupon and the depth less the edge margin otherwise', () => {
    expect(availableBedDepthMm(bed, 'center')).toBe(120)
    expect(availableBedDepthMm(bed, 'front')).toBe(110)
    expect(availableBedDepthMm(bed, 'back')).toBe(110)
  })

  it('places a fitting coupon against the requested edge', () => {
    expect(couponOrigin(bed, 100, 110, 'front')).toEqual({ ox: 10, oy: 10 })
    expect(couponOrigin(bed, 100, 110, 'back')).toEqual({ ox: 10, oy: 0 })
    expect(couponOrigin(bed, 100, 120, 'center')).toEqual({ ox: 10, oy: 0 })
  })

  it('refuses a front coupon that would overhang the far (back) edge', () => {
    // 111 mm from a 10 mm front margin ends at 121 mm, past the 120 mm bed.
    expect(() => couponOrigin(bed, 100, 111, 'front')).toThrow('Coupon does not fit on the configured bed')
    expect(() => couponOrigin(bed, 100, 111, 'back')).toThrow('Coupon does not fit on the configured bed')
    expect(() => couponOrigin(bed, 121, 100, 'center')).toThrow('Coupon does not fit on the configured bed')
  })
})
