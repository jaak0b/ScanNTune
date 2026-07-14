// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { selectCornerHoles } from '../../src/engine/cornerFiducialSolver'
import type { Point } from '../../src/engine/cornerFiducialSolver'

// The EM coupon's nominal fiducial layout (corner-adjacent hole second).
const nominal = [
  { xMm: 90.7, yMm: 6.5 },
  { xMm: 90.7, yMm: 71.5 },
  { xMm: 6.5, yMm: 71.5 },
]
const pxPerMm = 10
const trueHoles: Point[] = nominal.map((f) => ({ x: f.xMm * pxPerMm, y: f.yMm * pxPerMm }))

describe('selectCornerHoles', () => {
  it('accepts exactly three candidates that match the layout', () => {
    const r = selectCornerHoles(trueHoles, nominal, pxPerMm)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.holes).toEqual(trueHoles)
  })

  it('rejects exactly three candidates when one sits far off the layout', () => {
    const displaced: Point[] = [
      trueHoles[0],
      trueHoles[1],
      { x: trueHoles[1].x + 150, y: trueHoles[1].y + 150 },
    ]
    const r = selectCornerHoles(displaced, nominal, pxPerMm)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('No three of the detected holes')
  })

  it('fails with a hole-count reason on fewer than three candidates', () => {
    const r = selectCornerHoles(trueHoles.slice(0, 2), nominal, pxPerMm)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('found 2')
  })

  it('selects the fiducial triple among speckle blobs by its mutual geometry', () => {
    const speckle: Point[] = [
      { x: 200, y: 200 },
      { x: 350, y: 410 },
      { x: 780, y: 300 },
      { x: 460, y: 655 },
      { x: 640, y: 120 },
    ]
    const r = selectCornerHoles([...speckle, ...trueHoles], nominal, pxPerMm)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.holes).toEqual(trueHoles)
  })

  it('rejects a triple whose shape matches at a scale the plate contradicts', () => {
    // Same shape at half the scale: the pairwise ratios agree with each other but not with
    // the plate-derived px/mm.
    const shrunk = trueHoles.map((h) => ({ x: h.x / 2, y: h.y / 2 }))
    const r = selectCornerHoles([...shrunk, { x: 30, y: 40 }], nominal, pxPerMm)
    expect(r.ok).toBe(false)
  })

  it('fails as ambiguous when two disjoint triples both match the layout', () => {
    const shifted = trueHoles.map((h) => ({ x: h.x + 1500, y: h.y + 1500 }))
    const r = selectCornerHoles([...trueHoles, ...shifted], nominal, pxPerMm)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('Several hole patterns')
  })

  it('refuses a candidate flood', () => {
    const flood: Point[] = Array.from({ length: 41 }, (_, i) => ({ x: i * 13, y: i * 7 }))
    const r = selectCornerHoles(flood, nominal, pxPerMm)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('too many')
  })
})
