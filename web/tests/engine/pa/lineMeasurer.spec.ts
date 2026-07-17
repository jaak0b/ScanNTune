// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getCv } from '../../helpers/cv'
import { renderPaScan } from '../../helpers/paRender'
import { rgbaToBgrMat } from '../../../src/engine/imageData'
import { valueChannel } from '../../../src/engine/cvUtils'
import { alignPaCoupon } from '../../../src/engine/pa/fiducialAligner'
import { measureLineWidthProfile } from '../../../src/engine/pa/lineMeasurer'
import { defaultPaTestSpec, couponGeometry, paValueForLine } from '../../../src/engine/pa/types'

describe('measureLineWidthProfile', () => {
  const spec = defaultPaTestSpec()
  const g = couponGeometry(spec)

  it('recovers nominal width on the matching-PA line and a bulge on a wrong line', async () => {
    const cv = await getCv()
    const truePa = paValueForLine(spec, 8)
    const bgr = rgbaToBgrMat(cv, renderPaScan({ truePa, noiseSigma: 2 }))
    const gray = valueChannel(cv, bgr)
    try {
      const al = alignPaCoupon(cv, bgr, spec)
      expect(al.success).toBe(true)

      const uniform = measureLineWidthProfile(cv, gray, al, spec, 8)
      const widths = uniform.map((s) => s.widthMm).filter((w) => Number.isFinite(w))
      expect(widths.length).toBeGreaterThan(uniform.length * 0.9)
      const mean = widths.reduce((a, b) => a + b, 0) / widths.length
      expect(mean).toBeGreaterThan(spec.lineWidthMm * 0.7)
      expect(mean).toBeLessThan(spec.lineWidthMm * 1.3)
      // Uniform line: relative spread stays small.
      const sd = Math.sqrt(widths.reduce((a, b) => a + (b - mean) ** 2, 0) / widths.length)
      expect(sd / mean).toBeLessThan(0.12)

      // Line 0 has max PA error: width near the decel transition deviates.
      const bulgy = measureLineWidthProfile(cv, gray, al, spec, 0)
      const nearT2 = bulgy.filter((s) => Math.abs(s.xMm - g.transitionXsMm[1]) < 1.5)
      const peak = Math.max(...nearT2.map((s) => (Number.isFinite(s.widthMm) ? s.widthMm : 0)))
      expect(peak).toBeGreaterThan(mean * 1.3)
    } finally {
      bgr.delete()
      gray.delete()
    }
  }, 120000)

  it('measures nominal width when base ridges out-gradient the blurred line edges', async () => {
    // Glossy-scan model: scanner blur softens the line-edge gradient below the gradient of the
    // sharp specular infill ridges next to the line. A global gradient argmax locks onto the
    // ridge instead of the edge; the flank-bounded half-amplitude edge must not.
    const cv = await getCv()
    const truePa = paValueForLine(spec, 8)
    const bgr = rgbaToBgrMat(
      cv,
      renderPaScan({
        truePa,
        noiseSigma: 2,
        pxPerMm: 24,
        blurSigmaPx: 1.5,
        textureAmpGray: 90,
        ridgeExponent: 20,
        texturePitchMm: 0.7,
      }),
    )
    const gray = valueChannel(cv, bgr)
    try {
      const al = alignPaCoupon(cv, bgr, spec)
      expect(al.success).toBe(true)

      const uniform = measureLineWidthProfile(cv, gray, al, spec, 8)
      const widths = uniform.map((s) => s.widthMm).filter((w) => Number.isFinite(w))
      expect(widths.length).toBeGreaterThan(uniform.length * 0.9)
      const mean = widths.reduce((a, b) => a + b, 0) / widths.length
      expect(mean).toBeGreaterThan(spec.lineWidthMm * 0.7)
      expect(mean).toBeLessThan(spec.lineWidthMm * 1.3)
      const sd = Math.sqrt(widths.reduce((a, b) => a + (b - mean) ** 2, 0) / widths.length)
      expect(sd / mean).toBeLessThan(0.12)
    } finally {
      bgr.delete()
      gray.delete()
    }
  }, 120000)

  it('recovers nominal width with light lines on a dark base', async () => {
    const cv = await getCv()
    const truePa = paValueForLine(spec, 8)
    const bgr = rgbaToBgrMat(
      cv,
      renderPaScan({ truePa, noiseSigma: 2, baseGray: 40, lineGray: 220, backgroundGray: 245 }),
    )
    const gray = valueChannel(cv, bgr)
    try {
      const al = alignPaCoupon(cv, bgr, spec)
      expect(al.success).toBe(true)

      const uniform = measureLineWidthProfile(cv, gray, al, spec, 8)
      const widths = uniform.map((s) => s.widthMm).filter((w) => Number.isFinite(w))
      expect(widths.length).toBeGreaterThan(uniform.length * 0.9)
      const mean = widths.reduce((a, b) => a + b, 0) / widths.length
      expect(mean).toBeGreaterThan(spec.lineWidthMm * 0.7)
      expect(mean).toBeLessThan(spec.lineWidthMm * 1.3)
      // Uniform line: relative spread stays small.
      const sd = Math.sqrt(widths.reduce((a, b) => a + (b - mean) ** 2, 0) / widths.length)
      expect(sd / mean).toBeLessThan(0.12)

      // Line 0 has max PA error: width near the decel transition deviates.
      const bulgy = measureLineWidthProfile(cv, gray, al, spec, 0)
      const nearT2 = bulgy.filter((s) => Math.abs(s.xMm - g.transitionXsMm[1]) < 1.5)
      const peak = Math.max(...nearT2.map((s) => (Number.isFinite(s.widthMm) ? s.widthMm : 0)))
      expect(peak).toBeGreaterThan(mean * 1.3)
    } finally {
      bgr.delete()
      gray.delete()
    }
  }, 120000)
})
