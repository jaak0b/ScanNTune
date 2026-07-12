<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useApp } from '../stores/useApp'
import { useCalibration } from '../stores/useCalibration'
import { usePrinterProfiles } from '../stores/usePrinterProfiles'
import { readBytes } from '../util/preview'
import { scaleReferenceAtDpi } from '../engine/scannerCalibration'
import { resolutionRowValue } from '../util/scanResolution'
import { analyzeEmScan } from '../workerClient'
import type { EmProcessing } from '../workerClient'
import { emCorrection } from '../engine/em/emCorrectionFormatter'
import { generateEmGcodeWithReport, HIGH_FLOW_WARNING_THRESHOLD_MM3_S } from '../engine/em/gcodeGenerator'
import {
  accelRampMm,
  defaultEmTestSpec,
  emCouponGeometry,
  volumetricFlowMm3S,
  type EmProgress,
  type EmTestSpec,
} from '../engine/em/types'
import { fitsA4 } from '../engine/gcode/emitter'
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

// Spec defaults follow the selected printer; the fields start prefilled with them and
// refill whenever another printer is selected (edits between switches are one-shot).
const specDefaults = computed(() => defaultEmTestSpec(store.selected ?? defaultPrinterProfile()))
const pitchMin = ref<number | null>(specDefaults.value.pitchMinMm)
const pitchMax = ref<number | null>(specDefaults.value.pitchMaxMm)
const blockCount = ref<number | null>(specDefaults.value.blockCount)
const linesPerBlock = ref<number | null>(specDefaults.value.linesPerBlock)
const printSpeed = ref<number | null>(specDefaults.value.printSpeedMmS)
// The placement and contrasting-base spec fields are driven by two scanning choices:
// where the scan happens (removed part vs the whole build plate on the scanner, the
// latter for filaments that will not come off, e.g. TPU or PETG), and, for a removed
// part only, whether a contrasting base is printed under the coupon. Scanning with the
// plate is always a single-color print at the bed's front edge so the plate edge can
// lie on the glass with the rest overhanging.
type ScanPlace = 'part' | 'plate'
type PartColors = 'single' | 'base'
const scanPlace = ref<ScanPlace>('part')
const partColors = ref<PartColors>('single')
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

watch(
  () => store.selected?.id,
  () => {
    pitchMin.value = specDefaults.value.pitchMinMm
    pitchMax.value = specDefaults.value.pitchMaxMm
    blockCount.value = specDefaults.value.blockCount
    linesPerBlock.value = specDefaults.value.linesPerBlock
    printSpeed.value = specDefaults.value.printSpeedMmS
    scanPlace.value = 'part'
    partColors.value = 'single'
  },
)

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
const highFlow = computed(
  () => volumetricFlowMm3S(spec.value, layerHeight.value) > HIGH_FLOW_WARNING_THRESHOLD_MM3_S,
)
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

// Scan card state. While an analysis runs, the upload and flow controls are locked.
const analyzing = ref(false)
const progressText = ref('')
const scanError = ref('')
// The user's CURRENT slicer flow, entered either as a factor (PrusaSlicer extrusion
// multiplier / Orca flow ratio, e.g. 0.96) or as a percent (Cura-style, e.g. 96). Values
// above 5 are read as percent; real factors live near 1 and real percents near 100, so the
// two ranges cannot collide. The corrected value is echoed back in the same style.
const currentFlow = ref<number | null>(1)

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
  processing.value?.overlay.close()
  processing.value = null
  analyzedSpec.value = null
}

onBeforeUnmount(resetProcessing)

async function onPick(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  // Clear the input so picking the same file again still fires change.
  input.value = ''
  // A disabled input still receives drops in some browsers; the calibration is a hard
  // requirement and a running analysis must not be doubled up.
  if (!file || analyzing.value || !calibration.calibration) return
  const usedSpec = spec.value
  const cal = calibration.calibration
  analyzing.value = true
  progressText.value = 'Reading the scan'
  scanError.value = ''
  resetProcessing()
  try {
    const bytes = await readBytes(file)
    // The calibration's scale error holds across resolutions; the scan is expected at the
    // calibration DPI, so the calibration is priced at exactly that resolution.
    const scanPxPerMm = scaleReferenceAtDpi(cal, cal.dpi)
    processing.value = await analyzeEmScan(bytes, usedSpec, scanPxPerMm, cal.dpi, onProgress)
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
  const entered = currentFlow.value ?? 1
  const isPercent = entered > 5
  const factor = isPercent ? entered / 100 : entered
  const corrected = factor * (s.nominalLineWidthMm / r.wMm)
  return isPercent ? `${(corrected * 100).toFixed(1)}%` : corrected.toFixed(3)
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
        test lines parallel to the direction the scanner lamp travels; rotating the coupon
        180 degrees is fine, but 90 degrees lets the lamp shadow the narrow gaps and degrades
        the measurement. Then drop the image in.
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
          :disabled="analyzing"
          data-testid="em-current-flow"
        />
      </div>
      <p class="tip mb-3">
        Enter the current value from your slicer, either as an extrusion multiplier / flow
        ratio (0.96) or as a percentage (96). The result shows the corrected value in the
        same format.
      </p>
      <label class="dropzone" :class="{ 'dropzone-disabled': !isCalibrated }">
        <input
          type="file"
          accept="image/*"
          class="file-input"
          :disabled="!isCalibrated || analyzing"
          data-testid="em-scan-input"
          @change="onPick"
        />
        <v-icon size="28" :color="isCalibrated ? 'primary' : undefined">mdi-image-plus</v-icon>
        <span class="dz-label">Choose the scan image</span>
        <span class="dz-sub">or drop it here</span>
      </label>
      <p v-if="!isCalibrated" class="tip" data-testid="em-scan-needs-calibration">
        Calibrate the scanner first (step 1); the analysis needs the scanner's true
        resolution.
      </p>
      <div v-if="analyzing" class="d-flex align-center ga-2 mt-3">
        <v-progress-circular indeterminate size="20" width="2" color="primary" />
        <span class="tip mt-0" data-testid="em-progress">{{ progressText || 'Analyzing the scan...' }}</span>
      </div>
      <v-alert
        v-if="scanError"
        type="error"
        variant="tonal"
        class="mt-3"
        :text="scanError"
        data-testid="em-scan-error"
      />
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
            :value="`${result.blocksMeasured} of ${2 * analyzedSpec!.blockCount}`"
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
          v-if="result.shadowWarning"
          type="warning"
          variant="tonal"
          class="mb-3"
          data-testid="em-shadow-warning"
          text="Rotate the coupon 90 degrees on the scanner glass and rescan. The scanner lamp casts a one-sided shadow across the lines in this orientation, which inflates the measured bead width."
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
        v-if="processing?.overlay"
        :bitmap="processing.overlay"
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
</style>
