import { describe, it, expect } from 'vitest'
import { ringSeverity, clippedSides } from '../../src/engine/scanDiagnostics'
import { defaultCouponSpec } from '../../src/engine/types'
import type { AffineModel, GridCorrespondence } from '../../src/engine/types'

// clippedSides is derived from the fitted grid model, not from a proximity heuristic: a grid
// position that SHOULD hold a hole but has no detected ring is projected through the fitted affine,
// and a side is flagged when that hole's disk would cross (or fall past) the image border.

const spec = defaultCouponSpec() // 5x5, 100 mm baseline -> 25 mm pitch, 5 mm hole diameter
const PX_PER_MM = 10

// An axis-aligned identity-shaped fit: px = 10*mmX + ox, py = 10*mmY + oy.
function affine(ox: number, oy: number): AffineModel {
  return {
    scaleXPxPerMm: PX_PER_MM,
    scaleYPxPerMm: PX_PER_MM,
    skewDegrees: 0,
    rmsResidualPx: 0,
    pointCount: 23,
    a: PX_PER_MM,
    b: 0,
    c: 0,
    d: PX_PER_MM,
    tx: ox,
    ty: oy,
  }
}

// Every grid vertex except the two solid markers (0,0)/(1,0) and the listed missing holes.
function grid(ox: number, oy: number, missing: Array<[number, number]>): GridCorrespondence[] {
  const points: GridCorrespondence[] = []
  for (let c = 0; c < spec.gridN; c++) {
    for (let r = 0; r < spec.gridN; r++) {
      if ((c === 0 || c === 1) && r === 0) continue // solid markers, never holes
      if (missing.some(([mc, mr]) => mc === c && mr === r)) continue
      points.push({
        col: c,
        row: r,
        nominalXmm: c * 25,
        nominalYmm: r * 25,
        measuredXpx: ox + c * 25 * PX_PER_MM,
        measuredYpx: oy + r * 25 * PX_PER_MM,
      })
    }
  }
  return points
}

describe('ringSeverity', () => {
  it('is green when aligned and every hole registered', () => {
    expect(ringSeverity(23, 23, true)).toBe('ok')
  })

  it('warns when aligned but one hole is missing (the stray tolerance)', () => {
    expect(ringSeverity(22, 23, true)).toBe('warning')
  })

  it('is red when the scan did not align, whatever the count', () => {
    expect(ringSeverity(13, 23, false)).toBe('error')
    expect(ringSeverity(23, 23, false)).toBe('error')
  })
})

describe('clippedSides', () => {
  // The grid spans 1000 px; a hole is 5 mm across, so its disk reaches 25 px past its centre.
  it('flags the side where a missing hole would cross the image border', () => {
    // Right-edge column sits at x = 60 + 1000 = 1060; the image ends at 1080, inside the 25 px disk.
    const points = grid(60, 500, [[4, 2]])
    expect(clippedSides(spec, points, affine(60, 500), 1080, 2000)).toEqual(['right'])
  })

  it('flags the side even when the missing hole is entirely off-image', () => {
    // Left column at x = 10 - 250 = -240: off the left edge.
    const points = grid(-240, 500, [[0, 3]])
    expect(clippedSides(spec, points, affine(-240, 500), 1000, 2000)).toEqual(['left'])
  })

  it('is empty when the missing hole is interior (a genuine detection miss, not clipping)', () => {
    const points = grid(200, 200, [[2, 2]])
    expect(clippedSides(spec, points, affine(200, 200), 1500, 1500)).toEqual([])
  })

  it('is empty when no hole is missing', () => {
    const points = grid(60, 500, [])
    expect(clippedSides(spec, points, affine(60, 500), 1080, 2000)).toEqual([])
  })
})
