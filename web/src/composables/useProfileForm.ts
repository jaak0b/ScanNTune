import { computed, ref } from 'vue'
import type { FilamentProfile, Firmware, PrinterProfile } from '../engine/pa/types'
import { defaultFilamentProfile, defaultPrinterProfile } from '../engine/pa/types'
import {
  FIELD_KINDS,
  importSlicerConfigs,
  orcaPresetKind,
  orcaPresetName,
  tryParseOrcaPreset,
} from '../engine/pa/slicerImport'
import type { ImportedFilamentFields, ImportedPrinterFields } from '../engine/pa/slicerImport'
import { orcaPresetInherits } from '../engine/pa/slicerImportChain'
import type { SlicerFile, UnresolvedParent } from '../engine/pa/slicerImportChain'
import { useSlicerPresets } from '../stores/useSlicerPresets'

export type ImportKind = 'printer' | 'filament'

/** A filament being edited: numbers nullable while the stepper field is cleared. */
export interface EditableFilament {
  id: string
  name: string
  filamentType: string
  filamentDiameterMm: number | null
  nozzleTempC: number | null
  bedTempC: number | null
  chamberTempC: number | null
  extrusionMultiplier: number | null
  maxVolumetricFlowMm3S: number | null
}

export interface ImportSummary {
  kind: ImportKind
  importedCount: number
  /** Names (raw camelCase) of the fields this import actually filled, for the filled-field chips. */
  filled: string[]
  missing: string[]
  warnings: string[]
  wrongKind: string | null
  /** Source file names, for the headline and single-file warning-prefix suppression. */
  fileNames: string[]
  unresolvedParents: UnresolvedParent[]
  /** Inherited base presets that resolved from the remembered cache, shown as a resolved card
   *  with an "upload new version" affordance rather than as a missing-parent warning. */
  resolvedFromCache: { presetName: string }[]
  /** Per-file success cards: which of this kind's fields each uploaded file filled. */
  sources: { fileName: string; filled: string[] }[]
  /** True when the upload contained an OrcaSlicer machine preset, enabling the missing-field
   *  split between "in the base preset" and "machine presets never carry this". */
  orcaMachine: boolean
}

/** Names an import may overwrite with the imported preset's name: the profile/filament defaults a
 *  fresh editor starts with, which the user has not deliberately chosen. */
const PLACEHOLDER_PRINTER_NAME = defaultPrinterProfile().name
const PLACEHOLDER_FILAMENT_NAMES = [defaultFilamentProfile().name, 'New filament']

const WRONG_KIND_MESSAGES: Record<ImportKind, string> = {
  printer: 'This looks like a filament preset. Use the import button on the Filament tab.',
  filament: 'This looks like a printer preset. Use the import button on the Printer tab.',
}

/**
 * All editable state of the printer profile editor: printer fields, the filament list, slicer
 * config import, validation, and dirty tracking. The page component stays purely presentational.
 */
export function useProfileForm() {
  // Numeric fields are nullable while editing (the stepper allows clearing); Save stays disabled
  // until every one holds a number again.
  const id = ref('')
  const name = ref('')
  const firmware = ref<Firmware>('Klipper')
  const bedWidthMm = ref<number | null>(null)
  const bedDepthMm = ref<number | null>(null)
  const nozzleDiameterMm = ref<number | null>(null)
  const travelSpeedMmS = ref<number | null>(null)
  const firstLayerSpeedMmS = ref<number | null>(null)
  const printAccelMmS2 = ref<number | null>(null)
  const squareCornerVelocityMmS = ref<number | null>(null)
  const layerHeightMm = ref<number | null>(null)
  const retractMm = ref<number | null>(null)
  const retractSpeedMmS = ref<number | null>(null)
  const startGcode = ref('')
  const pauseGcode = ref('')
  const endGcode = ref('')

  const filaments = ref<EditableFilament[]>([])
  const filamentIndex = ref(0)
  const currentFilament = computed<EditableFilament | undefined>(
    () => filaments.value[filamentIndex.value],
  )

  const importSummary = ref<ImportSummary | null>(null)

  /** Snapshot of the loaded state, for dirty detection. */
  const loadedSnapshot = ref('')

  function snapshot(): string {
    return JSON.stringify({
      name: name.value,
      firmware: firmware.value,
      bedWidthMm: bedWidthMm.value,
      bedDepthMm: bedDepthMm.value,
      nozzleDiameterMm: nozzleDiameterMm.value,
      travelSpeedMmS: travelSpeedMmS.value,
      firstLayerSpeedMmS: firstLayerSpeedMmS.value,
      printAccelMmS2: printAccelMmS2.value,
      squareCornerVelocityMmS: squareCornerVelocityMmS.value,
      layerHeightMm: layerHeightMm.value,
      retractMm: retractMm.value,
      retractSpeedMmS: retractSpeedMmS.value,
      startGcode: startGcode.value,
      pauseGcode: pauseGcode.value,
      endGcode: endGcode.value,
      filaments: filaments.value,
      filamentIndex: filamentIndex.value,
    })
  }

  const isDirty = computed(() => snapshot() !== loadedSnapshot.value)

  function load(p: PrinterProfile): void {
    id.value = p.id
    name.value = p.name
    firmware.value = p.firmware
    bedWidthMm.value = p.bedWidthMm
    bedDepthMm.value = p.bedDepthMm
    nozzleDiameterMm.value = p.nozzleDiameterMm
    travelSpeedMmS.value = p.travelSpeedMmS
    firstLayerSpeedMmS.value = p.firstLayerSpeedMmS
    printAccelMmS2.value = p.printAccelMmS2
    squareCornerVelocityMmS.value = p.squareCornerVelocityMmS
    layerHeightMm.value = p.layerHeightMm
    retractMm.value = p.retractMm
    retractSpeedMmS.value = p.retractSpeedMmS
    startGcode.value = p.startGcode
    pauseGcode.value = p.pauseGcode
    endGcode.value = p.endGcode
    filaments.value = p.filaments.map((f) => ({ ...f }))
    const selectedAt = p.filaments.findIndex((f) => f.id === p.selectedFilamentId)
    filamentIndex.value = selectedAt === -1 ? 0 : selectedAt
    importSummary.value = null
    loadedSnapshot.value = snapshot()
  }

  // --- Filament list management --------------------------------------------

  const filamentItems = computed(() =>
    filaments.value.map((f, i) => ({ title: f.name.trim() || `Filament ${i + 1}`, value: i })),
  )

  function addFilament(): void {
    // The id is generated here so the editor's own selection can reference the new filament
    // before the store ever sees it.
    filaments.value = [
      ...filaments.value,
      { ...defaultFilamentProfile(), id: crypto.randomUUID(), name: 'New filament' },
    ]
    filamentIndex.value = filaments.value.length - 1
  }

  function removeFilament(): void {
    if (filaments.value.length <= 1) return
    filaments.value = filaments.value.filter((_, i) => i !== filamentIndex.value)
    filamentIndex.value = Math.min(filamentIndex.value, filaments.value.length - 1)
  }

  // --- Slicer config import -------------------------------------------------

  function applyPrinterFields(fields: ImportedPrinterFields): void {
    if (fields.firmware !== undefined) firmware.value = fields.firmware
    if (fields.bedWidthMm !== undefined) bedWidthMm.value = fields.bedWidthMm
    if (fields.bedDepthMm !== undefined) bedDepthMm.value = fields.bedDepthMm
    if (fields.nozzleDiameterMm !== undefined) nozzleDiameterMm.value = fields.nozzleDiameterMm
    if (fields.travelSpeedMmS !== undefined) travelSpeedMmS.value = fields.travelSpeedMmS
    if (fields.printAccelMmS2 !== undefined) printAccelMmS2.value = fields.printAccelMmS2
    if (fields.squareCornerVelocityMmS !== undefined)
      squareCornerVelocityMmS.value = fields.squareCornerVelocityMmS
    if (fields.layerHeightMm !== undefined) layerHeightMm.value = fields.layerHeightMm
    if (fields.retractMm !== undefined) retractMm.value = fields.retractMm
    if (fields.retractSpeedMmS !== undefined) retractSpeedMmS.value = fields.retractSpeedMmS
    if (fields.startGcode !== undefined) startGcode.value = fields.startGcode
    if (fields.pauseGcode !== undefined) pauseGcode.value = fields.pauseGcode
    if (fields.endGcode !== undefined) endGcode.value = fields.endGcode
  }

  function applyFilamentFields(target: EditableFilament, fields: ImportedFilamentFields): void {
    if (fields.filamentType !== undefined) target.filamentType = fields.filamentType
    if (fields.filamentDiameterMm !== undefined)
      target.filamentDiameterMm = fields.filamentDiameterMm
    if (fields.nozzleTempC !== undefined) target.nozzleTempC = fields.nozzleTempC
    if (fields.bedTempC !== undefined) target.bedTempC = fields.bedTempC
    if (fields.chamberTempC !== undefined) target.chamberTempC = fields.chamberTempC
    if (fields.extrusionMultiplier !== undefined)
      target.extrusionMultiplier = fields.extrusionMultiplier
    if (fields.maxVolumetricFlowMm3S !== undefined)
      target.maxVolumetricFlowMm3S = fields.maxVolumetricFlowMm3S
  }

  /** Names the profile after the imported preset, unless the user already chose a name. */
  function applyPresetNameToPrinter(presetName: string | undefined): void {
    if (presetName === undefined) return
    const current = name.value.trim()
    if (current === '' || current === PLACEHOLDER_PRINTER_NAME) name.value = presetName
  }

  /** Names the selected filament after the imported preset, unless the user already chose a name. */
  function applyPresetNameToFilament(target: EditableFilament, presetName: string | undefined): void {
    if (presetName === undefined) return
    const current = target.name.trim()
    if (current === '' || PLACEHOLDER_FILAMENT_NAMES.includes(current)) target.name = presetName
  }

  /** Appends one new filament per named bundle section and selects the first of them. */
  function addBundleFilaments(sections: { name: string; fields: ImportedFilamentFields }[]): void {
    const firstNewIndex = filaments.value.length
    const added = sections.map((section) => {
      const filament: EditableFilament = {
        ...defaultFilamentProfile(),
        id: crypto.randomUUID(),
        name: section.name,
      }
      applyFilamentFields(filament, section.fields)
      return filament
    })
    filaments.value = [...filaments.value, ...added]
    filamentIndex.value = firstNewIndex
  }

  /** Kind of a missing-field name reported by the importer, for kind-scoped summaries. */
  function kindOfMissing(field: string): ImportKind {
    return FIELD_KINDS[field as keyof typeof FIELD_KINDS]
  }

  const presetStore = useSlicerPresets()

  /** The last upload, kept so resolving a missing base preset can re-run the whole import;
   *  readWarnings preserves any file-read failures from the original pick across re-runs. */
  let lastImport: { files: SlicerFile[]; kind: ImportKind; readWarnings: string[] } | null = null

  /** Remembers every uploaded preset that is part of an inherits chain (a parent another upload
   *  inherits from, or a child that inherits something), so later imports resolve from the cache. */
  function cacheChainMembers(uploads: { file: SlicerFile; orca: Record<string, unknown> | null }[]) {
    const inheritedNames = new Set(
      uploads
        .map((u) => (u.orca === null ? undefined : orcaPresetInherits(u.orca)))
        .filter((name): name is string => name !== undefined),
    )
    for (const upload of uploads) {
      if (upload.orca === null) continue
      const name = orcaPresetName(upload.orca)
      if (name === undefined) continue
      const isChainMember =
        orcaPresetInherits(upload.orca) !== undefined || inheritedNames.has(name)
      if (isChainMember) presetStore.add(upload.file.content)
    }
  }

  async function importFiles(files: File[], kind: ImportKind): Promise<void> {
    if (files.length === 0) return
    const warnings: string[] = []
    const slicerFiles: SlicerFile[] = []
    for (const file of files) {
      try {
        slicerFiles.push({ fileName: file.name, content: await file.text() })
      } catch (e) {
        warnings.push(e instanceof Error ? e.message : String(e))
      }
    }
    lastImport = { files: slicerFiles, kind, readWarnings: warnings }
    runImport(slicerFiles, kind, warnings)
  }

  /** Adds a user-picked base preset file to the cache and re-runs the last import so the chain
   *  resolves against it; a file the cache rejects surfaces as a warning on the summary. */
  async function importParentFile(file: File): Promise<void> {
    if (lastImport === null) return
    try {
      presetStore.add(await file.text())
    } catch (e) {
      const summary = importSummary.value
      if (summary !== null) {
        importSummary.value = {
          ...summary,
          warnings: [...summary.warnings, e instanceof Error ? e.message : String(e)],
        }
      }
      return
    }
    runImport(lastImport.files, lastImport.kind, lastImport.readWarnings)
  }

  function runImport(slicerFiles: SlicerFile[], kind: ImportKind, readWarnings: string[]): void {
    const warnings = [...readWarnings]
    const uploads = slicerFiles.map((file) => ({ file, orca: tryParseOrcaPreset(file.content) }))
    cacheChainMembers(uploads)
    const cached = presetStore.presets.map((p) => ({
      fileName: `${p.name}.json`,
      content: p.content,
    }))
    const result = importSlicerConfigs(slicerFiles, cached, presetStore.installPath)
    warnings.push(...result.warnings)
    const orcaMachine = uploads.some(
      (u) => u.orca !== null && orcaPresetKind(u.orca) === 'machine',
    )

    const printerCount = Object.keys(result.fields.printer).length
    const filamentCount = Object.keys(result.fields.filament).length
    const otherKindCount = kind === 'printer' ? filamentCount : printerCount
    const ownKindCount = kind === 'printer' ? printerCount : filamentCount
    const wrongKind =
      ownKindCount === 0 && result.filaments.length === 0 && otherKindCount > 0
        ? WRONG_KIND_MESSAGES[kind]
        : null

    let importedCount = 0
    let filled: string[] = []
    if (wrongKind === null) {
      if (kind === 'printer') {
        applyPrinterFields(result.fields.printer)
        applyPresetNameToPrinter(result.presetName)
        importedCount = printerCount
        filled = Object.keys(result.fields.printer)
      } else if (result.filaments.length > 0) {
        addBundleFilaments(result.filaments)
        // Distinct field names filled across all bundle sections: the summary reports "what kinds
        // of settings did we fill" (matching the filled-field chip list below), not a raw sum
        // across sections, which would double-count a field two filaments both set.
        filled = [...new Set(result.filaments.flatMap((f) => Object.keys(f.fields)))]
        importedCount = filled.length
      } else if (currentFilament.value) {
        applyFilamentFields(currentFilament.value, result.fields.filament)
        applyPresetNameToFilament(currentFilament.value, result.presetName)
        importedCount = filamentCount
        filled = Object.keys(result.fields.filament)
      }
    }
    importSummary.value = {
      kind,
      importedCount,
      filled,
      missing: result.missing.filter((f) => kindOfMissing(f) === kind),
      warnings,
      wrongKind,
      fileNames: slicerFiles.map((f) => f.fileName),
      unresolvedParents: result.unresolvedParents ?? [],
      resolvedFromCache: result.resolvedFromCache ?? [],
      sources: (result.sources ?? []).map((s) => ({
        fileName: s.fileName,
        filled: s.imported.filter((f) => kindOfMissing(f) === kind),
      })),
      orcaMachine,
    }
  }

  // --- Validation and output --------------------------------------------------

  const printerNumbers = computed(() => [
    bedWidthMm.value,
    bedDepthMm.value,
    nozzleDiameterMm.value,
    travelSpeedMmS.value,
    firstLayerSpeedMmS.value,
    printAccelMmS2.value,
    squareCornerVelocityMmS.value,
    layerHeightMm.value,
    retractMm.value,
    retractSpeedMmS.value,
  ])
  const filamentsValid = computed(() =>
    filaments.value.every(
      (f) =>
        f.name.trim() !== '' &&
        [
          f.filamentDiameterMm,
          f.nozzleTempC,
          f.bedTempC,
          f.chamberTempC,
          f.extrusionMultiplier,
          f.maxVolumetricFlowMm3S,
        ].every((n) => n !== null && Number.isFinite(n)),
    ),
  )
  const canSave = computed(
    () =>
      name.value.trim() !== '' &&
      printerNumbers.value.every((n) => n !== null && Number.isFinite(n)) &&
      filaments.value.length > 0 &&
      filamentsValid.value,
  )

  function toFilamentProfile(f: EditableFilament): FilamentProfile {
    return {
      id: f.id,
      name: f.name.trim(),
      filamentType: f.filamentType.trim() || defaultFilamentProfile().filamentType,
      filamentDiameterMm: f.filamentDiameterMm!,
      nozzleTempC: f.nozzleTempC!,
      bedTempC: f.bedTempC!,
      chamberTempC: f.chamberTempC!,
      extrusionMultiplier: f.extrusionMultiplier!,
      maxVolumetricFlowMm3S: f.maxVolumetricFlowMm3S!,
    }
  }

  /** The finished profile. Only valid while `canSave` is true. */
  function toProfile(): PrinterProfile {
    const savedFilaments = filaments.value.map(toFilamentProfile)
    return {
      id: id.value,
      name: name.value.trim(),
      firmware: firmware.value,
      bedWidthMm: bedWidthMm.value!,
      bedDepthMm: bedDepthMm.value!,
      nozzleDiameterMm: nozzleDiameterMm.value!,
      filaments: savedFilaments,
      selectedFilamentId: savedFilaments[filamentIndex.value]?.id || null,
      travelSpeedMmS: travelSpeedMmS.value!,
      firstLayerSpeedMmS: firstLayerSpeedMmS.value!,
      printAccelMmS2: printAccelMmS2.value!,
      squareCornerVelocityMmS: squareCornerVelocityMmS.value!,
      layerHeightMm: layerHeightMm.value!,
      retractMm: retractMm.value!,
      retractSpeedMmS: retractSpeedMmS.value!,
      startGcode: startGcode.value,
      pauseGcode: pauseGcode.value,
      endGcode: endGcode.value,
    }
  }

  function loadNew(): void {
    load(defaultPrinterProfile())
  }

  return {
    name,
    firmware,
    bedWidthMm,
    bedDepthMm,
    nozzleDiameterMm,
    travelSpeedMmS,
    firstLayerSpeedMmS,
    printAccelMmS2,
    squareCornerVelocityMmS,
    layerHeightMm,
    retractMm,
    retractSpeedMmS,
    startGcode,
    pauseGcode,
    endGcode,
    filaments,
    filamentIndex,
    currentFilament,
    filamentItems,
    addFilament,
    removeFilament,
    importSummary,
    importFiles,
    importParentFile,
    isDirty,
    canSave,
    load,
    loadNew,
    toProfile,
  }
}
