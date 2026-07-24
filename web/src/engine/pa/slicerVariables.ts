import type { FilamentProfile, PrinterProfile } from './types'
import { evaluateTemplate, TOOL_INDEX_VARS } from './orcaTemplate'

/**
 * Facts known only at coupon-generation time (not stored on the printer or filament profile)
 * that a slicer placeholder can reference: the coupon shell's own print speed and line width,
 * and the first layer's printed-geometry bounding box in bed coordinates. Every coupon
 * generator that calls `substituteSlicerVariables` (via `prepareProfile`) supplies one, built
 * from the same geometry it uses to emit the coupon, so a placeholder never sees a value the
 * generator did not actually print.
 */
export interface SlicerGenerationContext {
  /** The coupon shell's outer perimeter print speed, in mm/s. */
  outerWallSpeedMmS?: number
  /** The coupon shell's outer perimeter bead width, in mm. */
  outerWallLineWidthMm?: number
  /** The first printed layer's bounding box, in mm, in the generator's bed coordinate space. */
  firstLayerBboxMm?: { minXMm: number; minYMm: number; maxXMm: number; maxYMm: number }
}

// PrusaSlicer and OrcaSlicer placeholder names mapped onto profile fields. Case-sensitive,
// matching the slicers' own variable names. The optional [n] index suffix (multi-extruder
// vectors) is accepted and ignored: the PA coupon is a single-extruder print. A mapping may
// return null to leave its placeholder unresolved (reported as unknown) when the value it
// would need is not actually known, e.g. an unset filament limit or a missing generation
// context; it must never substitute a placeholder number that would misrepresent "unset".
const VARIABLE_MAP: Record<
  string,
  (p: PrinterProfile, f: FilamentProfile, ctx?: SlicerGenerationContext) => string | number | null
> = {
  first_layer_temperature: (_p, f) => f.nozzleTempC,
  temperature: (_p, f) => f.nozzleTempC,
  nozzle_temperature: (_p, f) => f.nozzleTempC,
  first_layer_nozzle_temperature: (_p, f) => f.nozzleTempC,
  nozzle_temperature_initial_layer: (_p, f) => f.nozzleTempC,
  first_layer_bed_temperature: (_p, f) => f.bedTempC,
  bed_temperature: (_p, f) => f.bedTempC,
  first_layer_bed_temp: (_p, f) => f.bedTempC,
  bed_temperature_initial_layer_single: (_p, f) => f.bedTempC,
  chamber_temperature: (_p, f) => f.chamberTempC,
  chamber_temp: (_p, f) => f.chamberTempC,
  filament_type: (_p, f) => f.filamentType,
  filament_diameter: (_p, f) => f.filamentDiameterMm,
  // 0 means "not configured" on the filament profile, never a real flow limit: leave the
  // placeholder unresolved rather than tell a macro the printer may extrude at zero flow.
  filament_max_volumetric_speed: (_p, f) => (f.maxVolumetricFlowMm3S > 0 ? f.maxVolumetricFlowMm3S : null),
  layer_height: (p) => p.layerHeightMm,
  first_layer_height: (p) => p.layerHeightMm,
  nozzle_diameter: (p) => p.nozzleDiameterMm,
  travel_speed: (p) => p.travelSpeedMmS,
  outer_wall_speed: (_p, _f, ctx) => ctx?.outerWallSpeedMmS ?? null,
  outer_wall_line_width: (_p, _f, ctx) => ctx?.outerWallLineWidthMm ?? null,
  retraction_length: (p) => p.retractMm,
}

/** Orca's plate bounding-box vec2 placeholders, resolved from the generation context. */
const INDEXED_VARIABLE_MAP: Record<
  string,
  (ctx?: SlicerGenerationContext) => [number, number] | null
> = {
  first_layer_print_min: (ctx) =>
    ctx?.firstLayerBboxMm ? [ctx.firstLayerBboxMm.minXMm, ctx.firstLayerBboxMm.minYMm] : null,
  first_layer_print_max: (ctx) =>
    ctx?.firstLayerBboxMm ? [ctx.firstLayerBboxMm.maxXMm, ctx.firstLayerBboxMm.maxYMm] : null,
}

/**
 * Substitute PrusaSlicer/OrcaSlicer placeholder variables in user start/pause/end G-code with
 * values from the printer profile, the filament being printed, and (for values only known at
 * generation time, such as the shell speed/width and the plate bounding box) `context`,
 * evaluating single-tool template syntax (indexed settings and {if}/{elif}/{else}/{endif}
 * conditionals) via the OrcaSlicer template engine. Recognized placeholders are replaced;
 * identifier-shaped placeholders that are not in the map (or whose value is not known) stay
 * verbatim and are returned in `unknown` (deduplicated). A conditional block that cannot be
 * evaluated is left verbatim and surfaced in `warnings`, as is a slicer arithmetic expression
 * (e.g. `{retraction_length[0]*0.75}`) built from a recognized variable: this tool does not
 * evaluate slicer arithmetic, so the expression is left untouched and warned about rather than
 * silently passed through or reported as an unresolved variable.
 */
export function substituteSlicerVariables(
  gcode: string,
  profile: PrinterProfile,
  filament: FilamentProfile,
  context?: SlicerGenerationContext,
): { gcode: string; unknown: string[]; warnings: string[] } {
  const resolveSetting = (name: string, idx?: number): string | null => {
    // Object.hasOwn guards against inherited Object.prototype keys ({constructor}, {toString})
    // being resolved as variables.
    if (Object.hasOwn(INDEXED_VARIABLE_MAP, name)) {
      const vec = INDEXED_VARIABLE_MAP[name](context)
      if (vec === null) return null
      if (idx === undefined) return vec.join(',')
      const component = vec[idx]
      return component === undefined ? null : String(component)
    }
    if (!Object.hasOwn(VARIABLE_MAP, name)) return null
    const value = VARIABLE_MAP[name](profile, filament, context)
    return value === null ? null : String(value)
  }
  const isKnownVariable = (name: string): boolean =>
    Object.hasOwn(VARIABLE_MAP, name) || Object.hasOwn(INDEXED_VARIABLE_MAP, name) || TOOL_INDEX_VARS.has(name)
  const result = evaluateTemplate(gcode, resolveSetting, isKnownVariable)
  return { gcode: result.text, unknown: result.unknown, warnings: result.warnings }
}

/**
 * The single unresolved-slicer-variables warning shared by every calibration flow's page: the
 * named placeholders were left exactly as written because their value could not be determined,
 * and a printer macro reading one as a number will fail until it is replaced.
 */
export function unresolvedVariablesWarning(names: string[]): string {
  return (
    `These slicer variables could not be filled in: ${names.join(', ')}. ` +
    'They were left exactly as written in the G-code, and a printer macro that reads one of ' +
    'them as a number will fail. Replace each one with a real number in your start G-code, in ' +
    'the profile editor, before printing.'
  )
}
