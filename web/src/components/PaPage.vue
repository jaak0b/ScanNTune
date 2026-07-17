<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { usePrinterProfiles } from '../stores/usePrinterProfiles'
import { usePaSettings } from '../stores/usePaSettings'
import { useFlowSettingsForm } from '../composables/useFlowSettingsForm'
import { runGuardedAnalysis } from '../composables/useScanAnalysis'
import { readBytes } from '../util/preview'
import { hasMeasuredResolution } from '../util/scanResolution'
import { analyzePaScan } from '../workerClient'
import type { PaProcessing } from '../workerClient'
import { generatePaGcodeWithReport } from '../engine/pa/gcodeGenerator'
import { paCorrection, sweepCorrection } from '../engine/pa/paCorrectionFormatter'
import {
  couponGeometry,
  defaultPaTestSpec,
  defaultSmoothTimeTestSpec,
  edgeShiftRange,
  extruderPresetRanges,
  fitsA4,
  maxLineCountForHeight,
} from '../engine/pa/types'
import type { PaProgress, PaTestSpec } from '../engine/pa/types'
import NumericField from './NumericField.vue'
import OverlayCanvas from './OverlayCanvas.vue'
import CodeBlock from './CodeBlock.vue'
import MetricTile from './MetricTile.vue'
import PrinterProfileCard from './PrinterProfileCard.vue'
import ResolutionChip from './ResolutionChip.vue'

const store = usePrinterProfiles()

// Test range card state, persisted per printer profile; falls back to the spec defaults
// when nothing is stored for the selected profile.
const specDefaults = defaultPaTestSpec()
const paSettings = usePaSettings()
const {
  form: settingsForm,
  hasStored: settingsStored,
  reset: resetSettings,
} = useFlowSettingsForm(
  paSettings,
  () => ({
    paStart: specDefaults.paStart,
    paEnd: specDefaults.paEnd,
    lineCount: specDefaults.lineCount,
    slowSpeedMmS: specDefaults.slowSpeedMmS,
    fastSpeedMmS: specDefaults.fastSpeedMmS,
  }),
  () => store.selectedId,
)
const { paStart, paEnd, lineCount, slowSpeedMmS: slowSpeed, fastSpeedMmS: fastSpeed } = settingsForm

const spec = computed<PaTestSpec>(() => ({
  ...defaultPaTestSpec(),
  paStart: paStart.value ?? specDefaults.paStart,
  paEnd: paEnd.value ?? specDefaults.paEnd,
  lineCount: lineCount.value ?? specDefaults.lineCount,
  slowSpeedMmS: slowSpeed.value ?? specDefaults.slowSpeedMmS,
  fastSpeedMmS: fastSpeed.value ?? specDefaults.fastSpeedMmS,
}))
// Extruder preset picker: prefills the PA range once per selection, never persisted, and manual
// edits leave the selection alone (it is a one-shot prefill, not a bound value).
const extruderPreset = ref<keyof typeof extruderPresetRanges | null>(null)
const extruderItems = [
  { title: 'Direct drive', value: 'directDrive' },
  { title: 'Bowden', value: 'bowden' },
]
function onExtruderPreset(key: keyof typeof extruderPresetRanges | null): void {
  extruderPreset.value = key
  if (!key) return
  const range = extruderPresetRanges[key]
  paStart.value = range.paStart
  paEnd.value = range.paEnd
}

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
const speedContrastLow = computed(() => spec.value.fastSpeedMmS < 3 * spec.value.slowSpeedMmS)
const tooManyLines = computed(() => spec.value.lineCount > 24)

const generateError = ref('')
const unknownVariables = ref<string[]>([])
const templateWarnings = ref<string[]>([])
const canGenerate = computed(() => store.selected !== null && store.selectedFilament !== null)

function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'printer'
}
const filename = computed(() =>
  store.selected ? `pa_test_${sanitizeName(store.selected.name)}.gcode` : '',
)

function downloadGcode(usedSpec: PaTestSpec, name: string, errorRef: { value: string }): void {
  const profile = store.selected
  const filament = store.selectedFilament
  if (!profile || !filament) return
  errorRef.value = ''
  unknownVariables.value = []
  templateWarnings.value = []
  let gcode: string
  try {
    const report = generatePaGcodeWithReport(profile, filament, usedSpec)
    gcode = report.gcode
    unknownVariables.value = report.unknownVariables
    templateWarnings.value = report.warnings
  } catch (e) {
    errorRef.value = e instanceof Error ? e.message : String(e)
    console.error('G-code generation failed', e)
    return
  }
  const blob = new Blob([gcode], { type: 'text/x-gcode' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

function generate(): void {
  downloadGcode(spec.value, filename.value, generateError)
}

// Scan card state. One `analyzing` lock covers BOTH scan uploads (PA and smooth time): while
// either analysis runs, every control on the page is disabled. `analyzeKind` only says which
// card shows the progress spinner.
const analyzing = ref(false)
const showPaInfo = ref(false)
const analyzeKind = ref<'pa' | 'smoothTime' | null>(null)
const progressText = ref('')
const scanError = ref('')

function onProgress(p: PaProgress): void {
  switch (p.stage) {
    case 'decode':
      progressText.value = 'Reading the scan'
      break
    case 'align':
      progressText.value = 'Locating the fiducials'
      break
    case 'measure':
      progressText.value = `Measuring line ${(p.line ?? 0) + 1} of ${p.lineCount ?? '?'}`
      break
    case 'score':
      progressText.value = 'Scoring'
      break
    case 'render':
      progressText.value = 'Rendering the result'
      break
  }
}
const processing = shallowRef<PaProcessing | null>(null)
// The spec the current `processing` result was actually analyzed against, so the result card
// stays consistent even if the form fields below change afterwards.
const analyzedSpec = shallowRef<PaTestSpec | null>(null)

function resetProcessing(): void {
  processing.value?.overlay.close()
  processing.value = null
  analyzedSpec.value = null
}

// Shared upload handler for both scan cards: decodes the picked file, runs the worker analysis
// against the given spec, and lands the outcome in the given card's refs, all under the one
// page-wide `analyzing` lock.
async function analyzeUpload(
  e: Event,
  kind: 'pa' | 'smoothTime',
  usedSpec: PaTestSpec,
  sink: {
    processing: typeof processing
    analyzedSpec: typeof analyzedSpec
    error: { value: string }
    reset: () => void
  },
): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  // Clear the input so picking the same file again still fires change.
  input.value = ''
  // A disabled input still receives drops in some browsers; never start a second analysis.
  if (!file || analyzing.value) return
  analyzeKind.value = kind
  progressText.value = 'Reading the scan'
  sink.reset()
  await runGuardedAnalysis(
    { analyzing, error: sink.error },
    'PA scan analysis failed',
    async () => {
      const bytes = await readBytes(file)
      sink.processing.value = await analyzePaScan(bytes, usedSpec, onProgress)
      sink.analyzedSpec.value = usedSpec
    },
    () => {
      analyzeKind.value = null
      progressText.value = ''
    },
  )
}

async function onPick(e: Event): Promise<void> {
  await analyzeUpload(e, 'pa', spec.value, {
    processing,
    analyzedSpec,
    error: scanError,
    reset: resetProcessing,
  })
  const r = processing.value?.result
  // Prefill the smooth-time step's fixed advance with the freshly measured value.
  if (r?.success && r.bestPa !== null) stFixedAdvance.value = Number(r.bestPa.toFixed(4))
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
// Raw diagnostic: the resolution geometrically measured from the coupon itself.
const hasResolution = computed(() => hasMeasuredResolution(result.value?.measuredPxPerMm))

const edgeShift = computed<{ start: number; end: number } | null>(() => {
  const r = result.value
  const s = analyzedSpec.value
  if (!r || !r.success || !s) return null
  return edgeShiftRange(s, r.bestLineIndex)
})
// Bulge-sign sweep coverage: non-null when the transition bulges say the true value lies outside
// the printed range, carrying the direction.
const outOfRange = computed<'above-range' | 'below-range' | null>(() => {
  const b = result.value?.sweepBracket
  return b === 'above-range' || b === 'below-range' ? b : null
})
function applyShift(): void {
  if (!edgeShift.value || analyzing.value) return
  paStart.value = Number(edgeShift.value.start.toFixed(4))
  paEnd.value = Number(edgeShift.value.end.toFixed(4))
  resetProcessing()
}

// Step 5, smooth time (optional, Klipper only). Shown once a successful PA result exists in this
// session; hidden again if the user switches to a non-Klipper profile.
const stDefaults = defaultSmoothTimeTestSpec(0)
const stStart = ref<number | null>(stDefaults.paStart)
const stEnd = ref<number | null>(stDefaults.paEnd)
const stFixedAdvance = ref<number | null>(null)
const stSpec = computed<PaTestSpec>(() => ({
  ...defaultSmoothTimeTestSpec(stFixedAdvance.value ?? 0),
  paStart: stStart.value ?? stDefaults.paStart,
  paEnd: stEnd.value ?? stDefaults.paEnd,
}))
const showSmoothStep = computed(
  () => store.selected?.firmware === 'Klipper' && result.value?.success === true,
)

const stGenerateError = ref('')
const stFilename = computed(() =>
  store.selected ? `smooth_time_${sanitizeName(store.selected.name)}.gcode` : '',
)
function generateSmooth(): void {
  downloadGcode(stSpec.value, stFilename.value, stGenerateError)
}

const stScanError = ref('')
const stProcessing = shallowRef<PaProcessing | null>(null)
const stAnalyzedSpec = shallowRef<PaTestSpec | null>(null)
function resetStProcessing(): void {
  stProcessing.value?.overlay.close()
  stProcessing.value = null
  stAnalyzedSpec.value = null
}

onBeforeUnmount(() => {
  resetProcessing()
  resetStProcessing()
})

async function onPickSmooth(e: Event): Promise<void> {
  await analyzeUpload(e, 'smoothTime', stSpec.value, {
    processing: stProcessing,
    analyzedSpec: stAnalyzedSpec,
    error: stScanError,
    reset: resetStProcessing,
  })
}

const stResult = computed(() => stProcessing.value?.result ?? null)
const stLinesReadable = computed(() =>
  stResult.value ? stResult.value.lines.filter((l) => l.measured).length : 0,
)
const stOutOfRange = computed<'above-range' | 'below-range' | null>(() => {
  const b = stResult.value?.sweepBracket
  return b === 'above-range' || b === 'below-range' ? b : null
})
const stCorrection = computed(() => {
  const r = stResult.value
  const s = stAnalyzedSpec.value
  if (!r || !r.success || r.bestPa === null || !s) return null
  if (store.selected?.firmware !== 'Klipper') return null
  return sweepCorrection('Klipper', s, r.bestPa)
})
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
    <PrinterProfileCard :disabled="analyzing" />

    <!-- 2. Test range -->
    <section class="step mb-3">
      <div class="step-head mb-2">
        <span class="num">2</span><span class="step-title">Test range</span>
        <v-spacer />
        <v-btn
          v-if="settingsStored"
          variant="tonal"
          color="warning"
          size="small"
          prepend-icon="mdi-restore"
          :disabled="analyzing"
          data-testid="pa-settings-reset"
          @click="resetSettings"
        >
          Reset to defaults
        </v-btn>
        <v-btn
          variant="text"
          size="small"
          prepend-icon="mdi-information-outline"
          class="info-link"
          data-testid="pa-info-panel"
          @click="showPaInfo = true"
        >
          What affects PA?
        </v-btn>
      </div>
      <div class="field-group">
        <span class="group-label">Sweep</span>
        <div class="fields">
          <v-select
            :model-value="extruderPreset"
            :items="extruderItems"
            label="Extruder"
            placeholder="Prefill range..."
            density="comfortable"
            :disabled="analyzing"
            data-testid="pa-extruder-preset"
            @update:model-value="onExtruderPreset"
          />
          <NumericField v-model="paStart" label="PA start" :step="0.01" :min="0" :precision="4" :disabled="analyzing" />
          <NumericField v-model="paEnd" label="PA end" :step="0.01" :min="0" :precision="4" :disabled="analyzing" />
          <NumericField v-model="lineCount" label="Lines" :step="1" :min="4" :disabled="analyzing" />
        </div>
      </div>
      <div class="field-group mt-1">
        <span class="group-label">Test speeds</span>
        <div class="fields">
          <NumericField v-model="slowSpeed" label="Slow speed (mm/s)" :step="5" :min="1" :disabled="analyzing" />
          <NumericField v-model="fastSpeed" label="Fast speed (mm/s)" :step="5" :min="1" :disabled="analyzing" />
        </div>
      </div>
      <div class="facts mt-2">
        <v-chip size="small" variant="tonal" prepend-icon="mdi-stairs">{{ stepPerLine }} per line</v-chip>
        <v-chip size="small" variant="tonal" prepend-icon="mdi-ruler-square">{{ footprintText }}</v-chip>
        <span v-if="!canGenerate" class="tip mt-0">Choose a printer profile first.</span>
        <v-spacer />
        <v-btn
          color="primary"
          prepend-icon="mdi-download"
          :disabled="!canGenerate || analyzing"
          data-testid="generate-btn"
          @click="generate"
        >
          Generate G-code
        </v-btn>
      </div>
      <v-dialog v-model="showPaInfo" max-width="560">
        <v-card title="What affects pressure advance">
          <v-card-text>
            <ul class="info-list">
              <li>
                <strong>Temperature:</strong> the biggest factor. Hotter plastic flows easier and
                needs less advance. Calibrate at the temperature you print with (the test uses your
                filament profile's temperature).
              </li>
              <li>
                <strong>Filament:</strong> every material, brand, and even color has its own value.
                Recalibrate when you switch filament.
              </li>
              <li>
                <strong>Extruder type:</strong> direct drive needs small values (around 0.02 to
                0.06); bowden needs far more (0.2 to 1.0), because the long tube adds compliance.
              </li>
              <li>
                <strong>Print speed:</strong> a secondary effect. The linear model is an
                approximation, so calibrate near the speeds you actually print at; the test's slow
                and fast speeds are configurable for that reason.
              </li>
              <li>
                <strong>Acceleration and jerk (square corner velocity):</strong> these do not
                change the correct value; they change how visible a wrong value is. Higher
                acceleration makes speed changes sharper, so errors bulge or starve more.
              </li>
              <li>
                <strong>Nozzle size:</strong> larger nozzles change the flow behavior; recalibrate
                after a nozzle swap.
              </li>
            </ul>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn variant="text" @click="showPaInfo = false">Close</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
      <v-alert
        v-if="speedContrastLow"
        type="warning"
        variant="tonal"
        density="compact"
        class="mt-3 soft-alert"
        data-testid="pa-speed-warning"
        text="Fast speed should be at least 3x the slow speed; the speed contrast is what makes pressure advance measurable."
      />
      <v-alert
        v-if="tooManyLines"
        type="info"
        variant="tonal"
        density="compact"
        class="mt-3 soft-alert"
        data-testid="pa-lines-hint"
        text="More than 24 lines adds little precision; a narrower follow-up range works better."
      />
      <v-alert
        v-if="exceedsA4"
        type="warning"
        variant="tonal"
        density="compact"
        class="mt-3 soft-alert"
        data-testid="pa-a4-warning"
        :text="`The coupon is larger than A4. Most flatbed scanners cannot scan it in one pass. Reduce the line count to ${maxLinesForA4} or fewer unless your scanner is larger.`"
      />
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
      <v-alert
        v-if="templateWarnings.length > 0"
        type="warning"
        variant="tonal"
        class="mt-3"
        :text="templateWarnings.join(' ')"
        data-testid="template-warnings"
      />
      <p class="caption-note">
        <v-icon size="14" class="mr-1">mdi-invert-colors</v-icon>
        Use two filaments with clearly different brightness (any colors work); swap to the second
        one at the pause.
      </p>
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
          :disabled="analyzing"
          data-testid="pa-scan-input"
          @change="onPick"
        />
        <v-icon size="28" color="primary">mdi-image-plus</v-icon>
        <span class="dz-label">Choose the scan image</span>
        <span class="dz-sub">or drop it here</span>
      </label>
      <div v-if="analyzing && analyzeKind === 'pa'" class="d-flex align-center ga-2 mt-3">
        <v-progress-circular indeterminate size="20" width="2" color="primary" />
        <span class="tip mt-0" data-testid="pa-progress">{{ progressText || 'Analyzing the scan...' }}</span>
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
            :value="result.bestPa!.toFixed(4) + (result.sePa !== null ? ` ± ${result.sePa.toFixed(4)}` : '')"
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

        <div class="facts mb-3">
          <ResolutionChip
            v-if="hasResolution"
            :measured-px-per-mm="result.measuredPxPerMm"
            testid="pa-resolution"
          />
          <span class="tip mt-0" data-testid="pa-bracket">
            Sweep bracketed the optimum: {{ result.sweepBracket === 'bracketed' ? 'yes' : 'no' }}
          </span>
          <span v-if="outOfRange" class="tip mt-0" data-testid="pa-bracket-direction">
            True value direction: {{ outOfRange === 'above-range' ? 'above the printed range' : 'below the printed range' }}
          </span>
        </div>

        <div v-if="edgeShift || outOfRange" class="warn-box mb-3" data-testid="pa-edge-warning">
          <v-icon color="warning" size="16" class="warn-icon">mdi-alert-outline</v-icon>
          <span>
            <template v-if="outOfRange === 'above-range'">
              <strong class="warn-lead">The true pressure advance lies above the printed range.</strong>
              The value shown is the top of the range, not the optimum.
            </template>
            <template v-else-if="outOfRange === 'below-range'">
              <strong class="warn-lead">The true pressure advance lies below the printed range.</strong>
              The value shown is the bottom of the range, not the optimum.
            </template>
            <template v-else>
              <strong class="warn-lead">The optimum sits at the edge of the sweep,</strong>
              so the true value may lie outside the tested range.
            </template>
            <template v-if="edgeShift">
              Rerun with a shifted range:
              {{ edgeShift.start.toFixed(4) }} to {{ edgeShift.end.toFixed(4) }}.
              <v-btn size="x-small" variant="tonal" color="warning" class="ml-1" :disabled="analyzing" @click="applyShift">
                Use shifted range
              </v-btn>
            </template>
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

    <!-- 5. Smooth time (optional, Klipper only) -->
    <section v-if="showSmoothStep" class="step mt-3" data-testid="pa-st-step">
      <div class="step-head mb-1">
        <span class="num">5</span><span class="step-title">Smooth time (optional)</span>
      </div>
      <p class="tip mb-3">
        optional, Klipper only: sharper corners at high acceleration. The test lines all use the
        pressure advance measured above and sweep pressure_advance_smooth_time instead.
      </p>
      <div class="fields">
        <NumericField v-model="stStart" label="Smooth time start (s)" :step="0.005" :min="0" :precision="4" :disabled="analyzing" />
        <NumericField v-model="stEnd" label="Smooth time end (s)" :step="0.005" :min="0" :precision="4" :disabled="analyzing" />
        <NumericField v-model="stFixedAdvance" label="Pressure advance" :step="0.005" :min="0" :precision="4" :disabled="analyzing" />
      </div>
      <div class="gen-row mt-2">
        <v-btn
          color="primary"
          prepend-icon="mdi-download"
          :disabled="!canGenerate || analyzing"
          data-testid="st-generate-btn"
          @click="generateSmooth"
        >
          Generate G-code
        </v-btn>
        <span v-if="stFilename" class="tip mt-0">{{ stFilename }}</span>
      </div>
      <v-alert
        v-if="stGenerateError"
        type="error"
        variant="tonal"
        class="mt-3"
        :text="stGenerateError"
        data-testid="st-generate-error"
      />
      <p class="tip mb-3 mt-3">
        Print it the same way as the first coupon, scan it, and drop the image in.
      </p>
      <label class="dropzone">
        <input
          type="file"
          accept="image/*"
          class="file-input"
          :disabled="analyzing"
          data-testid="pa-st-scan-input"
          @change="onPickSmooth"
        />
        <v-icon size="28" color="primary">mdi-image-plus</v-icon>
        <span class="dz-label">Choose the scan image</span>
        <span class="dz-sub">or drop it here</span>
      </label>
      <div v-if="analyzing && analyzeKind === 'smoothTime'" class="d-flex align-center ga-2 mt-3">
        <v-progress-circular indeterminate size="20" width="2" color="primary" />
        <span class="tip mt-0" data-testid="pa-st-progress">{{ progressText || 'Analyzing the scan...' }}</span>
      </div>
      <v-alert
        v-if="stScanError"
        type="error"
        variant="tonal"
        class="mt-3"
        :text="stScanError"
        data-testid="st-scan-error"
      />

      <template v-if="stResult">
        <template v-if="stResult.success">
          <div class="tiles mb-3 mt-3">
            <MetricTile
              label="Best smooth time (s)"
              :value="stResult.bestPa!.toFixed(4) + (stResult.sePa !== null ? ` ± ${stResult.sePa.toFixed(4)}` : '')"
              testid="pa-st-best"
            />
            <MetricTile
              label="Best line"
              :value="`${stResult.bestLineIndex! + 1} of ${stAnalyzedSpec!.lineCount}`"
              testid="pa-st-best-line"
            />
            <MetricTile
              label="Lines readable"
              :value="`${stLinesReadable} / ${stAnalyzedSpec!.lineCount}`"
              testid="pa-st-lines-readable"
            />
          </div>
          <div class="facts mb-3">
            <span class="tip mt-0" data-testid="pa-st-bracket">
              Sweep bracketed the optimum: {{ stResult.sweepBracket === 'bracketed' ? 'yes' : 'no' }}
            </span>
            <span v-if="stOutOfRange" class="tip mt-0" data-testid="pa-st-bracket-direction">
              True value direction: {{ stOutOfRange === 'above-range' ? 'above the printed range' : 'below the printed range' }}
            </span>
          </div>
          <div v-if="stOutOfRange" class="warn-box mb-3" data-testid="pa-st-edge-warning">
            <v-icon color="warning" size="16" class="warn-icon">mdi-alert-outline</v-icon>
            <span>
              <strong class="warn-lead">
                The true smooth time lies {{ stOutOfRange === 'above-range' ? 'above' : 'below' }} the printed range.
              </strong>
              The value shown is the range edge, not the optimum. Rerun with a shifted range.
            </span>
          </div>
          <template v-if="stCorrection">
            <CodeBlock :code="stCorrection.code" data-testid="pa-st-code" />
            <CodeBlock
              v-if="stCorrection.secondaryCode"
              :code="stCorrection.secondaryCode"
              :caption="stCorrection.secondaryCaption"
            />
            <p class="tip mt-0">{{ stCorrection.hint }}</p>
          </template>
        </template>
        <v-alert
          v-else
          type="error"
          variant="tonal"
          class="mb-3 mt-3"
          :text="stResult.failureReason ?? 'The scan could not be analyzed.'"
          data-testid="pa-st-failure"
        />
        <OverlayCanvas
          v-if="stProcessing?.overlay"
          :bitmap="stProcessing.overlay"
          label="Detected lines and scores"
          class="mt-3"
        />
      </template>
    </section>
  </v-container>
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
.info-panels :deep(.v-expansion-panel) {
  background: transparent;
}
.info-list {
  padding-left: 18px;
  display: grid;
  gap: 8px;
  font-size: 13px;
  color: rgba(var(--v-theme-on-surface), 0.78);
}
.tip {
  font-size: 12.5px;
  color: rgba(var(--v-theme-on-surface), 0.6);
  margin-top: 8px;
}
.fields {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.fields > * {
  flex: 1 1 140px;
}
.field-group .group-label {
  display: block;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.55;
  margin-bottom: 4px;
}
.facts {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.soft-alert {
  font-size: 0.875rem;
}
.info-link {
  text-transform: none;
  letter-spacing: normal;
  opacity: 0.8;
}
.caption-note {
  display: flex;
  align-items: center;
  font-size: 0.8rem;
  opacity: 0.65;
  margin: 12px 0 0;
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
