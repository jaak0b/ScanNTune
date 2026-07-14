<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { useApp } from '../stores/useApp'
import { useCalibration } from '../stores/useCalibration'
import { usePrinterProfiles } from '../stores/usePrinterProfiles'
import { useEmSettings } from '../stores/useEmSettings'
import { useFlowSettingsForm } from '../composables/useFlowSettingsForm'
import type { PartColors, ScanPlace } from '../model/scanPlan'
import { readBytes } from '../util/preview'
import { scaleReferenceAtDpi } from '../engine/scannerCalibration'
import { resolutionRowValue } from '../util/scanResolution'
import { analyzeEmScans } from '../workerClient'
import type { EmProcessing } from '../workerClient'
import { emCorrection } from '../engine/em/emCorrectionFormatter'
import { generateEmGcodeWithReport } from '../engine/em/gcodeGenerator'
import {
  accelRampMm,
  defaultEmTestSpec,
  emCouponGeometry,
  volumetricFlowMm3S,
  type EmProgress,
  type EmTestSpec,
} from '../engine/em/types'
import { fitsA4, flowWarningLimitMm3S } from '../engine/gcode/emitter'
import { defaultFilamentProfile } from '../engine/gcode/profileTypes'
import { defaultPrinterProfile } from '../engine/pa/types'
import PrinterProfileCard from './PrinterProfileCard.vue'
import EmScanOrientationDiagram from './EmScanOrientationDiagram.vue'
import NumericField from './NumericField.vue'
import OverlayCanvas from './OverlayCanvas.vue'
import CodeBlock from './CodeBlock.vue'
import MetricTile from './MetricTile.vue'

const app = useApp()
const store = usePrinterProfiles()

// Scanner calibration is a hard requirement: the analysis measures pitch and gap in true
// millimetres (axis-scale and shrinkage immune), which needs the card-derived px/mm.
const calibration = useCalibration()
const isCalibrated = computed(() => calibration.calibration !== null)
const calibrationLine = computed(() =>
  isCalibrated.value
    ? `${Math.round(calibration.calibration!.dpi)} dpi`
    : 'Not calibrated',
)

// Spec defaults follow the selected printer. The fields are persisted per printer profile;
// with nothing stored for the selected profile they fall back to the spec defaults, and a
// profile switch re-applies that profile's stored settings or defaults.
const specDefaults = computed(() => defaultEmTestSpec(store.selected ?? defaultPrinterProfile()))
const emSettings = useEmSettings()
const {
  form: settingsForm,
  hasStored: settingsStored,
  reset: resetSettings,
} = useFlowSettingsForm(
  emSettings,
  () => ({
    pitchMinMm: specDefaults.value.pitchMinMm,
    pitchMaxMm: specDefaults.value.pitchMaxMm,
    blockCount: specDefaults.value.blockCount,
    linesPerBlock: specDefaults.value.linesPerBlock,
    printSpeedMmS: specDefaults.value.printSpeedMmS,
    scanPlace: 'part' as ScanPlace,
    partColors: 'single' as PartColors,
  }),
  () => store.selectedId,
)
// The placement and contrasting-base spec fields are driven by two scanning choices:
// where the scan happens (removed part vs the whole build plate on the scanner, the
// latter for filaments that will not come off, e.g. TPU or PETG), and, for a removed
// part only, whether a contrasting base is printed under the coupon. Scanning with the
// plate is always a single-color print at the bed's front edge so the plate edge can
// lie on the glass with the rest overhanging.
const {
  pitchMinMm: pitchMin,
  pitchMaxMm: pitchMax,
  blockCount,
  linesPerBlock,
  printSpeedMmS: printSpeed,
  scanPlace,
  partColors,
} = settingsForm
const scanPlaceItems = [
  { title: 'Scan the removed part', value: 'part' },
  { title: 'Scan with the build plate', value: 'plate' },
]
const partColorsItems = [
  { title: 'Single color', value: 'single' },
  { title: 'Two colors (contrasting base)', value: 'base' },
]
const scanPlanNote = computed(() => {
  if (scanPlace.value === 'plate') {
    const placement =
      'The coupon is printed at the front edge of the bed, so that edge of the build ' +
      'plate can lie on the scanner glass. Useful for filaments that are hard to remove, ' +
      'like TPU or PETG.'
    return partColors.value === 'base'
      ? placement +
          ' The contrasting base backs the measured gaps, so the build plate surface does not matter.'
      : placement +
          ' Use a light, even build plate; a dark or textured plate shows through the gaps and the scan is refused.'
  }
  return partColors.value === 'base'
    ? 'A base is printed in a second color underneath the coupon, with a filament swap ' +
        'pause between the two. The two filaments need to differ in brightness.'
    : 'The removed part is scanned face down on the glass. The filament color needs to ' +
        'contrast with the backing, either the scanner lid or a sheet of paper.'
})

const spec = computed<EmTestSpec>(() => ({
  ...specDefaults.value,
  pitchMinMm: pitchMin.value ?? specDefaults.value.pitchMinMm,
  pitchMaxMm: pitchMax.value ?? specDefaults.value.pitchMaxMm,
  blockCount: blockCount.value ?? specDefaults.value.blockCount,
  linesPerBlock: linesPerBlock.value ?? specDefaults.value.linesPerBlock,
  printSpeedMmS: printSpeed.value ?? specDefaults.value.printSpeedMmS,
  placement: scanPlace.value === 'plate' ? 'front' : 'center',
  contrastBase: partColors.value === 'base',
}))

const geometry = computed(() => emCouponGeometry(spec.value))
const footprintText = computed(
  () => `coupon ${Math.round(geometry.value.couponWidthMm)} x ${Math.round(geometry.value.couponHeightMm)} mm`,
)
const exceedsA4 = computed(() => !fitsA4(geometry.value.couponWidthMm, geometry.value.couponHeightMm))
const layerHeight = computed(() => (store.selected ?? defaultPrinterProfile()).layerHeightMm)
const flowText = computed(() => `${volumetricFlowMm3S(spec.value, layerHeight.value).toFixed(1)} mm^3/s`)
const highFlow = computed(() => {
  const f = store.selectedFilament ?? defaultFilamentProfile()
  return volumetricFlowMm3S(spec.value, layerHeight.value) > flowWarningLimitMm3S(f)
})
const rampWarning = computed(() => {
  const p = store.selected
  if (!p) return false
  return 2 * accelRampMm(spec.value.printSpeedMmS, p.printAccelMmS2) > spec.value.lineLengthMm / 2
})

const generateError = ref('')
const unknownVariables = ref<string[]>([])
const templateWarnings = ref<string[]>([])
const canGenerate = computed(() => store.selected !== null && store.selectedFilament !== null)

function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'printer'
}
const filename = computed(() =>
  store.selected ? `em_flow_test_${sanitizeName(store.selected.name)}.gcode` : '',
)

function generate(): void {
  const profile = store.selected
  const filament = store.selectedFilament
  if (!profile || !filament) return
  generateError.value = ''
  unknownVariables.value = []
  templateWarnings.value = []
  let gcode: string
  try {
    const report = generateEmGcodeWithReport(profile, filament, spec.value)
    gcode = report.gcode
    unknownVariables.value = report.unknownVariables
    templateWarnings.value = report.warnings
  } catch (e) {
    generateError.value = e instanceof Error ? e.message : String(e)
    console.error('EM G-code generation failed', e)
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

// Scan step state: one scan is required, a second scan of the same coupon rotated 180 degrees
// on the glass is optional (it cancels one-sided scanner-lamp shading in the pooled estimate).
// While an analysis runs, the upload and flow controls are locked.
const scanFiles = ref<File[]>([])
const scanPickHint = ref('')
const analyzing = ref(false)
// True once "Analyze" was clicked; the per-file delete buttons give way to the "Start over"
// reset until the step is cleared again.
const analysisStarted = ref(false)
const progressText = ref('')
const scanError = ref('')
// The user's CURRENT slicer flow, entered either as a factor (PrusaSlicer extrusion
// multiplier / Orca flow ratio, e.g. 0.96) or as a percent (Cura-style, e.g. 96). Values
// above 5 are read as percent; real factors live near 1 and real percents near 100, so the
// two ranges cannot collide. The corrected value is echoed back in the same style.
// Deliberately starts empty: the corrected flow is computed relative to this value, so
// analysis is blocked until the user has entered their actual current setting.
const currentFlow = ref<number | null>(null)
const currentFlowValid = computed(() => currentFlow.value !== null && currentFlow.value > 0)

function onProgress(p: EmProgress): void {
  switch (p.stage) {
    case 'decode':
      progressText.value = 'Reading the scan'
      break
    case 'align':
      progressText.value = 'Locating the fiducials'
      break
    case 'measure':
      progressText.value = 'Measuring the blocks'
      break
    case 'render':
      progressText.value = 'Rendering the result'
      break
  }
}

const processing = shallowRef<EmProcessing | null>(null)
// The spec the current `processing` result was actually analyzed against, so the result card
// stays consistent even if the form fields above change afterwards.
const analyzedSpec = shallowRef<EmTestSpec | null>(null)

function resetProcessing(): void {
  zoomed.value = null
  processing.value?.overlays.forEach((bitmap) => bitmap.close())
  processing.value = null
  analyzedSpec.value = null
}

onBeforeUnmount(resetProcessing)

// The overlay a scan card was clicked on, shown full size in a dialog; null when closed.
const zoomed = shallowRef<ImageBitmap | null>(null)

function onPickScans(e: Event): void {
  const input = e.target as HTMLInputElement
  const picked = Array.from(input.files ?? [])
  // Clear the input so picking the same file again still fires change.
  input.value = ''
  // A disabled input still receives drops in some browsers; the calibration is a hard
  // requirement and a running analysis must not be doubled up.
  if (picked.length === 0 || analyzing.value || analysisStarted.value || !calibration.calibration)
    return
  scanPickHint.value = ''
  const room = 2 - scanFiles.value.length
  if (picked.length > room) {
    scanPickHint.value =
      'The analysis uses at most two scan images. The files beyond the first two were not added.'
  }
  scanFiles.value = [...scanFiles.value, ...picked.slice(0, Math.max(0, room))]
}

function removeScan(index: number): void {
  if (analyzing.value || analysisStarted.value) return
  scanFiles.value = scanFiles.value.filter((_, i) => i !== index)
  scanPickHint.value = ''
}

// Clears the whole scan step (files, result, overlays, and errors) so new scans can be picked
// and analyzed from a clean slate.
function startOver(): void {
  if (analyzing.value) return
  resetProcessing()
  scanFiles.value = []
  scanPickHint.value = ''
  scanError.value = ''
  analysisStarted.value = false
}

const canAnalyze = computed(
  () =>
    scanFiles.value.length >= 1 && isCalibrated.value && currentFlowValid.value && !analyzing.value,
)

async function analyze(): Promise<void> {
  const files = scanFiles.value
  const cal = calibration.calibration
  if (files.length === 0 || analyzing.value || !cal || !currentFlowValid.value) return
  const usedSpec = spec.value
  analyzing.value = true
  analysisStarted.value = true
  progressText.value = 'Reading the scan'
  scanError.value = ''
  resetProcessing()
  try {
    const bytesList = await Promise.all(files.map((file) => readBytes(file)))
    // The calibration's scale error holds across resolutions; the scan is expected at the
    // calibration DPI, so the calibration is priced at exactly that resolution.
    const scanPxPerMm = scaleReferenceAtDpi(cal, cal.dpi)
    processing.value = await analyzeEmScans(bytesList, usedSpec, scanPxPerMm, cal.dpi, onProgress)
    analyzedSpec.value = usedSpec
  } catch (err) {
    console.error('EM scan analysis failed', err)
    scanError.value = err instanceof Error ? err.message : String(err)
  } finally {
    analyzing.value = false
    progressText.value = ''
  }
}

// Result card state, derived from the analyzedSpec snapshot, never the live form state.
const result = computed(() => processing.value?.result ?? null)
// Machine-level correction: the coupon always prints at firmware flow 100%, so the M221
// command is computed against that, independent of any slicer setting.
const correction = computed(() => {
  const r = result.value
  const s = analyzedSpec.value
  if (!r || !r.success || r.wMm === null || !s) return null
  return emCorrection(store.selected?.firmware ?? 'Klipper', 100, s.nominalLineWidthMm, r.wMm)
})

// Corrected slicer flow: the measured over/under-extrusion ratio applied to the user's
// current slicer flow, echoed in the style it was entered (factor or percent).
const newSlicerFlow = computed(() => {
  const r = result.value
  const s = analyzedSpec.value
  if (!r || !r.success || r.wMm === null || !s) return null
  const entered = currentFlow.value
  if (entered === null || entered <= 0) return null
  const isPercent = entered > 5
  const factor = isPercent ? entered / 100 : entered
  const corrected = factor * (s.nominalLineWidthMm / r.wMm)
  // Uncertainty on the corrected flow: the standard error of the measured bead width
  // (between-block spread of the analysis), propagated through the correction ratio.
  // Presented the same way the input shaper states its frequency confidence interval.
  const uncertainty = r.seMm !== null ? (r.seMm / r.wMm) * corrected : null
  if (isPercent) {
    const ci = uncertainty !== null ? ` ± ${(uncertainty * 100).toFixed(1)}` : ''
    return `${(corrected * 100).toFixed(1)}${ci}%`
  }
  const ci = uncertainty !== null ? ` ± ${uncertainty.toFixed(3)}` : ''
  return `${corrected.toFixed(3)}${ci}`
})
const pitchScaleOff = computed(() => {
  const p = result.value?.pitchScale
  return p !== null && p !== undefined && Math.abs(p - 1) > 0.003
})
// Raw diagnostic: the resolution geometrically measured from the coupon itself.
const resolutionText = computed(() => {
  const px = result.value?.measuredPxPerMm
  return px != null && px > 0 ? resolutionRowValue(px) : null
})

// The shadow alert only fires on a single-scan result, where a second scan can fix it; for a
// combined pair the surviving residual is already carried as the flow tile's uncertainty.
const showShadowWarning = computed(() => {
  const r = result.value
  return !!r?.shadowWarning && r.scans.length <= 1
})
const shadowWarningText =
  'The scanner lamp shades one side of each gap in this scan, which biases the measured line width. Add a second scan of the same coupon rotated 180 degrees on the glass; the two orientations carry opposite biases that cancel in the combined result.'

// Per-scan card facts, shown when two scans were analyzed: each scan's own orientation,
// resolution, and block tally from the result's per-scan diagnostics. A scan the engine never
// reached (after an earlier scan failed) has no diagnostics entry and reads as not analyzed.
type CardSev = 'ok' | 'warn' | 'mute'
const CARD_ICON: Record<CardSev, string> = {
  ok: 'mdi-check-circle',
  warn: 'mdi-alert-circle',
  mute: 'mdi-minus-circle-outline',
}
const CARD_COLOR: Record<CardSev, string> = { ok: 'success', warn: 'warning', mute: 'grey' }
interface ScanCardRow {
  label: string
  value: string
  sev: CardSev
}
interface ScanCard {
  index: number
  title: string
  fileName: string
  bitmap: ImageBitmap
  rows: ScanCardRow[]
}
const scanCards = computed<ScanCard[]>(() => {
  const p = processing.value
  const r = p?.result
  const s = analyzedSpec.value
  if (!p || !r || !s || p.overlays.length < 2) return []
  return p.overlays.map((bitmap, i) => {
    const info = r.scans[i] ?? null
    const aligned = info !== null && info.measuredPxPerMm !== null
    const measured = info !== null && info.blocksMeasured > 0
    const rows: ScanCardRow[] = [
      {
        label: 'Flipped',
        value: aligned ? (info!.flipped ? 'yes' : 'no') : 'Not resolved',
        sev: aligned ? 'ok' : info ? 'warn' : 'mute',
      },
      {
        label: 'Rotation',
        value: aligned ? `${info!.rotationDegrees.toFixed(1)} degrees` : 'Not resolved',
        sev: aligned ? 'ok' : info ? 'warn' : 'mute',
      },
      {
        label: 'Resolution',
        value: resolutionRowValue(info?.measuredPxPerMm ?? undefined),
        sev: aligned ? 'ok' : 'mute',
      },
      {
        label: 'Blocks',
        value: measured ? `${info!.blocksMeasured} of ${2 * s.blockCount}` : 'Not measured',
        sev: measured ? 'ok' : 'mute',
      },
    ]
    return {
      index: i,
      title: `Scan ${i + 1}`,
      fileName: scanFiles.value[i]?.name ?? '',
      bitmap,
      rows,
    }
  })
})
</script>

<template>
  <v-container class="page">
    <header class="mb-4">
      <h1 class="text-h5 font-weight-bold">Flow calibration</h1>
      <p class="text-body-2 text-medium-emphasis mt-1">
        Print a single-color test coupon of comb lines at a swept line pitch and the app gives you
        the extrusion multiplier / flow correction to set.
      </p>
    </header>

    <!-- 1. Calibrate scanner (hard requirement: the analysis measures true pitch and gap in mm) -->
    <section class="step mb-3">
      <div class="step-row">
        <div class="step-head">
          <span class="num">1</span><span class="step-title">Calibrate scanner</span>
          <span class="status-inline">
            <v-icon :color="isCalibrated ? 'success' : 'warning'" size="15">
              {{ isCalibrated ? 'mdi-check-circle' : 'mdi-alert-circle-outline' }}
            </v-icon>
            <span class="text-medium-emphasis">{{ calibrationLine }}</span>
          </span>
        </div>
        <v-btn
          data-testid="em-calibrate-btn"
          :variant="isCalibrated ? 'text' : 'flat'"
          :color="isCalibrated ? undefined : 'primary'"
          size="small"
          @click="app.goCalibration()"
        >
          {{ isCalibrated ? 'Recalibrate' : 'Calibrate scanner' }}
        </v-btn>
      </div>
      <p v-if="!isCalibrated" class="text-body-2 text-medium-emphasis mt-2 mb-0">
        Required. The analysis measures the coupon in millimetres, which needs the true
        scanner resolution from the card calibration.
      </p>
    </section>

    <!-- 2. Printer profile -->
    <PrinterProfileCard :step="2" />

    <!-- 3. Test settings -->
    <section class="step mb-3">
      <div class="step-head mb-2">
        <span class="num">3</span><span class="step-title">Test settings</span>
        <v-spacer />
        <v-btn
          v-if="settingsStored"
          variant="tonal"
          color="warning"
          size="small"
          prepend-icon="mdi-restore"
          :disabled="analyzing"
          data-testid="em-settings-reset"
          @click="resetSettings"
        >
          Reset to defaults
        </v-btn>
      </div>
      <div class="field-group">
        <span class="group-label">Pitch sweep</span>
        <div class="fields">
          <NumericField v-model="pitchMin" label="Pitch min (mm)" :step="0.01" :min="0.01" :precision="4" />
          <NumericField v-model="pitchMax" label="Pitch max (mm)" :step="0.01" :min="0.01" :precision="4" />
          <NumericField v-model="blockCount" label="Blocks per row" :step="1" :min="3" />
          <NumericField v-model="linesPerBlock" label="Lines per block" :step="1" :min="2" />
        </div>
      </div>
      <div class="field-group mt-1">
        <span class="group-label">Print speed</span>
        <div class="fields">
          <NumericField v-model="printSpeed" label="Print speed (mm/s)" :step="1" :min="1" />
        </div>
      </div>
      <div class="field-group mt-1">
        <span class="group-label">Scanning plan</span>
        <div class="fields">
          <v-select
            v-model="scanPlace"
            :items="scanPlaceItems"
            label="How will you scan the print?"
            density="comfortable"
            hide-details
            data-testid="em-scan-plan"
          />
          <v-select
            v-model="partColors"
            :items="partColorsItems"
            label="Colors"
            density="comfortable"
            hide-details
            data-testid="em-part-colors"
          />
        </div>
        <p class="tip mb-0" data-testid="em-scan-plan-note">{{ scanPlanNote }}</p>
      </div>
      <div class="facts mt-2">
        <v-chip size="small" variant="tonal" prepend-icon="mdi-ruler-square">{{ footprintText }}</v-chip>
        <v-chip size="small" variant="tonal" prepend-icon="mdi-water">{{ flowText }}</v-chip>
        <span v-if="!canGenerate" class="tip mt-0">Choose a printer profile first.</span>
      </div>
      <v-alert
        v-if="exceedsA4"
        type="warning"
        variant="tonal"
        density="compact"
        class="mt-3 soft-alert"
        data-testid="em-a4-warning"
        text="The coupon is larger than A4. Most flatbed scanners cannot scan it in one pass. Reduce the block count or lines per block unless your scanner is larger."
      />
      <v-alert
        v-if="highFlow"
        type="warning"
        variant="tonal"
        density="compact"
        class="mt-3 soft-alert"
        data-testid="em-flow-warning"
        text="This volumetric flow is intended for high-flow hotends. A standard hotend may under-extrude and mask the real result."
      />
      <v-alert
        v-if="rampWarning"
        type="warning"
        variant="tonal"
        density="compact"
        class="mt-3 soft-alert"
        data-testid="em-ramp-warning"
        text="At this speed and acceleration the line middles never reach the commanded speed; lower the speed, raise the acceleration, or lengthen the lines."
      />
    </section>

    <!-- 4. Generate -->
    <section class="step mb-3">
      <div class="step-head mb-2">
        <span class="num">4</span><span class="step-title">Generate</span>
      </div>
      <div class="gen-row">
        <v-btn
          color="primary"
          prepend-icon="mdi-download"
          :disabled="!canGenerate"
          data-testid="em-generate"
          @click="generate"
        >
          Generate G-code
        </v-btn>
        <span v-if="filename" class="tip mt-0">{{ filename }}</span>
      </div>
      <v-alert
        v-if="generateError"
        type="error"
        variant="tonal"
        class="mt-3"
        :text="generateError"
        data-testid="em-generate-error"
      />
      <v-alert
        v-if="unknownVariables.length > 0"
        type="warning"
        variant="tonal"
        class="mt-3"
        :text="`Unknown slicer variables left as-is: ${unknownVariables.join(', ')}. Replace them with real values if your firmware does not resolve them.`"
        data-testid="em-unknown-variables-warning"
      />
      <v-alert
        v-if="templateWarnings.length > 0"
        type="warning"
        variant="tonal"
        class="mt-3"
        :text="templateWarnings.join(' ')"
        data-testid="em-template-warnings"
      />
    </section>

    <!-- 5. Scan the print -->
    <section class="step mb-3">
      <div class="step-head mb-1">
        <span class="num">5</span><span class="step-title">Scan the print</span>
      </div>
      <p class="tip mb-3">
        Scan the printed coupon top face down at the calibrated resolution. Place it with the
        test lines parallel to the direction the scanner lamp travels; a quarter turn lets the
        lamp shadow the narrow gaps and degrades the measurement. A second scan of the same
        coupon rotated 180 degrees on the glass is optional; it cancels the one-sided shading
        the lamp can add.
      </p>
      <div class="diagram-wrap mb-3">
        <EmScanOrientationDiagram />
      </div>
      <div class="fields mb-3">
        <NumericField
          v-model="currentFlow"
          label="Current slicer flow"
          :step="0.01"
          :min="0.01"
          :precision="3"
          :disabled="analyzing || result !== null"
          data-testid="em-current-flow"
        />
      </div>
      <p class="tip mb-3">
        Enter the current value from your slicer, either as an extrusion multiplier / flow
        ratio (0.96) or as a percentage (96). The corrected value is computed relative to
        this setting and is shown in the same format, so the analysis cannot run until it
        is entered.
      </p>
      <div class="scan-inputs mb-3">
        <label class="dropzone" :class="{ 'dropzone-disabled': !isCalibrated || analysisStarted }">
          <input
            type="file"
            accept="image/*"
            multiple
            class="file-input"
            :disabled="!isCalibrated || analyzing || analysisStarted"
            data-testid="em-scan-input"
            @change="onPickScans"
          />
          <v-icon
            size="28"
            :color="scanFiles.length > 0 ? 'success' : isCalibrated ? 'primary' : undefined"
          >
            {{ scanFiles.length > 0 ? 'mdi-check-circle' : 'mdi-image-plus' }}
          </v-icon>
          <span class="dz-label">Scan images</span>
          <span class="dz-sub">One scan is required; a second one rotated 180 degrees is optional.</span>
        </label>
        <div v-if="scanFiles.length > 0 && scanCards.length === 0" class="scan-files">
          <div
            v-for="(file, i) in scanFiles"
            :key="`${file.name}-${i}`"
            class="scan-file"
            :data-testid="`em-scan-file-${i}`"
          >
            <v-icon size="16" color="success">mdi-image-check</v-icon>
            <span class="scan-file-name">{{ file.name }}</span>
            <v-btn
              v-if="!analysisStarted"
              icon="mdi-close"
              size="x-small"
              variant="text"
              :aria-label="`Remove ${file.name}`"
              :data-testid="`em-scan-remove-${i}`"
              @click="removeScan(i)"
            />
          </div>
        </div>
        <p v-if="scanPickHint" class="tip mt-0 mb-0" data-testid="em-scan-pick-hint">
          {{ scanPickHint }}
        </p>
      </div>
      <p v-if="!isCalibrated" class="tip" data-testid="em-scan-needs-calibration">
        Calibrate the scanner first (step 1); the analysis needs the scanner's true
        resolution.
      </p>
      <div class="gen-row">
        <v-btn
          color="primary"
          prepend-icon="mdi-magnify-scan"
          :disabled="!canAnalyze"
          data-testid="em-analyze"
          @click="analyze"
        >
          Analyze
        </v-btn>
        <v-btn
          v-if="analysisStarted"
          variant="tonal"
          prepend-icon="mdi-restart"
          :disabled="analyzing"
          data-testid="em-start-over"
          @click="startOver"
        >
          Start over
        </v-btn>
        <div v-if="analyzing" class="d-flex align-center ga-2">
          <v-progress-circular indeterminate size="20" width="2" color="primary" />
          <span class="tip mt-0" data-testid="em-progress">{{ progressText || 'Analyzing the scan...' }}</span>
        </div>
      </div>
      <v-alert
        v-if="scanError"
        type="error"
        variant="tonal"
        class="mt-3"
        :text="scanError"
        data-testid="em-scan-error"
      />

      <div v-if="scanCards.length > 0" class="scan-cards mt-4" data-testid="em-scan-cards">
        <div v-for="card in scanCards" :key="card.index" class="island" :data-testid="`em-scan-card-${card.index}`">
          <button
            type="button"
            class="preview"
            :aria-label="`Show the ${card.title} overlay full size`"
            @click="zoomed = card.bitmap"
          >
            <OverlayCanvas :bitmap="card.bitmap" />
          </button>
          <div class="body">
            <div class="card-title">{{ card.title }}</div>
            <div
              v-if="card.fileName"
              class="card-subtitle"
              :data-testid="`em-scan-card-file-${card.index}`"
            >
              {{ card.fileName }}
            </div>
            <div class="status">
              <template v-for="r in card.rows" :key="r.label">
                <v-icon :color="CARD_COLOR[r.sev]" size="16">{{ CARD_ICON[r.sev] }}</v-icon>
                <span class="slabel">{{ r.label }}</span>
                <span class="sval" :class="r.sev">{{ r.value }}</span>
              </template>
            </div>
          </div>
        </div>
      </div>

      <v-dialog
        :model-value="zoomed !== null"
        max-width="1100"
        @update:model-value="zoomed = null"
      >
        <v-card class="pa-2">
          <OverlayCanvas v-if="zoomed" :bitmap="zoomed" />
        </v-card>
      </v-dialog>
    </section>

    <!-- 6. Result -->
    <section v-if="result" class="step mb-3">
      <div class="step-head mb-3">
        <span class="num">6</span><span class="step-title">Result</span>
      </div>

      <template v-if="result.success">
        <div class="tiles mb-3">
          <MetricTile
            v-if="newSlicerFlow"
            label="New slicer flow"
            :value="newSlicerFlow"
            testid="em-flow"
          />
          <MetricTile
            label="Measured line width"
            :value="`${result.wMm!.toFixed(3)} mm`"
            testid="em-width"
          />
          <MetricTile
            label="Blocks measured"
            :value="`${result.blocksMeasured} of ${2 * analyzedSpec!.blockCount * Math.max(result.scans.length, 1)}`"
            testid="em-blocks"
          />
        </div>
        <div class="facts mb-3">
          <v-chip
            v-if="resolutionText"
            size="small"
            variant="tonal"
            prepend-icon="mdi-magnify-scan"
            data-testid="em-resolution"
          >
            resolution {{ resolutionText }}
          </v-chip>
          <v-chip size="small" variant="tonal" prepend-icon="mdi-scale-balance" data-testid="em-bias">
            separator check {{ result.biasMm!.toFixed(3) }} mm
          </v-chip>
          <v-chip size="small" variant="tonal" prepend-icon="mdi-arrow-expand-horizontal" data-testid="em-pitch-scale">
            pitch scale {{ result.pitchScale!.toFixed(4) }}
          </v-chip>
          <v-chip
            v-if="result.flankAsymmetryMm !== null"
            size="small"
            variant="tonal"
            prepend-icon="mdi-mirror"
            data-testid="em-flank-asymmetry"
          >
            flank asymmetry {{ result.flankAsymmetryMm.toFixed(3) }} mm
          </v-chip>
          <v-chip
            v-if="pitchScaleOff"
            size="small"
            variant="tonal"
            color="warning"
            prepend-icon="mdi-alert-outline"
            data-testid="em-pitch-warning"
          >
            printer scale is off; run the skew and size calibration
          </v-chip>
        </div>
        <v-alert
          v-if="showShadowWarning"
          type="warning"
          variant="tonal"
          class="mb-3"
          data-testid="em-shadow-warning"
          :text="shadowWarningText"
        />
        <template v-if="correction">
          <CodeBlock :code="correction.command" data-testid="em-code" />
          <p class="tip mt-0">
            The slicer flow value is the permanent fix; the M221 command only affects the
            current firmware session.
          </p>
        </template>
      </template>

      <v-alert
        v-else
        type="error"
        variant="tonal"
        class="mb-3"
        :text="result.failureReason ?? 'The scan could not be analyzed.'"
        data-testid="em-failure"
      />

      <OverlayCanvas
        v-if="processing && processing.overlays.length === 1"
        :bitmap="processing.overlays[0]"
        label="Detected blocks and measurements"
        class="mt-3"
      />
    </section>

    <p class="tip">
      <v-icon size="14" class="mr-1">mdi-information-outline</v-icon>
      The result is only valid near the printed speed. Filament diameter variation limits
      repeatability to about 1%.
    </p>
  </v-container>
</template>

<style scoped>
.step-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.status-inline {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
}
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
.diagram-wrap {
  display: flex;
  justify-content: center;
}
.fields {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.fields > * {
  flex: 1 1 160px;
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
.gen-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
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
.dropzone-disabled {
  border-color: rgba(var(--v-theme-on-surface), 0.25);
  cursor: not-allowed;
  opacity: 0.6;
}
.dropzone-disabled:hover {
  border-color: rgba(var(--v-theme-on-surface), 0.25);
}
.file-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.file-input:disabled {
  cursor: not-allowed;
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
.scan-inputs {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.scan-files {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.scan-file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px 2px 8px;
  border-radius: 8px;
  background: rgb(var(--v-theme-surface-bright));
}
.scan-file-name {
  font-size: 12.5px;
  overflow-wrap: anywhere;
  flex: 1;
}
.scan-cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.island {
  display: flex;
  background: rgb(var(--v-theme-surface-bright));
  border: 1px solid rgba(var(--v-theme-on-surface), 0.09);
  border-radius: 12px;
  overflow: hidden;
}
.preview {
  flex: 0 0 200px;
  background: rgb(var(--v-theme-background));
  border: none;
  border-right: 1px solid rgba(var(--v-theme-on-surface), 0.09);
  min-height: 150px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  cursor: zoom-in;
}
.body {
  flex: 1 1 320px;
  padding: 14px 16px;
  min-width: 0;
}
.card-title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 10px;
}
.card-subtitle {
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), 0.62);
  overflow-wrap: anywhere;
  margin-top: -8px;
  margin-bottom: 10px;
}
.status {
  display: grid;
  grid-template-columns: 18px 86px 1fr;
  row-gap: 9px;
  column-gap: 8px;
  align-items: center;
}
.slabel {
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), 0.62);
}
.sval {
  font-size: 12.75px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.sval.ok {
  color: rgb(var(--v-theme-success));
}
.sval.warn {
  color: rgb(var(--v-theme-warning));
}
.sval.mute {
  color: rgba(var(--v-theme-on-surface), 0.42);
  font-weight: 500;
}
@media (max-width: 560px) {
  .island {
    flex-direction: column;
  }
  .preview {
    flex-basis: auto;
    border-right: none;
    border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.09);
    height: 220px;
  }
  .body {
    flex: 0 0 auto;
  }
}
</style>
