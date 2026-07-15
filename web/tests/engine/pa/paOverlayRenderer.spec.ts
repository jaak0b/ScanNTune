// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getCv } from '../../helpers/cv'
import { renderPaScan } from '../../helpers/paRender'
import { rgbaToBgrMat } from '../../../src/engine/imageData'
import { alignPaCoupon } from '../../../src/engine/pa/fiducialAligner'
import { renderPaOverlayMat } from '../../../src/engine/pa/paOverlayRenderer'
import { couponGeometry, defaultPaTestSpec, paValueForLine } from '../../../src/engine/pa/types'
import type { PaLineScore, PaResult } from '../../../src/engine/pa/types'

describe('renderPaOverlayMat', () => {
  const spec = defaultPaTestSpec()

  const syntheticResult = (): PaResult => {
    const lines: PaLineScore[] = []
    for (let i = 0; i < spec.lineCount; i++) {
      lines.push({
        index: i,
        paValue: paValueForLine(spec, i),
        score: i === 2 ? Infinity : Math.abs(i - 5) * 0.01,
        medianWidthMm: i === 2 ? NaN : 0.45,
        measured: i !== 2,
      })
    }
    return {
      success: true,
      failureReason: null,
      lines,
      bestLineIndex: 5,
      bestPa: paValueForLine(spec, 5),
      sweepBracket: 'bracketed',
      sePa: 0.001,
      measuredPxPerMm: 24,
      flipped: false,
      rotationQuarterTurns: 0,
    }
  }

  it('renders the overlay cropped to the coupon outline plus a small margin', async () => {
    const cv = await getCv()
    const bgr = rgbaToBgrMat(cv, renderPaScan({ truePa: 0.02 }))
    let overlay = null
    try {
      const alignment = alignPaCoupon(cv, bgr, spec)
      expect(alignment.success).toBe(true)
      overlay = renderPaOverlayMat(cv, bgr, alignment, spec, syntheticResult())
      // The synthetic scan has a 6 mm border around the coupon, so the crop must shrink the frame
      // but still cover the coupon itself.
      expect(overlay.cols).toBeLessThan(bgr.cols)
      expect(overlay.rows).toBeLessThan(bgr.rows)
      const g = couponGeometry(spec)
      const scale = Math.hypot(alignment.a, alignment.c)
      expect(overlay.cols).toBeGreaterThanOrEqual(Math.floor(g.baseWidthMm * scale))
      expect(overlay.rows).toBeGreaterThanOrEqual(Math.floor(g.baseHeightMm * scale))
      expect(overlay.channels()).toBe(3)
      // The crop must be a continuous Mat: a ROI clone() can keep the parent's row stride,
      // which misaligns every flat `data` read (and the ImageData handed to the UI).
      expect(overlay.isContinuous()).toBe(true)
      expect((overlay.data as Uint8Array).length).toBe(overlay.rows * overlay.cols * 3)
    } finally {
      overlay?.delete()
      bgr.delete()
    }
  }, 60000)
})
