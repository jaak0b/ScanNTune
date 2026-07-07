<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { usePrinterProfiles } from '../stores/usePrinterProfiles'
import { readBytes } from '../util/preview'
import { analyzePaScan } from '../workerClient'
import type { PaProcessing } from '../workerClient'
import { generatePaGcodeWithReport, estimatePaPrintSeconds } from '../engine/pa/gcodeGenerator'
import { paCorrection } from '../engine/pa/paCorrectionFormatter'
import {
  couponGeometry,
  defaultPaTestSpec,
  defaultPrinterProfile,
  edgeShiftRange,
  fitsA4,
  maxLineCountForHeight,
} from '../engine/pa/types'
import type { PaTestSpec, PrinterProfile } from '../engine/pa/types'
import NumericField from './NumericField.vue'
import PrinterProfileForm from './PrinterProfileForm.vue'
import OverlayCanvas from './OverlayCanvas.vue'
import CodeBlock from './CodeBlock.vue'
import MetricTile from './MetricTile.vue'

const store = usePrinterProfiles()

// Profile card state.
const formOpen = ref(false)
const editing = ref<PrinterProfile | null>(null)
const deleteOpen = ref(false)

const NEW_ID = '__new__'
const selectItems = computed(() => [
  ...store.profiles.map((p) => ({ title: p.name, value: p.id })),
  { title: 'New printer...', value: NEW_ID },
])
function onSelect(id: string | null): void {
  if (id === NEW_ID) {
    openNew()
    return
  }
  if (id) store.select(id)
}
function openNew(): void {
  editing.value = null
  formOpen.value = true
}
function openEdit(): void {
  editing.value = store.selected
  formOpen.value = true
}
function onSave(profile: PrinterProfile): void {
  const id = store.upsert(profile)
  store.select(id)
}
function confirmDelete(): void {
  if (store.selected) store.remove(store.selected.id)
  deleteOpen.value = false
}

const filamentItems = computed(() =>
  (store.selected?.filaments ?? []).map((f) => ({ title: f.name, value: f.id })),
)
function onSelectFilament(filamentId: string | null): void {
  if (store.selected && filamentId) store.selectFilament(store.selected.id, filamentId)
}

const summaryChips = computed(() => {
  const p = store.selected
  const f = store.selectedFilament
  if (!p || !f) return []
  const chips = [
    `${p.firmware} · ${p.nozzleDiameterMm} mm nozzle`,
    `${p.bedWidthMm} × ${p.bedDepthMm} mm bed`,
    `${f.filamentType} · ${f.nozzleTempC} °C / ${f.bedTempC} °C`,
  ]
  const d = defaultPrinterProfile()
  if (p.startGcode !== d.startGcode || p.pauseGcode !== d.pauseGcode || p.endGcode !== d.endGcode) {
    chips.push('custom start/pause/end G-code')
  }
  return chips
})

// Test range card state.
const specDefaults = defaultPaTestSpec()
const paStart = ref<number | null>(specDefaults.paStart)
const paEnd = ref<number | null>(specDefaults.paEnd)
const lineCount = ref<number | null>(specDefaults.lineCount)
const slowSpeed = ref<number | null>(specDefaults.slowSpeedMmS)
const fastSpeed = ref<number | null>(specDefaults.fastSpeedMmS)

const spec = computed<PaTestSpec>(() => ({
  ...defaultPaTestSpec(),
  paStart: paStart.value ?? specDefaults.paStart,
  paEnd: paEnd.value ?? specDefaults.paEnd,
  lineCount: lineCount.value ?? specDefaults.lineCount,
  slowSpeedMmS: slowSpeed.value ?? specDefaults.slowSpeedMmS,
  fastSpeedMmS: fastSpeed.value ?? specDefaults.fastSpeedMmS,
}))
const stepPerLine = computed(() =>
  ((spec.value.paEnd - spec.value.paStart) / (spec.value.lineCount - 1)).toFixed(4),
)

const A4_LONG_MM = 297

const geometry = computed(() => couponGeometry(spec.value))
const footprintText = computed(() => {
  const g = geometry.value
  return `coupon ${Math.round(g.baseWidthMm)} x ${Math.round(g.baseHeightMm)} mm`
})
const exceedsA4 = computed(() => {
  const g = geometry.value
  return !fitsA4(g.baseWidthMm, g.baseHeightMm)
})
const maxLinesForA4 = computed(() => maxLineCountForHeight(spec.value, A4_LONG_MM))

const generateError = ref('')
const unknownVariables = ref<string[]>([])
const canGenerate = computed(() => store.selected !== null && store.selectedFilament !== null)

function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'printer'
}
const filename = computed(() =>
  store.selected ? `pa_test_${sanitizeName(store.selected.name)}.gcode` : '',
)

// Rough print time from the generator's own estimator. Labelled with "~" because it ignores
// acceleration.
const printTimeText = computed(() => {
  const p = store.selected
  if (!p) return ''
  const minutes = Math.max(1, Math.round(estimatePaPrintSeconds(p, spec.value) / 60))
  return `~${minutes} min`
})

function generate(): void {
  const profile = store.selected
  const filament = store.selectedFilament
  if (!profile || !filament) return
  generateError.value = ''
  unknownVariables.value = []
  let gcode: string
  try {
    const report = generatePaGcodeWithReport(profile, filament, spec.value)
    gcode = report.gcode
    unknownVariables.value = report.unknownVariables
  } catch (e) {
    generateError.value = e instanceof Error ? e.message : String(e)
    console.error('G-code generation failed', e)
    return
  }
  const blob = new Blob([gcode], { type: 'text/x-gcode' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.value
  a.click()
  URL.revokeObjectURL(url)
}

// Scan card state.
const analyzing = ref(false)
const scanError = ref('')
const processing = shallowRef<PaProcessing | null>(null)
// The spec the current `processing` result was actually analyzed against, so the result card
// stays consistent even if the form fields below change afterwards.
const analyzedSpec = shallowRef<PaTestSpec | null>(null)

function resetProcessing(): void {
  processing.value?.overlay.close()
  processing.value = null
  analyzedSpec.value = null
}

async function onPick(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  // Clear the input so picking the same file again still fires change.
  input.value = ''
  if (!file) return
  analyzing.value = true
  scanError.value = ''
  resetProcessing()
  try {
    const bytes = await readBytes(file)
    const usedSpec = spec.value
    processing.value = await analyzePaScan(bytes, usedSpec)
    analyzedSpec.value = usedSpec
  } catch (err) {
    console.error('PA scan analysis failed', err)
    scanError.value = err instanceof Error ? err.message : String(err)
  } finally {
    analyzing.value = false
  }
}

// Result card state. Derived exclusively from analyzedSpec, the snapshot of the spec used for
// this analysis, never the live form state above.
const result = computed(() => processing.value?.result ?? null)
const linesReadable = computed(() =>
  result.value ? result.value.lines.filter((l) => l.measured).length : 0,
)
const correction = computed(() => {
  const r = result.value
  if (!r || !r.success || r.bestPa === null) return null
  return paCorrection(store.selected?.firmware ?? 'Klipper', r.bestPa)
})

const edgeShift = computed<{ start: number; end: number } | null>(() => {
  const r = result.value
  const s = analyzedSpec.value
  if (!r || !r.success || !s) return null
  return edgeShiftRange(s, r.bestLineIndex)
})
function applyShift(): void {
  if (!edgeShift.value) return
  paStart.value = Number(edgeShift.value.start.toFixed(4))
  paEnd.value = Number(edgeShift.value.end.toFixed(4))
  resetProcessing()
}
</script>

<template>
  <v-container class="page">
    <header class="mb-4">
      <h1 class="text-h5 font-weight-bold">Pressure advance calibration</h1>
      <p class="text-body-2 text-medium-emphasis mt-1">
        Print a two-color test coupon, scan it, and the app reads which line has the most even width
        and gives you the pressure advance value to set.
      </p>
    </header>

    <!-- 1. Printer profile -->
    <section class="step mb-3">
      <div class="step-head mb-2">
        <span class="num">1</span><span class="step-title">Printer profile</span>
      </div>
      <div class="profile-row">
        <v-select
          :model-value="store.selectedId"
          :items="selectItems"
          label="Printer"
          density="comfortable"
          hide-details
          placeholder="Choose or create a printer"
          class="profile-select"
          data-testid="profile-select"
          @update:model-value="onSelect"
        />
        <v-select
          v-if="store.selected"
          :model-value="store.selectedFilament?.id ?? null"
          :items="filamentItems"
          label="Filament"
          density="comfortable"
          hide-details
          class="filament-select"
          data-testid="pa-filament-select"
          @update:model-value="onSelectFilament"
        />
        <v-btn
          variant="tonal"
          size="small"
          :disabled="!store.selected"
          data-testid="profile-edit"
          @click="openEdit"
        >
          Edit
        </v-btn>
        <v-btn
          variant="text"
          size="small"
          :disabled="!store.selected"
          data-testid="profile-delete"
          @click="deleteOpen = true"
        >
          Delete
        </v-btn>
      </div>
      <div v-if="!store.profiles.length" class="mt-3">
        <v-btn color="primary" size="small" prepend-icon="mdi-plus" data-testid="profile-new" @click="openNew">
          New printer profile
        </v-btn>
      </div>
      <div v-if="summaryChips.length" class="chips mt-3">
        <v-chip v-for="c in summaryChips" :key="c" size="small" variant="tonal">{{ c }}</v-chip>
      </div>
    </section>

    <!-- 2. Test range -->
    <section class="step mb-3">
      <div class="step-head mb-2">
        <span class="num">2</span><span class="step-title">Test range</span>
      </div>
      <div class="fields">
        <NumericField v-model="paStart" label="PA start" :step="0.01" :min="0" :precision="4" />
        <NumericField v-model="paEnd" label="PA end" :step="0.01" :min="0" :precision="4" />
        <NumericField v-model="lineCount" label="Lines" :step="1" :min="4" />
      </div>
      <div class="fields mt-3">
        <NumericField v-model="slowSpeed" label="Slow speed (mm/s)" :step="5" :min="1" />
        <NumericField v-model="fastSpeed" label="Fast speed (mm/s)" :step="5" :min="1" />
      </div>
      <p class="tip">
        The speed contrast creates the measurable transitions. Keep fast at least 3x slow.
      </p>
      <p class="tip">Step {{ stepPerLine }} per line, {{ footprintText }}.</p>
      <p class="tip" data-testid="pa-lines-hint">
        16 to 24 lines is plenty. The result is interpolated between lines, and the app suggests a
        narrower follow-up range for extra precision. Up to {{ maxLinesForA4 }} lines stays within an
        A4 scanner bed.
      </p>
      <v-alert
        v-if="exceedsA4"
        type="warning"
        variant="tonal"
        class="mt-3"
        data-testid="pa-a4-warning"
        text="The coupon is larger than A4. Most flatbed scanners cannot scan it in one pass. Reduce the line count unless your scanner is larger."
      />
      <div class="gen-row mt-2">
        <v-btn
          color="primary"
          prepend-icon="mdi-download"
          :disabled="!canGenerate"
          data-testid="generate-btn"
          @click="generate"
        >
          Generate G-code
        </v-btn>
        <span v-if="filename" class="tip mt-0">{{ filename }} · {{ printTimeText }}</span>
        <span v-else class="tip mt-0">Choose a printer profile first.</span>
      </div>
      <v-alert
        v-if="generateError"
        type="error"
        variant="tonal"
        class="mt-3"
        :text="generateError"
        data-testid="generate-error"
      />
      <v-alert
        v-if="unknownVariables.length > 0"
        type="warning"
        variant="tonal"
        class="mt-3"
        :text="`Unknown slicer variables left as-is: ${unknownVariables.join(', ')}. Replace them with real values if your firmware does not resolve them.`"
        data-testid="unknown-variables-warning"
      />
      <div class="warn-box mt-3">
        <v-icon color="warning" size="16" class="warn-icon">mdi-alert-outline</v-icon>
        <span>
          <strong class="warn-lead">Use two filaments with clearly different brightness.</strong>
          Any colors work; the pause is where you swap to the second filament for the test lines.
        </span>
      </div>
    </section>

    <!-- 3. Scan the print -->
    <section class="step mb-3">
      <div class="step-head mb-1">
        <span class="num">3</span><span class="step-title">Scan the print</span>
      </div>
      <p class="tip mb-3">
        Scan the finished coupon face-down on a flatbed scanner and drop the image in.
      </p>
      <label class="dropzone">
        <input
          type="file"
          accept="image/*"
          class="file-input"
          data-testid="pa-scan-input"
          @change="onPick"
        />
        <v-icon size="28" color="primary">mdi-image-plus</v-icon>
        <span class="dz-label">Choose the scan image</span>
        <span class="dz-sub">or drop it here</span>
      </label>
      <div v-if="analyzing" class="d-flex align-center ga-2 mt-3">
        <v-progress-circular indeterminate size="20" width="2" color="primary" />
        <span class="tip mt-0">Analyzing the scan...</span>
      </div>
      <v-alert
        v-if="scanError"
        type="error"
        variant="tonal"
        class="mt-3"
        :text="scanError"
        data-testid="scan-error"
      />
    </section>

    <!-- 4. Result -->
    <section v-if="result" class="step">
      <div class="step-head mb-3">
        <span class="num">4</span><span class="step-title">Result</span>
      </div>

      <template v-if="result.success">
        <div class="tiles mb-3">
          <MetricTile
            label="Best pressure advance"
            :value="result.bestPa!.toFixed(4)"
            testid="pa-best"
          />
          <MetricTile
            label="Best line"
            :value="`${result.bestLineIndex! + 1} of ${analyzedSpec!.lineCount}`"
            testid="pa-best-line"
          />
          <MetricTile
            label="Lines readable"
            :value="`${linesReadable} / ${analyzedSpec!.lineCount}`"
            testid="pa-lines-readable"
          />
        </div>

        <div v-if="edgeShift" class="warn-box mb-3" data-testid="pa-edge-warning">
          <v-icon color="warning" size="16" class="warn-icon">mdi-alert-outline</v-icon>
          <span>
            <strong class="warn-lead">The optimum sits at the edge of the sweep,</strong>
            so the true value may lie outside the tested range. Rerun with a shifted range:
            {{ edgeShift.start.toFixed(4) }} to {{ edgeShift.end.toFixed(4) }}.
            <v-btn size="x-small" variant="tonal" color="warning" class="ml-1" @click="applyShift">
              Use shifted range
            </v-btn>
          </span>
        </div>

        <template v-if="correction">
          <CodeBlock :code="correction.code" data-testid="pa-code" />
          <CodeBlock
            v-if="correction.secondaryCode"
            :code="correction.secondaryCode"
            :caption="correction.secondaryCaption"
          />
          <p class="tip mt-0">{{ correction.hint }}</p>
        </template>
      </template>

      <v-alert
        v-else
        type="error"
        variant="tonal"
        class="mb-3"
        :text="result.failureReason ?? 'The scan could not be analyzed.'"
        data-testid="pa-failure"
      />

      <OverlayCanvas
        v-if="processing?.overlay"
        :bitmap="processing.overlay"
        label="Detected lines and scores"
        class="mt-3"
      />
    </section>
  </v-container>

  <PrinterProfileForm v-model="formOpen" :profile="editing" @save="onSave" />

  <v-dialog v-model="deleteOpen" max-width="380">
    <v-card title="Delete printer profile?">
      <v-card-text>
        "{{ store.selected?.name }}" will be removed. This cannot be undone.
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="deleteOpen = false">Cancel</v-btn>
        <v-btn color="error" variant="flat" data-testid="profile-delete-confirm" @click="confirmDelete">
          Delete
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.page {
  max-width: 760px;
}
.step {
  background: rgb(var(--v-theme-surface-light));
  border-radius: 12px;
  padding: 16px;
}
.step-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.num {
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
  font-size: 14px;
}
.step-title {
  font-weight: 500;
  font-size: 14px;
}
.tip {
  font-size: 12.5px;
  color: rgba(var(--v-theme-on-surface), 0.6);
  margin-top: 8px;
}
.profile-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.profile-select {
  flex: 1 1 220px;
}
.filament-select {
  flex: 1 1 160px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.fields {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.fields > * {
  flex: 1 1 140px;
}
.gen-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.warn-box {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  background: rgba(var(--v-theme-warning), 0.12);
  border: 1px solid rgba(var(--v-theme-warning), 0.35);
  border-radius: 8px;
  padding: 9px 11px;
  font-size: 12.5px;
  line-height: 1.55;
}
.warn-icon {
  margin-top: 1px;
  flex-shrink: 0;
}
.warn-lead {
  color: rgb(var(--v-theme-warning));
  font-weight: 500;
}
.dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 22px;
  border: 1.5px dashed rgba(var(--v-theme-primary), 0.5);
  border-radius: 12px;
  background: rgb(var(--v-theme-surface-bright));
  cursor: pointer;
  position: relative;
  transition: border-color 0.15s ease;
}
.dropzone:hover {
  border-color: rgb(var(--v-theme-primary));
}
.file-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.dz-label {
  font-weight: 500;
  font-size: 14px;
}
.dz-sub {
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), 0.6);
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 8px;
}
</style>
