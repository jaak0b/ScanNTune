<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useApp } from '../stores/useApp'
import { useCalibration } from '../stores/useCalibration'
import { usePrinterProfiles } from '../stores/usePrinterProfiles'
import { readBytes } from '../util/preview'
import { scaleReferenceAtDpi } from '../engine/scannerCalibration'
import { analyzeIsScans } from '../workerClient'
import type { IsResult } from '../engine/is/resultTypes'
import type { Firmware } from '../engine/gcode/profileTypes'
import {
  generateIsGcodeWithReport,
  HIGH_FLOW_WARNING_THRESHOLD_MM3_S,
} from '../engine/is/gcodeGenerator'
import {
  defaultIsTestSpec,
  fitSpecToBed,
  MIN_CORNER_SPEED_MM_S,
  rampWarnings,
  validateIsSpec,
  type IsAxis,
  type IsTestSpec,
} from '../engine/is/types'
import { isCouponGeometry } from '../engine/is/couponGeometry'
import { NOMINAL_WIDTH_FACTOR } from '../engine/gcode/emitter'
import { defaultPrinterProfile } from '../engine/pa/types'
import PrinterProfileCard from './PrinterProfileCard.vue'
import IsGuideDiagram from './IsGuideDiagram.vue'
import IsResultsCard from './IsResultsCard.vue'
import NumericField from './NumericField.vue'

const app = useApp()
const store = usePrinterProfiles()

// The scan step measures the ringing wavelength in true millimetres, which needs the
// card-derived px/mm; generation itself does not depend on the calibration.
const calibration = useCalibration()
const isCalibrated = computed(() => calibration.calibration !== null)
const calibrationLine = computed(() =>
  isCalibrated.value
    ? `${Math.round(calibration.calibration!.dpi)} dpi`
    : 'Not calibrated',
)

// Spec defaults follow the selected printer; the fields start prefilled with them and
// refill whenever another printer is selected (edits between switches are one-shot).
const specDefaults = computed(() => defaultIsTestSpec(store.selected ?? defaultPrinterProfile()))
const tierSpeed = ref<number | null>(specDefaults.value.speedsMmS[0])
const cornerSpeed = ref<number | null>(specDefaults.value.cornerSpeedMmS)
const linesPerSpeed = ref<number | null>(specDefaults.value.linesPerSpeed)
const measuredLine = ref<number | null>(specDefaults.value.measuredLineMm)
const linePitch = ref<number | null>(specDefaults.value.linePitchMm)
type AxisChoice = 'both' | 'x' | 'y'
const axisChoice = ref<AxisChoice>('both')
const axisItems = [
  { title: 'X and Y', value: 'both' },
  { title: 'X only', value: 'x' },
  { title: 'Y only', value: 'y' },
]

watch(
  () => store.selected?.id,
  () => {
    tierSpeed.value = specDefaults.value.speedsMmS[0]
    cornerSpeed.value = specDefaults.value.cornerSpeedMmS
    linesPerSpeed.value = specDefaults.value.linesPerSpeed
    measuredLine.value = specDefaults.value.measuredLineMm
    linePitch.value = specDefaults.value.linePitchMm
    axisChoice.value = 'both'
  },
)

const spec = computed<IsTestSpec>(() => {
  return {
    ...specDefaults.value,
    speedsMmS: [tierSpeed.value ?? specDefaults.value.speedsMmS[0]],
    cornerSpeedMmS: cornerSpeed.value ?? specDefaults.value.cornerSpeedMmS,
    linesPerSpeed: linesPerSpeed.value ?? specDefaults.value.linesPerSpeed,
    measuredLineMm: measuredLine.value ?? specDefaults.value.measuredLineMm,
    linePitchMm: linePitch.value ?? specDefaults.value.linePitchMm,
    axes: (axisChoice.value === 'both' ? ['x', 'y'] : [axisChoice.value]) as IsAxis[],
  }
})

// The spec as the generator will actually print it: validated, then shrunk to the
// configured bed with a user-worded note per reduction. Validation and fitting failures
// both surface as the error text.
const fitted = computed<{ spec: IsTestSpec; notes: string[] } | { error: string }>(() => {
  try {
    validateIsSpec(spec.value)
    return fitSpecToBed(spec.value, store.selected ?? defaultPrinterProfile())
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
})
const fitError = computed(() => ('error' in fitted.value ? fitted.value.error : ''))
const fittedSpec = computed(() => ('spec' in fitted.value ? fitted.value.spec : null))
const fitNotes = computed(() => ('notes' in fitted.value ? fitted.value.notes : []))

const tiersText = computed(() =>
  fittedSpec.value ? `speeds ${fittedSpec.value.speedsMmS.join(' / ')} mm/s` : '',
)
const footprintText = computed(() => {
  if (!fittedSpec.value) return ''
  const g = isCouponGeometry(fittedSpec.value)
  return `coupon ${Math.round(g.couponWidthMm)} x ${Math.round(g.couponHeightMm)} mm`
})
const rampNotes = computed(() => (fittedSpec.value ? rampWarnings(fittedSpec.value) : []))
// The acceleration is not editable here: it comes from the printer profile, floored by
// the generator when the profile value is too weak for a readable trace.
const accelNote = computed(() => {
  const p = store.selected
  if (!p || !fittedSpec.value) return ''
  const a = fittedSpec.value.accelMmS2
  return a > p.printAccelMmS2
    ? `The test accelerates at ${a} mm/s^2, raised above the profile's ` +
      `${p.printAccelMmS2} mm/s^2 because a weaker ramp leaves too faint a ringing trace.`
    : `The test accelerates at the profile's ${a} mm/s^2 print acceleration.`
})
const highFlowText = computed(() => {
  const s = fittedSpec.value
  const p = store.selected
  if (!s || !p) return ''
  const nominal = p.nozzleDiameterMm * NOMINAL_WIDTH_FACTOR
  const flow = Math.max(...s.speedsMmS) * nominal * p.layerHeightMm
  if (flow <= HIGH_FLOW_WARNING_THRESHOLD_MM3_S) return ''
  return (
    `The selected line speed extrudes ${flow.toFixed(1)} mm^3/s of filament; a typical ` +
    `hotend melts about ${HIGH_FLOW_WARNING_THRESHOLD_MM3_S} mm^3/s and thins the lines ` +
    'above that. The ringing wavelength is still readable from slightly thinned lines.'
  )
})

const generateError = ref('')
const unknownVariables = ref<string[]>([])
const templateWarnings = ref<string[]>([])
const canGenerate = computed(() => store.selected !== null && store.selectedFilament !== null)

function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'printer'
}
const filename = computed(() =>
  store.selected ? `is_resonance_test_${sanitizeName(store.selected.name)}.gcode` : '',
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
    const report = generateIsGcodeWithReport(profile, filament, spec.value)
    gcode = report.gcode
    unknownVariables.value = report.unknownVariables
    templateWarnings.value = report.warnings
  } catch (e) {
    generateError.value = e instanceof Error ? e.message : String(e)
    console.error('Input shaper G-code generation failed', e)
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

// Scan card state: the two scans of the same printed coupon, held page-locally like the other
// flows hold their scan state. Each axis group is only read along the scanner's sensor rows,
// which is why the part is scanned twice, a quarter turn apart. The analyzer assigns each
// axis group to the scan that reads it along the sensor rows, so the pick order is free.
const scanFiles = ref<File[]>([])
const scanPickHint = ref('')
const analyzing = ref(false)
const scanError = ref('')
const result = shallowRef<IsResult | null>(null)
// The firmware the current result was analyzed under, so the snippet stays consistent even if
// the profile selection changes afterwards.
const analyzedFirmware = ref<Firmware>('Klipper')

function onPickScans(e: Event): void {
  const input = e.target as HTMLInputElement
  const picked = Array.from(input.files ?? [])
  // Clear the input so picking the same file again still fires change.
  input.value = ''
  if (picked.length === 0 || analyzing.value) return
  scanPickHint.value = ''
  const room = 2 - scanFiles.value.length
  if (picked.length > room) {
    scanPickHint.value =
      'The analysis uses exactly two scan images. The files beyond the first two were not added.'
  }
  scanFiles.value = [...scanFiles.value, ...picked.slice(0, Math.max(0, room))]
}

function removeScan(index: number): void {
  if (analyzing.value) return
  scanFiles.value = scanFiles.value.filter((_, i) => i !== index)
  scanPickHint.value = ''
}

const canAnalyze = computed(
  () =>
    scanFiles.value.length === 2 &&
    isCalibrated.value &&
    fittedSpec.value !== null &&
    !analyzing.value,
)

async function analyze(): Promise<void> {
  const [fileA, fileB] = scanFiles.value
  const cal = calibration.calibration
  // The analysis measures the print as generated, so it runs against the bed-fitted spec.
  const usedSpec = fittedSpec.value
  if (!fileA || !fileB || !cal || !usedSpec || analyzing.value) return
  analyzing.value = true
  scanError.value = ''
  result.value = null
  try {
    const [bytesA, bytesB] = await Promise.all([readBytes(fileA), readBytes(fileB)])
    // The calibration's scale error holds across resolutions; the scan is expected at the
    // calibration DPI, so the calibration is priced at exactly that resolution.
    const scanPxPerMm = scaleReferenceAtDpi(cal, cal.dpi)
    result.value = await analyzeIsScans(bytesA, bytesB, usedSpec, scanPxPerMm)
    analyzedFirmware.value = store.selected?.firmware ?? 'Klipper'
  } catch (err) {
    console.error('Input shaper scan analysis failed', err)
    scanError.value = err instanceof Error ? err.message : String(err)
  } finally {
    analyzing.value = false
  }
}
</script>

<template>
  <v-container class="page">
    <header class="mb-4">
      <h1 class="text-h5 font-weight-bold">Input shaper calibration</h1>
      <p class="text-body-2 text-medium-emphasis mt-1">
        Print a resonance test coupon whose lines record the ringing after a sharp corner.
        Two scans of the coupon measure the resonance frequency and damping per axis and
        give the input shaper values to set.
      </p>
    </header>

    <!-- 1. Calibrate scanner (needed for the later scan step, not for generation) -->
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
          data-testid="is-calibrate-btn"
          :variant="isCalibrated ? 'text' : 'flat'"
          :color="isCalibrated ? undefined : 'primary'"
          size="small"
          @click="app.goCalibration()"
        >
          {{ isCalibrated ? 'Recalibrate' : 'Calibrate scanner' }}
        </v-btn>
      </div>
      <p v-if="!isCalibrated" class="text-body-2 text-medium-emphasis mt-2 mb-0">
        Required before the scan step. The analysis measures the ringing in millimetres,
        which needs the true scanner resolution from the card calibration. Generating the
        test print works without it.
      </p>
    </section>

    <!-- 2. Printer profile -->
    <PrinterProfileCard :step="2" />

    <!-- 3. Test settings -->
    <section class="step mb-3">
      <div class="step-head mb-2">
        <span class="num">3</span><span class="step-title">Test settings</span>
      </div>
      <div class="diagram-wrap mb-3">
        <IsGuideDiagram />
      </div>
      <div class="field-group">
        <span class="group-label">Speeds</span>
        <p class="tip mt-0 mb-2">
          The corner between the run-up and the measured line is taken at the corner speed
          without deceleration; higher values ring the frame harder and make the waves
          easier to read. Lower the corner speed if the print shifts layers: a corner
          taken too fast for the machine skips motor steps.
        </p>
        <p class="tip mt-0 mb-2">
          The line speed is the cruise speed of the measured lines and cannot be below the
          corner speed. The printer profile's travel speed only applies to moves between
          lines and does not affect the measurement.
        </p>
        <div class="fields">
          <NumericField
            v-model="tierSpeed"
            label="Line speed (mm/s)"
            :step="10"
            :min="cornerSpeed ?? MIN_CORNER_SPEED_MM_S"
            data-testid="is-tier-speed"
          />
          <NumericField
            v-model="cornerSpeed"
            label="Corner speed (mm/s)"
            :step="10"
            :min="MIN_CORNER_SPEED_MM_S"
            data-testid="is-corner-speed"
          />
        </div>
        <p v-if="accelNote" class="tip mb-0">{{ accelNote }}</p>
      </div>
      <div class="field-group mt-1">
        <span class="group-label">Test lines</span>
        <p class="tip mt-0 mb-2">
          The clean read length is the guaranteed undisturbed stretch of every line after
          the corner's acceleration ramp. It should cover at least five wavelengths of the
          lowest resonance of interest at the tier speed. The printed lines are longer:
          they continue into the zone where the two axis groups cross.
        </p>
        <p class="tip mt-0 mb-2">
          The line pitch only needs raising when neighbouring lines touch on a strongly
          ringing printer: it must exceed twice the ringing amplitude plus the line width.
        </p>
        <div class="fields">
          <NumericField v-model="linesPerSpeed" label="Lines per speed" :step="1" :min="3" />
          <NumericField v-model="measuredLine" label="Clean read length (mm)" :step="5" :min="20" />
          <NumericField v-model="linePitch" label="Line pitch (mm)" :step="0.1" :min="0.1" :precision="2" />
        </div>
      </div>
      <div class="field-group mt-1">
        <span class="group-label">Axes</span>
        <div class="fields">
          <v-select
            v-model="axisChoice"
            :items="axisItems"
            label="Axes to test"
            density="comfortable"
            hide-details
            data-testid="is-axes"
          />
        </div>
      </div>
      <div class="facts mt-2">
        <v-chip
          v-if="tiersText"
          size="small"
          variant="tonal"
          prepend-icon="mdi-speedometer"
          data-testid="is-tiers"
        >
          {{ tiersText }}
        </v-chip>
        <v-chip
          v-if="footprintText"
          size="small"
          variant="tonal"
          prepend-icon="mdi-ruler-square"
          data-testid="is-footprint"
        >
          {{ footprintText }}
        </v-chip>
        <span v-if="!canGenerate" class="tip mt-0">Choose a printer profile first.</span>
      </div>
      <v-alert
        v-if="fitError"
        type="error"
        variant="tonal"
        density="compact"
        class="mt-3 soft-alert"
        :text="fitError"
        data-testid="is-fit-error"
      />
      <v-alert
        v-if="fitNotes.length > 0"
        type="info"
        variant="tonal"
        density="compact"
        class="mt-3 soft-alert"
        :text="fitNotes.join(' ')"
        data-testid="is-fit-notes"
      />
      <v-alert
        v-if="rampNotes.length > 0"
        type="warning"
        variant="tonal"
        density="compact"
        class="mt-3 soft-alert"
        :text="rampNotes.join(' ')"
        data-testid="is-ramp-warning"
      />
      <v-alert
        v-if="highFlowText"
        type="warning"
        variant="tonal"
        density="compact"
        class="mt-3 soft-alert"
        data-testid="is-flow-warning"
        :text="highFlowText"
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
          data-testid="is-generate"
          @click="generate"
        >
          Generate G-code
        </v-btn>
        <span v-if="filename" class="tip mt-0">{{ filename }}</span>
      </div>
      <p class="tip mb-0" data-testid="is-restart-note">
        Restart the firmware after the print finishes. The test overrides the printer's
        motion limits, and the restart restores the configured values.
      </p>
      <v-alert
        v-if="generateError"
        type="error"
        variant="tonal"
        class="mt-3"
        :text="generateError"
        data-testid="is-generate-error"
      />
      <v-alert
        v-if="unknownVariables.length > 0"
        type="warning"
        variant="tonal"
        class="mt-3"
        :text="`Unknown slicer variables left as-is: ${unknownVariables.join(', ')}. Replace them with real values if your firmware does not resolve them.`"
        data-testid="is-unknown-variables-warning"
      />
      <v-alert
        v-if="templateWarnings.length > 0"
        type="warning"
        variant="tonal"
        class="mt-3"
        :text="templateWarnings.join(' ')"
        data-testid="is-template-warnings"
      />
    </section>

    <!-- 5. Scan the print -->
    <section class="step mb-3">
      <div class="step-head mb-1">
        <span class="num">5</span><span class="step-title">Scan the print</span>
      </div>
      <p class="tip mb-3">
        Scan the coupon face down, then rotate the part a quarter turn on the glass and scan
        again. Both scans are needed because each line group is only read along the
        scanner's accurate axis; the order of the two images does not matter. Scan at the
        calibrated resolution with the lid closed.
      </p>
      <div class="scan-inputs mb-3">
        <label class="dropzone" :class="{ 'dropzone-disabled': !isCalibrated }">
          <input
            type="file"
            accept="image/*"
            multiple
            class="file-input"
            :disabled="!isCalibrated || analyzing"
            data-testid="is-scan-input"
            @change="onPickScans($event)"
          />
          <v-icon
            size="28"
            :color="scanFiles.length === 2 ? 'success' : isCalibrated ? 'primary' : undefined"
          >
            {{ scanFiles.length === 2 ? 'mdi-check-circle' : 'mdi-image-plus' }}
          </v-icon>
          <span class="dz-label">Scan images</span>
          <span class="dz-sub">Choose both scans of the coupon</span>
        </label>
        <div v-if="scanFiles.length > 0" class="scan-files">
          <div
            v-for="(file, i) in scanFiles"
            :key="`${file.name}-${i}`"
            class="scan-file"
            :data-testid="`is-scan-file-${i}`"
          >
            <v-icon size="16" color="success">mdi-image-check</v-icon>
            <span class="scan-file-name">{{ file.name }}</span>
            <v-btn
              icon="mdi-close"
              size="x-small"
              variant="text"
              :disabled="analyzing"
              :aria-label="`Remove ${file.name}`"
              :data-testid="`is-scan-remove-${i}`"
              @click="removeScan(i)"
            />
          </div>
        </div>
        <p v-if="scanFiles.length < 2" class="tip mt-0 mb-0" data-testid="is-scan-count-hint">
          Two scan images are needed: the upright scan and the quarter-turned scan.
        </p>
        <p v-if="scanPickHint" class="tip mt-0 mb-0" data-testid="is-scan-pick-hint">
          {{ scanPickHint }}
        </p>
      </div>
      <p v-if="!isCalibrated" class="tip" data-testid="is-scan-needs-calibration">
        Calibrate the scanner first (step 1); the analysis needs the scanner's true
        resolution.
      </p>
      <div class="gen-row">
        <v-btn
          color="primary"
          prepend-icon="mdi-waveform"
          :disabled="!canAnalyze"
          data-testid="is-analyze"
          @click="analyze"
        >
          Analyze scans
        </v-btn>
        <div v-if="analyzing" class="d-flex align-center ga-2">
          <v-progress-circular indeterminate size="20" width="2" color="primary" />
          <span class="tip mt-0" data-testid="is-progress">Analyzing the scans...</span>
        </div>
      </div>
      <v-alert
        v-if="scanError"
        type="error"
        variant="tonal"
        class="mt-3"
        :text="scanError"
        data-testid="is-scan-error"
      />
    </section>

    <!-- 6. Result -->
    <section v-if="result" class="step mb-3">
      <div class="step-head mb-3">
        <span class="num">6</span><span class="step-title">Result</span>
      </div>
      <IsResultsCard :result="result" :firmware="analyzedFirmware" />
    </section>

    <p class="tip">
      <v-icon size="14" class="mr-1">mdi-information-outline</v-icon>
      Print the coupon with the downloaded file and keep the finished part flat until it is
      scanned.
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
  overflow-wrap: anywhere;
  text-align: center;
}
</style>
