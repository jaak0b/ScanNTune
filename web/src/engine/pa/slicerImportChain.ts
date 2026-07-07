import type { SlicerImportResult } from './slicerImport'
import {
  importSlicerConfig,
  importOrcaMerged,
  orcaPresetName,
  tryParseOrcaPreset,
} from './slicerImport'

export interface SlicerFile {
  fileName: string
  content: string
}

/** One uploaded file, classified for chain resolution. */
interface ParsedFile {
  fileName: string
  content: string
  orca: Record<string, unknown> | null
}

/**
 * Parses an Orca preset's raw "inherits" value, resolving multi-level parent chains against the
 * other uploaded files by preset "name", order-independently. Non-Orca files, and Orca files
 * that are not part of a resolvable chain, keep the original later-file-wins single-file import.
 */
export function importSlicerConfigs(files: SlicerFile[]): SlicerImportResult {
  const parsed = files.map(parseFile)
  const orcaByName = buildOrcaNameMap(parsed)
  const consumedAsParent = findParentNames(parsed, orcaByName)

  const imports: SlicerImportResult[] = []
  for (const file of parsed) {
    if (file.orca === null) {
      imports.push(prefixWarnings(file.fileName, importSingleFile(file)))
      continue
    }
    // A file that only exists in this upload to serve as another file's chain parent is folded
    // into that chain's merge already; importing it again standalone would let later-file-wins
    // clobber the child's own values, making the result depend on upload order.
    const name = orcaPresetName(file.orca)
    if (name !== undefined && consumedAsParent.has(name)) continue
    imports.push(prefixWarnings(file.fileName, importOrcaChain(file, orcaByName)))
  }
  return mergeResults(imports)
}

/**
 * Prefixes each warning with its source file name, as the single-file form's caller used to. The
 * chain-specific warnings already name their file inline, so this only decorates plain messages.
 */
function prefixWarnings(fileName: string, result: SlicerImportResult): SlicerImportResult {
  return {
    ...result,
    warnings: result.warnings.map((w) => (w.includes(fileName) ? w : `${fileName}: ${w}`)),
  }
}

/**
 * Names of uploaded presets that some other uploaded preset's inherits chain resolves through
 * (and so should not also be imported standalone). Reads {@link resolveChain}'s own traversal
 * record rather than re-walking the chain, so the two can't drift out of sync. A chain that turns
 * out to be a cycle does not mark its members consumed: each cycle member still needs its own
 * standalone import so the cycle warning surfaces regardless of which file the caller looks at.
 */
function findParentNames(
  files: ParsedFile[],
  orcaByName: Map<string, Record<string, unknown>>,
): Set<string> {
  const consumed = new Set<string>()
  for (const file of files) {
    if (file.orca === null) continue
    const chain = resolveChain(file.orca, orcaByName)
    if (chain.cycle) continue
    for (const name of chain.parentNamesVisited) consumed.add(name)
  }
  return consumed
}

/** A file that isn't an Orca preset: PrusaSlicer .ini, or content neither format recognizes.
 *  A parse failure becomes a warning naming the file, not a thrown error, so one bad file in a
 *  multi-file upload doesn't discard the rest. */
function importSingleFile(file: ParsedFile): SlicerImportResult {
  try {
    return importSlicerConfig(file.fileName, file.content)
  } catch (e) {
    return {
      fields: { printer: {}, filament: {} },
      filaments: [],
      imported: [],
      missing: [],
      warnings: [e instanceof Error ? e.message : String(e)],
    }
  }
}

function parseFile(file: SlicerFile): ParsedFile {
  return { fileName: file.fileName, content: file.content, orca: tryParseOrcaPreset(file.content) }
}

/** Maps preset "name" to its parsed preset object, for chain lookups across the uploaded set. */
function buildOrcaNameMap(files: ParsedFile[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>()
  for (const file of files) {
    if (file.orca === null) continue
    const name = orcaPresetName(file.orca)
    if (name !== undefined) map.set(name, file.orca)
  }
  return map
}

/** Chain-resolves one Orca file's inherits parents (if any were uploaded) and imports the merge. */
function importOrcaChain(
  file: ParsedFile,
  orcaByName: Map<string, Record<string, unknown>>,
): SlicerImportResult {
  const preset = file.orca as Record<string, unknown>
  const chain = resolveChain(preset, orcaByName)
  const result = importOrcaMerged(chain.merged)
  if (chain.cycle) {
    result.warnings.push(
      `"${file.fileName}" has an "inherits" cycle; stopped resolving to avoid a hang.`,
    )
  } else if (chain.unresolvedParent !== undefined) {
    result.warnings.push(unresolvedInheritsWarning(chain.unresolvedParent))
  }
  return result
}

interface ChainResolution {
  /** Parent-under-child merge of every preset found in the chain, child keys always win. */
  merged: Record<string, unknown>
  /** Name of the top-most parent that is still missing from the uploaded set, if any. */
  unresolvedParent: string | undefined
  cycle: boolean
  /** Names of uploaded presets consumed as a parent while walking this chain (excludes the
   *  starting preset itself), for {@link findParentNames} to read instead of re-walking. */
  parentNamesVisited: string[]
}

/** Walks "inherits" parent-to-parent across the uploaded set, merging child-over-parent. */
function resolveChain(
  preset: Record<string, unknown>,
  orcaByName: Map<string, Record<string, unknown>>,
): ChainResolution {
  const visited = new Set<string>()
  const parentNamesVisited: string[] = []
  let merged: Record<string, unknown> = preset
  let current = preset
  for (;;) {
    const inherits = orcaPresetInherits(current)
    if (inherits === undefined) {
      return { merged, unresolvedParent: undefined, cycle: false, parentNamesVisited }
    }
    const name = orcaPresetName(current)
    if (name !== undefined) visited.add(name)
    if (visited.has(inherits)) {
      return { merged, unresolvedParent: undefined, cycle: true, parentNamesVisited }
    }
    const parent = orcaByName.get(inherits)
    if (parent === undefined) {
      return { merged, unresolvedParent: inherits, cycle: false, parentNamesVisited }
    }
    parentNamesVisited.push(inherits)
    merged = { ...parent, ...merged }
    current = parent
  }
}

function orcaPresetInherits(preset: Record<string, unknown>): string | undefined {
  const raw = preset.inherits
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  return raw
}

const ORCA_PARENT_PATH_HINT = 'resources\\profiles\\<vendor>\\machine\\'

function unresolvedInheritsWarning(parentName: string): string {
  return (
    `This preset inherits from '${parentName}' which was not uploaded. ` +
    `Find it under the OrcaSlicer installation: ${ORCA_PARENT_PATH_HINT}`
  )
}

/** later-file-wins merge across files, matching the existing form loop's behavior. */
function mergeResults(imports: SlicerImportResult[]): SlicerImportResult {
  const fields: SlicerImportResult['fields'] = { printer: {}, filament: {} }
  const filaments: SlicerImportResult['filaments'] = []
  const importedFields = new Set<string>()
  const warnings: string[] = []
  let missing: string[] = []
  for (const result of imports) {
    Object.assign(fields.printer, result.fields.printer)
    Object.assign(fields.filament, result.fields.filament)
    filaments.push(...result.filaments)
    for (const f of result.imported) importedFields.add(f)
    missing = result.missing.filter((f) => !importedFields.has(f))
    warnings.push(...result.warnings)
  }
  return { fields, filaments, imported: [...importedFields], missing, warnings }
}
