import type { FilamentProfile, PrinterProfile } from '../gcode/profileTypes'
import {
  baseLayers,
  couponOrigin,
  couponOverriddenSettings,
  EDGE_MARGIN_MM,
  fiducialHoleBoxes,
  filamentSwapPause,
  finishCoupon,
  firstLayerSpeedCap,
  layerZBracket,
  type OverriddenSetting,
  prepareProfile,
  setupPreamble,
  shellSlicerContext,
} from '../gcode/couponShell'
import {
  BASE_LAYERS,
  basePerimeters,
  beadExtrusionMm,
  type Box,
  type Emitter,
  type ExtrudeFn,
  extrude,
  frameBandInfill,
  HIGH_FLOW_WARNING_THRESHOLD_MM3_S,
  highFlowWarning,
  newEmitter,
  NOMINAL_WIDTH_FACTOR,
  PEDESTAL_LAYERS,
  PEDESTAL_WIDTH_FACTOR,
  retract,
  travel,
} from '../gcode/emitter'
import {
  isCouponGeometry,
  type IsSegment,
  MIN_CORNER_SPEED_MM_S,
  sweepPeakSpeedMmS,
} from './couponGeometry'
import { dipsForMove, extrudeWithDips, type PrintedBead } from './crossings'
import { disableShapingCommands, isMotionLimitCommands } from './firmwareMotion'
import { fitSpecToPrinter, type IsTestSpec, rampWarnings, validateIsSpec } from './types'

export { EDGE_MARGIN_MM, HIGH_FLOW_WARNING_THRESHOLD_MM3_S }

/**
 * Firmware state the test leaves changed: shaping and pressure advance are switched off and
 * the motion limits are raised for the whole print; a firmware restart brings all of it back.
 */
export const IS_OVERRIDDEN_SETTINGS: readonly OverriddenSetting[] = couponOverriddenSettings([
  'inputShaping',
  'pressureAdvance',
])

/**
 * The high-flow warnings of a fitted spec: one per speed tier whose measured lines exceed the
 * flow limit, and one for the resonance sweep, whose fastest chord runs at the vector sum of
 * the corner speed and the peak lateral swing speed (about 18.75 mm/s under the
 * accel_per_hz scaling), so at high corner speeds it can pass the limit even when every tier
 * stays below it. Judged on the measured layers' nominal bead, extrusion multiplier included.
 */
export function isFlowWarnings(
  profile: PrinterProfile,
  filament: FilamentProfile,
  fitted: IsTestSpec,
): string[] {
  const nominal = profile.nozzleDiameterMm * NOMINAL_WIDTH_FACTOR
  const warnings = fitted.speedsMmS.map((speed) =>
    highFlowWarning(profile, filament, nominal, speed, 'line speed'),
  )
  if (fitted.sweep) {
    warnings.push(
      highFlowWarning(profile, filament, nominal, sweepPeakSpeedMmS(fitted), 'corner speed'),
    )
  }
  return warnings.filter((w): w is string => w !== null)
}

export function generateIsGcode(
  profile: PrinterProfile,
  filament: FilamentProfile,
  spec: IsTestSpec,
): string {
  return generateIsGcodeWithReport(profile, filament, spec).gcode
}

export function generateIsGcodeWithReport(
  profile: PrinterProfile,
  filament: FilamentProfile,
  spec: IsTestSpec,
): { gcode: string; unknownVariables: string[]; warnings: string[] } {
  validateIsSpec(spec)
  const { spec: fitted, notes } = fitSpecToPrinter(spec, profile)

  const g = isCouponGeometry(fitted)
  const { ox, oy } = couponOrigin(profile, g.couponWidthMm, g.couponHeightMm, spec.placement, EDGE_MARGIN_MM)
  const nominalWallWidth = profile.nozzleDiameterMm * NOMINAL_WIDTH_FACTOR
  const context = shellSlicerContext(
    profile,
    nominalWallWidth,
    ox,
    oy,
    g.couponWidthMm,
    g.couponHeightMm,
  )

  // The pause G-code is only emitted (and its placeholders only reported) with a contrast base.
  const {
    profile: substituted,
    filament: substitutedFilament,
    unknownVariables,
    warnings,
  } = prepareProfile(profile, filament, context, { includePause: spec.contrastBase })
  warnings.push(...notes)
  warnings.push(...rampWarnings(fitted))
  warnings.push(...isFlowWarnings(profile, filament, fitted))

  return { gcode: emitIsGcode(substituted, substitutedFilament, fitted), unknownVariables, warnings }
}

/** Feedrate of the moving prime at each line start. */
const PRIME_SPEED_MM_S = 30
/** Coast length as a multiple of the nozzle diameter (standard slicer coasting default). */
const COAST_NOZZLE_FACTOR = 1.5
/** Length of the wipe move the retract runs over. */
const WIPE_MM = 2

/**
 * Measured layers above the pedestal, deliberately fewer than the shared default: overhang
 * curl of the unsupported wave crest is cumulative per stacked layer, so one measured layer
 * halves the proud height while a single 0.2 mm bead still defines the silhouette edge.
 */
export const IS_MEASURED_LAYERS = 1

/**
 * Prime on the move: the deretract is spread over the first stretch of the run-up leg at
 * a slow feedrate instead of a stationary un-retract, which piles a blob at the line start.
 */
function primeOnTheMove(
  e: Emitter,
  p: PrinterProfile,
  f: FilamentProfile,
  lineWidthMm: number,
  x: number,
  y: number,
  speedMmS: number,
): void {
  const len = Math.hypot(x - e.x, y - e.y)
  const eAmt = p.retractMm + beadExtrusionMm(p, f, len, lineWidthMm)
  e.lines.push(
    `G1 X${x.toFixed(3)} Y${y.toFixed(3)} E${eAmt.toFixed(5)} F${Math.round(speedMmS * 60)}`,
  )
  e.x = x
  e.y = y
  e.retracted = false
}

/**
 * End a test line inside the frame band: extrude the deceleration tail at the cruise
 * feedrate, coast the last stretch (zero-E move fed by residual pressure), then wipe on
 * retract, running the retract during a short move back along the just-printed tail. All
 * three are standard slicer end-of-line features; the E manipulation only starts past the
 * measured segment.
 */
function finishLine(
  e: Emitter,
  p: PrinterProfile,
  f: FilamentProfile,
  lineWidthMm: number,
  tail: IsSegment,
  ox: number,
  oy: number,
  speedMmS: number,
): void {
  const tailLen = Math.hypot(tail.x1 - tail.x0, tail.y1 - tail.y0)
  const ux = (tail.x1 - tail.x0) / tailLen
  const uy = (tail.y1 - tail.y0) / tailLen
  const endX = ox + tail.x1
  const endY = oy + tail.y1
  const feed = Math.round(speedMmS * 60)

  const coastMm = Math.min(COAST_NOZZLE_FACTOR * p.nozzleDiameterMm, tailLen)
  if (tailLen - coastMm > 1e-6) {
    extrude(e, p, f, lineWidthMm, endX - ux * coastMm, endY - uy * coastMm, speedMmS)
  }
  e.lines.push(`G1 X${endX.toFixed(3)} Y${endY.toFixed(3)} F${feed}`)
  e.x = endX
  e.y = endY

  const wipeMm = Math.min(WIPE_MM, tailLen)
  const wipeX = endX - ux * wipeMm
  const wipeY = endY - uy * wipeMm
  // Wipe feedrate chosen so the E axis runs at the profile's retract speed over the move,
  // capped at the tier speed; at the cap the retract runs slower than the profile's speed.
  const wipeFeed = Math.round(
    Math.min(speedMmS, (wipeMm / p.retractMm) * p.retractSpeedMmS) * 60,
  )
  e.lines.push(
    `G1 X${wipeX.toFixed(3)} Y${wipeY.toFixed(3)} E${(-p.retractMm).toFixed(3)} F${wipeFeed}`,
  )
  e.x = wipeX
  e.y = wipeY
  e.retracted = true
}

function emitIsGcode(profile: PrinterProfile, filament: FilamentProfile, spec: IsTestSpec): string {
  const g = isCouponGeometry(spec, profile.squareCornerVelocityMmS)
  const { ox, oy } = couponOrigin(
    profile,
    g.couponWidthMm,
    g.couponHeightMm,
    spec.placement,
    EDGE_MARGIN_MM,
  )

  const nominal = profile.nozzleDiameterMm * NOMINAL_WIDTH_FACTOR
  const holes: Box[] = fiducialHoleBoxes(g.fiducials, g.fiducialSizeMm, ox, oy)
  const windowBed: Box = {
    x0: ox + g.windowBox.x0,
    y0: oy + g.windowBox.y0,
    x1: ox + g.windowBox.x1,
    y1: oy + g.windowBox.y1,
  }

  // A contrasting base is solid apart from the fiducial holes; the coupon layers above it
  // (or on the bed) also leave the window open.
  const e = newEmitter(holes)
  const L = e.lines
  L.push(
    ...setupPreamble(
      profile,
      filament,
      [
        '; ScanNTune input shaper resonance test',
        `; speed tiers ${spec.speedsMmS.join(', ')} mm/s, acceleration ${spec.accelMmS2} mm/s^2`,
        ...(spec.sweep
          ? [
              `; resonant run-up sweep ${spec.sweepFromHz} to ${spec.sweepToHz} Hz over ` +
                `${spec.sweepCycles} cycles`,
            ]
          : [
              `; corner-speed excitation ladder ${MIN_CORNER_SPEED_MM_S} to ` +
                `${spec.cornerSpeedMmS} mm/s across the ${spec.linesPerSpeed} lines of each tier`,
            ]),
      ],
      // The test rings the frame on purpose: the spec's acceleration and corner speed
      // replace the profile's limits for the whole print, and the velocity ceiling is
      // raised to the fastest commanded move so a low configured maximum can never clamp
      // a tier or a sweep chord (a clamped chord stretches its time slice and shifts the
      // cell off its labeled frequency).
      {
        motionLines: isMotionLimitCommands(
          profile,
          spec.accelMmS2,
          spec.cornerSpeedMmS,
          Math.max(...spec.speedsMmS, sweepPeakSpeedMmS(spec), profile.travelSpeedMmS),
        ),
      },
    ),
  )
  // Input shaping and pressure advance both mask ringing; switch them off before any
  // extrusion so the measured corners carry the raw machine response.
  L.push(...disableShapingCommands(profile))

  // Contrasting-color base: solid layers over the full coupon rectangle, band and window
  // alike (only the fiducial holes stay open), then a filament change pause. The base
  // becomes the scan background behind the test lines, so the silhouette read gains
  // contrast: the gaps between lines show the base color instead of whatever backing sits
  // behind the part. Every coupon layer above shifts up by the base thickness; the scan
  // face (the top) is unchanged.
  const zOffsetMm = spec.contrastBase ? BASE_LAYERS * profile.layerHeightMm : 0
  if (spec.contrastBase) {
    baseLayers(e, profile, filament, nominal, ox, oy, g.couponWidthMm, g.couponHeightMm, holes)
    filamentSwapPause(e, profile)
  }

  e.openAreas = [...holes, windowBed]
  const totalLayers = PEDESTAL_LAYERS + IS_MEASURED_LAYERS
  for (let layer = 0; layer < totalLayers; layer++) {
    const z = profile.layerHeightMm * (layer + 1) + zOffsetMm
    // Retract before the Z push; the travel to the band perimeters runs retracted.
    layerZBracket(e, profile, z, ox + 0.5 * nominal, oy + 0.5 * nominal)

    // Per-layer order: band perimeters, test lines, band raster. The perimeters come
    // first so the nozzle primes over sacrificial geometry instead of a test line's
    // first millimetres, and so the lines weld their tips into already-standing walls.
    // The raster comes last: it irons the through-band leg stretches (travel arrival,
    // moving prime, start blob), the weld tips, and any residual stop blobs flat, so the
    // scanned face stays flush. Pedestal width below, nominal width on the measured
    // layers.
    const pedestal = layer < PEDESTAL_LAYERS
    const width = pedestal ? PEDESTAL_WIDTH_FACTOR * nominal : nominal
    const firstLayerSpeed = firstLayerSpeedCap(profile, spec.contrastBase, layer)
    // Nothing of this layer exists yet under the perimeters, so they extrude plainly; the
    // window box is the hole that turns the outline loops into a band frame.
    basePerimeters(e, profile, filament, nominal, ox, oy, g.couponWidthMm, g.couponHeightMm,
      [windowBed], extrude, firstLayerSpeed)
    // The test lines travel retracted and restore pressure with their moving primes, which
    // the pedestal layer caps at its first layer speed like every other bead on it.
    retract(e, profile, 1)
    const primeSpeed = pedestal
      ? Math.min(PRIME_SPEED_MM_S, profile.firstLayerSpeedMmS)
      : PRIME_SPEED_MM_S

    // Each line is one continuous path from the coupon outer edge through the band, into
    // the window as the run-up, through the sharp corner, and across the window as the
    // measured segment; the corner vertex gets no retract, pause, or E change, so the
    // bead is continuous and the flow constant through the corner. The run-up cruises at
    // the corner speed, so the corner is taken with zero deceleration and the excitation
    // is the per-axis velocity step at the bend (see cornerSpeedMmS on IsTestSpec); the
    // measured segment is commanded at the tier speed.
    // The single beads over the open window are bridges; standard bridge practice is
    // maximum part cooling, fixed and identical across tiers so cooling never varies
    // between test lines. The pedestal layer prints with the fan off, per standard
    // first-layer practice: on the bed it IS the first layer, and on a contrast base it
    // still bonds best without cooling.
    if (!pedestal) L.push('M106 S255')
    for (const group of g.groups) {
      for (const line of group.lines) {
        // The pedestal layer only needs to stick: its lines are capped to the profile's
        // first layer speed, because a single first-layer bead at the fast tiers would be
        // dragged off the bed. On a contrast base the pedestal bonds to plastic instead
        // of the bed, which is easier, but the cap stays as a conservative choice. The
        // measured layers run at the full tier speed.
        const speed = pedestal
          ? Math.min(line.speedMmS, profile.firstLayerSpeedMmS)
          : line.speedMmS
        // Each line cruises its run-up at its own rung of the corner-speed ladder; the
        // emitted corner limit equals the TOP rung, an upper bound, so every slower rung
        // passes the corner unbraked on all firmwares.
        const runUpSpeed = Math.min(line.cornerSpeedMmS, speed)
        // The sweep chords carry their own commanded speeds; the pedestal layer scales
        // them uniformly in time (same path, slower everywhere) so even the fastest
        // chord, the peak of the deepest swing, stays at or below the first layer
        // speed cap. The pedestal only needs to stick and is not measured.
        const pedestalScale =
          pedestal && spec.sweep
            ? Math.min(1, profile.firstLayerSpeedMmS / sweepPeakSpeedMmS(spec))
            : 1
        travel(e, profile, ox + line.prime.x0, oy + line.prime.y0)
        primeOnTheMove(e, profile, filament, width, ox + line.prime.x1, oy + line.prime.y1,
          primeSpeed)
        // Full-flow run-up straight into the corner at the corner speed: under
        // the per-firmware junction limits this test emits (see isMotionLimitCommands for
        // the Klipper SCV, Marlin classic-jerk plus junction-deviation, and
        // RepRapFirmware jerk reasoning), a 90 degree corner entered at that velocity is
        // taken without deceleration, so the corner dumps no pressure and the bead stays
        // continuous through it.
        extrude(e, profile, filament, width, ox + line.runUp.x1, oy + line.runUp.y1, runUpSpeed)
        // Resonant run-up chords (empty without the sweep): the ramped zigzag of
        // Klipper's resonance tester, constant forward speed with a bang-bang lateral
        // acceleration. Each chord is commanded at its own average speed so every sweep
        // cell lasts exactly one forcing period. Adjacent chords change each axis's velocity
        // by at most the profile's square corner velocity, far below the corner limit this
        // test emits, and no cell's lateral acceleration exceeds the test acceleration, so
        // the planner's junction model gives no reason to brake between chords; that rests
        // on the model and has not been checked on a toolhead trace. One continuous bead
        // throughout, ending on the corner.
        for (const tooth of line.teeth) {
          extrude(e, profile, filament, width, ox + tooth.x1, oy + tooth.y1,
            tooth.speedMmS * pedestalScale)
        }
        // Crossings over beads printed earlier this layer are taken at full flow, the way
        // grid infill crosses itself: the free beads must weld into the stiff grid, and
        // with pressure advance disabled a zero-E stretch drains nozzle pressure and
        // breaks the bead instead. The geometry guarantees every crossing lies beyond the
        // protected span, so the read window never sees the small crossing blob.
        extrude(e, profile, filament, width, ox + line.measured.x1, oy + line.measured.y1, speed)
        finishLine(e, profile, filament, width, line.tail, ox, oy, speed)
      }
    }
    // M107 forces the fan off for the band; any fan state the user's start G-code set
    // is not restored.
    if (!pedestal) L.push('M107')

    // The band raster is printed over the through-band leg stretches of both groups; its
    // flow is zeroed where a pass crosses one of those beads (the leg positions are
    // exactly known).
    const legBeads: PrintedBead[] = g.groups.flatMap((group) =>
      group.lines.map((line) => ({
        x0: ox + line.prime.x0,
        y0: oy + line.prime.y0,
        x1: ox + line.runUp.x1,
        y1: oy + line.runUp.y1,
        widthMm: width,
      })),
    )
    const bandExtrude: ExtrudeFn = (e2, p2, f2, w2, x, y, s) => {
      const dips = dipsForMove(e2.x, e2.y, x, y, legBeads)
      if (dips.length > 0) extrudeWithDips(e2, p2, f2, w2, x, y, s, dips)
      else extrude(e2, p2, f2, w2, x, y, s)
    }

    // The lines left the nozzle retracted after their wipes, so the first raster strip
    // starts on that retracted hop and every strip hop crosses the window without stringing.
    frameBandInfill(e, profile, filament, nominal, ox, oy, g.couponWidthMm, g.couponHeightMm,
      g.frameBandMm, holes, layer % 2 === 0, bandExtrude, firstLayerSpeed)
  }

  // Hand the printer back: nothing is re-applied numerically. The user's own shaper,
  // pressure advance, and motion limit settings all come back with a firmware restart or
  // saved configuration, so no printer settings need to be stored for the restore.
  finishCoupon(e, profile, filament, IS_OVERRIDDEN_SETTINGS)
  return L.join('\n') + '\n'
}
