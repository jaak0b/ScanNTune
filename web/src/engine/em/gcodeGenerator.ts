import type { FilamentProfile, PrinterProfile } from '../gcode/profileTypes'
import {
  baseLayers,
  couponOrigin,
  EDGE_MARGIN_MM,
  fiducialHoleBoxes,
  filamentSwapPause,
  firstLayerSpeedCap,
  layerZBracket,
  prepareProfile,
  setupPreamble,
  shellSlicerContext,
  teardownLines,
} from '../gcode/couponShell'
import {
  BASE_LAYERS,
  type Emitter,
  extrude,
  flowWarningLimitMm3S,
  frameBandLayer,
  HIGH_FLOW_WARNING_THRESHOLD_MM3_S,
  PERIMETER_LOOPS,
  RASTER_SPEED_FACTOR,
  rasterBase,
  rectLoop,
  retract,
  travel,
  type Box,
} from '../gcode/emitter'
import {
  accelRampMm,
  emCouponGeometry,
  type EmTestSpec,
  MEASURED_LAYERS,
  PEDESTAL_LAYERS,
  PEDESTAL_WIDTH_FACTOR,
  volumetricFlowMm3S,
} from './types'

export { EDGE_MARGIN_MM, HIGH_FLOW_WARNING_THRESHOLD_MM3_S }
/**
 * How far each comb line runs past its row boundary onto the band/rail perimeters.
 * Long enough that the wall crossing sits past the acceleration ramp and the nozzle
 * pressure lag after the preceding travel, so the bead is at full width where it
 * welds onto the perimeter (a starved tip only kisses the bead and snaps off).
 * Opposing rows overrun the 4 mm rail centreline by 0.5 mm each; the tips sit at
 * distinct X positions on top of the solid rail, so they never cross.
 */
export const ANCHOR_OVERLAP_MM = 2.5
export function generateEmGcode(
  profile: PrinterProfile,
  filament: FilamentProfile,
  spec: EmTestSpec,
): string {
  return generateEmGcodeWithReport(profile, filament, spec).gcode
}

export function generateEmGcodeWithReport(
  profile: PrinterProfile,
  filament: FilamentProfile,
  spec: EmTestSpec,
): { gcode: string; unknownVariables: string[]; warnings: string[] } {
  if (spec.blockCount < 3) throw new Error('At least 3 pitch blocks are needed for a fit')
  if (spec.linesPerBlock < 2) throw new Error('Each block needs at least 2 lines')
  if (spec.pitchMaxMm <= spec.pitchMinMm) throw new Error('Max pitch must exceed min pitch')
  if (spec.printSpeedMmS <= 0) throw new Error('Print speed must be positive')
  if (spec.lineLengthMm <= 0) throw new Error('Line length must be positive')
  if (spec.nominalLineWidthMm <= 0) throw new Error('Nominal line width must be positive')

  const g = emCouponGeometry(spec)
  const { ox, oy } = couponOrigin(profile, g.couponWidthMm, g.couponHeightMm, spec.placement, EDGE_MARGIN_MM)
  const context = shellSlicerContext(
    profile,
    spec.nominalLineWidthMm,
    ox,
    oy,
    g.couponWidthMm,
    g.couponHeightMm,
  )

  // The pause gcode is only emitted (and its placeholders only reported) with a contrast base.
  const {
    profile: substituted,
    filament: substitutedFilament,
    unknownVariables,
    warnings,
  } = prepareProfile(profile, filament, context, { includePause: spec.contrastBase })

  const flow = volumetricFlowMm3S(spec, profile.layerHeightMm)
  const flowLimit = flowWarningLimitMm3S(filament)
  if (flow > flowLimit) {
    warnings.push(
      `Volumetric flow is ${flow.toFixed(1)} mm^3/s, above ` +
        (filament.maxVolumetricFlowMm3S > 0
          ? `the filament's configured ${flowLimit} mm^3/s maximum volumetric flow. `
          : `the ${flowLimit} mm^3/s typical hotends under-extrude past. `) +
        'Intended for high-flow hotends only.',
    )
  }
  const ramp = accelRampMm(spec.printSpeedMmS, profile.printAccelMmS2)
  if (2 * ramp > spec.lineLengthMm / 2) {
    warnings.push(
      'At this speed and acceleration the line middles never reach the commanded speed; ' +
        'lower the speed, raise the acceleration, or lengthen the lines.',
    )
  }

  return { gcode: emitEmGcode(substituted, substitutedFilament, spec), unknownVariables, warnings }
}

function emitEmGcode(profile: PrinterProfile, rawFilament: FilamentProfile, spec: EmTestSpec): string {
  // This test measures the extrusion multiplier, so it always prints at exactly 1.0: the
  // measured ratio is then the absolute value to set, with no back-multiplication.
  const filament: FilamentProfile = { ...rawFilament, extrusionMultiplier: 1 }
  const g = emCouponGeometry(spec)
  const { ox, oy } = couponOrigin(
    profile,
    g.couponWidthMm,
    g.couponHeightMm,
    spec.placement,
    EDGE_MARGIN_MM,
  )

  const nominal = spec.nominalLineWidthMm
  const holes: Box[] = fiducialHoleBoxes(g.fiducials, g.fiducialSizeMm, ox, oy)
  const e: Emitter = { lines: [], x: 0, y: 0 }
  const L = e.lines
  L.push(
    ...setupPreamble(profile, filament, [
      '; ScanNTune extrusion multiplier test',
      `; nominal line width ${nominal.toFixed(3)} mm, comb speed ${spec.printSpeedMmS} mm/s`,
    ]),
  )
  // Pin the firmware flow override to 100 percent: the test's baseline is exactly 1.0.
  L.push('M221 S100')

  const totalLayers = PEDESTAL_LAYERS + MEASURED_LAYERS
  const infillInset = PERIMETER_LOOPS * nominal

  // Contrasting-color base: two solid layers over the full coupon rectangle (the window is
  // backed, not open; only the fiducial holes stay open), then a filament-change pause.
  const zOffsetMm = spec.contrastBase ? BASE_LAYERS * profile.layerHeightMm : 0
  if (spec.contrastBase) {
    baseLayers(e, profile, filament, nominal, ox, oy, g.couponWidthMm, g.couponHeightMm, holes)
    filamentSwapPause(e, profile)
  }

  for (let layer = 0; layer < totalLayers; layer++) {
    const z = profile.layerHeightMm * (layer + 1) + zOffsetMm
    // Bracket the layer change: retract before the Z push, travel to the frame corner where
    // the next layer's perimeter starts while still retracted (the move crosses the open
    // window), and only then restore pressure. The first layer needs no bracket.
    layerZBracket(e, profile, z, ox + 0.5 * nominal, oy + 0.5 * nominal, layer > 0)

    const firstLayerSpeed = firstLayerSpeedCap(profile, spec.contrastBase, layer)
    // Frame band: outline + window perimeters, four band raster strips (never crossing the
    // open window), then the fiducial hole perimeters sealing the raster's ragged line-ends.
    frameBandLayer(e, profile, filament, nominal, ox, oy, g.couponWidthMm, g.couponHeightMm,
      g.frameBandMm, holes, layer % 2 === 0, extrude, firstLayerSpeed)

    // Center rail: perimeter loops flush with its edges give the comb line ends a continuous
    // bead to anchor into (a bare raster edge is a sawtooth the thin lines pull out of), with
    // the raster inset behind them like the band. The approach travel crosses the window.
    const railX0 = ox + g.frameBandMm
    const railY0 = oy + g.railY0Mm
    const railW = g.couponWidthMm - 2 * g.frameBandMm
    retract(e, profile, 1)
    travel(e, profile, railX0 + railW - 0.5 * nominal, railY0 + 0.5 * nominal)
    retract(e, profile, -1)
    // The loops wind from the rail's right corner because the raster below starts at the
    // right end; ending the perimeters there keeps the hop between them short and wet.
    for (let k = 0; k < PERIMETER_LOOPS; k++) {
      const ins = (k + 0.5) * nominal
      rectLoop(e, profile, filament, nominal, railX0 + railW - ins, railY0 + ins,
        railX0 + ins, railY0 + g.railWidthMm - ins,
        firstLayerSpeed ?? profile.travelSpeedMmS * RASTER_SPEED_FACTOR)
    }
    // Fixed 45 degrees: on a long thin strip the 135 degree raster starts at the far end,
    // which would mean a long dry travel from the perimeter corner.
    rasterBase(e, profile, filament, nominal, railX0 + infillInset, railY0 + infillInset,
      railW - 2 * infillInset, g.railWidthMm - 2 * infillInset, true, [], extrude,
      firstLayerSpeed)

    // Comb lines: pedestal width below, nominal width on the measured layers. Each line
    // runs ANCHOR_OVERLAP_MM past the row boundary on both ends so its tip prints on top
    // of the band/rail perimeters laid earlier in the same layer: an overlap weld. A line
    // ending exactly at the boundary only kisses the perimeter bead's side and snaps off.
    const combWidth = layer < PEDESTAL_LAYERS ? PEDESTAL_WIDTH_FACTOR * nominal : nominal
    const rows: { blocks: typeof g.topRow; y0: number; y1: number }[] = [
      { blocks: g.topRow, y0: oy + g.topRowY0Mm - ANCHOR_OVERLAP_MM,
        y1: oy + g.topRowY1Mm + ANCHOR_OVERLAP_MM },
      { blocks: g.bottomRow, y0: oy + g.bottomRowY0Mm - ANCHOR_OVERLAP_MM,
        y1: oy + g.bottomRowY1Mm + ANCHOR_OVERLAP_MM },
    ]
    for (const row of rows) {
      for (const block of row.blocks) {
        retract(e, profile, 1)
        travel(e, profile, ox + block.lineXsMm[0], row.y0)
        retract(e, profile, -1)
        for (let j = 0; j < block.lineXsMm.length; j++) {
          const x = ox + block.lineXsMm[j]
          const down = j % 2 === 1
          if (j > 0) travel(e, profile, x, down ? row.y1 : row.y0)
          // Pedestal comb lines on the bed take the first layer cap; the measured layers
          // keep the spec speed, which the bead width depends on.
          extrude(e, profile, filament, combWidth, x, down ? row.y0 : row.y1,
            Math.min(spec.printSpeedMmS, firstLayerSpeed ?? spec.printSpeedMmS))
        }
      }
    }
  }

  retract(e, profile, 1)
  L.push(...teardownLines(profile, filament))
  return L.join('\n') + '\n'
}
