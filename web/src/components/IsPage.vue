<script setup lang="ts">
import { computed, ref } from 'vue'
import { useApp } from '../stores/useApp'
import { usePrinterProfiles } from '../stores/usePrinterProfiles'
import { useIsSettings } from '../stores/useIsSettings'
import { useCalibrationGate } from '../composables/useCalibrationGate'
import { useFlowSettingsForm } from '../composables/useFlowSettingsForm'
import { useScanAnalysis } from '../composables/useScanAnalysis'
import { PART_COLORS_ITEMS, SCAN_PLACE_ITEMS, scanPlanNoteText } from '../model/scanPlan'
import type { PartColors, ScanPlace, ScanPlanTexts } from '../model/scanPlan'
import { readBytes } from '../util/preview'
import { scaleReferenceAtDpi } from '../engine/scannerCalibration'
import {
  evaluateScanSetResolution,
  expectedFromCalibration,
  resolutionBadge,
  resolutionRowValue,
} from '../util/scanResolution'
import type { ScanResolutionVerdict } from '../util/scanResolution'
import { analyzeIsScans } from '../workerClient'
import type { IsProcessing } from '../workerClient'
import type { Firmware } from '../engine/gcode/profileTypes'
import { generateIsGcodeWithReport } from '../engine/is/gcodeGenerator'
import { flowWarningLimitMm3S } from '../engine/gcode/emitter'
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
import IsFirstScanDiagram from './IsFirstScanDiagram.vue'
import IsSecondScanDiagram from './IsSecondScanDiagram.vue'
import IsResultsCard from './IsResultsCard.vue'
import NumericField from './NumericField.vue'
import OverlayCanvas from './OverlayCanvas.vue'

const app = useApp()
const store = usePrinterProfiles()

// The scan step measures the ringing wavelength in true millimetres, which needs the
// card-derived px/mm; generation itself does not depend on the calibration.
const { calibration, isCalibrated, calibrationLine } = useCalibrationGate()

// Spec defaults follow the selected printer. The fields are persisted per printer profile;
// with nothing stored for the selected profile they fall back to the spec defaults, and a
// profile switch re-applies that profile's stored settings or defaults.
const specDefaults = computed(() => defaultIsTestSpec(store.selected ?? defaultPrinterProfile()))
const isSettings = useIsSettings()
const {
  form: settingsForm,
  hasStored: settingsStored,
  reset: resetSettings,
} = useFlowSettingsForm(
  isSettings,
  () => ({
    lineSpeedMmS: specDefaults.value.speedsMmS[0],
    cornerSpeedMmS: specDefaults.value.cornerSpeedMmS,
    linesPerSpeed: specDefaults.value.linesPerSpeed,
    measuredLineMm: specDefaults.value.measuredLineMm,
    linePitchMm: specDefaults.value.linePitchMm,
    sweep: specDefaults.value.sweep,
    sweepFromHz: specDefaults.value.sweepFromHz,
    sweepToHz: specDefaults.value.sweepToHz,
    sweepCycles: specDefaults.value.sweepCycles,
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
  lineSpeedMmS: tierSpeed,
  cornerSpeedMmS: cornerSpeed,
  linesPerSpeed,
  measuredLineMm: measuredLine,
  linePitchMm: linePitch,
  sweep,
  sweepFromHz,
  sweepToHz,
  sweepCycles,
  scanPlace,
  partColors,
} = settingsForm
const scanPlaceItems = SCAN_PLACE_ITEMS
const partColorsItems = PART_COLORS_ITEMS
const scanPlanTexts: ScanPlanTexts = {
  platePlacement:
    'The coupon prints at the front edge of the bed so the plate edge can rest on the ' +
    'scanner glass. Use this for filaments that are hard to remove, like TPU or PETG.',
  plateBase:
    ' The contrasting base backs the open window, so the build plate surface does not matter.',
  plateSingle:
    ' Use a light, even build plate; a dark or textured plate shows through the window and the scan is refused.',
  partBase:
    'A base prints in a second color under the coupon, with a filament swap pause ' +
    'between them. The two filaments must differ in brightness.',
  partSingle:
    'The filament color must contrast with the backing, either the lid or a sheet of paper.',
}
const scanPlanNote = computed(() =>
  scanPlanNoteText(scanPlace.value, partColors.value, scanPlanTexts),
)

const spec = computed<IsTestSpec>(() => {
  return {
    ...specDefaults.value,
    speedsMmS: [tierSpeed.value ?? specDefaults.value.speedsMmS[0]],
    cornerSpeedMmS: cornerSpeed.value ?? specDefaults.value.cornerSpeedMmS,
    linesPerSpeed: linesPerSpeed.value ?? specDefaults.value.linesPerSpeed,
    measuredLineMm: measuredLine.value ?? specDefaults.value.measuredLineMm,
    linePitchMm: linePitch.value ?? specDefaults.value.linePitchMm,
    sweep: sweep.value,
    sweepFromHz: sweepFromHz.value ?? specDefaults.value.sweepFromHz,
    sweepToHz: sweepToHz.value ?? specDefaults.value.sweepToHz,
    sweepCycles: sweepCycles.value ?? specDefaults.value.sweepCycles,
    axes: ['x', 'y'] as IsAxis[],
    placement: (scanPlace.value === 'plate' ? 'front' : 'center') as IsTestSpec['placement'],
    contrastBase: partColors.value === 'base',
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
  const f = store.selectedFilament
  if (!s || !p || !f) return ''
  const nominal = p.nozzleDiameterMm * NOMINAL_WIDTH_FACTOR
  const flow = Math.max(...s.speedsMmS) * nominal * p.layerHeightMm
  const limit = flowWarningLimitMm3S(f)
  if (flow <= limit) return ''
  return (
    `The line speed extrudes ${flow.toFixed(1)} mm^3/s, above ` +
    (f.maxVolumetricFlowMm3S > 0
      ? `the filament's configured ${limit} mm^3/s maximum volumetric flow, `
      : `the roughly ${limit} mm^3/s a typical hotend melts, `) +
    'so the lines print thinner. The ringing wavelength is still readable from slightly ' +
    'thinned lines.'
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
const {
  scanFiles,
  scanPickHint,
  analyzing,
  analysisStarted,
  scanError,
  processing,
  zoomed,
  onPickScans,
  removeScan,
  startOver,
  analyzeWith,
} = useScanAnalysis<IsProcessing>({
  maxFiles: 2,
  tooManyHint:
    'The analysis uses exactly two scan images. The files beyond the first two were not added.',
  errorLabel: 'Input shaper scan analysis failed',
})
const result = computed(() => processing.value?.result ?? null)
// The firmware the current result was analyzed under, so the snippet stays consistent even if
// the profile selection changes afterwards.
const analyzedFirmware = ref<Firmware>('Klipper')

// Per-scan card facts, derived from the result: the alignment (fiducials), the resolved
// orientation, and which axis group this scan measured with its line tally. The engine stops
// at the first scan that fails to align, so a later scan may be not analyzed rather than
// failed.
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
  /** Badge and explanation when this scan's resolution verdict failed; null otherwise. */
  resolutionProblem: { text: string; explanation: string } | null
}
// Per-scan resolution verdicts over the analyzed pair, judged against the calibration's expected
// resolution, so the offending scan's own card carries the badge. Scans without a solved affine
// have no measured resolution and get no verdict.
const resolutionVerdicts = computed<(ScanResolutionVerdict | null)[]>(() => {
  const scans = processing.value?.result.scans ?? []
  const withScale = scans
    .map((s, index) => ({ index, pxPerMm: s.measuredPxPerMm }))
    .filter((s): s is { index: number; pxPerMm: number } => s.pxPerMm != null && s.pxPerMm > 0)
  const verdicts = evaluateScanSetResolution(
    withScale.map((s) => ({ pxPerMm: s.pxPerMm })),
    expectedFromCalibration(calibration.calibration),
  )
  const byIndex: (ScanResolutionVerdict | null)[] = scans.map(() => null)
  withScale.forEach((s, i) => (byIndex[s.index] = verdicts[i]))
  return byIndex
})
const scanCards = computed<ScanCard[]>(() => {
  const p = processing.value
  const r = p?.result
  if (!p || !r) return []
  // r.scans lists the analyzed scans in order, including the scan whose alignment failed
  // (its entry reports how far the alignment got); every scan after it was never attempted.
  return p.overlays.map((bitmap, i) => {
    const info = r.scans[i] ?? null
    const axes = r.axes.filter((a) => a.scanIndex === i)
    const verdict = resolutionVerdicts.value[i] ?? null
    const rows: ScanCardRow[] = [
      {
        label: 'Fiducials',
        value: info ? (info.fiducialsFound ? 'Found' : 'Not found') : 'Not analyzed',
        sev: info ? (info.fiducialsFound ? 'ok' : 'warn') : 'mute',
      },
      {
        label: 'Flipped',
        value: info?.orientationSolved ? (info.flipped ? 'yes' : 'no') : 'Not resolved',
        sev: info?.orientationSolved ? 'ok' : 'mute',
      },
      {
        label: 'Rotation',
        value: info?.orientationSolved ? `${info.rotationQuarterTurns * 90} degrees` : 'Not resolved',
        sev: info?.orientationSolved ? 'ok' : 'mute',
      },
      {
        label: 'Resolution',
        value: resolutionRowValue(info?.measuredPxPerMm),
        sev: info?.measuredPxPerMm == null ? 'mute' : verdict && !verdict.ok ? 'warn' : 'ok',
      },
      {
        label: 'Measures',
        value:
          axes.length > 0
            ? `${axes.map((a) => a.axis.toUpperCase()).join(' and ')} axis lines`
            : 'No axis group',
        sev: axes.length > 0 ? 'ok' : 'mute',
      },
      ...axes.map((a) => ({
        label: `${a.axis.toUpperCase()} lines`,
        value: `${a.linesUsed} of ${a.linesTraced} used`,
        sev: (a.linesTraced > 0 && a.linesUsed === a.linesTraced ? 'ok' : 'warn') as CardSev,
      })),
    ]
    return {
      index: i,
      title: `Scan ${i + 1}`,
      fileName: scanFiles.value[i]?.name ?? '',
      bitmap,
      rows,
      resolutionProblem: resolutionBadge(verdict),
    }
  })
})

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
  await analyzeWith(async () => {
    const [bytesA, bytesB] = await Promise.all([readBytes(fileA), readBytes(fileB)])
    // The calibration's scale error holds across resolutions; the scan is expected at the
    // calibration DPI, so the calibration is priced at exactly that resolution.
    const scanPxPerMm = scaleReferenceAtDpi(cal, cal.dpi)
    const p = await analyzeIsScans(bytesA, bytesB, usedSpec, scanPxPerMm, cal.dpi)
    analyzedFirmware.value = store.selected?.firmware ?? 'Klipper'
    return p
  })
}
</script>

<template>
  <v-container class="page">
    <header class="mb-4">
      <h1 class="text-h5 font-weight-bold">Input shaper calibration</h1>
      <p class="text-body-2 text-medium-emphasis mt-1">
        Print a resonance test coupon whose lines record the ringing after a sharp corner.
        Two scans then measure each axis's resonance frequency and damping, and report the
        input shaper values to set.
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
        Required before the scan step, not for generating the print. The analysis reads the
        ringing in millimetres, which needs the true scanner resolution from the card
        calibration.
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
          data-testid="is-settings-reset"
          @click="resetSettings"
        >
          Reset to defaults
        </v-btn>
      </div>
      <div class="field-group">
        <span class="group-label">Speeds</span>
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
        <p class="tip mb-0">
          <strong>Lower the corner speed if the print skips layers.</strong>
        </p>
        <v-alert
          v-if="highFlowText"
          type="info"
          variant="tonal"
          density="compact"
          class="mt-2 soft-alert"
          data-testid="is-flow-warning"
          :text="highFlowText"
        />
        <p v-if="accelNote" class="tip mb-0">{{ accelNote }}</p>
      </div>
      <v-divider class="my-3" />
      <div class="field-group mt-1" :class="{ 'optional-off': !sweep }">
        <span class="group-label">Resonant run-up</span>
        <v-switch
          v-model="sweep"
          label="Resonant run-up (frequency sweep)"
          density="compact"
          color="primary"
          hide-details
          data-testid="is-sweep-toggle"
        />
        <v-expand-transition>
          <p v-if="!sweep" class="tip mt-0 mb-0" data-testid="is-sweep-note">
            Enable this when the printed lines show almost no ringing after the corner, which
            is common on small stiff printers. The run-up becomes a comb of corners that
            sweeps the frequency band and builds the ringing up before each measured line,
            at the cost of a larger coupon.
          </p>
        </v-expand-transition>
        <div v-if="sweep" class="fields mt-2">
          <NumericField
            v-model="sweepFromHz"
            label="Sweep start (Hz)"
            :step="5"
            :min="20"
            data-testid="is-sweep-from"
            hint="Start of the excited frequency band."
          />
          <NumericField
            v-model="sweepToHz"
            label="Sweep end (Hz)"
            :step="5"
            :min="25"
            data-testid="is-sweep-to"
            hint="End of the excited frequency band, reached right before the corner."
          />
          <NumericField
            v-model="sweepCycles"
            label="Sweep cycles"
            :step="1"
            :min="4"
            data-testid="is-sweep-cycles"
            hint="More cycles strengthen the buildup but lengthen the coupon."
          />
        </div>
      </div>
      <v-divider class="my-3" />
      <div class="field-group mt-1">
        <span class="group-label">Scanning plan</span>
        <div class="fields">
          <v-select
            v-model="scanPlace"
            :items="scanPlaceItems"
            label="How will you scan the print?"
            density="comfortable"
            hide-details
            data-testid="is-scan-plan"
          />
          <v-select
            v-model="partColors"
            :items="partColorsItems"
            label="Colors"
            density="comfortable"
            hide-details
            data-testid="is-part-colors"
          />
        </div>
        <p class="tip mb-0" data-testid="is-scan-plan-note">{{ scanPlanNote }}</p>
        <v-expansion-panels flat class="advanced-panels mt-1">
          <v-expansion-panel data-testid="is-advanced-panel">
            <v-expansion-panel-title class="adv-title">
              Advanced: line pitch, read length, lines per speed
            </v-expansion-panel-title>
            <v-expansion-panel-text>
              <div class="fields">
                <NumericField
                  v-model="linePitch"
                  label="Line pitch (mm)"
                  :step="0.1"
                  :min="0.1"
                  :precision="2"
                  hint="Raise only if neighbouring lines touch on a strongly ringing printer."
                />
                <NumericField
                  v-model="measuredLine"
                  label="Clean read length (mm)"
                  :step="5"
                  :min="20"
                  hint="Cover at least five wavelengths of the lowest resonance of interest."
                />
                <NumericField
                  v-model="linesPerSpeed"
                  label="Lines per speed"
                  :step="1"
                  :min="3"
                  hint="More lines tolerate damaged or unreadable lines in the scan."
                />
              </div>
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>
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
      <div class="alert-stack mt-3">
        <v-alert
          v-if="fitError"
          type="error"
          variant="tonal"
          density="compact"
          class="soft-alert"
          :text="fitError"
          data-testid="is-fit-error"
        />
        <v-alert
          v-if="rampNotes.length > 0"
          type="warning"
          variant="tonal"
          density="compact"
          class="soft-alert"
          :text="rampNotes.join(' ')"
          data-testid="is-ramp-warning"
        />
        <v-alert
          v-if="fitNotes.length > 0"
          type="info"
          variant="tonal"
          density="compact"
          class="soft-alert"
          :text="fitNotes.join(' ')"
          data-testid="is-fit-notes"
        />
      </div>
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
        Scan the coupon face down with the lid closed, at the calibrated resolution. Scan it
        twice, once in each placement shown below, because each line group is only read along
        the scanner's accurate axis.
      </p>
      <div class="diagram-wrap mb-3">
        <IsFirstScanDiagram />
      </div>
      <div class="diagram-wrap mb-3">
        <IsSecondScanDiagram />
      </div>
      <p class="tip mb-3">
        The placements are a suggested starting point, and the order of the two images
        does not matter.
      </p>
      <div class="scan-inputs mb-3">
        <label class="dropzone" :class="{ 'dropzone-disabled': !isCalibrated || analysisStarted }">
          <input
            type="file"
            accept="image/*"
            multiple
            class="file-input"
            :disabled="!isCalibrated || analyzing || analysisStarted"
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
        <div v-if="scanFiles.length > 0 && scanCards.length === 0" class="scan-files">
          <div
            v-for="(file, i) in scanFiles"
            :key="`${file.name}-${i}`"
            class="scan-file"
            :data-testid="`is-scan-file-${i}`"
          >
            <v-icon size="16" color="success">mdi-image-check</v-icon>
            <span class="scan-file-name">{{ file.name }}</span>
            <v-btn
              v-if="!analysisStarted"
              icon="mdi-close"
              size="x-small"
              variant="text"
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
        Calibrate the scanner in step 1 to enable the analysis.
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
        <v-btn
          v-if="analysisStarted"
          variant="tonal"
          prepend-icon="mdi-restart"
          :disabled="analyzing"
          data-testid="is-start-over"
          @click="startOver"
        >
          Start over
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

      <div v-if="scanCards.length > 0" class="scan-cards mt-4" data-testid="is-scan-cards">
        <div v-for="card in scanCards" :key="card.index" class="island" :data-testid="`is-scan-card-${card.index}`">
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
              :data-testid="`is-scan-card-file-${card.index}`"
            >
              {{ card.fileName }}
            </div>
            <template v-if="card.resolutionProblem">
              <span class="pill warn" :data-testid="`is-scan-resolution-pill-${card.index}`">
                <span class="dot"></span>{{ card.resolutionProblem.text }}
              </span>
              <p class="pill-note" :data-testid="`is-scan-resolution-note-${card.index}`">
                {{ card.resolutionProblem.explanation }}
              </p>
            </template>
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
      <p v-if="scanCards.length > 0" class="tip mb-0" data-testid="is-overlay-legend">
        In the overlays, green marks the lines whose ringing was measured and red marks the
        skipped lines, each labelled with its line number. A red cross marks a line that could
        not be traced at all.
      </p>

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
  align-items: flex-start;
  gap: 12px;
}
.fields > * {
  flex: 1 1 160px;
}
.advanced-panels :deep(.v-expansion-panel) {
  background: transparent;
}
.advanced-panels :deep(.v-expansion-panel-title) {
  padding: 8px 4px;
  min-height: 0;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.55;
}
.advanced-panels :deep(.v-expansion-panel-text__wrapper) {
  padding: 8px 4px 12px;
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
.optional-off {
  opacity: 0.75;
}
.optional-off .group-label {
  opacity: 0.4;
}
.alert-stack > * + * {
  margin-top: 8px;
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
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
  margin-bottom: 8px;
}
.pill .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.pill.warn {
  background: rgba(var(--v-theme-warning), 0.16);
  color: rgb(var(--v-theme-warning));
}
.pill.warn .dot {
  background: rgb(var(--v-theme-warning));
}
.pill-note {
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), 0.6);
  margin: 0 0 10px;
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
