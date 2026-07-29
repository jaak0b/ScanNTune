import { defaultPrinterProfile } from '../gcode/profileTypes'
import type { IsAxis, IsTestSpec } from './types'

export const MIN_FRAME_BAND_MM = 12
export const FIDUCIAL_INSET_MM = 4
export const FIDUCIAL_SIZE_MM = 5
export const INNER_MARGIN_MM = 3
export const BLOCK_GAP_MM = 2
/** Length of the moving prime at the start of each run-up leg. */
export const PRIME_MM = 3
/** Leg start clearance from the coupon outer edge, so nothing pokes outside the outline. */
export const LEG_INSET_MM = 3
/** Added to the kinematic deceleration distance to absorb planner rounding. */
export const TAIL_MARGIN_MM = 1
/** Clearance kept between a tail's stop point and the coupon outer perimeter. */
export const TAIL_EDGE_CLEARANCE_MM = 1
/**
 * Straight in-window stretch kept between the window edge and the first sweep tooth, so
 * the fiducial aligner's leg probes (1 and 4 mm inside the window) always land on a
 * straight bead.
 */
export const SWEEP_STUB_MM = 5
/** Bead width plus working clearance reserved between a tooth tip and the neighbouring
 *  line's leg; it caps the lateral tooth depth at `linePitchMm` minus this value. */
export const SWEEP_TOOTH_CLEARANCE_MM = 1
/**
 * Excitation acceleration per hertz of forcing frequency: the `accel_per_hz` default of
 * Klipper's resonance tester (resonance_tester.py), the established
 * reference-implementation scaling that keeps the swing's velocity amplitude near
 * constant (a / (4 f) = 18.75 mm/s) across the band instead of driving every cell at
 * the machine's absolute acceleration ceiling.
 */
export const SWEEP_ACCEL_PER_HZ_MM_S2 = 75

/** Distance to reach `speedMmS` from rest (or stop from it) at `accelMmS2`: v^2 / (2a). */
export function accelRampMm(speedMmS: number, accelMmS2: number): number {
  return (speedMmS * speedMmS) / (2 * accelMmS2)
}

/**
 * Distance a tier needs after the corner to accelerate from the corner speed (the run-up
 * cruise the bend is taken at) to its cruise speed: (v^2 - corner^2) / (2a).
 */
export function tierRampMm(spec: IsTestSpec, speedMmS: number): number {
  return accelRampMm(speedMmS, spec.accelMmS2) - accelRampMm(spec.cornerSpeedMmS, spec.accelMmS2)
}

/**
 * One forcing cell of the resonant run-up sweep: one full period of the ramped zigzag
 * excitation of Klipper's resonance tester (resonance_tester.py, vibrate_axis). Over the
 * period T = 1/freqHz the toolhead advances along the leg at the constant corner speed
 * while a bang-bang lateral acceleration of constant magnitude `accelMmS2` drives one
 * smooth parabolic swing away from the measured direction and back: a quarter period
 * outward, a half period through the extreme, a quarter period back, with zero lateral
 * velocity on the centreline at both cell boundaries, so consecutive cells join tangent
 * parabolas without a cusp. The one-sided swing amplitude is accelMmS2 / (16 freqHz^2).
 */
export interface SweepCell {
  freqHz: number
  /** Effective lateral acceleration: the resonance tester's accel_per_hz scaling
   *  (SWEEP_ACCEL_PER_HZ_MM_S2 * f), never above the spec's acceleration, and capped at
   *  16 f^2 * (linePitchMm - SWEEP_TOOTH_CLEARANCE_MM) so the swing amplitude keeps the
   *  tooth clearance to the neighbouring line's leg. */
  accelMmS2: number
}

/**
 * The sweep's forcing cells: one per cycle, frequencies geometrically spaced from
 * `sweepFromHz` to `sweepToHz` (low first, so the highest frequencies, where stiff
 * machines resonate, excite last and reach the launch corner with the least decay).
 */
export function sweepCells(spec: IsTestSpec): SweepCell[] {
  if (!spec.sweep) return []
  const depthCap = spec.linePitchMm - SWEEP_TOOTH_CLEARANCE_MM
  const n = spec.sweepCycles
  const ratio = Math.pow(spec.sweepToHz / spec.sweepFromHz, 1 / (n - 1))
  return Array.from({ length: n }, (_, k) => {
    const freqHz = spec.sweepFromHz * Math.pow(ratio, k)
    const accelMmS2 = Math.min(
      spec.accelMmS2,
      SWEEP_ACCEL_PER_HZ_MM_S2 * freqHz,
      16 * freqHz * freqHz * depthCap,
    )
    return { freqHz, accelMmS2 }
  })
}

/**
 * The fastest commanded chord speed of the sweep: the vector sum of the constant forward
 * speed and the peak lateral speed a_eff / (4 f) of a cell, maximized over the cells (the
 * chord speeds are per-slice averages, so this instantaneous peak bounds every one of
 * them). Zero when the sweep is disabled.
 */
export function sweepPeakSpeedMmS(spec: IsTestSpec): number {
  const cells = sweepCells(spec)
  if (cells.length === 0) return 0
  return Math.max(
    ...cells.map((c) => Math.hypot(spec.cornerSpeedMmS, c.accelMmS2 / (4 * c.freqHz))),
  )
}

/** In-window leg length the sweep needs: the straight stub plus one corner-speed period
 *  of forward travel per cell, cornerSpeed * sum(1 / f_k). */
export function sweepLegMm(spec: IsTestSpec): number {
  const v = spec.cornerSpeedMmS
  return SWEEP_STUB_MM + sweepCells(spec).reduce((s, c) => s + v / c.freqHz, 0)
}

/** In-window run-up length actually laid out: the sweep's leg when enabled, else the
 *  spec's straight run-up. */
export function effectiveRunUpMm(spec: IsTestSpec): number {
  return spec.sweep ? sweepLegMm(spec) : spec.runUpMm
}

/**
 * A line's protected span, measured from its corner along the measured segment: the
 * acceleration ramp to the tier speed followed by the guaranteed clean read length. No
 * crossing, flow change, or speed change is allowed inside it.
 */
export function protectedSpanMm(spec: IsTestSpec, speedMmS: number): number {
  return tierRampMm(spec, speedMmS) + spec.measuredLineMm
}

/**
 * How deep into the frame band a line's deceleration tail ends, measured from the window
 * edge: the weld overrun plus the kinematic stopping distance. The band is sized so the
 * deepest tail still keeps its edge clearance; no clamp is needed.
 */
function tailDepthMm(speedMmS: number, spec: IsTestSpec): number {
  return spec.weldMm + accelRampMm(speedMmS, spec.accelMmS2) + TAIL_MARGIN_MM
}

/**
 * Width of the frame band the spec needs: at least the structural minimum, and wide enough
 * that the fastest tier's full deceleration tail ends clear of the coupon outer perimeter,
 * so firmware lookahead never bleeds deceleration back into a measured segment.
 */
export function frameBandMm(spec: IsTestSpec): number {
  const deepest = Math.max(...spec.speedsMmS.map((v) => tailDepthMm(v, spec)))
  return Math.max(MIN_FRAME_BAND_MM, deepest + TAIL_EDGE_CLEARANCE_MM)
}

/** An axis-aligned segment or rectangle in coupon-local mm, origin at the min corner. */
export interface IsSegment {
  x0: number
  y0: number
  x1: number
  y1: number
}

export type IsBox = IsSegment

/** One chord of the sweep polyline. */
export interface SweepToothSegment extends IsSegment {
  /** Commanded speed of the chord: its length divided by its fixed time slice (the true
   *  average speed over the slice), so each sweep cell lasts exactly one forcing period. */
  speedMmS: number
}

export interface IsLine {
  speedMmS: number
  /** First stretch of the leg, starting one inset inside the coupon outer edge, entirely
   *  under the frame band, where the un-retract is primed on the move. */
  prime: IsSegment
  /**
   * The straight run-up leg: it starts after the prime, runs through the frame band and
   * into the open window at the corner speed, and ends on the ringing corner. The square
   * corner velocity is validated to at least that speed, so the corner is taken with
   * zero deceleration and the bead is continuous through it.
   */
  runUp: IsSegment
  /**
   * The measured segment: it starts at the corner (the run-up end), crosses the rest of
   * the window, and welds one weld length into the opposite band.
   */
  measured: IsSegment
  /** Colinear continuation of the measured segment: the deceleration tail in the band. */
  tail: IsSegment
  /**
   * The resonant run-up chords: a polyline from the run-up end to the corner, sampling
   * the sweep cells' lateral parabolas uniformly in time (see `sweepCells` and
   * `sweepTeeth`), each chord carrying the commanded speed that makes its time slice
   * exact. Empty when the sweep is disabled; the run-up then reaches the corner directly.
   */
  teeth: SweepToothSegment[]
  /**
   * Protected span from the corner: acceleration ramp plus the clean read length. All
   * crossings of this line lie beyond it.
   */
  protectedMm: number
  /**
   * Distances from the corner at which this line crosses lines printed before it this
   * layer, sorted ascending. Crossings print at full flow (the beads weld into the grid);
   * the distances document that every crossing lies beyond the protected span.
   */
  crossingsMm: number[]
}

export interface IsLineGroup {
  axis: IsAxis
  lines: IsLine[]
  boundingBox: IsBox
}

export interface IsCouponGeometry {
  couponWidthMm: number
  couponHeightMm: number
  frameBandMm: number
  fiducialInsetMm: number
  fiducialSizeMm: number
  /** Hole centers; the (min-x, min-y) origin corner deliberately has none (PA convention). */
  fiducials: { xMm: number; yMm: number }[]
  /** Line groups in print order: the first group is printed first each layer. */
  groups: IsLineGroup[]
  /** The open interior of the frame. */
  windowBox: IsBox
}

/**
 * Perpendicular offsets of every line in a group, ordered by speed tier then line index.
 * Lines within a tier sit one pitch apart; consecutive tiers are separated by an extra gap.
 */
function lineOffsets(spec: IsTestSpec): number[] {
  const blockSpan = (spec.linesPerSpeed - 1) * spec.linePitchMm
  const blockStep = blockSpan + spec.linePitchMm + BLOCK_GAP_MM
  const offsets: number[] = []
  for (let block = 0; block < spec.speedsMmS.length; block++) {
    for (let j = 0; j < spec.linesPerSpeed; j++) {
      offsets.push(block * blockStep + j * spec.linePitchMm)
    }
  }
  return offsets
}

/** Extent of a group's line field perpendicular to its measured direction. */
export function fieldExtentMm(spec: IsTestSpec): number {
  const offsets = lineOffsets(spec)
  return offsets[offsets.length - 1]
}

const speedOf = (spec: IsTestSpec, i: number) =>
  spec.speedsMmS[Math.floor(i / spec.linesPerSpeed)]

/**
 * Per-pair packed depth of a group's corner diagonal, excluding the clean read length.
 * Within each group the SLOWEST tier's lines sit nearest the crossing zone (their small
 * protected span tolerates an early crossing) and the fastest farthest, corners
 * anti-staggered along the field so no leg crosses a same-group measured segment. The
 * binding line maximizes (field extent - its offset) + its tier ramp; adding the clean
 * read length (paid once, by every line alike) gives the exact room the corner diagonal
 * plus every protected span needs. This is tighter than the worst-case form
 * field + max ramp whenever the fastest tier does not sit at offset zero.
 */
export function maxPackedRampMm(spec: IsTestSpec): number {
  const offsets = lineOffsets(spec)
  const F = offsets[offsets.length - 1]
  return Math.max(...offsets.map((off, i) => F - off + tierRampMm(spec, speedOf(spec, i))))
}

/**
 * Chord samples of one cell, uniform in time per constant-acceleration span. Each
 * quarter-period span of duration tau is split into ceil(a * tau / vScv) equal time
 * slices, and the half-period span into twice that count (so its midpoint, the swing's
 * extreme, lands on a vertex); the common slice keeps every adjacent-chord per-axis
 * velocity step within the square corner velocity: within a span the average lateral
 * chord velocities differ by exactly a * dt, they are equal across the two span
 * boundaries inside a cell (the lateral velocity is continuous and the accelerations
 * mirror), and across a cell boundary they differ by at most a * dt again. Vertices lie
 * on the exact parabolas lat(t) = lat0 + v0 t + a t^2 / 2.
 */
function cellChords(cell: SweepCell, vScvMmS: number): { dtS: number; latMm: number }[] {
  const T = 1 / cell.freqHz
  const a = cell.accelMmS2
  const nQ = Math.max(1, Math.ceil((a * (T / 4)) / vScvMmS))
  const dtS = T / 4 / nQ
  const vP = (a * T) / 4
  const lat1 = (-a * (T / 4) ** 2) / 2
  const chords: { dtS: number; latMm: number }[] = []
  // Span 1, T/4 at -a: rest on the centreline down to lateral speed -vP.
  for (let i = 1; i <= nQ; i++) {
    const t = i * dtS
    chords.push({ dtS, latMm: (-a * t * t) / 2 })
  }
  // Span 2, T/2 at +a: -vP through the extreme -a / (16 f^2) at mid-span, up to +vP.
  for (let i = 1; i <= 2 * nQ; i++) {
    const t = i * dtS
    chords.push({ dtS, latMm: lat1 - vP * t + (a * t * t) / 2 })
  }
  // Span 3, T/4 at -a: +vP back to rest exactly on the centreline.
  for (let i = 1; i <= nQ; i++) {
    const t = i * dtS
    chords.push({ dtS, latMm: i === nQ ? 0 : lat1 + vP * t - (a * t * t) / 2 })
  }
  return chords
}

/**
 * The sweep chords of one line, built backward from its corner: the total forward
 * advance is cornerSpeed * sum(1 / f_k), so the polyline starts that far behind the
 * corner and its last vertex is the corner. `leg` is the unit travel direction of the
 * run-up leg and `lateral` the unit direction of the measured segment: every swing
 * (negative lateral offset) points AWAY from the measured direction, into the corridor
 * toward the neighbouring legs whose in-phase swings keep the same pitch. The leg starts
 * and ends on the centreline with zero lateral velocity, so the launch corner stays the
 * only full per-axis velocity step.
 */
function sweepTeeth(
  spec: IsTestSpec,
  vScvMmS: number,
  corner: { x: number; y: number },
  leg: { x: number; y: number },
  lateral: { x: number; y: number },
): SweepToothSegment[] {
  const cells = sweepCells(spec)
  if (cells.length === 0) return []
  const v = spec.cornerSpeedMmS
  const advance = cells.reduce((s, c) => s + v / c.freqHz, 0)
  const startX = corner.x - leg.x * advance
  const startY = corner.y - leg.y * advance
  let fwd = 0
  let px = startX
  let py = startY
  const segs: SweepToothSegment[] = []
  for (const cell of cells) {
    for (const { dtS, latMm } of cellChords(cell, vScvMmS)) {
      fwd += v * dtS
      const x = startX + leg.x * fwd + lateral.x * latMm
      const y = startY + leg.y * fwd + lateral.y * latMm
      segs.push({ x0: px, y0: py, x1: x, y1: y, speedMmS: Math.hypot(x - px, y - py) / dtS })
      px = x
      py = y
    }
  }
  return segs
}

function boundingBox(lines: IsLine[]): IsBox {
  const segs = (l: IsLine) => [l.prime, l.runUp, l.measured, l.tail, ...l.teeth]
  const xs = lines.flatMap((l) => segs(l).flatMap((s) => [s.x0, s.x1]))
  const ys = lines.flatMap((l) => segs(l).flatMap((s) => [s.y0, s.y1]))
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

/**
 * Y-axis group, printed first: each line starts one inset above the coupon's bottom outer
 * edge, runs vertically up through the bottom band (this through-band stretch hosts the
 * travel arrival, the moving prime, and the start blob, all ironed flat by the band pass
 * printed after it), continues into the open window as the run-up, cruises at the corner
 * speed straight into the sharp corner, and the measured segment runs
 * +X into the right band. The corners sit near the window's left side on a descending
 * diagonal: the corner x DECREASES as the line's y increases, so a later line's vertical
 * leg always passes left of every earlier corner and never crosses an earlier measured
 * segment. Tier order runs bottom-up, so the slowest lines (smallest protected span) take
 * the largest corner x, nearest the crossing zone: the per-pair packing.
 */
function buildYGroup(
  spec: IsTestSpec,
  vScvMmS: number,
  bandMm: number,
  couponW: number,
): IsLineGroup {
  const offsets = lineOffsets(spec)
  const F = fieldExtentMm(spec)
  const advance = effectiveRunUpMm(spec) - (spec.sweep ? SWEEP_STUB_MM : 0)
  const lines = offsets.map((off, i) => {
    const speedMmS = speedOf(spec, i)
    const y = bandMm + effectiveRunUpMm(spec) + off
    const x = bandMm + INNER_MARGIN_MM + (F - off)
    const teeth = sweepTeeth(spec, vScvMmS, { x, y }, { x: 0, y: 1 }, { x: 1, y: 0 })
    const legEndY = spec.sweep ? y - advance : y
    return {
      speedMmS,
      prime: { x0: x, y0: LEG_INSET_MM, x1: x, y1: LEG_INSET_MM + PRIME_MM },
      runUp: { x0: x, y0: LEG_INSET_MM + PRIME_MM, x1: x, y1: legEndY },
      measured: { x0: x, y0: y, x1: couponW - bandMm + spec.weldMm, y1: y },
      tail: { x0: couponW - bandMm + spec.weldMm, y0: y, x1: couponW - bandMm + tailDepthMm(speedMmS, spec), y1: y },
      teeth,
      protectedMm: protectedSpanMm(spec, speedMmS),
      crossingsMm: [],
    }
  })
  return { axis: 'y', lines, boundingBox: boundingBox(lines) }
}

/**
 * X-axis group, printed second: each line starts one inset inside the coupon's right
 * outer edge, runs horizontally through the right band, continues -X into the window as
 * the run-up, corners at the corner speed, and the measured segment runs -Y
 * (downward) into the bottom band. The corners sit near the window's top on a diagonal
 * mirroring the Y group's packing: the FASTEST lines take the highest corners (their long
 * protected span needs the most depth above the crossing zone) and, anti-staggered, the
 * smallest corner x; the corner y then DECREASES as the corner x increases, so no leg
 * crosses a same-group measured segment. When the Y group exists, every X measured line
 * crosses every Y measured line; the crossing distances (from the X line's corner) are
 * recorded so the emitter can zero the flow over the already-printed beads. The window
 * sizing guarantees each crossing lies beyond BOTH lines' protected spans plus the inner
 * margin.
 */
function buildXGroup(
  spec: IsTestSpec,
  vScvMmS: number,
  bandMm: number,
  couponW: number,
  couponH: number,
  yGroup: IsLineGroup | null,
): IsLineGroup {
  const offsets = lineOffsets(spec)
  const F = fieldExtentMm(spec)
  // With a Y group present the X field starts past the Y group's packed corner diagonal
  // (stagger + protected spans) and one inner margin keeping the crossings' flow ramps
  // clear of the read windows.
  const firstX = yGroup
    ? bandMm + 2 * INNER_MARGIN_MM + maxPackedRampMm(spec) + spec.measuredLineMm
    : bandMm + INNER_MARGIN_MM
  const yMeasured = yGroup ? yGroup.lines.map((l) => l.measured.y0) : []
  const advance = effectiveRunUpMm(spec) - (spec.sweep ? SWEEP_STUB_MM : 0)
  const lines = offsets.map((off, i) => {
    const speedMmS = speedOf(spec, i)
    const x = firstX + (F - off)
    const y = couponH - bandMm - INNER_MARGIN_MM - (F - off)
    const teeth = sweepTeeth(spec, vScvMmS, { x, y }, { x: -1, y: 0 }, { x: 0, y: -1 })
    const legEndX = spec.sweep ? x + advance : x
    return {
      speedMmS,
      prime: { x0: couponW - LEG_INSET_MM, y0: y, x1: couponW - LEG_INSET_MM - PRIME_MM, y1: y },
      runUp: { x0: couponW - LEG_INSET_MM - PRIME_MM, y0: y, x1: legEndX, y1: y },
      measured: { x0: x, y0: y, x1: x, y1: bandMm - spec.weldMm },
      tail: { x0: x, y0: bandMm - spec.weldMm, x1: x, y1: bandMm - tailDepthMm(speedMmS, spec) },
      teeth,
      protectedMm: protectedSpanMm(spec, speedMmS),
      crossingsMm: yMeasured.map((yk) => y - yk).sort((a, b) => a - b),
    }
  })
  return { axis: 'x', lines, boundingBox: boundingBox(lines) }
}

/**
 * Coupon-local layout. Both groups share one open window and deliberately cross each
 * other in the window's lower right region, welding the free beads into a stiff grid. A
 * crossing between an X line and a Y line is legal only past both lines' protected spans
 * plus one inner margin; the interior is derived EXACTLY from that per-pair constraint,
 * with no padding:
 *
 *   interior width  = margin + packed(Y) + margin + F (X field) + runUp
 *   interior height = runUp + F (Y field) + margin + packed(X) + margin
 *
 * where F is the field extent, packed(g) = maxPackedRampMm + clean read length is group
 * g's per-pair packed corner diagonal (slowest lines nearest the crossing zone), and
 * runUp the in-window leg length before each group's first corner (the through-band leg
 * stretch is extra and comes free from the band width). Both expressions are equal, so
 * the two-axis coupon is square. With a single axis the crossing terms drop: the measured
 * direction needs margin + packed and the perpendicular one margin + F + runUp.
 */
export function isCouponGeometry(
  spec: IsTestSpec,
  // The square corner velocity only shapes the sweep chords' time slicing; the footprint,
  // line positions, and swing amplitudes are independent of it, so consumers that never
  // read the chords (aligner, analyzer, previews) may rely on the profile default.
  squareCornerVelocityMmS: number = defaultPrinterProfile().squareCornerVelocityMmS,
): IsCouponGeometry {
  const hasX = spec.axes.includes('x')
  const hasY = spec.axes.includes('y')
  const packed = maxPackedRampMm(spec) + spec.measuredLineMm
  const F = fieldExtentMm(spec)
  const runUp = effectiveRunUpMm(spec)
  const crossTerm = INNER_MARGIN_MM + F + runUp
  const interiorW = hasY
    ? INNER_MARGIN_MM + packed + (hasX ? crossTerm : 0)
    : INNER_MARGIN_MM + F + runUp
  const interiorH = hasX
    ? INNER_MARGIN_MM + packed + (hasY ? crossTerm : 0)
    : INNER_MARGIN_MM + F + runUp
  const bandMm = frameBandMm(spec)
  const couponWidthMm = interiorW + 2 * bandMm
  const couponHeightMm = interiorH + 2 * bandMm

  // Print order: the Y group first (its measured lines cross nothing), then the X group,
  // whose measured lines carry the crossing dips over the Y beads.
  const groups: IsLineGroup[] = []
  const yGroup = hasY ? buildYGroup(spec, squareCornerVelocityMmS, bandMm, couponWidthMm) : null
  if (yGroup) groups.push(yGroup)
  if (hasX) {
    groups.push(
      buildXGroup(spec, squareCornerVelocityMmS, bandMm, couponWidthMm, couponHeightMm, yGroup),
    )
  }

  const inset = FIDUCIAL_INSET_MM
  const size = FIDUCIAL_SIZE_MM
  return {
    couponWidthMm,
    couponHeightMm,
    frameBandMm: bandMm,
    fiducialInsetMm: inset,
    fiducialSizeMm: size,
    fiducials: [
      { xMm: couponWidthMm - inset - size / 2, yMm: inset + size / 2 },
      { xMm: couponWidthMm - inset - size / 2, yMm: couponHeightMm - inset - size / 2 },
      { xMm: inset + size / 2, yMm: couponHeightMm - inset - size / 2 },
    ],
    groups,
    windowBox: {
      x0: bandMm,
      y0: bandMm,
      x1: couponWidthMm - bandMm,
      y1: couponHeightMm - bandMm,
    },
  }
}
