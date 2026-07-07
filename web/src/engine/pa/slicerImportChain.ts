import type { OrcaPresetKind, SlicerImportResult } from './slicerImport'
import {
  importSlicerConfig,
  importOrcaMerged,
  orcaPresetKind,
  orcaPresetName,
  tryParseOrcaPreset,
} from './slicerImport'

export interface SlicerFile {
  fileName: string
  content: string
}

/** One unresolved "inherits" parent, structured for the UI instead of parsed out of a prose
 *  warning string. pathHint is null when the vendor guess failed (non-alphabetic or empty first
 *  word of the preset name): the UI shows that case as plain guidance text with no copy button. */
export interface UnresolvedParent {
  presetName: string
  pathHint: string | null
  fileName: string
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
 *
 * `cachedPresets` are previously remembered base presets: they take part in chain resolution as
 * parents (an uploaded preset of the same name wins) but are never imported standalone, so the
 * cache can only fill fields an uploaded chain asks for. `installPath` is the OrcaSlicer install
 * folder used to make unresolved-parent path hints absolute; null keeps the generic relative hint.
 */
export function importSlicerConfigs(
  files: SlicerFile[],
  cachedPresets: SlicerFile[] = [],
  installPath: string | null = null,
): SlicerImportResult {
  const parsed = files.map(parseFile)
  const orcaByName = buildOrcaNameMap([...cachedPresets.map(parseFile), ...parsed])
  // Names present only in the cache (no uploaded preset of the same name in this batch): a chain
  // parent resolved through one of these is a remembered-from-cache resolution, not an upload.
  const uploadedNames = new Set(buildOrcaNameMap(parsed).keys())
  const cachedOnlyNames = new Set(
    [...buildOrcaNameMap(cachedPresets.map(parseFile)).keys()].filter(
      (name) => !uploadedNames.has(name),
    ),
  )
  const consumedAsParent = findParentNames(parsed, orcaByName)

  const imports: { fileName: string; result: SlicerImportResult }[] = []
  for (const file of parsed) {
    if (file.orca === null) {
      imports.push({
        fileName: file.fileName,
        result: prefixWarnings(file.fileName, importSingleFile(file)),
      })
      continue
    }
    // A file that only exists in this upload to serve as another file's chain parent is folded
    // into that chain's merge already; importing it again standalone would let later-file-wins
    // clobber the child's own values, making the result depend on upload order.
    const name = orcaPresetName(file.orca)
    if (name !== undefined && consumedAsParent.has(name)) continue
    imports.push({
      fileName: file.fileName,
      result: prefixWarnings(
        file.fileName,
        importOrcaChain(file, orcaByName, installPath, cachedOnlyNames),
      ),
    })
  }
  const merged = mergeResults(imports.map((i) => i.result))
  merged.sources = imports.map((i) => ({ fileName: i.fileName, imported: i.result.imported }))
  return merged
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
    const result = importSlicerConfig(file.fileName, file.content)
    result.unresolvedParents = []
    result.resolvedFromCache = []
    return result
  } catch (e) {
    return {
      fields: { printer: {}, filament: {} },
      filaments: [],
      imported: [],
      missing: [],
      warnings: [e instanceof Error ? e.message : String(e)],
      unresolvedParents: [],
      resolvedFromCache: [],
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

/** The raw non-empty "inherits" value of a preset, or undefined when it inherits nothing.
 *  Exported so the UI layer can decide which uploads are chain members worth caching. */
export function orcaPresetInherits(preset: Record<string, unknown>): string | undefined {
  const raw = preset.inherits
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  return raw
}

/** Chain-resolves one Orca file's inherits parents (if any were uploaded) and imports the merge. */
function importOrcaChain(
  file: ParsedFile,
  orcaByName: Map<string, Record<string, unknown>>,
  installPath: string | null,
  cachedOnlyNames: Set<string>,
): SlicerImportResult {
  const preset = file.orca as Record<string, unknown>
  const chain = resolveChain(preset, orcaByName)
  const result = importOrcaMerged(chain.merged)
  result.unresolvedParents = []
  result.resolvedFromCache = chain.parentNamesVisited
    .filter((name) => cachedOnlyNames.has(name))
    .map((presetName) => ({ presetName }))
  if (chain.cycle) {
    result.warnings.push(
      `"${file.fileName}" has an "inherits" cycle; stopped resolving to avoid a hang.`,
    )
  } else if (chain.unresolvedParent !== undefined) {
    const kind = orcaPresetKind(preset)
    result.warnings.push(unresolvedInheritsWarning(chain.unresolvedParent, kind))
    const rootName = orcaPresetName(preset)
    const vendorCandidates = [chain.unresolvedParent, chain.lastResolvedChild, rootName].filter(
      (name): name is string => name !== undefined,
    )
    result.unresolvedParents.push({
      presetName: chain.unresolvedParent,
      pathHint: parentPathHint(chain.unresolvedParent, kind, installPath, vendorCandidates),
      fileName: file.fileName,
    })
  }
  return result
}

/** True when a preset name's first whitespace-separated word plausibly identifies an OrcaSlicer
 *  vendor folder: alphabetic characters only (no digits, underscores, or symbols) and at least two
 *  characters long. Common vendor-less bases like "fdm_klipper_common" fail this (underscore), as
 *  do nozzle-size-prefixed names like "0.4 Generic Nozzle" (leading digit). */
export function isVendorWord(name: string): boolean {
  const firstWord = name.trim().split(/\s+/)[0] ?? ''
  return /^[A-Za-z]{2,}$/.test(firstWord)
}

/**
 * Guesses the OrcaSlicer vendor profile folder for a missing parent preset, from the first
 * candidate name (in priority order) whose first whitespace-separated word plausibly identifies a
 * vendor, per {@link isVendorWord}. Callers pass candidates most-specific first: typically the
 * missing parent's own name, then the uploaded preset that inherits from it directly (whose name
 * usually does carry the vendor, e.g. "Voron 2.4 300 0.4 nozzle" for a missing "fdm_klipper_common"
 * base), then the chain root. When none qualify, the caller shows the placeholder "<vendor>" hint
 * as plain text instead of a copyable path. The subfolder matches the child preset's own kind
 * (filament/process/machine), since that's what the missing parent is too. Orca stores each preset
 * as "<preset name>.json" in that folder, so the hint names the exact file.
 */
function parentPathHint(
  presetName: string,
  kind: OrcaPresetKind,
  installPath: string | null,
  vendorCandidates: string[],
): string | null {
  const vendorSource = vendorCandidates.find(isVendorWord)
  if (vendorSource === undefined) return null
  const vendor = vendorSource.trim().split(/\s+/)[0]
  const base =
    installPath !== null && installPath.trim() !== ''
      ? installPath.trim().replace(/[\\/]+$/, '')
      : 'OrcaSlicer'
  return `${base}\\resources\\profiles\\${vendor}\\${kind}\\${presetName}.json`
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
  /** Name of the last successfully resolved preset in the chain before the unresolved parent was
   *  hit, i.e. the preset whose own "inherits" names it. Undefined when the chain's starting
   *  preset itself is the one with the unresolved parent. Used as a vendor-name fallback in
   *  {@link parentPathHint} when the missing parent's own name doesn't carry one. */
  lastResolvedChild: string | undefined
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
      return {
        merged,
        unresolvedParent: undefined,
        cycle: false,
        parentNamesVisited,
        lastResolvedChild: undefined,
      }
    }
    const name = orcaPresetName(current)
    if (name !== undefined) visited.add(name)
    if (visited.has(inherits)) {
      return {
        merged,
        unresolvedParent: undefined,
        cycle: true,
        parentNamesVisited,
        lastResolvedChild: undefined,
      }
    }
    const parent = orcaByName.get(inherits)
    if (parent === undefined) {
      return {
        merged,
        unresolvedParent: inherits,
        cycle: false,
        parentNamesVisited,
        lastResolvedChild: name,
      }
    }
    parentNamesVisited.push(inherits)
    merged = { ...parent, ...merged }
    current = parent
  }
}

function unresolvedInheritsWarning(parentName: string, kind: OrcaPresetKind): string {
  const placeholderHint = `resources\\profiles\\<vendor>\\${kind}\\${parentName}.json`
  return (
    `This preset inherits from '${parentName}' which was not uploaded. ` +
    `Find it under the OrcaSlicer installation: ${placeholderHint}`
  )
}

/** later-file-wins merge across files, matching the existing form loop's behavior. */
function mergeResults(imports: SlicerImportResult[]): SlicerImportResult {
  const fields: SlicerImportResult['fields'] = { printer: {}, filament: {} }
  const filaments: SlicerImportResult['filaments'] = []
  const importedFields = new Set<string>()
  const warnings: string[] = []
  const unresolvedParents: NonNullable<SlicerImportResult['unresolvedParents']> = []
  const resolvedFromCache: NonNullable<SlicerImportResult['resolvedFromCache']> = []
  let missing: string[] = []
  for (const result of imports) {
    Object.assign(fields.printer, result.fields.printer)
    Object.assign(fields.filament, result.fields.filament)
    filaments.push(...result.filaments)
    for (const f of result.imported) importedFields.add(f)
    missing = result.missing.filter((f) => !importedFields.has(f))
    warnings.push(...result.warnings)
    unresolvedParents.push(...(result.unresolvedParents ?? []))
    for (const cached of result.resolvedFromCache ?? []) {
      if (!resolvedFromCache.some((c) => c.presetName === cached.presetName))
        resolvedFromCache.push(cached)
    }
  }
  return {
    fields,
    filaments,
    imported: [...importedFields],
    missing,
    warnings,
    unresolvedParents,
    resolvedFromCache,
  }
}
