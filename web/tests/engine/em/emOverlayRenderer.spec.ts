// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getCv } from '../../helpers/cv'
import { renderEmScan } from '../../helpers/emRender'
import { rgbaToBgrMat } from '../../../src/engine/imageData'
import { alignEmCoupon } from '../../../src/engine/em/fiducialAligner'
import type { EmAlignment } from '../../../src/engine/em/fiducialAligner'
import { analyzeEmCoupon } from '../../../src/engine/em/emAnalyzer'
import { renderEmOverlayMat } from '../../../src/engine/em/emOverlayRenderer'
import { defaultEmTestSpec, emCouponGeometry } from '../../../src/engine/em/types'
import { defaultPrinterProfile } from '../../../src/engine/pa/types'

describe('renderEmOverlayMat', () => {
  const spec = defaultEmTestSpec(defaultPrinterProfile())
  // At the 600 dpi class resolution the analyzer's measurement resolution gate accepts.
  const PX_PER_MM = 24

  it(
    'renders the overlay cropped to the coupon outline plus a small margin',
    async () => {
      const cv = await getCv()
      const bgr = rgbaToBgrMat(cv, renderEmScan({ spec, trueWidthMm: 0.42, pxPerMm: PX_PER_MM }))
      let overlay = null
      try {
        const alignment = alignEmCoupon(cv, bgr, spec)
        expect(alignment.success).toBe(true)
        const result = analyzeEmCoupon(cv, bgr, spec, PX_PER_MM)
        expect(result.success).toBe(true)
        overlay = renderEmOverlayMat(cv, bgr, alignment, spec, result)
        // The synthetic scan has a margin around the coupon, so the crop must shrink the frame
        // but still cover the coupon itself.
        expect(overlay.cols).toBeLessThan(bgr.cols)
        expect(overlay.rows).toBeLessThan(bgr.rows)
        const g = emCouponGeometry(spec)
        const scale = Math.hypot(alignment.affine!.a, alignment.affine!.c)
        expect(overlay.cols).toBeGreaterThanOrEqual(Math.floor(g.couponWidthMm * scale))
        expect(overlay.rows).toBeGreaterThanOrEqual(Math.floor(g.couponHeightMm * scale))
        expect(overlay.channels()).toBe(3)
        // The crop must be a continuous Mat: a ROI clone() can keep the parent's row stride,
        // which misaligns every flat `data` read (and the ImageData handed to the UI).
        expect(overlay.isContinuous()).toBe(true)
        expect((overlay.data as Uint8Array).length).toBe(overlay.rows * overlay.cols * 3)
      } finally {
        overlay?.delete()
        bgr.delete()
      }
    },
    240000,
  )

  it('throws when the alignment did not succeed', async () => {
    const cv = await getCv()
    const bgr = rgbaToBgrMat(cv, renderEmScan({ spec, trueWidthMm: 0.42, pxPerMm: PX_PER_MM }))
    try {
      const failed: EmAlignment = {
        success: false,
        failureReason: 'test',
        affine: null,
        flipped: false,
        rotationQuarterTurns: 0,
        rotationDegrees: 0,
      }
      const result = analyzeEmCoupon(cv, bgr, spec, PX_PER_MM)
      expect(() => renderEmOverlayMat(cv, bgr, failed, spec, result)).toThrow()
    } finally {
      bgr.delete()
    }
  }, 240000)
})
