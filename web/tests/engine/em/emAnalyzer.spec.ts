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

  it(
    'reports a near-zero flank asymmetry and no shadow warning on a clean render',
    async () => {
      const r = await analyzeRender({ trueWidthMm: 0.42 })
      expect(r.success).toBe(true)
      expect(r.flankAsymmetryMm).not.toBeNull()
      expect(Math.abs(r.flankAsymmetryMm!)).toBeLessThan(0.005)
      expect(r.shadowWarning).toBe(false)
    },
    240000,
  )

  it(
    'detects a one-sided lamp shadow and warns, with an asymmetry near the width inflation',
    async () => {
      const trueWidth = 0.42
      // Rendered at a higher resolution so the narrowest gaps span enough pixels for the flanks to
      // be measured independently; the tightest default-spec gap is only about a quarter millimetre.
      const px = 24
      // A symmetric clean reference to measure how much the injected shadow inflated the width.
      const clean = await analyzeRender({ trueWidthMm: trueWidth, pxPerMm: px })
      const rLeft = await analyzeRender({
        trueWidthMm: trueWidth,
        pxPerMm: px,
        shadow: { side: 'left', extraSigmaMm: 0.16 },
      })
      const rRight = await analyzeRender({
        trueWidthMm: trueWidth,
        pxPerMm: px,
        shadow: { side: 'right', extraSigmaMm: 0.16 },
      })
      expect(clean.success).toBe(true)
      expect(rLeft.success).toBe(true)
      expect(rRight.success).toBe(true)
      expect(rLeft.shadowWarning).toBe(true)
      expect(rRight.shadowWarning).toBe(true)
      expect(rLeft.flankAsymmetryMm).not.toBeNull()
      expect(rRight.flankAsymmetryMm).not.toBeNull()
      // The asymmetry sign is the signature of which flank the lamp shadowed: the two sides shift
      // opposite flanks, so their asymmetries come out with opposite signs.
      expect(Math.sign(rLeft.flankAsymmetryMm!)).not.toBe(0)
      expect(Math.sign(rRight.flankAsymmetryMm!)).toBe(-Math.sign(rLeft.flankAsymmetryMm!))
      // The estimated one-sided edge shift should track the actual width inflation each shadow
      // caused (clean baseline vs shadowed) within a factor of two, since each gap loses the shift
      // and the bead width gains it.
      for (const r of [rLeft, rRight]) {
        const inflation = r.wMm! - clean.wMm!
        expect(Math.abs(inflation)).toBeGreaterThan(0.01 * trueWidth)
        const ratio = Math.abs(r.flankAsymmetryMm!) / Math.abs(inflation)
        expect(ratio).toBeGreaterThan(0.5)
        expect(ratio).toBeLessThan(2)
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
