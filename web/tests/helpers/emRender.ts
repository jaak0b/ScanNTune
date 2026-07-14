import type { RgbaImage } from '../../src/engine/imageData'
import type { EmTestSpec } from '../../src/engine/em/types'
import { ANCHOR_OVERLAP_MM } from '../../src/engine/em/gcodeGenerator'
import { emCouponGeometry } from '../../src/engine/em/types'

export interface EmRenderOptions {
  spec: EmTestSpec
  /** Ground-truth deposited bead width in mm (the value the pipeline must recover). */
  trueWidthMm: number
  pxPerMm?: number
  rotationDegrees?: number
  quarterTurns?: 0 | 1 | 2 | 3
  flipped?: boolean
  noiseSigma?: number
  blurSigmaMm?: number
  plasticGray?: number
  backgroundGray?: number
  /**
   * RGB colors overriding the corresponding gray tones, for rendering a colored coupon (e.g.
   * saturated yellow plastic on a white backing, whose value channel carries no contrast).
   * Undefined means the neutral gray render, the current behavior. Setting `baseColor` puts a
   * base behind the window interior the same way setting `baseGray` does.
   */
  plasticColor?: [number, number, number]
  backgroundColor?: [number, number, number]
  baseColor?: [number, number, number]
  /**
   * Gray tone of a contrasting-color base backing the window interior (gaps, separators,
   * margins). Undefined means no base: the interior shows `backgroundGray`, the current
   * behavior. The three fiducial holes are through-holes and always show `backgroundGray`.
   */
  baseGray?: number
  /** Uniform pitch scale simulating printer axis stretch (default 1). */
  pitchScale?: number
  marginMm?: number
  /**
   * Injects a one-sided scanner-lamp penumbra: the named flank of every test line gets an edge
   * spread widened by `extraSigmaMm`, modelling the shadow skirt a flatbed lamp casts across gaps.
   * `side` is the shadowed flank in increasing profile x ('left' = the background-to-plastic edge,
   * 'right' = the plastic-to-background edge). Absent means a symmetric edge (unchanged output).
   */
  shadow?: { side: 'left' | 'right'; extraSigmaMm: number }
  /**
   * One-sided scanner-lamp shading, fixed in IMAGE space: `lampSide` is the image side the lamp
   * illuminates from, independent of how the coupon lies on the glass. A shading that only
   * darkened a fixed image side of each gap would bias both 180-degree orientations identically
   * (the rotated coupon presents a congruent scene), which is not what real scans show; the
   * observed sign flip comes from the lamp meeting the printed bead's asymmetric flank. Every
   * bead's coupon +X flank is modelled as the sloped one: it casts a shadow skirt into the gap
   * when it faces away from the lamp and catches a bright glare fringe when it faces the lamp,
   * so the width bias flips sign when the coupon turns 180 degrees on the glass. `extraSigmaMm`
   * sets the disturbance reach (the strength). Requires the comb lines to render vertically in
   * the image (0 or 2 quarter turns). Absent means no shading (unchanged output).
   */
  lampShading?: { lampSide: 'left' | 'right'; extraSigmaMm: number }
}

type OptionalKeys =
  | 'baseGray'
  | 'shadow'
  | 'lampShading'
  | 'plasticColor'
  | 'backgroundColor'
  | 'baseColor'

type Resolved = Required<Omit<EmRenderOptions, OptionalKeys>> &
  Pick<EmRenderOptions, OptionalKeys>

const DEFAULTS: Omit<Resolved, 'spec' | 'trueWidthMm'> = {
  pxPerMm: 12,
  rotationDegrees: 0,
  quarterTurns: 0,
  flipped: false,
  noiseSigma: 0,
  blurSigmaMm: 0.04,
  plasticGray: 40,
  backgroundGray: 245,
  pitchScale: 1,
  marginMm: 8,
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

/**
 * Linear coverage ramp centered on an edge: `d` is the signed distance (mm) from the edge,
 * positive meaning inside the covered region. A box-filter approximation of edge blur: full
 * coverage `sigma` mm inside, zero `sigma` mm outside, linear between (deterministic, cheap,
 * and matches the coupon's real scan softness closely enough to validate the pipeline).
 */
function softEdge(d: number, sigma: number): number {
  if (sigma <= 0) return d >= 0 ? 1 : 0
  return Math.max(0, Math.min(1, 0.5 + d / sigma))
}

// Peak coverage of an injected one-sided shadow skirt, kept below the 0.5 plastic-vs-gap mid level
// so the skirt darkens the gap without moving the edge's mid-level crossing. The glare fringe of
// lampShading uses the same peak mirrored into the plastic (coverage dips to 1 - SKIRT_PEAK, still
// above mid), so shadow and glare pull the edge centroid by the same magnitude in opposite
// directions.
const SKIRT_PEAK = 0.4

/** The disturbance one coupon-space flank of every test line carries. */
interface FlankEffect {
  kind: 'shadow' | 'glare'
  reachMm: number
}

interface FlankEffects {
  left?: FlankEffect
  right?: FlankEffect
}

// Resolves the shading options into per-coupon-flank disturbances. `shadow` is coupon-anchored
// directly; `lampShading` is image-anchored and resolves through the coupon's orientation: the
// bead's sloped coupon +X flank shadows the gap when it faces away from the lamp and glares when
// it faces the lamp.
function resolveFlankEffects(o: Resolved, cos: number): FlankEffects {
  if (o.shadow && o.lampShading) {
    throw new Error('Use either the shadow option or the lampShading option, not both.')
  }
  if (o.shadow) {
    const effect: FlankEffect = { kind: 'shadow', reachMm: o.shadow.extraSigmaMm }
    return o.shadow.side === 'left' ? { left: effect } : { right: effect }
  }
  if (!o.lampShading) return {}
  // d(coupon x)/d(image x): the image direction the coupon's +X axis (and flank) faces.
  const axis = (o.flipped ? -1 : 1) * cos
  if (Math.abs(axis) < 1e-9) {
    throw new Error(
      'lampShading requires the comb lines to render vertically in the image (0 or 2 quarter turns).',
    )
  }
  const facesImage = axis > 0 ? 'right' : 'left'
  return {
    right: {
      kind: facesImage === o.lampShading.lampSide ? 'glare' : 'shadow',
      reachMm: o.lampShading.extraSigmaMm,
    },
  }
}

/** Coverage (0..1) of an axis-aligned box, softened at its edges by `sigma` mm. */
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

/** One comb row's test-line centers, pre-scaled and sorted, for windowed lookup per sample. */
interface RowLines {
  y0: number
  y1: number
  centers: Float64Array
}

// Precomputes the per-row sorted line centers and the widest x-window (mm) within which a line
// can still influence a sample: half the bead width plus the larger of the edge blur and any
// disturbance reach. Outside that window a line's contribution is exactly zero, so culling by
// the window leaves the rendered image bit-identical while skipping almost every line.
function precomputeRows(
  g: ReturnType<typeof emCouponGeometry>,
  o: Resolved,
  effects: FlankEffects,
): { rows: RowLines[]; windowMm: number } {
  const rows: RowLines[] = [
    { blocks: g.topRow, y0: g.topRowY0Mm - ANCHOR_OVERLAP_MM, y1: g.topRowY1Mm + ANCHOR_OVERLAP_MM },
    {
      blocks: g.bottomRow,
      y0: g.bottomRowY0Mm - ANCHOR_OVERLAP_MM,
      y1: g.bottomRowY1Mm + ANCHOR_OVERLAP_MM,
    },
  ].map((row) => {
    const centers = row.blocks.flatMap((block) => block.lineXsMm.map((x) => x * o.pitchScale))
    centers.sort((a, b) => a - b)
    return { y0: row.y0, y1: row.y1, centers: Float64Array.from(centers) }
  })
  const reach = Math.max(
    o.blurSigmaMm,
    effects.left?.reachMm ?? 0,
    effects.right?.reachMm ?? 0,
  )
  return { rows, windowMm: o.trueWidthMm / 2 + reach }
}

/** Index of the first element of the sorted array not below `value`. */
function lowerBound(sorted: Float64Array, value: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Fractional plastic coverage (0..1) at a coupon-frame point, per the EM coupon model in
 * `src/engine/em/types.ts`: an outer frame band, a center rail, two comb rows of test lines,
 * and three fiducial holes cut through the band. `pitchScale` simulates a stretched X axis: it
 * scales every coupon x-coordinate (band/rail/window/fiducial/line positions), not line widths.
 */
function couponCoverage(
  x: number,
  y: number,
  g: ReturnType<typeof emCouponGeometry>,
  o: Resolved,
  effects: FlankEffects,
  rowLines: RowLines[],
  windowMm: number,
): { plastic: number; hole: number } {
  const sigma = o.blurSigmaMm
  const scaleX = (xMm: number) => xMm * o.pitchScale
  const Wc = scaleX(g.couponWidthMm)
  const Hc = g.couponHeightMm
  const band = g.frameBandMm

  const bandTop = boxCoverage(x, y, 0, 0, Wc, band, sigma)
  const bandBottom = boxCoverage(x, y, 0, Hc - band, Wc, Hc, sigma)
  const bandLeft = boxCoverage(x, y, 0, 0, scaleX(band), Hc, sigma)
  const bandRight = boxCoverage(x, y, Wc - scaleX(band), 0, Wc, Hc, sigma)
  let coverage = Math.max(bandTop, bandBottom, bandLeft, bandRight)

  const railCoverage = boxCoverage(x, y, scaleX(band), g.railY0Mm, Wc - scaleX(band), g.railY1Mm, sigma)
  coverage = Math.max(coverage, railCoverage)

  for (const row of rowLines) {
    if (y < row.y0 - sigma || y > row.y1 + sigma) continue
    const rowCoverage = softEdge(Math.min(y - row.y0, row.y1 - y), sigma)
    if (rowCoverage <= 0) continue
    // Only line centers within the influence window of x can contribute; the rest are the
    // exact zero-contribution cases the per-line distance check would have skipped.
    const from = lowerBound(row.centers, x - windowMm)
    for (let li = from; li < row.centers.length && row.centers[li] <= x + windowMm; li++) {
      const c = row.centers[li]
      const half = o.trueWidthMm / 2
      // Signed distance into the line (positive inside plastic, negative in the adjacent gap).
      const d = half - Math.abs(x - c)
      const effect = x < c ? effects.left : effects.right
      const reach = effect?.kind === 'shadow' ? effect.reachMm : 0
      if (d < -sigma && d < -reach) continue
      // The real plastic edge stays sharp (the mid-level crossing sits on the true edge). The
      // disturbances stay on the far side of the 0.5 mid level, confined to the band from
      // `sigma` (just past the sharp edge, so the two samples straddling the mid-level crossing
      // stay clean and the crossing stays on the true edge) out to the effect's reach (kept
      // inside the centroid window). A smooth triangular deviation peaks mid-band; its gradient,
      // seen by the wider centroid window but not by the local crossing, pulls the centroid
      // without moving the crossing: the sub-pixel bias a real lamp imprints.
      let edge = softEdge(d, sigma)
      if (effect && effect.reachMm > sigma) {
        if (effect.kind === 'shadow' && d < -sigma && d > -effect.reachMm) {
          // Sub-mid shadow skirt in the gap next to this flank: pulls the centroid outward into
          // the gap, so the gap reads narrower and the bead wider.
          const u = (-d - sigma) / (effect.reachMm - sigma) // 0 at the inner band edge, 1 outer
          edge = Math.max(edge, SKIRT_PEAK * (1 - Math.abs(2 * u - 1)))
        } else if (effect.kind === 'glare' && d > sigma && d < effect.reachMm) {
          // Above-mid glare fringe on the plastic slope facing the lamp: pulls the centroid
          // inward into the plastic, so the gap reads wider and the bead narrower.
          const u = (d - sigma) / (effect.reachMm - sigma)
          edge = Math.min(edge, 1 - SKIRT_PEAK * (1 - Math.abs(2 * u - 1)))
        }
      }
      coverage = Math.max(coverage, Math.min(rowCoverage, edge))
    }
  }

  let holeCoverage = 0
  for (const f of g.fiducials) {
    const fx = scaleX(f.xMm)
    const half = g.fiducialSizeMm / 2
    holeCoverage = Math.max(
      holeCoverage,
      boxCoverage(x, y, fx - half, f.yMm - half, fx + half, f.yMm + half, sigma),
    )
  }

  return {
    plastic: Math.max(0, Math.min(1, coverage - holeCoverage)),
    hole: Math.max(0, Math.min(1, holeCoverage)),
  }
}

export function renderEmScan(options: EmRenderOptions): RgbaImage {
  const o: Resolved = { ...DEFAULTS, ...options }
  const g = emCouponGeometry(o.spec)
  const Wc = g.couponWidthMm * o.pitchScale
  const Hc = g.couponHeightMm
  const w0Mm = Wc + 2 * o.marginMm
  const h0Mm = Hc + 2 * o.marginMm
  const rad = ((o.rotationDegrees + o.quarterTurns * 90) * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const effects = resolveFlankEffects(o, cos)
  const { rows, windowMm } = precomputeRows(g, o, effects)
  const wMm = Math.abs(cos) * w0Mm + Math.abs(sin) * h0Mm
  const hMm = Math.abs(sin) * w0Mm + Math.abs(cos) * h0Mm
  const width = Math.round(wMm * o.pxPerMm)
  const height = Math.round(hMm * o.pxPerMm)
  const cx = wMm / 2
  const cy = hMm / 2
  const rand = rng(1234567)
  const data = new Uint8ClampedArray(width * height * 4)

  // Each surface is an RGB triple; a gray option is the neutral triple, a color option (for a
  // colored coupon render) overrides it. The coverage mixing is linear per channel, so the gray
  // render is exactly the old single-channel output replicated to RGB.
  const gray3 = (v: number): [number, number, number] => [v, v, v]
  const plasticRgb = o.plasticColor ?? gray3(o.plasticGray)
  const backgroundRgb = o.backgroundColor ?? gray3(o.backgroundGray)
  const baseRgb = o.baseColor ?? (o.baseGray === undefined ? undefined : gray3(o.baseGray))

  const S = 3
  const acc = [0, 0, 0]
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      acc[0] = acc[1] = acc[2] = 0
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const imx = (px + (sx + 0.5) / S) / o.pxPerMm
          const imy = (py + (sy + 0.5) / S) / o.pxPerMm
          let mx = cos * (imx - cx) + sin * (imy - cy) + w0Mm / 2
          const my = -sin * (imx - cx) + cos * (imy - cy) + h0Mm / 2
          if (o.flipped) mx = w0Mm - mx
          const bx = mx - o.marginMm
          const by = my - o.marginMm
          if (bx < 0 || by < 0 || bx > Wc || by > Hc) {
            for (let c = 0; c < 3; c++) acc[c] += backgroundRgb[c]
          } else {
            const { plastic, hole } = couponCoverage(bx, by, g, o, effects, rows, windowMm)
            // The stack, top to bottom: plastic, then the contrasting base (if any) backing
            // the window interior, then the scanner background showing through the fiducial
            // through-holes and where there is no base.
            const backing = baseRgb ?? backgroundRgb
            for (let c = 0; c < 3; c++) {
              const behind = hole * backgroundRgb[c] + (1 - hole) * backing[c]
              acc[c] += plastic * plasticRgb[c] + (1 - plastic) * behind
            }
          }
        }
      }
      // One noise draw per pixel across the channels, matching the single-channel render's
      // statistics (a scanner's luminance noise, not independent chroma noise).
      const noise = o.noiseSigma > 0 ? gauss(rand) * o.noiseSigma : 0
      const i = (py * width + px) * 4
      for (let c = 0; c < 3; c++) {
        data[i + c] = Math.max(0, Math.min(255, Math.round(acc[c] / (S * S) + noise)))
      }
      data[i + 3] = 255
    }
  }
  return { data, width, height }
}
