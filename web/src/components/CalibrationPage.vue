<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useApp } from '../stores/useApp'
import { useCalibration } from '../stores/useCalibration'
import { readBytes } from '../util/preview'
import { diagnoseScale } from '../engine/scanScale'
import { measureCardScan } from '../workerClient'
import { signedFixed } from '../util/format'
import type { ScanAxis, ScannerType } from '../engine/types'
import NumericField from './NumericField.vue'
import HowToScanDiagram from './HowToScanDiagram.vue'
import WhatToMeasureDiagram from './WhatToMeasureDiagram.vue'
import MetricTile from './MetricTile.vue'

const app = useApp()
const calibration = useCalibration()

const ISO_MM = 85.6

const measuredMm = ref<number | null>(calibration.calibration?.referenceMm ?? null)
const dpi = ref<number | null>(calibration.calibration?.dpi ?? 600)
const scannerType = ref<ScannerType>(calibration.calibration?.scannerType ?? 'CIS')

const detecting = ref(false)
const isError = ref(false)
const statusText = ref('')
const confirmReset = ref(false)

const measuredWidthPx = ref<number | null>(calibration.calibration?.measuredWidthPx ?? null)
const measuredAxis = ref<ScanAxis>(calibration.calibration?.measuredAxis ?? 'horizontal')
const straightnessPx = ref(calibration.calibration?.straightnessPx ?? 0)
const parallelismDegrees = ref(calibration.calibration?.parallelismDegrees ?? 0)
const hasResult = ref(calibration.calibration !== null)

const canUpload = computed(() => (measuredMm.value ?? 0) > 0 && (dpi.value ?? 0) >= 50)

const pxPerMm = computed(() =>
  measuredWidthPx.value && measuredMm.value ? measuredWidthPx.value / measuredMm.value : 0,
)
const effectiveDpi = computed(() => pxPerMm.value * 25.4)
const detectedMm = computed(() =>
  measuredWidthPx.value && dpi.value ? measuredWidthPx.value / (dpi.value / 25.4) : 0,
)
const sizeDiff = computed(() => Math.abs(detectedMm.value - (measuredMm.value ?? 0)))
// The size gate catches an entered-DPI or measurement mistake. On a CIS scanner both axes carry
// the same small error, so 0.3 mm suffices. A CCD scanner's sensor axis is legitimately off by
// around a percent (the very error this calibration corrects), so CCD mode allows 2% of the card
// length; a resolution mix-up is a clean integer factor and is caught by the scale-factor note.
const sizeToleranceMm = computed(() =>
  scannerType.value === 'CCD' ? (measuredMm.value ?? ISO_MM) * 0.02 : 0.3,
)
const sizeCheckOk = computed(() => hasResult.value && sizeDiff.value < sizeToleranceMm.value)
// A passing size check means maybeSave() persisted it (on detection, on edit, or it was already
// stored when the page loaded), so derive "saved" from the check rather than tracking it separately.
const saved = computed(() => sizeCheckOk.value)
const percentVsNominal = computed(() =>
  dpi.value ? (pxPerMm.value / (dpi.value / 25.4) - 1) * 100 : 0,
)

// Geometric resolution cross-check: when the detected card size is about double or half the
// measured size, the scan was almost certainly taken at a different resolution than entered.
// Driven by the same reactive figures as the size check, so it updates when the fields change.
const scaleFactorNote = computed(() => {
  if (!hasResult.value || !measuredMm.value || !dpi.value) return null
  const d = diagnoseScale(detectedMm.value, measuredMm.value)
  if (d.likelyMultiple === null) return null
  return `The detected card is about ${d.factor.toFixed(1)} times your measured size. The scan resolution likely differs from the ${Math.round(dpi.value)} dpi you entered.`
})

const isoSanityWarn = computed(
  () => measuredMm.value != null && Math.abs(measuredMm.value - ISO_MM) > 0.25,
)
const isoSanityText = computed(() => {
  if (measuredMm.value == null) return ''
  const d = Math.abs(measuredMm.value - ISO_MM)
  return isoSanityWarn.value
    ? `That is ${d.toFixed(2)} mm from the 85.60 mm ISO card. Double-check your measurement.`
    : 'In range for an ISO card (about 85.60 mm).'
})

async function processFile(file: File | null): Promise<void> {
  if (!canUpload.value) {
    isError.value = true
    statusText.value = 'Enter your measured size and a DPI of at least 50 first.'
    return
  }
  if (!file) return
  detecting.value = true
  isError.value = false
  hasResult.value = false
  statusText.value = 'Detecting the card...'
  try {
    const bytes = await readBytes(file)
    const r = await measureCardScan(bytes, measuredMm.value!, dpi.value!)
    if (!r.success) {
      isError.value = true
      statusText.value = r.message ?? "Couldn't detect the card in that scan."
      // A card-shaped object rejected only by the size gate points at a resolution mix-up, which
      // is a far more actionable diagnosis than the generic "no card" message.
      if (r.rejectedLongSidePx && measuredMm.value && dpi.value) {
        const rejectedMm = r.rejectedLongSidePx / (dpi.value / 25.4)
        const d = diagnoseScale(rejectedMm, measuredMm.value)
        if (d.likelyMultiple !== null) {
          statusText.value = `The detected card is about ${d.factor.toFixed(1)} times your measured size. The scan resolution likely differs from the ${Math.round(dpi.value)} dpi you entered.`
        }
      }
      return
    }
    measuredWidthPx.value = r.measuredWidthPx
    measuredAxis.value = r.measuredAxis ?? 'horizontal'
    straightnessPx.value = r.straightnessPx
    parallelismDegrees.value = r.parallelismDegrees
    hasResult.value = true
    statusText.value = ''
    maybeSave()
  } catch (e) {
    isError.value = true
    statusText.value = `Couldn't read the scan: ${e instanceof Error ? e.message : String(e)}`
    console.error('Card detection failed', e)
  } finally {
    detecting.value = false
  }
}

function onPick(e: Event): void {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  // Clear the input so picking the same file again (e.g. after a rejected attempt) still fires change.
  input.value = ''
  void processFile(file)
}
function onDrop(e: DragEvent): void {
  void processFile(e.dataTransfer?.files?.[0] ?? null)
}

function maybeSave(): void {
  if (
    sizeCheckOk.value &&
    measuredWidthPx.value != null &&
    measuredMm.value != null &&
    dpi.value != null
  ) {
    calibration.save({
      pxPerMm: pxPerMm.value,
      dpi: dpi.value,
      referenceMm: measuredMm.value,
      measuredWidthPx: measuredWidthPx.value,
      straightnessPx: straightnessPx.value,
      parallelismDegrees: parallelismDegrees.value,
      calibratedUtc: new Date().toISOString(),
      scannerType: scannerType.value,
      measuredAxis: measuredAxis.value,
    })
  }
}

function startOver(): void {
  confirmReset.value = false
  calibration.clear()
  measuredWidthPx.value = null
  measuredAxis.value = 'horizontal'
  straightnessPx.value = 0
  parallelismDegrees.value = 0
  hasResult.value = false
  detecting.value = false
  isError.value = false
  statusText.value = ''
}

watch([measuredMm, dpi, scannerType], () => {
  // Once the numbers are valid, drop a stale "enter your measurement first" prompt.
  if (isError.value && canUpload.value) {
    isError.value = false
    statusText.value = ''
  }
  if (hasResult.value) maybeSave()
})
</script>

<template>
  <v-container class="page">
    <div class="topbar">
      <v-btn variant="text" size="small" prepend-icon="mdi-arrow-left" data-testid="back-btn" @click="app.goScan()">
        Scan
      </v-btn>
      <h1 class="text-h6 font-weight-bold">Scanner calibration</h1>
      <span class="text-caption text-medium-emphasis">one-time</span>
    </div>

    <p class="text-body-2 text-medium-emphasis mb-4">
      Scan a bank card once, enter its measured long side and your scan DPI, and the tool auto-detects the
      card edges to read your scanner's true pixels-per-mm. It is stored and reused for every scan afterwards.
    </p>

    <!-- 1. How to scan -->
    <section class="panel mb-3">
      <div class="step-head mb-2"><span class="num">1</span><span class="step-title">How to scan</span></div>
      <div class="diagram-wrap"><HowToScanDiagram /></div>
      <ul class="tips">
        <li>The two edges you measure (green) run with the sweep, so they stay shadow-free.</li>
        <li>Lay the card fully on the glass, off every border.</li>
      </ul>
    </section>

    <div class="two-col mb-3">
      <!-- 2. What to measure -->
      <section class="panel">
        <div class="step-head mb-2"><span class="num">2</span><span class="step-title">What to measure</span></div>
        <div class="diagram-wrap"><WhatToMeasureDiagram /></div>
        <ul class="tips">
          <li>Measure the long side at mid-edge, avoiding the rounded corners.</li>
          <li>To 0.01 mm; checked against the 85.60 mm ISO nominal.</li>
        </ul>
      </section>

      <!-- 3. Your numbers -->
      <section class="panel">
        <div class="step-head mb-3"><span class="num">3</span><span class="step-title">Your numbers</span></div>
        <NumericField
          v-model="measuredMm"
          label="Measured long side (mm)"
          :step="0.02"
          :min="1"
          :precision="2"
          placeholder="85.50"
        />
        <NumericField
          v-model="dpi"
          label="Scan resolution (dpi)"
          :step="100"
          :min="50"
          :precision="0"
          hint="For best results scan at 600 dpi, and use the same resolution for your coupon."
          class="mt-3"
        />
        <div class="mt-3">
          <div class="field-label mb-1">Sensor type</div>
          <v-btn-toggle
            v-model="scannerType"
            mandatory
            divided
            density="comfortable"
            variant="outlined"
            data-testid="sensor-toggle"
          >
            <v-btn value="CIS" data-testid="sensor-cis">CIS</v-btn>
            <v-btn value="CCD" data-testid="sensor-ccd">CCD</v-btn>
          </v-btn-toggle>
          <p class="tip mt-1">
            CIS applies the correction to both scan axes; CCD applies it only along the card's
            long side. Your scanner's specification sheet names its sensor type.
          </p>
        </div>
        <p class="tip mt-2" :class="{ warn: isoSanityWarn }">{{ isoSanityText }}</p>
      </section>
    </div>

    <!-- Upload -->
    <label v-if="!hasResult" class="uploadzone mb-3" @dragover.prevent @drop.prevent="onDrop">
      <input
        type="file"
        class="hidden-input"
        accept="image/png,image/jpeg,image/tiff,image/webp"
        data-testid="card-input"
        @change="onPick"
      />
      <v-icon size="30" color="primary">mdi-tray-arrow-up</v-icon>
      <div class="text-body-1">Drop your card scan here, or choose a file</div>
      <div class="text-caption text-medium-emphasis text-center">
        PNG, JPG or TIFF. Works with most card colours; a pale card needs a dark sheet behind it.
      </div>
      <div v-if="!canUpload" class="text-caption warn">Enter your measurement and a DPI of at least 50 first.</div>
      <v-progress-linear v-if="detecting" indeterminate class="mt-2" style="max-width: 220px" />
    </label>

    <!-- Result -->
    <section v-if="hasResult" class="panel mb-3" data-testid="calibration-result">
      <div class="d-flex align-center ga-2 mb-3">
        <v-icon color="success">mdi-check-circle</v-icon>
        <span class="font-weight-medium">Card detected</span>
        <v-spacer />
        <v-btn
          data-testid="startover-btn"
          variant="text"
          size="small"
          prepend-icon="mdi-refresh"
          @click="confirmReset = true"
        >
          Start over
        </v-btn>
      </div>

      <div class="tiles">
        <MetricTile label="px / mm" :value="pxPerMm.toFixed(3)" testid="pxpermm" />
        <MetricTile label="effective dpi" :value="effectiveDpi.toFixed(0)" testid="effective-dpi" />
        <MetricTile label="vs nominal" :value="`${signedFixed(percentVsNominal, 3)} %`" testid="vs-nominal" />
      </div>

      <p class="text-caption text-medium-emphasis mt-3 mb-1">
        Edges straight to {{ straightnessPx.toFixed(2) }} px, parallel to {{ parallelismDegrees.toFixed(3) }}°.
      </p>
      <p class="text-body-2" :class="{ warn: !sizeCheckOk }">
        <span>Detected {{ detectedMm.toFixed(2) }} mm</span
        ><span v-if="sizeCheckOk && sizeDiff < 0.3">, matches your {{ (measuredMm ?? 0).toFixed(2) }} mm.</span
        ><span v-else-if="sizeCheckOk"
          >, {{ sizeDiff.toFixed(2) }} mm from your {{ (measuredMm ?? 0).toFixed(2) }} mm: the
          scanner scale error this calibration corrects.</span
        ><span v-else>, but you entered {{ (measuredMm ?? 0).toFixed(2) }} mm. Check the DPI or the measured value.</span>
      </p>
      <p v-if="scaleFactorNote" class="text-body-2 warn" data-testid="scale-factor-note">
        {{ scaleFactorNote }}
      </p>

      <div class="d-flex align-center justify-space-between mt-3">
        <div>
          <span v-if="saved" class="saved" data-testid="saved">
            <v-icon color="success" size="16">mdi-check</v-icon> Saved, used for every scan
          </span>
          <span v-else class="warn text-body-2">Not saved: resolve the size check above.</span>
        </div>
        <label class="rescan">
          <input type="file" class="hidden-input" accept="image/png,image/jpeg,image/tiff,image/webp" @change="onPick" />
          <v-btn size="small" variant="tonal" :disabled="!canUpload" tabindex="-1">Re-scan</v-btn>
        </label>
      </div>
    </section>

    <v-alert
      v-if="statusText"
      :type="isError ? 'error' : 'info'"
      variant="tonal"
      :text="statusText"
      :data-testid="isError ? 'card-error' : undefined"
    />

    <v-dialog v-model="confirmReset" max-width="420">
      <v-card title="Start over?">
        <v-card-text>
          This removes the stored scanner calibration. Scans analyzed afterwards need a new card
          measurement until you calibrate again.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmReset = false">Cancel</v-btn>
          <v-btn color="error" variant="flat" data-testid="startover-confirm" @click="startOver">
            Start over
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<style scoped>
.page {
  max-width: 820px;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.panel {
  background: rgb(var(--v-theme-surface-light));
  border-radius: 12px;
  padding: 16px;
}
.two-col {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
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
.diagram-wrap {
  display: flex;
  justify-content: center;
  margin: 4px 0 10px;
}
.tips {
  margin: 0;
  padding-left: 18px;
  font-size: 12.5px;
  color: rgba(var(--v-theme-on-surface), 0.6);
}
.tips li {
  margin-bottom: 3px;
}
.tip {
  font-size: 12.5px;
  color: rgba(var(--v-theme-on-surface), 0.6);
}
.field-label {
  font-size: 13px;
  color: rgba(var(--v-theme-on-surface), 0.7);
}
.tip.warn,
.warn {
  color: rgb(var(--v-theme-warning));
}
.uploadzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px;
  border: 1.4px dashed rgba(var(--v-theme-on-surface), 0.3);
  border-radius: 12px;
  cursor: pointer;
  transition: border-color 0.15s ease;
}
.uploadzone:hover {
  border-color: rgb(var(--v-theme-primary));
}
.tiles {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.saved {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: rgb(var(--v-theme-success));
  font-size: 13px;
}
.rescan {
  position: relative;
  cursor: pointer;
}
.hidden-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
</style>
