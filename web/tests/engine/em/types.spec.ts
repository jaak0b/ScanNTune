import { describe, expect, it } from 'vitest'
import { defaultPrinterProfile } from '../../../src/engine/pa/types'
import {
  accelRampMm,
  defaultEmTestSpec,
  emCouponGeometry,
  pitchForBlock,
  volumetricFlowMm3S,
} from '../../../src/engine/em/types'

describe('defaultEmTestSpec', () => {
  it('derives widths and pitch range from the nozzle', () => {
    const spec = defaultEmTestSpec(defaultPrinterProfile()) // 0.4 nozzle
    expect(spec.nominalLineWidthMm).toBeCloseTo(0.42, 5)
    expect(spec.pitchMinMm).toBeCloseTo(1.14, 2)
    expect(spec.pitchMaxMm).toBeCloseTo(1.35, 2)
    expect(spec.blockCount).toBe(9)
    expect(spec.linesPerBlock).toBe(5)
    expect(spec.lineLengthMm).toBe(25)
    expect(spec.printSpeedMmS).toBeGreaterThan(0)
    expect(spec.placement).toBe('center')
    expect(spec.contrastBase).toBe(false)
  })
  it('scales for a 0.6 nozzle', () => {
    const p = { ...defaultPrinterProfile(), nozzleDiameterMm: 0.6 }
    const spec = defaultEmTestSpec(p)
    expect(spec.nominalLineWidthMm).toBeCloseTo(0.63, 5)
    // Every gap stays at or above the 0.65 mm through-depth readability floor, with 15%
    // over-extrusion headroom on the bead width.
    expect(spec.pitchMinMm - 1.15 * spec.nominalLineWidthMm).toBeGreaterThanOrEqual(0.65)
    expect(spec.pitchMaxMm).toBeGreaterThan(spec.pitchMinMm)
  })
  it('keeps the tightest gap at or above the readable floor for a 0.4 nozzle', () => {
    const spec = defaultEmTestSpec(defaultPrinterProfile())
    expect(spec.pitchMinMm - 1.15 * spec.nominalLineWidthMm).toBeGreaterThanOrEqual(0.65)
  })
})

describe('pitchForBlock', () => {
  it('is linear from pitchMin to pitchMax inclusive', () => {
    const spec = defaultEmTestSpec(defaultPrinterProfile())
    expect(pitchForBlock(spec, 0)).toBeCloseTo(spec.pitchMinMm, 9)
    expect(pitchForBlock(spec, spec.blockCount - 1)).toBeCloseTo(spec.pitchMaxMm, 9)
    const step = pitchForBlock(spec, 1) - pitchForBlock(spec, 0)
    expect(pitchForBlock(spec, 2) - pitchForBlock(spec, 1)).toBeCloseTo(step, 9)
  })
})

describe('emCouponGeometry', () => {
  const spec = defaultEmTestSpec(defaultPrinterProfile())
  const g = emCouponGeometry(spec)
  it('lays out the requested number of blocks in both rows', () => {
    expect(g.topRow).toHaveLength(spec.blockCount)
    expect(g.bottomRow).toHaveLength(spec.blockCount)
    for (const b of g.topRow) expect(b.lineXsMm).toHaveLength(spec.linesPerBlock)
  })
  it('mirrors the bottom row pitch order', () => {
    expect(g.bottomRow[0].pitchMm).toBeCloseTo(g.topRow[g.topRow.length - 1].pitchMm, 9)
    expect(g.bottomRow[g.bottomRow.length - 1].pitchMm).toBeCloseTo(g.topRow[0].pitchMm, 9)
  })
  it('spaces lines inside a block exactly at the block pitch', () => {
    const b = g.topRow[3]
    for (let j = 1; j < b.lineXsMm.length; j++) {
      expect(b.lineXsMm[j] - b.lineXsMm[j - 1]).toBeCloseTo(b.pitchMm, 9)
    }
  })
  it('keeps all lines inside the frame window', () => {
    for (const row of [g.topRow, g.bottomRow]) {
      for (const b of row) {
        expect(b.lineXsMm[0]).toBeGreaterThan(g.frameBandMm)
        expect(b.lineXsMm[b.lineXsMm.length - 1]).toBeLessThan(g.couponWidthMm - g.frameBandMm)
      }
    }
  })
  it('places three fiducials and leaves the origin corner empty', () => {
    expect(g.fiducials).toHaveLength(3)
    const nearOrigin = g.fiducials.filter((f) => f.xMm < 20 && f.yMm < 20)
    expect(nearOrigin).toHaveLength(0)
  })
  it('stacks rows and rail without overlap', () => {
    expect(g.topRowY1Mm).toBeLessThanOrEqual(g.railY0Mm)
    expect(g.railY1Mm).toBeLessThanOrEqual(g.bottomRowY0Mm)
    expect(g.bottomRowY1Mm).toBeCloseTo(g.couponHeightMm - g.frameBandMm, 9)
  })
})

describe('warning helpers', () => {
  it('computes volumetric flow as speed * width * layer height', () => {
    const spec = { ...defaultEmTestSpec(defaultPrinterProfile()), printSpeedMmS: 100 }
    expect(volumetricFlowMm3S(spec, 0.2)).toBeCloseTo(100 * spec.nominalLineWidthMm * 0.2, 9)
  })
  it('computes the acceleration ramp distance v^2 / (2a)', () => {
    expect(accelRampMm(100, 5000)).toBeCloseTo(1.0, 9)
  })
})
