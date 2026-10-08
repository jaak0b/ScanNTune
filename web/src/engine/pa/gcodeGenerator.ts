import type { FilamentProfile, PrinterProfile, PaTestSpec } from './types'
import { couponGeometry, KLIPPER_DEFAULT_SMOOTH_TIME, paFlowWarning, paValueForLine } from './types'
import {
  baseLayers,
  couponOrigin,
  couponOverriddenSettings,
  fiducialHoleBoxes,
  filamentSwapPause,
  finishCoupon,
  type OverriddenSetting,
  prepareProfile,
  setupPreamble,
  shellSlicerContext,
} from '../gcode/couponShell'
import { BASE_LAYERS, extrude, newEmitter, retract, travel } from '../gcode/emitter'

export { extrusionMm } from '../gcode/emitter'

/**
 * Firmware state the test leaves changed: pressure advance (and the smooth time) stays at the
 * last test line's value, and the preamble's motion limits stay in force; a firmware restart
 * brings the configured values back.
 */
export const PA_OVERRIDDEN_SETTINGS: readonly OverriddenSetting[] = couponOverriddenSettings([
  'pressureAdvance',
])

export function paCommand(value: number): string {
  return `SET_PRESSURE_ADVANCE ADVANCE=${value.toFixed(4)}`
}

/** Sets the fixed advance K together with a swept smooth time. */
export function smoothTimeCommand(fixedAdvance: number, smoothTime: number): string {
  return `SET_PRESSURE_ADVANCE ADVANCE=${fixedAdvance.toFixed(4)} SMOOTH_TIME=${smoothTime.toFixed(4)}`
}

/** The per-line parameter command for the spec's sweep kind. */
function sweepCommand(spec: PaTestSpec, value: number): string {
  if (spec.sweep === 'smoothTime') return smoothTimeCommand(spec.fixedAdvance as number, value)
  return paCommand(value)
}

export function generatePaGcode(
  profile: PrinterProfile,
  filament: FilamentProfile,
  spec: PaTestSpec,
): string {
  return generatePaGcodeWithReport(profile, filament, spec).gcode
}

/**
 * Generate the PA test G-code, substituting slicer placeholder variables in the profile's
 * start/pause/end G-code, and report any placeholders that were left verbatim.
 */
export function generatePaGcodeWithReport(
  profile: PrinterProfile,
  filament: FilamentProfile,
  spec: PaTestSpec,
): { gcode: string; unknownVariables: string[]; warnings: string[] } {
  if (spec.fastSpeedMmS <= spec.slowSpeedMmS) {
    throw new Error('Fast speed must exceed slow speed')
  }
  if (spec.sweep === 'smoothTime' && !Number.isFinite(spec.fixedAdvance)) {
    throw new Error('A smooth time sweep needs a fixed pressure advance value (fixedAdvance).')
  }
  const g = couponGeometry(spec)
  const { ox, oy } = couponOrigin(profile, g.baseWidthMm, g.baseHeightMm)
  const context = shellSlicerContext(profile, spec.lineWidthMm, ox, oy, g.baseWidthMm, g.baseHeightMm)
  const {
    profile: substituted,
    filament: substitutedFilament,
    unknownVariables,
    warnings,
  } = prepareProfile(profile, filament, context)
  const flowWarning = paFlowWarning(profile, filament, spec)
  if (flowWarning !== null) warnings.push(flowWarning)
  return { gcode: emitPaGcode(substituted, substitutedFilament, spec), unknownVariables, warnings }
}

function emitPaGcode(profile: PrinterProfile, filament: FilamentProfile, spec: PaTestSpec): string {
  const g = couponGeometry(spec)
  // Center the coupon on the bed.
  const { ox, oy } = couponOrigin(profile, g.baseWidthMm, g.baseHeightMm)
  const holes = fiducialHoleBoxes(g.fiducials, g.fiducialSizeMm, ox, oy)

  // The base is solid apart from the fiducial holes, so they are the only open areas a
  // travel can cross, on the base layers and on the line layer above them alike.
  const e = newEmitter(holes)
  const L = e.lines
  L.push(...setupPreamble(profile, filament, ['; ScanNTune pressure advance test', '; fiducial holes preserved']))

  // Base layers: perimeter loops first, then serpentine infill inset behind them.
  baseLayers(e, profile, filament, spec.lineWidthMm, ox, oy, g.baseWidthMm, g.baseHeightMm, holes)
  filamentSwapPause(e, profile)

  // Prime line along the bottom base edge, outside the measured region.
  const z3 = profile.layerHeightMm * (BASE_LAYERS + 1)
  L.push(`G1 Z${z3.toFixed(3)} F600`)
  L.push(
    spec.sweep === 'smoothTime'
      ? smoothTimeCommand(spec.fixedAdvance as number, KLIPPER_DEFAULT_SMOOTH_TIME)
      : paCommand(0),
  )
  travel(e, profile, ox + 2, oy + 1.5)
  extrude(e, profile, filament, spec.lineWidthMm, ox + g.baseWidthMm - 2, oy + 1.5, spec.slowSpeedMmS)

  // Test lines: slow up to the first transition, fast to the second, slow to the end, over the
  // line extent that keeps every bead clear of the fiducial holes.
  const [startXMm, endXMm] = g.lineExtentXsMm
  const [accelXMm, decelXMm] = g.transitionXsMm
  for (let i = 0; i < spec.lineCount; i++) {
    L.push(sweepCommand(spec, paValueForLine(spec, i)))
    const y = oy + g.lineStartYMm(i)
    const x0 = ox + g.lineStartXMm
    retract(e, profile, 1)
    travel(e, profile, x0 + startXMm, y)
    retract(e, profile, -1)
    extrude(e, profile, filament, spec.lineWidthMm, x0 + accelXMm, y, spec.slowSpeedMmS)
    extrude(e, profile, filament, spec.lineWidthMm, x0 + decelXMm, y, spec.fastSpeedMmS)
    extrude(e, profile, filament, spec.lineWidthMm, x0 + endXMm, y, spec.slowSpeedMmS)
  }

  finishCoupon(e, profile, filament, PA_OVERRIDDEN_SETTINGS)
  return L.join('\n') + '\n'
}
