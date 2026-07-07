import type { FilamentProfile, PrinterProfile } from './types'

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
}

// A placeholder is a simple identifier with an optional numeric index, wrapped in [] or {}.
// Anything else in brackets or braces (Klipper jinja {% ... %}, dotted object refs like
// {printer.extruder.target}, plain comment text) is firmware-side syntax or prose: it is left
// verbatim and never reported.
const PLACEHOLDER = /\[([A-Za-z_][A-Za-z0-9_]*)(?:\[\d+\])?\]|\{([A-Za-z_][A-Za-z0-9_]*)(?:\[\d+\])?\}/g

/**
 * Substitute PrusaSlicer/OrcaSlicer placeholder variables in user start/pause/end G-code with
 * values from the printer profile and the filament being printed. Recognized placeholders are
 * replaced; identifier-shaped placeholders that are not in the map stay verbatim and are
 * returned in `unknown` (deduplicated).
 */
export function substituteSlicerVariables(
  gcode: string,
  profile: PrinterProfile,
  filament: FilamentProfile,
): { gcode: string; unknown: string[] } {
  const unknown = new Set<string>()
  const out = gcode.replace(PLACEHOLDER, (match, square: string | undefined, curly: string | undefined) => {
    const name = square ?? curly
    if (name === undefined) return match
    // Object.hasOwn guards against inherited Object.prototype keys ({constructor}, {toString})
    // being resolved as variables.
    const resolve = Object.hasOwn(VARIABLE_MAP, name) ? VARIABLE_MAP[name] : undefined
    if (resolve === undefined) {
      unknown.add(name)
      return match
    }
    return String(resolve(profile, filament))
  })
  return { gcode: out, unknown: [...unknown] }
}
