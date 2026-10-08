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
  MIN_CORNER_SPEED_MM_S,
  MIN_MEASURED_LINE_MM,
  protectedSpanMm,
  shortestRunUpMoveMm,
  timeAtDistance,
  TRACE_START_MM,
} from './couponGeometry'
import { klipperCentripetalCornerCapMmS } from './firmwareMotion'

export { accelRampMm, MIN_CORNER_SPEED_MM_S, MIN_MEASURED_LINE_MM }

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
   * TOP rung of the corner-speed excitation ladder, and the size of the strongest
   * ringing excitation. Each tier's lines take their corner at geometrically spaced
   * run-up speeds from MIN_CORNER_SPEED_MM_S up to this value (or up to the tier's own
   * speed when that is slower), one rung per line (the step-excitation idea of Klipper's
   * ringing tower: the print self-ranges, so some lines ring visibly regardless of frame
   * stiffness). The emitted motion limits set the firmware's corner limit to the line's
   * own rung, so the planner takes every 90 degree corner at that line's full run-up speed
   * with zero deceleration: the pressure dump K * (v_in - v_corner) is zero by construction
   * and the bead stays continuous. The excitation is the per-axis velocity step at the
   * corner; the residual ring amplitude is approximately delta-v over omega, so faster
   * rungs ring the frame proportionally harder. The printer fit (fitSpecToPrinter) lowers
   * it to the fastest corner the firmware's corner limit can express at the test
   * acceleration.
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

/**
 * What the page asks for: a spec without its line count. The lines per speed are always
 * derived by fitSpecToPrinter (ladderLinesPerSpeed) after the firmware fit, so the generator
 * and the analysis both read one fitted IsTestSpec.
 */
export type IsTestRequest = Omit<IsTestSpec, 'linesPerSpeed'>

/** Frequency search range of the ringing fit: the flow's measurable resonance band. */
export const F_MIN_HZ = 20
export const F_MAX_HZ = 150

/** The flow's false-alarm level for every detection decision (0.1%). */
export const DETECTION_ALPHA = 0.001
/**
 * Confidence gate: the pooled 95% confidence halfwidth must stay under 10% of the
 * frequency. The EI shaper family suppresses vibration below its 5% tolerance only within
 * roughly +/-10-15% of its target frequency, so a wider interval cannot guarantee the true
 * resonance lies inside the configured shaper's stopband.
 */
export const MAX_CI95_REL = 0.1
/**
 * Minimum lines entering the joint fit before the axis estimate is meaningful, and the floor of
 * followable rungs the coupon design keeps. It is not the minimum for an accepted axis: the
 * input-proportionality gate must reach the design power against a forced tone each line
 * detects on its own (inputProportionality.ts), which depends on the lines' corner speeds and
 * tiers and is judged per axis. On the default ladder (two tiers of rungs 20 to 100 mm/s) that
 * takes 9 of the 10 lines; a one-tier ladder of 20 to 100 mm/s needs 9 rungs.
 */
export const MIN_ACCEPTED_LINES = 3
/** Power the two-tier speed check is designed for at the weakest accepted measurement, and the
 *  design power of the input-proportionality gate. */
export const SPEED_CHECK_POWER = 0.95

/**
 * Ratio between the two speed tiers. A real resonance keeps its frequency when the line
 * speed changes, so d = ln(f_slow / f_fast) is 0; a pattern fixed in the print or the scan
 * (belt teeth, scanner artifacts) is fixed in arc length, so its frequency scales with the
 * speed and d = -ln(rho). The speed check rejects the pattern hypothesis one-sided at
 * DETECTION_ALPHA. At the weakest measurement the confidence gate accepts (95% halfwidth
 * MAX_CI95_REL of the frequency, so a relative standard error of MAX_CI95_REL / z_0.975 per
 * tier), the difference of two independent log frequencies has the standard error
 * s_d = sqrt(2) * MAX_CI95_REL / z_0.975 (delta method). A one-sided z test separates two
 * hypotheses ln(rho) apart at level alpha with power 1 - beta when
 * ln(rho) = (z_(1-alpha) + z_(1-beta)) * s_d, the standard power relation, so
 * rho = exp((z_0.999 + z_0.95) * sqrt(2) * 0.1 / z_0.975) = 1.40728.
 */
export const TIER_SPEED_RATIO = Math.exp(
  ((normalQuantile(1 - DETECTION_ALPHA) + normalQuantile(SPEED_CHECK_POWER)) *
    Math.SQRT2 *
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
 * corner-speed ladder, ceil(MIN_CORNER_SPEED_MM_S * TIER_SPEED_RATIO) = 29 mm/s. Below it
 * fitSpecToPrinter drops the slower tier.
 */
export const MIN_TWO_TIER_LINE_SPEED_MM_S = Math.ceil(MIN_CORNER_SPEED_MM_S * TIER_SPEED_RATIO)

export const MIN_SPEED_TIERS = 1
export const MAX_SPEED_TIERS = 2
export const MIN_LINES_PER_SPEED = 3
/** Extra replicate lines cost little coupon area and raise the chance that at least the
 *  required three lines per axis survive print damage and scan artifacts. */
export const MAX_LINES_PER_SPEED = 15
/**
 * Default corner (run-up) speed, the top rung of the ladder: the fastest corner proven to
 * print clean on a tested 300 mm CoreXY printer, where ladders topping out at 145 to 200 mm/s
 * skipped steps. The field is entered by the user, and the page warns above this value. The
 * corner's velocity step leaves a residual ring amplitude of approximately delta-v over omega:
 * at 100 mm/s about 0.64 mm at 25 Hz down to 0.27 mm at 60 Hz, several scanner pixels at
 * 600 dpi even on stiff frames.
 *
 * Why no safe corner speed is computed: at the corner the field of a motor jumps while its
 * rotor and the reflected load keep their velocity. The motor stays in step while the kinetic
 * energy of that velocity step, 0.5 * J_eff * (dv_m / r)^2, stays below the work 2 * T_h / N_r
 * the holding torque does across the stable half of the sinusoidal torque-angle curve (the
 * equal-area criterion, Kundur 1994 section 13.1.2, applied to the torque-angle curve of
 * Acarnley 2002 chapters 2 to 5). The criterion is sufficient, not exact: it ignores damping,
 * and energy conservation in the field frame keeps it valid with belt compliance. The holding
 * torque T_h, the rotor tooth count N_r, the rotor inertia, the pulley radius r and the moving
 * mass are not in the printer profile, so no bound follows from the profile. Qualitatively the
 * risk grows with dv_m^2: on CoreXY one motor reverses by twice the corner speed, which
 * quadruples its rotor energy at the same corner speed, while the load term grows only about
 * 1.5 to 2 times; the other motor carries about a third of the reversing motor's reaction
 * through the mass coupling (m_x - m_y) / 4; 0.9 degree motors have half the well depth; and
 * the acceleration ramp after the corner tilts the well by about 5%.
 */
export const DEFAULT_CORNER_SPEED_MM_S = 100
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
    // Hosts the ramp to the 100 mm/s default corner speed (about 1.7 mm at 3000 mm/s^2)
    // with cruise to spare; the through-band leg stretch is extra.
    runUpMm: 8,
    // The pitch must exceed twice the expected residual ring amplitude plus the bead
    // width; the worst case is about 0.64 mm of amplitude at the default corner speed
    // (see DEFAULT_CORNER_SPEED_MM_S), so 2.5 mm keeps neighbouring traces apart.
    linePitchMm: 2.5,
    axes: ['x', 'y'],
    // The test runs at the profile's own print acceleration: the ringing excitation is the
    // velocity step at the corner, which the acceleration does not set.
    accelMmS2: profile.printAccelMmS2,
    cornerSpeedMmS: DEFAULT_CORNER_SPEED_MM_S,
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
  if (spec.cornerSpeedMmS < MIN_CORNER_SPEED_MM_S) {
    throw new Error(
      `The corner speed must be at least ${MIN_CORNER_SPEED_MM_S} mm/s; below that the ` +
        'corner excitation is too weak to leave a readable trace.',
    )
  }
  // With the corner speed floor above, this also holds the line speed to at least
  // MIN_CORNER_SPEED_MM_S. A slower tier below that floor is not an error: fitSpecToPrinter
  // drops it (fitTiersToLadder).
  if (Math.max(...spec.speedsMmS) < spec.cornerSpeedMmS) {
    throw new Error(
      `The line speed must be at least the ${spec.cornerSpeedMmS} mm/s corner speed. A ` +
        'slower line caps the corner below the corner speed and weakens the excitation.',
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
 * Damping ratio the bead followability is evaluated at: Klipper's DEFAULT_DAMPING_RATIO
 * (shaper_defs.py, 0.1), the damping Klipper designs input shapers for when none is
 * measured. The coupon is generated before the damping is known, so it is designed for the
 * same assumed value.
 */
export const FOLLOWABILITY_DAMPING_RATIO = 0.1
/** Sampling step of the followability evaluation along the read window. */
const FOLLOWABILITY_STEP_MM = 0.1

/**
 * The smallest radius of curvature of a ring path over a line's read window, from the first
 * traced sample (TRACE_START_MM past the corner) to the end of its protected span, for a
 * resonance at F_MAX_HZ. The corner's velocity step c leaves a lateral ring of amplitude
 * A(t) = (c / omega) e^(-zeta omega t); written over the along-track speed u, the path
 * y = A sin(omega t) has the radius of curvature R = u^2 / (A omega^2) at its crests. The
 * along-track speed follows the commanded profile after the corner, sqrt(c^2 + 2 a s) up to
 * the tier speed, lowered by the along-track axis' own ring by up to c e^(-zeta omega_a t)
 * (the along axis takes the same velocity step c at the corner); omega_a is taken at F_MIN_HZ,
 * the slowest decay the band allows. The radius grows along the window, but it is evaluated
 * at every sample rather than assumed monotonic.
 */
export function ringPathMinRadiusMm(
  spec: IsTestSpec,
  tierSpeedMmS: number,
  cornerSpeedMmS: number,
): number {
  const omega = 2 * Math.PI * F_MAX_HZ
  const omegaAlong = 2 * Math.PI * F_MIN_HZ
  const zeta = FOLLOWABILITY_DAMPING_RATIO
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
 * How many rungs of the slowest tier's ladder leave a bead that can follow a ring at
 * F_MAX_HZ over the whole read window. The bead edges are the offset curves of the path at
 * plus and minus half the bead width, and an offset curve stays regular only while the
 * path's radius of curvature exceeds the offset (Farouki and Neff, "Analytic properties of
 * plane offset curves", CAGD 7, 1990); below that the edge folds into a cusp and the traced
 * centreline no longer follows the nozzle. The slowest tier binds: its along-track speed is
 * the lowest. The bead width is the measured layers' nominal width.
 */
export function followableRungCount(spec: IsTestSpec, profile: PrinterProfile): number {
  const slowest = Math.min(...spec.speedsMmS)
  const halfWidthMm = (profile.nozzleDiameterMm * NOMINAL_WIDTH_FACTOR) / 2
  return ladderCornerSpeeds(spec, slowest).filter(
    (c) => ringPathMinRadiusMm(spec, slowest, c) > halfWidthMm,
  ).length
}

/**
 * The derived lines per speed: the fewest rungs (at least MIN_LINES_PER_SPEED) whose ladder
 * keeps at least MIN_ACCEPTED_LINES followable rungs on the slowest tier, so the analysis can
 * reach its line floor at the top of the band. When even the most lines cannot (the bottom
 * rung already folds), the minimum is used and bandTopWarning explains it.
 */
export function ladderLinesPerSpeed(
  request: Omit<IsTestSpec, 'linesPerSpeed'>,
  profile: PrinterProfile,
): number {
  for (let n = MIN_LINES_PER_SPEED; n <= MAX_LINES_PER_SPEED; n++) {
    if (followableRungCount({ ...request, linesPerSpeed: n }, profile) >= MIN_ACCEPTED_LINES) {
      return n
    }
  }
  return MIN_LINES_PER_SPEED
}

/**
 * The warning shown when fewer than MIN_ACCEPTED_LINES rungs of the slowest tier leave a
 * followable bead at F_MAX_HZ (see followableRungCount), or null.
 */
export function bandTopWarning(spec: IsTestSpec, profile: PrinterProfile): string | null {
  const followable = followableRungCount(spec, profile)
  if (followable >= MIN_ACCEPTED_LINES) return null
  const slowest = Math.min(...spec.speedsMmS)
  return (
    'Raise the line speed or the print acceleration to read a resonance near ' +
    `${F_MAX_HZ} Hz. Only ${followable} of the ${slowest} mm/s lines leave a bead that can ` +
    `follow ringing that fast, and the analysis needs ${MIN_ACCEPTED_LINES}.`
  )
}

/**
 * Fits the request to the selected printer: first resolves the speed tiers against the
 * ladder's bottom rung, then fits what the firmware can execute, then resolves the lines per
 * speed and fits the bed. This is the single place a spec is fitted and the only place a tier
 * is dropped; the generator and the analysis both read its result, so the coupon is analyzed
 * exactly as it was printed. Every change is described in a user-worded note; a request the
 * printer cannot host throws.
 */
export function fitSpecToPrinter(
  request: IsTestRequest,
  profile: PrinterProfile,
): { spec: IsTestSpec; notes: string[] } {
  const tiers = fitTiersToLadder(request)
  const firmware = fitSpecToFirmware(tiers.request)
  const bed = fitSpecToBed(firmware.request, profile)
  return { spec: bed.spec, notes: [...tiers.notes, ...firmware.notes, ...bed.notes] }
}

const ONE_TIER_CONSEQUENCE =
  'With one tier, the analysis cannot tell print and scan patterns apart from ringing.'

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
 * falls below the rung, because validateIsSpec holds it to at least the corner speed.
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
      `${oneTier.note} Raise the line speed to at least ${MIN_TWO_TIER_LINE_SPEED_MM_S} mm/s to keep both tiers.`,
    ],
  }
}

/**
 * Lowers the corner speed to the fastest corner the firmware can take at the test
 * acceleration: Klipper's centripetal junction limit over the shortest run-up move (see
 * klipperCentripetalCornerCapMmS). The lowered value becomes the spec's one corner speed, so
 * the ladder's top rung, the ramps, the packing, the emitted limits, and the analysis time
 * base all agree with the corner the printer actually takes. Throws when the firmware cannot
 * take even the minimum corner speed.
 */
function fitSpecToFirmware(request: IsTestRequest): { request: IsTestRequest; notes: string[] } {
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
  if (request.cornerSpeedMmS <= cap) return { request, notes: [] }
  return {
    request: { ...request, cornerSpeedMmS: cap },
    notes: [
      `The corner speed was limited to ${cap} mm/s because Klipper's centripetal ` +
        `junction limit allows no faster corner after the ${legMm} mm run-up at ` +
        `${request.accelMmS2} mm/s^2.`,
    ],
  }
}

const BED_FIT_REASON = 'so the coupon fits the configured bed.'

/**
 * Shrinks the request until the coupon fits the configured bed, in this order: the measured
 * lines are shortened toward the minimum length, then the lines per speed are reduced toward
 * the minimum (taking the longest read length that fits at each count), then the derived
 * slower tier is dropped and the same two reductions run on the single tier. Throws when the
 * bed cannot host even the smallest coupon. Every reduction is described in a user-worded
 * note; a derived line count that changes with the tiers is no reduction and gets none.
 */
function fitSpecToBed(
  request: IsTestRequest,
  profile: PrinterProfile,
): { spec: IsTestSpec; notes: string[] } {
  const attempt = (speedsMmS: number[]): { spec: IsTestSpec; notes: string[] } | null => {
    const base = { ...request, speedsMmS }
    const derivedLines = ladderLinesPerSpeed(base, profile)
    for (let n = derivedLines; n >= MIN_LINES_PER_SPEED; n--) {
      const candidate: IsTestSpec = { ...base, linesPerSpeed: n }
      const read = longestFittingReadMm(candidate, profile)
      if (read === null) continue
      const notes: string[] = []
      if (n < derivedLines) {
        notes.push(`The lines per speed were reduced from ${derivedLines} to ${n} ${BED_FIT_REASON}`)
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
