import { describe, expect, it } from 'vitest'
import {
  replayGcode,
  timeAtDistanceInMove,
  type PlannedJunction,
  type ReplayKinematics,
} from '../../helpers/plannerReplay'
import { generateIsGcodeWithReport } from '../../../src/engine/is/gcodeGenerator'
import { defaultIsTestRequest, fitSpecToPrinter } from '../../../src/engine/is/types'
import { isCouponGeometry, timeAtDistance } from '../../../src/engine/is/couponGeometry'
import { couponOrigin, type CouponPlacement } from '../../../src/engine/gcode/couponShell'
import { defaultFilamentProfile, defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'

// The planner oracle (tests/helpers/plannerReplay.ts) replays G-code through a port of the
// Klipper planner and imports no production code. These tests first pin the oracle against
// hand-derived planner behaviour, then replay the generated input shaper coupon on Cartesian
// and CoreXY kinematics.

describe('planner replay oracle', () => {
  it('takes a Klipper 90 degree corner at the square corner velocity', () => {
    const r = replayGcode(
      'SET_VELOCITY_LIMIT VELOCITY=300 ACCEL=3000 SQUARE_CORNER_VELOCITY=20 MINIMUM_CRUISE_RATIO=0\n' +
        'G1 X50 Y0 F6000\nG1 X50 Y50 F6000\n',
      { kinematics: 'cartesian' },
    )
    expect(r.junctions).toHaveLength(1)
    expect(r.junctions[0].speedMmS).toBeCloseTo(20, 9)
    expect(r.junctions[0].cartesianStepMmS).toBeCloseTo(20, 9)
  })

  it('limits a Klipper corner between short moves to its centripetal term, v^2 = 0.5 L a', () => {
    // Two 2 mm legs at 3000 mm/s^2: v^2 = 0.5 x 2 x 3000 = 3000, v = 54.7723 mm/s.
    const r = replayGcode(
      'SET_VELOCITY_LIMIT VELOCITY=300 ACCEL=3000 SQUARE_CORNER_VELOCITY=1000 MINIMUM_CRUISE_RATIO=0\n' +
        'G1 X2 Y0 F6000\nG1 X2 Y2 F6000\n',
      { kinematics: 'cartesian' },
    )
    expect(r.junctions[0].speedMmS).toBeCloseTo(54.7723, 4)
  })

  it("flags a Klipper move beyond its default maximum extrusion cross-section", () => {
    // 0.905 mm of 1.75 mm filament over 3 mm is 0.7256 mm^2, above 4 x 0.4^2 = 0.64 mm^2.
    const r = replayGcode('G1 X3 Y0 E0.905 F1800\nG1 X6 Y0 E0.79824 F1800\n', {
      kinematics: 'cartesian',
    })
    expect(r.crossSectionViolations.map((v) => v.line)).toEqual([0])
    expect(r.crossSectionViolations[0].areaMm2).toBeCloseTo(0.7256, 4)
  })

  it('scales every commanded feed by the speed factor (M220)', () => {
    const r = replayGcode(
      'SET_VELOCITY_LIMIT VELOCITY=300 ACCEL=3000 SQUARE_CORNER_VELOCITY=200 MINIMUM_CRUISE_RATIO=0\n' +
        'M220 S90\nG1 X50 Y0 F6000\nG1 X50 Y50 F6000\n',
      { kinematics: 'cartesian' },
    )
    expect(r.junctions[0].speedMmS).toBeCloseTo(90, 9)
  })
})

/** The default profile's own square corner velocity, mm/s. */
const PROFILE_LIMIT = 5

/**
 * The corner speed of each ladder rung as the default coupon commands it on the measured layer,
 * mm/s, lowest rung first. Hand-derived once: the rungs 20 * (top / 20)^(j / (n - 1)) mm/s
 * rounded to the whole mm/min the G-code prints, five rungs up to 100 mm/s (F1200, F1794,
 * F2683, F4012, F6000).
 */
const MEASURED_RUNG_MM_S = [20, 29.9, 44.716667, 66.866667, 100]
/** The same rungs on the pedestal layer, where the profile's 30 mm/s first layer speed (F1800)
 *  caps every line. */
const PEDESTAL_RUNG_MM_S = [20, 29.9, 30, 30, 30]
/** The pedestal layer's line speed: the profile's 30 mm/s first layer speed. */
const PEDESTAL_LINE_SPEED_MM_S = 30

const cases: [ReplayKinematics, CouponPlacement, boolean][] = []
for (const kinematics of ['cartesian', 'corexy'] as const) {
  for (const placement of ['center', 'front'] as const) {
    for (const contrastBase of [false, true]) cases.push([kinematics, placement, contrastBase])
  }
}

describe('the input shaper coupon on the Klipper planner', () => {
  const filament = defaultFilamentProfile()

  it.each(cases)('%s, %s placement, contrast base %s', (kinematics, placement, contrastBase) => {
    const profile = defaultPrinterProfile()
    const request = { ...defaultIsTestRequest(profile), placement, contrastBase }
    const { gcode } = generateIsGcodeWithReport(profile, filament, request)
    const spec = fitSpecToPrinter(request, profile).spec
    const g = isCouponGeometry(spec)
    const { ox, oy } = couponOrigin(profile, g.couponWidthMm, g.couponHeightMm, placement)
    // A speed factor left at 90% before the print: the coupon's M220 S100 must undo it. The
    // corner and timing checks below compare against the coupon's planned speeds, never the
    // replayed feeds (which carry any speed factor left in force), so a missing reset fails them.
    const r = replayGcode(gcode, { kinematics, initialSpeedFactor: 0.9 })
    const motorFactor = kinematics === 'corexy' ? 2 : 1
    const linesPerLayer = g.printOrder.length

    expect(r.crossSectionViolations).toEqual([])

    // The ladder corners: the junction where a run-up ends on its line's corner and the
    // measured segment turns 90 degrees.
    const at = (x: number, y: number) => `${x.toFixed(3)},${y.toFixed(3)}`
    const lineAtCorner = new Map(
      g.groups.flatMap((grp) => grp.lines.map((l) => [at(ox + l.measured.x0, oy + l.measured.y0), l] as const)),
    )
    const isCorner = (j: PlannedJunction) =>
      lineAtCorner.has(at(j.x, j.y)) &&
      j.prev.e > 0 &&
      j.next.e > 0 &&
      Math.abs((j.prev.x1 - j.prev.x0) * (j.next.x1 - j.next.x0) + (j.prev.y1 - j.prev.y0) * (j.next.y1 - j.next.y0)) < 1e-6
    const corners = r.junctions.filter(isCorner)
    expect(corners).toHaveLength(2 * linesPerLayer)
    // Each corner's planned speeds: its line's rung and tier speed on the measured layer, both
    // capped at the first layer speed on the pedestal layer, which prints first.
    const planned = corners.map((c, k) => {
      const line = lineAtCorner.get(at(c.x, c.y))!
      const pedestal = k < linesPerLayer
      return {
        rungMmS: (pedestal ? PEDESTAL_RUNG_MM_S : MEASURED_RUNG_MM_S)[line.rungIndex],
        lineMmS: pedestal ? PEDESTAL_LINE_SPEED_MM_S : line.speedMmS,
      }
    })
    corners.forEach((c, k) => {
      // Each corner passes at its own planned rung: no braking, and the motor step is the
      // rung (Cartesian) or twice the rung (the CoreXY motor that reverses).
      expect(Math.abs(c.speedMmS - planned[k].rungMmS)).toBeLessThan(1e-3)
      expect(Math.abs(c.motorStepMmS - motorFactor * planned[k].rungMmS)).toBeLessThan(2e-3)
    })
    // The kicks never fall within a layer: the fastest corners print last.
    for (let layer = 0; layer < 2; layer++) {
      const kicks = corners.slice(layer * linesPerLayer, (layer + 1) * linesPerLayer).map((c) => c.motorStepMmS)
      for (let k = 1; k < kicks.length; k++) expect(kicks[k]).toBeGreaterThanOrEqual(kicks[k - 1] - 1e-9)
    }

    // The raised corner limit covers exactly each line's run-up, measured segment, tail and
    // coast; everything else (preamble, base, band, travels, un-retracts, first stretches,
    // wipes) is queued under the profile's own limit.
    const raised = new Set(r.moves.filter((m) => Math.abs(m.cornerLimit - PROFILE_LIMIT) > 1e-9))
    expect(raised.size).toBe(4 * 2 * linesPerLayer)
    // Inside the line phase only the ladder corners kick: every other junction there is
    // colinear and continuous.
    for (const j of r.junctions) {
      if ((raised.has(j.prev) || raised.has(j.next)) && !isCorner(j)) {
        expect(j.cartesianStepMmS).toBeLessThan(1e-9)
      }
    }

    // Every move from rest starts from standstill.
    for (const s of r.starts) expect(s.motorSpeedMmS).toBeLessThanOrEqual(0.05 + 1e-9)

    // Isolated kicks: the travel to each line, its first stretch and its wipe each begin a
    // planner segment (the planner came to rest before them), so no corner kick follows a
    // travel or wipe junction and none lands on a rotor still ringing from the last line.
    const segmentStarts = new Set(r.starts.map((s) => s.move))
    const primeStarts = new Set(g.groups.flatMap((grp) => grp.lines.map((l) => at(ox + l.prime.x0, oy + l.prime.y0))))
    const primeEnds = new Set(g.groups.flatMap((grp) => grp.lines.map((l) => at(ox + l.prime.x1, oy + l.prime.y1))))
    const travelsToLines = r.moves.filter((m) => m.kind === 'xy' && m.e === 0 && primeStarts.has(at(m.x1, m.y1)))
    const primes = r.moves.filter((m) => m.kind === 'xy' && m.e > 0 && primeEnds.has(at(m.x1, m.y1)))
    const wipes = r.moves.filter((m) => m.kind === 'xy' && m.e < 0)
    expect(travelsToLines).toHaveLength(2 * linesPerLayer)
    expect(primes).toHaveLength(2 * linesPerLayer)
    expect(wipes).toHaveLength(2 * linesPerLayer)
    for (const m of [...travelsToLines, ...primes, ...wipes]) expect(segmentStarts.has(m)).toBe(true)

    // After each corner the nozzle covers the measured segment on the time base the analysis
    // uses: the planned trapezoid from the rung to the line speed, cruising to the end of the
    // measured move.
    for (const [k, c] of corners.entries()) {
      const m = c.next
      const corner = planned[k].rungMmS
      const line = planned[k].lineMmS
      expect(Math.abs(m.cruiseMmS - line)).toBeLessThan(1e-6)
      expect(Math.abs(m.endMmS - line)).toBeLessThan(1e-6)
      for (let k = 0; k <= 20; k++) {
        const s = (m.lengthMm * k) / 20
        const expected = timeAtDistance(s, corner, line, spec.accelMmS2)
        expect(Math.abs(timeAtDistanceInMove(m, s) - expected)).toBeLessThan(1e-6)
      }
    }
  })
})
