import { describe, expect, it } from 'vitest'
import {
  defaultFilamentProfile,
  defaultPrinterProfile,
  defaultPaTestSpec,
  paValueForLine,
  couponGeometry,
  edgeShiftRange,
  fitsA4,
  maxLineCountForHeight,
} from '../../../src/engine/pa/types'

describe('pa types', () => {
  it('steps PA linearly across lines', () => {
    const spec = defaultPaTestSpec()
    expect(paValueForLine(spec, 0)).toBeCloseTo(spec.paStart, 10)
    expect(paValueForLine(spec, spec.lineCount - 1)).toBeCloseTo(spec.paEnd, 10)
    expect(paValueForLine(spec, 5) - paValueForLine(spec, 4)).toBeCloseTo(
      (spec.paEnd - spec.paStart) / (spec.lineCount - 1),
      10,
    )
  })

  it('derives coupon geometry containing all lines plus margin', () => {
    const spec = defaultPaTestSpec()
    const g = couponGeometry(spec)
    const lineLen = 2 * spec.slowSegmentMm + spec.fastSegmentMm
    expect(g.baseWidthMm).toBeCloseTo(lineLen + 2 * spec.marginMm, 10)
    expect(g.baseHeightMm).toBeCloseTo((spec.lineCount - 1) * spec.linePitchMm + 2 * spec.marginMm, 10)
    // three fiducial holes, none at the origin corner (min-x, min-y)
    expect(g.fiducials).toHaveLength(3)
    const originX = g.fiducialInsetMm + g.fiducialSizeMm / 2
    const originY = g.fiducialInsetMm + g.fiducialSizeMm / 2
    for (const f of g.fiducials) {
      expect(f.xMm === originX && f.yMm === originY).toBe(false)
    }
    // transitions sit at slow/fast boundaries in line-local x
    expect(g.transitionXsMm).toEqual([spec.slowSegmentMm, spec.slowSegmentMm + spec.fastSegmentMm])
  })

  it('provides sane printer defaults with one default filament', () => {
    const p = defaultPrinterProfile()
    expect(p.firmware).toBe('Klipper')
    expect(p.nozzleDiameterMm).toBeCloseTo(0.4)
    expect(p.bedWidthMm).toBeGreaterThan(100)
    expect(p.filaments).toHaveLength(1)
    expect(p.selectedFilamentId).toBeNull()
    expect(p.filaments[0]).toEqual(defaultFilamentProfile())
  })

  it('provides sane filament defaults', () => {
    const f = defaultFilamentProfile()
    expect(f.name).toBe('Default')
    expect(f.filamentType).toBe('PLA')
    expect(f.filamentDiameterMm).toBeCloseTo(1.75)
    expect(f.nozzleTempC).toBe(210)
    expect(f.bedTempC).toBe(60)
    expect(f.chamberTempC).toBe(0)
  })

  describe('edgeShiftRange', () => {
    it('returns null when the best line is not null but sits mid-sweep', () => {
      const spec = defaultPaTestSpec()
      const mid = Math.floor(spec.lineCount / 2)
      expect(edgeShiftRange(spec, mid)).toBeNull()
    })

    it('returns null when there is no best line', () => {
      expect(edgeShiftRange(defaultPaTestSpec(), null)).toBeNull()
    })

    it('shifts the range around the first line when it is the optimum', () => {
      // A non-zero paStart, so the shifted range differs from the current one (see the
      // bottom-edge clamp refinement case below for paStart already at 0).
      const spec = { ...defaultPaTestSpec(), paStart: 0.02, paEnd: 0.08 }
      const shift = edgeShiftRange(spec, 0)
      expect(shift).not.toBeNull()
      const range = spec.paEnd - spec.paStart
      const centre = paValueForLine(spec, 0)
      expect(shift!.start).toBeCloseTo(Math.max(0, centre - range / 2), 10)
      expect(shift!.end - shift!.start).toBeCloseTo(range, 10)
    })

    it('shifts the range around the last line when it is the optimum', () => {
      const spec = defaultPaTestSpec()
      const shift = edgeShiftRange(spec, spec.lineCount - 1)
      expect(shift).not.toBeNull()
      const range = spec.paEnd - spec.paStart
      const centre = paValueForLine(spec, spec.lineCount - 1)
      expect(shift!.start).toBeCloseTo(Math.max(0, centre - range / 2), 10)
      expect(shift!.end - shift!.start).toBeCloseTo(range, 10)
    })

    it('derives from the spec passed in, not any external live state', () => {
      const analyzedSpec = { ...defaultPaTestSpec(), paStart: 0.02, paEnd: 0.08, lineCount: 5 }
      const shift = edgeShiftRange(analyzedSpec, 0)
      expect(shift).toEqual({ start: 0, end: 0.06 })
    })

    it('returns a narrowing refinement when the shifted range would be a no-op (bottom-edge clamp)', () => {
      const spec = { ...defaultPaTestSpec(), paStart: 0, paEnd: 0.06 }
      const shift = edgeShiftRange(spec, 0)
      expect(shift).toEqual({ start: 0, end: 0.03 })
    })
  })

  describe('fitsA4', () => {
    it('fits when within portrait A4', () => {
      expect(fitsA4(200, 280)).toBe(true)
    })

    it('fits when within landscape A4 (orientation-agnostic)', () => {
      expect(fitsA4(280, 200)).toBe(true)
    })

    it('fits exactly at the A4 boundary', () => {
      expect(fitsA4(210, 297)).toBe(true)
      expect(fitsA4(297, 210)).toBe(true)
    })

    it('does not fit when both dimensions exceed either A4 orientation', () => {
      expect(fitsA4(96, 400)).toBe(false)
    })

    it('does not fit when width exceeds both orientations', () => {
      expect(fitsA4(300, 100)).toBe(false)
    })
  })

  describe('maxLineCountForHeight', () => {
    it('inverts baseHeightMm = (n-1)*linePitchMm + 2*marginMm', () => {
      const spec = defaultPaTestSpec()
      const maxHeight = 297
      const n = maxLineCountForHeight(spec, maxHeight)
      const g = { ...spec, lineCount: n }
      expect(couponGeometry(g).baseHeightMm).toBeLessThanOrEqual(maxHeight)
      const gPlusOne = { ...spec, lineCount: n + 1 }
      expect(couponGeometry(gPlusOne).baseHeightMm).toBeGreaterThan(maxHeight)
    })

    it('matches the analytic formula', () => {
      const spec = defaultPaTestSpec()
      const maxHeight = 297
      const expected = Math.floor((maxHeight - 2 * spec.marginMm) / spec.linePitchMm) + 1
      expect(maxLineCountForHeight(spec, maxHeight)).toBe(expected)
    })
  })
})
