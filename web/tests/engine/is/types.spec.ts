import { describe, expect, it } from 'vitest'
import { defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'
import {
  accelRampMm,
  defaultIsTestSpec,
  fitSpecToBed,
  rampWarnings,
  validateIsSpec,
} from '../../../src/engine/is/types'
import { isCouponGeometry } from '../../../src/engine/is/couponGeometry'

describe('defaultIsTestSpec', () => {
  it('uses the documented defaults', () => {
    const spec = defaultIsTestSpec(defaultPrinterProfile())
    expect(spec.speedsMmS).toEqual([150])
    expect(spec.linesPerSpeed).toBe(5)
    // Five wavelengths of the 25 Hz lowest resonance of interest at the 150 mm/s tier:
    // 5 * 150 / 25 = 30 mm.
    expect(spec.measuredLineMm).toBe(30)
    expect(spec.runUpMm).toBe(8)
    expect(spec.linePitchMm).toBe(2.5)
    expect(spec.axes).toEqual(['x', 'y'])
    expect(spec.cornerSpeedMmS).toBe(100)
    expect(spec.weldMm).toBe(1)
    expect(spec.placement).toBe('center')
    expect(spec.contrastBase).toBe(false)
  })
  it('floors the profile acceleration at the low-signal threshold and never caps it', () => {
    // The floor equals the low-acceleration warning threshold, so a default spec never
    // starts inside its own warning zone.
    const p = defaultPrinterProfile()
    expect(defaultIsTestSpec({ ...p, printAccelMmS2: 2000 }).accelMmS2).toBe(4000)
    expect(rampWarnings(defaultIsTestSpec({ ...p, printAccelMmS2: 2000 }))).toEqual([])
    expect(defaultIsTestSpec({ ...p, printAccelMmS2: 20000 }).accelMmS2).toBe(20000)
    expect(defaultIsTestSpec({ ...p, printAccelMmS2: 4500 }).accelMmS2).toBe(4500)
  })
})

describe('validateIsSpec', () => {
  const spec = defaultIsTestSpec(defaultPrinterProfile())
  it('accepts the default spec', () => {
    expect(() => validateIsSpec(spec)).not.toThrow()
  })
  it('throws on zero or more than 3 speed tiers', () => {
    expect(() => validateIsSpec({ ...spec, speedsMmS: [] })).toThrow(/speed tiers/)
    expect(() => validateIsSpec({ ...spec, speedsMmS: [150, 200, 250, 300] })).toThrow(
      /speed tiers/,
    )
    expect(() => validateIsSpec({ ...spec, speedsMmS: [150] })).not.toThrow()
  })
  it('throws on non-positive values', () => {
    expect(() => validateIsSpec({ ...spec, speedsMmS: [0] })).toThrow(/positive/)
    expect(() => validateIsSpec({ ...spec, runUpMm: -1 })).toThrow(/positive/)
    expect(() => validateIsSpec({ ...spec, linePitchMm: 0 })).toThrow(/positive/)
    expect(() => validateIsSpec({ ...spec, accelMmS2: 0 })).toThrow(/positive/)
    expect(() => validateIsSpec({ ...spec, weldMm: 0 })).toThrow(/positive/)
  })
  it('throws when the corner speed sits below the 20 mm/s floor', () => {
    expect(() => validateIsSpec({ ...spec, cornerSpeedMmS: 19 })).toThrow(/at least 20 mm\/s/)
    expect(() =>
      validateIsSpec({ ...spec, cornerSpeedMmS: 20, speedsMmS: [20] }),
    ).not.toThrow()
  })
  it('throws when a speed tier sits below the corner speed', () => {
    // A slower tier caps the planner's corner junction at the tier cruise speed, so the
    // configured corner speed would never be reached.
    expect(() => validateIsSpec({ ...spec, speedsMmS: [99] })).toThrow(/corner speed/)
    expect(() => validateIsSpec({ ...spec, speedsMmS: [150, 99] })).toThrow(/corner speed/)
    expect(() => validateIsSpec({ ...spec, speedsMmS: [150, 200] })).not.toThrow()
  })
  it('throws on lines per speed outside 3 to 6', () => {
    expect(() => validateIsSpec({ ...spec, linesPerSpeed: 2 })).toThrow(/Lines per speed/)
    expect(() => validateIsSpec({ ...spec, linesPerSpeed: 7 })).toThrow(/Lines per speed/)
  })
  it('throws when the clean read length is shorter than the 20 mm floor', () => {
    expect(() => validateIsSpec({ ...spec, measuredLineMm: 19 })).toThrow(/at least 20 mm/)
    expect(() => validateIsSpec({ ...spec, measuredLineMm: 20 })).not.toThrow()
  })
  it('throws on empty axes', () => {
    expect(() => validateIsSpec({ ...spec, axes: [] })).toThrow(/axis/)
  })
})

describe('rampWarnings', () => {
  const spec = defaultIsTestSpec(defaultPrinterProfile())
  it('is silent at a healthy acceleration', () => {
    expect(rampWarnings({ ...spec, accelMmS2: 4000 })).toEqual([])
  })
  it('warns when the acceleration is below 4000 mm/s^2', () => {
    const warnings = rampWarnings({ ...spec, accelMmS2: 3000 })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Low acceleration')
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
    // At 2000 mm/s^2 the 300 mm/s tier needs a long ramp past the corner; the
    // geometry allocates it in front of the clean read length, so only the
    // low-acceleration warning fires (the 8 mm run-up still hosts its 2.5 mm ramp to
    // the corner speed).
    const warnings = rampWarnings({ ...spec, accelMmS2: 2000, speedsMmS: [150, 300] })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Low acceleration')
  })
  it('computes the ramp distance v^2 / (2a)', () => {
    expect(accelRampMm(100, 5000)).toBeCloseTo(1.0, 9)
  })
})

describe('fitSpecToBed', () => {
  const spec = defaultIsTestSpec(defaultPrinterProfile())
  it('leaves the default spec unchanged on the default 220 mm bed and on a 120 mm bed', () => {
    for (const bed of [220, 120]) {
      const p = { ...defaultPrinterProfile(), bedWidthMm: bed, bedDepthMm: bed }
      const { spec: fitted, notes } = fitSpecToBed(spec, p)
      expect(fitted).toEqual(spec)
      expect(notes).toEqual([])
    }
  })
  it('drops the fastest tier before shortening lines', () => {
    // A three-tier variant overflows a 120 mm bed; dropping the 300 mm/s tier shrinks the
    // field, the packed diagonal, and the band, back onto it at full read length.
    const three = { ...spec, speedsMmS: [150, 200, 300] }
    const p = { ...defaultPrinterProfile(), bedWidthMm: 120, bedDepthMm: 120 }
    const { spec: fitted, notes } = fitSpecToBed(three, p)
    expect(fitted.speedsMmS).toEqual([150, 200])
    expect(fitted.measuredLineMm).toBe(30)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('300 mm/s')
  })
  it('shortens the clean read length when tiers cannot be dropped, maximally', () => {
    // The default spec already has a single tier, so only the line shortening can act.
    const long = { ...spec, measuredLineMm: 60 }
    const p = { ...defaultPrinterProfile(), bedWidthMm: 110, bedDepthMm: 110 }
    const { spec: fitted, notes } = fitSpecToBed(long, p)
    expect(fitted.speedsMmS).toEqual([150])
    expect(fitted.measuredLineMm).toBeLessThan(60)
    expect(fitted.measuredLineMm).toBeGreaterThanOrEqual(20)
    expect(notes).toHaveLength(1)
    const g = isCouponGeometry(fitted)
    expect(g.couponWidthMm).toBeLessThanOrEqual(110)
    expect(g.couponHeightMm).toBeLessThanOrEqual(110)
    // The solved length is maximal: one more millimetre would overflow the bed.
    const g1 = isCouponGeometry({ ...fitted, measuredLineMm: fitted.measuredLineMm + 1 })
    expect(Math.max(g1.couponWidthMm, g1.couponHeightMm)).toBeGreaterThan(110)
  })
  it('never shortens below the 20 mm floor and throws when the bed is genuinely too small', () => {
    const p = { ...defaultPrinterProfile(), bedWidthMm: 75, bedDepthMm: 75 }
    expect(() => fitSpecToBed(spec, p)).toThrow(/does not fit/)
  })
})
