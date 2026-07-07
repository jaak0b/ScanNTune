<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { FilamentProfile, Firmware, PrinterProfile } from '../engine/pa/types'
import { defaultFilamentProfile, defaultPrinterProfile } from '../engine/pa/types'
import { FIELD_KINDS, importSlicerConfigs } from '../engine/pa/slicerImport'
import type { ImportedFilamentFields, ImportedPrinterFields } from '../engine/pa/slicerImport'
import NumericField from './NumericField.vue'

const props = defineProps<{
  modelValue: boolean
  /** Profile to edit, or null to create a new one. */
  profile: PrinterProfile | null
}>()
const emit = defineEmits<{
  'update:modelValue': [boolean]
  save: [PrinterProfile]
}>()

const firmwares: Firmware[] = ['Klipper', 'Marlin', 'RepRapFirmware']

// Local editable copy. Numeric fields are nullable while editing (the stepper allows clearing);
// Save stays disabled until every one holds a number again.
const id = ref('')
const name = ref('')
const firmware = ref<Firmware>('Klipper')
const bedWidthMm = ref<number | null>(null)
const bedDepthMm = ref<number | null>(null)
const nozzleDiameterMm = ref<number | null>(null)
const travelSpeedMmS = ref<number | null>(null)
const printAccelMmS2 = ref<number | null>(null)
const squareCornerVelocityMmS = ref<number | null>(null)
const layerHeightMm = ref<number | null>(null)
const retractMm = ref<number | null>(null)
const retractSpeedMmS = ref<number | null>(null)
const startGcode = ref('')
const pauseGcode = ref('')
const endGcode = ref('')

/** A filament being edited: numbers nullable while the stepper field is cleared. */
interface EditableFilament {
  id: string
  name: string
  filamentType: string
  filamentDiameterMm: number | null
  nozzleTempC: number | null
  bedTempC: number | null
  chamberTempC: number | null
}

const filaments = ref<EditableFilament[]>([])
const filamentIndex = ref(0)
const currentFilament = computed<EditableFilament>(() => filaments.value[filamentIndex.value])

function editableFilament(f: FilamentProfile): EditableFilament {
  return { ...f }
}

function loadFrom(p: PrinterProfile): void {
  id.value = p.id
  name.value = p.name
  firmware.value = p.firmware
  bedWidthMm.value = p.bedWidthMm
  bedDepthMm.value = p.bedDepthMm
  nozzleDiameterMm.value = p.nozzleDiameterMm
  travelSpeedMmS.value = p.travelSpeedMmS
  printAccelMmS2.value = p.printAccelMmS2
  squareCornerVelocityMmS.value = p.squareCornerVelocityMmS
  layerHeightMm.value = p.layerHeightMm
  retractMm.value = p.retractMm
  retractSpeedMmS.value = p.retractSpeedMmS
  startGcode.value = p.startGcode
  pauseGcode.value = p.pauseGcode
  endGcode.value = p.endGcode
  filaments.value = p.filaments.map(editableFilament)
  const selectedAt = p.filaments.findIndex((f) => f.id === p.selectedFilamentId)
  filamentIndex.value = selectedAt === -1 ? 0 : selectedAt
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      loadFrom(props.profile ?? defaultPrinterProfile())
      importSummary.value = null
      showImportHelp.value = false
    }
  },
)

// --- Filament list management ----------------------------------------------

const filamentItems = computed(() =>
  filaments.value.map((f, i) => ({ title: f.name.trim() || `Filament ${i + 1}`, value: i })),
)

function addFilament(): void {
  // The id is generated here so the dialog's own selection can reference the new filament
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

// --- Slicer config import ---------------------------------------------------

type ImportKind = 'printer' | 'filament'

const printerFileInput = ref<HTMLInputElement | null>(null)
const filamentFileInput = ref<HTMLInputElement | null>(null)
const importSummary = ref<{
  kind: ImportKind
  importedCount: number
  missing: string[]
  warnings: string[]
  wrongKind: string | null
} | null>(null)
const showImportHelp = ref(false)
const copiedPath = ref('')

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
  if (fields.filamentDiameterMm !== undefined) target.filamentDiameterMm = fields.filamentDiameterMm
  if (fields.nozzleTempC !== undefined) target.nozzleTempC = fields.nozzleTempC
  if (fields.bedTempC !== undefined) target.bedTempC = fields.bedTempC
  if (fields.chamberTempC !== undefined) target.chamberTempC = fields.chamberTempC
}

/** Appends one new filament per named bundle section and selects the first of them. */
function addBundleFilaments(sections: { name: string; fields: ImportedFilamentFields }[]): number {
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
  return added.reduce((count, _f, i) => count + Object.keys(sections[i].fields).length, 0)
}

const WRONG_KIND_MESSAGES: Record<ImportKind, string> = {
  printer: 'This looks like a filament preset. Use the import button in the Filament section.',
  filament: 'This looks like a printer preset. Use the import button in the Printer section.',
}

async function onImportFiles(event: Event, kind: ImportKind): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (files.length === 0) return
  const warnings: string[] = []
  const slicerFiles: { fileName: string; content: string }[] = []
  for (const file of files) {
    try {
      slicerFiles.push({ fileName: file.name, content: await file.text() })
    } catch (e) {
      warnings.push(e instanceof Error ? e.message : String(e))
    }
  }
  const result = importSlicerConfigs(slicerFiles)
  warnings.push(...result.warnings)

  const printerCount = Object.keys(result.fields.printer).length
  const filamentCount = Object.keys(result.fields.filament).length
  const otherKindCount = kind === 'printer' ? filamentCount : printerCount
  const ownKindCount = kind === 'printer' ? printerCount : filamentCount
  const wrongKind =
    ownKindCount === 0 && result.filaments.length === 0 && otherKindCount > 0
      ? WRONG_KIND_MESSAGES[kind]
      : null

  let importedCount = 0
  if (wrongKind === null) {
    if (kind === 'printer') {
      applyPrinterFields(result.fields.printer)
      importedCount = printerCount
    } else if (result.filaments.length > 0) {
      importedCount = addBundleFilaments(result.filaments)
    } else {
      applyFilamentFields(currentFilament.value, result.fields.filament)
      importedCount = filamentCount
    }
  }
  importSummary.value = {
    kind,
    importedCount,
    missing: result.missing.filter((f) => kindOfMissing(f) === kind),
    warnings,
    wrongKind,
  }
}

/** Kind of a missing-field name reported by the importer, for kind-scoped summaries. */
function kindOfMissing(field: string): ImportKind {
  return FIELD_KINDS[field as keyof typeof FIELD_KINDS]
}

/**
 * Path hint embedded in an unresolved-inherits warning, if any. Returns null when the vendor
 * folder is unknown (the literal "<vendor>" placeholder): that text is guidance, not a real path,
 * so it is shown as plain text rather than offered behind a misleading copy button.
 */
function parentPathHint(warning: string): string | null {
  const match = warning.match(/(resources\\profiles\\[^\s]+)$/)
  if (match === null || match[1].includes('<vendor>')) return null
  return match[1]
}

type Os = 'Windows' | 'macOS' | 'Linux'
type Slicer = 'PrusaSlicer' | 'OrcaSlicer'

function detectOs(): Os {
  const ua = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`.toLowerCase()
  if (ua.includes('mac')) return 'macOS'
  if (ua.includes('linux') && !ua.includes('android')) return 'Linux'
  return 'Windows'
}

const helpOs = ref<Os>(detectOs())
const helpSlicer = ref<Slicer>('PrusaSlicer')

const prusaPresetPaths: Record<Os, string> = {
  Windows: '%APPDATA%\\PrusaSlicer\\printer\\',
  macOS: '~/Library/Application Support/PrusaSlicer/printer/',
  Linux: '~/.config/PrusaSlicer/printer/',
}
const orcaMachinePaths: Record<Os, string> = {
  Windows: '%APPDATA%\\OrcaSlicer\\user\\default\\machine\\',
  macOS: '~/Library/Application Support/OrcaSlicer/user/default/machine/',
  Linux: '~/.config/OrcaSlicer/user/default/machine/',
}
const orcaFilamentPaths: Record<Os, string> = {
  Windows: '%APPDATA%\\OrcaSlicer\\user\\default\\filament\\',
  macOS: '~/Library/Application Support/OrcaSlicer/user/default/filament/',
  Linux: '~/.config/OrcaSlicer/user/default/filament/',
}

async function copyPath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path)
    copiedPath.value = path
  } catch (e) {
    console.error('Clipboard copy failed', e)
  }
}

const printerNumbers = computed(() => [
  bedWidthMm.value,
  bedDepthMm.value,
  nozzleDiameterMm.value,
  travelSpeedMmS.value,
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
      [f.filamentDiameterMm, f.nozzleTempC, f.bedTempC, f.chamberTempC].every(
        (n) => n !== null && Number.isFinite(n),
      ),
  ),
)
const canSave = computed(
  () =>
    name.value.trim() !== '' &&
    printerNumbers.value.every((n) => n !== null && Number.isFinite(n)) &&
    filaments.value.length > 0 &&
    filamentsValid.value,
)

function close(): void {
  emit('update:modelValue', false)
}

function toFilamentProfile(f: EditableFilament): FilamentProfile {
  return {
    id: f.id,
    name: f.name.trim(),
    filamentType: f.filamentType.trim() || defaultFilamentProfile().filamentType,
    filamentDiameterMm: f.filamentDiameterMm!,
    nozzleTempC: f.nozzleTempC!,
    bedTempC: f.bedTempC!,
    chamberTempC: f.chamberTempC!,
  }
}

function save(): void {
  if (!canSave.value) return
  const savedFilaments = filaments.value.map(toFilamentProfile)
  emit('save', {
    id: id.value,
    name: name.value.trim(),
    firmware: firmware.value,
    bedWidthMm: bedWidthMm.value!,
    bedDepthMm: bedDepthMm.value!,
    nozzleDiameterMm: nozzleDiameterMm.value!,
    filaments: savedFilaments,
    selectedFilamentId: savedFilaments[filamentIndex.value]?.id || null,
    travelSpeedMmS: travelSpeedMmS.value!,
    printAccelMmS2: printAccelMmS2.value!,
    squareCornerVelocityMmS: squareCornerVelocityMmS.value!,
    layerHeightMm: layerHeightMm.value!,
    retractMm: retractMm.value!,
    retractSpeedMmS: retractSpeedMmS.value!,
    startGcode: startGcode.value,
    pauseGcode: pauseGcode.value,
    endGcode: endGcode.value,
  })
  close()
}
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    max-width="640"
    scrollable
    @update:model-value="emit('update:modelValue', $event)"
  >
    <v-card :title="profile ? 'Edit printer profile' : 'New printer profile'">
      <v-card-text>
        <div class="mb-3">
          <v-btn variant="text" size="small" @click="showImportHelp = !showImportHelp">
            Where is my config?
          </v-btn>
          <div v-if="showImportHelp" class="import-help mt-2">
            <div class="d-flex ga-2 mb-2">
              <v-btn-toggle v-model="helpOs" density="compact" color="primary" mandatory divided>
                <v-btn value="Windows" size="small">Windows</v-btn>
                <v-btn value="macOS" size="small">macOS</v-btn>
                <v-btn value="Linux" size="small">Linux</v-btn>
              </v-btn-toggle>
              <v-btn-toggle v-model="helpSlicer" density="compact" color="primary" mandatory divided>
                <v-btn value="PrusaSlicer" size="small">PrusaSlicer</v-btn>
                <v-btn value="OrcaSlicer" size="small">OrcaSlicer</v-btn>
              </v-btn-toggle>
            </div>
            <div v-if="helpSlicer === 'PrusaSlicer'">
              <p class="mb-1">Easiest: File, Export, Export Config. Or pick a preset from:</p>
              <div class="d-flex align-center ga-1">
                <code class="copy-path">{{ prusaPresetPaths[helpOs] }}</code>
                <v-btn
                  icon="mdi-content-copy"
                  size="x-small"
                  variant="text"
                  :title="'Copy'"
                  @click="copyPath(prusaPresetPaths[helpOs])"
                />
                <span v-if="copiedPath === prusaPresetPaths[helpOs]" class="text-success">copied</span>
              </div>
            </div>
            <div v-else>
              <p class="mb-1">
                Import the machine .json in the Printer section and a filament .json in the
                Filament section.
              </p>
              <div class="d-flex align-center ga-1">
                <code class="copy-path">{{ orcaMachinePaths[helpOs] }}</code>
                <v-btn
                  icon="mdi-content-copy"
                  size="x-small"
                  variant="text"
                  :title="'Copy'"
                  @click="copyPath(orcaMachinePaths[helpOs])"
                />
                <span v-if="copiedPath === orcaMachinePaths[helpOs]" class="text-success">copied</span>
              </div>
              <div class="d-flex align-center ga-1 mt-1">
                <code class="copy-path">{{ orcaFilamentPaths[helpOs] }}</code>
                <v-btn
                  icon="mdi-content-copy"
                  size="x-small"
                  variant="text"
                  :title="'Copy'"
                  @click="copyPath(orcaFilamentPaths[helpOs])"
                />
                <span v-if="copiedPath === orcaFilamentPaths[helpOs]" class="text-success">copied</span>
              </div>
            </div>
          </div>
          <div v-if="importSummary" class="mt-2" data-testid="import-summary">
            <v-alert
              v-if="importSummary.wrongKind"
              type="warning"
              density="compact"
              variant="tonal"
              class="mb-1 text-body-2"
              :text="importSummary.wrongKind"
              data-testid="import-wrong-kind"
            />
            <div v-else class="text-body-2">
              Filled {{ importSummary.importedCount }}
              {{ importSummary.importedCount === 1 ? 'field' : 'fields' }} from the imported
              config.
            </div>
            <div
              v-if="!importSummary.wrongKind && importSummary.missing.length > 0"
              class="text-caption text-medium-emphasis"
            >
              Not in the file (kept as-is): {{ importSummary.missing.join(', ') }}
            </div>
            <v-alert
              v-for="(warning, i) in importSummary.warnings"
              :key="i"
              type="warning"
              density="compact"
              variant="tonal"
              class="mt-1 text-body-2"
            >
              <div>{{ warning }}</div>
              <div v-if="parentPathHint(warning)" class="d-flex align-center ga-1 mt-1">
                <code class="copy-path">{{ parentPathHint(warning) }}</code>
                <v-btn
                  icon="mdi-content-copy"
                  size="x-small"
                  variant="text"
                  :title="'Copy'"
                  @click="copyPath(parentPathHint(warning)!)"
                />
                <span v-if="copiedPath === parentPathHint(warning)" class="text-success">copied</span>
              </div>
            </v-alert>
          </div>
        </div>

        <v-card variant="outlined" class="section mb-4">
          <v-card-item>
            <v-card-subtitle>Printer</v-card-subtitle>
          </v-card-item>
          <v-card-text>
            <div class="mb-3">
              <input
                ref="printerFileInput"
                type="file"
                accept=".ini,.json,.cfg,.txt"
                multiple
                class="d-none"
                data-testid="import-printer-input"
                @change="onImportFiles($event, 'printer')"
              />
              <v-btn
                variant="tonal"
                size="small"
                prepend-icon="mdi-import"
                data-testid="import-printer"
                @click="printerFileInput?.click()"
              >
                Import printer settings
              </v-btn>
            </div>
            <div class="fields mb-2">
              <v-text-field
                v-model="name"
                label="Profile name"
                density="comfortable"
                data-testid="profile-name"
                class="wide"
              />
              <v-select
                v-model="firmware"
                :items="firmwares"
                label="Firmware"
                density="comfortable"
                data-testid="profile-firmware"
              />
            </div>
            <div class="fields mb-2">
              <NumericField v-model="bedWidthMm" label="Bed width (mm)" :step="10" :min="10" />
              <NumericField v-model="bedDepthMm" label="Bed depth (mm)" :step="10" :min="10" />
              <NumericField
                v-model="nozzleDiameterMm"
                label="Nozzle diameter (mm)"
                :step="0.1"
                :min="0.1"
                :precision="2"
              />
              <NumericField
                v-model="layerHeightMm"
                label="Layer height (mm)"
                :step="0.05"
                :min="0.05"
                :precision="2"
              />
            </div>
            <div class="fields mb-2">
              <NumericField
                v-model="retractMm"
                label="Retraction (mm)"
                :step="0.1"
                :min="0"
                :precision="2"
              />
              <NumericField
                v-model="retractSpeedMmS"
                label="Retract speed (mm/s)"
                :step="5"
                :min="1"
              />
              <NumericField
                v-model="travelSpeedMmS"
                label="Travel speed (mm/s)"
                :step="10"
                :min="10"
              />
            </div>
            <div class="fields mb-2">
              <NumericField
                v-model="printAccelMmS2"
                label="Acceleration (mm/s2)"
                :step="500"
                :min="100"
              />
              <NumericField
                v-model="squareCornerVelocityMmS"
                label="Square corner velocity (mm/s)"
                :step="1"
                :min="1"
              />
            </div>
            <v-textarea
              v-model="startGcode"
              label="Start G-code"
              rows="3"
              density="comfortable"
              class="mono mb-2"
            />
            <v-textarea
              v-model="pauseGcode"
              label="Pause G-code (filament change)"
              rows="2"
              density="comfortable"
              class="mono mb-2"
            />
            <v-textarea
              v-model="endGcode"
              label="End G-code"
              rows="3"
              density="comfortable"
              class="mono"
            />
          </v-card-text>
        </v-card>

        <v-card variant="outlined" class="section">
          <v-card-item>
            <v-card-subtitle>Filament</v-card-subtitle>
          </v-card-item>
          <v-card-text>
            <div class="filament-row mb-3">
              <v-select
                v-model="filamentIndex"
                :items="filamentItems"
                label="Filament"
                density="comfortable"
                hide-details
                class="filament-select"
                data-testid="filament-select"
              />
              <v-btn
                variant="tonal"
                size="small"
                prepend-icon="mdi-plus"
                data-testid="filament-add"
                @click="addFilament"
              >
                Add
              </v-btn>
              <v-btn
                variant="text"
                size="small"
                icon="mdi-delete-outline"
                :disabled="filaments.length <= 1"
                data-testid="filament-delete"
                @click="removeFilament"
              />
            </div>
            <div class="mb-3">
              <input
                ref="filamentFileInput"
                type="file"
                accept=".ini,.json,.cfg,.txt"
                multiple
                class="d-none"
                data-testid="import-filament-input"
                @change="onImportFiles($event, 'filament')"
              />
              <v-btn
                variant="tonal"
                size="small"
                prepend-icon="mdi-import"
                data-testid="import-filament"
                @click="filamentFileInput?.click()"
              >
                Import filament
              </v-btn>
            </div>
            <template v-if="currentFilament">
              <div class="fields mb-2">
                <v-text-field
                  v-model="currentFilament.name"
                  label="Filament name"
                  density="comfortable"
                  data-testid="filament-name"
                  class="wide"
                />
                <v-text-field
                  v-model="currentFilament.filamentType"
                  label="Filament type"
                  density="comfortable"
                  data-testid="profile-filament-type"
                />
              </div>
              <div class="fields mb-2">
                <NumericField
                  v-model="currentFilament.filamentDiameterMm"
                  label="Filament diameter (mm)"
                  :step="0.05"
                  :min="0.5"
                  :precision="2"
                />
                <NumericField
                  v-model="currentFilament.nozzleTempC"
                  label="Nozzle temp (°C)"
                  :step="5"
                  :min="0"
                />
                <NumericField
                  v-model="currentFilament.bedTempC"
                  label="Bed temp (°C)"
                  :step="5"
                  :min="0"
                />
                <NumericField
                  v-model="currentFilament.chamberTempC"
                  label="Chamber temp (°C)"
                  :step="5"
                  :min="0"
                />
              </div>
            </template>
          </v-card-text>
        </v-card>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="close">Cancel</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :disabled="!canSave"
          data-testid="profile-save"
          @click="save"
        >
          Save
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.section {
  border-radius: 12px;
}
.fields {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.fields > * {
  flex: 1 1 140px;
}
.fields > .wide {
  flex: 2 1 220px;
}
.filament-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.filament-select {
  flex: 1 1 200px;
}
.import-help {
  font-size: 0.8rem;
  line-height: 1.5;
}
.copy-path {
  font-family: 'Roboto Mono', ui-monospace, monospace;
  user-select: all;
  background: rgba(128, 128, 128, 0.15);
  border-radius: 4px;
  padding: 0 4px;
}
.mono :deep(textarea) {
  font-family: 'Roboto Mono', ui-monospace, monospace;
  font-size: 0.85rem;
}
</style>
