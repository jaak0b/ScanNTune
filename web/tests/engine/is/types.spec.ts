import { describe, expect, it } from 'vitest'
import { defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'
import type { Firmware, PrinterProfile } from '../../../src/engine/gcode/profileTypes'
import {
  accelRampMm,
  bandTopWarning,
  defaultIsTestRequest,
  fitSpecToPrinter,
  followableRungCount,
  type IsTestRequest,
  rampWarnings,
  speedTiersFor,
  TIER_SPEED_RATIO,
  validateIsSpec,
} from '../../../src/engine/is/types'
import { isCouponGeometry, ladderCornerSpeeds } from '../../../src/engine/is/couponGeometry'

const profile = defaultPrinterProfile()
const request = defaultIsTestRequest(profile)
const fitted = (r: IsTestRequest, p: PrinterProfile = profile) => fitSpecToPrinter(r, p).spec

describe('defaultIsTestRequest', () => {
  it('uses the documented defaults', () => {
    expect(request.speedsMmS).toEqual([106, 150])
    expect(request.linesPerSpeed).toBeNull()
    // Five wavelengths of the 25 Hz lowest resonance of interest at the 150 mm/s tier:
    // 5 * 150 / 25 = 30 mm.
    expect(request.measuredLineMm).toBe(30)
    expect(request.runUpMm).toBe(8)
    expect(request.linePitchMm).toBe(2.5)
    expect(request.axes).toEqual(['x', 'y'])
    expect(request.cornerSpeedMmS).toBe(100)
    expect(request.weldMm).toBe(1)
    expect(request.placement).toBe('center')
    expect(request.contrastBase).toBe(false)
  })
  it('runs at the profile print acceleration, neither floored nor capped', () => {
    expect(defaultIsTestRequest({ ...profile, printAccelMmS2: 1000 }).accelMmS2).toBe(1000)
    expect(defaultIsTestRequest({ ...profile, printAccelMmS2: 20000 }).accelMmS2).toBe(20000)
    expect(defaultIsTestRequest({ ...profile, printAccelMmS2: 4500 }).accelMmS2).toBe(4500)
  })
})

describe('speed tiers', () => {
  it('derives the tier ratio from the detection level, the speed-check power and the CI gate', () => {
    // exp((z_0.999 + z_0.95) * sqrt(2) * 0.1 / z_0.975) with the AS 241 quantiles
    // 3.090232, 1.644854 and 1.959964: exp(0.341658) = 1.407282 (hand-derived).
    expect(TIER_SPEED_RATIO).toBeCloseTo(1.407282, 6)
  })
  it('pairs the line speed with the slower tier rounded down to a whole mm/s', () => {
    // 150 / 1.407282 = 106.59 -> 106; 29 / 1.407282 = 20.61 -> 20; 28 -> 19.90 -> 19.
    expect(speedTiersFor(150)).toEqual([106, 150])
    expect(speedTiersFor(29)).toEqual([20, 29])
    expect(speedTiersFor(28)).toEqual([19, 28])
  })
})

describe('validateIsSpec', () => {
  it('accepts the default request, its derived line count still open', () => {
    expect(() => validateIsSpec(request)).not.toThrow()
  })
  it('throws on zero or more than 2 speed tiers', () => {
    expect(() => validateIsSpec({ ...request, speedsMmS: [] })).toThrow(/speed tiers/)
    expect(() => validateIsSpec({ ...request, speedsMmS: [106, 150, 200] })).toThrow(
      'Between 1 and 2 speed tiers are required',
    )
    expect(() => validateIsSpec({ ...request, speedsMmS: [150] })).not.toThrow()
  })
  it('throws on non-positive values', () => {
    expect(() => validateIsSpec({ ...request, speedsMmS: [0] })).toThrow(/positive/)
    expect(() => validateIsSpec({ ...request, runUpMm: -1 })).toThrow(/positive/)
    expect(() => validateIsSpec({ ...request, linePitchMm: 0 })).toThrow(/positive/)
    expect(() => validateIsSpec({ ...request, accelMmS2: 0 })).toThrow(/positive/)
    expect(() => validateIsSpec({ ...request, weldMm: 0 })).toThrow(/positive/)
  })
  it('throws when the corner speed sits below the 20 mm/s floor', () => {
    expect(() => validateIsSpec({ ...request, cornerSpeedMmS: 19 })).toThrow(/at least 20 mm\/s/)
    expect(() =>
      validateIsSpec({ ...request, cornerSpeedMmS: 20, speedsMmS: [20] }),
    ).not.toThrow()
  })
  it('throws when the line speed (the fastest tier) sits below the corner speed', () => {
    // A slower line caps the planner's corner junction at its cruise speed, so the
    // configured corner speed would never be reached.
    expect(() => validateIsSpec({ ...request, speedsMmS: [99] })).toThrow(
      'The line speed must be at least the 100 mm/s corner speed. A slower line caps the ' +
        'corner below the corner speed and weakens the excitation.',
    )
    // A slower derived tier is legal: its own ladder tops out at its speed.
    expect(() => validateIsSpec({ ...request, speedsMmS: [99, 150] })).not.toThrow()
  })
  it('throws when the slower tier falls below the 20 mm/s bottom rung', () => {
    expect(() => validateIsSpec({ ...request, cornerSpeedMmS: 20, speedsMmS: [19, 28] })).toThrow(
      'Raise the line speed to at least 29 mm/s, or use one speed tier. Every speed tier ' +
        'must be at least 20 mm/s, the bottom rung of its corner-speed ladder.',
    )
    expect(() =>
      validateIsSpec({ ...request, cornerSpeedMmS: 20, speedsMmS: [20, 29] }),
    ).not.toThrow()
  })
  it('throws on lines per speed outside 3 to 15, and accepts the derived (null) count', () => {
    expect(() => validateIsSpec({ ...request, linesPerSpeed: 2 })).toThrow(/Lines per speed/)
    expect(() => validateIsSpec({ ...request, linesPerSpeed: 16 })).toThrow(/Lines per speed/)
    expect(() => validateIsSpec({ ...request, linesPerSpeed: 15 })).not.toThrow()
    expect(() => validateIsSpec({ ...request, linesPerSpeed: null })).not.toThrow()
  })
  it('throws when the clean read length is shorter than the 20 mm floor', () => {
    expect(() => validateIsSpec({ ...request, measuredLineMm: 19 })).toThrow(/at least 20 mm/)
    expect(() => validateIsSpec({ ...request, measuredLineMm: 20 })).not.toThrow()
  })
  it('throws on empty axes', () => {
    expect(() => validateIsSpec({ ...request, axes: [] })).toThrow(/axis/)
  })
})

describe('rampWarnings', () => {
  const spec = fitted(request)
  it('is silent at a low acceleration whose run-up still reaches the corner speed', () => {
    // The excitation is the velocity step at the corner, which the acceleration does not
    // set, so a low acceleration alone is no reason to warn: at 1000 mm/s^2 the ramp to
    // the 100 mm/s corner speed is 100^2 / 2000 = 5 mm, inside the 8 mm run-up.
    expect(rampWarnings({ ...spec, accelMmS2: 1000 })).toEqual([])
  })
  it('warns when the run-up cannot host the ramp to the 100 mm/s corner speed', () => {
    // At 4000 mm/s^2 the ramp from rest to 100 mm/s is 100^2 / 8000 = 1.25 mm; there
    // is no deceleration term because the run-up cruises into the corner at the emitted
    // corner limit.
    const warnings = rampWarnings({ ...spec, accelMmS2: 4000, runUpMm: 1.2 })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('run-up')
    expect(warnings[0]).toContain('100 mm/s')
    expect(rampWarnings({ ...spec, accelMmS2: 4000, runUpMm: 1.3 })).toEqual([])
  })
  it('does not warn about tier ramps: the layout reserves them before the read window', () => {
    // At 2000 mm/s^2 the 300 mm/s tier needs a long ramp past the corner; the geometry
    // allocates it in front of the clean read length, and the 8 mm run-up still hosts its
    // 2.5 mm ramp to the corner speed, so nothing warns.
    expect(rampWarnings({ ...spec, accelMmS2: 2000, speedsMmS: [150, 300] })).toEqual([])
  })
  it('computes the ramp distance v^2 / (2a)', () => {
    expect(accelRampMm(100, 5000)).toBeCloseTo(1.0, 9)
  })
})

describe('derived lines per speed (bead followability on the slower tier)', () => {
  // Every expected count was re-derived once by an independent scratch implementation of the
  // rule (Farouki and Neff offset regularity, R > w/2, along the commanded profile from the
  // first traced sample, F_MAX lateral ring, F_MIN along-track ring, damping 0.1).
  it('derives five lines per speed for the defaults, three of whose rungs stay followable', () => {
    const spec = fitted(request)
    expect(spec.linesPerSpeed).toBe(5)
    expect(followableRungCount(spec, profile)).toBe(3)
  })
  it('needs fewer lines when Marlin caps the ladder, and more for a wider bead or a lower acceleration', () => {
    expect(fitted(request, { ...profile, firmware: 'Marlin' }).linesPerSpeed).toBe(3)
    expect(fitted(request, { ...profile, nozzleDiameterMm: 0.6 }).linesPerSpeed).toBe(6)
    const slow = { ...profile, printAccelMmS2: 1000 }
    expect(fitted(defaultIsTestRequest(slow), slow).linesPerSpeed).toBe(7)
  })
  it('keeps an explicit line count instead of deriving one', () => {
    expect(fitted({ ...request, linesPerSpeed: 8 }).linesPerSpeed).toBe(8)
  })
  it('warns when fewer than three rungs of the slower tier stay followable', () => {
    // Four rungs (20, 34.2, 58.5, 100 mm/s) leave only two followable beads on the 106 mm/s
    // lines.
    const four = fitted({ ...request, linesPerSpeed: 4 })
    expect(bandTopWarning(four, profile)).toBe(
      'Raise the line speed or the print acceleration, or use more lines per speed, to read ' +
        'a resonance near 150 Hz. Only 2 of the 106 mm/s lines leave a bead that can follow ' +
        'ringing that fast, and the analysis needs 3.',
    )
    expect(bandTopWarning(fitted(request), profile)).toBeNull()
  })
})

describe('fitSpecToPrinter firmware fit', () => {
  const withFirmware = (firmware: Firmware) => ({ ...profile, firmware })

  it('caps the Marlin corner speed where junction deviation stops, and says so', () => {
    // At the default profile's 3000 mm/s^2 a 0.3 mm junction deviation takes a 90 degree
    // corner at most at sqrt(0.3 * 3000 * (sqrt(2) + 1)) = 46.61 mm/s (Marlin's planner
    // junction formula), rounded down to 46.6.
    const { spec, notes } = fitSpecToPrinter(request, withFirmware('Marlin'))
    expect(spec.cornerSpeedMmS).toBe(46.6)
    expect(notes).toEqual([
      "The corner speed was limited to 46.6 mm/s because Marlin's junction deviation cannot " +
        'express a faster corner at 3000 mm/s^2.',
    ])
  })

  it('makes the capped speed the ladder top rung and keeps the 20 mm/s bottom rung', () => {
    const spec = fitted(request, withFirmware('Marlin'))
    const rungs = ladderCornerSpeeds(spec)
    expect(rungs[0]).toBe(20)
    expect(rungs[rungs.length - 1]).toBeCloseTo(46.6, 9)
  })

  it('leaves a Marlin corner speed already under the cap untouched', () => {
    const slow = { ...request, cornerSpeedMmS: 40 }
    expect(fitted(slow, withFirmware('Marlin')).cornerSpeedMmS).toBe(40)
    // The cap grows with the acceleration: 120.3 mm/s at 20000 mm/s^2 hosts the 100 default.
    const hot = { ...request, accelMmS2: 20000 }
    expect(fitSpecToPrinter(hot, withFirmware('Marlin')).notes).toEqual([])
    expect(fitted(hot, withFirmware('Marlin')).cornerSpeedMmS).toBe(100)
  })

  it('never caps Klipper or RepRapFirmware', () => {
    for (const firmware of ['Klipper', 'RepRapFirmware'] as const) {
      const { spec, notes } = fitSpecToPrinter(request, withFirmware(firmware))
      expect(spec.cornerSpeedMmS).toBe(100)
      expect(notes).toEqual([])
    }
  })

  it('refuses a Marlin acceleration too low to express the 20 mm/s minimum corner', () => {
    // 20^2 / (0.3 * (sqrt(2) + 1)) = 552.28 mm/s^2, rounded up to 553; at 552 mm/s^2 the cap
    // is sqrt(0.3 * 552 * (sqrt(2) + 1)) = 19.99 mm/s, rounded down to 19.9.
    expect(() =>
      fitSpecToPrinter({ ...request, accelMmS2: 552, cornerSpeedMmS: 20, speedsMmS: [150] },
        withFirmware('Marlin')),
    ).toThrow(
      'Raise the print acceleration in the printer profile to at least 553 mm/s^2. At ' +
        "552 mm/s^2, Marlin's 0.3 mm junction deviation limit caps the corner speed at " +
        '19.9 mm/s, below the 20 mm/s minimum.',
    )
    expect(() =>
      fitSpecToPrinter({ ...request, accelMmS2: 553, cornerSpeedMmS: 20 }, withFirmware('Marlin')),
    ).not.toThrow()
  })
})

describe('fitSpecToPrinter bed fit', () => {
  const bed = (mm: number) => ({ ...profile, bedWidthMm: mm, bedDepthMm: mm })

  it('leaves the default request unchanged on the default 220 mm bed and on a 120 mm bed', () => {
    // The default coupon is 114.806 mm square (see the couponGeometry footprint test).
    for (const mm of [220, 120]) {
      const { spec, notes } = fitSpecToPrinter(request, bed(mm))
      expect(spec.speedsMmS).toEqual([106, 150])
      expect(spec.linesPerSpeed).toBe(5)
      expect(spec.measuredLineMm).toBe(30)
      expect(notes).toEqual([])
    }
  })
  it('fits a front or back placement into the depth its edge margin leaves', () => {
    // Scan with the plate (front placement) on a 120 mm bed: 110 mm of depth remain, so
    // 114.806 - 30 + L <= 110 gives L = 25 mm; the 120 mm width alone would allow 30.
    for (const placement of ['front', 'back'] as const) {
      const { spec, notes } = fitSpecToPrinter({ ...request, placement }, bed(120))
      expect(spec.linesPerSpeed).toBe(5)
      expect(spec.measuredLineMm).toBe(25)
      expect(notes).toEqual([
        'The measured lines were shortened from 30 mm to 25 mm so the coupon fits the configured bed.',
      ])
    }
  })
  it('shortens the measured lines first, to the longest length that fits', () => {
    // 110 mm bed: 114.806 - 30 + L <= 110 gives L <= 25.194, so 25 mm.
    const { spec, notes } = fitSpecToPrinter(request, bed(110))
    expect(spec.linesPerSpeed).toBe(5)
    expect(spec.measuredLineMm).toBe(25)
    expect(notes).toEqual([
      'The measured lines were shortened from 30 mm to 25 mm so the coupon fits the configured bed.',
    ])
  })
  it('reduces the lines per speed once the shortest lines still overflow, then retakes the longest length', () => {
    // 100 mm bed: five lines need 104.806 mm even at 20 mm; four lines (field 17.5 mm, packed
    // ramp 19.306 mm) fit at L = 100 - 74.806 = 25.194, so 25 mm.
    const { spec, notes } = fitSpecToPrinter(request, bed(100))
    expect(spec.speedsMmS).toEqual([106, 150])
    expect(spec.linesPerSpeed).toBe(4)
    expect(spec.measuredLineMm).toBe(25)
    expect(notes).toEqual([
      'The lines per speed were reduced from 5 to 4 so the coupon fits the configured bed.',
      'The measured lines were shortened from 30 mm to 25 mm so the coupon fits the configured bed.',
    ])
  })
  it('drops the derived slower tier last, then reduces the single tier the same way', () => {
    // 80 mm bed: two tiers at three lines need 84.806 mm at 20 mm. One 150 mm/s tier derives
    // five lines (81.683 mm at 20 mm), fits at four lines at L = 80 - 56.683 = 23.317, so 23 mm.
    const { spec, notes } = fitSpecToPrinter(request, bed(80))
    expect(spec.speedsMmS).toEqual([150])
    expect(spec.linesPerSpeed).toBe(4)
    expect(spec.measuredLineMm).toBe(23)
    expect(notes).toEqual([
      'The 106 mm/s speed tier was removed so the coupon fits the configured bed. With one ' +
        'tier, the analysis cannot tell print and scan patterns apart from ringing.',
      'The lines per speed were reduced from 5 to 4 so the coupon fits the configured bed.',
      'The measured lines were shortened from 30 mm to 23 mm so the coupon fits the configured bed.',
    ])
    const g = isCouponGeometry(spec)
    expect(g.couponWidthMm).toBeLessThanOrEqual(80)
    expect(g.couponHeightMm).toBeLessThanOrEqual(80)
  })
  it('keeps an explicit line count through the length step and reports its reduction', () => {
    const { spec, notes } = fitSpecToPrinter({ ...request, linesPerSpeed: 8 }, bed(120))
    // Eight lines per tier need 134.806 mm even at 20 mm and seven need 124.806 mm; six lines
    // (field 27.5 mm, packed ramp 29.306 mm) fit at L = 120 - 94.806 = 25.194, so 25 mm.
    expect(spec.linesPerSpeed).toBe(6)
    expect(spec.measuredLineMm).toBe(25)
    expect(notes).toEqual([
      'The lines per speed were reduced from 8 to 6 so the coupon fits the configured bed.',
      'The measured lines were shortened from 30 mm to 25 mm so the coupon fits the configured bed.',
    ])
  })
  it('throws when the bed is genuinely too small even for one tier of three short lines', () => {
    expect(() => fitSpecToPrinter(request, bed(60))).toThrow(/does not fit/)
  })
})
