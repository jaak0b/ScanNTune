// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getCv } from '../../helpers/cv'
import { renderEmScan } from '../../helpers/emRender'
import type { EmRenderOptions } from '../../helpers/emRender'
import { rgbaToBgrMat } from '../../../src/engine/imageData'
import { analyzeEmCoupon } from '../../../src/engine/em/emAnalyzer'
import type { EmResult } from '../../../src/engine/em/emAnalyzer'
import { defaultEmTestSpec } from '../../../src/engine/em/types'
import { defaultPrinterProfile } from '../../../src/engine/pa/types'

const spec = defaultEmTestSpec(defaultPrinterProfile())
const PX_PER_MM = 12

async function analyzeRender(options: Omit<EmRenderOptions, 'spec'>): Promise<EmResult> {
  const cv = await getCv()
  const img = rgbaToBgrMat(cv, renderEmScan({ spec, ...options }))
  try {
    return analyzeEmCoupon(cv, img, spec, options.pxPerMm ?? PX_PER_MM)
  } finally {
    img.delete()
  }
}

describe('analyzeEmCoupon render recovery', () => {
  for (const trueWidth of [0.36, 0.4, 0.42, 0.46, 0.5]) {
    it(
      `recovers a ${trueWidth} mm bead width from a clean render within 0.005 mm`,
      async () => {
        const r = await analyzeRender({ trueWidthMm: trueWidth })
        expect(r.success).toBe(true)
        expect(r.wMm).not.toBeNull()
        expect(Math.abs(r.wMm! - trueWidth)).toBeLessThanOrEqual(0.005)
      },
      240000,
    )
  }

  it(
    'recovers 0.42 mm within 0.008 mm from a rotated, flipped, noisy, blurred render',
    async () => {
      const r = await analyzeRender({
        trueWidthMm: 0.42,
        rotationDegrees: 2,
        flipped: true,
        quarterTurns: 1,
        noiseSigma: 8,
        blurSigmaMm: 0.08,
      })
      expect(r.success).toBe(true)
      expect(r.wMm).not.toBeNull()
      expect(Math.abs(r.wMm! - 0.42)).toBeLessThanOrEqual(0.008)
      expect(r.flipped).toBe(true)
    },
    240000,
  )

  it(
    'recovers 0.42 mm within 0.008 mm with inverted polarity (light plastic on dark background)',
    async () => {
      const r = await analyzeRender({
        trueWidthMm: 0.42,
        backgroundGray: 30,
        plasticGray: 220,
      })
      expect(r.success).toBe(true)
      expect(r.wMm).not.toBeNull()
      expect(Math.abs(r.wMm! - 0.42)).toBeLessThanOrEqual(0.008)
    },
    240000,
  )

  it(
    'recovers the width within 0.008 mm and reports the pitch stretch on a 1.01 pitchScale render',
    async () => {
      const r = await analyzeRender({ trueWidthMm: 0.42, pitchScale: 1.01 })
      expect(r.success).toBe(true)
      expect(r.wMm).not.toBeNull()
      expect(Math.abs(r.wMm! - 0.42)).toBeLessThanOrEqual(0.008)
      expect(r.pitchScale).not.toBeNull()
      expect(r.pitchScale!).toBeGreaterThanOrEqual(1.005)
      expect(r.pitchScale!).toBeLessThanOrEqual(1.015)
    },
    240000,
  )

  it(
    'recovers 0.42 mm within 0.008 mm on a contrasting-color base (dark plastic on a gray base)',
    async () => {
      const r = await analyzeRender({
        trueWidthMm: 0.42,
        plasticGray: 40,
        baseGray: 150,
        backgroundGray: 245,
      })
      expect(r.success).toBe(true)
      expect(r.wMm).not.toBeNull()
      expect(Math.abs(r.wMm! - 0.42)).toBeLessThanOrEqual(0.008)
    },
    240000,
  )

  it(
    'on a low-contrast light-on-light base either measures accurately or fails cleanly',
    async () => {
      const r = await analyzeRender({
        trueWidthMm: 0.42,
        plasticGray: 240,
        baseGray: 200,
        backgroundGray: 20,
      })
      if (r.success) {
        expect(r.wMm).not.toBeNull()
        expect(Math.abs(r.wMm! - 0.42)).toBeLessThanOrEqual(0.008)
      } else {
        expect(r.failureReason).toBeTruthy()
      }
    },
    240000,
  )

  it(
    'prices a quarter-turned coupon with the vertical figure of a per-axis (CCD) reference',
    async () => {
      // The comb profiles of a quarter-turned coupon run along the image's vertical axis, so a
      // per-axis reference must convert them with its vertical figure alone; the horizontal figure
      // here is deliberately far off and must not leak into the measurement.
      const cv = await getCv()
      const img = rgbaToBgrMat(cv, renderEmScan({ spec, trueWidthMm: 0.42, quarterTurns: 1 }))
      try {
        const r = analyzeEmCoupon(cv, img, spec, {
          horizontal: PX_PER_MM * 2,
          vertical: PX_PER_MM,
        })
        expect(r.success).toBe(true)
        expect(r.wMm).not.toBeNull()
        expect(Math.abs(r.wMm! - 0.42)).toBeLessThanOrEqual(0.005)
      } finally {
        img.delete()
      }
    },
    240000,
  )

  it('fails with a reason on a blank image', async () => {
    const cv = await getCv()
    const width = 400
    const height = 300
    const data = new Uint8ClampedArray(width * height * 4)
    data.fill(200)
    const img = rgbaToBgrMat(cv, { data, width, height })
    try {
      const r = analyzeEmCoupon(cv, img, spec, PX_PER_MM)
      expect(r.success).toBe(false)
      expect(r.failureReason).toBeTruthy()
      expect(r.wMm).toBeNull()
    } finally {
      img.delete()
    }
  })
})
