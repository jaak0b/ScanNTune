import { describe, expect, it } from 'vitest'
import { defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'
import { defaultIsTestSpec, fitSpecToPrinter, type IsTestSpec } from '../../../src/engine/is/types'
import {
  accelRampMm,
  ladderCornerSpeeds,
  MIN_CORNER_SPEED_MM_S,
  BLOCK_GAP_MM,
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

  it('records the protected span (per-line ramp plus clean read length) per line', () => {
    for (const group of g.groups) {
      for (const line of group.lines) {
        expect(line.protectedMm).toBeCloseTo(
          protectedSpanMm(spec, line.speedMmS, line.cornerSpeedMmS),
          9,
        )
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
    // 30 mm clean read, 8 mm run-up, the default profile's 3000 mm/s^2, 100 mm/s top
    // corner speed): a regression inflating the layout is caught here. The field extent
    // enters the two-axis footprint twice (once per group), so each extra line costs two
    // pitches (5 mm); the 3.68333 mm fraction is the binding corner-to-tier ramp of the
    // ladder's 20 mm/s bottom rung, (150^2 - 20^2) / (2 * 3000).
    expect(g.couponWidthMm).toBeCloseTo(106.683333, 6)
    // The 15-line maximum adds seven more line pairs on the same formula.
    const max = isCouponGeometry({ ...spec, linesPerSpeed: 15 })
    expect(max.couponWidthMm).toBeCloseTo(141.683333, 6)
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

describe('corner-speed excitation ladder', () => {
  it('spaces the rungs geometrically from the 20 mm/s bottom rung to the top corner speed', () => {
    // Hand-derived: 20 * 5^(j/7) for j = 0..7 at the 100 mm/s default top rung.
    const expected = [20, 25.16998, 31.67639, 39.86471, 50.16969, 63.1385, 79.45974, 100]
    const rungs = ladderCornerSpeeds(spec)
    expect(rungs).toHaveLength(spec.linesPerSpeed)
    rungs.forEach((r, j) => expect(r).toBeCloseTo(expected[j], 4))
    expect(rungs[0]).toBe(MIN_CORNER_SPEED_MM_S)
  })
  it('tags every line with its rung, repeating the ladder per tier', () => {
    const multi = isCouponGeometry({ ...spec, speedsMmS: [150, 300] })
    const rungs = ladderCornerSpeeds({ ...spec, speedsMmS: [150, 300] })
    for (const group of multi.groups) {
      group.lines.forEach((line, i) => {
        expect(line.cornerSpeedMmS).toBeCloseTo(rungs[i % spec.linesPerSpeed], 9)
      })
    }
  })
  it('gives every line its own ramp from its rung, longest on the bottom rung', () => {
    for (const group of g.groups) {
      const first = group.lines[0]
      const last = group.lines[group.lines.length - 1]
      // Bottom rung (20 mm/s): ramp (150^2 - 20^2) / 6000 = 3.683333 mm (hand-derived);
      // top rung (100 mm/s): (150^2 - 100^2) / 6000 = 2.083333 mm; plus the 30 mm read.
      expect(first.protectedMm).toBeCloseTo(33.683333, 6)
      expect(last.protectedMm).toBeCloseTo(32.083333, 6)
    }
  })
  it('shrinks a ladder coupon onto a small bed through the measured-line reduction', () => {
    const profile = { ...defaultPrinterProfile(), bedWidthMm: 100, bedDepthMm: 100 }
    const { spec: fitted, notes } = fitSpecToPrinter(spec, profile)
    expect(notes.some((n) => n.includes('shortened'))).toBe(true)
    expect(fitted.measuredLineMm).toBeLessThan(spec.measuredLineMm)
    const gf = isCouponGeometry(fitted)
    expect(gf.couponWidthMm).toBeLessThanOrEqual(100)
    expect(gf.couponHeightMm).toBeLessThanOrEqual(100)
  })
})

describe('isCouponGeometry frame band sizing', () => {
  it('keeps the minimum band when every tail fits inside it', () => {
    expect(g.frameBandMm).toBeCloseTo(MIN_FRAME_BAND_MM, 9)
  })
  it('widens the band for a fast tier so the full tail plus clearance fits', () => {
    // A 300 mm/s tier at 3000 mm/s^2 needs a 17 mm tail depth (1 mm weld + 15 mm stopping
    // distance + 1 mm margin) plus 1 mm edge clearance.
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
