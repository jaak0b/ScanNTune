import { describe, expect, it } from 'vitest'
import { defaultFilamentProfile, defaultPrinterProfile } from '../../../src/engine/pa/types'
import { extrusionMm, newEmitter, type Emitter } from '../../../src/engine/gcode/emitter'
import { dipsForMove, extrudeWithDips } from '../../../src/engine/is/crossings'

const profile = defaultPrinterProfile()
const filament = defaultFilamentProfile()

describe('dipsForMove', () => {
  it('finds a perpendicular crossing with the bead width as the occupied length', () => {
    const dips = dipsForMove(0, 0, 10, 0, [{ x0: 4, y0: -5, x1: 4, y1: 5, widthMm: 0.4 }])
    expect(dips).toHaveLength(1)
    expect(dips[0].atMm).toBeCloseTo(4, 9)
    expect(dips[0].occupiedMm).toBeCloseTo(0.4, 9)
  })
  it('widens the occupied length to w / sin(theta) for an oblique crossing', () => {
    // A 45 degree crossing occupies sqrt(2) bead widths of the move's channel.
    const dips = dipsForMove(0, 0, 10, 0, [{ x0: 4, y0: -1, x1: 6, y1: 1, widthMm: 0.4 }])
    expect(dips).toHaveLength(1)
    expect(dips[0].atMm).toBeCloseTo(5, 9)
    expect(dips[0].occupiedMm).toBeCloseTo(0.4 * Math.SQRT2, 9)
  })
  it('ignores parallel beads and beads outside the move', () => {
    expect(dipsForMove(0, 0, 10, 0, [{ x0: 0, y0: 1, x1: 10, y1: 1, widthMm: 0.4 }])).toEqual([])
    expect(dipsForMove(0, 0, 10, 0, [{ x0: 20, y0: -5, x1: 20, y1: 5, widthMm: 0.4 }])).toEqual([])
    expect(dipsForMove(0, 0, 10, 0, [{ x0: 4, y0: 1, x1: 4, y1: 5, widthMm: 0.4 }])).toEqual([])
  })
  it('sorts multiple crossings along the move', () => {
    const dips = dipsForMove(0, 0, 10, 0, [
      { x0: 7, y0: -1, x1: 7, y1: 1, widthMm: 0.4 },
      { x0: 3, y0: -1, x1: 3, y1: 1, widthMm: 0.4 },
    ])
    expect(dips.map((d) => d.atMm)).toEqual([3, 7])
  })
})

describe('extrudeWithDips', () => {
  const width = 0.42
  const ePerMm = extrusionMm(1, width, profile.layerHeightMm, filament.filamentDiameterMm)

  function run(dips: Parameters<typeof extrudeWithDips>[7]): Emitter {
    const e = newEmitter()
    extrudeWithDips(e, profile, filament, width, 10, 0, 100, dips)
    return e
  }

  it('emits a plain extrusion when there are no dips', () => {
    const e = run([])
    expect(e.lines).toHaveLength(1)
    expect(e.lines[0]).toMatch(/^G1 X10\.000 Y0\.000 E[\d.]+ F6000$/)
  })
  it('splits full, half-flow ramp, zero, half-flow ramp, full at a constant feedrate', () => {
    const e = run([{ atMm: 5, occupiedMm: 1 }])
    // Cuts at 3.5, 4.5, 5.5, 6.5: five subsegments.
    expect(e.lines).toHaveLength(5)
    for (const l of e.lines) expect(l).toMatch(/F6000$/)
    const eOf = (l: string) => Number(l.match(/E([\d.]+)/)?.[1] ?? 0)
    expect(eOf(e.lines[0])).toBeCloseTo(3.5 * ePerMm, 5)
    expect(eOf(e.lines[1])).toBeCloseTo(0.5 * ePerMm, 5) // ramp down: mean half flow
    expect(e.lines[2]).not.toContain('E') // occupied stretch: zero flow
    expect(eOf(e.lines[3])).toBeCloseTo(0.5 * ePerMm, 5) // ramp up
    expect(eOf(e.lines[4])).toBeCloseTo(3.5 * ePerMm, 5)
    expect(e.lines[4]).toContain('X10.000 Y0.000')
    expect(e.x).toBe(10)
    expect(e.y).toBe(0)
  })
  it('deposits the same total volume as the exact trapezoid profile', () => {
    const e = run([{ atMm: 5, occupiedMm: 1 }])
    const total = e.lines.reduce((sum, l) => sum + Number(l.match(/E([\d.]+)/)?.[1] ?? 0), 0)
    // Full length minus the occupied millimetre minus two half-flow ramp halves (2 * 0.5).
    expect(total).toBeCloseTo((10 - 1 - 1) * ePerMm, 4)
  })
})
