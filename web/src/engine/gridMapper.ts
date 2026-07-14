import type { CouponSpec, DetectedRing, GridCorrespondence, GridMapping } from './types'
import { couponPitchMm } from './types'
import { median } from './math'

// Estimates the grid axes/pitch from nearest-neighbour vectors, indexes the rings, then resolves
// orientation from the two-solid marker: the coupon's origin-corner ring AND its neighbour are
// printed solid (no hole), so they show up as two adjacent grid vertices with no detected ring.
// origin -> neighbour is the coupon's +X, which pins orientation at ANY rotation and flip. The
// marker is required; if it can't be located the scan is rejected (no rotation-only fallback).

// A grid-fit rejection carrying how far through the mapping pipeline the ring set got (higher
// stage means further: enough rings, pitch estimated, grid populated, marker located). The
// analyzer uses the stage to pick which failed threshold-band hypothesis to report, the same
// deepest-failure model the other flows apply to their band sweeps.
export class GridMapError extends Error {
  constructor(
    message: string,
    readonly stage: number,
  ) {
    super(message)
    this.name = 'GridMapError'
  }
}

interface Vec {
  x: number
  y: number
}

interface Geometry {
  u: Vec
  v: Vec
  pitchPx: number
  cx: number
  cy: number
}

export function mapGrid(rings: readonly DetectedRing[], spec: CouponSpec): GridMapping {
  if (rings.length < 4)
    throw new GridMapError(`Need at least 4 rings to fit a grid, found ${rings.length}.`, 0)

  const points: Vec[] = rings.map((r) => ({ x: r.centerX, y: r.centerY }))
  const n = points.length
  const geo = estimateGeometry(points)
  if (geo.pitchPx <= 0) throw new GridMapError('Could not estimate a positive grid pitch.', 1)

  // theta is folded into (-45, 45], so colHat points +x and rowHat points +y (image-y down).
  const colHat = geo.u
  const rowHat = geo.v

  const col = new Array<number>(n)
  const row = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const rx = points[i].x - geo.cx
    const ry = points[i].y - geo.cy
    col[i] = Math.round((rx * colHat.x + ry * colHat.y) / geo.pitchPx)
    row[i] = Math.round((rx * rowHat.x + ry * rowHat.y) / geo.pitchPx)
  }

  const minCol = Math.min(...col)
  const minRow = Math.min(...row)
  for (let i = 0; i < n; i++) {
    col[i] -= minCol
    row[i] -= minRow
  }
  const maxCol = Math.max(...col)
  const maxRow = Math.max(...row)

  const occupied = new Set<string>()
  for (let i = 0; i < n; i++) occupied.add(key(col[i], row[i]))

  // The two solid marker vertices are always missing; tolerate at most ONE stray missed hole on
  // top. Beyond that the marker search can silently land on the wrong corner. Count against the
  // SPECIFIED grid, not the detected extent (a fully missed outer row shrinks the extent).
  const missing = spec.gridN * spec.gridN - occupied.size
  if (missing > 3)
    throw new GridMapError(
      `${missing} grid positions are missing a detected ring; only the two solid marker ` +
        'rings plus one stray miss are tolerated. Check the scan quality and contrast.',
      2,
    )

  const marker = findMarker(occupied, maxCol, maxRow)
  if (marker.found === 0)
    throw new GridMapError(
      'Could not locate the two solid orientation rings (an origin corner plus its neighbour). ' +
        'Check the scan quality and that the coupon carries the orientation marker.',
      3,
    )
  if (marker.found > 1)
    throw new GridMapError(
      'The orientation marker is ambiguous: more than one corner has a missing neighbour, ' +
        'so the +X direction cannot be determined (a hole next to a corner may have gone ' +
        'undetected). Rescan with better contrast.',
      4,
    )

  const g00 = originOfIndexSpace(points, col, row, colHat, rowHat, geo.pitchPx)
  const originPx: Vec = {
    x: g00.x + marker.origin.c * geo.pitchPx * colHat.x + marker.origin.r * geo.pitchPx * rowHat.x,
    y: g00.y + marker.origin.c * geo.pitchPx * colHat.y + marker.origin.r * geo.pitchPx * rowHat.y,
  }

  const xHat: Vec = {
    x: marker.toNeighbour.dc * colHat.x + marker.toNeighbour.dr * rowHat.x,
    y: marker.toNeighbour.dc * colHat.y + marker.toNeighbour.dr * rowHat.y,
  }
  let perp: Vec = Math.abs(xHat.x * colHat.x + xHat.y * colHat.y) > 0.5 ? rowHat : colHat
  if (perp.x * (geo.cx - originPx.x) + perp.y * (geo.cy - originPx.y) < 0) perp = { x: -perp.x, y: -perp.y }
  const yHat = perp

  // Flip (informational): the chirality of the recovered (+X, +Y) pair in image coordinates.
  // A flatbed scanner images the face lying on the glass from below, which mirrors the coupon:
  // with image y pointing down, the designed scan face on the glass (the first layer, for the
  // flat plate) makes cross(xHat, yHat) positive. A negative cross means the plate was scanned
  // on its wrong face, so flipped = true.
  const flipped = xHat.x * yHat.y - xHat.y * yHat.x < 0

  const pitchMm = couponPitchMm(spec)
  const mapped: GridCorrespondence[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const dx = points[i].x - originPx.x
    const dy = points[i].y - originPx.y
    const xi = Math.round((dx * xHat.x + dy * xHat.y) / geo.pitchPx)
    const yi = Math.round((dx * yHat.x + dy * yHat.y) / geo.pitchPx)
    mapped[i] = {
      col: xi,
      row: yi,
      nominalXmm: xi * pitchMm,
      nominalYmm: yi * pitchMm,
      measuredXpx: points[i].x,
      measuredYpx: points[i].y,
    }
  }

  return {
    points: mapped,
    originX: originPx.x,
    originY: originPx.y,
    xAxisX: xHat.x,
    xAxisY: xHat.y,
    flipped,
  }
}

interface Marker {
  found: number
  origin: { c: number; r: number }
  toNeighbour: { dc: number; dr: number }
}

// The two solid rings are two missing grid vertices: a corner and one edge-neighbour. Counts every
// such (corner, neighbour) pair; the marker is only trustworthy when the count is exactly 1.
function findMarker(occupied: Set<string>, maxCol: number, maxRow: number): Marker {
  const steps: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]
  let found = 0
  let origin = { c: 0, r: 0 }
  let toNeighbour = { dc: 0, dr: 0 }
  for (let c = 0; c <= maxCol; c++) {
    for (let r = 0; r <= maxRow; r++) {
      if (occupied.has(key(c, r)) || !isCorner(c, r, maxCol, maxRow)) continue
      for (const [dc, dr] of steps) {
        const nc = c + dc
        const nr = r + dr
        if (nc < 0 || nc > maxCol || nr < 0 || nr > maxRow) continue
        if (occupied.has(key(nc, nr))) continue
        found++
        origin = { c, r }
        toNeighbour = { dc, dr }
      }
    }
  }
  return { found, origin, toNeighbour }
}

function isCorner(c: number, r: number, maxCol: number, maxRow: number): boolean {
  return (c === 0 || c === maxCol) && (r === 0 || r === maxRow)
}

function originOfIndexSpace(
  points: Vec[],
  col: number[],
  row: number[],
  colHat: Vec,
  rowHat: Vec,
  pitchPx: number,
): Vec {
  let ox = 0
  let oy = 0
  for (let i = 0; i < points.length; i++) {
    ox += points[i].x - (col[i] * pitchPx * colHat.x + row[i] * pitchPx * rowHat.x)
    oy += points[i].y - (col[i] * pitchPx * colHat.y + row[i] * pitchPx * rowHat.y)
  }
  return { x: ox / points.length, y: oy / points.length }
}

function estimateGeometry(points: Vec[]): Geometry {
  const n = points.length
  let sum4Cos = 0
  let sum4Sin = 0
  const neighbourDistances: number[] = []

  for (let i = 0; i < n; i++) {
    let best = Number.MAX_VALUE
    let bestJ = -1
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      const dx = points[j].x - points[i].x
      const dy = points[j].y - points[i].y
      const d2 = dx * dx + dy * dy
      if (d2 < best) {
        best = d2
        bestJ = j
      }
    }
    const vx = points[bestJ].x - points[i].x
    const vy = points[bestJ].y - points[i].y
    neighbourDistances.push(Math.sqrt(vx * vx + vy * vy))
    const angle = Math.atan2(vy, vx)
    sum4Cos += Math.cos(4 * angle) // 4x maps the 90-degree grid symmetry onto a full circle
    sum4Sin += Math.sin(4 * angle)
  }

  const theta = Math.atan2(sum4Sin, sum4Cos) / 4.0 // in (-45, 45]
  const u: Vec = { x: Math.cos(theta), y: Math.sin(theta) }
  const v: Vec = { x: -Math.sin(theta), y: Math.cos(theta) }
  const cx = points.reduce((s, p) => s + p.x, 0) / n
  const cy = points.reduce((s, p) => s + p.y, 0) / n
  return { u, v, pitchPx: median(neighbourDistances), cx, cy }
}

function key(c: number, r: number): string {
  return `${c},${r}`
}
