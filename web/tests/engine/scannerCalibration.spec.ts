import { describe, it, expect } from 'vitest'
import {
  correctionFactor,
  effectiveDpi,
  isotropicPxPerMm,
  referenceAlongDirection,
  scaleReferenceAtDpi,
} from '../../src/engine/scannerCalibration'
import type { ScannerCalibration } from '../../src/engine/types'

// Mirrors the PxPerMmAtDpi_AppliesScannerErrorAtAnyDpi case in ScanNTune.Tests/CalibrationStoreTests.cs.
describe('scanner calibration', () => {
  it('applies the scanner error at any DPI', () => {
    const cal: ScannerCalibration = {
      pxPerMm: 23.5969,
      dpi: 600,
      referenceMm: 85.5,
      measuredWidthPx: 2017.5,
      straightnessPx: 0.3,
      parallelismDegrees: 0.002,
      calibratedUtc: '2026-07-02T12:00:00.000Z',
    }
    const factor = 23.5969 / (600.0 / 25.4)

    expect(Math.abs(correctionFactor(cal) - factor)).toBeLessThanOrEqual(1e-12)
    expect(Math.abs((scaleReferenceAtDpi(cal, 600) as number) - 23.5969)).toBeLessThanOrEqual(1e-9)
    expect(Math.abs((scaleReferenceAtDpi(cal, 1200) as number) - (1200.0 / 25.4) * factor)).toBeLessThanOrEqual(1e-9)
    expect(Math.abs(effectiveDpi(cal) - 23.5969 * 25.4)).toBeLessThanOrEqual(1e-9)
  })
})

describe('scale reference', () => {
  const cal: ScannerCalibration = {
    pxPerMm: 23.86, // ~+1% over 600 dpi nominal, a typical CCD sensor-axis error
    dpi: 600,
    referenceMm: 85.5,
    measuredWidthPx: 2040.03,
    straightnessPx: 0.3,
    parallelismDegrees: 0.002,
    calibratedUtc: '2026-07-10T12:00:00.000Z',
  }
  const nominal = 600 / 25.4

  it('a CIS calibration (and a legacy one without the field) stays a scalar on both axes', () => {
    expect(scaleReferenceAtDpi(cal, 600)).toBeCloseTo(23.86, 9)
    expect(scaleReferenceAtDpi({ ...cal, scannerType: 'CIS' }, 600)).toBeCloseTo(23.86, 9)
  })

  it('a CCD calibration corrects the horizontal axis only (also when the axis field is absent)', () => {
    const ref = scaleReferenceAtDpi({ ...cal, scannerType: 'CCD' }, 600)
    expect(ref).toEqual({ horizontal: expect.closeTo(23.86, 9), vertical: expect.closeTo(nominal, 9) })
    const explicit = scaleReferenceAtDpi({ ...cal, scannerType: 'CCD', measuredAxis: 'horizontal' }, 600)
    expect(explicit).toEqual(ref)
  })

  it('a CCD calibration measured along the vertical axis corrects that axis instead', () => {
    const ref = scaleReferenceAtDpi({ ...cal, scannerType: 'CCD', measuredAxis: 'vertical' }, 600)
    expect(ref).toEqual({ horizontal: expect.closeTo(nominal, 9), vertical: expect.closeTo(23.86, 9) })
  })

  it('a CCD calibration scales both axis figures to another DPI', () => {
    const ref = scaleReferenceAtDpi({ ...cal, scannerType: 'CCD' }, 300)
    expect(typeof ref).not.toBe('number')
    if (typeof ref !== 'number') {
      expect(ref.horizontal).toBeCloseTo(23.86 / 2, 9)
      expect(ref.vertical).toBeCloseTo(nominal / 2, 9)
    }
  })

  it('the effective px/mm along a direction interpolates the axes through the inverse metric', () => {
    const ref = { horizontal: 24, vertical: 23 }
    // Along the pure axes it is the axis figure itself; a scalar passes through unchanged.
    expect(referenceAlongDirection(ref, 1, 0)).toBeCloseTo(24, 12)
    expect(referenceAlongDirection(ref, 0, -5)).toBeCloseTo(23, 12)
    expect(referenceAlongDirection(23.5, 3, 4)).toBeCloseTo(23.5, 12)
    // At 45 degrees: |u| / |S^-1 u| with S = diag(24, 23).
    const expected = Math.SQRT2 / Math.hypot(1 / 24, 1 / 23)
    expect(referenceAlongDirection(ref, 1, 1)).toBeCloseTo(expected, 12)
    // The direction's length must not matter.
    expect(referenceAlongDirection(ref, 10, 10)).toBeCloseTo(expected, 12)
  })

  it('the isotropic equivalent of a pair is the geometric mean', () => {
    expect(isotropicPxPerMm(23.5)).toBeCloseTo(23.5, 12)
    expect(isotropicPxPerMm({ horizontal: 24, vertical: 23 })).toBeCloseTo(Math.sqrt(24 * 23), 12)
  })
})
