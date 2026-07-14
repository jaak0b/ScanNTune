// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getCv, decodeFixtureBgr } from '../helpers/cv'
import { detectRingsOnBands } from '../../src/engine/ringDetector'
import type { RingBandDetection } from '../../src/engine/ringDetector'
import { analyzeCoupon } from '../../src/engine/couponAnalyzer'
import { defaultCouponSpec } from '../../src/engine/types'
import type { Mat } from '../../src/engine/opencv'

// The Scan/Threshold toggle shows the binary mask the detector searched. The detector hands each
// band's mask to the evaluator; the analyzer keeps the one whose rings fit the grid and frees the
// rest.
describe('threshold mask capture', () => {
  it('hands a full-frame single-channel mask to the evaluator for every band', async () => {
    const cv = await getCv()
    const image = decodeFixtureBgr(cv, 'TestData_2solid.png')
    let ringCounts: number[] = []
    try {
      ringCounts = detectRingsOnBands(cv, image, (detection: RingBandDetection) => {
        try {
          expect(detection.mask.rows).toBe(image.rows)
          expect(detection.mask.cols).toBe(image.cols)
          expect(detection.mask.channels()).toBe(1)
          return detection.rings.length
        } finally {
          detection.mask.delete()
        }
      })
      // One of the band hypotheses is the part; the ring grid rides on it.
      expect(Math.max(...ringCounts)).toBe(23)
    } finally {
      image.delete()
    }
  }, 60000)

  it('analyzeCoupon hands back exactly the winning band mask', async () => {
    const cv = await getCv()
    const image = decodeFixtureBgr(cv, 'TestData_2solid.png')
    const maskHolder: { mask?: Mat } = {}
    try {
      const result = analyzeCoupon(
        cv,
        image,
        { coupon: defaultCouponSpec(), pxPerMm: null },
        undefined,
        maskHolder,
      )
      expect(result.aligned).toBe(true)
      expect(maskHolder.mask).toBeDefined()
      expect(maskHolder.mask!.rows).toBe(image.rows)
      expect(maskHolder.mask!.cols).toBe(image.cols)
      expect(maskHolder.mask!.channels()).toBe(1)
    } finally {
      maskHolder.mask?.delete()
      image.delete()
    }
  }, 60000)
})
