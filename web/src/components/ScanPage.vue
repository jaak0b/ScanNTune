<script setup lang="ts">
import { computed, nextTick, reactive, ref, toRaw, watch } from 'vue'
import { useApp } from '../stores/useApp'
import { useCalibration } from '../stores/useCalibration'
import { useScans } from '../stores/useScans'
import { readBytes } from '../util/preview'
import { analyzeScan } from '../workerClient'
import { reconcileScans } from '../engine/multiPlaneCombiner'
import { turnBetween } from '../engine/scanCombiner'
import { asAligned, defaultCouponSpec, xAxisAngleDegrees } from '../engine/types'
import type { CouponSpec, Plane } from '../engine/types'
import { ScanState } from '../model/skewCouponScan'
import {
  skewFlavours,
  sizeFlavours,
  resetSkewCommand,
  skewCorrectionMulti,
  axisSizeCorrection,
  currentValueLabel,
} from '../engine/correctionFormatter'
import { signedPercent, signedDegrees } from '../util/format'
import NumericField from './NumericField.vue'
import CouponGlyph from './CouponGlyph.vue'
import ScanIsland from './ScanIsland.vue'
import CodeBlock from './CodeBlock.vue'
import MetricTile from './MetricTile.vue'

const app = useApp()
const calibration = useCalibration()
const store = useScans()

const MAX_SCANS = 6

const dpi = ref<number | null>(1200)
const baselineMm = ref<number | null>(100)
const gridN = ref<number | null>(5)

const isError = ref(false)
const statusText = ref('')

const truncatedSnackbar = ref(false)
const truncatedMessage = ref('')

const isCalibrated = computed(() => calibration.calibration !== null)
const calibrationLine = computed(() =>
  isCalibrated.value
    ? `${Math.round(calibration.calibration!.dpi)} dpi`
    : 'Optional · skips absolute size',
)
const scanDpiHint = computed(() =>
  isCalibrated.value ? `Scan every plate at ${Math.round(calibration.calibration!.dpi)} dpi.` : '',
)

// Coupon geometry locks once any scan is loaded: the per-scan analysis is cached against these
// values, so letting them change mid-batch would silently mismatch the loaded scans.
const fieldsLocked = computed(() => store.scans.length > 0)
const anyPending = computed(() => store.scans.some((s) => s.state === ScanState.Pending))
const notReady = computed(() => store.scans.filter((s) => !s.isMeasured))

// A valid plate is exactly two scans of the same plane, a quarter-turn apart. Two problems get
// flagged directly on the scan, rather than as a vague "planes don't pair up" message: a scan at
// nearly the SAME orientation as an earlier one for that plane (the plate wasn't actually turned
// between scans, often the same scan picked twice under a different file name), or a plane that
// already has its two scans and doesn't need a third. Driven by the measured orientation angle, not
// the file name, so it holds regardless of what the files are called.
const ROTATION_DUPLICATE_TOLERANCE_DEGREES = 15
type PlaneProblem = 'duplicate' | 'extra'
const planeProblems = computed(() => {
  const seenByPlane = new Map<Plane, number[]>()
  const problems = new Map<number, PlaneProblem>()
  for (const s of store.scans) {
    if (!s.isMeasured || !s.plane || !s.result?.orientation) continue
    const angle = xAxisAngleDegrees(s.result.orientation)
    const seen = seenByPlane.get(s.plane) ?? []
    const isDuplicate = seen.some((a) => {
      const turn = turnBetween(a, angle)
      return turn <= ROTATION_DUPLICATE_TOLERANCE_DEGREES || turn >= 360 - ROTATION_DUPLICATE_TOLERANCE_DEGREES
    })
    if (isDuplicate) problems.set(s.id, 'duplicate')
    else if (seen.length >= 2) problems.set(s.id, 'extra')
    seen.push(angle)
    seenByPlane.set(s.plane, seen)
  }
  return problems
})

// Data-driven: analysable only when every scan measured a plane and those planes pair up into
// complete plates. So the button never lets a bad scan through, and combine can't surface a
// picture-stage error.
const planeCounts = computed(() => {
  const byPlane = new Map<Plane, number>()
  for (const s of store.scans.filter((s) => s.isMeasured)) {
    byPlane.set(s.plane!, (byPlane.get(s.plane!) ?? 0) + 1)
  }
  return byPlane
})
const planesPair = computed(() => {
  if (planeCounts.value.size === 0) return false
  for (const count of planeCounts.value.values()) if (count !== 2) return false
  return true
})
const canAnalyze = computed(() => {
  const n = store.scans.length
  return !anyPending.value && n >= 2 && n <= MAX_SCANS && notReady.value.length === 0 && planesPair.value
})
// The button label stays short and action-shaped; the reason it's disabled (if any) goes in a
// caption below instead, since a long explanation wrapping inside the button looks broken.
const analyzeLabel = computed(() => {
  if (anyPending.value) return 'Checking scans...'
  const n = store.scans.length
  return canAnalyze.value ? `Analyze ${n} scans` : 'Analyze'
})
const analyzeReason = computed(() => {
  if (anyPending.value) return ''
  const n = store.scans.length
  if (n === 0) return 'Add 2 scans to analyze.'
  const bad = notReady.value.length
  if (bad > 0) return `Fix ${bad} scan${bad === 1 ? '' : 's'} to analyze.`
  if (!planesPair.value) {
    return planeProblems.value.size > 0
      ? 'Fix the flagged scan(s) above: each plate needs exactly two, a quarter-turn apart.'
      : 'Each plate needs two scans a quarter-turn apart.'
  }
  return ''
})

// One firmware choice drives every firmware-specific command on the page (reset, and the skew fix),
// so the reset command and the fix always agree on which firmware they're talking to.
const firmware = ref<string>(skewFlavours[0])
const resetCommand = computed(() => resetSkewCommand(firmware.value))

// Set once Analyze succeeds: locks step 5 (no more uploads or removals) and reveals step 6.
const hasResults = computed(() => app.payload !== null)
const result = computed(() => app.payload?.result ?? null)
const scales = computed(() => result.value?.scales ?? [])
const skews = computed(() => result.value?.skews ?? [])
const planes = computed(() => result.value?.planes ?? [])
// A plane whose two-scan pairing didn't check out (bad quarter-turn, or a mirror-flip mismatch)
// still produces numbers, but they shouldn't be trusted, so surface it rather than showing a clean
// result indistinguishable from a good one.
const invalidPlanes = computed(() =>
  planes.value
    .filter((p) => !p.twoScan.rotationLooksValid)
    .map((p) => ({
      plane: p.plane,
      reason: p.twoScan.flipMismatch
        ? 'one scan is mirror-flipped relative to the other'
        : "the scans aren't a quarter-turn apart",
    })),
)

const sizeFlavour = ref<string>(sizeFlavours[0])
const currents = reactive<Record<'X' | 'Y' | 'Z', number | null>>({ X: null, Y: null, Z: null })
const activeFixTab = ref<'skew' | 'size'>('skew')
const resultsSection = ref<HTMLElement | null>(null)

const currentLabel = computed(() => currentValueLabel(sizeFlavour.value))
const showCurrent = computed(() => currentLabel.value !== null)
const currentAxes = computed(() => scales.value.map((s) => s.axis))

// A steps/mm value is meaningless as a rotation distance, so clear entered currents on format change.
watch(sizeFlavour, () => {
  currents.X = currents.Y = currents.Z = null
})

const skewFix = computed(() =>
  result.value && app.payload
    ? skewCorrectionMulti(firmware.value, skews.value, app.payload.coupon)
    : null,
)
const sizeFix = computed(() =>
  result.value ? axisSizeCorrection(sizeFlavour.value, scales.value, currents) : null,
)

function startOver(): void {
  app.clearResults()
  store.clear()
  isError.value = false
  statusText.value = ''
}

const plates: ReadonlyArray<{ key: string; label: string; file: string }> = [
  { key: 'xy', label: 'XY plane', file: 'calibration_coupon_xy.stl' },
  { key: 'xz', label: 'XZ plane', file: 'calibration_coupon_xz.stl' },
  { key: 'yz', label: 'YZ plane', file: 'calibration_coupon_yz.stl' },
]

function buildCoupon(): CouponSpec {
  return { ...defaultCouponSpec(), baselineMm: baselineMm.value ?? 100, gridN: gridN.value ?? 5 }
}

function downloadAllCoupons(): void {
  // Browsers gate multiple downloads fired in the same tick without a fresh user gesture per file
  // (Chrome/Firefox silently block the 2nd+ after the first), so space them out.
  plates.forEach((p, i) => setTimeout(() => getCoupon(p.file), i * 400))
}

async function onPick(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const picked = Array.from(input.files ?? [])
  // Clear the input so picking the same file again still fires change.
  input.value = ''
  const remaining = MAX_SCANS - store.scans.length
  const files = picked.slice(0, Math.max(0, remaining))
  if (files.length < picked.length) {
    truncatedMessage.value = `Only added ${files.length} of ${picked.length} scans: ${MAX_SCANS} max.`
    truncatedSnackbar.value = true
  }
  const coupon = buildCoupon()
  for (const file of files) {
    let bytes: Uint8Array
    try {
      bytes = await readBytes(file)
    } catch (err) {
      console.error('Could not read a picked scan', err)
      isError.value = true
      statusText.value = `Could not read ${file.name}.`
      continue
    }
    const id = store.add(file.name, bytes)
    // Fire the analysis without blocking the next file. The worker serialises the calls, so scans are
    // still decoded one at a time (bounded memory), and each island fills in as its scan finishes.
    void analyzeItem(id, bytes, coupon)
  }
}

async function analyzeItem(id: number, bytes: Uint8Array, coupon: CouponSpec): Promise<void> {
  try {
    store.applyProcessing(id, await analyzeScan(bytes, coupon))
  } catch (e) {
    console.error('Per-scan analysis failed', e)
    store.fail(id, e instanceof Error ? e.message : String(e))
  }
}

async function analyze(): Promise<void> {
  const measured = store.scans.filter((s) => s.isMeasured)
  const pxPerMm = calibration.calibration
    ? calibration.calibration.pxPerMm
    : dpi.value != null && dpi.value >= 50
      ? dpi.value / 25.4
      : null
  try {
    const result = reconcileScans(
      measured.map((s) => asAligned(toRaw(s.result!))),
      pxPerMm,
    )
    // Each scan's overlay stays owned by the scans store, so nothing is copied here; only the
    // reconciled numbers travel in the payload.
    app.setResults({ result, coupon: buildCoupon() })
    await nextTick()
    resultsSection.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch (e) {
    isError.value = true
    statusText.value = e instanceof Error ? e.message : String(e)
    console.error('Reconcile failed', e)
  }
}

function getCoupon(file: string): void {
  const a = document.createElement('a')
  a.href = `${import.meta.env.BASE_URL}${file}`
  a.download = file
  a.click()
}
</script>

<template>
  <v-container class="page">
    <header class="mb-4">
      <div class="header-row">
        <h1 class="text-h5 font-weight-bold">Skew/shrinkage calibration</h1>
        <v-select
          v-model="firmware"
          :items="skewFlavours"
          label="Firmware"
          density="comfortable"
          hide-details
          class="firmware-select"
        />
      </div>
      <p class="text-body-2 text-medium-emphasis mt-1">
        Print a plate for each plane you want to calibrate, scan each one twice (flat, then a quarter-turn),
        and drop all the scans in. The app sorts them by plate and works out X/Y/Z scale and skew.
      </p>
    </header>

    <!-- 1. Calibrate scanner -->
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
          data-testid="calibrate-btn"
          :variant="isCalibrated ? 'text' : 'flat'"
          :color="isCalibrated ? undefined : 'primary'"
          size="small"
          @click="app.goCalibration()"
        >
          {{ isCalibrated ? 'Recalibrate' : 'Calibrate scanner' }}
        </v-btn>
      </div>
    </section>

    <!-- 2. Reset printer skew -->
    <section class="step mb-3">
      <div class="step-head mb-2">
        <span class="num">2</span><span class="step-title">Reset printer skew</span>
      </div>
      <div class="warn-box mb-3">
        <v-icon color="warning" size="16" class="warn-icon">mdi-alert-outline</v-icon>
        <span>
          <strong class="warn-lead">Coupons must be printed with skew correction disabled.</strong>
          A correction still active bends the coupon before it prints, so the skew fix ScanNTune
          calculates from it will be wrong.
        </span>
      </div>
      <CodeBlock :code="resetCommand.code" />
      <p v-if="resetCommand.hint" class="tip mt-0">{{ resetCommand.hint }}</p>
    </section>

    <!-- 3. Print the plates -->
    <section class="step mb-3">
      <div class="step-row mb-2">
        <div class="step-head">
          <span class="num">3</span><span class="step-title">Print the plate(s)</span>
        </div>
        <v-menu>
          <template #activator="{ props }">
            <v-btn variant="tonal" size="small" prepend-icon="mdi-download" v-bind="props">
              Download plate
            </v-btn>
          </template>
          <v-list density="compact">
            <v-list-item v-for="p in plates" :key="p.key" @click="getCoupon(p.file)">
              <v-list-item-title>{{ p.label }}</v-list-item-title>
            </v-list-item>
            <v-divider />
            <v-list-item @click="downloadAllCoupons">
              <v-list-item-title class="text-primary">Download all</v-list-item-title>
            </v-list-item>
          </v-list>
        </v-menu>
      </div>
      <p class="tip">
        Download the plane(s) you want to calibrate. XZ and YZ print standing, no supports needed.
      </p>
    </section>

    <!-- 4. Scan your prints -->
    <section class="step mb-3">
      <div class="step-head mb-1">
        <span class="num">4</span><span class="step-title">Scan your prints</span>
      </div>
      <p class="tip mb-3">
        Scan each plate flat, then quarter-turn it and scan again. Repeat for every plate. Back light
        plates with a dark sheet for contrast.
        <template v-if="scanDpiHint">{{ scanDpiHint }}</template>
      </p>

      <div class="scan-flow">
        <div class="glyph-step">
          <CouponGlyph :rotate="0" :size="76" />
          <span class="glyph-cap">1 · scan flat</span>
        </div>
        <div class="connector">
          <v-icon class="arrow" color="primary" size="26">mdi-rotate-right</v-icon>
          <span class="deg">turn 90°</span>
        </div>
        <div class="glyph-step">
          <div class="roll">
            <div class="glyph-wrap"><CouponGlyph :size="76" /></div>
          </div>
          <span class="glyph-cap">2 · scan again</span>
        </div>
      </div>
    </section>

    <!-- 5. Upload your scans -->
    <section class="step mb-3">
      <div class="step-head mb-1">
        <span class="num">5</span><span class="step-title">Upload your scans</span>
      </div>
      <p class="tip mb-3">
        Drop in every scan at once: two per plate, up to three plates ({{ MAX_SCANS }} scans).
      </p>

      <label v-if="!hasResults && store.scans.length < MAX_SCANS" class="dropzone">
        <input
          type="file"
          accept="image/*"
          multiple
          class="file-input"
          data-testid="scans-input"
          @change="onPick"
        />
        <v-icon size="28" color="primary">mdi-image-plus</v-icon>
        <span class="dz-label">Choose scan images</span>
        <span class="dz-sub">or drop them here · you can add more later</span>
      </label>

      <div v-if="store.scans.length" class="islands mt-3" data-testid="islands">
        <ScanIsland
          v-for="s in store.scans"
          :key="s.id"
          :scan="s"
          :removable="!hasResults"
          :problem="planeProblems.get(s.id)"
          @remove="store.remove(s.id)"
        />
      </div>

      <div class="fields mt-4">
        <NumericField
          v-if="!isCalibrated"
          v-model="dpi"
          label="Scanner DPI"
          :step="100"
          :min="50"
          hint="DPI / 25.4 = px per mm. Clear for anisotropy and skew only."
        />
        <template v-if="fieldsLocked">
          <div class="locked-field">
            <span class="lf-label">Coupon baseline (mm)</span>
            <span class="lf-value">{{ baselineMm }}</span>
          </div>
          <div class="locked-field">
            <span class="lf-label">Rings per side</span>
            <span class="lf-value">{{ gridN }}</span>
          </div>
        </template>
        <template v-else>
          <NumericField v-model="baselineMm" label="Coupon baseline (mm)" :step="10" :min="10" />
          <NumericField v-model="gridN" label="Rings per side" :step="1" :min="2" />
        </template>
      </div>

      <template v-if="!hasResults">
        <v-btn
          data-testid="analyze-btn"
          color="primary"
          size="large"
          block
          class="mt-4"
          :disabled="!canAnalyze"
          @click="analyze"
        >
          {{ analyzeLabel }}
        </v-btn>
        <p v-if="analyzeReason" class="tip text-center mt-2">{{ analyzeReason }}</p>

        <v-alert
          v-if="statusText"
          :type="isError ? 'error' : 'info'"
          variant="tonal"
          class="mt-3"
          :text="statusText"
          data-testid="status"
        />
      </template>
    </section>

    <!-- 6. Results -->
    <section v-if="hasResults" ref="resultsSection" class="step">
      <div class="step-row mb-3">
        <div class="step-head">
          <span class="num">6</span><span class="step-title">Results</span>
        </div>
        <v-btn
          data-testid="startover-btn"
          variant="text"
          size="small"
          prepend-icon="mdi-refresh"
          @click="startOver"
        >
          Start over
        </v-btn>
      </div>

      <div v-if="invalidPlanes.length" class="warn-box mb-3">
        <v-icon color="warning" size="16" class="warn-icon">mdi-alert-outline</v-icon>
        <span>
          <template v-for="(bad, i) in invalidPlanes" :key="bad.plane">
            <strong class="warn-lead">{{ bad.plane }}</strong> didn't align: {{ bad.reason }}, so
            those figures can't be trusted.<template v-if="i < invalidPlanes.length - 1"> </template>
          </template>
        </span>
      </div>

      <div class="group-label">Scale</div>
      <div class="tiles mb-3">
        <MetricTile
          v-for="s in scales"
          :key="s.axis"
          :label="`${s.axis} scale`"
          :value="signedPercent(s.scalePercent)"
          :testid="`scale-${s.axis}`"
        />
      </div>
      <div class="group-label">Skew</div>
      <div class="tiles mb-4">
        <MetricTile
          v-for="k in skews"
          :key="k.plane"
          :label="`${k.plane} skew`"
          :value="signedDegrees(k.skewDegrees)"
          :testid="`skew-${k.plane}`"
        />
      </div>

      <div class="fix-tabs">
        <button
          type="button"
          class="fix-tab"
          :class="{ active: activeFixTab === 'skew' }"
          @click="activeFixTab = 'skew'"
        >
          Fix skew
        </button>
        <button
          type="button"
          class="fix-tab"
          :class="{ active: activeFixTab === 'size' }"
          @click="activeFixTab = 'size'"
        >
          Fix size
        </button>
      </div>

      <div v-if="activeFixTab === 'skew'" class="fix-panel">
        <CodeBlock
          v-if="skewFix"
          :code="skewFix.code"
          :caption="skewFix.primaryCaption"
          data-testid="skew-code"
        />
        <CodeBlock
          v-if="skewFix?.secondaryCode"
          :code="skewFix.secondaryCode"
          :caption="skewFix.secondaryCaption"
        />
        <p v-if="skewFix?.hint" class="tip mt-0">{{ skewFix.hint }}</p>
      </div>

      <div v-else class="fix-panel">
        <v-select
          v-model="sizeFlavour"
          :items="sizeFlavours"
          label="Format"
          density="comfortable"
          hide-details
          class="fix-select mb-3"
        />
        <div v-if="showCurrent" class="fields mb-3">
          <NumericField
            v-for="axis in currentAxes"
            :key="axis"
            v-model="currents[axis]"
            :label="`${axis} ${currentLabel}`"
            :step="0.1"
            :min="0"
            :precision="3"
          />
        </div>
        <CodeBlock v-if="sizeFix" :code="sizeFix.code" data-testid="size-code" />
        <p v-if="sizeFix?.hint" class="tip mt-0">{{ sizeFix.hint }}</p>
      </div>
    </section>
  </v-container>

  <v-snackbar v-model="truncatedSnackbar" color="warning" :timeout="8000">
    {{ truncatedMessage }}
    <template #actions>
      <v-btn icon="mdi-close" size="small" variant="text" @click="truncatedSnackbar = false" />
    </template>
  </v-snackbar>
</template>

<style scoped>
.page {
  max-width: 760px;
}
.header-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.firmware-select {
  flex: 0 0 180px;
  min-width: 150px;
}
.step {
  background: rgb(var(--v-theme-surface-light));
  border-radius: 12px;
  padding: 16px;
}
.step-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
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
.status-inline {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
}
.tip {
  font-size: 12.5px;
  color: rgba(var(--v-theme-on-surface), 0.6);
  margin-top: 8px;
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
.scan-flow {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
  padding: 6px 0 2px;
}
.glyph-step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.glyph-cap {
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), 0.7);
}
/* The second coupon pivots about its top-right corner (transform-origin 0 0 plus translateX by one
   glyph width pins that corner on screen) so it ROLLS in from the right onto the quarter-turned
   resting frame, rather than spinning in place. This mirrors the desktop app's slot-2 animation. */
.roll {
  position: relative;
  width: 152px;
  height: 76px;
}
.glyph-wrap {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  animation: roll-turn 2.6s ease infinite;
}
@keyframes roll-turn {
  0%,
  25% {
    transform: translateX(76px) rotate(0deg);
  }
  65%,
  100% {
    transform: translateX(76px) rotate(90deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .glyph-wrap {
    animation: none;
    transform: translateX(76px) rotate(90deg);
  }
}
.connector {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.deg {
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.6);
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
.islands {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.fields {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.fields > * {
  flex: 1 1 160px;
}
.locked-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 0;
  flex: 1 1 100px;
}
.lf-label {
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), 0.6);
}
.lf-value {
  font-size: 16px;
  font-weight: 500;
  font-family: 'Roboto Mono', ui-monospace, monospace;
}
.group-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: rgba(var(--v-theme-on-surface), 0.6);
  margin-bottom: 8px;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
  gap: 8px;
}
.fix-tabs {
  display: flex;
  gap: 14px;
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.09);
  margin-bottom: 14px;
}
.fix-tab {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: rgba(var(--v-theme-on-surface), 0.6);
  font-size: 13.5px;
  font-weight: 500;
  padding: 8px 2px;
  cursor: pointer;
}
.fix-tab.active {
  color: rgb(var(--v-theme-on-surface));
  border-bottom-color: rgb(var(--v-theme-primary));
}
.fix-select {
  max-width: 220px;
}
</style>
