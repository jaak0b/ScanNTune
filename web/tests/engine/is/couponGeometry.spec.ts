import { describe, expect, it } from 'vitest'
import { defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'
import {
  defaultIsTestRequest,
  fitSpecToPrinter,
  type IsTestSpec,
} from '../../../src/engine/is/types'
import {
  accelRampMm,
  ladderCornerSpeeds,
  MIN_CORNER_SPEED_MM_S,
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

const profile = defaultPrinterProfile()
// The fitted default: tiers 90 / 150 mm/s, four lines per speed on a bottom-dense ladder whose
// followable corner is 25.5 mm/s, 100 mm/s corner speed, 3000 mm/s^2, 30 mm read, 8 mm run-up,
// 2.5 mm pitch.
const spec = fitSpecToPrinter(defaultIsTestRequest(profile), profile).spec
const g = isCouponGeometry(spec)
const yGroup = g.groups.find((grp) => grp.axis === 'y')!
const xGroup = g.groups.find((grp) => grp.axis === 'x')!

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
  it('builds the Y group then the X group, one group for a single axis', () => {
    expect(g.groups.map((grp) => grp.axis)).toEqual(['y', 'x'])
    const single = isCouponGeometry({ ...spec, axes: ['y'] })
    expect(single.groups.map((grp) => grp.axis)).toEqual(['y'])
    const singleX = isCouponGeometry({ ...spec, axes: ['x'] })
    expect(singleX.groups.map((grp) => grp.axis)).toEqual(['x'])
  })
  it('interleaves the two tiers rung by rung, alternating which tier leads (ABBA)', () => {
    for (const group of g.groups) {
      expect(group.lines.map((l) => l.speedMmS)).toEqual([90, 150, 150, 90, 90, 150, 150, 90])
      expect(group.lines.map((l) => l.rungIndex)).toEqual([0, 0, 1, 1, 2, 2, 3, 3])
    }
  })
  it('spaces every line one pitch from the next, with no gap between the tiers', () => {
    for (const group of g.groups) {
      const pos = perpendicularPositions(group)
      for (let i = 1; i < pos.length; i++) {
        expect(Math.abs(pos[i] - pos[i - 1])).toBeCloseTo(2.5, 9)
      }
    }
    expect(fieldExtentMm(spec)).toBeCloseTo(17.5, 9)
  })
  it('balances the tiers along the ringing axis: equal mean positions up to a pitch over the line count', () => {
    const meanOffset = (lines: IsLine[], v: number) => {
      const own = lines.filter((l) => l.speedMmS === v)
      return own.reduce((s, l) => s + l.measured.y0, 0) / own.length
    }
    // Four lines: slow slots 0, 3, 4, 7 and fast slots 1, 2, 5, 6 both average 3.5 pitches.
    expect(meanOffset(yGroup.lines, 150) - meanOffset(yGroup.lines, 90)).toBeCloseTo(0, 9)
    // Five lines: slow slots 0, 3, 4, 7, 8 and fast slots 1, 2, 5, 6, 9 average 4.4 and 4.6
    // pitches, half a millimetre apart (the odd total of 45 slot pitches cannot split evenly).
    const five = isCouponGeometry({ ...spec, linesPerSpeed: 5 })
    const fiveY = five.groups.find((grp) => grp.axis === 'y')!
    expect(meanOffset(fiveY.lines, 150) - meanOffset(fiveY.lines, 90)).toBeCloseTo(0.5, 9)
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
        // stretch, the cruise runs at the corner speed straight into the bend.
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
    for (const { measured } of yGroup.lines) {
      expect(measured.x1).toBeCloseTo(g.windowBox.x1 + spec.weldMm, 9)
    }
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
    expect(yGroup.lines[0].measured.x1).toBeGreaterThan(yGroup.lines[0].measured.x0)
    expect(yGroup.lines[0].runUp.y1).toBeGreaterThan(yGroup.lines[0].runUp.y0)
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

describe('isCouponGeometry print order', () => {
  const lineOf = (r: { groupIndex: number; lineIndex: number }) =>
    g.groups[r.groupIndex].lines[r.lineIndex]
  it('prints every line exactly once per layer', () => {
    expect(g.printOrder).toHaveLength(16)
    const keys = new Set(g.printOrder.map((r) => `${r.groupIndex}:${r.lineIndex}`))
    expect(keys.size).toBe(16)
  })
  it('prints the corners in non-decreasing corner speed, so the fastest corners come last', () => {
    const corners = g.printOrder.map((r) => lineOf(r).cornerSpeedMmS)
    for (let i = 1; i < corners.length; i++) {
      expect(corners[i]).toBeGreaterThanOrEqual(corners[i - 1])
    }
    // The two 40.21 mm/s top printed corners of the line-speed tier are the last two lines of
    // the layer, after the two 38.82 mm/s top printed corners of the slower tier.
    expect(corners.slice(-2).every((c) => Math.abs(c - 40.21241) < 1e-5)).toBe(true)
    expect(corners.slice(-4, -2).every((c) => Math.abs(c - 38.82466) < 1e-5)).toBe(true)
    expect(corners.slice(0, -4).every((c) => c < 38.8)).toBe(true)
  })
  it('prints equal corners Y slow, Y fast, X slow, X fast', () => {
    const firstRung = g.printOrder.slice(0, 4).map((r) => {
      const line = lineOf(r)
      return `${g.groups[r.groupIndex].axis}${line.speedMmS}@${line.cornerSpeedMmS}`
    })
    expect(firstRung).toEqual(['y90@20', 'y150@20', 'x90@20', 'x150@20'])
  })
  it('orders by corner speed even when the slower tier tops out below the corner speed', () => {
    // A 120 mm/s corner speed: the 90 mm/s tier's ladder tops out at 90, the 150 mm/s tier's
    // at 120, so the upper rungs of the two tiers differ and the order follows the speeds alone.
    const fast = isCouponGeometry({ ...spec, cornerSpeedMmS: 120 })
    const corners = fast.printOrder.map((r) => fast.groups[r.groupIndex].lines[r.lineIndex].cornerSpeedMmS)
    for (let i = 1; i < corners.length; i++) {
      expect(corners[i]).toBeGreaterThanOrEqual(corners[i - 1])
    }
  })
})

describe('isCouponGeometry crossings and packing', () => {
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
  it('places the slowest tier bottom rung at offset zero, nearest the crossing zone in both groups', () => {
    // Offset zero: the Y line with the largest corner x and the X line with the lowest corner.
    expect(yGroup.lines[0].speedMmS).toBe(90)
    expect(yGroup.lines[0].cornerSpeedMmS).toBe(20)
    expect(Math.max(...yGroup.lines.map((l) => l.measured.x0))).toBe(yGroup.lines[0].measured.x0)
    expect(xGroup.lines[0].speedMmS).toBe(90)
    expect(Math.min(...xGroup.lines.map((l) => l.measured.y0))).toBe(xGroup.lines[0].measured.y0)
  })
  it('records on each line its crossings with the other group printed earlier, all beyond the protected span', () => {
    let total = 0
    const printed: { groupIndex: number; lineIndex: number }[] = []
    for (const ref of g.printOrder) {
      const group = g.groups[ref.groupIndex]
      const line = group.lines[ref.lineIndex]
      const earlierOther = printed.filter((r) => r.groupIndex !== ref.groupIndex)
      expect(line.crossingsMm).toHaveLength(earlierOther.length)
      const sorted = [...line.crossingsMm].sort((a, b) => a - b)
      expect(line.crossingsMm).toEqual(sorted)
      for (const c of line.crossingsMm) {
        expect(c).toBeGreaterThanOrEqual(line.protectedMm + INNER_MARGIN_MM - 1e-9)
      }
      total += line.crossingsMm.length
      printed.push(ref)
    }
    // Every X line crosses every Y line once, recorded on whichever prints later: 8 x 8.
    expect(total).toBe(64)
    // Both groups now carry crossings: the rung-major order interleaves them.
    expect(yGroup.lines.some((l) => l.crossingsMm.length > 0)).toBe(true)
    expect(xGroup.lines.some((l) => l.crossingsMm.length > 0)).toBe(true)
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
    // Documented derived size of the defaults (tiers 90 / 150 mm/s, four lines per speed,
    // 30 mm clean read, 8 mm run-up, 3000 mm/s^2, 100 mm/s corner speed): a regression
    // inflating the layout is caught here. Field extent 7 pitches = 17.5 mm; the binding
    // line is the slow tier's 20 mm/s rung at offset zero, 17.5 + (90^2 - 20^2) / 6000 =
    // 18.783 mm; the interior is 3 + 18.783 + 30 + 3 + 17.5 + 8 = 80.283 mm plus two 12 mm
    // bands.
    expect(g.couponWidthMm).toBeCloseTo(104.283333, 6)
    // The 15-line maximum: field 29 pitches = 72.5 mm, binding 72.5 + 1.283 = 73.783 mm.
    const max = isCouponGeometry({ ...spec, linesPerSpeed: 15 })
    expect(max.couponWidthMm).toBeCloseTo(214.283333, 6)
  })
  it('shrinks when any driving parameter shrinks (the formula carries no padding)', () => {
    const size = (s: IsTestSpec) => isCouponGeometry(s).couponWidthMm
    expect(size({ ...spec, measuredLineMm: spec.measuredLineMm + 10 })).toBeGreaterThan(
      size(spec),
    )
    expect(size({ ...spec, linesPerSpeed: spec.linesPerSpeed + 1 })).toBeGreaterThan(size(spec))
    expect(size(spec)).toBeGreaterThan(size({ ...spec, speedsMmS: [150] }))
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
  // The default spec drives every invariant above; the 15-line maximum widens the field the
  // most, so the containment and crossing legality are re-proven here.
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
    const xG = gm.groups.find((grp) => grp.axis === 'x')!
    const yG = gm.groups.find((grp) => grp.axis === 'y')!
    for (const xl of xG.lines) {
      for (const yl of yG.lines) {
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
  it('spaces three rungs from 20 mm/s up to the followable corner, then prints the lowest upper rungs', () => {
    // Hand-derived: 20 * (25.5 / 20)^(j / 2) for j = 0..2, then the upper ladder
    // 25.5 * (100 / 25.5)^(k / 3) for k = 1..3 towards the 100 mm/s corner speed, of which the
    // four-line default prints the first and six lines all three.
    const rungs = ladderCornerSpeeds(spec)
    expect(rungs).toHaveLength(spec.linesPerSpeed)
    ;[20, 22.58318, 25.5, 40.21241].forEach((r, j) => expect(rungs[j]).toBeCloseTo(r, 4))
    expect(rungs[0]).toBe(MIN_CORNER_SPEED_MM_S)
    const six = ladderCornerSpeeds({ ...spec, linesPerSpeed: 6 })
    ;[20, 22.58318, 25.5, 40.21241, 63.41326, 100].forEach((r, j) => expect(six[j]).toBeCloseTo(r, 4))
    // Three lines are the followable rungs alone.
    expect(ladderCornerSpeeds({ ...spec, linesPerSpeed: 3 })).toEqual(rungs.slice(0, 3))
  })
  it('spaces the rungs geometrically over the whole range when the followable corner does not split it', () => {
    // Every rung follows (the followable corner at the top), or not even the bottom rung does
    // (below 20 mm/s): 20 * 5^(j / 3) (hand-derived).
    const plainFour = [20, 34.19952, 58.48035, 100]
    for (const followableCornerMmS of [100, 19.9]) {
      const rungs = ladderCornerSpeeds({ ...spec, followableCornerMmS })
      expect(rungs).toHaveLength(4)
      rungs.forEach((r, j) => expect(r).toBeCloseTo(plainFour[j], 4))
    }
  })
  it('tops a slower tier ladder out at its own speed when the corner speed is faster', () => {
    // 120 mm/s corner speed: both tiers share the bottom rungs 20, 22.583, 25.5; above them the
    // 90 mm/s tier climbs as 25.5 * (90 / 25.5)^(k / 3), the 150 mm/s tier as
    // 25.5 * (120 / 25.5)^(k / 3) (hand-derived).
    const fast = { ...spec, cornerSpeedMmS: 120 }
    const slowRungs = ladderCornerSpeeds(fast, 90)
    const fastRungs = ladderCornerSpeeds(fast, 150)
    ;[20, 22.58318, 25.5, 38.82466].forEach((r, j) => expect(slowRungs[j]).toBeCloseTo(r, 4))
    ;[20, 22.58318, 25.5, 42.73206].forEach((r, j) => expect(fastRungs[j]).toBeCloseTo(r, 4))
  })
  it('tags every line with its own tier rung', () => {
    const fast = isCouponGeometry({ ...spec, cornerSpeedMmS: 120 })
    const yG = fast.groups.find((grp) => grp.axis === 'y')!
    expect(yG.lines.map((l) => Number(l.cornerSpeedMmS.toFixed(3)))).toEqual([
      20, 20, 22.583, 22.583, 25.5, 25.5, 42.732, 38.825,
    ])
  })
  it('gives every line its own ramp from its rung', () => {
    for (const group of g.groups) {
      const first = group.lines[0]
      const last = group.lines[group.lines.length - 1]
      // First line: the 90 mm/s tier's 20 mm/s rung, ramp (90^2 - 20^2) / 6000 = 1.283333 mm;
      // last line: the 90 mm/s tier's 38.825 mm/s top printed rung, ramp
      // (90^2 - 38.825^2) / 6000 = 1.098774 mm; plus the 30 mm read (hand-derived).
      expect(first.protectedMm).toBeCloseTo(31.283333, 6)
      expect(last.protectedMm).toBeCloseTo(31.098774, 6)
    }
  })
})

describe('isCouponGeometry frame band sizing', () => {
  it('keeps the minimum band when every tail fits inside it', () => {
    expect(g.frameBandMm).toBeCloseTo(MIN_FRAME_BAND_MM, 9)
  })
  it('widens the band for a fast tier so the full tail plus clearance fits', () => {
    // A 300 mm/s tier at 3000 mm/s^2 needs a 17 mm tail depth (1 mm weld + 15 mm stopping
    // distance + 1 mm margin) plus 1 mm edge clearance.
    const fast: IsTestSpec = { ...spec, speedsMmS: [150, 300] }
    expect(isCouponGeometry(fast).frameBandMm).toBeCloseTo(18, 9)
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
