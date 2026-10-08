// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getCv } from '../../helpers/cv'
import { renderPaScan } from '../../helpers/paRender'
import { rgbaToBgrMat } from '../../../src/engine/imageData'
import { analyzePaCoupon } from '../../../src/engine/pa/paAnalyzer'
import { generatePaGcode } from '../../../src/engine/pa/gcodeGenerator'
import { smoothTimeCorrection, sweepCorrection } from '../../../src/engine/pa/paCorrectionFormatter'
import {
  defaultFilamentProfile,
  defaultPaTestSpec,
  defaultPrinterProfile,
  defaultSmoothTimeTestSpec,
  paValueForLine,
} from '../../../src/engine/pa/types'

describe('defaultSmoothTimeTestSpec', () => {
  it('sweeps 0.01 to 0.06 s with the given fixed advance', () => {
    const spec = defaultSmoothTimeTestSpec(0.03)
    expect(spec.sweep).toBe('smoothTime')
    expect(spec.fixedAdvance).toBe(0.03)
    expect(spec.paStart).toBe(0.01)
    expect(spec.paEnd).toBe(0.06)
    expect(paValueForLine(spec, 0)).toBe(0.01)
    expect(paValueForLine(spec, spec.lineCount - 1)).toBe(0.06)
  })
})

describe('generatePaGcode smooth time sweep', () => {
  const profile = defaultPrinterProfile()
  const filament = defaultFilamentProfile()
  const spec = defaultSmoothTimeTestSpec(0.03)

  it('emits one SET_PRESSURE_ADVANCE with fixed advance and stepped smooth time per line', () => {
    const g = generatePaGcode(profile, filament, spec)
    for (let i = 0; i < spec.lineCount; i++) {
      const v = paValueForLine(spec, i)
      expect(g).toContain(`SET_PRESSURE_ADVANCE ADVANCE=0.0300 SMOOTH_TIME=${v.toFixed(4)}`)
    }
  })

  it('primes at the Klipper default smooth time with the fixed advance', () => {
    const g = generatePaGcode(profile, filament, spec)
    expect(g).toContain('SET_PRESSURE_ADVANCE ADVANCE=0.0300 SMOOTH_TIME=0.0400')
  })

  it('throws when the fixed advance is missing', () => {
    expect(() =>
      generatePaGcode(profile, filament, { ...spec, fixedAdvance: undefined }),
    ).toThrow(/fixedAdvance/)
  })
})

describe('smoothTimeCorrection', () => {
  it('formats the Klipper command and printer.cfg line', () => {
    const c = smoothTimeCorrection(0.03, 0.0351)
    expect(c.code).toBe('SET_PRESSURE_ADVANCE ADVANCE=0.0300 SMOOTH_TIME=0.0351')
    expect(c.secondaryCode).toBe('pressure_advance_smooth_time: 0.0351')
    expect(c.secondaryCaption).toBe('printer.cfg')
  })
})

describe('sweepCorrection', () => {
  it('picks the smooth time correction for a smoothTime sweep', () => {
    const c = sweepCorrection(defaultSmoothTimeTestSpec(0.03), 0.0351)
    expect(c.code).toBe('SET_PRESSURE_ADVANCE ADVANCE=0.0300 SMOOTH_TIME=0.0351')
  })

  it('picks the pressure advance correction for an advance sweep', () => {
    const c = sweepCorrection(defaultPaTestSpec(), 0.0312)
    expect(c.code).toBe('SET_PRESSURE_ADVANCE ADVANCE=0.0312')
  })

  it('throws when a smoothTime sweep has no fixed advance', () => {
    const spec = { ...defaultSmoothTimeTestSpec(0.03), fixedAdvance: undefined }
    expect(() => sweepCorrection(spec, 0.035)).toThrow(/fixedAdvance/)
  })
})

describe('analyzePaCoupon on a smooth-time render', () => {
  it('recovers the true smooth time within one sweep step', async () => {
    const truePa = 0.03
    const trueSmoothTime = 0.035
    const spec = defaultSmoothTimeTestSpec(truePa)
    const step = (spec.paEnd - spec.paStart) / (spec.lineCount - 1)
    const cv = await getCv()
    const bgr = rgbaToBgrMat(cv, renderPaScan({ spec, truePa, trueSmoothTime, pxPerMm: 24 }))
    try {
      const r = analyzePaCoupon(cv, bgr, spec)
      expect(r.success).toBe(true)
      expect(r.lines).toHaveLength(spec.lineCount)
      expect(Math.abs((r.bestPa as number) - trueSmoothTime)).toBeLessThan(step)
    } finally {
      bgr.delete()
    }
  }, 180000)
})
