import type { FilamentProfile, PrinterProfile } from '../gcode/profileTypes'
import { highFlowWarning, PERIMETER_LOOPS, perimeterBandMm } from '../gcode/emitter'
import { fiducialHoleBoxes } from '../gcode/couponShell'

export type { Firmware, FilamentProfile, PrinterProfile } from '../gcode/profileTypes'
export { defaultFilamentProfile, defaultPrinterProfile } from '../gcode/profileTypes'

/** Which Klipper parameter the test lines sweep. Absent means 'advance' (back-compat). */
export type PaSweepKind = 'advance' | 'smoothTime'

export interface PaTestSpec {
  lineCount: number
  /**
   * Swept parameter range: pressure advance K for an 'advance' sweep, seconds of
   * pressure_advance_smooth_time for a 'smoothTime' sweep.
   */
  paStart: number
  paEnd: number
  /** Swept parameter; omitted means 'advance'. */
  sweep?: PaSweepKind
  /** Pressure advance K applied to every line when sweeping smooth time. */
  fixedAdvance?: number
  slowSegmentMm: number
  fastSegmentMm: number
  slowSpeedMmS: number
  fastSpeedMmS: number
  linePitchMm: number
  marginMm: number
  lineWidthMm: number
}

/** A stage event of the PA analysis; 'measure' carries the per-line progress. */
export interface PaProgress {
  stage: 'decode' | 'align' | 'measure' | 'score' | 'render'
  line?: number
  lineCount?: number
}

export type PaProgressCallback = (progress: PaProgress) => void

export interface Fiducial {
  xMm: number
  yMm: number
}

export interface CouponGeometry {
  baseWidthMm: number
  baseHeightMm: number
  fiducialInsetMm: number
  fiducialSizeMm: number
  fiducials: Fiducial[]
  /** Line-local x of the two speed transitions. */
  transitionXsMm: [number, number]
  /**
   * Line-local x where every test line starts and ends printing. The same for all lines; inside
   * the nominal slow-fast-slow line, trimmed where a line would reach a fiducial hole.
   */
  lineExtentXsMm: [number, number]
  /** Coupon-frame x of the line-local origin: the start of the nominal, untrimmed line. */
  lineStartXMm: number
  /** Coupon-frame y of line i. */
  lineStartYMm: (index: number) => number
}

export interface PaLineScore {
  index: number
  paValue: number
  /** RMS width deviation in transition windows, in mm of width. */
  score: number
  medianWidthMm: number
  measured: boolean
}

/**
 * Whether the sweep bracketed the true optimum, judged by the sign of the per-line transition
 * bulge (deceleration-window minus acceleration-window median width deviation): a sign change
 * across the sweep means the optimum lies inside it; an all-positive column means the true value
 * lies above the printed range, all-negative below it.
 */
export type PaSweepBracket = 'bracketed' | 'above-range' | 'below-range'

export interface PaResult {
  success: boolean
  failureReason: string | null
  lines: PaLineScore[]
  /** Discrete best line index, null on failure. */
  bestLineIndex: number | null
  /** Parabolic-interpolated PA at the score minimum, null on failure. */
  bestPa: number | null
  /** Bulge-sign sweep coverage diagnostic, null on failure. */
  sweepBracket: PaSweepBracket | null
  /**
   * Bootstrap standard error of bestPa (Efron nonparametric bootstrap of the parabolic vertex),
   * null on failure or when the best line sits at the sweep edge (no bracket to interpolate in).
   */
  sePa: number | null
  /** Geometrically measured scan scale along the width-profile direction; null before alignment. */
  measuredPxPerMm: number | null
  flipped: boolean
  rotationQuarterTurns: number
}

export function defaultPaTestSpec(): PaTestSpec {
  return {
    lineCount: 16,
    paStart: 0,
    paEnd: 0.06,
    slowSegmentMm: 20,
    fastSegmentMm: 40,
    slowSpeedMmS: 25,
    fastSpeedMmS: 100,
    linePitchMm: 4,
    marginMm: 8,
    lineWidthMm: 0.45,
  }
}

/** Klipper's default pressure_advance_smooth_time, in seconds. */
export const KLIPPER_DEFAULT_SMOOTH_TIME = 0.04

/** Default smooth-time sweep: 0.01 to 0.06 s around Klipper's 0.04 s default. */
export function defaultSmoothTimeTestSpec(fixedAdvance: number): PaTestSpec {
  return {
    ...defaultPaTestSpec(),
    sweep: 'smoothTime',
    fixedAdvance,
    paStart: 0.01,
    paEnd: 0.06,
  }
}

// Recommended PA sweep ranges by extruder style, from the Klipper pressure advance
// documentation: direct drive tunes below 0.06, a bowden setup can need up to 1.0.
export const extruderPresetRanges = {
  directDrive: { paStart: 0, paEnd: 0.06 },
  bowden: { paStart: 0, paEnd: 1.0 },
} as const

export function paValueForLine(spec: PaTestSpec, index: number): number {
  return spec.paStart + ((spec.paEnd - spec.paStart) * index) / (spec.lineCount - 1)
}

// The optimum sitting on the first or last line means the sweep didn't bracket it: offer a range
// shifted so the current best PA sits in the middle. Takes the spec the analysis was actually run
// against, not any later live form state, so a result stays consistent with what produced it.
export function edgeShiftRange(
  spec: PaTestSpec,
  bestLineIndex: number | null,
): { start: number; end: number } | null {
  if (bestLineIndex === null) return null
  if (bestLineIndex !== 0 && bestLineIndex !== spec.lineCount - 1) return null
  const range = spec.paEnd - spec.paStart
  const centre = paValueForLine(spec, bestLineIndex)
  const start = Math.max(0, centre - range / 2)
  const end = start + range
  // The bottom-edge clamp case (bestLineIndex 0, paStart already 0) produces a shift identical to
  // the current range: offer a refinement narrowing the sweep toward zero instead of a no-op rerun.
  if (bestLineIndex === 0 && start === spec.paStart && end === spec.paEnd) {
    return { start: 0, end: (spec.paEnd - spec.paStart) / 2 }
  }
  return { start, end }
}

export { fitsA4 } from '../gcode/emitter'

/**
 * The largest line count whose baseHeightMm stays within maxHeightMm, inverting
 * baseHeightMm = (n-1)*linePitchMm + 2*marginMm.
 */
export function maxLineCountForHeight(spec: PaTestSpec, maxHeightMm: number): number {
  return Math.floor((maxHeightMm - 2 * spec.marginMm) / spec.linePitchMm) + 1
}

/**
 * The high-flow warning for the fast segment, the coupon's fastest bead and the one whose
 * extrusion the measurement depends on (under-extruding it corrupts the result); null when
 * it stays within the flow limit. Judged on the bead the generator commands, extrusion
 * multiplier included.
 */
export function paFlowWarning(
  profile: PrinterProfile,
  filament: FilamentProfile,
  spec: PaTestSpec,
): string | null {
  return highFlowWarning(profile, filament, spec.lineWidthMm, spec.fastSpeedMmS, 'fast speed')
}

export function couponGeometry(spec: PaTestSpec): CouponGeometry {
  const lineLen = 2 * spec.slowSegmentMm + spec.fastSegmentMm
  const baseWidthMm = lineLen + 2 * spec.marginMm
  const baseHeightMm = (spec.lineCount - 1) * spec.linePitchMm + 2 * spec.marginMm
  const inset = 4
  const size = 5
  // Hole centers; the (min-x, min-y) origin corner deliberately has none.
  const fiducials: Fiducial[] = [
    { xMm: baseWidthMm - inset - size / 2, yMm: inset + size / 2 },
    { xMm: baseWidthMm - inset - size / 2, yMm: baseHeightMm - inset - size / 2 },
    { xMm: inset + size / 2, yMm: baseHeightMm - inset - size / 2 },
  ]
  const transitionXsMm: [number, number] = [spec.slowSegmentMm, spec.slowSegmentMm + spec.fastSegmentMm]
  const lineStartXMm = spec.marginMm
  const lineStartYMm = (index: number) => spec.marginMm + index * spec.linePitchMm
  return {
    baseWidthMm,
    baseHeightMm,
    fiducialInsetMm: inset,
    fiducialSizeMm: size,
    fiducials,
    transitionXsMm,
    lineExtentXsMm: lineExtentXsMm(spec, fiducials, size, lineStartXMm, lineStartYMm, transitionXsMm),
    lineStartXMm,
    lineStartYMm,
  }
}

/**
 * The line-local x range every test line prints over. A line's bead (half the line width either
 * side of its path, and past its end) stays clear of each fiducial hole grown by the band of the
 * base's perimeter loops around it, so no line bridges a hole, covers its rim, or prints over its
 * perimeters. Where any line would come too close to a hole, the nominal line is shortened at
 * that end, and every line shares the shortened range: all lines print the same path apart from
 * the swept parameter, and the speed transitions stay where they are.
 */
function lineExtentXsMm(
  spec: PaTestSpec,
  fiducials: Fiducial[],
  fiducialSizeMm: number,
  lineStartXMm: number,
  lineStartYMm: (index: number) => number,
  transitionXsMm: [number, number],
): [number, number] {
  const lineLen = 2 * spec.slowSegmentMm + spec.fastSegmentMm
  const keepOutMm = perimeterBandMm(PERIMETER_LOOPS, spec.lineWidthMm) + spec.lineWidthMm / 2
  const lineYs = Array.from({ length: spec.lineCount }, (_, i) => lineStartYMm(i))
  let start = 0
  let end = lineLen
  for (const hole of fiducialHoleBoxes(fiducials, fiducialSizeMm, 0, 0)) {
    if (!lineYs.some((y) => y > hole.y0 - keepOutMm && y < hole.y1 + keepOutMm)) continue
    // A hole left of the line's middle shortens its start, one right of it its end.
    if (hole.x0 + hole.x1 < 2 * lineStartXMm + lineLen) {
      start = Math.max(start, hole.x1 + keepOutMm - lineStartXMm)
    } else {
      end = Math.min(end, hole.x0 - keepOutMm - lineStartXMm)
    }
  }
  if (start >= transitionXsMm[0] || end <= transitionXsMm[1]) {
    throw new Error('The fiducial holes leave no slow segment before or after the speed transitions.')
  }
  return [start, end]
}
