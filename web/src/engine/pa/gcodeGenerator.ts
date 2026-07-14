import type { FilamentProfile, PrinterProfile, PaTestSpec } from './types'
import { couponGeometry, KLIPPER_DEFAULT_SMOOTH_TIME, paValueForLine } from './types'
import {
  baseLayers,
  couponOrigin,
  fiducialHoleBoxes,
  filamentSwapPause,
  prepareProfile,
  setupPreamble,
  teardownLines,
} from '../gcode/couponShell'
import { BASE_LAYERS, type Emitter, extrude, retract, travel } from '../gcode/emitter'

export { extrusionMm } from '../gcode/emitter'

export function paCommand(firmware: PrinterProfile['firmware'], value: number): string {
  const v = value.toFixed(4)
  if (firmware === 'Marlin') return `M900 K${v}`
  if (firmware === 'RepRapFirmware') return `M572 D0 S${v}`
  return `SET_PRESSURE_ADVANCE ADVANCE=${v}`
}

/** Klipper-only: set the fixed advance K together with a swept smooth time. */
export function smoothTimeCommand(fixedAdvance: number, smoothTime: number): string {
  return `SET_PRESSURE_ADVANCE ADVANCE=${fixedAdvance.toFixed(4)} SMOOTH_TIME=${smoothTime.toFixed(4)}`
}

/** The per-line parameter command for the spec's sweep kind. */
function sweepCommand(profile: PrinterProfile, spec: PaTestSpec, value: number): string {
  if (spec.sweep === 'smoothTime') return smoothTimeCommand(spec.fixedAdvance as number, value)
  return paCommand(profile.firmware, value)
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
  if (spec.sweep === 'smoothTime') {
    if (profile.firmware !== 'Klipper') {
      throw new Error(
        'Smooth time calibration requires Klipper; Marlin and RepRapFirmware have no equivalent setting.',
      )
    }
    if (!Number.isFinite(spec.fixedAdvance)) {
      throw new Error('A smooth time sweep needs a fixed pressure advance value (fixedAdvance).')
    }
  }
  const {
    profile: substituted,
    filament: substitutedFilament,
    unknownVariables,
    warnings,
  } = prepareProfile(profile, filament)
  return { gcode: emitPaGcode(substituted, substitutedFilament, spec), unknownVariables, warnings }
}

function emitPaGcode(profile: PrinterProfile, filament: FilamentProfile, spec: PaTestSpec): string {
  const g = couponGeometry(spec)
  // Center the coupon on the bed.
  const { ox, oy } = couponOrigin(profile, g.baseWidthMm, g.baseHeightMm)
  const holes = fiducialHoleBoxes(g.fiducials, g.fiducialSizeMm, ox, oy)

  const e: Emitter = { lines: [], x: 0, y: 0 }
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
      : paCommand(profile.firmware, 0),
  )
  travel(e, profile, ox + 2, oy + 1.5)
  extrude(e, profile, filament, spec.lineWidthMm, ox + g.baseWidthMm - 2, oy + 1.5, spec.slowSpeedMmS)

  // Test lines.
  for (let i = 0; i < spec.lineCount; i++) {
    L.push(sweepCommand(profile, spec, paValueForLine(spec, i)))
    const y = oy + g.lineStartYMm(i)
    const x0 = ox + g.lineStartXMm
    retract(e, profile, 1)
    travel(e, profile, x0, y)
    retract(e, profile, -1)
    extrude(e, profile, filament, spec.lineWidthMm, x0 + spec.slowSegmentMm, y, spec.slowSpeedMmS)
    extrude(
      e,
      profile,
      filament,
      spec.lineWidthMm,
      x0 + spec.slowSegmentMm + spec.fastSegmentMm,
      y,
      spec.fastSpeedMmS,
    )
    extrude(
      e,
      profile,
      filament,
      spec.lineWidthMm,
      x0 + 2 * spec.slowSegmentMm + spec.fastSegmentMm,
      y,
      spec.slowSpeedMmS,
    )
  }

  retract(e, profile, 1)
  L.push(...teardownLines(profile, filament))
  return L.join('\n') + '\n'
}
