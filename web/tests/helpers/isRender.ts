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
//
// The ring is a function of time since the corner, and the printer reaches a commanded
// distance at the commanded time whatever the part does afterwards: `shrink` scales the whole
// printed coupon (lines, rings, fiducials) by 1 - shrink about its origin, the way plastic
// shrinkage or a printer axis scale error does, while the ring stays timed by the commanded
// distance.
//
// Along-track lag: the axis along a group's lines is the other group's axis, and the corner
// changes its velocity the same way (the Y group starts it from rest along +X, the X group stops
// it from a -X run-up), so it answers with the ring the other group's truth gives it. When both
// axes have a truth, the nozzle of a line lags its commanded position by that ring, taken as the
// displacement along the other group's run-up, and the line's bead at commanded position s lies
// where the nozzle passed s: at the time t solving s_cmd(t) - lag(t) = s (bisection), at which
// the line's own lobe and ring are evaluated. `alongTrackLag: false` renders on the commanded
// time base instead.

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
  /** Fraction the printed coupon is smaller than commanded (0.005 = 0.5% shrinkage). */
  shrink?: number
  /** Deposit each line where its nozzle, lagging by the other axis's ring, passed it. */
  alongTrackLag?: boolean
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
  shrink: 0,
  alongTrackLag: true,
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

/** Commanded distance covered by time t after the corner: the trapezoid ramp, then cruise. */
function distanceAtTime(t: number, c: number, v: number, a: number): number {
  const T = (v - c) / a
  if (t >= T) return 0.5 * (c + v) * T + v * (t - T)
  return c * t + 0.5 * a * t * t
}

/** Step of the deposit-time table along a lagged line, mm: linear interpolation over it misses a
 *  0.25 mm ring of 0.7 mm wavelength (150 Hz at 106 mm/s) by under a tenth of a micrometre. */
const LAG_TABLE_STEP_MM = 0.005

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
}

/** The coupon-frame direction a line's lateral displacement is drawn in (+Y for a horizontal
 *  line, +X for a vertical one), as +1 along its run-up's direction of travel or -1 against it. */
function towardRunUp(line: IsLine): number {
  const horizontal = line.measured.y0 === line.measured.y1
  const along = horizontal ? line.runUp.y1 - line.runUp.y0 : line.runUp.x1 - line.runUp.x0
  return along >= 0 ? 1 : -1
}

/** The along-track lag of a line of the group whose axis is not `ringingAxis`, at corner speed c:
 *  the ringing axis's ring along that axis's own group's run-up; null without both truths. */
function lagFunction(
  g: IsCouponGeometry,
  o: Resolved,
  lineAxis: IsAxis,
  cornerSpeedMmS: number,
): ((t: number) => number) | null {
  if (!o.alongTrackLag || g.groups.length < 2 || !o.truth[lineAxis]) return null
  const other = g.groups.find((group) => group.axis !== lineAxis)!
  const truth = o.truth[other.axis]
  if (!truth) return null
  const sign = towardRunUp(other.lines[0])
  const B = truth.ringAmpMm * (cornerSpeedMmS / o.spec.cornerSpeedMmS)
  const omega = 2 * Math.PI * truth.frequencyHz
  const omegaD = omega * Math.sqrt(1 - truth.dampingRatio * truth.dampingRatio)
  const phi = truth.phaseRad ?? 0
  return (t: number) => sign * B * Math.exp(-omega * truth.dampingRatio * t) * Math.cos(omegaD * t + phi)
}

function buildRingedLines(spec: IsTestSpec, g: IsCouponGeometry, o: Resolved): RingedLine[] {
  const out: RingedLine[] = []
  for (const group of g.groups) {
    const truth = o.truth[group.axis]
    for (let i = 0; i < group.lines.length; i++) {
      const line = group.lines[i]
      const horizontal = line.measured.y0 === line.measured.y1
      const lengthMm = Math.abs(line.measured.x1 - line.measured.x0) + Math.abs(line.measured.y1 - line.measured.y0)
      if (!truth) {
        out.push({ line, horizontal, lat: () => 0, maxAmpMm: 0, lengthMm })
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
      const c = line.cornerSpeedMmS
      const v = line.speedMmS
      const a = spec.accelMmS2
      const atTime = (t: number) =>
        lobeA * Math.exp(-t / lobeTau) + B * Math.exp(-omega * zeta * t) * Math.cos(omegaD * t + phi)
      const lag = lagFunction(g, o, group.axis, c)
      let lat = (sMm: number) => atTime(timeAtDistance(sMm, c, v, a))
      if (lag) {
        // The ring is bounded by its corner amplitude, so the deposit time lies between the
        // commanded times of s - bound and s + bound.
        const bound = Math.abs(o.truth[g.groups.find((other) => other.axis !== group.axis)!.axis]!.ringAmpMm) * (c / spec.cornerSpeedMmS)
        const depositTime = (sMm: number) => {
          let lo = timeAtDistance(Math.max(0, sMm - bound), c, v, a)
          let hi = timeAtDistance(sMm + bound, c, v, a)
          for (let k = 0; k < 60; k++) {
            const mid = 0.5 * (lo + hi)
            if (distanceAtTime(mid, c, v, a) - lag(mid) < sMm) lo = mid
            else hi = mid
          }
          return 0.5 * (lo + hi)
        }
        const count = Math.ceil(lengthMm / LAG_TABLE_STEP_MM) + 2
        const table = new Float64Array(count)
        for (let k = 0; k < count; k++) table[k] = atTime(depositTime(k * LAG_TABLE_STEP_MM))
        lat = (sMm: number) => {
          const x = Math.min(count - 1.000001, sMm / LAG_TABLE_STEP_MM)
          const k = Math.floor(x)
          return table[k] + (x - k) * (table[k + 1] - table[k])
        }
      }
      out.push({ line, horizontal, lat, maxAmpMm: Math.abs(B) + Math.abs(lobeA), lengthMm })
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
    // Straight legs: the run-up in the window (the prime and tail sit under the bands).
    coverage = Math.max(coverage, segmentCoverage(x, y, rl.line.runUp, halfW, sigma))
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
  // The printed (physical) coupon is the commanded one scaled by k about its origin.
  const k = 1 - o.shrink
  const Wc = g.couponWidthMm * k
  const Hc = g.couponHeightMm * k
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
            const { plastic } = couponCoverage(bx / k, by / k, g, lines, o)
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
