import type { FilamentProfile, PrinterProfile } from '../gcode/profileTypes'
import { couponOrigin, EDGE_MARGIN_MM, prepareProfile, setupPreamble } from '../gcode/couponShell'
import {
  BASE_LAYERS,
  basePerimeters,
  type Box,
  type Emitter,
  type ExtrudeFn,
  extrude,
  extrusionMm,
  frameBandInfill,
  HIGH_FLOW_WARNING_THRESHOLD_MM3_S,
  NOMINAL_WIDTH_FACTOR,
  PEDESTAL_LAYERS,
  PEDESTAL_WIDTH_FACTOR,
  PERIMETER_LOOPS,
  RASTER_SPEED_FACTOR,
  rasterBase,
  retract,
  travel,
} from '../gcode/emitter'
import { isCouponGeometry, type IsSegment } from './couponGeometry'
import { dipsForMove, extrudeWithDips, type PrintedBead } from './crossings'
import {
  disableShapingCommands,
  isMotionLimitCommands,
  restoreMotionLimitNote,
  restoreShapingCommands,
} from './firmwareMotion'
import { fitSpecToBed, type IsTestSpec, rampWarnings, validateIsSpec } from './types'

export { EDGE_MARGIN_MM, HIGH_FLOW_WARNING_THRESHOLD_MM3_S }

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
  const { spec: fitted, notes } = fitSpecToBed(spec, profile)

  // The pause G-code is only emitted (and its placeholders only reported) with a contrast base.
  const {
    profile: substituted,
    unknownVariables,
    warnings,
  } = prepareProfile(profile, filament, { includePause: spec.contrastBase })
  warnings.push(...notes)
  warnings.push(...rampWarnings(fitted))

  const nominal = profile.nozzleDiameterMm * NOMINAL_WIDTH_FACTOR
  for (const speed of fitted.speedsMmS) {
    const flow = speed * nominal * profile.layerHeightMm
    if (flow > HIGH_FLOW_WARNING_THRESHOLD_MM3_S) {
      warnings.push(
        `The ${speed} mm/s tier extrudes ${flow.toFixed(1)} mm^3/s; a typical hotend melts ` +
          `about ${HIGH_FLOW_WARNING_THRESHOLD_MM3_S} mm^3/s and thins the lines above that. ` +
          'The ringing wavelength is still readable from slightly thinned lines.',
      )
    }
  }

  return { gcode: emitIsGcode(substituted, filament, fitted), unknownVariables, warnings }
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
): void {
  const len = Math.hypot(x - e.x, y - e.y)
  const eAmt = p.retractMm + extrusionMm(len, lineWidthMm, p.layerHeightMm, f.filamentDiameterMm)
  e.lines.push(
    `G1 X${x.toFixed(3)} Y${y.toFixed(3)} E${eAmt.toFixed(5)} F${Math.round(PRIME_SPEED_MM_S * 60)}`,
  )
  e.x = x
  e.y = y
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
}

function emitIsGcode(profile: PrinterProfile, filament: FilamentProfile, spec: IsTestSpec): string {
  const g = isCouponGeometry(spec)
  const { ox, oy } = couponOrigin(
    profile,
    g.couponWidthMm,
    g.couponHeightMm,
    spec.placement,
    EDGE_MARGIN_MM,
  )

  const nominal = profile.nozzleDiameterMm * NOMINAL_WIDTH_FACTOR
  const holes: Box[] = g.fiducials.map((f) => ({
    x0: ox + f.xMm - g.fiducialSizeMm / 2,
    y0: oy + f.yMm - g.fiducialSizeMm / 2,
    x1: ox + f.xMm + g.fiducialSizeMm / 2,
    y1: oy + f.yMm + g.fiducialSizeMm / 2,
  }))

  const e: Emitter = { lines: [], x: 0, y: 0 }
  const L = e.lines
  L.push(
    ...setupPreamble(
      profile,
      [
        '; ScanNTune input shaper resonance test',
        `; speed tiers ${spec.speedsMmS.join(', ')} mm/s, acceleration ${spec.accelMmS2} mm/s^2`,
      ],
      // The test rings the frame on purpose: the spec's acceleration and corner speed
      // replace the profile's limits for the whole print.
      { motionLines: isMotionLimitCommands(profile, spec.accelMmS2, spec.cornerSpeedMmS) },
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
    const infillInset = PERIMETER_LOOPS * nominal
    const baseRasterHoles = holes.map((h) => ({
      x0: h.x0 - infillInset,
      y0: h.y0 - infillInset,
      x1: h.x1 + infillInset,
      y1: h.y1 + infillInset,
    }))
    for (let layer = 0; layer < BASE_LAYERS; layer++) {
      const z = profile.layerHeightMm * (layer + 1)
      L.push(`G1 Z${z.toFixed(3)} F600`)
      basePerimeters(e, profile, filament, nominal, ox, oy, g.couponWidthMm, g.couponHeightMm,
        holes)
      rasterBase(e, profile, filament, nominal, ox + infillInset, oy + infillInset,
        g.couponWidthMm - 2 * infillInset, g.couponHeightMm - 2 * infillInset,
        layer % 2 === 0, baseRasterHoles)
    }
    // Filament change to the contrasting color.
    retract(e, profile, 1)
    L.push(...profile.pauseGcode.split('\n'))
    // Printers whose PAUSE/M600 macro already retracts may see a small blob at the band
    // start; set retractMm to 0 in the profile if that happens.
    L.push('; if your pause macro already retracts, set retractMm to 0 in the profile')
    retract(e, profile, -1)
  }

  const totalLayers = PEDESTAL_LAYERS + IS_MEASURED_LAYERS
  for (let layer = 0; layer < totalLayers; layer++) {
    const z = profile.layerHeightMm * (layer + 1) + zOffsetMm
    // Retract before the Z push; the travel to the band perimeters runs retracted.
    retract(e, profile, 1)
    L.push(`G1 Z${z.toFixed(3)} F600`)

    // Per-layer order: band perimeters, test lines, band raster. The perimeters come
    // first so the nozzle primes over sacrificial geometry instead of a test line's
    // first millimetres, and so the lines weld their tips into already-standing walls.
    // The raster comes last: it irons the through-band leg stretches (travel arrival,
    // moving prime, start blob), the weld tips, and any residual stop blobs flat, so the
    // scanned face stays flush. Pedestal width below, nominal width on the measured
    // layers.
    const pedestal = layer < PEDESTAL_LAYERS
    const width = pedestal ? PEDESTAL_WIDTH_FACTOR * nominal : nominal
    travel(e, profile, ox + 0.5 * nominal, oy + 0.5 * nominal)
    retract(e, profile, -1)
    // Nothing of this layer exists yet under the perimeters, so they extrude plainly; the
    // window box is the hole that turns the outline loops into a band frame.
    basePerimeters(e, profile, filament, nominal, ox, oy, g.couponWidthMm, g.couponHeightMm,
      [{ x0: ox + g.windowBox.x0, y0: oy + g.windowBox.y0, x1: ox + g.windowBox.x1, y1: oy + g.windowBox.y1 }])
    // The test lines travel retracted and restore pressure with their moving primes.
    retract(e, profile, 1)

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
        // The pedestal layer only needs to stick: its lines are capped to the same speed the
        // band fill uses on that layer, because a single first-layer bead at the fast tiers
        // would be dragged off the bed. On a contrast base the pedestal bonds to plastic
        // instead of the bed, which is easier, but the cap stays as a conservative choice.
        // The measured layers run at the full tier speed.
        const speed = pedestal
          ? Math.min(line.speedMmS, profile.travelSpeedMmS * RASTER_SPEED_FACTOR)
          : line.speedMmS
        const runUpSpeed = Math.min(spec.cornerSpeedMmS, speed)
        travel(e, profile, ox + line.prime.x0, oy + line.prime.y0)
        primeOnTheMove(e, profile, filament, width, ox + line.prime.x1, oy + line.prime.y1)
        // Full-flow run-up straight into the corner at the corner speed: under
        // the per-firmware junction limits this test emits (see isMotionLimitCommands for
        // the Klipper SCV, Marlin classic-jerk plus junction-deviation, and
        // RepRapFirmware jerk reasoning), a 90 degree corner entered at that velocity is
        // taken without deceleration, so the corner dumps no pressure and the bead stays
        // continuous through it.
        extrude(e, profile, filament, width, ox + line.runUp.x1, oy + line.runUp.y1, runUpSpeed)
        // Groups printed earlier this layer leave beads across this line's path; the flow
        // is zeroed over each crossing. The geometry guarantees every crossing (and its
        // flow ramps) lies beyond the protected span, so the read window sees none of it.
        if (line.crossingsMm.length > 0) {
          extrudeWithDips(
            e, profile, filament, width,
            ox + line.measured.x1, oy + line.measured.y1, speed,
            line.crossingsMm.map((at) => ({ atMm: at, occupiedMm: width })),
          )
        } else {
          extrude(e, profile, filament, width, ox + line.measured.x1, oy + line.measured.y1, speed)
        }
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

    // The lines left the nozzle retracted after their wipes, so the raster strips start
    // on retracted hops (startRetracted skips the first strip's own retract) and cross
    // the window without stringing.
    frameBandInfill(e, profile, filament, nominal, ox, oy, g.couponWidthMm, g.couponHeightMm,
      g.frameBandMm, holes, layer % 2 === 0, bandExtrude, true)
  }

  // Hand the printer back: nothing is re-applied numerically. The user's own shaper,
  // pressure advance, and motion limit settings all come back with a firmware restart or
  // saved configuration, so no printer settings need to be stored for the restore.
  L.push(...restoreShapingCommands(profile))
  L.push(...restoreMotionLimitNote(profile))
  retract(e, profile, 1)
  L.push(...profile.endGcode.split('\n'))
  return L.join('\n') + '\n'
}
