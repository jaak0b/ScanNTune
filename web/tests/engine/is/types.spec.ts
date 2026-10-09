import { describe, expect, it } from 'vitest'
import { defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'
import type { PrinterProfile } from '../../../src/engine/gcode/profileTypes'
import {
  accelRampMm,
  bandTopWarning,
  defaultIsTestRequest,
  fitSpecToPrinter,
  followableRungCount,
  guaranteedBandTopHz,
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
    expect(request.speedsMmS).toEqual([90, 150])
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
  it('derives the tier ratio from the two-sided detection level, the speed-check power and the CI gate', () => {
    // exp((z_0.9995 + z_0.95) * 2 * 0.1 / z_0.975) with the AS 241 quantiles 3.290527,
    // 1.644854 and 1.959964: exp(4.935381 * 0.102043) = exp(0.503620) = 1.654700
    // (hand-derived).
    expect(TIER_SPEED_RATIO).toBeCloseTo(1.6547, 6)
  })
  it('pairs the line speed with the slower tier rounded down to a whole mm/s', () => {
    // 150 / 1.6547 = 90.65 -> 90; 34 / 1.6547 = 20.55 -> 20; 33 -> 19.94 -> 19.
    expect(speedTiersFor(150)).toEqual([90, 150])
    expect(speedTiersFor(34)).toEqual([20, 34])
    expect(speedTiersFor(33)).toEqual([19, 33])
  })
})

describe('validateIsSpec', () => {
  it('accepts the default request, its derived line count still open', () => {
    expect(() => validateIsSpec(request)).not.toThrow()
  })
  it('throws on zero or more than 2 speed tiers', () => {
    expect(() => validateIsSpec({ ...request, speedsMmS: [] })).toThrow(/speed tiers/)
    expect(() => validateIsSpec({ ...request, speedsMmS: [90, 150, 200] })).toThrow(
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
  it('accepts a slower tier below the 20 mm/s bottom rung, which the printer fit drops', () => {
    // The tiers of a 33 mm/s line speed: 33 / 1.6547 = 19.94 -> 19 mm/s.
    expect(() =>
      validateIsSpec({ ...request, cornerSpeedMmS: 20, speedsMmS: [19, 33] }),
    ).not.toThrow()
  })
  it('still refuses a line speed below 20 mm/s', () => {
    // The line speed is held to the corner speed, and the corner speed to the 20 mm/s floor.
    expect(() => validateIsSpec({ ...request, cornerSpeedMmS: 20, speedsMmS: [19] })).toThrow(
      'The line speed must be at least the 20 mm/s corner speed.',
    )
    expect(() => validateIsSpec({ ...request, cornerSpeedMmS: 19, speedsMmS: [19] })).toThrow(
      'The corner speed must be at least 20 mm/s',
    )
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

describe('bottom-dense ladder and derived lines per speed (bead followability on the slower tier)', () => {
  // The fastest followable corner was re-derived once by an independent scratch implementation
  // of the rule (Farouki and Neff offset regularity, R > w/2 = 0.21 mm, along the commanded
  // profile from the first traced sample, 200 Hz lateral ring, 20 Hz along-track ring, damping
  // 0.04): 29.2 mm/s leaves a smallest radius of 0.2104 mm, 29.3 mm/s 0.2090 mm.
  it('derives six lines per speed for the defaults, three of whose rungs stay followable', () => {
    const spec = fitted(request)
    expect(spec.followableCornerMmS).toBe(29.2)
    expect(spec.linesPerSpeed).toBe(6)
    expect(followableRungCount(spec, profile)).toBe(3)
    expect(guaranteedBandTopHz(spec, profile)).toBe(200)
  })
  it('spaces three rungs up to the followable corner and the rest up to the ladder top', () => {
    // Slow tier: 20 * (29.2 / 20)^(j / 2), then 29.2 * (90 / 29.2)^(k / 3) (hand-derived).
    const spec = fitted(request)
    const slow = ladderCornerSpeeds(spec, 90)
    ;[20, 24.16609, 29.2, 42.49483, 61.84282, 90].forEach((r, j) => expect(slow[j]).toBeCloseTo(r, 4))
    // Fast tier: the same bottom rungs, then 29.2 * (100 / 29.2)^(k / 3).
    const fast = ladderCornerSpeeds(spec, 150)
    ;[20, 24.16609, 29.2, 44.01377, 66.34287, 100].forEach((r, j) => expect(fast[j]).toBeCloseTo(r, 4))
  })
  it('keeps the three followable rungs at every line count of four or more', () => {
    for (let n = 4; n <= 7; n++) {
      const spec = { ...fitted(request), linesPerSpeed: n }
      expect(ladderCornerSpeeds(spec, 90).slice(0, 3)).toEqual(ladderCornerSpeeds(fitted(request), 90).slice(0, 3))
      expect(followableRungCount(spec, profile)).toBe(3)
    }
  })
  it('derives six lines for a wider bead, whose followable corner is lower', () => {
    const wide = { ...profile, nozzleDiameterMm: 0.6 }
    const spec = fitted(request, wide)
    expect(spec.followableCornerMmS).toBe(23.4)
    expect(spec.linesPerSpeed).toBe(6)
    expect(followableRungCount(spec, wide)).toBe(3)
  })
  it('never reports a corner that folds inside the band as followable up to 200 Hz', () => {
    // 0.4 mm nozzle at 1500 mm/s^2, 90 mm/s tier: a 21.2 mm/s corner follows a ring at 200 Hz but
    // folds from 129 to 193 Hz (checked once at every 1 Hz grid point by a scratch script), while
    // the 20 and 20.6 mm/s rungs follow the whole band.
    const p = { ...profile, printAccelMmS2: 1500 }
    const spec = fitted(defaultIsTestRequest(p), p)
    expect(guaranteedBandTopHz({ ...spec, followableCornerMmS: 21.2 }, p)).toBe(128)
    expect(spec.followableCornerMmS).toBeLessThan(21.2)
    expect(guaranteedBandTopHz(spec, p)).toBe(200)
  })
  it('designs the ladder at the reduced band top a low acceleration still reads, and names the acceleration', () => {
    // 1200 mm/s^2, 90 mm/s tier: the 20 mm/s bottom rung follows a ring at every 1 Hz grid point
    // up to 86 Hz and folds at 87 Hz (checked once by a scratch script), so the six-line ladder is
    // designed for a band ending at 86 Hz.
    const slow = { ...profile, printAccelMmS2: 1200 }
    const spec = fitted(defaultIsTestRequest(slow), slow)
    expect(spec.linesPerSpeed).toBe(6)
    expect(guaranteedBandTopHz(spec, slow)).toBe(86)
    expect(bandTopWarning(spec, slow)).toBe(
      'Raise the print acceleration to measure resonances up to 200 Hz. At 1200 mm/s^2, the ' +
        'lines follow ringing only up to 86 Hz.',
    )
    expect(bandTopWarning(fitted(request), profile)).toBeNull()
  })
  it('reports a coupon whose bottom rung folds already at 20 Hz as reading nothing', () => {
    // 500 mm/s^2: even the 20 mm/s bottom rung of the 90 mm/s tier folds at 20 Hz (checked once
    // by a scratch script).
    const slow = { ...profile, printAccelMmS2: 500 }
    const spec = fitted(defaultIsTestRequest(slow), slow)
    expect(guaranteedBandTopHz(spec, slow)).toBeNull()
    expect(bandTopWarning(spec, slow)).toBe(
      'Raise the print acceleration before printing this coupon. At 500 mm/s^2, the lines ' +
        'cannot follow ringing at any frequency from 20 to 200 Hz.',
    )
  })
})

describe('fitSpecToPrinter speed tiers', () => {
  const SLOW_TIER_NOTE =
    'The 19 mm/s speed tier was removed because it is slower than the 20 mm/s lowest corner ' +
    'speed. With one speed tier, the analysis cannot tell print and scan patterns apart from ' +
    'ringing. Raise the line speed to at least 34 mm/s to keep both speed tiers.'

  it('drops the slower tier of a 33 mm/s line speed, below the 20 mm/s bottom rung, and says so', () => {
    // 33 / 1.6547 = 19.94 -> 19 mm/s; the smallest line speed with a 20 mm/s slower tier
    // is ceil(20 * 1.6547) = ceil(33.09) = 34 mm/s.
    const { spec, notes } = fitSpecToPrinter(
      { ...request, cornerSpeedMmS: 20, speedsMmS: [19, 33] },
      profile,
    )
    expect(spec.speedsMmS).toEqual([33])
    expect(notes).toEqual([SLOW_TIER_NOTE])
  })
  it('keeps both tiers of a 34 mm/s line speed, whose slower tier is the 20 mm/s bottom rung', () => {
    const { spec, notes } = fitSpecToPrinter(
      { ...request, cornerSpeedMmS: 20, speedsMmS: [20, 34] },
      profile,
    )
    expect(spec.speedsMmS).toEqual([20, 34])
    expect(notes).toEqual([])
  })
  it('prints the same coupon as a one-tier request at the line speed', () => {
    // The followable corner and the line count are derived from the tier that remains.
    const dropped = fitted({ ...request, cornerSpeedMmS: 25, speedsMmS: [19, 33] })
    const oneTier = fitted({ ...request, cornerSpeedMmS: 25, speedsMmS: [33] })
    expect(dropped).toEqual(oneTier)
  })
  it('drops the tier once, before the bed fit, when the bed is small as well', () => {
    const smallBed = { ...profile, bedWidthMm: 70, bedDepthMm: 70 }
    const { spec, notes } = fitSpecToPrinter(
      { ...request, cornerSpeedMmS: 25, speedsMmS: [19, 33] },
      smallBed,
    )
    expect(spec.speedsMmS).toEqual([33])
    expect(notes[0]).toBe(SLOW_TIER_NOTE)
    expect(notes.filter((n) => n.includes('speed tier was removed'))).toHaveLength(1)
  })
})

describe('fitSpecToPrinter firmware fit', () => {
  it('leaves the default corner speed at 3000 mm/s^2', () => {
    // Klipper's centripetal cap over the 14 mm shortest run-up is 144.9 mm/s here.
    const { spec, notes } = fitSpecToPrinter(request, profile)
    expect(spec.cornerSpeedMmS).toBe(100)
    expect(notes).toEqual([])
  })

  it("caps a Klipper corner at the planner's centripetal junction limit over the shortest run-up", () => {
    // 1000 mm/s^2: the 150 mm/s tail widens the band to 1 + 11.25 + 1 + 1 = 14.25 mm, so the
    // shortest run-up move is 14.25 + 8 - 3 - 3 = 16.25 mm and the corner at most
    // sqrt(0.5 * 16.25 * 1000) = 90.14 mm/s, rounded down to 90.1 (hand-derived).
    const slow = { ...profile, printAccelMmS2: 1000 }
    const { spec, notes } = fitSpecToPrinter(defaultIsTestRequest(slow), slow)
    expect(spec.cornerSpeedMmS).toBe(90.1)
    expect(notes).toEqual([
      "The corner speed was limited to 90.1 mm/s because Klipper's centripetal junction " +
        'limit allows no faster corner after the 16.25 mm run-up at 1000 mm/s^2.',
    ])
  })
})

describe('fitSpecToPrinter bed fit', () => {
  const bed = (mm: number) => ({ ...profile, bedWidthMm: mm, bedDepthMm: mm })

  it('leaves the default request unchanged on the default 220 mm bed and on a 150 mm bed', () => {
    // The default coupon is 124.283 mm square (see the couponGeometry footprint test).
    for (const mm of [220, 150]) {
      const { spec, notes } = fitSpecToPrinter(request, bed(mm))
      expect(spec.speedsMmS).toEqual([90, 150])
      expect(spec.linesPerSpeed).toBe(6)
      expect(spec.measuredLineMm).toBe(30)
      expect(notes).toEqual([])
    }
  })
  it('shortens the measured lines first, to the longest length that fits', () => {
    // 120 mm bed: 124.283 - 30 + L <= 120 gives L <= 25.717, so 25 mm; both tiers and all
    // six lines stay, three of them followable.
    const { spec, notes } = fitSpecToPrinter(request, bed(120))
    expect(spec.speedsMmS).toEqual([90, 150])
    expect(spec.linesPerSpeed).toBe(6)
    expect(spec.measuredLineMm).toBe(25)
    expect(followableRungCount(spec, bed(120))).toBe(3)
    expect(notes).toEqual([
      'The measured lines were shortened from 30 mm to 25 mm so the coupon fits the configured bed.',
    ])
  })
  it('fits a front or back placement into the depth its edge margin leaves', () => {
    // Scan with the plate (front placement) on a 120 mm bed: 110 mm of depth remain. Six lines
    // need 114.283 mm even at 20 mm; five lines (field 22.5 mm) fit at
    // L = 110 - (114.283 - 30) = 25.717, so 25 mm.
    for (const placement of ['front', 'back'] as const) {
      const { spec, notes } = fitSpecToPrinter({ ...request, placement }, bed(120))
      expect(spec.linesPerSpeed).toBe(5)
      expect(spec.measuredLineMm).toBe(25)
      expect(notes).toEqual([
        'The lines per speed tier were reduced from 6 to 5 so the coupon fits the configured bed.',
        'The measured lines were shortened from 30 mm to 25 mm so the coupon fits the configured bed.',
      ])
    }
  })
  it('reduces the lines per speed once the shortest lines still overflow, removing upper rungs only', () => {
    // 100 mm bed: four lines (field 17.5 mm) fit at L = 25 mm. The removed lines are upper rungs:
    // the three followable bottom rungs stay, so the band top stays 200 Hz.
    const { spec, notes } = fitSpecToPrinter(request, bed(100))
    expect(spec.speedsMmS).toEqual([90, 150])
    expect(spec.linesPerSpeed).toBe(4)
    expect(spec.measuredLineMm).toBe(25)
    expect(ladderCornerSpeeds(spec, 90).slice(0, 3)).toEqual(ladderCornerSpeeds(fitted(request), 90).slice(0, 3))
    expect(followableRungCount(spec, bed(100))).toBe(3)
    expect(bandTopWarning(spec, bed(100))).toBeNull()
    expect(notes).toEqual([
      'The lines per speed tier were reduced from 6 to 4 so the coupon fits the configured bed.',
      'The measured lines were shortened from 30 mm to 25 mm so the coupon fits the configured bed.',
    ])
  })
  it('never reduces below the four-line followable floor: it drops the slower tier instead', () => {
    // 90 mm bed: two tiers at four lines need 94.283 mm even at 20 mm, and three lines would
    // lose the followable rungs, so the slower tier goes and the single tier keeps six lines.
    const { spec } = fitSpecToPrinter(request, bed(90))
    expect(spec.speedsMmS).toEqual([150])
    expect(spec.linesPerSpeed).toBe(6)
    expect(followableRungCount(spec, bed(90))).toBe(3)
  })
  it('drops the derived slower tier last, then reduces the single tier the same way', () => {
    // 80 mm bed: one 150 mm/s tier derives six lines and fits at four lines at L = 23 mm.
    const { spec, notes } = fitSpecToPrinter(request, bed(80))
    expect(spec.speedsMmS).toEqual([150])
    expect(spec.linesPerSpeed).toBe(4)
    expect(spec.measuredLineMm).toBe(23)
    expect(followableRungCount(spec, bed(80))).toBe(3)
    expect(notes).toEqual([
      'The 90 mm/s speed tier was removed so the coupon fits the configured bed. With one ' +
        'speed tier, the analysis cannot tell print and scan patterns apart from ringing.',
      'The lines per speed tier were reduced from 6 to 4 so the coupon fits the configured bed.',
      'The measured lines were shortened from 30 mm to 23 mm so the coupon fits the configured bed.',
    ])
    const g = isCouponGeometry(spec)
    expect(g.couponWidthMm).toBeLessThanOrEqual(80)
    expect(g.couponHeightMm).toBeLessThanOrEqual(80)
  })
  it('throws when the bed is genuinely too small even for one tier of four short lines', () => {
    // One tier of four lines at 20 mm is 76.683 mm square.
    expect(() => fitSpecToPrinter(request, bed(75))).toThrow(/does not fit/)
  })
})
