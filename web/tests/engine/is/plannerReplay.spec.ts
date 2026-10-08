import { describe, expect, it } from 'vitest'
import {
  replayGcode,
  sCurveRampDistanceMm,
  timeAtDistanceInMove,
  type PlannedJunction,
  type ReplayFirmware,
  type ReplayKinematics,
} from '../../helpers/plannerReplay'
import { generateIsGcodeWithReport } from '../../../src/engine/is/gcodeGenerator'
import { defaultIsTestRequest, fitSpecToPrinter } from '../../../src/engine/is/types'
import { isCouponGeometry, timeAtDistance } from '../../../src/engine/is/couponGeometry'
import { couponOrigin, type CouponPlacement } from '../../../src/engine/gcode/couponShell'
import {
  defaultFilamentProfile,
  defaultPrinterProfile,
  type Firmware,
} from '../../../src/engine/gcode/profileTypes'

// The planner oracle (tests/helpers/plannerReplay.ts) replays G-code through ports of the
// Klipper, Marlin and RepRapFirmware planners and imports no production code. These tests
// first pin the oracle against hand-derived planner behaviour, then replay the generated input
// shaper coupon on every planner.

describe('planner replay oracle', () => {
  it('takes a Klipper 90 degree corner at the square corner velocity', () => {
    const r = replayGcode(
      'SET_VELOCITY_LIMIT VELOCITY=300 ACCEL=3000 SQUARE_CORNER_VELOCITY=20 MINIMUM_CRUISE_RATIO=0\n' +
        'G1 X50 Y0 F6000\nG1 X50 Y50 F6000\n',
      { firmware: 'klipper', kinematics: 'cartesian' },
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
      { firmware: 'klipper', kinematics: 'cartesian' },
    )
    expect(r.junctions[0].speedMmS).toBeCloseTo(54.7723, 4)
  })

  it('takes a Marlin classic-jerk reversal at the jerk value', () => {
    // +X then -X at 100 mm/s with 10 mm/s jerk: the reversal rule counts max(v_exit, -v_entry),
    // so the junction is held at 10 mm/s (the axis swings from +10 to -10).
    const r = replayGcode('M205 X10 Y10\nG1 X50 Y0 F6000\nG1 X0 Y0 F6000\n', {
      firmware: 'marlinClassic',
      kinematics: 'cartesian',
    })
    expect(r.junctions[0].speedMmS).toBeCloseTo(10, 9)
  })

  it('starts a Marlin classic move from an empty queue at the jerk-limited safe speed', () => {
    // planner.synchronize() empties the queue; the next block starts at safe_speed, here the
    // 100 mm/s feed limited to the 10 mm/s jerk, on Cartesian and on CoreXY (both motors move
    // at 100 mm/s for a pure X move, each limited to 10).
    for (const kinematics of ['cartesian', 'corexy'] as const) {
      const r = replayGcode('M205 X10 Y10\nG4 P0\nG1 X50 Y0 F6000\n', { firmware: 'marlinClassic', kinematics })
      expect(r.starts[0].move.startMmS).toBeCloseTo(10, 9)
      expect(r.starts[0].motorSpeedMmS).toBeCloseTo(10, 9)
    }
  })

  it('takes a Marlin junction deviation corner at sqrt(a J (sqrt(2) + 1))', () => {
    // J = 0.1 mm at 3000 mm/s^2: sqrt(3000 x 0.1 x 2.414214) = 26.91215 mm/s (hand-derived).
    const r = replayGcode('M204 P3000 T3000\nM205 J0.1\nG1 X50 Y0 F6000\nG1 X50 Y50 F6000\n', {
      firmware: 'marlinJd',
      kinematics: 'cartesian',
    })
    expect(r.junctions[0].speedMmS).toBeCloseTo(26.91215, 4)
  })

  it('applies RepRapFirmware jerk to the Cartesian direction, also on CoreXY', () => {
    // M566 1200 mm/min = 20 mm/s per axis: the corner passes at 20 mm/s on both machines; on
    // CoreXY one motor reverses from -20 to +20, a 40 mm/s step.
    const gcode = 'M566 X1200 Y1200\nG1 X50 Y0 F6000\nG1 X50 Y50 F6000\n'
    const cart = replayGcode(gcode, { firmware: 'rrf', kinematics: 'cartesian' })
    const core = replayGcode(gcode, { firmware: 'rrf', kinematics: 'corexy' })
    expect(cart.junctions[0].speedMmS).toBeCloseTo(20, 9)
    expect(cart.junctions[0].motorStepMmS).toBeCloseTo(20, 9)
    expect(core.junctions[0].speedMmS).toBeCloseTo(20, 9)
    expect(core.junctions[0].motorStepMmS).toBeCloseTo(40, 9)
  })

  it('ends a Marlin S-curve acceleration at the trapezoid distance', () => {
    // 20 to 150 mm/s at 3000 mm/s^2: (150^2 - 20^2) / 6000 = 3.683333 mm.
    expect(sCurveRampDistanceMm(20, 150, 3000)).toBeCloseTo(3.683333, 6)
  })

  it("flags a Klipper move beyond its default maximum extrusion cross-section", () => {
    // 0.905 mm of 1.75 mm filament over 3 mm is 0.7256 mm^2, above 4 x 0.4^2 = 0.64 mm^2.
    const r = replayGcode('G1 X3 Y0 E0.905 F1800\nG1 X6 Y0 E0.79824 F1800\n', {
      firmware: 'klipper',
      kinematics: 'cartesian',
    })
    expect(r.crossSectionViolations.map((v) => v.line)).toEqual([0])
    expect(r.crossSectionViolations[0].areaMm2).toBeCloseTo(0.7256, 4)
  })

  it('scales every commanded feed by the speed factor (M220)', () => {
    const r = replayGcode(
      'SET_VELOCITY_LIMIT VELOCITY=300 ACCEL=3000 SQUARE_CORNER_VELOCITY=200 MINIMUM_CRUISE_RATIO=0\n' +
        'M220 S90\nG1 X50 Y0 F6000\nG1 X50 Y50 F6000\n',
      { firmware: 'klipper', kinematics: 'cartesian' },
    )
    expect(r.junctions[0].speedMmS).toBeCloseTo(90, 9)
  })
})

const PLANNERS: [ReplayFirmware, Firmware][] = [
  ['klipper', 'Klipper'],
  ['marlinJd', 'Marlin'],
  ['marlinClassic', 'Marlin'],
  ['rrf', 'RepRapFirmware'],
]
/** The default profile's own corner limit as each planner stores it: 5 mm/s square corner
 *  velocity, 5 mm/s jerk, or the 0.010 mm junction deviation Marlin's range floor gives it. */
const PROFILE_LIMIT: Record<ReplayFirmware, number> = {
  klipper: 5,
  marlinJd: 0.01,
  marlinClassic: 5,
  rrf: 5,
}

const cases: [ReplayFirmware, Firmware, ReplayKinematics, CouponPlacement, boolean][] = []
for (const [planner, firmware] of PLANNERS) {
  for (const kinematics of ['cartesian', 'corexy'] as const) {
    for (const placement of ['center', 'front'] as const) {
      for (const contrastBase of [false, true]) cases.push([planner, firmware, kinematics, placement, contrastBase])
    }
  }
}

describe('the input shaper coupon on each firmware planner', () => {
  const filament = defaultFilamentProfile()

  it.each(cases)('%s (%s profile) on %s, %s placement, contrast base %s', (planner, firmware, kinematics, placement, contrastBase) => {
    const profile = { ...defaultPrinterProfile(), firmware }
    const request = { ...defaultIsTestRequest(profile), placement, contrastBase }
    const { gcode } = generateIsGcodeWithReport(profile, filament, request)
    const spec = fitSpecToPrinter(request, profile).spec
    const g = isCouponGeometry(spec)
    const { ox, oy } = couponOrigin(profile, g.couponWidthMm, g.couponHeightMm, placement)
    // A speed factor left at 90% before the print: the coupon's M220 S100 must undo it.
    const r = replayGcode(gcode, { firmware: planner, kinematics, initialSpeedFactor: 0.9 })
    const motorFactor = kinematics === 'corexy' ? 2 : 1
    const linesPerLayer = g.printOrder.length

    expect(r.crossSectionViolations).toEqual([])

    // The ladder corners: the junction where a run-up ends on its line's corner and the
    // measured segment turns 90 degrees.
    const cornerKeys = new Set(
      g.groups.flatMap((grp) =>
        grp.lines.map((l) => `${(ox + l.measured.x0).toFixed(3)},${(oy + l.measured.y0).toFixed(3)}`),
      ),
    )
    const isCorner = (j: PlannedJunction) =>
      cornerKeys.has(`${j.x.toFixed(3)},${j.y.toFixed(3)}`) &&
      j.prev.e > 0 &&
      j.next.e > 0 &&
      Math.abs((j.prev.x1 - j.prev.x0) * (j.next.x1 - j.next.x0) + (j.prev.y1 - j.prev.y0) * (j.next.y1 - j.next.y0)) < 1e-6
    const corners = r.junctions.filter(isCorner)
    expect(corners).toHaveLength(2 * linesPerLayer)
    for (const c of corners) {
      // Each corner passes at its own commanded rung: no braking, and the motor step is the
      // rung (Cartesian) or twice the rung (the CoreXY motor that reverses).
      expect(Math.abs(c.speedMmS - c.prev.feedMmS)).toBeLessThan(1e-3)
      expect(Math.abs(c.motorStepMmS - motorFactor * c.prev.feedMmS)).toBeLessThan(2e-3)
    }
    // The kicks never fall within a layer: the fastest corners print last.
    for (let layer = 0; layer < 2; layer++) {
      const kicks = corners.slice(layer * linesPerLayer, (layer + 1) * linesPerLayer).map((c) => c.motorStepMmS)
      for (let k = 1; k < kicks.length; k++) expect(kicks[k]).toBeGreaterThanOrEqual(kicks[k - 1] - 1e-9)
    }

    // The raised corner limit covers exactly each line's run-up, measured segment, tail and
    // coast; everything else (preamble, base, band, travels, primes, wipes) is queued under the
    // profile's own limit.
    const raised = new Set(r.moves.filter((m) => Math.abs(m.cornerLimit - PROFILE_LIMIT[planner]) > 1e-9))
    expect(raised.size).toBe(4 * 2 * linesPerLayer)
    // Inside the line phase only the ladder corners kick: every other junction there is
    // colinear and continuous.
    for (const j of r.junctions) {
      if ((raised.has(j.prev) || raised.has(j.next)) && !isCorner(j)) {
        expect(j.cartesianStepMmS).toBeLessThan(1e-9)
      }
    }

    // Every move from rest starts at or below the profile's limit: from standstill on Klipper,
    // RepRapFirmware and junction-deviation Marlin, at most the profile jerk per motor on
    // classic-jerk Marlin.
    const startLimit = planner === 'marlinClassic' ? 5 : 0.05
    for (const s of r.starts) expect(s.motorSpeedMmS).toBeLessThanOrEqual(startLimit + 1e-9)

    // Isolated kicks: the travel to each line, its moving prime and its wipe each begin a
    // planner segment (the planner came to rest before them), so no corner kick follows a
    // travel or wipe junction and none lands on a rotor still ringing from the last line.
    const segmentStarts = new Set(r.starts.map((s) => s.move))
    const at = (x: number, y: number) => `${x.toFixed(3)},${y.toFixed(3)}`
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
    // uses: the commanded trapezoid from the rung to the line speed (on Marlin also with an
    // S-curve ramp, from the end of the ramp on), cruising to the end of the measured move.
    for (const c of corners) {
      const m = c.next
      const corner = c.prev.feedMmS
      const line = m.feedMmS
      expect(Math.abs(m.cruiseMmS - line)).toBeLessThan(1e-6)
      expect(Math.abs(m.endMmS - line)).toBeLessThan(1e-6)
      const rampMm = (line * line - corner * corner) / (2 * spec.accelMmS2)
      for (let k = 0; k <= 20; k++) {
        const s = (m.lengthMm * k) / 20
        const expected = timeAtDistance(s, corner, line, spec.accelMmS2)
        expect(Math.abs(timeAtDistanceInMove(m, s) - expected)).toBeLessThan(1e-6)
        if (planner.startsWith('marlin') && s >= rampMm) {
          expect(Math.abs(timeAtDistanceInMove(m, s, true) - expected)).toBeLessThan(1e-6)
        }
      }
    }
  })
})
