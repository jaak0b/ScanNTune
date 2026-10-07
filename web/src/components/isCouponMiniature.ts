// Shared geometry for the input shaper scan diagrams: the coupon miniature is computed
// from the engine's real coupon layout (default spec on the default printer profile), so
// the pictogram's plate, window, fiducial holes, and test lines match the actual print
// by construction.
import { isCouponGeometry } from '../engine/is/couponGeometry'
import { defaultIsTestSpec } from '../engine/is/types'
import { defaultPrinterProfile } from '../engine/gcode/profileTypes'

export interface MiniatureRect {
  x: number
  y: number
  width: number
  height: number
}

export interface IsCouponMiniature {
  /** The coupon outline in SVG pixels. */
  plate: MiniatureRect
  /** The open interior of the frame (rendered as a cutout showing the backing). */
  window: MiniatureRect
  /** The three fiducial holes; the fourth corner has none and marks the origin. */
  fiducials: MiniatureRect[]
  /** One SVG polyline `points` string per test line: run-up start, corner, measured end. */
  linePoints: string[]
  /** The printed bead pitch in SVG pixels, a sane stroke-width reference. */
  pitchPx: number
}

/**
 * Lays the engine-computed coupon out inside a square of `sidePx` pixels centered on
 * (cx, cy), mapping coupon millimetres to SVG pixels with y pointing down (so the
 * holeless origin corner lands at the top left, matching a face-down scan).
 */
export function isCouponMiniature(cx: number, cy: number, sidePx: number): IsCouponMiniature {
  const spec = defaultIsTestSpec(defaultPrinterProfile())
  const g = isCouponGeometry(spec)
  const s = sidePx / Math.max(g.couponWidthMm, g.couponHeightMm)
  const x0 = cx - (g.couponWidthMm * s) / 2
  const y0 = cy - (g.couponHeightMm * s) / 2
  const X = (mm: number) => x0 + mm * s
  const Y = (mm: number) => y0 + mm * s

  const fidPx = g.fiducialSizeMm * s
  return {
    plate: { x: x0, y: y0, width: g.couponWidthMm * s, height: g.couponHeightMm * s },
    window: {
      x: X(g.windowBox.x0),
      y: Y(g.windowBox.y0),
      width: (g.windowBox.x1 - g.windowBox.x0) * s,
      height: (g.windowBox.y1 - g.windowBox.y0) * s,
    },
    fiducials: g.fiducials.map((f) => ({
      x: X(f.xMm) - fidPx / 2,
      y: Y(f.yMm) - fidPx / 2,
      width: fidPx,
      height: fidPx,
    })),
    linePoints: g.groups.flatMap((group) =>
      group.lines.map((l) =>
        [
          `${X(l.runUp.x0)},${Y(l.runUp.y0)}`,
          `${X(l.runUp.x1)},${Y(l.runUp.y1)}`,
          `${X(l.measured.x1)},${Y(l.measured.y1)}`,
        ].join(' '),
      ),
    ),
    pitchPx: spec.linePitchMm * s,
  }
}
