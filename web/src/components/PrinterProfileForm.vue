<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Firmware, PrinterProfile } from '../engine/pa/types'
import { defaultPrinterProfile } from '../engine/pa/types'
import { importSlicerConfig } from '../engine/pa/slicerImport'
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
const filamentDiameterMm = ref<number | null>(null)
const nozzleTempC = ref<number | null>(null)
const bedTempC = ref<number | null>(null)
const chamberTempC = ref<number | null>(null)
const filamentType = ref('')
const travelSpeedMmS = ref<number | null>(null)
const printAccelMmS2 = ref<number | null>(null)
const squareCornerVelocityMmS = ref<number | null>(null)
const layerHeightMm = ref<number | null>(null)
const retractMm = ref<number | null>(null)
const retractSpeedMmS = ref<number | null>(null)
const startGcode = ref('')
const pauseGcode = ref('')
const endGcode = ref('')

function loadFrom(p: PrinterProfile): void {
  id.value = p.id
  name.value = p.name
  firmware.value = p.firmware
  bedWidthMm.value = p.bedWidthMm
  bedDepthMm.value = p.bedDepthMm
  nozzleDiameterMm.value = p.nozzleDiameterMm
  filamentDiameterMm.value = p.filamentDiameterMm
  nozzleTempC.value = p.nozzleTempC
  bedTempC.value = p.bedTempC
  chamberTempC.value = p.chamberTempC
  filamentType.value = p.filamentType
  travelSpeedMmS.value = p.travelSpeedMmS
  printAccelMmS2.value = p.printAccelMmS2
  squareCornerVelocityMmS.value = p.squareCornerVelocityMmS
  layerHeightMm.value = p.layerHeightMm
  retractMm.value = p.retractMm
  retractSpeedMmS.value = p.retractSpeedMmS
  startGcode.value = p.startGcode
  pauseGcode.value = p.pauseGcode
  endGcode.value = p.endGcode
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

// --- Slicer config import -------------------------------------------------

const fileInput = ref<HTMLInputElement | null>(null)
const importSummary = ref<{
  importedCount: number
  missing: string[]
  warnings: string[]
} | null>(null)
const showImportHelp = ref(false)
const copiedPath = ref('')

function applyImported(fields: Partial<PrinterProfile>): void {
  if (fields.firmware !== undefined) firmware.value = fields.firmware
  if (fields.bedWidthMm !== undefined) bedWidthMm.value = fields.bedWidthMm
  if (fields.bedDepthMm !== undefined) bedDepthMm.value = fields.bedDepthMm
  if (fields.nozzleDiameterMm !== undefined) nozzleDiameterMm.value = fields.nozzleDiameterMm
  if (fields.filamentDiameterMm !== undefined) filamentDiameterMm.value = fields.filamentDiameterMm
  if (fields.nozzleTempC !== undefined) nozzleTempC.value = fields.nozzleTempC
  if (fields.bedTempC !== undefined) bedTempC.value = fields.bedTempC
  if (fields.chamberTempC !== undefined) chamberTempC.value = fields.chamberTempC
  if (fields.filamentType !== undefined) filamentType.value = fields.filamentType
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

async function onImportFiles(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (files.length === 0) return
  const importedFields = new Set<string>()
  let missing: string[] = []
  const warnings: string[] = []
  for (const file of files) {
    try {
      const result = importSlicerConfig(file.name, await file.text())
      applyImported(result.fields)
      for (const f of result.imported) importedFields.add(f)
      // The missing list reflects the last file plus anything an earlier file already filled.
      missing = result.missing.filter((f) => !importedFields.has(f))
      warnings.push(...result.warnings.map((w) => `${file.name}: ${w}`))
    } catch (e) {
      warnings.push(e instanceof Error ? e.message : String(e))
    }
  }
  importSummary.value = { importedCount: importedFields.size, missing, warnings }
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

const numbers = computed(() => [
  bedWidthMm.value,
  bedDepthMm.value,
  nozzleDiameterMm.value,
  filamentDiameterMm.value,
  nozzleTempC.value,
  bedTempC.value,
  chamberTempC.value,
  travelSpeedMmS.value,
  printAccelMmS2.value,
  squareCornerVelocityMmS.value,
  layerHeightMm.value,
  retractMm.value,
  retractSpeedMmS.value,
])
const canSave = computed(
  () => name.value.trim() !== '' && numbers.value.every((n) => n !== null && Number.isFinite(n)),
)

function close(): void {
  emit('update:modelValue', false)
}

function save(): void {
  if (!canSave.value) return
  emit('save', {
    id: id.value,
    name: name.value.trim(),
    firmware: firmware.value,
    bedWidthMm: bedWidthMm.value!,
    bedDepthMm: bedDepthMm.value!,
    nozzleDiameterMm: nozzleDiameterMm.value!,
    filamentDiameterMm: filamentDiameterMm.value!,
    nozzleTempC: nozzleTempC.value!,
    bedTempC: bedTempC.value!,
    chamberTempC: chamberTempC.value!,
    filamentType: filamentType.value.trim() || defaultPrinterProfile().filamentType,
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
          <input
            ref="fileInput"
            type="file"
            accept=".ini,.json,.cfg,.txt"
            multiple
            class="d-none"
            data-testid="import-file-input"
            @change="onImportFiles"
          />
          <v-btn
            variant="tonal"
            size="small"
            prepend-icon="mdi-import"
            data-testid="import-slicer"
            @click="fileInput?.click()"
          >
            Import from slicer
          </v-btn>
          <v-btn
            variant="text"
            size="small"
            class="ml-2"
            @click="showImportHelp = !showImportHelp"
          >
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
                Import the machine .json first, then optionally a filament .json.
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
            <div class="text-body-2">
              Filled {{ importSummary.importedCount }}
              {{ importSummary.importedCount === 1 ? 'field' : 'fields' }} from the imported
              config.
            </div>
            <div
              v-if="importSummary.missing.length > 0"
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
              {{ warning }}
            </v-alert>
          </div>
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
          <NumericField v-model="nozzleTempC" label="Nozzle temp (°C)" :step="5" :min="0" />
          <NumericField v-model="bedTempC" label="Bed temp (°C)" :step="5" :min="0" />
        </div>
        <div class="fields mb-2">
          <NumericField v-model="chamberTempC" label="Chamber temp (°C)" :step="5" :min="0" />
          <v-text-field
            v-model="filamentType"
            label="Filament type"
            density="comfortable"
            data-testid="profile-filament-type"
          />
        </div>
        <div class="fields mb-2">
          <NumericField
            v-model="nozzleDiameterMm"
            label="Nozzle diameter (mm)"
            :step="0.1"
            :min="0.1"
            :precision="2"
          />
          <NumericField
            v-model="filamentDiameterMm"
            label="Filament diameter (mm)"
            :step="0.05"
            :min="0.5"
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
        <v-textarea v-model="endGcode" label="End G-code" rows="3" density="comfortable" class="mono" />
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
