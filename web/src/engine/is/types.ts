import type { PrinterProfile } from '../gcode/profileTypes'
import { availableBedDepthMm, type CouponPlacement } from '../gcode/couponShell'
import { NOMINAL_WIDTH_FACTOR } from '../gcode/emitter'
import { normalQuantile } from '../math'
import {
  accelRampMm,
  fieldExtentMm,
  frameBandMm,
  INNER_MARGIN_MM,
  isCouponGeometry,
  ladderCornerSpeeds,
  maxPackedRampMm,
  MIN_ACCEPTED_LINES,
  MIN_CORNER_SPEED_MM_S,
  MIN_MEASURED_LINE_MM,
  protectedSpanMm,
  shortestRunUpMoveMm,
  tierLadderTopMmS,
  tierRampMm,
  timeAtDistance,
  TRACE_START_MM,
} from './couponGeometry'
import { klipperCentripetalCornerCapMmS } from './firmwareMotion'

export { accelRampMm, MIN_ACCEPTED_LINES, MIN_CORNER_SPEED_MM_S, MIN_MEASURED_LINE_MM }

export type IsAxis = 'x' | 'y'

export interface IsTestSpec {
  /**
   * Cruise speeds of the measured segments, one ladder of lines per tier. A request carries
   * two tiers, the line speed and the slower derived tier of speedTiersFor; fitSpecToPrinter
   * drops the slower one only when it falls below the ladder's bottom rung or the bed is too
   * small for both.
   */
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
   * TOP of the corner-speed excitation ladder, derived by fitSpecToPrinter
   * (fastestReadableCornerMmS): the fastest corner whose bead still follows a ring at one grid
   * frequency of the band at least, on the slowest tier, and never faster than the corner
   * ceiling (cornerCeilingMmS). Each tier's lines take their corner at run-up speeds spaced from
   * MIN_CORNER_SPEED_MM_S up to this value, one rung per line (the step-excitation idea of
   * Klipper's ringing tower: the print self-ranges, so some lines ring visibly regardless of
   * frame stiffness; see ladderCornerSpeeds). The emitted motion limits set the firmware's
   * corner limit to the line's own rung, so the planner takes every 90 degree corner at that
   * line's full run-up speed with zero deceleration: the pressure dump K * (v_in - v_corner) is
   * zero by construction and the bead stays continuous. The excitation is the per-axis velocity
   * step at the corner; the residual ring amplitude is approximately delta-v over omega, so
   * faster rungs ring the frame proportionally harder.
   */
  topCornerMmS: number
  /**
   * The fastest corner speed whose bead still follows a ring at every grid frequency of the band
   * on the slowest tier (fastestFollowableCornerMmS), derived by fitSpecToPrinter. The ladder places its
   * lowest rungs at or below it (ladderCornerSpeeds), so the generator, the analysis and the
   * simulators all read the same rungs from this one value.
   */
  followableCornerMmS: number
  /**
   * The damping ratio the bead followability is judged at (ringPathMinRadiusMm): the coupon is
   * generated before the printer's damping is measured, so it is designed for a lightly damped
   * frame. defaultIsTestRequest sets FOLLOWABILITY_DAMPING_RATIO.
   */
  followabilityDampingRatio: number
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

/**
 * What the page asks for: a spec without its line count and its ladder corners. All three are
 * always derived by fitSpecToPrinter (fastestFollowableCornerMmS, fastestReadableCornerMmS,
 * ladderLinesPerSpeed), so the generator and the analysis both read one fitted IsTestSpec.
 */
export type IsTestRequest = Omit<IsTestSpec, 'linesPerSpeed' | 'followableCornerMmS' | 'topCornerMmS'>

/** A request whose ladder corners are resolved, its line count still open. */
type LadderRequest = Omit<IsTestSpec, 'linesPerSpeed'>

/** Frequency search range of the ringing fit: the flow's measurable resonance band. */
export const F_MIN_HZ = 20
export const F_MAX_HZ = 200
/** Step of the band's frequency grid, Hz: the detection grid's frequency axis and the grid the
 *  coupon's bead followability is checked on. */
export const FREQUENCY_GRID_HZ = 1

/** The flow's false-alarm level for every detection decision (0.1%). */
export const DETECTION_ALPHA = 0.001
/**
 * Confidence gate: the pooled 95% confidence halfwidth must stay under 10% of the
 * frequency. The EI shaper family suppresses vibration below its 5% tolerance only within
 * roughly +/-10-15% of its target frequency, so a wider interval cannot guarantee the true
 * resonance lies inside the configured shaper's stopband.
 */
export const MAX_CI95_REL = 0.1
/** Power the two-tier speed check is designed for at the weakest accepted measurement. */
export const SPEED_CHECK_POWER = 0.95

/**
 * Ratio between the two speed tiers. A real resonance keeps its frequency when the line
 * speed changes, so d = ln(f_slow / f_fast) is 0; a pattern fixed in the print or the scan
 * (belt teeth, scanner artifacts) is fixed in arc length, so its frequency scales with the
 * speed and d = -ln(rho). The branch of the speed check that refuses an axis is "frequency
 * changed with speed": d = 0 rejected two-sided at DETECTION_ALPHA, critical value
 * z_(1-alpha/2) = z_0.9995 = 3.2905. The ratio is sized so a pattern is refused with power
 * SPEED_CHECK_POWER at the weakest measurement the confidence gate accepts: a 95% halfwidth of
 * MAX_CI95_REL of the frequency, so a relative standard error of MAX_CI95_REL / z_0.975 =
 * 0.05102 for the axis estimate. Each tier is fitted from half of the axis's lines, so its
 * standard error is sqrt(2) times that, and the difference of the two independent tier log
 * frequencies has sqrt(2) times a tier's (delta method): s_d = 2 * MAX_CI95_REL / z_0.975 =
 * 0.10204. A two-sided z test separates two hypotheses ln(rho) apart at level alpha with power
 * 1 - beta when ln(rho) = (z_(1-alpha/2) + z_(1-beta)) * s_d, the standard power relation
 * (the far rejection tail is negligible), so
 * rho = exp((z_0.9995 + z_0.95) * 2 * 0.1 / z_0.975) = exp((3.2905 + 1.6449) * 0.10204) = 1.6547.
 * Whether the check reaches this power on real fits (a tier near the gate can miss its own
 * detection on half the lines, and its standard error varies from fit to fit) is a matter of
 * the analysis and an open item there.
 */
export const TIER_SPEED_RATIO = Math.exp(
  ((normalQuantile(1 - DETECTION_ALPHA / 2) + normalQuantile(SPEED_CHECK_POWER)) *
    2 *
    MAX_CI95_REL) /
    normalQuantile(0.975),
)

/**
 * The two speed tiers of a line speed, slowest first: the line speed and the derived slower
 * tier, rounded down to a whole mm/s so the ratio between them is never below
 * TIER_SPEED_RATIO. The second tier is slower, never faster, so it never raises the flow or
 * the motion demands above what the user entered.
 */
export function speedTiersFor(lineSpeedMmS: number): number[] {
  return [Math.floor(lineSpeedMmS / TIER_SPEED_RATIO), lineSpeedMmS]
}

/**
 * The slowest whole-number line speed that keeps both tiers: its derived slower tier
 * (speedTiersFor) still reaches MIN_CORNER_SPEED_MM_S, the bottom rung of every tier's
 * corner-speed ladder, ceil(MIN_CORNER_SPEED_MM_S * TIER_SPEED_RATIO) = 34 mm/s. Below it
 * fitSpecToPrinter drops the slower tier.
 */
export const MIN_TWO_TIER_LINE_SPEED_MM_S = Math.ceil(MIN_CORNER_SPEED_MM_S * TIER_SPEED_RATIO)

export const MIN_SPEED_TIERS = 1
export const MAX_SPEED_TIERS = 2
export const MIN_LINES_PER_SPEED = 3
/** Extra replicate lines cost little coupon area and raise the chance that at least the
 *  required three lines per axis survive print damage and scan artifacts. */
export const MAX_LINES_PER_SPEED = 15
/** The line speed the defaults are built around. */
const DEFAULT_LINE_SPEED_MM_S = 150

export function defaultIsTestRequest(profile: PrinterProfile): IsTestRequest {
  return {
    // Two tiers: a real resonance keeps its frequency at both speeds, while print and scan
    // patterns change with the speed (see TIER_SPEED_RATIO).
    speedsMmS: speedTiersFor(DEFAULT_LINE_SPEED_MM_S),
    // Five wavelengths of the lowest resonance of interest at the tier speed:
    // 5 * tierSpeed / 25 Hz, so 30 mm at the 150 mm/s default tier.
    measuredLineMm: 30,
    // Hosts the ramp to the ladder's top corner (55.4 mm/s by default, a 0.51 mm ramp at
    // 3000 mm/s^2) with cruise to spare; the through-band leg stretch is extra.
    runUpMm: 8,
    // The pitch must exceed twice the expected residual ring amplitude plus the bead
    // width; the ring amplitude is about the corner speed over omega, 0.44 mm for the default
    // 55.4 mm/s top corner at 20 Hz, so 2.5 mm keeps neighbouring traces apart.
    linePitchMm: 2.5,
    axes: ['x', 'y'],
    // The test runs at the profile's own print acceleration: the ringing excitation is the
    // velocity step at the corner, which the acceleration does not set.
    accelMmS2: profile.printAccelMmS2,
    followabilityDampingRatio: FOLLOWABILITY_DAMPING_RATIO,
    weldMm: 1,
    placement: 'center',
    contrastBase: false,
  }
}

/** Throws on a request the generator cannot print; called before any G-code is emitted. */
export function validateIsSpec(spec: IsTestRequest): void {
  if (spec.speedsMmS.length < MIN_SPEED_TIERS || spec.speedsMmS.length > MAX_SPEED_TIERS) {
    throw new Error(`Between ${MIN_SPEED_TIERS} and ${MAX_SPEED_TIERS} speed tiers are required`)
  }
  if (spec.speedsMmS.some((v) => v <= 0)) throw new Error('Every speed tier must be positive')
  if (spec.measuredLineMm < MIN_MEASURED_LINE_MM) {
    throw new Error(`The measured line length must be at least ${MIN_MEASURED_LINE_MM} mm`)
  }
  if (spec.runUpMm <= 0) throw new Error('Run-up length must be positive')
  if (spec.linePitchMm <= 0) throw new Error('Line pitch must be positive')
  if (spec.accelMmS2 <= 0) throw new Error('Acceleration must be positive')
  // The ladder's bottom rung needs a line at least as fast as it. A slower tier below that
  // floor is not an error: fitSpecToPrinter drops it (fitTiersToLadder).
  if (Math.max(...spec.speedsMmS) < MIN_CORNER_SPEED_MM_S) {
    throw new Error(
      `The line speed must be at least the ${MIN_CORNER_SPEED_MM_S} mm/s lowest corner speed. ` +
        'Below that, the corner excitation is too weak to leave a readable trace.',
    )
  }
  if (spec.weldMm <= 0) throw new Error('Weld length must be positive')
  if (spec.axes.length === 0) throw new Error('At least one axis must be selected')
}

/**
 * Warns (does not throw) on spec combinations that weaken the ringing signal. The run-up
 * leg only needs to reach the ladder's top corner speed before the corner: the emitted corner
 * limit equals that speed, so it cruises straight into the bend with no deceleration term. The
 * acceleration ramp from the corner to each tier speed is reserved by the layout in
 * front of the clean read length, so a long ramp grows the coupon instead of eating the
 * measured line; no per-tier warning is needed for it.
 */
export function rampWarnings(spec: IsTestSpec): string[] {
  const warnings: string[] = []
  // The run-up must reach its cruise speed before the corner: v^2 / 2a from rest.
  const rampUpMm = accelRampMm(spec.topCornerMmS, spec.accelMmS2)
  if (rampUpMm > spec.runUpMm) {
    warnings.push(
      `The ${spec.runUpMm} mm run-up is too short to reach the ${spec.topCornerMmS} mm/s ` +
        `corner speed at ${spec.accelMmS2} mm/s^2. Lengthen the run-up.`,
    )
  }
  return warnings
}

/**
 * Damping ratio the bead followability is evaluated at, carried on the request as
 * followabilityDampingRatio. The coupon is generated before the damping is known, so it is
 * designed for a lightly damped frame: a well-built CoreXY printer measured a damping ratio of
 * 0.033 on its X axis by an accelerometer, so 0.03 lies on the safe side of it. Klipper's 0.075 to 0.15 (shaper_calibrate.py
 * TEST_DAMPING_RATIOS) is the range its shapers are made robust over, not a floor on printers, and
 * a lighter damping keeps the ring larger for longer, so assuming it is the safe side.
 */
export const FOLLOWABILITY_DAMPING_RATIO = 0.03
/** Sampling step of the followability evaluation along the read window. */
const FOLLOWABILITY_STEP_MM = 0.1
/** Resolution of the followable corner speed. */
const FOLLOWABLE_CORNER_STEP_MM_S = 0.1
/** What a line's ring path depends on besides its tier and corner speeds. */
type RingPathInputs = Pick<IsTestSpec, 'accelMmS2' | 'measuredLineMm' | 'followabilityDampingRatio'>

/**
 * The smallest radius of curvature of a ring path over a line's read window, from the first
 * traced sample (TRACE_START_MM past the corner) to the end of its protected span, for a
 * resonance at `frequencyHz` (the band top F_MAX_HZ unless stated). The corner's velocity step c
 * leaves a lateral ring of amplitude A(t) = (c / omega) e^(-zeta omega t); written over the
 * along-track speed u, the path y = A sin(omega t) has the radius of curvature
 * R = u^2 / (A omega^2) at its crests. The along-track speed follows the commanded profile after
 * the corner, sqrt(c^2 + 2 a s) up to the tier speed, lowered by the along-track axis' own ring
 * by up to c e^(-zeta omega_a t) (the along axis takes the same velocity step c at the corner);
 * omega_a is taken at F_MIN_HZ, the slowest decay the band allows. The radius grows along the
 * window, but it is evaluated at every sample rather than assumed monotonic.
 */
export function ringPathMinRadiusMm(
  spec: RingPathInputs,
  tierSpeedMmS: number,
  cornerSpeedMmS: number,
  frequencyHz: number = F_MAX_HZ,
): number {
  const omega = 2 * Math.PI * frequencyHz
  const omegaAlong = 2 * Math.PI * F_MIN_HZ
  const zeta = spec.followabilityDampingRatio
  const a = spec.accelMmS2
  const c = cornerSpeedMmS
  const endMm = protectedSpanMm(spec, tierSpeedMmS, cornerSpeedMmS)
  const steps = Math.max(1, Math.ceil((endMm - TRACE_START_MM) / FOLLOWABILITY_STEP_MM))
  let minRadius = Infinity
  for (let k = 0; k <= steps; k++) {
    const s = TRACE_START_MM + ((endMm - TRACE_START_MM) * k) / steps
    const t = timeAtDistance(s, c, tierSpeedMmS, a)
    const speed = Math.min(tierSpeedMmS, Math.sqrt(c * c + 2 * a * s))
    const along = speed - c * Math.exp(-zeta * omegaAlong * t)
    if (along <= 0) return 0
    const amplitude = (c / omega) * Math.exp(-zeta * omega * t)
    minRadius = Math.min(minRadius, (along * along) / (amplitude * omega * omega))
  }
  return minRadius
}

/**
 * Whether a line's bead follows a ring at `frequencyHz` over its whole read window. The bead
 * edges are the offset curves of the path at plus and minus half the bead width, and an offset
 * curve stays regular only while the path's radius of curvature exceeds the offset (Farouki and
 * Neff, "Analytic properties of plane offset curves", CAGD 7, 1990); below that the edge folds
 * into a cusp and the traced centreline no longer follows the nozzle. The bead width is the
 * measured layers' nominal width.
 */
function followsRing(
  spec: RingPathInputs,
  profile: PrinterProfile,
  tierSpeedMmS: number,
  cornerSpeedMmS: number,
  frequencyHz: number,
): boolean {
  const halfWidthMm = (profile.nozzleDiameterMm * NOMINAL_WIDTH_FACTOR) / 2
  return ringPathMinRadiusMm(spec, tierSpeedMmS, cornerSpeedMmS, frequencyHz) > halfWidthMm
}

/**
 * The highest frequency up to which a corner's bead follows a ring at every point of the band's
 * frequency grid (every FREQUENCY_GRID_HZ from F_MIN_HZ), found by scanning upward to the first
 * failure; null when it fails already at F_MIN_HZ. Followability is not monotone in frequency: a
 * higher frequency curves the ring more sharply per unit amplitude, but its ring also decays
 * faster in time, so a corner can fold inside the band and follow again at its top. Only the scan
 * from the bottom of the band is safe.
 */
function followedBandTopHz(
  spec: RingPathInputs,
  profile: PrinterProfile,
  tierSpeedMmS: number,
  cornerSpeedMmS: number,
): number | null {
  let top: number | null = null
  for (let f = F_MIN_HZ; f <= F_MAX_HZ; f += FREQUENCY_GRID_HZ) {
    if (!followsRing(spec, profile, tierSpeedMmS, cornerSpeedMmS, f)) return top
    top = f
  }
  return top
}

/** Whether a corner's bead follows a ring at every grid frequency from F_MIN_HZ up to `topHz`. */
function followsBandUpTo(
  spec: RingPathInputs,
  profile: PrinterProfile,
  tierSpeedMmS: number,
  cornerSpeedMmS: number,
  topHz: number,
): boolean {
  for (let f = F_MIN_HZ; f <= topHz; f += FREQUENCY_GRID_HZ) {
    if (!followsRing(spec, profile, tierSpeedMmS, cornerSpeedMmS, f)) return false
  }
  return true
}

/**
 * The top of the band the coupon is designed for: the highest grid frequency up to which the
 * ladder's bottom rung (MIN_CORNER_SPEED_MM_S) on the slowest tier follows a ring at every grid
 * frequency from F_MIN_HZ (followedBandTopHz). It is F_MAX_HZ on most printers; a low
 * acceleration lowers it, because the along-track speed right after the corner grows with the
 * acceleration while the ring does not. Null when not even the bottom rung follows a ring at
 * F_MIN_HZ: then no ladder reads any frequency of the band.
 */
function designBandTopHz(
  request: RingPathInputs & Pick<IsTestSpec, 'speedsMmS'>,
  profile: PrinterProfile,
): number | null {
  return followedBandTopHz(request, profile, Math.min(...request.speedsMmS), MIN_CORNER_SPEED_MM_S)
}

/**
 * The fastest corner the ladder may print: Klipper's centripetal junction limit over the
 * shortest run-up move at the test acceleration (klipperCentripetalCornerCapMmS), or the slowest
 * tier's own speed when that is slower, because a run-up cruising faster than the line it feeds
 * would brake into the corner instead of passing it.
 */
function cornerCeilingMmS(request: IsTestRequest): number {
  const firmwareCap = klipperCentripetalCornerCapMmS(shortestRunUpMoveMm(request), request.accelMmS2)
  return Math.min(firmwareCap, Math.min(...request.speedsMmS))
}

/**
 * The fastest corner speed on a FOLLOWABLE_CORNER_STEP_MM_S grid from MIN_CORNER_SPEED_MM_S up to
 * `ceilingMmS` that satisfies `holds`, found by bisection; `holds` must be monotone (true up to
 * some corner speed, false above it). Returns the ceiling when even it holds; MIN_CORNER_SPEED_MM_S
 * itself must hold.
 */
function fastestCornerOnGrid(ceilingMmS: number, holds: (cornerMmS: number) => boolean): number {
  const step = FOLLOWABLE_CORNER_STEP_MM_S
  if (holds(ceilingMmS)) return ceilingMmS
  // Bisection on the grid index; invariant: lo * step holds, hi * step does not.
  let lo = Math.round(MIN_CORNER_SPEED_MM_S / step)
  let hi = Math.ceil(ceilingMmS / step)
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (holds(mid * step)) lo = mid
    else hi = mid
  }
  return Number((lo * step).toFixed(1))
}

/**
 * The fastest corner speed, on a FOLLOWABLE_CORNER_STEP_MM_S grid, whose bead follows a ring at
 * every grid frequency up to the design band top (designBandTopHz) on the slowest tier, found by
 * bisection between MIN_CORNER_SPEED_MM_S and the corner ceiling (cornerCeilingMmS): at every
 * sample a faster corner rings with a larger amplitude and leaves a smaller along-track gain over
 * its own speed, so its path curves more sharply at every frequency. The slowest tier binds: its
 * along-track speed is the lowest, so every faster tier follows the same corners. The bottom rung
 * follows up to the design band top by its definition. Returns the ceiling when even it follows,
 * and one step below MIN_CORNER_SPEED_MM_S when there is no design band top.
 */
export function fastestFollowableCornerMmS(
  request: IsTestRequest,
  profile: PrinterProfile,
): number {
  const topHz = designBandTopHz(request, profile)
  if (topHz === null) return MIN_CORNER_SPEED_MM_S - FOLLOWABLE_CORNER_STEP_MM_S
  const slowest = Math.min(...request.speedsMmS)
  return fastestCornerOnGrid(cornerCeilingMmS(request), (c) =>
    followsBandUpTo(request, profile, slowest, c, topHz),
  )
}

/**
 * The top of the ladder: the fastest corner speed, on a FOLLOWABLE_CORNER_STEP_MM_S grid up to the
 * corner ceiling (cornerCeilingMmS), whose bead on the slowest tier still follows a ring at one
 * grid frequency of the band at least, at the design damping ratio. A faster corner folds the
 * bead at every band frequency, so its line reads on no printer, whatever the resonance: this is
 * the natural end of the excitation ladder, and no chosen speed is needed. The criterion is
 * monotone in the corner speed, because at every frequency a faster corner curves the path more
 * sharply (see fastestFollowableCornerMmS), so the corners that follow somewhere in the band are
 * exactly those below one speed; bisection finds it. The slowest tier binds, as for the followable
 * corner. Returns MIN_CORNER_SPEED_MM_S when not even the bottom rung follows anywhere in the band;
 * such a coupon reads nothing and fitSpecToPrinter refuses it.
 *
 * No motor stall bound is applied, because none follows from the printer profile: at the corner
 * the field of a motor jumps while its rotor and the reflected load keep their velocity. The
 * motor stays in step while the kinetic energy of that velocity step, 0.5 * J_eff * (dv_m / r)^2,
 * stays below the work 2 * T_h / N_r the holding torque does across the stable half of the
 * sinusoidal torque-angle curve (the equal-area criterion, Kundur 1994 section 13.1.2, applied to
 * the torque-angle curve of Acarnley 2002 chapters 2 to 5). The holding torque T_h, the rotor
 * tooth count N_r, the rotor inertia, the pulley radius r and the moving mass are not in the
 * printer profile. Qualitatively the risk grows with dv_m^2: on CoreXY one motor reverses by twice
 * the corner speed, which quadruples its rotor energy at the same corner speed. The lines print
 * in ascending corner speed, so the fastest corners come last in every layer
 * (IsCouponGeometry.printOrder).
 */
export function fastestReadableCornerMmS(request: IsTestRequest, profile: PrinterProfile): number {
  const slowest = Math.min(...request.speedsMmS)
  const reads = (c: number) => followsSomewhereInBand(request, profile, slowest, c)
  if (!reads(MIN_CORNER_SPEED_MM_S)) return MIN_CORNER_SPEED_MM_S
  return fastestCornerOnGrid(cornerCeilingMmS(request), reads)
}

/**
 * How many rungs of the slowest tier's ladder leave a bead that follows a ring at every grid
 * frequency from F_MIN_HZ up to `topHz` (the band top F_MAX_HZ unless stated) over the whole read
 * window (see followsBandUpTo). The slowest tier binds: its along-track speed is the lowest.
 */
export function followableRungCount(
  spec: IsTestSpec,
  profile: PrinterProfile,
  topHz: number = F_MAX_HZ,
): number {
  const slowest = Math.min(...spec.speedsMmS)
  return ladderCornerSpeeds(spec, slowest).filter((c) =>
    followsBandUpTo(spec, profile, slowest, c, topHz),
  ).length
}

/**
 * The fewest lines per speed (at least MIN_LINES_PER_SPEED) whose ladder keeps at least
 * MIN_ACCEPTED_LINES rungs on the slowest tier that follow up to the design band top
 * (designBandTopHz), so the analysis can reach its line floor across the band the coupon is
 * designed for; MIN_LINES_PER_SPEED when there is no design band top. The bed fit never removes
 * lines below it. With a bottom-dense ladder this is MIN_ACCEPTED_LINES: the followable rungs
 * alone.
 */
function followableLineFloor(request: LadderRequest, profile: PrinterProfile): number {
  const topHz = designBandTopHz(request, profile)
  if (topHz === null) return MIN_LINES_PER_SPEED
  for (let n = MIN_LINES_PER_SPEED; n <= MAX_LINES_PER_SPEED; n++) {
    const spec = { ...request, linesPerSpeed: n }
    if (followableRungCount(spec, profile, topHz) >= MIN_ACCEPTED_LINES) return n
  }
  return MIN_LINES_PER_SPEED
}

/** Whether a corner's bead follows a ring at one grid frequency of the band at least. */
function followsSomewhereInBand(
  spec: RingPathInputs,
  profile: PrinterProfile,
  tierSpeedMmS: number,
  cornerSpeedMmS: number,
): boolean {
  for (let f = F_MIN_HZ; f <= F_MAX_HZ; f += FREQUENCY_GRID_HZ) {
    if (followsRing(spec, profile, tierSpeedMmS, cornerSpeedMmS, f)) return true
  }
  return false
}

/**
 * The derived lines per speed. When the fastest followable corner splits the slowest tier's
 * ladder (it lies at or above the bottom rung and below the ladder top), the ladder takes
 * MIN_ACCEPTED_LINES rungs at or below it, so the design band (up to designBandTopHz) stays
 * readable at the analysis' line floor, and one upper rung at the ladder top
 * (fastestReadableCornerMmS): the hardest excitation whose bead still follows a ring somewhere in
 * the band, for a stiff frame whose ring the slower rungs leave small. With the default profile
 * that gives 4 lines. Otherwise every rung follows up to the design band top (or none does), and
 * the followable line floor is the count.
 */
export function ladderLinesPerSpeed(request: LadderRequest, profile: PrinterProfile): number {
  const slowest = Math.min(...request.speedsMmS)
  const c = request.followableCornerMmS
  if (c < MIN_CORNER_SPEED_MM_S || c >= tierLadderTopMmS(request, slowest)) {
    return followableLineFloor(request, profile)
  }
  return MIN_ACCEPTED_LINES + 1
}

/**
 * The highest grid frequency up to which at least MIN_ACCEPTED_LINES rungs of the slowest tier
 * follow a ring at every grid frequency from F_MIN_HZ (see followedBandTopHz): the
 * MIN_ACCEPTED_LINES-th highest of the rungs' own followed band tops. The derived ladder reaches
 * its design band top (designBandTopHz): F_MAX_HZ on most printers, lower at a low acceleration.
 * Null when fewer than MIN_ACCEPTED_LINES rungs follow a ring even at F_MIN_HZ, so the coupon reads
 * no frequency of the band.
 */
export function guaranteedBandTopHz(spec: IsTestSpec, profile: PrinterProfile): number | null {
  const slowest = Math.min(...spec.speedsMmS)
  const tops = ladderCornerSpeeds(spec, slowest)
    .map((c) => followedBandTopHz(spec, profile, slowest, c))
    .filter((top): top is number => top !== null)
    .sort((x, y) => y - x)
  return tops.length < MIN_ACCEPTED_LINES ? null : tops[MIN_ACCEPTED_LINES - 1]
}

/**
 * Whether the line speed, not the acceleration, keeps a coupon from reading: the slowest tier's
 * ramp from the ladder's bottom rung ends before the first traced sample (TRACE_START_MM), so the
 * along-track speed over the whole read window is already the tier speed. A higher acceleration
 * then cannot raise the along-track speed; it only shortens the time the ring has to decay before
 * the read starts. Only a faster line speed straightens the bead's path.
 */
function lineSpeedBindsReading(spec: Pick<IsTestSpec, 'speedsMmS' | 'accelMmS2'>): boolean {
  return tierRampMm(spec, Math.min(...spec.speedsMmS), MIN_CORNER_SPEED_MM_S) <= TRACE_START_MM
}

/**
 * The text a coupon whose lines follow ringing at no band frequency (guaranteedBandTopHz null) is
 * refused with: fitSpecToPrinter throws it, so no G-code is offered. It names the line speed when
 * a higher acceleration cannot help (lineSpeedBindsReading), and the acceleration otherwise.
 */
function readsNothingMessage(spec: Pick<IsTestSpec, 'speedsMmS' | 'accelMmS2'>): string {
  const band = `any frequency from ${F_MIN_HZ} to ${F_MAX_HZ} Hz`
  if (lineSpeedBindsReading(spec)) {
    return (
      'Raise the line speed before printing this coupon. ' +
      `At a line speed of ${Math.max(...spec.speedsMmS)} mm/s, the lines cannot follow ringing ` +
      `at ${band}, and a higher print acceleration cannot change that.`
    )
  }
  return (
    'Raise the print acceleration before printing this coupon. ' +
    `At ${spec.accelMmS2} mm/s^2, the lines cannot follow ringing at ${band}.`
  )
}

/**
 * The warning shown when the coupon cannot keep MIN_ACCEPTED_LINES followable lines over the
 * whole band (guaranteedBandTopHz below F_MAX_HZ), or null. A coupon that reads nothing is
 * refused by fitSpecToPrinter instead; for such a spec this returns the refusal's text. The
 * bed fit never removes the followable rungs (followableLineFloor), and a faster line speed does
 * not help either: the binding stretch is the acceleration ramp right after the corner, whose
 * along-track speed depends on the corner speed and the acceleration only. The cause the user can
 * change is the acceleration.
 */
export function bandTopWarning(spec: IsTestSpec, profile: PrinterProfile): string | null {
  const topHz = guaranteedBandTopHz(spec, profile)
  if (topHz === null) return readsNothingMessage(spec)
  if (topHz >= F_MAX_HZ) return null
  return (
    `Raise the print acceleration to measure resonances up to ${F_MAX_HZ} Hz. ` +
    `At ${spec.accelMmS2} mm/s^2, the lines follow ringing only up to ${topHz} Hz.`
  )
}

/**
 * Fits the request to the selected printer: first resolves the speed tiers against the
 * ladder's bottom rung, then fits what the firmware can execute, then resolves the followable
 * corner and the lines per speed and fits the bed. This is the single place a spec is fitted and the only place a tier
 * is dropped; the generator and the analysis both read its result, so the coupon is analyzed
 * exactly as it was printed. Every change is described in a user-worded note; a request the
 * printer cannot host throws, and so does a coupon whose lines follow ringing at no frequency of
 * the band (guaranteedBandTopHz null). That limit is the bead followability of the printer's own
 * nozzle, acceleration and speeds, not a fixed acceleration.
 */
export function fitSpecToPrinter(
  request: IsTestRequest,
  profile: PrinterProfile,
): { spec: IsTestSpec; notes: string[] } {
  const tiers = fitTiersToLadder(request)
  checkFirmwareCorner(tiers.request)
  const bed = fitSpecToBed(tiers.request, profile)
  if (guaranteedBandTopHz(bed.spec, profile) === null) {
    throw new Error(readsNothingMessage(bed.spec))
  }
  return { spec: bed.spec, notes: [...tiers.notes, ...bed.notes] }
}

const ONE_TIER_CONSEQUENCE =
  'With one speed tier, the analysis cannot tell print and scan patterns apart from ringing.'

/**
 * The request with its slower tier removed, keeping the line speed, and the user-worded note
 * saying why. Both automatic tier drops (the ladder floor and the bed fit) go through here.
 */
function withoutSlowerTier<R extends Pick<IsTestSpec, 'speedsMmS'>>(
  request: R,
  reason: string,
): { request: R; note: string } {
  const dropped = Math.min(...request.speedsMmS)
  return {
    request: { ...request, speedsMmS: [Math.max(...request.speedsMmS)] },
    note: `The ${dropped} mm/s speed tier was removed ${reason} ${ONE_TIER_CONSEQUENCE}`,
  }
}

/**
 * Drops the slower tier when it falls below MIN_CORNER_SPEED_MM_S, the bottom rung of every
 * tier's corner-speed ladder: such a tier cannot host its ladder. With the derived tiers of
 * speedTiersFor this happens below MIN_TWO_TIER_LINE_SPEED_MM_S. The line speed itself never
 * falls below the rung, because validateIsSpec holds it to at least MIN_CORNER_SPEED_MM_S.
 */
function fitTiersToLadder(request: IsTestRequest): { request: IsTestRequest; notes: string[] } {
  if (request.speedsMmS.length < 2 || Math.min(...request.speedsMmS) >= MIN_CORNER_SPEED_MM_S) {
    return { request, notes: [] }
  }
  const oneTier = withoutSlowerTier(
    request,
    `because it is slower than the ${MIN_CORNER_SPEED_MM_S} mm/s lowest corner speed.`,
  )
  return {
    request: oneTier.request,
    notes: [
      `${oneTier.note} Raise the line speed to at least ${MIN_TWO_TIER_LINE_SPEED_MM_S} mm/s to keep both speed tiers.`,
    ],
  }
}

/**
 * Throws when the firmware cannot take even the ladder's bottom rung at the test acceleration:
 * Klipper's centripetal junction limit over the shortest run-up move (see
 * klipperCentripetalCornerCapMmS). Below that the ladder top is bounded by the same limit
 * (cornerCeilingMmS), so the ladder, the ramps, the packing, the emitted limits, and the analysis
 * time base all agree with the corners the printer actually takes.
 */
function checkFirmwareCorner(request: IsTestRequest): void {
  const legMm = shortestRunUpMoveMm(request)
  const cap = klipperCentripetalCornerCapMmS(legMm, request.accelMmS2)
  if (cap < MIN_CORNER_SPEED_MM_S) {
    throw new Error(
      'Raise the print acceleration in the printer profile. At ' +
        `${request.accelMmS2} mm/s^2, Klipper's centripetal junction limit caps a corner after ` +
        `the ${legMm} mm run-up at ${cap} mm/s, below the ${MIN_CORNER_SPEED_MM_S} mm/s ` +
        'minimum.',
    )
  }
}

const BED_FIT_REASON = 'so the coupon fits the configured bed.'

/**
 * Resolves the ladder corners and the derived lines per speed, then shrinks the request
 * until the coupon fits the configured bed, in this order: the measured lines are shortened
 * toward the minimum length, then the lines per speed are reduced toward the followable line
 * floor (taking the longest read length that fits at each count), then the derived slower tier
 * is dropped and the same two reductions run on the single tier. Removing a line removes an
 * upper rung of the bottom-dense ladder, and the floor keeps MIN_ACCEPTED_LINES followable
 * rungs, so the bed fit never lowers the band top the coupon can read. The ladder corners are
 * found at the requested read length; a shorter read only shortens the window they are judged
 * over, so their rungs stay followable. Throws when the bed cannot host even the smallest
 * coupon. Every reduction is described in a user-worded note; a derived line count that
 * changes with the tiers is no reduction and gets none.
 */
function fitSpecToBed(
  request: IsTestRequest,
  profile: PrinterProfile,
): { spec: IsTestSpec; notes: string[] } {
  const attempt = (speedsMmS: number[]): { spec: IsTestSpec; notes: string[] } | null => {
    const tiers = { ...request, speedsMmS }
    const base: LadderRequest = {
      ...tiers,
      followableCornerMmS: fastestFollowableCornerMmS(tiers, profile),
      topCornerMmS: fastestReadableCornerMmS(tiers, profile),
    }
    const derivedLines = ladderLinesPerSpeed(base, profile)
    const floorLines = followableLineFloor(base, profile)
    for (let n = derivedLines; n >= floorLines; n--) {
      const candidate: IsTestSpec = { ...base, linesPerSpeed: n }
      const read = longestFittingReadMm(candidate, profile)
      if (read === null) continue
      const notes: string[] = []
      if (n < derivedLines) {
        notes.push(`The lines per speed tier were reduced from ${derivedLines} to ${n} ${BED_FIT_REASON}`)
      }
      if (read < request.measuredLineMm) {
        notes.push(
          `The measured lines were shortened from ${request.measuredLineMm} mm to ${read} mm ` +
            BED_FIT_REASON,
        )
      }
      return { spec: { ...candidate, measuredLineMm: read }, notes }
    }
    return null
  }

  const full = attempt(request.speedsMmS)
  if (full) return full
  if (request.speedsMmS.length > 1) {
    const oneTier = withoutSlowerTier(request, BED_FIT_REASON)
    const single = attempt(oneTier.request.speedsMmS)
    if (single) return { spec: single.spec, notes: [oneTier.note, ...single.notes] }
  }
  throw new Error('The coupon does not fit the configured bed even at the shortest line length')
}

/**
 * The longest clean read length, at most the spec's own and at least MIN_MEASURED_LINE_MM,
 * at which the coupon fits the bed at its placement, or null when none does. The bed depth is
 * the depth the placement leaves (availableBedDepthMm: a coupon pushed to the front or back
 * edge keeps its edge margin). Inverts the interior formulas of isCouponGeometry for the read
 * length L: along a group's measured direction the interior is margin + maxPackedRampMm + L,
 * plus the crossing terms (margin + field + run-up) when both axes are present. The band width
 * and the packed ramp depend on the tiers and the ladder, not on L, so they are constants
 * here; the longest L each constrained bed dimension allows is solved and the tighter one
 * taken.
 */
function longestFittingReadMm(spec: IsTestSpec, profile: PrinterProfile): number | null {
  const depthMm = availableBedDepthMm(profile, spec.placement)
  const fits = (s: IsTestSpec): boolean => {
    const g = isCouponGeometry(s)
    return g.couponWidthMm <= profile.bedWidthMm && g.couponHeightMm <= depthMm
  }
  if (fits(spec)) return spec.measuredLineMm
  const band = frameBandMm(spec)
  const field = fieldExtentMm(spec)
  const both = spec.axes.length === 2
  const crossTerm = both ? INNER_MARGIN_MM + field + spec.runUpMm : 0
  const fixed = 2 * band + INNER_MARGIN_MM + maxPackedRampMm(spec) + crossTerm
  const limits: number[] = []
  if (spec.axes.includes('y')) limits.push(profile.bedWidthMm - fixed)
  if (spec.axes.includes('x')) limits.push(depthMm - fixed)
  const read = Math.min(spec.measuredLineMm, Math.floor(Math.min(...limits)))
  if (read < MIN_MEASURED_LINE_MM) return null
  return fits({ ...spec, measuredLineMm: read }) ? read : null
}
