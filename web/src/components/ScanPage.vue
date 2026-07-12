<script setup lang="ts">
import { computed, nextTick, reactive, ref, toRaw, watch } from 'vue'
import { useApp } from '../stores/useApp'
import { useCalibration } from '../stores/useCalibration'
import { useScans } from '../stores/useScans'
import { readBytes } from '../util/preview'
import { scaleReferenceAtDpi } from '../engine/scannerCalibration'
import {
  evaluateScanSetResolution,
  expectedFromCalibration,
  expectedFromDpi,
} from '../util/scanResolution'
import type { ScanResolutionVerdict } from '../util/scanResolution'
import { analyzeScan } from '../workerClient'
import { reconcileScans } from '../engine/multiPlaneCombiner'
import {
  MIN_SCANS_FOR_RANGE,
  MIN_TURN_SPREAD_DEGREES,
  normalizeAngle,
  quadrantsCovered,
  turnBetween,
  turnSpreadDegrees,
} from '../engine/scanCombiner'
import { asAligned, defaultCouponSpec, planeAxes, xAxisAngleDegrees } from '../engine/types'
import type { CouponSpec, Plane } from '../engine/types'
import type { MetricRange } from './MetricTile.vue'
import { ScanState, SkewCouponScan } from '../model/skewCouponScan'
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
import PlateStyleGlyph from './PlateStyleGlyph.vue'
import ScanIsland from './ScanIsland.vue'
import CodeBlock from './CodeBlock.vue'
import MetricTile from './MetricTile.vue'

const app = useApp()
const calibration = useCalibration()
const store = useScans()

const MAX_SCANS = 24

const dpi = ref<number | null>(600)
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
    : 'Optional: reports skew and X-to-Y difference only',
)
const scanDpiHint = computed(() =>
  isCalibrated.value
    ? `Scan every plate at ${Math.round(calibration.calibration!.dpi)} dpi, the DPI the scanner was calibrated at.`
    : '',
)

// Coupon geometry locks once any scan is loaded: the per-scan analysis is cached against these
// values, so letting them change mid-batch would silently mismatch the loaded scans.
const fieldsLocked = computed(() => store.scans.length > 0)
const anyPending = computed(() => store.scans.some((s) => s.state === ScanState.Pending))
const notReady = computed(() => store.scans.filter((s) => !s.isMeasured))

// A scan at nearly the SAME angle as an earlier scan of the plate (the plate was not actually
// turned between scans) adds little information. It is flagged as a soft warning on the scan card,
// never as a blocker: the least-squares fit still uses it. Driven by the measured orientation
// angle, not the file name, so it holds regardless of what the files are called.
const ROTATION_DUPLICATE_TOLERANCE_DEGREES = 15
const planeProblems = computed(() => {
  const seenByPlane = new Map<Plane, number[]>()
  const problems = new Map<number, 'duplicate'>()
  for (const s of store.scans) {
    if (!s.isMeasured || !s.plane || !s.result?.orientation) continue
    const angle = xAxisAngleDegrees(s.result.orientation)
    const seen = seenByPlane.get(s.plane) ?? []
    const isDuplicate = seen.some((a) => {
      const turn = turnBetween(a, angle)
      return turn <= ROTATION_DUPLICATE_TOLERANCE_DEGREES || turn >= 360 - ROTATION_DUPLICATE_TOLERANCE_DEGREES
    })
    if (isDuplicate) problems.set(s.id, 'duplicate')
    seen.push(angle)
    seenByPlane.set(s.plane, seen)
  }
  return problems
})

// Per-scan resolution verdicts over the whole uploaded set: each measured scan's geometrically
// measured px/mm is judged against the expected resolution (the calibration, or the entered DPI)
// and against the other scans, so the one scan taken at a wrong resolution setting is flagged on
// its own card. Set-relative, so the verdicts recompute whenever the scan set changes.
const resolutionExpected = computed(() =>
  calibration.calibration
    ? expectedFromCalibration(calibration.calibration)
    : expectedFromDpi(dpi.value != null && dpi.value >= 50 ? dpi.value : null),
)
const resolutionVerdicts = computed<Map<number, ScanResolutionVerdict>>(() => {
  const measured = store.scans.filter((s) => s.isMeasured)
  const verdicts = evaluateScanSetResolution(
    measured.map((s) => ({
      pxPerMm: Math.sqrt(s.result!.measuredPxPerMmX! * s.result!.measuredPxPerMmY!),
    })),
    resolutionExpected.value,
  )
  return new Map(measured.map((s, i) => [s.id, verdicts[i]]))
})
const resolutionBadCount = computed(
  () => [...resolutionVerdicts.value.values()].filter((v) => !v.ok).length,
)

// Measured scans grouped by plane, each group carrying the angle figures the analyzability check
// and the group header need. Scans that have not measured a plane (pending, unreadable, misaligned
// or unlabeled) stay outside the groups and are listed separately.
interface PlaneGroup {
  plane: Plane
  scans: SkewCouponScan[]
  anglesDegrees: number[]
  spreadDegrees: number
  quadrants: number
  ready: boolean
  statusText: string
  statusIcon: string
  statusColor: string
  /** Non-blocking accuracy nudge shown when the group is otherwise ready. */
  note: string | null
}
const planeGroups = computed<PlaneGroup[]>(() => {
  const byPlane = new Map<Plane, SkewCouponScan[]>()
  for (const s of store.scans) {
    if (!s.isMeasured || !s.plane) continue
    const g = byPlane.get(s.plane)
    if (g) g.push(s)
    else byPlane.set(s.plane, [s])
  }
  const groups: PlaneGroup[] = []
  for (const [plane, unsorted] of byPlane) {
    // Sorted by measured angle so near-duplicates sit next to each other. Angles are circular
    // (0.2 and 359.96 are nearly the same), so the list starts after the largest gap around the
    // circle instead of at a fixed zero.
    const scans = sortByCircularAngle(unsorted)
    const anglesDegrees = scans.map((s) => normalizeAngle(xAxisAngleDegrees(s.result!.orientation!)))
    const spreadDegrees = turnSpreadDegrees(anglesDegrees)
    const quadrants = quadrantsCovered(anglesDegrees)
    const enough = scans.length >= 2
    const spreadOk = spreadDegrees >= MIN_TURN_SPREAD_DEGREES
    // Every measured scan carries its handedness, so a mirror-flip mismatch is detectable here,
    // before Analyze, and blocks with an actionable message instead of surfacing after the fact.
    const flipMismatch = scans.some(
      (s) => s.result!.orientation!.flipped !== scans[0].result!.orientation!.flipped,
    )
    const ready = enough && spreadOk && !flipMismatch
    const statusText = !enough
      ? 'This plate needs a second scan, turned on the glass from the first.'
      : flipMismatch
        ? 'One scan shows the plate mirrored relative to the others. Scan every image of this plate with the same face down.'
        : !spreadOk
          ? `These two scans are only ${Math.round(spreadDegrees)} degrees apart. Turn the plate further, about a quarter turn, and scan it again so the app can separate scale from skew.`
          : 'Ready to analyze.'
    const note =
      ready && quadrants < 4
        ? `This plate covers ${quadrants} of 4 quarter turns. A scan at one of the remaining quarter turns would improve accuracy.`
        : null
    groups.push({
      plane,
      scans,
      anglesDegrees,
      spreadDegrees,
      quadrants,
      ready,
      statusText,
      statusIcon: ready ? 'mdi-check-circle' : 'mdi-alert-circle-outline',
      statusColor: ready ? 'success' : 'warning',
      note,
    })
  }
  return groups
})
const groupedIds = computed(() => {
  const ids = new Set<number>()
  for (const g of planeGroups.value) for (const s of g.scans) ids.add(s.id)
  return ids
})
const ungroupedScans = computed(() => store.scans.filter((s) => !groupedIds.value.has(s.id)))

const canAnalyze = computed(() => {
  const n = store.scans.length
  return (
    !anyPending.value &&
    n >= 2 &&
    n <= MAX_SCANS &&
    notReady.value.length === 0 &&
    resolutionBadCount.value === 0 &&
    planeGroups.value.length > 0 &&
    planeGroups.value.every((g) => g.ready)
  )
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
  if (n === 0) return 'Add at least two scans of each plate you want to calibrate.'
  const bad = notReady.value.length
  if (bad > 0) return `Fix ${bad} scan${bad === 1 ? '' : 's'} to analyze.`
  const wrongRes = resolutionBadCount.value
  if (wrongRes > 0)
    return wrongRes === 1
      ? 'One scan measures a wrong resolution; replace it to analyze.'
      : `${wrongRes} scans measure a wrong resolution; replace them to analyze.`
  const short = planeGroups.value.find((g) => !g.ready)
  if (short) return `${short.plane} plate: ${short.statusText}`
  return ''
})

/**
 * Orders a plane group's scans around the angle circle, starting after the largest gap between
 * consecutive angles, so scans at nearly the same angle are always adjacent even across the
 * 360-to-0 wrap.
 */
function sortByCircularAngle(scans: SkewCouponScan[]): SkewCouponScan[] {
  const withAngle = scans.map((s) => ({
    scan: s,
    angle: normalizeAngle(xAxisAngleDegrees(s.result!.orientation!)),
  }))
  withAngle.sort((a, b) => a.angle - b.angle)
  if (withAngle.length < 2) return withAngle.map((e) => e.scan)
  let cutIndex = 0
  let largestGap = -1
  for (let i = 0; i < withAngle.length; i++) {
    const next = withAngle[(i + 1) % withAngle.length]
    const gap = normalizeAngle(next.angle - withAngle[i].angle)
    if (gap > largestGap) {
      largestGap = gap
      cutIndex = (i + 1) % withAngle.length
    }
  }
  return [...withAngle.slice(cutIndex), ...withAngle.slice(0, cutIndex)].map((e) => e.scan)
}

/** The measured placement angle shown in a group header, one decimal, folded so 359.96 reads 0.0 and not 360.0. */
function formatAngle(a: number): string {
  const rounded = Math.round(a * 10) / 10
  return `${(rounded % 360).toFixed(1)}°`
}
function dialLabel(g: PlaneGroup): string {
  return `Scan angles: ${g.anglesDegrees.map(formatAngle).join(', ')}`
}

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
// A plane whose scan set could not be separated (angles too close together, or a mirror-flip
// mismatch) still produces numbers, but they shouldn't be trusted, so surface it rather than
// showing a clean result indistinguishable from a good one.
const invalidPlanes = computed(() =>
  planes.value
    .filter((p) => !p.scanSet.rotationLooksValid)
    .map((p) => ({
      plane: p.plane,
      reason: p.scanSet.failureReason ?? 'The scans could not be combined.',
    })),
)

// With enough scans of a plate the least-squares fit reports a 95% confidence range per figure.
// The ranges are per plane; a scale tile shows one only when its axis was measured by exactly one
// plane, since a figure averaged across two plates has no single scan set to take a spread from.
function makeRange(
  point: number,
  halfWidth: number,
  standardError: number,
  unit: '°' | '%',
  scanCount: number,
): MetricRange {
  return { low: point - halfWidth, high: point + halfWidth, point, unit, scanCount, standardError }
}
// Zero within one standard error of the estimate: tighter than (and independent of) the 95% range
// the bar/caption show, so a range can include zero without qualifying for the no-correction note.
function isZeroWithinOneSE(r: MetricRange): boolean {
  return Math.abs(r.point) <= r.standardError
}
interface ScaleRangeEntry {
  range: MetricRange
  plane: Plane
  /** Which of the plane's two in-plane figures the axis maps to. */
  figure: 'scaleX' | 'scaleY'
}
const scaleRanges = computed(() => {
  const byAxis = new Map<'X' | 'Y' | 'Z', ScaleRangeEntry>()
  for (const s of scales.value) {
    if (s.sources.length !== 1) continue
    const p = planes.value.find((pl) => pl.plane === s.sources[0])
    const u = p?.scanSet.uncertainty
    if (!p || !u) continue
    const figure = planeAxes(p.plane)[0] === s.axis ? 'scaleX' : 'scaleY'
    const fig = figure === 'scaleX' ? u.scaleX : u.scaleY
    byAxis.set(s.axis, {
      range: makeRange(s.scalePercent, fig.rangeHalfWidth, fig.standardError, '%', u.scanCount),
      plane: p.plane,
      figure,
    })
  }
  return byAxis
})
const skewRanges = computed(() => {
  const byPlane = new Map<Plane, MetricRange>()
  for (const p of planes.value) {
    const u = p.scanSet.uncertainty
    if (u)
      byPlane.set(
        p.plane,
        makeRange(
          p.scanSet.combined.skewDegrees,
          u.skew.rangeHalfWidth,
          u.skew.standardError,
          '°',
          u.scanCount,
        ),
      )
  }
  return byPlane
})
// A plate scanned fewer than MIN_SCANS_FOR_RANGE times has no range yet; say how many scans away it is.
const moreScansHints = computed(() =>
  planes.value
    .filter((p) => p.scanSet.uncertainty === null && p.scanSet.rotationLooksValid)
    .map((p) => {
      const missing = Math.max(1, MIN_SCANS_FOR_RANGE - p.scanSet.scans.length)
      return {
        plane: p.plane,
        text: `Scan this plate ${missing} more ${missing === 1 ? 'time' : 'times'} to get a confidence range, which shows how tightly the value is pinned down.`,
      }
    }),
)

// Planes whose every figure is zero within one standard error: nothing on that plane needs correcting.
const wellCalibratedPlanes = computed(() =>
  planes.value
    .filter((p) => {
      const u = p.scanSet.uncertainty
      if (!u) return false
      const c = p.scanSet.combined
      return (
        Math.abs(c.xScalePercent) <= u.scaleX.standardError &&
        Math.abs(c.yScalePercent) <= u.scaleY.standardError &&
        Math.abs(c.skewDegrees) <= u.skew.standardError
      )
    })
    .map((p) => p.plane),
)

// A tip above a fix snippet when some or all of the figures it corrects have a range that includes
// zero. The command values themselves are never altered.
function zeroRangeNote(zeroNames: string[], totalFigures: number): string | null {
  if (zeroNames.length === 0) return null
  if (zeroNames.length === totalFigures)
    return "Every figure's range includes zero, so no correction appears to be needed. The commands below reflect the measured values in case you still want to apply them."
  const list = zeroNames.join(' and ')
  return zeroNames.length === 1
    ? `The ${list} range includes zero, so that figure may not need correcting; the other figures do.`
    : `The ${list} ranges include zero, so those figures may not need correcting; the other figures do.`
}
const skewZeroNote = computed(() =>
  zeroRangeNote(
    [...skewRanges.value].filter(([, r]) => isZeroWithinOneSE(r)).map(([p]) => `${p} skew`),
    skews.value.length,
  ),
)
const sizeZeroNote = computed(() =>
  zeroRangeNote(
    [...scaleRanges.value].filter(([, e]) => isZeroWithinOneSE(e.range)).map(([axis]) => `${axis} scale`),
    scales.value.length,
  ),
)

// Changing the scan set after an analysis invalidates its results: clear the payload so the user
// can add or remove scans and analyze again.
watch(
  () => store.scans.map((s) => s.id).join(','),
  () => {
    if (app.payload !== null) app.clearResults()
  },
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

// Plate picker cards in step 3: one entry per downloadable plate, with the caption and glyph
// orientation the card shows. The selection drives the guidance panel and the download button.
const plateCards: ReadonlyArray<{ key: string; caption: string; standing: boolean }> = [
  { key: 'xy', caption: 'XY (flat)', standing: false },
  { key: 'xz', caption: 'XZ (standing)', standing: true },
  { key: 'yz', caption: 'YZ (standing)', standing: true },
]
const selectedPlates = ref<string[]>(['xy'])
const selectedPlateEntries = computed(() =>
  plates.filter((p) => selectedPlates.value.includes(p.key)),
)
const anyStandingSelected = computed(() =>
  selectedPlates.value.some((key) => key !== 'xy'),
)
const downloadLabel = computed(() => {
  const keys = selectedPlateEntries.value.map((p) => p.key.toUpperCase())
  if (keys.length === 0) return 'Download'
  if (keys.length === 1) return `Download ${keys[0]} plate`
  return `Download ${keys.join(' + ')} plates`
})

function buildCoupon(): CouponSpec {
  return { ...defaultCouponSpec(), baselineMm: baselineMm.value ?? 100, gridN: gridN.value ?? 5 }
}

function downloadSelectedCoupons(): void {
  // Browsers gate multiple downloads fired in the same tick without a fresh user gesture per file
  // (Chrome/Firefox silently block the 2nd+ after the first), so space them out.
  selectedPlateEntries.value.forEach((p, i) => setTimeout(() => getCoupon(p.file), i * 400))
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
  // The card calibration stores the scanner's scale error, which holds across resolutions, so it
  // is priced at the calibration DPI: the resolution the coupon scan is expected to use.
  const cal = calibration.calibration
  const pxPerMm = cal
    ? scaleReferenceAtDpi(cal, cal.dpi)
    : dpi.value != null && dpi.value >= 50
      ? dpi.value / 25.4
      : null
  try {
    // The reconcile re-runs the per-scan resolution gate the cards already show, so a wrong
    // resolution can never slip into the averaged figures even if the UI state went stale.
    const result = reconcileScans(
      measured.map((s) => asAligned(toRaw(s.result!))),
      pxPerMm,
      resolutionExpected.value?.dpi ?? null,
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
          data-testid="firmware-select"
        />
      </div>
      <p class="text-body-2 text-medium-emphasis mt-1">
        Print a plate for each plane you want to calibrate, scan each plate, and drop the scans in.
        The app works out X, Y, and Z scale and skew; two scans of a plate give a result, four or more
        add a confidence range.
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
            <span class="text-medium-emphasis" data-testid="calibration-status-line">{{ calibrationLine }}</span>
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
      <p v-if="!isCalibrated" class="tip">
        Scanning a standard plastic card of known size teaches the app the true pixels per
        millimeter, which no scanner reports exactly. Without it the app still measures skew and the
        difference between X and Y scale, but not absolute size.
      </p>
    </section>

    <!-- 2. Reset printer skew -->
    <section class="step mb-3">
      <div class="step-head mb-2">
        <span class="num">2</span><span class="step-title">Reset printer skew</span>
      </div>
      <div class="warn-box mb-3">
        <v-icon color="warning" size="16" class="warn-icon">mdi-alert-outline</v-icon>
        <span>
          <strong class="warn-lead">
            Turn off skew correction in the printer's firmware before printing the plates.
          </strong>
          Any correction still active bends the plate as it prints, so the skew ScanNTune reports
          would be measured on top of the old correction and come out wrong.
        </span>
      </div>
      <CodeBlock :code="resetCommand.code" data-testid="reset-skew-code" />
      <p v-if="resetCommand.hint" class="tip mt-0">{{ resetCommand.hint }}</p>
    </section>

    <!-- 3. Print the plates -->
    <section class="step mb-3">
      <div class="step-head mb-2">
        <span class="num">3</span><span class="step-title">Print the plate(s)</span>
      </div>
      <p class="tip mt-0 mb-1">
        <strong>Print it exactly as downloaded. Do not rotate or mirror it.</strong> A flipped plate
        reports the wrong X and Y directions, and the scan cannot detect that this happened.
      </p>
      <v-item-group v-model="selectedPlates" multiple class="plate-select">
        <v-item v-for="c in plateCards" :key="c.key" :value="c.key" v-slot="{ isSelected, toggle }">
          <div
            class="plate-card"
            :class="{ selected: isSelected }"
            :data-testid="`plate-select-${c.key}`"
            role="checkbox"
            :aria-checked="isSelected ? 'true' : 'false'"
            tabindex="0"
            @click="toggle"
            @keydown.enter="toggle"
          >
            <PlateStyleGlyph :standing="c.standing" />
            <span class="glyph-cap">{{ c.caption }}</span>
          </div>
        </v-item>
      </v-item-group>
      <p v-if="anyStandingSelected" class="tip" data-testid="plate-brim-tip">
        <strong>Add an 8&nbsp;mm brim to the outer side; peel it off and file the edge smooth before
        scanning.</strong> Thin-edge plates lift at the corners without one.
      </p>
      <p class="tip">Let the bed cool before removing the plate.</p>
      <div class="plate-actions mt-2">
        <v-btn
          data-testid="plate-download-button"
          color="primary"
          variant="flat"
          size="small"
          prepend-icon="mdi-download"
          :disabled="selectedPlateEntries.length === 0"
          @click="downloadSelectedCoupons"
        >
          {{ downloadLabel }}
        </v-btn>
      </div>
    </section>

    <!-- 4. Scan your prints -->
    <section class="step mb-3">
      <div class="step-head mb-1">
        <span class="num">4</span><span class="step-title">Scan your prints</span>
      </div>
      <p class="tip mb-2">
        Cover the plate with a backing that contrasts with its color: dark paper behind a light
        plate, or the white lid behind a dark plate. Scan the plate once. Turn it on the glass and
        scan it again. Use the same face down for every scan of a plate.
      </p>
      <p class="tip mb-2" data-testid="scan-dpi-hint">
        <strong>{{ scanDpiHint || 'Scan at 600 dpi.' }}</strong>
      </p>
      <p class="tip mb-3">
        More scans improve accuracy. Four plates, turned a quarter turn each, are ideal. Up to
        {{ MAX_SCANS }} scans in total.
      </p>

      <div class="scan-flow">
        <div class="glyph-step">
          <CouponGlyph :rotate="0" :size="76" />
          <span class="glyph-cap">Scan 1</span>
        </div>
        <div class="connector">
          <v-icon class="arrow" color="primary" size="26">mdi-rotate-right</v-icon>
          <span class="deg">turn the plate</span>
        </div>
        <div class="glyph-step">
          <div class="roll">
            <div class="glyph-wrap"><CouponGlyph :size="76" /></div>
          </div>
          <span class="glyph-cap">Scan 2</span>
        </div>
        <div class="connector">
          <v-icon class="arrow" color="primary" size="26">mdi-rotate-right</v-icon>
          <span class="deg">turn again</span>
        </div>
        <div class="glyph-step faded">
          <CouponGlyph :rotate="180" :size="76" />
          <span class="glyph-cap">More scans (optional)</span>
        </div>
      </div>
    </section>

    <!-- 5. Upload your scans -->
    <section class="step mb-3">
      <div class="step-head mb-1">
        <span class="num">5</span><span class="step-title">Upload your scans</span>
      </div>
      <p class="tip mb-3">
        Drop in every scan at once. The app reads each one, identifies which plate and which plane it
        shows, and groups them below. A plate needs at least two scans to produce a result.
      </p>

      <label v-if="store.scans.length < MAX_SCANS" class="dropzone">
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

      <div v-if="store.scans.length" class="mt-3" data-testid="islands">
        <div v-if="ungroupedScans.length" class="islands mb-3">
          <ScanIsland
            v-for="s in ungroupedScans"
            :key="s.id"
            :scan="s"
            :removable="true"
            :resolution="resolutionVerdicts.get(s.id)"
            @remove="store.remove(s.id)"
          />
        </div>

        <section
          v-for="g in planeGroups"
          :key="g.plane"
          class="plane-group mb-3"
          :data-testid="`plane-group-${g.plane}`"
        >
          <div class="pg-head">
            <span class="pg-title">{{ g.plane }} plane</span>
            <v-chip size="x-small" variant="tonal" color="primary" class="pg-chip">
              {{ g.scans.length }} {{ g.scans.length === 1 ? 'scan' : 'scans' }}
            </v-chip>
            <svg
              class="pg-dial"
              viewBox="0 0 32 32"
              role="img"
              :aria-label="dialLabel(g)"
            >
              <circle cx="16" cy="16" r="13" class="dial-ring" />
              <line
                v-for="(a, i) in g.anglesDegrees"
                :key="i"
                x1="16"
                y1="16"
                :x2="16 + 13 * Math.cos((a * Math.PI) / 180)"
                :y2="16 + 13 * Math.sin((a * Math.PI) / 180)"
                class="dial-tick"
              />
            </svg>
            <span class="pg-angles">
              Scan angles: {{ g.anglesDegrees.map(formatAngle).join(', ') }}
            </span>
            <span class="pg-status">
              <v-icon :color="g.statusColor" size="15">{{ g.statusIcon }}</v-icon>
              <span :data-testid="`plane-status-${g.plane}`">{{ g.statusText }}</span>
            </span>
          </div>
          <p v-if="g.note" class="pg-note">
            <v-icon color="info" size="14">mdi-information-outline</v-icon>
            {{ g.note }}
          </p>
          <div class="islands">
            <ScanIsland
              v-for="s in g.scans"
              :key="s.id"
              :scan="s"
              :removable="true"
              :problem="planeProblems.get(s.id)"
              :resolution="resolutionVerdicts.get(s.id)"
              @remove="store.remove(s.id)"
            />
          </div>
        </section>
      </div>

      <div class="fields mt-4">
        <NumericField
          v-if="!isCalibrated"
          v-model="dpi"
          label="Scanner DPI"
          :step="100"
          :min="50"
          hint="The app divides DPI by 25.4 to get pixels per millimeter. Leave it blank to skip absolute size."
        />
        <template v-if="fieldsLocked">
          <div class="locked-field">
            <span class="lf-label">Plate baseline (mm)</span>
            <span class="lf-value">{{ baselineMm }}</span>
          </div>
          <div class="locked-field">
            <span class="lf-label">Rings per side</span>
            <span class="lf-value">{{ gridN }}</span>
          </div>
        </template>
        <template v-else>
          <NumericField
            v-model="baselineMm"
            label="Plate baseline (mm)"
            :step="10"
            :min="10"
            testid="baseline-mm-input"
          />
          <NumericField
            v-model="gridN"
            label="Rings per side"
            :step="1"
            :min="2"
            testid="grid-n-input"
          />
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
        <p v-if="analyzeReason" class="tip text-center mt-2" data-testid="analyze-reason">{{ analyzeReason }}</p>

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
            <strong class="warn-lead">{{ bad.plane }}</strong> did not align. {{ bad.reason }}
            These figures cannot be trusted until it is fixed.<template
              v-if="i < invalidPlanes.length - 1"
            >
            </template>
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
          :range="scaleRanges.get(s.axis)?.range"
          :figure-name="`${s.axis} scale`"
          :range-testid="
            scaleRanges.has(s.axis)
              ? `range-${scaleRanges.get(s.axis)!.figure}-${scaleRanges.get(s.axis)!.plane}`
              : undefined
          "
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
          :range="skewRanges.get(k.plane)"
          :figure-name="`${k.plane} skew`"
          :range-testid="`range-skew-${k.plane}`"
        />
      </div>
      <p class="tip mt-0 mb-2" data-testid="skew-reference-frame-hint">
        Positive skew means the corner between the printer's +X and +Y axes prints wider than 90
        degrees. You do not correct the sign yourself: the commands below already carry the right
        value to cancel the measured skew.
      </p>
      <div v-if="moreScansHints.length || wellCalibratedPlanes.length" class="mb-4">
        <p
          v-for="h in moreScansHints"
          :key="h.plane"
          class="tip mt-0"
          :data-testid="`more-scans-${h.plane}`"
        >
          {{ h.plane }} plate: {{ h.text }}
        </p>
        <p
          v-for="plane in wellCalibratedPlanes"
          :key="plane"
          class="plane-ok mt-0"
          :data-testid="`zero-note-plane-${plane}`"
        >
          <v-icon color="success" size="15" class="po-icon">mdi-check-circle</v-icon>
          <span>
            <strong>{{ plane }}:</strong> Your printer is already well calibrated for this plane.
            No changes are needed.
          </span>
        </p>
      </div>

      <div class="fix-tabs">
        <button
          type="button"
          class="fix-tab"
          data-testid="fix-tab-skew"
          :class="{ active: activeFixTab === 'skew' }"
          @click="activeFixTab = 'skew'"
        >
          Fix skew
        </button>
        <button
          type="button"
          class="fix-tab"
          data-testid="fix-tab-size"
          :class="{ active: activeFixTab === 'size' }"
          @click="activeFixTab = 'size'"
        >
          Fix size
        </button>
      </div>

      <div v-if="activeFixTab === 'skew'" class="fix-panel">
        <p v-if="skewZeroNote" class="tip mt-0 mb-2" data-testid="zero-note-skewfix">
          {{ skewZeroNote }}
        </p>
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
          data-testid="skew-code-secondary"
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
        <p v-if="sizeZeroNote" class="tip mt-0 mb-2" data-testid="zero-note-sizefix">
          {{ sizeZeroNote }}
        </p>
        <CodeBlock v-if="sizeFix" :code="sizeFix.code" data-testid="size-code" />
        <p v-if="sizeFix?.hint" class="tip mt-0">{{ sizeFix.hint }}</p>
      </div>

      <p class="tip mt-3" data-testid="verify-fix-tip">
        To confirm the fix, print the plate again with the correction active and scan it; the skew
        should now read near zero.
      </p>
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
  flex-wrap: wrap;
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
.glyph-step.faded {
  opacity: 0.4;
}
.plate-select {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 12px;
  padding: 8px 0 4px;
}
.plate-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 18px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 10px;
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}
.plate-card:hover {
  border-color: rgba(var(--v-theme-primary), 0.5);
}
.plate-card.selected {
  border-color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.08);
}
.plate-actions {
  display: flex;
  align-items: center;
  gap: 8px;
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
.plane-group {
  border: 1px solid rgba(var(--v-theme-on-surface), 0.14);
  border-radius: 12px;
  padding: 12px;
}
.pg-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
.pg-title {
  font-weight: 600;
  font-size: 13.5px;
}
.pg-chip {
  flex-shrink: 0;
}
.pg-dial {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
}
.dial-ring {
  fill: none;
  stroke: rgba(var(--v-theme-on-surface), 0.25);
  stroke-width: 1.5;
}
.dial-tick {
  stroke: rgb(var(--v-theme-primary));
  stroke-width: 2;
  stroke-linecap: round;
}
.pg-angles {
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), 0.65);
  font-variant-numeric: tabular-nums;
}
.pg-status {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), 0.75);
  margin-left: auto;
}
.pg-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), 0.65);
  margin: 0 0 10px;
}
@media (max-width: 560px) {
  .plane-group {
    padding: 10px;
  }
  .pg-head {
    row-gap: 4px;
  }
  .pg-status {
    margin-left: 0;
    flex-basis: 100%;
  }
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
.plane-ok {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12.5px;
  color: rgb(var(--v-theme-success));
  margin-top: 6px;
}
.po-icon {
  margin-top: 1px;
  flex-shrink: 0;
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
