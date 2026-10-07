import type { FilamentProfile, PrinterProfile } from '../gcode/profileTypes'
import {
  beadExtrusionMm,
  type Emitter,
  extrude,
  printedSegmentLengthMm,
  quantizeE,
} from '../gcode/emitter'

/** An already-printed straight bead on the current layer, in bed coordinates. */
export interface PrintedBead {
  x0: number
  y0: number
  x1: number
  y1: number
  widthMm: number
}

/**
 * A flow dip along an extrusion move: `atMm` is the crossing point's distance from the
 * move start, `occupiedMm` the stretch of the move's channel the crossed bead occupies.
 */
export interface FlowDip {
  atMm: number
  occupiedMm: number
}

const EPS = 1e-9

/**
 * Crossings of a straight move with already-printed beads, as flow dips sorted along the
 * move. The occupied stretch is the crossed bead's width projected onto the move:
 * w / sin(theta) for a crossing at angle theta (geometric, exact for straight beads);
 * parallel beads never cross.
 */
export function dipsForMove(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  beads: PrintedBead[],
): FlowDip[] {
  const ux = x1 - x0
  const uy = y1 - y0
  const len = Math.hypot(ux, uy)
  if (len < EPS) return []
  const dips: FlowDip[] = []
  for (const b of beads) {
    const vx = b.x1 - b.x0
    const vy = b.y1 - b.y0
    const bLen = Math.hypot(vx, vy)
    if (bLen < EPS) continue
    const denom = ux * vy - uy * vx
    const sinTheta = Math.abs(denom) / (len * bLen)
    if (sinTheta < 1e-6) continue
    const wx = b.x0 - x0
    const wy = b.y0 - y0
    const s = (wx * vy - wy * vx) / denom
    const t = (wx * uy - wy * ux) / denom
    if (s < -EPS || s > 1 + EPS || t < -EPS || t > 1 + EPS) continue
    dips.push({ atMm: s * len, occupiedMm: b.widthMm / sinTheta })
  }
  return dips.sort((a, b) => a.atMm - b.atMm)
}

/** Flow factor at distance `s` along the move: 0 over each dip's occupied stretch, a
 *  linear ramp one occupied length long on either side, 1 elsewhere; overlapping dips
 *  combine by the minimum. */
function flowAt(s: number, dips: FlowDip[]): number {
  let flow = 1
  for (const d of dips) {
    const dist = Math.abs(s - d.atMm)
    const g =
      dist <= d.occupiedMm / 2
        ? 0
        : dist <= 1.5 * d.occupiedMm
          ? (dist - d.occupiedMm / 2) / d.occupiedMm
          : 1
    flow = Math.min(flow, g)
  }
  return flow
}

/**
 * Extrude a straight move whose channel is already occupied at the given dips. Where the
 * nozzle passes over an existing bead the correct flow is zero (extrude only the
 * unoccupied cross-section: the same physics as ironing), so the emission is split into
 * full flow, a linear ramp down to zero over one occupied length before the crossing,
 * zero E over the occupied length centered on it, a linear ramp back up, then full flow.
 * Each ramp is emitted as a SINGLE constant-flow subsegment at half flow: the mean of the
 * linear ramp, which deposits the same volume (a trapezoid approximation). The XY
 * feedrate is constant throughout; only the E rate is modulated.
 */
export function extrudeWithDips(
  e: Emitter,
  p: PrinterProfile,
  f: FilamentProfile,
  lineWidthMm: number,
  x: number,
  y: number,
  speedMmS: number,
  dips: FlowDip[],
): void {
  const len = Math.hypot(x - e.x, y - e.y)
  if (dips.length === 0 || len < EPS) {
    extrude(e, p, f, lineWidthMm, x, y, speedMmS)
    return
  }
  const cuts = new Set<number>([0, len])
  for (const d of dips) {
    const half = d.occupiedMm / 2
    for (const c of [d.atMm - 3 * half, d.atMm - half, d.atMm + half, d.atMm + 3 * half]) {
      if (c > EPS && c < len - EPS) cuts.add(c)
    }
  }
  const stops = [...cuts].sort((a, b) => a - b)
  const sx = e.x
  const sy = e.y
  const ux = (x - e.x) / len
  const uy = (y - e.y) / len
  const feed = Math.round(speedMmS * 60)
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]
    const b = stops[i]
    if (b - a < EPS) continue
    // Land the last subsegment exactly on the commanded endpoint.
    const nx = i === stops.length - 1 ? x : sx + ux * b
    const ny = i === stops.length - 1 ? y : sy + uy * b
    // The flow profile is piecewise linear between cuts, so the midpoint is its mean.
    const flow = flowAt((a + b) / 2, dips)
    if (flow < EPS) {
      e.lines.push(`G1 X${nx.toFixed(3)} Y${ny.toFixed(3)} F${feed}`)
    } else {
      // The subsegment's E is computed and quantized exactly as extrude does for a whole move.
      const len = printedSegmentLengthMm(e.x, e.y, nx, ny)
      const eAmt = quantizeE(flow * beadExtrusionMm(p, f, len, lineWidthMm))
      e.lines.push(`G1 X${nx.toFixed(3)} Y${ny.toFixed(3)} E${eAmt.toFixed(5)} F${feed}`)
    }
    e.x = nx
    e.y = ny
  }
}
