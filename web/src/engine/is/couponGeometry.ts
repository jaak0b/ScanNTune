import type { IsAxis, IsTestSpec } from './types'

export const MIN_FRAME_BAND_MM = 12
export const FIDUCIAL_INSET_MM = 4
export const FIDUCIAL_SIZE_MM = 5
export const INNER_MARGIN_MM = 3
/** Length of the moving prime at the start of each run-up leg. */
export const PRIME_MM = 3
/** Leg start clearance from the coupon outer edge, so nothing pokes outside the outline. */
export const LEG_INSET_MM = 3
/** Added to the kinematic deceleration distance to absorb planner rounding. */
export const TAIL_MARGIN_MM = 1
/** Clearance kept between a tail's stop point and the coupon outer perimeter. */
export const TAIL_EDGE_CLEARANCE_MM = 1
/** Distance from the corner where the traced read starts: clears the corner blob and keeps
 *  the perpendicular profile window off the run-up bead, which is colinear with the window at
 *  the corner itself. */
export const TRACE_START_MM = 1

/** Distance to reach `speedMmS` from rest (or stop from it) at `accelMmS2`: v^2 / (2a). */
export function accelRampMm(speedMmS: number, accelMmS2: number): number {
  return (speedMmS * speedMmS) / (2 * accelMmS2)
}

/**
 * Time since the corner at arc distance sMm along the commanded trapezoidal velocity profile
 * (constant-acceleration kinematics): t(s) = (sqrt(v0^2 + 2 a s) - v0) / a inside the
 * acceleration ramp from the corner speed to the tier speed, then linear at the cruise speed.
 */
export function timeAtDistance(
  sMm: number,
  cornerSpeedMmS: number,
  tierSpeedMmS: number,
  accelMmS2: number,
): number {
  const rampMm = (tierSpeedMmS * tierSpeedMmS - cornerSpeedMmS * cornerSpeedMmS) / (2 * accelMmS2)
  if (sMm <= rampMm) {
    return (Math.sqrt(cornerSpeedMmS * cornerSpeedMmS + 2 * accelMmS2 * sMm) - cornerSpeedMmS) / accelMmS2
  }
  const tRamp = (tierSpeedMmS - cornerSpeedMmS) / accelMmS2
  return tRamp + (sMm - rampMm) / tierSpeedMmS
}

/** Below this corner speed the excitation is too weak to leave a readable trace; it is
 *  also the bottom rung of the corner-speed excitation ladder. */
export const MIN_CORNER_SPEED_MM_S = 20

/**
 * The top rung of one tier's corner-speed ladder: the spec's corner speed, or the tier's own
 * line speed when that is slower. A line's run-up cruises into the corner at its rung, and a
 * cruise faster than the line it feeds would brake into the corner instead of passing it.
 */
export function tierLadderTopMmS(spec: IsTestSpec, tierSpeedMmS: number): number {
  return Math.min(spec.cornerSpeedMmS, tierSpeedMmS)
}

/**
 * The corner-speed excitation ladder of one tier: its lines take their ringing corner at
 * geometrically spaced speeds from MIN_CORNER_SPEED_MM_S up to the tier's ladder top, one
 * rung per line, the step-excitation idea of Klipper's ringing tower: the print self-ranges,
 * so the ringing is pronounced on some lines regardless of frame stiffness. One entry per
 * rung, lowest first. `tierSpeedMmS` defaults to the fastest tier, whose ladder top is the
 * spec's corner speed.
 */
export function ladderCornerSpeeds(
  spec: IsTestSpec,
  tierSpeedMmS: number = Math.max(...spec.speedsMmS),
): number[] {
  const n = spec.linesPerSpeed
  const top = tierLadderTopMmS(spec, tierSpeedMmS)
  if (n === 1) return [top]
  const ratio = Math.pow(top / MIN_CORNER_SPEED_MM_S, 1 / (n - 1))
  return Array.from({ length: n }, (_, j) => MIN_CORNER_SPEED_MM_S * Math.pow(ratio, j))
}

/**
 * Distance a line needs after the corner to accelerate from its corner speed (the run-up
 * cruise the bend is taken at) to its cruise speed: (v^2 - corner^2) / (2a). The corner
 * speed defaults to the spec's top rung; ladder-aware callers pass the line's own rung.
 */
export function tierRampMm(
  spec: IsTestSpec,
  speedMmS: number,
  cornerSpeedMmS: number = spec.cornerSpeedMmS,
): number {
  return accelRampMm(speedMmS, spec.accelMmS2) - accelRampMm(cornerSpeedMmS, spec.accelMmS2)
}

/** Hard floor of the clean read length; the default is derived per tier speed instead
 *  (five wavelengths of the lowest resonance of interest: 5 * tierSpeed / 25 Hz). */
export const MIN_MEASURED_LINE_MM = 20

/**
 * A line's protected span, measured from its corner along the measured segment: the
 * acceleration ramp to the tier speed followed by the guaranteed clean read length. No
 * crossing, flow change, or speed change is allowed inside it.
 */
export function protectedSpanMm(
  spec: IsTestSpec,
  speedMmS: number,
  cornerSpeedMmS: number = spec.cornerSpeedMmS,
): number {
  return tierRampMm(spec, speedMmS, cornerSpeedMmS) + spec.measuredLineMm
}

/** What the band width depends on: the tiers, the weld and the acceleration. */
type BandInputs = Pick<IsTestSpec, 'speedsMmS' | 'weldMm' | 'accelMmS2'>

/**
 * How deep into the frame band a line's deceleration tail ends, measured from the window
 * edge: the weld overrun plus the kinematic stopping distance. The band is sized so the
 * deepest tail still keeps its edge clearance; no clamp is needed.
 */
function tailDepthMm(speedMmS: number, spec: Pick<IsTestSpec, 'weldMm' | 'accelMmS2'>): number {
  return spec.weldMm + accelRampMm(speedMmS, spec.accelMmS2) + TAIL_MARGIN_MM
}

/**
 * Width of the frame band the spec needs: at least the structural minimum, and wide enough
 * that the fastest tier's full deceleration tail ends clear of the coupon outer perimeter,
 * so firmware lookahead never bleeds deceleration back into a measured segment.
 */
export function frameBandMm(spec: BandInputs): number {
  const deepest = Math.max(...spec.speedsMmS.map((v) => tailDepthMm(v, spec)))
  return Math.max(MIN_FRAME_BAND_MM, deepest + TAIL_EDGE_CLEARANCE_MM)
}

/**
 * Length of the shortest run-up move, from the end of the prime to the corner: the line at
 * offset zero of either group, whose leg starts LEG_INSET_MM + PRIME_MM inside the outer edge
 * and runs through the band and the in-window run-up. Every other line's run-up move is longer
 * by its offset.
 */
export function shortestRunUpMoveMm(spec: BandInputs & Pick<IsTestSpec, 'runUpMm'>): number {
  return frameBandMm(spec) + spec.runUpMm - LEG_INSET_MM - PRIME_MM
}

/** An axis-aligned segment or rectangle in coupon-local mm, origin at the min corner. */
export interface IsSegment {
  x0: number
  y0: number
  x1: number
  y1: number
}

export type IsBox = IsSegment

export interface IsLine {
  speedMmS: number
  /** Speed the line's run-up cruises into the ringing corner at: this line's rung of its
   *  tier's corner-speed excitation ladder. */
  cornerSpeedMmS: number
  /** The line's rung on its tier's ladder, 0 for the lowest (MIN_CORNER_SPEED_MM_S). */
  rungIndex: number
  /** First stretch of the leg, starting one inset inside the coupon outer edge, entirely
   *  under the frame band, where the un-retract is primed on the move. */
  prime: IsSegment
  /**
   * The straight run-up leg: it starts after the prime, runs through the frame band and
   * into the open window at the corner speed, and ends on the ringing corner. The emitted
   * corner limit equals that speed, so the corner is taken with zero deceleration and the
   * bead is continuous through it.
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
   * Protected span from the corner: acceleration ramp plus the clean read length. All
   * crossings of this line lie beyond it.
   */
  protectedMm: number
  /**
   * Distances from the corner at which this line crosses lines printed before it this
   * layer (see IsCouponGeometry.printOrder), sorted ascending. Crossings print at full flow
   * (the beads weld into the grid); the distances document that every crossing lies beyond
   * the protected span.
   */
  crossingsMm: number[]
}

export interface IsLineGroup {
  axis: IsAxis
  /** The group's lines in field order: offset zero first (see fieldSlots). */
  lines: IsLine[]
  boundingBox: IsBox
}

/** One line of the coupon, addressed by its group and its index inside the group. */
export interface IsLineRef {
  groupIndex: number
  lineIndex: number
}

export interface IsCouponGeometry {
  couponWidthMm: number
  couponHeightMm: number
  frameBandMm: number
  fiducialInsetMm: number
  fiducialSizeMm: number
  /** Hole centers; the (min-x, min-y) origin corner deliberately has none (PA convention). */
  fiducials: { xMm: number; yMm: number }[]
  /** Line groups: the Y group first when present, then the X group. */
  groups: IsLineGroup[]
  /**
   * The order the lines print in on every layer: by corner speed ascending, so the fastest
   * corners print last; equal corner speeds print Y group before X group and the slower tier
   * first.
   */
  printOrder: IsLineRef[]
  /** The open interior of the frame. */
  windowBox: IsBox
}

/** The speed tiers in ascending order: the slowest tier is tier 0. */
function ascendingTiers(spec: IsTestSpec): number[] {
  return [...spec.speedsMmS].sort((a, b) => a - b)
}

/** What one perpendicular slot of a group's line field carries. */
interface FieldSlot {
  /** Index into the ascending tiers. */
  tier: number
  rung: number
}

/**
 * The perpendicular slots of a group's line field, offset zero first, one pitch apart. Rung j
 * of every tier occupies the block of slots j * T to j * T + T - 1 (T tiers), so the ladder
 * rises with the offset like the one-tier field does. Inside a block the tiers alternate
 * direction, slowest first on even rungs and fastest first on odd rungs (ABBA counterbalancing,
 * Fisher's blocking principle): both tiers then sample the same positions along the ringing
 * axis, so a position-dependent machine property (belt stiffness changing towards the travel
 * ends) cannot read as a speed effect. With an even line count the tiers' mean offsets are
 * equal; with an odd count they differ by one pitch divided by the line count, the least any
 * assignment to a uniform pitch grid can reach (the offsets then sum to an odd number of
 * pitches, which cannot split evenly). The slowest tier takes offset zero, where its shorter
 * ramp keeps the packed corner diagonal smallest.
 */
function fieldSlots(spec: IsTestSpec): FieldSlot[] {
  const tiers = spec.speedsMmS.length
  const slots: FieldSlot[] = []
  for (let rung = 0; rung < spec.linesPerSpeed; rung++) {
    for (let k = 0; k < tiers; k++) {
      slots.push({ tier: rung % 2 === 0 ? k : tiers - 1 - k, rung })
    }
  }
  return slots
}

/** A slot resolved to its perpendicular offset, tier speed and corner speed. */
interface PlacedSlot {
  offsetMm: number
  speedMmS: number
  cornerSpeedMmS: number
  rung: number
}

function placedSlots(spec: IsTestSpec): PlacedSlot[] {
  const tiers = ascendingTiers(spec)
  const ladders = tiers.map((v) => ladderCornerSpeeds(spec, v))
  return fieldSlots(spec).map((slot, k) => ({
    offsetMm: k * spec.linePitchMm,
    speedMmS: tiers[slot.tier],
    cornerSpeedMmS: ladders[slot.tier][slot.rung],
    rung: slot.rung,
  }))
}

/** Extent of a group's line field perpendicular to its measured direction. */
export function fieldExtentMm(spec: IsTestSpec): number {
  return (spec.speedsMmS.length * spec.linesPerSpeed - 1) * spec.linePitchMm
}

/**
 * Per-pair packed depth of a group's corner diagonal, excluding the clean read length. The
 * corners are anti-staggered along the field so no leg crosses a same-group measured segment;
 * the binding line maximizes (field extent - its offset) + its own ramp from its rung to its
 * tier speed. Adding the clean read length (paid once, by every line alike) gives the exact
 * room the corner diagonal plus every protected span needs.
 */
export function maxPackedRampMm(spec: IsTestSpec): number {
  const F = fieldExtentMm(spec)
  return Math.max(
    ...placedSlots(spec).map(
      (s) => F - s.offsetMm + tierRampMm(spec, s.speedMmS, s.cornerSpeedMmS),
    ),
  )
}

function boundingBox(lines: IsLine[]): IsBox {
  const segs = (l: IsLine) => [l.prime, l.runUp, l.measured, l.tail]
  const xs = lines.flatMap((l) => segs(l).flatMap((s) => [s.x0, s.x1]))
  const ys = lines.flatMap((l) => segs(l).flatMap((s) => [s.y0, s.y1]))
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

/**
 * Y-axis group: each line starts one inset above the coupon's bottom outer edge, runs
 * vertically up through the bottom band (this through-band stretch hosts the travel arrival,
 * the moving prime, and the start blob, all ironed flat by the band pass printed after it),
 * continues into the open window as the run-up, cruises at its corner speed straight into
 * the sharp corner, and the measured segment runs +X into the right band. The corners sit
 * near the window's left side on a descending diagonal: the corner x DECREASES as the line's
 * y increases, so a line's vertical leg always passes left of every corner below it and never
 * crosses a same-group measured segment, whatever the print order.
 */
function buildYGroup(spec: IsTestSpec, bandMm: number, couponW: number): IsLineGroup {
  const F = fieldExtentMm(spec)
  const lines = placedSlots(spec).map((s) => {
    const y = bandMm + spec.runUpMm + s.offsetMm
    const x = bandMm + INNER_MARGIN_MM + (F - s.offsetMm)
    return {
      speedMmS: s.speedMmS,
      cornerSpeedMmS: s.cornerSpeedMmS,
      rungIndex: s.rung,
      prime: { x0: x, y0: LEG_INSET_MM, x1: x, y1: LEG_INSET_MM + PRIME_MM },
      runUp: { x0: x, y0: LEG_INSET_MM + PRIME_MM, x1: x, y1: y },
      measured: { x0: x, y0: y, x1: couponW - bandMm + spec.weldMm, y1: y },
      tail: {
        x0: couponW - bandMm + spec.weldMm,
        y0: y,
        x1: couponW - bandMm + tailDepthMm(s.speedMmS, spec),
        y1: y,
      },
      protectedMm: protectedSpanMm(spec, s.speedMmS, s.cornerSpeedMmS),
      crossingsMm: [] as number[],
    }
  })
  return { axis: 'y', lines, boundingBox: boundingBox(lines) }
}

/**
 * X-axis group: each line starts one inset inside the coupon's right outer edge, runs
 * horizontally through the right band, continues -X into the window as the run-up, corners at
 * its corner speed, and the measured segment runs -Y (downward) into the bottom band. The
 * corners sit near the window's top on a diagonal mirroring the Y group's packing (same field
 * slots): the corner y DECREASES as the corner x increases, so no leg crosses a same-group
 * measured segment. When the Y group exists, every X measured line crosses every Y measured
 * line; the window sizing guarantees each crossing lies beyond BOTH lines' protected spans plus
 * the inner margin, whichever of the two prints first.
 */
function buildXGroup(
  spec: IsTestSpec,
  bandMm: number,
  couponW: number,
  couponH: number,
  hasY: boolean,
): IsLineGroup {
  const F = fieldExtentMm(spec)
  // With a Y group present the X field starts past the Y group's packed corner diagonal
  // (stagger + protected spans) and one inner margin keeping the crossings' flow ramps
  // clear of the read windows.
  const firstX = hasY
    ? bandMm + 2 * INNER_MARGIN_MM + maxPackedRampMm(spec) + spec.measuredLineMm
    : bandMm + INNER_MARGIN_MM
  const lines = placedSlots(spec).map((s) => {
    const x = firstX + (F - s.offsetMm)
    const y = couponH - bandMm - INNER_MARGIN_MM - (F - s.offsetMm)
    return {
      speedMmS: s.speedMmS,
      cornerSpeedMmS: s.cornerSpeedMmS,
      rungIndex: s.rung,
      prime: { x0: couponW - LEG_INSET_MM, y0: y, x1: couponW - LEG_INSET_MM - PRIME_MM, y1: y },
      runUp: { x0: couponW - LEG_INSET_MM - PRIME_MM, y0: y, x1: x, y1: y },
      measured: { x0: x, y0: y, x1: x, y1: bandMm - spec.weldMm },
      tail: { x0: x, y0: bandMm - spec.weldMm, x1: x, y1: bandMm - tailDepthMm(s.speedMmS, spec) },
      protectedMm: protectedSpanMm(spec, s.speedMmS, s.cornerSpeedMmS),
      crossingsMm: [] as number[],
    }
  })
  return { axis: 'x', lines, boundingBox: boundingBox(lines) }
}

/**
 * Print order: corner speed ascending, so the corners that kick the motors hardest come last
 * in every layer and a step loss from them cannot shift lines printed after it; equal corner
 * speeds keep the group order (Y first) and then the slower tier first. Line positions do not
 * depend on the order.
 */
function linePrintOrder(groups: IsLineGroup[]): IsLineRef[] {
  const refs = groups.flatMap((group, groupIndex) =>
    group.lines.map((_, lineIndex) => ({ groupIndex, lineIndex })),
  )
  const line = (r: IsLineRef) => groups[r.groupIndex].lines[r.lineIndex]
  return refs.sort(
    (a, b) =>
      line(a).cornerSpeedMmS - line(b).cornerSpeedMmS ||
      a.groupIndex - b.groupIndex ||
      line(a).speedMmS - line(b).speedMmS ||
      a.lineIndex - b.lineIndex,
  )
}

/**
 * Records on every line the distances from its corner to the crossings with lines of the
 * other group printed before it this layer. A Y line runs +X from its corner at height y and
 * an X line runs -Y from its corner at x, so they cross at (x_X, y_Y): x_X - x_cornerY along
 * the Y line and y_cornerX - y_Y along the X line.
 */
function recordCrossings(groups: IsLineGroup[], order: IsLineRef[]): void {
  const printed: IsLineRef[] = []
  for (const ref of order) {
    const line = groups[ref.groupIndex].lines[ref.lineIndex]
    const axis = groups[ref.groupIndex].axis
    const crossings: number[] = []
    for (const earlier of printed) {
      if (earlier.groupIndex === ref.groupIndex) continue
      const other = groups[earlier.groupIndex].lines[earlier.lineIndex]
      crossings.push(
        axis === 'y' ? other.measured.x0 - line.measured.x0 : line.measured.y0 - other.measured.y0,
      )
    }
    line.crossingsMm = crossings.sort((a, b) => a - b)
    printed.push(ref)
  }
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
 * g's per-pair packed corner diagonal, and runUp the in-window leg length before each group's
 * first corner (the through-band leg stretch is extra and comes free from the band width).
 * Both expressions are equal, so the two-axis coupon is square. With a single axis the
 * crossing terms drop: the measured direction needs margin + packed and the perpendicular one
 * margin + F + runUp.
 */
export function isCouponGeometry(spec: IsTestSpec): IsCouponGeometry {
  const hasX = spec.axes.includes('x')
  const hasY = spec.axes.includes('y')
  const packed = maxPackedRampMm(spec) + spec.measuredLineMm
  const F = fieldExtentMm(spec)
  const runUp = spec.runUpMm
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

  const groups: IsLineGroup[] = []
  if (hasY) groups.push(buildYGroup(spec, bandMm, couponWidthMm))
  if (hasX) groups.push(buildXGroup(spec, bandMm, couponWidthMm, couponHeightMm, hasY))
  const printOrder = linePrintOrder(groups)
  recordCrossings(groups, printOrder)

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
    printOrder,
    windowBox: {
      x0: bandMm,
      y0: bandMm,
      x1: couponWidthMm - bandMm,
      y1: couponHeightMm - bandMm,
    },
  }
}
