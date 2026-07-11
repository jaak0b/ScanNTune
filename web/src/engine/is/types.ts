import type { PrinterProfile } from '../gcode/profileTypes'
import type { CouponPlacement } from '../gcode/couponShell'
import {
  accelRampMm,
  fieldExtentMm,
  frameBandMm,
  INNER_MARGIN_MM,
  isCouponGeometry,
  maxPackedRampMm,
} from './couponGeometry'

export { accelRampMm }

export type IsAxis = 'x' | 'y'

export interface IsTestSpec {
  /** Cruise speeds of the measured segments, one sub-block of lines per tier. */
  speedsMmS: number[]
  linesPerSpeed: number
  /**
   * Guaranteed clean read length of each measured segment, counted AFTER the acceleration
   * ramp from the corner: the layout reserves ramp + this length per line before any
   * crossing or flow change is allowed, and the printed segment continues past it through
   * the crossing zone into the opposite band.
   */
  measuredLineMm: number
  /** In-window length of the straight run-up leg before the ringing corner; the
   *  through-band leg stretch is extra and comes free from the band width. */
  runUpMm: number
  linePitchMm: number
  axes: IsAxis[]
  accelMmS2: number
  /**
   * Cruise speed of the run-up leg, fixed across all tiers, and the size of the ringing
   * excitation. The emitted motion limits set the firmware's corner limit to this value,
   * so the planner takes the 90 degree corner at the full corner speed with zero deceleration:
   * the pressure dump K * (v_in - v_corner) is zero by construction and the bead stays
   * continuous. The excitation is the per-axis velocity step at the corner (the run-up
   * axis stops, the measured axis starts, each by this speed); the residual ring
   * amplitude is approximately delta-v over omega, so a higher corner speed rings the
   * frame proportionally harder.
   */
  cornerSpeedMmS: number
  /** How far each measured segment extends into the frame band at both ends. */
  weldMm: number
  /** Where the coupon sits on the bed: centered, or pushed to the front/back edge. */
  placement: CouponPlacement
  /**
   * Whether the coupon prints on a solid contrasting-color base (consumed by the
   * generator): base layers in the first filament under the entire footprint, band and
   * window alike, then a filament swap pause, then the coupon in the second filament.
   * The base backs the open window, so the scanned silhouette shows the base color
   * between the test lines instead of the backing behind the part. The pedestal and
   * measured layers shift up by the base thickness; the scan face (the top, laid face
   * down on the glass) and the traced geometry are unchanged.
   */
  contrastBase: boolean
}

export const MIN_SPEED_TIERS = 1
export const MAX_SPEED_TIERS = 3
export const MIN_LINES_PER_SPEED = 3
export const MAX_LINES_PER_SPEED = 6
/** Hard floor of the clean read length; the default is derived per tier speed instead
 *  (five wavelengths of the lowest resonance of interest: 5 * tierSpeed / 25 Hz). */
export const MIN_MEASURED_LINE_MM = 20
/**
 * Default corner (run-up) speed. The per-axis velocity step at the corner leaves a
 * residual ring amplitude of approximately delta-v over omega: at 100 mm/s about
 * 0.64 mm at 25 Hz down to 0.27 mm at 60 Hz, several scanner pixels at 600 dpi even
 * on stiff frames. A 150 mm/s corner step skipped steps and shifted layers on a
 * sturdy CoreXY test machine, so the default stays at 100; users with stiff machines
 * can raise it.
 */
export const DEFAULT_CORNER_SPEED_MM_S = 100
/** Below this corner speed the excitation is too weak to leave a readable trace. */
export const MIN_CORNER_SPEED_MM_S = 20
/** Below this acceleration the ringing trace is often too weak to measure. */
const LOW_ACCEL_MM_S2 = 4000
/** Default acceleration floor: the same threshold, so a default spec never starts in the
 *  low-acceleration warning zone. */
const MIN_ACCEL_MM_S2 = LOW_ACCEL_MM_S2

export function defaultIsTestSpec(profile: PrinterProfile): IsTestSpec {
  return {
    // One tier: the ringing frequency is speed-independent, so extra tiers are only
    // replicates; the replicates come from linesPerSpeed instead, which costs less
    // coupon width than a second tier's ramp and block gap.
    speedsMmS: [150],
    linesPerSpeed: 5,
    // Five ringing wavelengths of the lowest resonance of interest at the tier speed:
    // 5 * tierSpeed / 25 Hz, so 30 mm at the 150 mm/s default tier.
    measuredLineMm: 30,
    // Hosts the ramp to the 100 mm/s default corner speed (about 1.25 mm at 4000 mm/s^2)
    // with cruise to spare; the through-band leg stretch is extra.
    runUpMm: 8,
    // The pitch must exceed twice the expected residual ring amplitude plus the bead
    // width; the worst case is about 0.64 mm of amplitude at the default corner speed
    // (see DEFAULT_CORNER_SPEED_MM_S), so 2.5 mm keeps neighbouring traces apart.
    linePitchMm: 2.5,
    axes: ['x', 'y'],
    accelMmS2: Math.max(profile.printAccelMmS2, MIN_ACCEL_MM_S2),
    cornerSpeedMmS: DEFAULT_CORNER_SPEED_MM_S,
    weldMm: 1,
    placement: 'center',
    contrastBase: false,
  }
}

/** Throws on a spec the generator cannot print; called before any G-code is emitted. */
export function validateIsSpec(spec: IsTestSpec): void {
  if (spec.speedsMmS.length < MIN_SPEED_TIERS || spec.speedsMmS.length > MAX_SPEED_TIERS) {
    throw new Error(`Between ${MIN_SPEED_TIERS} and ${MAX_SPEED_TIERS} speed tiers are required`)
  }
  if (spec.speedsMmS.some((v) => v <= 0)) throw new Error('Every speed tier must be positive')
  if (spec.linesPerSpeed < MIN_LINES_PER_SPEED || spec.linesPerSpeed > MAX_LINES_PER_SPEED) {
    throw new Error(
      `Lines per speed must be between ${MIN_LINES_PER_SPEED} and ${MAX_LINES_PER_SPEED}`,
    )
  }
  if (spec.measuredLineMm < MIN_MEASURED_LINE_MM) {
    throw new Error(`The measured line length must be at least ${MIN_MEASURED_LINE_MM} mm`)
  }
  if (spec.runUpMm <= 0) throw new Error('Run-up length must be positive')
  if (spec.linePitchMm <= 0) throw new Error('Line pitch must be positive')
  if (spec.accelMmS2 <= 0) throw new Error('Acceleration must be positive')
  if (spec.cornerSpeedMmS < MIN_CORNER_SPEED_MM_S) {
    throw new Error(
      `The corner speed must be at least ${MIN_CORNER_SPEED_MM_S} mm/s; below that the ` +
        'corner excitation is too weak to leave a readable trace.',
    )
  }
  if (spec.speedsMmS.some((v) => v < spec.cornerSpeedMmS)) {
    throw new Error(
      `Every speed tier must be at least the ${spec.cornerSpeedMmS} mm/s corner speed; a ` +
        'slower tier would cap the corner below the corner speed and weaken the excitation.',
    )
  }
  if (spec.weldMm <= 0) throw new Error('Weld length must be positive')
  if (spec.axes.length === 0) throw new Error('At least one axis must be selected')
}

/**
 * Warns (does not throw) on spec combinations that weaken the ringing signal. The run-up
 * leg only needs to reach the corner speed before the corner: the emitted corner limit
 * equals that speed, so it cruises straight into the bend with no deceleration term. The
 * acceleration ramp from the corner to each tier speed is reserved by the layout in
 * front of the clean read length, so a long ramp grows the coupon instead of eating the
 * measured line; no per-tier warning is needed for it.
 */
export function rampWarnings(spec: IsTestSpec): string[] {
  const warnings: string[] = []
  if (spec.accelMmS2 < LOW_ACCEL_MM_S2) {
    warnings.push(
      'Low acceleration weakens the ringing signal; the test works best at the ' +
        "printer's true maximum acceleration.",
    )
  }
  // The run-up must reach its cruise speed before the corner: v^2 / 2a from rest.
  const rampUpMm = accelRampMm(spec.cornerSpeedMmS, spec.accelMmS2)
  if (rampUpMm > spec.runUpMm) {
    warnings.push(
      `The ${spec.runUpMm} mm run-up is too short to reach the ${spec.cornerSpeedMmS} mm/s ` +
        `corner speed at ${spec.accelMmS2} mm/s^2. Lengthen the run-up.`,
    )
  }
  return warnings
}

/**
 * Shrinks the spec until the coupon fits the configured bed: the highest speed tier is
 * dropped first (never below a single tier), then the measured lines are shortened toward the
 * minimum length. Throws when the bed cannot host even the smallest coupon. Every
 * reduction is described in a user-worded note.
 */
export function fitSpecToBed(
  spec: IsTestSpec,
  profile: PrinterProfile,
): { spec: IsTestSpec; notes: string[] } {
  const fits = (s: IsTestSpec): boolean => {
    const g = isCouponGeometry(s)
    return g.couponWidthMm <= profile.bedWidthMm && g.couponHeightMm <= profile.bedDepthMm
  }
  const notes: string[] = []
  let fitted = spec

  while (!fits(fitted) && fitted.speedsMmS.length > MIN_SPEED_TIERS) {
    const dropped = Math.max(...fitted.speedsMmS)
    fitted = { ...fitted, speedsMmS: fitted.speedsMmS.filter((v) => v !== dropped) }
    notes.push(
      `The ${dropped} mm/s speed tier was removed because the full coupon does not fit ` +
        'the configured bed.',
    )
  }

  if (!fits(fitted)) {
    // Invert the interior formulas of isCouponGeometry for the clean read length L: along
    // a group's measured direction the interior is margin + maxPackedRampMm + L, plus the
    // crossing terms (margin + field + run-up) when both axes are present. The band width
    // and the packed ramp depend on the speed tiers, not on L, so they are constants
    // here; solve the longest L each constrained bed dimension allows and take the
    // tighter one.
    const band = frameBandMm(fitted)
    const field = fieldExtentMm(fitted)
    const both = fitted.axes.length === 2
    const crossTerm = both ? INNER_MARGIN_MM + field + fitted.runUpMm : 0
    const fixed = 2 * band + INNER_MARGIN_MM + maxPackedRampMm(fitted) + crossTerm
    const limits: number[] = []
    if (fitted.axes.includes('y')) {
      limits.push(profile.bedWidthMm - fixed)
    }
    if (fitted.axes.includes('x')) {
      limits.push(profile.bedDepthMm - fixed)
    }
    const target = Math.max(MIN_MEASURED_LINE_MM, Math.floor(Math.min(...limits)))
    if (target < fitted.measuredLineMm) {
      notes.push(
        `The measured lines were shortened from ${fitted.measuredLineMm} mm to ${target} mm ` +
          'so the coupon fits the configured bed.',
      )
      fitted = { ...fitted, measuredLineMm: target }
    }
  }

  if (!fits(fitted)) {
    throw new Error('The coupon does not fit the configured bed even at the shortest line length')
  }
  return { spec: fitted, notes }
}
