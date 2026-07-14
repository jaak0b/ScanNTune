// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getCv } from '../../helpers/cv'
import { renderEmScan } from '../../helpers/emRender'
import type { EmRenderOptions } from '../../helpers/emRender'
import { rgbaToBgrMat } from '../../../src/engine/imageData'
import { analyzeEmCoupon, analyzeEmCoupons } from '../../../src/engine/em/emAnalyzer'
import type { EmResult } from '../../../src/engine/em/emAnalyzer'
import { defaultEmTestSpec } from '../../../src/engine/em/types'
import { defaultPrinterProfile } from '../../../src/engine/pa/types'

const spec = defaultEmTestSpec(defaultPrinterProfile())
// The analyzer refuses scans below the measurement resolution floor, so the synthetic scans are
// rendered at the 600 dpi class resolution a real scan is expected to have.
const PX_PER_MM = 24

async function analyzeRender(options: Omit<EmRenderOptions, 'spec'>): Promise<EmResult> {
  const cv = await getCv()
  const img = rgbaToBgrMat(cv, renderEmScan({ pxPerMm: PX_PER_MM, spec, ...options }))
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
    'recovers 0.42 mm within 0.008 mm from a saturated yellow coupon on a white backing',
    async () => {
      // Yellow plastic against white paper: the value channel carries almost no contrast (the
      // brightness gate correctly refuses it), so measurement must run on the saturation plane.
      const r = await analyzeRender({
        trueWidthMm: 0.42,
        plasticColor: [240, 220, 30],
        backgroundColor: [245, 245, 245],
      })
      expect(r.success).toBe(true)
      expect(r.wMm).not.toBeNull()
      expect(Math.abs(r.wMm! - 0.42)).toBeLessThanOrEqual(0.008)
    },
    240000,
  )

  it(
    'recovers 0.42 mm within 0.008 mm from an orange coupon on a teal backing (hue-only contrast)',
    async () => {
      // Orange plastic on a teal paper backing, chosen so that neither brightness nor
      // saturation separates them (plastic V 240 / S 181 against backing V 220 / S 185,
      // hand-calculated HSV: both under the 30-level contrast floor). Only the hue direction
      // separates the two, so measurement must run on the Fisher discriminant plane.
      const r = await analyzeRender({
        trueWidthMm: 0.42,
        plasticColor: [240, 170, 60],
        backgroundColor: [60, 190, 220],
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
    'refuses a textured-plate backdrop (speckled tones behind the gaps) instead of mis-measuring',
    async () => {
      const cv = await getCv()
      // Render on a mid plate tone, then speckle every plate-tone pixel: the four-population
      // scene of a coupon scanned on a textured build plate, including through the comb gaps.
      const rgba = renderEmScan({ pxPerMm: PX_PER_MM, spec, trueWidthMm: 0.42, plasticGray: 20, backgroundGray: 150 })
      let seed = 123456789
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0
        return seed / 4294967296
      }
      for (let i = 0; i < rgba.data.length; i += 4) {
        if (rgba.data[i] === 150) {
          // A textured plate has no plateau tone: a continuum between its dark pits and
          // bright glints (the measured spread of a real PEI plate spans 40 to 150).
          const tone = 40 + Math.round(rand() * 110)
          rgba.data[i] = tone
          rgba.data[i + 1] = tone
          rgba.data[i + 2] = tone
        }
      }
      const img = rgbaToBgrMat(cv, rgba)
      try {
        const r = analyzeEmCoupon(cv, img, spec, PX_PER_MM)
        expect(r.success).toBe(false)
        expect(r.failureReason).toContain('too uneven')
      } finally {
        img.delete()
      }
    },
    240000,
  )

  it(
    'refuses a backdrop too similar in brightness to the plastic instead of mis-measuring',
    async () => {
      const r = await analyzeRender({ trueWidthMm: 0.42, plasticGray: 26, backgroundGray: 45 })
      expect(r.success).toBe(false)
      expect(r.failureReason).toContain('too similar in brightness')
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
      const img = rgbaToBgrMat(
        cv,
        renderEmScan({ pxPerMm: PX_PER_MM, spec, trueWidthMm: 0.42, quarterTurns: 1 }),
      )
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
      // The between-block standard error of a clean render sits under the recovery tolerance.
      expect(r.seMm).not.toBeNull()
      expect(r.seMm!).toBeGreaterThanOrEqual(0)
      expect(r.seMm!).toBeLessThan(0.005)
    },
    240000,
  )

  it(
    'detects a one-sided lamp shadow and warns, with an asymmetry near the width inflation',
    async () => {
      const trueWidth = 0.42
      // A symmetric clean reference to measure how much the injected shadow inflated the width.
      const clean = await analyzeRender({ trueWidthMm: trueWidth })
      const rLeft = await analyzeRender({
        trueWidthMm: trueWidth,
        shadow: { side: 'left', extraSigmaMm: 0.16 },
      })
      const rRight = await analyzeRender({
        trueWidthMm: trueWidth,
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

  it(
    'refuses a scan whose measured resolution mismatches the expected calibration resolution',
    async () => {
      // Coupon rendered (and priced) at 24 px/mm, but the expected resolution says the scan
      // should measure twice that: the analyzer must refuse with the mismatch reason instead of
      // returning wrongly scaled widths.
      const cv = await getCv()
      const img = rgbaToBgrMat(cv, renderEmScan({ pxPerMm: PX_PER_MM, spec, trueWidthMm: 0.42 }))
      try {
        const expectedDpi = Math.round(2 * PX_PER_MM * 25.4)
        const r = analyzeEmCoupon(cv, img, spec, 2 * PX_PER_MM, expectedDpi)
        expect(r.success).toBe(false)
        expect(r.failureReason).toContain('expected resolution')
        expect(r.failureReason).toContain(`${expectedDpi} dpi`)
        expect(r.wMm).toBeNull()
      } finally {
        img.delete()
      }
    },
    240000,
  )

  it(
    'fails with a resolution reason on a scan below the 150 dpi floor',
    async () => {
      const r = await analyzeRender({ trueWidthMm: 0.42, pxPerMm: 5 })
      expect(r.success).toBe(false)
      expect(r.failureReason).toContain('dpi')
      expect(r.failureReason).toContain('150')
      expect(r.wMm).toBeNull()
    },
    240000,
  )

  it(
    'a single scan under one-sided lamp shading is biased away from the ground truth',
    async () => {
      const trueWidth = 0.42
      const r = await analyzeRender({
        trueWidthMm: trueWidth,
        lampShading: { lampSide: 'left', extraSigmaMm: 0.16 },
      })
      expect(r.success).toBe(true)
      expect(r.wMm).not.toBeNull()
      // The lamp bias exceeds the clean-render recovery tolerance: this is the error the second,
      // 180-degree-rotated scan exists to cancel.
      expect(Math.abs(r.wMm! - trueWidth)).toBeGreaterThan(0.005)
      expect(r.shadowWarning).toBe(true)
      expect(r.scans).toHaveLength(1)
    },
    240000,
  )

  it(
    'pooling a second scan rotated 180 degrees cancels the lamp-side bias',
    async () => {
      const trueWidth = 0.42
      const cv = await getCv()
      const render = (quarterTurns: 0 | 2) =>
        rgbaToBgrMat(
          cv,
          renderEmScan({
            pxPerMm: PX_PER_MM,
            spec,
            trueWidthMm: trueWidth,
            quarterTurns,
            lampShading: { lampSide: 'left', extraSigmaMm: 0.16 },
          }),
        )
      const imgA = render(0)
      const imgB = render(2)
      try {
        // The same image-fixed lamp biases the two orientations in opposite directions.
        const rA = analyzeEmCoupon(cv, imgA, spec, PX_PER_MM)
        const rB = analyzeEmCoupon(cv, imgB, spec, PX_PER_MM)
        expect(rA.success).toBe(true)
        expect(rB.success).toBe(true)
        expect(Math.sign(rA.wMm! - trueWidth)).toBe(-Math.sign(rB.wMm! - trueWidth))

        // Combined with equal weight per scan, the bias cancels and the clean tolerance holds
        // again.
        const pooled = analyzeEmCoupons(cv, [imgA, imgB], spec, PX_PER_MM)
        expect(pooled.success).toBe(true)
        expect(pooled.wMm).not.toBeNull()
        expect(Math.abs(pooled.wMm! - trueWidth)).toBeLessThanOrEqual(0.005)
        expect(pooled.shadowWarning).toBe(false)
        expect(pooled.scans).toHaveLength(2)
        expect(pooled.scans[0].rotationQuarterTurns).not.toBe(pooled.scans[1].rotationQuarterTurns)
        expect(pooled.rotationDegrees).toBe(pooled.scans[0].rotationDegrees)
        expect(Math.abs(pooled.scans[0].rotationDegrees)).toBeLessThan(0.5)
        expect(Math.abs(Math.abs(pooled.scans[1].rotationDegrees) - 180)).toBeLessThan(0.5)
        expect(pooled.blocksMeasured).toBe(
          pooled.scans[0].blocksMeasured + pooled.scans[1].blocksMeasured,
        )
      } finally {
        imgA.delete()
        imgB.delete()
      }
    },
    480000,
  )

  it(
    'cancels the lamp bias even when one scan of the 180 degree pair keeps fewer samples',
    async () => {
      const trueWidth = 0.42
      const cv = await getCv()
      // The 180 degree scan is rendered much noisier, so the MAD cleaning drops more of its
      // samples: a naive sample-level pool would lean toward the cleaner scan and leave part of
      // the lamp bias uncancelled, while the equal-weight per-scan combination cancels it fully.
      const render = (quarterTurns: 0 | 2, noiseSigma: number) =>
        rgbaToBgrMat(
          cv,
          renderEmScan({
            pxPerMm: PX_PER_MM,
            spec,
            trueWidthMm: trueWidth,
            quarterTurns,
            noiseSigma,
            lampShading: { lampSide: 'left', extraSigmaMm: 0.16 },
          }),
        )
      const imgA = render(0, 0)
      const imgB = render(2, 10)
      try {
        const combined = analyzeEmCoupons(cv, [imgA, imgB], spec, PX_PER_MM)
        expect(combined.success).toBe(true)
        expect(combined.wMm).not.toBeNull()
        expect(Math.abs(combined.wMm! - trueWidth)).toBeLessThanOrEqual(0.005)
        expect(combined.shadowWarning).toBe(false)
        expect(combined.scans).toHaveLength(2)
      } finally {
        imgA.delete()
        imgB.delete()
      }
    },
    480000,
  )

  it(
    'passes a smooth brightness-gradient backing but still refuses a textured one',
    async () => {
      const cv = await getCv()
      // A one-sided lamp gradient: multiplicative shading across the whole scan, strong enough
      // that the raw backing spread would have tripped the unevenness refusal before detrending.
      const shade = (rgba: ReturnType<typeof renderEmScan>) => {
        for (let py = 0; py < rgba.height; py++) {
          for (let px = 0; px < rgba.width; px++) {
            const i = (py * rgba.width + px) * 4
            const factor = 0.35 + (0.9 * px) / (rgba.width - 1)
            for (let c = 0; c < 3; c++) {
              rgba.data[i + c] = Math.max(0, Math.min(255, Math.round(rgba.data[i + c] * factor)))
            }
          }
        }
        return rgba
      }
      const gradient = shade(
        renderEmScan({ pxPerMm: PX_PER_MM, spec, trueWidthMm: 0.42, plasticGray: 20, backgroundGray: 150 }),
      )
      const imgGradient = rgbaToBgrMat(cv, gradient)
      try {
        const r = analyzeEmCoupon(cv, imgGradient, spec, PX_PER_MM)
        expect(r.failureReason).toBeNull()
        expect(r.success).toBe(true)
        expect(Math.abs(r.wMm! - 0.42)).toBeLessThanOrEqual(0.008)
      } finally {
        imgGradient.delete()
      }

      // High-frequency texture must still refuse: same speckled-plate construction as the
      // dedicated textured-backdrop test above.
      const textured = renderEmScan({ pxPerMm: PX_PER_MM, spec, trueWidthMm: 0.42, plasticGray: 20, backgroundGray: 150 })
      let seed = 987654321
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0
        return seed / 4294967296
      }
      for (let i = 0; i < textured.data.length; i += 4) {
        if (textured.data[i] === 150) {
          const tone = 40 + Math.round(rand() * 110)
          textured.data[i] = tone
          textured.data[i + 1] = tone
          textured.data[i + 2] = tone
        }
      }
      const imgTextured = rgbaToBgrMat(cv, textured)
      try {
        const r = analyzeEmCoupon(cv, imgTextured, spec, PX_PER_MM)
        expect(r.success).toBe(false)
        expect(r.failureReason).toContain('too uneven')
      } finally {
        imgTextured.delete()
      }
    },
    480000,
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
      expect(r.seMm).toBeNull()
    } finally {
      img.delete()
    }
  })
})
