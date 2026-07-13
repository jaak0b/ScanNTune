import type { FilamentProfile, Firmware, PrinterProfile } from './types'

export { importSlicerConfigs } from './slicerImportChain'
export type { SlicerFile } from './slicerImportChain'
import type { UnresolvedParent } from './slicerImportChain'

/** Printer-kind fields an import can fill (identity and filament list excluded). */
export type ImportedPrinterFields = Partial<
  Omit<PrinterProfile, 'id' | 'name' | 'filaments' | 'selectedFilamentId'>
>
/** Filament-kind fields an import can fill (identity excluded). */
export type ImportedFilamentFields = Partial<Omit<FilamentProfile, 'id' | 'name'>>

/** All fields an import can fill, before the printer/filament split in finish(). */
type ImportedFields = ImportedPrinterFields & ImportedFilamentFields

export interface SlicerImportResult {
  fields: { printer: ImportedPrinterFields; filament: ImportedFilamentFields }
  /** One entry per named [filament:...] section in a PrusaSlicer config bundle, in file order;
   *  empty for flat single-filament sources. */
  filaments: { name: string; fields: ImportedFilamentFields }[]
  imported: string[]
  missing: string[]
  warnings: string[]
  /** Unresolved-inherits parents, structured for the UI; absent (undefined) for single-file
   *  imports that never go through chain resolution. Chain resolution always sets it (possibly
   *  to an empty array), so callers that go through importSlicerConfigs can rely on it. */
  unresolvedParents?: UnresolvedParent[]
  /** Per-uploaded-file breakdown of which fields each file's import filled (cached or
   *  consumed-as-parent presets excluded); only set by multi-file chain resolution. */
  sources?: { fileName: string; imported: string[] }[]
  /** Inherited parents that resolved from the passed-in cached presets (not from an upload in
   *  this batch), so the UI can show them as remembered rather than as still-missing. */
  resolvedFromCache?: { presetName: string }[]
  /** The imported preset's own name, so the tool can name its profile after it. For an Orca
   *  file it is the preset "name"; for a Prusa bundle the chosen printer or first filament
   *  section; for a flat Prusa export the file name without its extension. Undefined when no
   *  non-empty name is available. */
  presetName?: string
}

/** Profile fields the importer knows how to fill; anything not found lands in missing[]. */
const MAPPED_FIELDS_LIST = [
  'firmware',
  'bedWidthMm',
  'bedDepthMm',
  'nozzleDiameterMm',
  'filamentDiameterMm',
  'nozzleTempC',
  'bedTempC',
  'chamberTempC',
  'filamentType',
  'extrusionMultiplier',
  'maxVolumetricFlowMm3S',
  'retractMm',
  'retractSpeedMmS',
  'printAccelMmS2',
  'squareCornerVelocityMmS',
  'startGcode',
  'pauseGcode',
  'endGcode',
] as const satisfies readonly (keyof ImportedFields)[]

const MAPPED_FIELDS: (typeof MAPPED_FIELDS_LIST)[number][] = [...MAPPED_FIELDS_LIST]

const FLAVOR_TO_FIRMWARE: Record<string, Firmware> = {
  klipper: 'Klipper',
  marlin: 'Marlin',
  marlin2: 'Marlin',
  reprap: 'RepRapFirmware',
  reprapfirmware: 'RepRapFirmware',
}

/**
 * Parses a PrusaSlicer .ini export (flat or bundle) or an OrcaSlicer preset .json and returns
 * the printer-profile fields it could fill. Missing keys are reported, never thrown; only
 * content that is neither format throws.
 */
export function importSlicerConfig(fileName: string, content: string): SlicerImportResult {
  const orca = tryParseOrca(content)
  if (orca !== null) return { ...importOrca(orca), presetName: orcaPresetName(orca) }
  const ini = tryParseIni(content)
  if (ini !== null) return { ...importPrusa(ini), presetName: prusaPresetName(ini, fileName) }
  throw new Error(
    `"${fileName}" does not look like a PrusaSlicer config export or an OrcaSlicer preset file.`,
  )
}

/** The file name with its final extension stripped and trimmed; undefined when nothing remains. */
function fileNameStem(fileName: string): string | undefined {
  const stem = fileName.replace(/\.[^./\\]+$/, '').trim()
  return stem === '' ? undefined : stem
}

/** A Prusa import's preset name: the chosen printer section (or first filament section) of a
 *  bundle, else the flat export's file name without its extension. */
function prusaPresetName(ini: ParsedIni, fileName: string): string | undefined {
  return ini.chosenSectionName ?? ini.filamentSections[0]?.name ?? fileNameStem(fileName)
}

/** Field-kind classification for every {@link MAPPED_FIELDS} entry: which side of the
 *  printer/filament split each imported field lands on. */
export const FIELD_KINDS: Record<(typeof MAPPED_FIELDS_LIST)[number], 'printer' | 'filament'> = {
  firmware: 'printer',
  bedWidthMm: 'printer',
  bedDepthMm: 'printer',
  nozzleDiameterMm: 'printer',
  retractMm: 'printer',
  retractSpeedMmS: 'printer',
  printAccelMmS2: 'printer',
  squareCornerVelocityMmS: 'printer',
  startGcode: 'printer',
  pauseGcode: 'printer',
  endGcode: 'printer',
  filamentType: 'filament',
  filamentDiameterMm: 'filament',
  nozzleTempC: 'filament',
  bedTempC: 'filament',
  chamberTempC: 'filament',
  extrusionMultiplier: 'filament',
  maxVolumetricFlowMm3S: 'filament',
}

interface Ctx {
  fields: ImportedFields
  warnings: string[]
  /** Raw config value lookup; returns undefined when absent. */
  get: (key: string) => string | undefined
}

/** Splits the flat imported fields into the printer and filament sides via FIELD_KINDS. */
function splitFields(fields: ImportedFields): SlicerImportResult['fields'] {
  const printer: Record<string, unknown> = {}
  const filament: Record<string, unknown> = {}
  for (const field of MAPPED_FIELDS) {
    const value = fields[field]
    if (value === undefined) continue
    const target = FIELD_KINDS[field] === 'printer' ? printer : filament
    target[field] = value
  }
  return {
    printer: printer as ImportedPrinterFields,
    filament: filament as ImportedFilamentFields,
  }
}

function finish(
  ctx: Ctx,
  filaments: SlicerImportResult['filaments'] = [],
): SlicerImportResult {
  const imported = MAPPED_FIELDS.filter((f) => ctx.fields[f] !== undefined)
  const missing = MAPPED_FIELDS.filter((f) => ctx.fields[f] === undefined)
  return { fields: splitFields(ctx.fields), filaments, imported, missing, warnings: ctx.warnings }
}

/** Parses "123", "123,456" (index 0), rejecting percent values with a warning. */
function numberFrom(ctx: Ctx, key: string): number | undefined {
  const raw = ctx.get(key)
  if (raw === undefined) return undefined
  const first = raw.split(',')[0].trim()
  if (first.endsWith('%')) {
    ctx.warnings.push(`Skipped ${key} = ${first}: percent values cannot be imported directly.`)
    return undefined
  }
  const n = Number.parseFloat(first)
  if (!Number.isFinite(n)) {
    ctx.warnings.push(`Skipped ${key}: could not read a number from "${raw}".`)
    return undefined
  }
  return n
}

function firstNumber(ctx: Ctx, keys: string[]): number | undefined {
  for (const key of keys) {
    const n = numberFrom(ctx, key)
    if (n !== undefined) return n
  }
  return undefined
}

function setNum(ctx: Ctx, field: keyof ImportedFields, value: number | undefined): void {
  if (value !== undefined) (ctx.fields as Record<string, unknown>)[field] = value
}

/** Bounding-box width/depth of an "AxB" corner-point polygon list. */
function polygonSize(points: string[]): { width: number; depth: number } | undefined {
  const xs: number[] = []
  const ys: number[] = []
  for (const p of points) {
    const [xStr, yStr] = p.trim().split('x')
    const x = Number.parseFloat(xStr)
    const y = Number.parseFloat(yStr)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
    xs.push(x)
    ys.push(y)
  }
  if (xs.length < 3) return undefined
  return {
    width: Math.max(...xs) - Math.min(...xs),
    depth: Math.max(...ys) - Math.min(...ys),
  }
}

function applyFirmware(ctx: Ctx): void {
  const flavor = ctx.get('gcode_flavor')
  if (flavor === undefined) return
  const fw = FLAVOR_TO_FIRMWARE[flavor.trim().toLowerCase()]
  if (fw !== undefined) {
    ctx.fields.firmware = fw
  } else {
    ctx.warnings.push(
      `G-code flavor "${flavor}" has no matching firmware option here; pick the firmware manually.`,
    )
  }
}

/** Fills the fields shared by both formats (temps, sizes, speeds, accel, jerk). */
function applyCommon(
  ctx: Ctx,
  keys: FilamentKeys & {
    bedPoints: () => string[] | undefined
    retractLength: string[]
    retractSpeed: string[]
    startGcode: string
    endGcode: string
    pauseGcode: string[]
    gcodeTransform: (raw: string) => string
  },
): void {
  const bedPoints = keys.bedPoints()
  if (bedPoints !== undefined) {
    const size = polygonSize(bedPoints)
    if (size !== undefined) {
      ctx.fields.bedWidthMm = size.width
      ctx.fields.bedDepthMm = size.depth
    } else {
      ctx.warnings.push('Could not read the bed shape from this file.')
    }
  }
  setNum(ctx, 'nozzleDiameterMm', numberFrom(ctx, 'nozzle_diameter'))
  applyFilamentKeys(ctx, keys)
  setNum(ctx, 'retractMm', firstNumber(ctx, keys.retractLength))
  setNum(ctx, 'retractSpeedMmS', firstNumber(ctx, keys.retractSpeed))
  const defaultAccel = numberFrom(ctx, 'default_acceleration')
  setNum(
    ctx,
    'printAccelMmS2',
    defaultAccel !== undefined && defaultAccel > 0
      ? defaultAccel
      : firstNumber(ctx, ['machine_max_acceleration_extruding', 'machine_max_acceleration_x']),
  )
  setNum(ctx, 'squareCornerVelocityMmS', numberFrom(ctx, 'machine_max_jerk_x'))
  const start = ctx.get(keys.startGcode)
  if (start !== undefined) ctx.fields.startGcode = keys.gcodeTransform(start)
  const end = ctx.get(keys.endGcode)
  if (end !== undefined) ctx.fields.endGcode = keys.gcodeTransform(end)
  for (const key of keys.pauseGcode) {
    const pause = ctx.get(key)
    if (pause !== undefined && pause.trim() !== '') {
      ctx.fields.pauseGcode = keys.gcodeTransform(pause)
      break
    }
  }
  applyFirmware(ctx)
}

/** Filament-kind key sets, shared by both formats. */
interface FilamentKeys {
  nozzleTemp: string[]
  bedTemp: string[]
  chamberTemp: string[]
  /** Extrusion multiplier / flow ratio keys, per format. */
  flowRatio: string[]
}

/** Fills the filament-kind fields (diameter, temps, type, flow) from a key map. */
function applyFilamentKeys(ctx: Ctx, keys: FilamentKeys): void {
  setNum(ctx, 'filamentDiameterMm', numberFrom(ctx, 'filament_diameter'))
  setNum(ctx, 'nozzleTempC', firstNumber(ctx, keys.nozzleTemp))
  setNum(ctx, 'bedTempC', firstNumber(ctx, keys.bedTemp))
  setNum(ctx, 'chamberTempC', firstNumber(ctx, keys.chamberTemp))
  const flowRatio = firstNumber(ctx, keys.flowRatio)
  if (flowRatio !== undefined && flowRatio > 0) {
    ctx.fields.extrusionMultiplier = flowRatio
  }
  // Slicers use 0 for "no volumetric limit"; that maps to the profile's own
  // not-configured value, so it is only set when positive.
  const maxFlow = numberFrom(ctx, 'filament_max_volumetric_speed')
  if (maxFlow !== undefined && maxFlow > 0) {
    ctx.fields.maxVolumetricFlowMm3S = maxFlow
  }
  const filamentType = ctx.get('filament_type')
  if (filamentType !== undefined && filamentType.trim() !== '') {
    ctx.fields.filamentType = filamentType.split(',')[0].trim()
  }
}

// ---------------------------------------------------------------------------
// PrusaSlicer .ini
// ---------------------------------------------------------------------------

/** A parsed PrusaSlicer .ini: the merged key map plus any named filament bundle sections. */
interface ParsedIni {
  keys: Map<string, string>
  /** Named (non-hidden) [filament:...] sections in file order; empty for flat exports. */
  filamentSections: { name: string; keys: Map<string, string> }[]
  /** The chosen [printer:...] section name of a bundle; undefined for a flat export. */
  chosenSectionName?: string
}

/** Returns the parsed ini, or null when the content has no key = value lines at all. */
function tryParseIni(content: string): ParsedIni | null {
  const sections = new Map<string, Map<string, string>>()
  const flat = new Map<string, string>()
  let current: Map<string, string> = flat
  let sawAssignment = false
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const section = line.match(/^\[(.+)\]$/)
    if (section) {
      current = new Map<string, string>()
      sections.set(section[1], current)
      continue
    }
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    current.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
    sawAssignment = true
  }
  if (!sawAssignment) return null
  if (sections.size === 0) return { keys: flat, filamentSections: [] }
  const filamentSections: ParsedIni['filamentSections'] = []
  for (const [name, keys] of sections) {
    if (name.startsWith('filament:') && !name.slice('filament:'.length).startsWith('*')) {
      filamentSections.push({ name: name.slice('filament:'.length), keys })
    }
  }
  const bundle = mergeBundle(sections)
  return { keys: bundle.keys, filamentSections, chosenSectionName: bundle.chosenPrinterName }
}

/** Merges a config-bundle's chosen print/filament/printer presets into one key map, and reports
 *  the chosen printer preset's section name (for naming the imported profile). */
function mergeBundle(sections: Map<string, Map<string, string>>): {
  keys: Map<string, string>
  chosenPrinterName: string | undefined
} {
  const presets = sections.get('presets')
  const merged = new Map<string, string>()
  let chosenPrinterName: string | undefined
  for (const kind of ['printer', 'filament', 'print']) {
    let chosen: Map<string, string> | undefined
    let chosenName: string | undefined
    const named = presets?.get(kind)
    if (named !== undefined) {
      chosen = sections.get(`${kind}:${named}`)
      if (chosen !== undefined) chosenName = named
    }
    if (chosen === undefined) {
      for (const [name, values] of sections) {
        if (name.startsWith(`${kind}:`) && !name.slice(kind.length + 1).startsWith('*')) {
          chosen = values
          chosenName = name.slice(kind.length + 1)
          break
        }
      }
    }
    if (chosen !== undefined) {
      for (const [k, v] of chosen) merged.set(k, v)
      if (kind === 'printer') chosenPrinterName = chosenName
    }
  }
  return { keys: merged, chosenPrinterName }
}

const PRUSA_FILAMENT_KEYS: FilamentKeys = {
  nozzleTemp: ['first_layer_temperature', 'temperature'],
  bedTemp: ['first_layer_bed_temperature', 'bed_temperature'],
  chamberTemp: ['chamber_temperature', 'chamber_minimal_temperature'],
  flowRatio: ['extrusion_multiplier'],
}

function importPrusa(ini: ParsedIni): SlicerImportResult {
  const { keys } = ini
  const ctx: Ctx = { fields: {}, warnings: [], get: (key) => keys.get(key) }
  applyCommon(ctx, {
    bedPoints: () => keys.get('bed_shape')?.split(','),
    ...PRUSA_FILAMENT_KEYS,
    retractLength: ['retract_length'],
    retractSpeed: ['retract_speed'],
    startGcode: 'start_gcode',
    endGcode: 'end_gcode',
    pauseGcode: ['pause_print_gcode'],
    gcodeTransform: (raw) => raw.replace(/\\n/g, '\n'),
  })
  return finish(ctx, ini.filamentSections.map((s) => prusaBundleFilament(s, ctx.warnings)))
}

/** Extracts one bundle [filament:...] section's filament-kind fields under its section name. */
function prusaBundleFilament(
  section: { name: string; keys: Map<string, string> },
  warnings: string[],
): SlicerImportResult['filaments'][number] {
  const ctx: Ctx = { fields: {}, warnings, get: (key) => section.keys.get(key) }
  applyFilamentKeys(ctx, PRUSA_FILAMENT_KEYS)
  return { name: section.name, fields: splitFields(ctx.fields).filament }
}

// ---------------------------------------------------------------------------
// OrcaSlicer preset .json
// ---------------------------------------------------------------------------

/** Returns the parsed preset object, or null when the content is not an Orca preset. Exported
 *  for chain resolution across multiple uploaded files (see slicerImportChain.ts). */
export function tryParseOrcaPreset(content: string): Record<string, unknown> | null {
  return tryParseOrca(content)
}

/** The preset's "name" field, used as the chain-resolution lookup key. */
export function orcaPresetName(preset: Record<string, unknown>): string | undefined {
  const name = preset.name
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined
}

/** The preset "kind" markers, used to place unresolved-parent path hints under the matching
 *  vendor profile subfolder. Exported for slicerImportChain.ts. */
export type OrcaPresetKind = 'filament' | 'process' | 'machine'

/** Infers a preset's kind (filament, process, or machine) from its distinguishing keys. Defaults
 *  to 'machine' when nothing filament- or process-specific is present, matching every kind of
 *  preset this importer otherwise treats as a printer profile. */
export function orcaPresetKind(preset: Record<string, unknown>): OrcaPresetKind {
  if (
    'filament_settings_id' in preset ||
    'filament_type' in preset ||
    'nozzle_temperature' in preset
  ) {
    return 'filament'
  }
  if ('print_settings_id' in preset) return 'process'
  return 'machine'
}

/** Returns the parsed preset object, or null when the content is not an Orca preset. */
function tryParseOrca(content: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    // Not JSON: the caller falls through to the INI parser. Nothing is lost here because a
    // real Orca preset always parses; anything else is handled (or rejected) downstream.
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  // Preset JSON exported from the Orca UI carries "type"; presets copied straight out of the
  // user config folder (as the app's own docs point users to) often don't. Accept any of the
  // other markers that are unique to an Orca preset file instead.
  if (typeof obj.type === 'string') return obj
  if (typeof obj.printer_settings_id === 'string') return obj
  if (typeof obj.print_settings_id === 'string') return obj
  if (typeof obj.filament_settings_id !== 'undefined') return obj
  if (typeof obj.from === 'string' && typeof obj.version === 'string') return obj
  if (typeof obj.inherits !== 'undefined') return obj
  return null
}

/** Orca values are strings or arrays of strings; element 0 counts and "nil" means absent. */
function orcaValue(preset: Record<string, unknown>, key: string): string | undefined {
  const raw = preset[key]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return undefined
  if (value === 'nil') return undefined
  return value
}

/** Imports an Orca preset that chain resolution has already merged parent-under-child; the
 *  "inherits" key on the merged object (if the chain is fully resolved) is dropped by the caller
 *  before this runs, so no unresolved-inherits warning fires here. Exported for
 *  slicerImportChain.ts, which appends its own chain-specific warning (missing parent or cycle). */
export function importOrcaMerged(preset: Record<string, unknown>): SlicerImportResult {
  return importOrca({ ...preset, inherits: undefined })
}

function importOrca(preset: Record<string, unknown>): SlicerImportResult {
  const ctx: Ctx = { fields: {}, warnings: [], get: (key) => orcaValue(preset, key) }
  applyCommon(ctx, {
    bedPoints: () => {
      const raw = preset.printable_area
      if (Array.isArray(raw) && raw.every((p) => typeof p === 'string')) return raw as string[]
      if (typeof raw === 'string') return raw.split(',')
      return undefined
    },
    nozzleTemp: ['nozzle_temperature_initial_layer', 'nozzle_temperature'],
    bedTemp: [],
    flowRatio: ['filament_flow_ratio'],
    retractLength: ['filament_retraction_length', 'retraction_length'],
    retractSpeed: ['filament_retraction_speed', 'retraction_speed'],
    startGcode: 'machine_start_gcode',
    endGcode: 'machine_end_gcode',
    pauseGcode: ['machine_pause_gcode', 'change_filament_gcode'],
    chamberTemp: ['chamber_temperatures', 'chamber_temperature'],
    gcodeTransform: (raw) => raw,
  })
  setNum(ctx, 'bedTempC', orcaBedTemp(ctx))
  const inherits = orcaValue(preset, 'inherits')
  if (inherits !== undefined && inherits.trim() !== '') {
    const filled = MAPPED_FIELDS.filter((f) => ctx.fields[f] !== undefined).length
    if (filled < MAPPED_FIELDS.length) {
      ctx.warnings.push(
        'This preset inherits from a system preset; missing values keep their current defaults. Export the resolved config or import the parent preset too.',
      )
    }
  }
  return finish(ctx)
}

/** First non-zero plate temperature, preferring hot and textured plates and first-layer keys. */
function orcaBedTemp(ctx: Ctx): number | undefined {
  const keys = [
    'hot_plate_temp_initial_layer',
    'hot_plate_temp',
    'textured_plate_temp_initial_layer',
    'textured_plate_temp',
    'supertack_plate_temp_initial_layer',
    'supertack_plate_temp',
    'cool_plate_temp_initial_layer',
    'cool_plate_temp',
    'eng_plate_temp_initial_layer',
    'eng_plate_temp',
  ]
  for (const key of keys) {
    const n = numberFrom(ctx, key)
    if (n !== undefined && n > 0) return n
  }
  return undefined
}
