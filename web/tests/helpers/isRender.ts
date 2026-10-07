import type { RgbaImage } from '../../src/engine/imageData'
import type { IsAxis, IsTestSpec } from '../../src/engine/is/types'
import { isCouponGeometry } from '../../src/engine/is/couponGeometry'
import type { IsCouponGeometry, IsLine, IsSegment } from '../../src/engine/is/couponGeometry'
import { timeAtDistance } from '../../src/engine/is/lineTracer'

// Synthetic ground-truth renderer for the IS coupon: draws a flatbed-style scan of a printed
// coupon whose measured lines follow the exact ringing model the pipeline fits (corner settle
// lobe plus damped sinusoid), from chosen per-axis ground truth. Follows the emRender.ts
// conventions: supersampled coverage rendering, soft edges, mirror flip and quarter turns,
// optional Gaussian noise, and an optional low-frequency transport waviness on the image's
// vertical (carriage) axis.

export interface IsAxisTruth {
  frequencyHz: number
  dampingRatio: number
  /** Initial ring amplitude at the corner, mm. */
  ringAmpMm: number
  lobeAmpMm?: number
  lobeTauS?: number
  phaseRad?: number
  /** Per-tier frequency override (index into spec.speedsMmS) for invariance tests. */
  frequencyByTierHz?: number[]
  /** Per-line frequency spread (+/- half of this, linear across the group) for scatter tests. */
  frequencySpreadHz?: number
}

export interface IsRenderOptions {
  spec: IsTestSpec
  truth: Partial<Record<IsAxis, IsAxisTruth>>
  pxPerMm?: number
  quarterTurns?: 0 | 1 | 2 | 3
  flipped?: boolean
  noiseSigma?: number
  blurSigmaMm?: number
  lineWidthMm?: number
  plasticGray?: number
  backgroundGray?: number
  marginMm?: number
  /** Amplitude of the transport-axis waviness, mm (applied along the image vertical). */
  wavinessAmpMm?: number
  wavinessPeriodMm?: number
}

type Resolved = Required<IsRenderOptions>

const DEFAULTS: Omit<Resolved, 'spec' | 'truth'> = {
  pxPerMm: 12,
  quarterTurns: 0,
  flipped: true,
  noiseSigma: 0,
  blurSigmaMm: 0.05,
  lineWidthMm: 0.45,
  plasticGray: 40,
  backgroundGray: 245,
  marginMm: 8,
  wavinessAmpMm: 0,
  wavinessPeriodMm: 40,
}

/** Deterministic pseudo-random (mulberry32), same construction as paRender.ts. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gauss(rand: () => number): number {
  const u = Math.max(rand(), 1e-12)
  const v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function softEdge(d: number, sigma: number): number {
  if (sigma <= 0) return d >= 0 ? 1 : 0
  return Math.max(0, Math.min(1, 0.5 + d / sigma))
}

function boxCoverage(
  x: number,
  y: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  sigma: number,
): number {
  const dx = Math.min(x - x0, x1 - x)
  const dy = Math.min(y - y0, y1 - y)
  return softEdge(Math.min(dx, dy), sigma)
}

/** Coverage of a straight axis-aligned bead segment of the given width. */
function segmentCoverage(x: number, y: number, s: IsSegment, halfW: number, sigma: number): number {
  const x0 = Math.min(s.x0, s.x1) - halfW
  const x1 = Math.max(s.x0, s.x1) + halfW
  const y0 = Math.min(s.y0, s.y1) - halfW
  const y1 = Math.max(s.y0, s.y1) + halfW
  return boxCoverage(x, y, x0, y0, x1, y1, sigma)
}

interface RingedLine {
  line: IsLine
  horizontal: boolean
  /** Lateral displacement in mm at arc distance s from the corner. */
  lat: (sMm: number) => number
  maxAmpMm: number
  lengthMm: number
  /**
   * Bounding box of the sweep teeth's coverage footprint (bead half-width plus the soft-edge
   * blur), or null without teeth. Outside it every tooth's coverage is exactly zero, so the
   * per-tooth loop is skipped there without changing a single rendered value: a sweep line
   * carries some 200 teeth, and testing each of them at every sub-pixel made the sweep
   * render cost two minutes per scan.
   */
  teethBox: IsSegment | null
}

/** The teeth's coverage footprint: softEdge is zero once a point lies more than half the
 *  blur outside a bead, so the bead half-width plus the full blur bounds it safely. */
function teethFootprint(line: IsLine, o: Resolved): IsSegment | null {
  if (line.teeth.length === 0) return null
  const pad = o.lineWidthMm / 2 + o.blurSigmaMm
  const xs = line.teeth.flatMap((t) => [t.x0, t.x1])
  const ys = line.teeth.flatMap((t) => [t.y0, t.y1])
  return {
    x0: Math.min(...xs) - pad,
    y0: Math.min(...ys) - pad,
    x1: Math.max(...xs) + pad,
    y1: Math.max(...ys) + pad,
  }
}

function buildRingedLines(spec: IsTestSpec, g: IsCouponGeometry, o: Resolved): RingedLine[] {
  const out: RingedLine[] = []
  for (const group of g.groups) {
    const truth = o.truth[group.axis]
    for (let i = 0; i < group.lines.length; i++) {
      const line = group.lines[i]
      const horizontal = line.measured.y0 === line.measured.y1
      const lengthMm = Math.abs(line.measured.x1 - line.measured.x0) + Math.abs(line.measured.y1 - line.measured.y0)
      const teethBox = teethFootprint(line, o)
      if (!truth) {
        out.push({ line, horizontal, lat: () => 0, maxAmpMm: 0, lengthMm, teethBox })
        continue
      }
      const tierIndex = spec.speedsMmS.indexOf(line.speedMmS)
      let f = truth.frequencyByTierHz?.[tierIndex] ?? truth.frequencyHz
      if (truth.frequencySpreadHz && group.lines.length > 1) {
        f += truth.frequencySpreadHz * (i / (group.lines.length - 1) - 0.5)
      }
      const zeta = truth.dampingRatio
      // Ladder physics: the ring amplitude scales with the corner's velocity step
      // (delta-v over omega), so a line on a slower rung rings proportionally weaker.
      // truth.ringAmpMm is the TOP rung's amplitude.
      const B = truth.ringAmpMm * (line.cornerSpeedMmS / spec.cornerSpeedMmS)
      const lobeA = (truth.lobeAmpMm ?? 0.08) * (line.cornerSpeedMmS / spec.cornerSpeedMmS)
      const lobeTau = truth.lobeTauS ?? 0.008
      const phi = truth.phaseRad ?? 0
      const omega = 2 * Math.PI * f
      const omegaD = omega * Math.sqrt(1 - zeta * zeta)
      const lat = (sMm: number) => {
        const t = timeAtDistance(sMm, line.cornerSpeedMmS, line.speedMmS, spec.accelMmS2)
        return lobeA * Math.exp(-t / lobeTau) + B * Math.exp(-omega * zeta * t) * Math.cos(omegaD * t + phi)
      }
      out.push({ line, horizontal, lat, maxAmpMm: Math.abs(B) + Math.abs(lobeA), lengthMm, teethBox })
    }
  }
  return out
}

/** Plastic coverage (0..1) at a coupon-frame point and hole coverage of the fiducials. */
function couponCoverage(
  x: number,
  y: number,
  g: IsCouponGeometry,
  lines: RingedLine[],
  o: Resolved,
): { plastic: number; hole: number } {
  const sigma = o.blurSigmaMm
  const Wc = g.couponWidthMm
  const Hc = g.couponHeightMm
  const band = g.frameBandMm

  const bandTop = boxCoverage(x, y, 0, 0, Wc, band, sigma)
  const bandBottom = boxCoverage(x, y, 0, Hc - band, Wc, Hc, sigma)
  const bandLeft = boxCoverage(x, y, 0, 0, band, Hc, sigma)
  const bandRight = boxCoverage(x, y, Wc - band, 0, Wc, Hc, sigma)
  let coverage = Math.max(bandTop, bandBottom, bandLeft, bandRight)

  const halfW = o.lineWidthMm / 2
  for (const rl of lines) {
    if (coverage >= 1) break
    // Straight legs: the run-up in the window (the prime and tail sit under the bands),
    // plus the resonant run-up teeth when the spec sweeps.
    coverage = Math.max(coverage, segmentCoverage(x, y, rl.line.runUp, halfW, sigma))
    const tb = rl.teethBox
    if (tb !== null && x >= tb.x0 && x <= tb.x1 && y >= tb.y0 && y <= tb.y1) {
      for (const tooth of rl.line.teeth) {
        if (coverage >= 1) break
        coverage = Math.max(coverage, segmentCoverage(x, y, tooth, halfW, sigma))
      }
    }
    // The measured segment with the ringing lateral path.
    const m = rl.line.measured
    if (rl.horizontal) {
      const sMin = Math.min(m.x0, m.x1)
      const sMax = Math.max(m.x0, m.x1)
      if (x < sMin - sigma || x > sMax + sigma) continue
      if (Math.abs(y - m.y0) > rl.maxAmpMm + halfW + sigma) continue
      const s = m.x1 > m.x0 ? x - m.x0 : m.x0 - x
      const yc = m.y0 + rl.lat(Math.max(0, s))
      coverage = Math.max(coverage, softEdge(halfW - Math.abs(y - yc), sigma))
    } else {
      const sMin = Math.min(m.y0, m.y1)
      const sMax = Math.max(m.y0, m.y1)
      if (y < sMin - sigma || y > sMax + sigma) continue
      if (Math.abs(x - m.x0) > rl.maxAmpMm + halfW + sigma) continue
      const s = m.y1 > m.y0 ? y - m.y0 : m.y0 - y
      const xc = m.x0 + rl.lat(Math.max(0, s))
      coverage = Math.max(coverage, softEdge(halfW - Math.abs(x - xc), sigma))
    }
  }

  let holeCoverage = 0
  for (const f of g.fiducials) {
    const half = g.fiducialSizeMm / 2
    holeCoverage = Math.max(
      holeCoverage,
      boxCoverage(x, y, f.xMm - half, f.yMm - half, f.xMm + half, f.yMm + half, sigma),
    )
  }

  return {
    plastic: Math.max(0, Math.min(1, coverage - holeCoverage)),
    hole: Math.max(0, Math.min(1, holeCoverage)),
  }
}

export function renderIsScan(options: IsRenderOptions): RgbaImage {
  const o: Resolved = { ...DEFAULTS, ...options }
  const g = isCouponGeometry(o.spec)
  const lines = buildRingedLines(o.spec, g, o)
  const Wc = g.couponWidthMm
  const Hc = g.couponHeightMm
  const w0Mm = Wc + 2 * o.marginMm
  const h0Mm = Hc + 2 * o.marginMm
  const rad = (o.quarterTurns * 90 * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const wMm = Math.abs(cos) * w0Mm + Math.abs(sin) * h0Mm
  const hMm = Math.abs(sin) * w0Mm + Math.abs(cos) * h0Mm
  const width = Math.round(wMm * o.pxPerMm)
  const height = Math.round(hMm * o.pxPerMm)
  const cx = wMm / 2
  const cy = hMm / 2
  const rand = rng(987654321)
  const data = new Uint8ClampedArray(width * height * 4)

  const S = 3
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let acc = 0
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const imx = (px + (sx + 0.5) / S) / o.pxPerMm
          // Transport waviness: the image row at imy actually sampled the document at a
          // slightly displaced carriage position (low-frequency registration error along the
          // image vertical, the scan head's travel).
          let imy = (py + (sy + 0.5) / S) / o.pxPerMm
          if (o.wavinessAmpMm > 0) {
            imy += o.wavinessAmpMm * Math.sin((2 * Math.PI * imy) / o.wavinessPeriodMm)
          }
          let mx = cos * (imx - cx) + sin * (imy - cy) + w0Mm / 2
          const my = -sin * (imx - cx) + cos * (imy - cy) + h0Mm / 2
          if (o.flipped) mx = w0Mm - mx
          const bx = mx - o.marginMm
          const by = my - o.marginMm
          if (bx < 0 || by < 0 || bx > Wc || by > Hc) {
            acc += o.backgroundGray
          } else {
            // Everything behind the plastic (fiducial through-holes and the open window)
            // shows the scanner background.
            const { plastic } = couponCoverage(bx, by, g, lines, o)
            acc += plastic * o.plasticGray + (1 - plastic) * o.backgroundGray
          }
        }
      }
      const gray = acc / (S * S) + (o.noiseSigma > 0 ? gauss(rand) * o.noiseSigma : 0)
      const v = Math.max(0, Math.min(255, Math.round(gray)))
      const i = (py * width + px) * 4
      data[i] = v
      data[i + 1] = v
      data[i + 2] = v
      data[i + 3] = 255
    }
  }
  return { data, width, height }
}
