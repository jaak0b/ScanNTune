import type { FilamentProfile, PrinterProfile } from './types'
import { evaluateTemplate } from './orcaTemplate'

// PrusaSlicer and OrcaSlicer placeholder names mapped onto profile fields. Case-sensitive,
// matching the slicers' own variable names. The optional [n] index suffix (multi-extruder
// vectors) is accepted and ignored: the PA coupon is a single-extruder print.
const VARIABLE_MAP: Record<
  string,
  (p: PrinterProfile, f: FilamentProfile) => string | number
> = {
  first_layer_temperature: (_p, f) => f.nozzleTempC,
  temperature: (_p, f) => f.nozzleTempC,
  nozzle_temperature: (_p, f) => f.nozzleTempC,
  first_layer_nozzle_temperature: (_p, f) => f.nozzleTempC,
  first_layer_bed_temperature: (_p, f) => f.bedTempC,
  bed_temperature: (_p, f) => f.bedTempC,
  first_layer_bed_temp: (_p, f) => f.bedTempC,
  chamber_temperature: (_p, f) => f.chamberTempC,
  chamber_temp: (_p, f) => f.chamberTempC,
  filament_type: (_p, f) => f.filamentType,
  filament_diameter: (_p, f) => f.filamentDiameterMm,
  layer_height: (p) => p.layerHeightMm,
  first_layer_height: (p) => p.layerHeightMm,
  nozzle_diameter: (p) => p.nozzleDiameterMm,
  travel_speed: (p) => p.travelSpeedMmS,
  nozzle_temperature_initial_layer: (_p, f) => f.nozzleTempC,
  bed_temperature_initial_layer_single: (_p, f) => f.bedTempC,
  first_layer_print_min: () => 0,
  first_layer_print_max: (p) => Math.min(p.bedWidthMm, p.bedDepthMm),
  outer_wall_speed: (p) => p.travelSpeedMmS / 2, // approximation
  outer_wall_line_width: (p) => p.nozzleDiameterMm,
  filament_max_volumetric_speed: (_p, f) => f.maxVolumetricFlowMm3S || 0,
  retraction_length: (p) => p.retractMm,
}

/**
 * Substitute PrusaSlicer/OrcaSlicer placeholder variables in user start/pause/end G-code with
 * values from the printer profile and the filament being printed, evaluating single-tool template
 * syntax (indexed settings and {if}/{elif}/{else}/{endif} conditionals) via the OrcaSlicer template
 * engine. Recognized placeholders are replaced; identifier-shaped placeholders that are not in the
 * map stay verbatim and are returned in `unknown` (deduplicated). A conditional block that cannot be
 * evaluated is left verbatim and surfaced in `warnings`.
 */
export function substituteSlicerVariables(
  gcode: string,
  profile: PrinterProfile,
  filament: FilamentProfile,
): { gcode: string; unknown: string[]; warnings: string[] } {
  const resolveSetting = (name: string): string | null => {
    // Object.hasOwn guards against inherited Object.prototype keys ({constructor}, {toString})
    // being resolved as variables.
    if (!Object.hasOwn(VARIABLE_MAP, name)) return null
    return String(VARIABLE_MAP[name](profile, filament))
  }
  const result = evaluateTemplate(gcode, resolveSetting)
  return { gcode: result.text, unknown: result.unknown, warnings: result.warnings }
}
