import { describe, expect, it } from 'vitest'
import { defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'
import { defaultIsTestSpec, type IsTestSpec } from '../../../src/engine/is/types'
import {
  accelRampMm,
  BLOCK_GAP_MM,
  effectiveRunUpMm,
  FIDUCIAL_INSET_MM,
  FIDUCIAL_SIZE_MM,
  fieldExtentMm,
  INNER_MARGIN_MM,
  isCouponGeometry,
  type IsLine,
  type IsLineGroup,
  LEG_INSET_MM,
  maxPackedRampMm,
  MIN_FRAME_BAND_MM,
  PRIME_MM,
  protectedSpanMm,
  SWEEP_STUB_MM,
  sweepCells,
  type SweepToothSegment,
  sweepLegMm,
  TAIL_EDGE_CLEARANCE_MM,
  TAIL_MARGIN_MM,
} from '../../../src/engine/is/couponGeometry'

const spec = defaultIsTestSpec(defaultPrinterProfile())
const g = isCouponGeometry(spec)

const segLen = (s: { x0: number; y0: number; x1: number; y1: number }) =>
  Math.hypot(s.x1 - s.x0, s.y1 - s.y0)
const segsOf = (l: IsLine) => [l.prime, l.runUp, l.measured, l.tail]

function perpendicularPositions(group: IsLineGroup): number[] {
  return group.lines.map((l) => (group.axis === 'x' ? l.measured.x0 : l.measured.y0))
}

describe('isCouponGeometry fiducials', () => {
  it('places three fiducials and leaves the origin corner solid', () => {
    expect(g.fiducials).toHaveLength(3)
    const nearOrigin = g.fiducials.filter((f) => f.xMm < 20 && f.yMm < 20)
    expect(nearOrigin).toHaveLength(0)
  })
})

describe('isCouponGeometry groups', () => {
  it('builds both groups in print order y then x, one for a single axis', () => {
    expect(g.groups.map((grp) => grp.axis)).toEqual(['y', 'x'])
    const single = isCouponGeometry({ ...spec, axes: ['y'] })
    expect(single.groups.map((grp) => grp.axis)).toEqual(['y'])
    const singleX = isCouponGeometry({ ...spec, axes: ['x'] })
    expect(singleX.groups.map((grp) => grp.axis)).toEqual(['x'])
  })
  it('emits linesPerSpeed lines per tier, tagged with the tier speed', () => {
    for (const group of g.groups) {
      expect(group.lines).toHaveLength(spec.linesPerSpeed * spec.speedsMmS.length)
      for (let i = 0; i < group.lines.length; i++) {
        expect(group.lines[i].speedMmS).toBe(
          spec.speedsMmS[Math.floor(i / spec.linesPerSpeed)],
        )
      }
    }
  })
  it('spaces lines at the pitch inside a tier and adds the gap between tiers', () => {
    for (const group of g.groups) {
      const pos = perpendicularPositions(group)
      for (let i = 1; i < pos.length; i++) {
        const crossesBlock = i % spec.linesPerSpeed === 0
        const expected = crossesBlock ? spec.linePitchMm + BLOCK_GAP_MM : spec.linePitchMm
        expect(Math.abs(pos[i] - pos[i - 1])).toBeCloseTo(expected, 9)
      }
    }
  })
})

describe('isCouponGeometry line paths', () => {
  it('starts every leg one inset inside the outer edge and passes it through a band', () => {
    for (const group of g.groups) {
      for (const line of group.lines) {
        if (group.axis === 'y') {
          // Legs enter vertically up through the bottom band.
          expect(line.prime.y0).toBeCloseTo(LEG_INSET_MM, 9)
          expect(line.prime.y1).toBeLessThan(g.windowBox.y0)
          expect(line.runUp.y1).toBeGreaterThan(g.windowBox.y0)
        } else {
          // Legs enter horizontally through the right band.
          expect(line.prime.x0).toBeCloseTo(g.couponWidthMm - LEG_INSET_MM, 9)
          expect(line.prime.x1).toBeGreaterThan(g.windowBox.x1)
          expect(line.runUp.x1).toBeLessThan(g.windowBox.x1)
        }
      }
    }
  })
  it('keeps every segment of every line inside the coupon outline', () => {
    for (const group of g.groups) {
      for (const line of group.lines) {
        for (const s of segsOf(line)) {
          for (const x of [s.x0, s.x1]) {
            expect(x).toBeGreaterThanOrEqual(0)
            expect(x).toBeLessThanOrEqual(g.couponWidthMm)
          }
          for (const y of [s.y0, s.y1]) {
            expect(y).toBeGreaterThanOrEqual(0)
            expect(y).toBeLessThanOrEqual(g.couponHeightMm)
          }
        }
      }
    }
  })
  it('chains prime, run-up, measured, and tail as one connected path per line', () => {
    for (const group of g.groups) {
      for (const { prime, runUp, measured, tail } of group.lines) {
        expect(prime.x1).toBeCloseTo(runUp.x0, 9)
        expect(prime.y1).toBeCloseTo(runUp.y0, 9)
        // The run-up ends exactly on the ringing corner: there is no slow approach
        // stretch, the cruise runs at the square corner velocity straight into the bend.
        expect(runUp.x1).toBeCloseTo(measured.x0, 9)
        expect(runUp.y1).toBeCloseTo(measured.y0, 9)
        expect(measured.x1).toBeCloseTo(tail.x0, 9)
        expect(measured.y1).toBeCloseTo(tail.y0, 9)
        expect(segLen(prime)).toBeCloseTo(PRIME_MM, 9)
      }
    }
  })
  it('places every corner inside the open window with at least the run-up before it', () => {
    for (const group of g.groups) {
      for (const line of group.lines) {
        const cornerX = line.measured.x0
        const cornerY = line.measured.y0
        expect(cornerX).toBeGreaterThan(g.windowBox.x0)
        expect(cornerX).toBeLessThan(g.windowBox.x1)
        expect(cornerY).toBeGreaterThan(g.windowBox.y0)
        expect(cornerY).toBeLessThan(g.windowBox.y1)
        // In-window approach length (run-up semantics): window edge to the corner.
        const inWindow =
          group.axis === 'y' ? cornerY - g.windowBox.y0 : g.windowBox.x1 - cornerX
        expect(inWindow).toBeGreaterThanOrEqual(spec.runUpMm - 1e-9)
      }
    }
  })
  it('welds every measured segment one weld length into the opposite band', () => {
    const yGroup = g.groups.find((grp) => grp.axis === 'y')!
    for (const { measured } of yGroup.lines) {
      expect(measured.x1).toBeCloseTo(g.windowBox.x1 + spec.weldMm, 9)
    }
    const xGroup = g.groups.find((grp) => grp.axis === 'x')!
    for (const { measured } of xGroup.lines) {
      expect(measured.y1).toBeCloseTo(g.windowBox.y0 - spec.weldMm, 9)
    }
  })
  it('gives every tail the full stopping distance and keeps its stop clear of the edge', () => {
    for (const group of g.groups) {
      for (const { speedMmS, measured, tail } of group.lines) {
        // Physical invariant: the commanded tail absorbs the whole kinematic deceleration
        // plus the planner margin, so no deceleration bleeds into the measured segment.
        expect(segLen(tail)).toBeGreaterThanOrEqual(
          accelRampMm(speedMmS, spec.accelMmS2) + TAIL_MARGIN_MM - 1e-9,
        )
        // The stop point stays under band material, clear of the coupon outer perimeter.
        if (group.axis === 'y') {
          expect(tail.x1).toBeLessThanOrEqual(g.couponWidthMm - TAIL_EDGE_CLEARANCE_MM + 1e-9)
          expect(tail.y1).toBeCloseTo(measured.y1, 9)
        } else {
          expect(tail.y1).toBeGreaterThanOrEqual(TAIL_EDGE_CLEARANCE_MM - 1e-9)
          expect(tail.x1).toBeCloseTo(measured.x1, 9)
        }
      }
    }
  })
  it('measures y lines along +X and x lines along -Y, legs perpendicular to them', () => {
    const yGroup = g.groups.find((grp) => grp.axis === 'y')!
    expect(yGroup.lines[0].measured.x1).toBeGreaterThan(yGroup.lines[0].measured.x0)
    expect(yGroup.lines[0].runUp.y1).toBeGreaterThan(yGroup.lines[0].runUp.y0)
    const xGroup = g.groups.find((grp) => grp.axis === 'x')!
    expect(xGroup.lines[0].measured.y1).toBeLessThan(xGroup.lines[0].measured.y0)
    expect(xGroup.lines[0].runUp.x1).toBeLessThan(xGroup.lines[0].runUp.x0)
  })
  it('bounds every segment of every line inside the group bounding box', () => {
    for (const group of g.groups) {
      for (const line of group.lines) {
        for (const s of segsOf(line)) {
          for (const x of [s.x0, s.x1]) {
            expect(x).toBeGreaterThanOrEqual(group.boundingBox.x0 - 1e-9)
            expect(x).toBeLessThanOrEqual(group.boundingBox.x1 + 1e-9)
          }
          for (const y of [s.y0, s.y1]) {
            expect(y).toBeGreaterThanOrEqual(group.boundingBox.y0 - 1e-9)
            expect(y).toBeLessThanOrEqual(group.boundingBox.y1 + 1e-9)
          }
        }
      }
    }
  })
})

describe('isCouponGeometry crossings and packing', () => {
  const yGroup = g.groups.find((grp) => grp.axis === 'y')!
  const xGroup = g.groups.find((grp) => grp.axis === 'x')!

  it('records the protected span (tier ramp plus clean read length) per line', () => {
    for (const group of g.groups) {
      for (const line of group.lines) {
        expect(line.protectedMm).toBeCloseTo(protectedSpanMm(spec, line.speedMmS), 9)
      }
    }
  })
  it('keeps every X/Y crossing point outside both lines protected spans (per pair)', () => {
    for (const xl of xGroup.lines) {
      for (const yl of yGroup.lines) {
        const crossX = xl.measured.x0
        const crossY = yl.measured.y0
        // The crossing point actually lies on both measured segments.
        expect(crossY).toBeLessThan(xl.measured.y0)
        expect(crossY).toBeGreaterThan(xl.measured.y1)
        expect(crossX).toBeGreaterThan(yl.measured.x0)
        expect(crossX).toBeLessThan(yl.measured.x1)
        // Distance from each corner exceeds that line's protected span with the margin.
        expect(xl.measured.y0 - crossY).toBeGreaterThanOrEqual(
          xl.protectedMm + INNER_MARGIN_MM - 1e-9,
        )
        expect(crossX - yl.measured.x0).toBeGreaterThanOrEqual(
          yl.protectedMm + INNER_MARGIN_MM - 1e-9,
        )
      }
    }
  })
  it('packs per pair: the slowest lines sit nearest the crossing zone in both groups', () => {
    // A two-tier variant: the single-tier default cannot show the tier ordering.
    const multi = isCouponGeometry({ ...spec, speedsMmS: [150, 300] })
    const yG = multi.groups.find((grp) => grp.axis === 'y')!
    const xG = multi.groups.find((grp) => grp.axis === 'x')!
    // Y group: the slowest tier's corners take the largest x (crossed earliest).
    const yFirst = yG.lines[0]
    const yLast = yG.lines[yG.lines.length - 1]
    expect(yFirst.speedMmS).toBeLessThan(yLast.speedMmS)
    expect(yFirst.measured.x0).toBeGreaterThan(yLast.measured.x0)
    // X group: the fastest tier's corners sit highest (deepest protected span above the
    // crossing zone), the slowest lowest.
    const xFirst = xG.lines[0]
    const xLast = xG.lines[xG.lines.length - 1]
    expect(xFirst.speedMmS).toBeLessThan(xLast.speedMmS)
    expect(xFirst.measured.y0).toBeLessThan(xLast.measured.y0)
  })
  it('lists the crossing distances on the second-printed group only, sorted ascending', () => {
    for (const yl of yGroup.lines) expect(yl.crossingsMm).toEqual([])
    for (const xl of xGroup.lines) {
      expect(xl.crossingsMm).toHaveLength(yGroup.lines.length)
      const expected = yGroup.lines
        .map((yl) => xl.measured.y0 - yl.measured.y0)
        .sort((a, b) => a - b)
      xl.crossingsMm.forEach((c, i) => expect(c).toBeCloseTo(expected[i], 9))
      for (const c of xl.crossingsMm) {
        expect(c).toBeGreaterThanOrEqual(xl.protectedMm + INNER_MARGIN_MM - 1e-9)
      }
    }
  })
  it('never crosses a leg with a same-group measured segment', () => {
    for (const group of g.groups) {
      for (const a of group.lines) {
        for (const b of group.lines) {
          if (a === b) continue
          // Leg of a (vertical for y, horizontal for x) versus measured of b.
          if (group.axis === 'y') {
            const legX = a.prime.x0
            const crossesSpan = legX > b.measured.x0 && legX < b.measured.x1
            const crossesHeight = b.measured.y0 < a.measured.y0
            expect(crossesSpan && crossesHeight).toBe(false)
          } else {
            const legY = a.prime.y0
            const crossesSpan = legY < b.measured.y0 && legY > b.measured.y1
            const crossesWidth = b.measured.x0 > a.measured.x0
            expect(crossesSpan && crossesWidth).toBe(false)
          }
        }
      }
    }
  })
})

describe('isCouponGeometry footprint', () => {
  it('sums margins, the packed diagonal, the other field, and the run-up, with no slack', () => {
    const F = fieldExtentMm(spec)
    const packed = maxPackedRampMm(spec) + spec.measuredLineMm
    const interior = 2 * INNER_MARGIN_MM + packed + F + spec.runUpMm
    expect(g.couponWidthMm).toBeCloseTo(interior + 2 * g.frameBandMm, 9)
    expect(g.couponHeightMm).toBeCloseTo(g.couponWidthMm, 9)
    // Documented derived size of the expert defaults (single 150 mm/s tier, 8 lines,
    // 30 mm clean read, 8 mm run-up, 4000 mm/s^2, 100 mm/s corner speed): a regression
    // inflating the layout is caught here. The field extent enters the two-axis
    // footprint twice (once per group), so each extra line costs two pitches (5 mm)
    // over the former 5-line default's 89.5625 mm; the 1.5625 mm fraction is the
    // corner-to-tier ramp (150^2 - 100^2) / (2 * 4000).
    expect(g.couponWidthMm).toBeCloseTo(104.5625, 9)
    // The 15-line maximum adds seven more line pairs on the same formula.
    const max = isCouponGeometry({ ...spec, linesPerSpeed: 15 })
    expect(max.couponWidthMm).toBeCloseTo(139.5625, 9)
  })
  it('shrinks when any driving parameter shrinks (the formula carries no padding)', () => {
    const size = (s: IsTestSpec) => isCouponGeometry(s).couponWidthMm
    expect(size({ ...spec, measuredLineMm: spec.measuredLineMm + 10 })).toBeGreaterThan(
      size(spec),
    )
    expect(size({ ...spec, linesPerSpeed: spec.linesPerSpeed + 1 })).toBeGreaterThan(size(spec))
    expect(size({ ...spec, speedsMmS: [150, 200, 300] })).toBeGreaterThan(size(spec))
    expect(size({ ...spec, runUpMm: spec.runUpMm + 4 })).toBeGreaterThan(size(spec))
    expect(size({ ...spec, linePitchMm: spec.linePitchMm + 0.5 })).toBeGreaterThan(size(spec))
  })
  it('drops the crossing terms for a single axis', () => {
    const F = fieldExtentMm(spec)
    const packed = maxPackedRampMm(spec) + spec.measuredLineMm
    const xOnly = isCouponGeometry({ ...spec, axes: ['x'] })
    expect(xOnly.couponWidthMm).toBeCloseTo(
      INNER_MARGIN_MM + F + spec.runUpMm + 2 * xOnly.frameBandMm, 9)
    expect(xOnly.couponHeightMm).toBeCloseTo(
      INNER_MARGIN_MM + packed + 2 * xOnly.frameBandMm, 9)
    const yOnly = isCouponGeometry({ ...spec, axes: ['y'] })
    expect(yOnly.couponWidthMm).toBeCloseTo(xOnly.couponHeightMm, 9)
    expect(yOnly.couponHeightMm).toBeCloseTo(xOnly.couponWidthMm, 9)
  })
  it('grows the protected span with the tier speed and shrinks it with acceleration', () => {
    expect(protectedSpanMm(spec, 300)).toBeGreaterThan(protectedSpanMm(spec, 200))
    const stiff: IsTestSpec = { ...spec, accelMmS2: 10000 }
    expect(protectedSpanMm(stiff, 300)).toBeLessThan(protectedSpanMm(spec, 300))
  })
})

describe('isCouponGeometry at the maximum line count', () => {
  // The default spec (8 lines) drives every invariant above; the 15-line maximum widens
  // the field the most, so the containment and crossing legality are re-proven here.
  const maxSpec: IsTestSpec = { ...spec, linesPerSpeed: 15 }
  const gm = isCouponGeometry(maxSpec)

  it('keeps every segment of every line inside the coupon outline', () => {
    for (const group of gm.groups) {
      for (const line of group.lines) {
        for (const s of segsOf(line)) {
          for (const x of [s.x0, s.x1]) {
            expect(x).toBeGreaterThanOrEqual(0)
            expect(x).toBeLessThanOrEqual(gm.couponWidthMm)
          }
          for (const y of [s.y0, s.y1]) {
            expect(y).toBeGreaterThanOrEqual(0)
            expect(y).toBeLessThanOrEqual(gm.couponHeightMm)
          }
        }
      }
    }
  })
  it('keeps every X/Y crossing point outside both lines protected spans (per pair)', () => {
    const xGroup = gm.groups.find((grp) => grp.axis === 'x')!
    const yGroup = gm.groups.find((grp) => grp.axis === 'y')!
    for (const xl of xGroup.lines) {
      for (const yl of yGroup.lines) {
        const crossX = xl.measured.x0
        const crossY = yl.measured.y0
        expect(crossY).toBeLessThan(xl.measured.y0)
        expect(crossY).toBeGreaterThan(xl.measured.y1)
        expect(crossX).toBeGreaterThan(yl.measured.x0)
        expect(crossX).toBeLessThan(yl.measured.x1)
        expect(xl.measured.y0 - crossY).toBeGreaterThanOrEqual(
          xl.protectedMm + INNER_MARGIN_MM - 1e-9,
        )
        expect(crossX - yl.measured.x0).toBeGreaterThanOrEqual(
          yl.protectedMm + INNER_MARGIN_MM - 1e-9,
        )
      }
    }
  })
  it('places every corner inside the open window with at least the run-up before it', () => {
    for (const group of gm.groups) {
      for (const line of group.lines) {
        const cornerX = line.measured.x0
        const cornerY = line.measured.y0
        expect(cornerX).toBeGreaterThan(gm.windowBox.x0)
        expect(cornerX).toBeLessThan(gm.windowBox.x1)
        expect(cornerY).toBeGreaterThan(gm.windowBox.y0)
        expect(cornerY).toBeLessThan(gm.windowBox.y1)
        const inWindow =
          group.axis === 'y' ? cornerY - gm.windowBox.y0 : gm.windowBox.x1 - cornerX
        expect(inWindow).toBeGreaterThanOrEqual(maxSpec.runUpMm - 1e-9)
      }
    }
  })
})

describe('isCouponGeometry frame band sizing', () => {
  it('keeps the minimum band when every tail fits inside it', () => {
    expect(g.frameBandMm).toBeCloseTo(MIN_FRAME_BAND_MM, 9)
  })
  it('widens the band for a fast tier so the full tail plus clearance fits', () => {
    // A 300 mm/s tier at 4000 mm/s^2 needs a 13.25 mm tail depth (1 mm weld + 11.25 mm
    // stopping distance + 1 mm margin) plus 1 mm edge clearance.
    const fast: IsTestSpec = { ...spec, speedsMmS: [150, 200, 300] }
    expect(isCouponGeometry(fast).frameBandMm).toBeCloseTo(
      spec.weldMm + accelRampMm(300, spec.accelMmS2) + TAIL_MARGIN_MM + TAIL_EDGE_CLEARANCE_MM,
      9,
    )
    expect(isCouponGeometry(fast).frameBandMm).toBeGreaterThan(MIN_FRAME_BAND_MM)
  })
  it('moves the window and fiducials with the band', () => {
    expect(g.windowBox.x0).toBeCloseTo(g.frameBandMm, 9)
    expect(g.windowBox.y0).toBeCloseTo(g.frameBandMm, 9)
    expect(g.windowBox.x1).toBeCloseTo(g.couponWidthMm - g.frameBandMm, 9)
    expect(g.windowBox.y1).toBeCloseTo(g.couponHeightMm - g.frameBandMm, 9)
    const far = g.fiducials.find(
      (f) => f.xMm > g.couponWidthMm / 2 && f.yMm > g.couponHeightMm / 2,
    )!
    expect(far.xMm).toBeCloseTo(g.couponWidthMm - FIDUCIAL_INSET_MM - FIDUCIAL_SIZE_MM / 2, 9)
    expect(far.yMm).toBeCloseTo(g.couponHeightMm - FIDUCIAL_INSET_MM - FIDUCIAL_SIZE_MM / 2, 9)
  })
})

describe('isCouponGeometry resonant run-up sweep', () => {
  const sweepSpec: IsTestSpec = { ...spec, sweep: true }
  const gs = isCouponGeometry(sweepSpec)

  /** Time slice of one chord: its length over its commanded speed. */
  const chordDtS = (t: SweepToothSegment) => segLen(t) / t.speedMmS
  /** Per-axis chord velocity in coupon coordinates. */
  const chordVel = (t: SweepToothSegment) => ({
    vx: (t.x1 - t.x0) / chordDtS(t),
    vy: (t.y1 - t.y0) / chordDtS(t),
  })
  /** Signed swing depth of a vertex, positive away from the measured direction. */
  const away = (line: IsLine, axis: 'x' | 'y', x: number, y: number) =>
    axis === 'y' ? line.runUp.x0 - x : y - line.runUp.y0
  /**
   * Split a line's chords into cells: a cell ends where the polyline returns to the
   * leg centreline, which the geometry pins to an exact zero lateral offset.
   */
  function cellsOf(line: IsLine, axis: 'x' | 'y'): SweepToothSegment[][] {
    const cells: SweepToothSegment[][] = []
    let current: SweepToothSegment[] = []
    for (const t of line.teeth) {
      current.push(t)
      if (away(line, axis, t.x1, t.y1) === 0) {
        cells.push(current)
        current = []
      }
    }
    expect(current).toHaveLength(0)
    return cells
  }

  it('leaves the geometry teeth-free and unchanged when the sweep is off', () => {
    for (const group of g.groups) {
      for (const line of group.lines) expect(line.teeth).toEqual([])
    }
    // The sweep band fields must not leak into a sweep-off layout.
    const other = isCouponGeometry({ ...spec, sweepFromHz: 50, sweepToHz: 100, sweepCycles: 8 })
    expect(other.couponWidthMm).toBeCloseTo(g.couponWidthMm, 9)
    expect(other.couponHeightMm).toBeCloseTo(g.couponHeightMm, 9)
  })

  it('sweeps the forcing frequency geometrically from sweepFromHz to sweepToHz', () => {
    const cells = sweepCells(sweepSpec)
    expect(cells).toHaveLength(sweepSpec.sweepCycles)
    expect(cells[0].freqHz).toBeCloseTo(35, 9)
    expect(cells[cells.length - 1].freqHz).toBeCloseTo(150, 9)
    for (let k = 2; k < cells.length; k++) {
      expect(cells[k].freqHz / cells[k - 1].freqHz).toBeCloseTo(
        cells[1].freqHz / cells[0].freqHz,
        9,
      )
    }
  })

  it('scales the cell acceleration by accel_per_hz, bounded by spec accel and clearance', () => {
    // Default band: 75 mm/s^2 per Hz gives 2625 at 35 Hz; from about 53 Hz up the
    // 4000 mm/s^2 spec acceleration is the lower bound and governs, so the last (150 Hz)
    // cell runs at 4000, not 11250.
    const cells = sweepCells(sweepSpec)
    expect(cells[0].accelMmS2).toBeCloseTo(2625, 9)
    expect(cells[cells.length - 1].accelMmS2).toBeCloseTo(4000, 9)
    // Clearance cap: at a 1.2 mm pitch the corridor is 0.2 mm, so a 20 Hz cell caps at
    // 16 * 400 * 0.2 = 1280 mm/s^2, below both 20000 and 75 * 20 = 1500; the 150 Hz
    // cell of the same spec runs at the accel_per_hz 11250.
    const capped = sweepCells({
      ...sweepSpec,
      accelMmS2: 20000,
      sweepFromHz: 20,
      linePitchMm: 1.2,
    })
    expect(capped[0].accelMmS2).toBeCloseTo(1280, 9)
    expect(capped[capped.length - 1].accelMmS2).toBeCloseTo(11250, 9)
  })

  it('takes exactly one forcing period per cell, longest (lowest) cell first', () => {
    for (const group of gs.groups) {
      for (const line of group.lines) {
        const periods = cellsOf(line, group.axis).map((c) =>
          c.reduce((s, t) => s + chordDtS(t), 0),
        )
        expect(periods).toHaveLength(16)
        expect(periods[0]).toBeCloseTo(0.02857142857142857, 9) // 1/35 s
        expect(periods[periods.length - 1]).toBeCloseTo(0.006666666666666667, 9) // 1/150 s
        for (let k = 1; k < periods.length; k++) {
          // Low frequency first: the periods shrink toward the launch corner.
          expect(periods[k]).toBeLessThan(periods[k - 1])
        }
        for (let k = 2; k < periods.length; k++) {
          expect(periods[k] / periods[k - 1]).toBeCloseTo(periods[1] / periods[0], 9)
        }
      }
    }
  })

  it('chains run-up, chords, and measured segment as one connected path to the corner', () => {
    for (const group of gs.groups) {
      for (const line of group.lines) {
        let prev = { x: line.runUp.x1, y: line.runUp.y1 }
        for (const t of line.teeth) {
          expect(t.x0).toBeCloseTo(prev.x, 9)
          expect(t.y0).toBeCloseTo(prev.y, 9)
          prev = { x: t.x1, y: t.y1 }
        }
        // The last vertex is the corner, reached on the centreline.
        expect(prev.x).toBeCloseTo(line.measured.x0, 9)
        expect(prev.y).toBeCloseTo(line.measured.y0, 9)
        const first = line.teeth[0]
        expect(away(line, group.axis, first.x0, first.y0)).toBeCloseTo(0, 9)
      }
    }
  })

  it('keeps a straight stub between the window edge and the first chord', () => {
    for (const group of gs.groups) {
      for (const line of group.lines) {
        const first = line.teeth[0]
        const stub =
          group.axis === 'y' ? first.y0 - gs.windowBox.y0 : gs.windowBox.x1 - first.x0
        expect(stub).toBeGreaterThanOrEqual(SWEEP_STUB_MM - 1e-9)
      }
    }
  })

  // Representative planner setups: the moderate default, a stiff fast machine, and a
  // stiff machine swept from a low start frequency at a tight pitch where the
  // clearance cap engages. `cap` is each corridor: pitch minus the 1 mm clearance.
  const setups: { name: string; s: IsTestSpec; scv: number; cap: number }[] = [
    { name: 'accel 4000, scv 5', s: sweepSpec, scv: 5, cap: 1.5 },
    { name: 'accel 20000, scv 12', s: { ...sweepSpec, accelMmS2: 20000 }, scv: 12, cap: 1.5 },
    {
      name: 'accel 20000 from 20 Hz at 1.2 mm pitch (clearance-capped), scv 12',
      s: { ...sweepSpec, accelMmS2: 20000, sweepFromHz: 20, linePitchMm: 1.2 },
      scv: 12,
      cap: 0.2,
    },
  ]

  it('never steps adjacent chord velocities by more than the square corner velocity', () => {
    for (const { name, s, scv } of setups) {
      const gg = isCouponGeometry(s, scv)
      for (const group of gg.groups) {
        for (const line of group.lines) {
          // The run-up cruise enters the first chord at 100 mm/s along the leg.
          let prev = group.axis === 'y' ? { vx: 0, vy: 100 } : { vx: -100, vy: 0 }
          for (const t of line.teeth) {
            const v = chordVel(t)
            expect(Math.abs(v.vx - prev.vx), name).toBeLessThanOrEqual(scv + 1e-9)
            expect(Math.abs(v.vy - prev.vy), name).toBeLessThanOrEqual(scv + 1e-9)
            prev = v
          }
        }
      }
    }
  })

  it('never implies a lateral acceleration above the spec acceleration', () => {
    for (const { name, s, scv } of setups) {
      const gg = isCouponGeometry(s, scv)
      for (const group of gg.groups) {
        for (const line of group.lines) {
          for (let i = 1; i < line.teeth.length; i++) {
            const a = chordVel(line.teeth[i - 1])
            const b = chordVel(line.teeth[i])
            const dt = (chordDtS(line.teeth[i - 1]) + chordDtS(line.teeth[i])) / 2
            const accel = Math.max(Math.abs(b.vx - a.vx), Math.abs(b.vy - a.vy)) / dt
            // The 1e-6 absorbs the float noise of velocities recovered from mm-scale
            // coordinates over sub-millisecond slices.
            expect(accel, name).toBeLessThanOrEqual(s.accelMmS2 + 1e-6)
          }
        }
      }
    }
  })

  it('keeps every swing inside the clearance corridor, away from the measured side', () => {
    for (const { name, s, scv, cap } of setups) {
      const gg = isCouponGeometry(s, scv)
      for (const group of gg.groups) {
        for (const line of group.lines) {
          for (const t of line.teeth) {
            const depth = away(line, group.axis, t.x1, t.y1)
            // Never toward the measured direction, never past the setup's corridor.
            expect(depth, name).toBeGreaterThanOrEqual(-1e-9)
            expect(depth, name).toBeLessThanOrEqual(cap + 1e-9)
            expect(t.x1, name).toBeGreaterThan(gg.windowBox.x0)
            expect(t.x1, name).toBeLessThan(gg.windowBox.x1)
            expect(t.y1, name).toBeGreaterThan(gg.windowBox.y0)
            expect(t.y1, name).toBeLessThan(gg.windowBox.y1)
          }
        }
      }
    }
  })

  it('exits onto the corner nearly colinear with the leg at the corner speed', () => {
    // Hand-derived exit figures: the last chord leaves the 150 Hz cell one slice from
    // rest, so its lateral-to-forward ratio and feed are set by that slice alone. At
    // 150 Hz the cell acceleration is min(spec accel, 75 * 150 = 11250): 4000 with
    // scv 5 gives F 6001 (100.0139 mm/s, ratio 0.0167); 11250 with scv 12 gives F 6007
    // (100.1098 mm/s, ratio 0.0469) for both 20000 mm/s^2 setups (the clearance cap
    // does not bind at 150 Hz).
    const expected = [
      { feed: 6001, maxRatio: 0.017 },
      { feed: 6007, maxRatio: 0.047 },
      { feed: 6007, maxRatio: 0.047 },
    ]
    setups.forEach(({ name, s, scv }, i) => {
      const gg = isCouponGeometry(s, scv)
      for (const group of gg.groups) {
        for (const line of group.lines) {
          const last = line.teeth[line.teeth.length - 1]
          expect(Math.round(last.speedMmS * 60), name).toBe(expected[i].feed)
          const fwd =
            group.axis === 'y' ? Math.abs(last.y1 - last.y0) : Math.abs(last.x1 - last.x0)
          const lat =
            group.axis === 'y' ? Math.abs(last.x1 - last.x0) : Math.abs(last.y1 - last.y0)
          expect(lat / fwd, name).toBeLessThanOrEqual(expected[i].maxRatio)
        }
      }
    })
  })

  it('peaks each swing at accel / (16 f^2), landing the extreme on a vertex', () => {
    const peak = (line: IsLine, axis: 'x' | 'y', cell: SweepToothSegment[]) =>
      Math.max(...cell.map((t) => away(line, axis, t.x1, t.y1)))
    for (const group of gs.groups) {
      for (const line of group.lines) {
        // First (35 Hz) cell under accel_per_hz: 75 * 35 / (16 * 35^2) = 75 / (16 * 35)
        // = 0.1339285... mm.
        const cells = cellsOf(line, group.axis)
        expect(peak(line, group.axis, cells[0])).toBeCloseTo(0.13392857142857142, 9)
      }
    }
    // A clearance-capped cell fills the corridor exactly: 20 Hz at a 1.2 mm pitch runs
    // at the capped 1280 mm/s^2, whose amplitude is the full 0.2 mm corridor.
    const capped = isCouponGeometry(
      { ...sweepSpec, accelMmS2: 20000, sweepFromHz: 20, linePitchMm: 1.2 },
      12,
    )
    for (const group of capped.groups) {
      for (const line of group.lines) {
        const cells = cellsOf(line, group.axis)
        expect(peak(line, group.axis, cells[0])).toBeCloseTo(0.2, 9)
      }
    }
  })

  it('sizes the leg by the closed form and keeps the coupon square', () => {
    // Hand-derived once: 5 mm stub plus 100 mm/s times the sum of the sixteen forcing
    // periods of the geometric 35 to 150 Hz band.
    expect(sweepLegMm(sweepSpec)).toBeCloseTo(29.35738350235176, 9)
    expect(gs.couponWidthMm).toBeCloseTo(125.91988350235175, 9)
    expect(gs.couponHeightMm).toBeCloseTo(gs.couponWidthMm, 9)
  })

  it('keeps the sweep leg acceleration-independent; only capped-cell amplitudes react', () => {
    // The leg length depends only on the corner speed and the frequency band, so the
    // 20000 mm/s^2 leg matches the 4000 mm/s^2 literal exactly. Below about 53 Hz the
    // accel_per_hz scaling governs both specs identically; above it the 4000 mm/s^2
    // bound flattens the default's cells, so the last (150 Hz) cell swings
    // 4000 / (16 * 150^2) = 0.0111 mm at the default and 11250 / (16 * 150^2)
    // = 0.03125 mm at 20000.
    const hiSpec: IsTestSpec = { ...sweepSpec, accelMmS2: 20000 }
    expect(sweepLegMm(hiSpec)).toBeCloseTo(29.35738350235176, 9)
    const hi = isCouponGeometry(hiSpec)
    const lastCellPeak = (l: IsLine, axis: 'x' | 'y') => {
      const cells = cellsOf(l, axis)
      return Math.max(...cells[cells.length - 1].map((t) => away(l, axis, t.x1, t.y1)))
    }
    hi.groups.forEach((grp, gi) => {
      grp.lines.forEach((line, li) => {
        expect(lastCellPeak(line, grp.axis)).toBeCloseTo(0.03125, 9)
        expect(lastCellPeak(gs.groups[gi].lines[li], grp.axis)).toBeCloseTo(
          0.011111111111111112,
          9,
        )
      })
    })
  })

  it('grows the coupon by the sweep leg and reports it via effectiveRunUpMm', () => {
    expect(effectiveRunUpMm(spec)).toBeCloseTo(spec.runUpMm, 9)
    expect(effectiveRunUpMm(sweepSpec)).toBeCloseTo(sweepLegMm(sweepSpec), 9)
    expect(sweepLegMm(sweepSpec)).toBeGreaterThan(spec.runUpMm)
    const growth = sweepLegMm(sweepSpec) - spec.runUpMm
    expect(gs.couponWidthMm).toBeCloseTo(g.couponWidthMm + growth, 9)
    expect(gs.couponHeightMm).toBeCloseTo(g.couponHeightMm + growth, 9)
  })
})
