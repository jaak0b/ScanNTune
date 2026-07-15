import type { RgbaImage } from '../../src/engine/imageData'
import { mulberry32 } from '../../src/engine/math'
import type { PaTestSpec } from '../../src/engine/pa/types'
import { couponGeometry, defaultPaTestSpec, paValueForLine } from '../../src/engine/pa/types'

export interface PaRenderOptions {
  spec: PaTestSpec
  pxPerMm: number // default 12 (about 300 dpi)
  truePa: number // ground-truth PA the "printer" needed
  bulgeGainMmPerPa: number // width bulge amplitude per unit PA error, default 30
  transitionSigmaMm: number // spatial extent of the transient, default 1.5
  rotationDegrees: number // whole-image rotation, default 0
  flipped: boolean // mirror the coupon, default false
  noiseSigma: number // additive gaussian pixel noise 0-255, default 4
  baseGray: number // base filament tone, default 210 (light)
  lineGray: number // test line tone, default 40 (dark)
  backgroundGray: number // scanner lid behind fiducial holes, default 120
  /** Ground-truth smooth time (s) of the "printer" for spec.sweep === 'smoothTime' renders. */
  trueSmoothTime: number
  /** Fractional half-width change per unit residual for smooth-time renders. */
  smoothTimeGain: number
  /** Noise RNG seed; the default keeps the historical renders byte-identical. */
  seed: number
  /** Amplitude (gray levels) of the glossy infill-ridge texture on the base; 0 disables it. */
  textureAmpGray: number
  /** Ridge pitch of the base texture, in mm. */
  texturePitchMm: number
  /** Sharpness exponent of the specular ridge bumps; higher reads glossier. */
  ridgeExponent: number
  /** Scanner point-spread blur sigma in px, applied to the gray image before noise; 0 disables. */
  blurSigmaPx: number
}

const DEFAULTS: Omit<PaRenderOptions, 'truePa'> = {
  spec: defaultPaTestSpec(),
  pxPerMm: 12,
  bulgeGainMmPerPa: 30,
  transitionSigmaMm: 1.5,
  rotationDegrees: 0,
  flipped: false,
  noiseSigma: 4,
  baseGray: 210,
  lineGray: 40,
  backgroundGray: 120,
  trueSmoothTime: 0.04,
  smoothTimeGain: 3,
  seed: 1234567,
  textureAmpGray: 0,
  texturePitchMm: 0.7,
  ridgeExponent: 6,
  blurSigmaPx: 0,
}

/**
 * Signed transient profile s(x) along a line. At the deceleration transition
 * (fast-to-slow, the second transition) too-low PA bulges: positive lobe.
 * At the acceleration transition (slow-to-fast, the first transition)
 * too-high PA starves: negative lobe there. Model: gaussian lobes at each
 * transition, sign -1 at the first transition, +1 at the second, scaled by
 * (truePa - pa) at the call site.
 */
function transient(xMm: number, transitions: [number, number], sigma: number): number {
  const [t1, t2] = transitions
  const lobe = (c: number, sign: number) => sign * Math.exp(-((xMm - c) ** 2) / (2 * sigma * sigma))
  return lobe(t1, -1) + lobe(t2, 1)
}

/**
 * Unit step at t convolved with a box (moving-average) window of full spatial
 * width w: Klipper's documented pressure advance smoothing, a weighted moving
 * average over smooth_time mapped to distance at the line speed. A zero-width
 * window degenerates to the exact step.
 */
function boxSmoothedStep(x: number, t: number, w: number): number {
  if (w <= 0) return x >= t ? 1 : 0
  return Math.min(1, Math.max(0, (x - t) / w + 0.5))
}

/**
 * Residual width error profile for a smooth-time render: the extrusion-rate
 * step at each transition blurred by the printer's true smoothing window minus
 * the same step blurred by the applied smooth_time window. Zero everywhere when
 * the applied smooth time matches the true one; grows monotonically with the
 * window mismatch. The deceleration transition is the opposite step direction.
 */
function smoothTimeResidual(
  xMm: number,
  transitions: [number, number],
  trueWidthMm: number,
  appliedWidthMm: number,
): number {
  const d = (t: number) =>
    boxSmoothedStep(xMm, t, trueWidthMm) - boxSmoothedStep(xMm, t, appliedWidthMm)
  const [t1, t2] = transitions
  return d(t1) - d(t2)
}

export function renderPaScan(options: Partial<PaRenderOptions> & { truePa: number }): RgbaImage {
  const o: PaRenderOptions = { ...DEFAULTS, ...options }
  const g = couponGeometry(o.spec)
  const borderMm = 6
  // Unrotated coupon-plus-border extents; the canvas is sized to the rotated bounding box so the
  // whole coupon stays in view at any rotation (a real scan always contains the coupon).
  const w0Mm = g.baseWidthMm + 2 * borderMm
  const h0Mm = g.baseHeightMm + 2 * borderMm
  const rad = (o.rotationDegrees * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const wMm = Math.abs(cos) * w0Mm + Math.abs(sin) * h0Mm
  const hMm = Math.abs(sin) * w0Mm + Math.abs(cos) * h0Mm
  const width = Math.round(wMm * o.pxPerMm)
  const height = Math.round(hMm * o.pxPerMm)
  const cx = wMm / 2
  const cy = hMm / 2
  const rand = mulberry32(o.seed)
  const data = new Uint8ClampedArray(width * height * 4)

  const gray = new Float64Array(width * height)
  const S = 3 // supersampling factor
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let acc = 0
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          // Pixel center in image mm, rotated back into coupon frame.
          const imx = (px + (sx + 0.5) / S) / o.pxPerMm
          const imy = (py + (sy + 0.5) / S) / o.pxPerMm
          let mx = cos * (imx - cx) + sin * (imy - cy) + w0Mm / 2
          const my = -sin * (imx - cx) + cos * (imy - cy) + h0Mm / 2
          if (o.flipped) mx = w0Mm - mx
          const bx = mx - borderMm // coupon-frame mm
          const by = my - borderMm
          acc += sampleGray(o, g, bx, by)
        }
      }
      gray[py * width + px] = acc / (S * S)
    }
  }
  blurGray(gray, width, height, o.blurSigmaPx)
  for (let p = 0; p < width * height; p++) {
    const noisy = gray[p] + (o.noiseSigma > 0 ? gauss(rand) * o.noiseSigma : 0)
    const v = Math.max(0, Math.min(255, Math.round(noisy)))
    const i = p * 4
    data[i] = v
    data[i + 1] = v
    data[i + 2] = v
    data[i + 3] = 255
  }
  return { data, width, height }
}

/**
 * Scanner point-spread blur: three box passes approximating a Gaussian (the standard
 * box-cascade construction), separable horizontal then vertical, edge-clamped, in place.
 */
function blurGray(gray: Float64Array, w: number, h: number, sigma: number): void {
  if (sigma <= 0) return
  const r = Math.max(1, Math.round(sigma))
  const tmp = new Float64Array(w * h)
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      let acc = 0
      const row = y * w
      for (let x = -r; x <= r; x++) acc += gray[row + Math.min(w - 1, Math.max(0, x))]
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / (2 * r + 1)
        acc += gray[row + Math.min(w - 1, x + r + 1)] - gray[row + Math.max(0, x - r)]
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]
      for (let y = 0; y < h; y++) {
        gray[y * w + x] = acc / (2 * r + 1)
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]
      }
    }
  }
}

function gauss(rand: () => number): number {
  // Box-Muller
  const u = Math.max(rand(), 1e-12)
  const v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function sampleGray(
  o: PaRenderOptions,
  g: ReturnType<typeof couponGeometry>,
  x: number,
  y: number,
): number {
  // Outside the base: scanner background.
  if (x < 0 || y < 0 || x > g.baseWidthMm || y > g.baseHeightMm) return o.backgroundGray
  // Fiducial holes: background shows through.
  for (const f of g.fiducials) {
    if (
      Math.abs(x - f.xMm) < g.fiducialSizeMm / 2 &&
      Math.abs(y - f.yMm) < g.fiducialSizeMm / 2
    ) {
      return o.backgroundGray
    }
  }
  // Test lines: check distance from each line's centerline with modeled width.
  const lineLen = 2 * o.spec.slowSegmentMm + o.spec.fastSegmentMm
  for (let i = 0; i < o.spec.lineCount; i++) {
    const yc = g.lineStartYMm(i)
    if (Math.abs(y - yc) > o.spec.linePitchMm / 2) continue
    const lx = x - g.lineStartXMm
    if (lx < 0 || lx > lineLen) break
    const halfNominal = o.spec.lineWidthMm / 2
    let half: number
    if (o.spec.sweep === 'smoothTime') {
      // Smoothing acts in time; map the window to distance at the mean of the
      // two segment speeds bounding each transition.
      const vMean = (o.spec.slowSpeedMmS + o.spec.fastSpeedMmS) / 2
      const r = smoothTimeResidual(
        lx,
        g.transitionXsMm,
        o.trueSmoothTime * vMean,
        paValueForLine(o.spec, i) * vMean,
      )
      half = halfNominal * (1 + o.smoothTimeGain * r)
    } else {
      const paErr = paValueForLine(o.spec, i) - o.truePa
      const s = transient(lx, g.transitionXsMm, o.transitionSigmaMm)
      // Too-low PA (paErr negative) bulges at the deceleration transition
      // (second lobe, sign +1); too-high PA (paErr positive) starves there.
      // Captured by -paErr * s.
      half = halfNominal * (1 + o.bulgeGainMmPerPa * -paErr * s)
    }
    half = Math.max(half, halfNominal * 0.2)
    if (Math.abs(y - yc) <= half) return o.lineGray
    break
  }
  return o.baseGray + baseTexture(o, x, y)
}

/**
 * Glossy top-infill texture on the base: periodic specular ridge bumps texturePitchMm apart,
 * slightly tilted against the line direction, bright at the ridge crest (exponent-sharpened
 * cosine) with a shallow dark valley between, matching the profile of a glossy real scan.
 */
function baseTexture(o: PaRenderOptions, x: number, y: number): number {
  if (o.textureAmpGray <= 0) return 0
  const phase = y + 0.13 * x
  const bump = Math.max(0, Math.cos((2 * Math.PI * phase) / o.texturePitchMm)) ** o.ridgeExponent
  return o.textureAmpGray * (bump - 0.25)
}
