<script setup lang="ts">
import { computed, ref } from 'vue'
import { SkewCouponScan, ScanState } from '../model/skewCouponScan'
import { ringSeverity } from '../engine/scanDiagnostics'
import { normalizeAngle } from '../engine/scanCombiner'
import { xAxisAngleDegrees } from '../engine/types'
import { resolutionBadge, resolutionRowValue } from '../util/scanResolution'
import type { ScanResolutionVerdict } from '../util/scanResolution'
import OverlayCanvas from './OverlayCanvas.vue'

const props = defineProps<{
  scan: SkewCouponScan
  removable?: boolean
  problem?: 'duplicate'
  /** The scan's resolution verdict within the uploaded set; undefined until measured. */
  resolution?: ScanResolutionVerdict
  /** True when the scan is rejected because a flat plate reads mirrored (mirroredScanInvalid). */
  mirrored?: boolean
}>()
const emit = defineEmits<{ (e: 'remove'): void }>()

// Scan <-> Threshold: the threshold mask is the binary image the detector searched for holes, cropped
// to the same frame as the overlay, so a hole that failed to register shows as a filled blob where it
// should be a black dot.
const showMask = ref(false)
const shownBitmap = computed(() =>
  showMask.value && props.scan.mask ? props.scan.mask : props.scan.overlay,
)

type Sev = 'ok' | 'warn' | 'err' | 'mute'
const ICON: Record<Sev, string> = {
  ok: 'mdi-check-circle',
  warn: 'mdi-alert-circle',
  err: 'mdi-close-circle',
  mute: 'mdi-minus-circle-outline',
}
const COLOR: Record<Sev, string> = { ok: 'success', warn: 'warning', err: 'error', mute: 'grey' }

const isPending = computed(() => props.scan.state === ScanState.Pending)
const isUnreadable = computed(() => props.scan.state === ScanState.Unreadable)

const rows = computed(() => {
  const s = props.scan
  const aligned = s.aligned
  const rs = ringSeverity(s.ringsFound, s.ringsExpected, aligned)
  const ringSev: Sev = rs === 'ok' ? 'ok' : rs === 'warning' ? 'warn' : 'err'
  const planeSev: Sev = s.plane ? 'ok' : aligned ? 'warn' : 'mute'
  const flipValue = s.flipped === null ? 'Unknown' : s.flipped ? 'Mirrored' : 'None'
  const angle = s.result?.orientation ? normalizeAngle(xAxisAngleDegrees(s.result.orientation)) : null
  const measuredPxPerMm =
    s.result?.measuredPxPerMmX != null && s.result?.measuredPxPerMmY != null
      ? Math.sqrt(s.result.measuredPxPerMmX * s.result.measuredPxPerMmY)
      : null
  return [
    { label: 'Rings', value: `${s.ringsFound} of ${s.ringsExpected}`, sev: ringSev, testid: 'ring-count' },
    { label: 'Plane', value: s.plane ?? 'Not detected', sev: planeSev, testid: undefined },
    {
      label: 'Rotation',
      value: aligned && angle !== null ? `${angle.toFixed(1)}°` : 'Not resolved',
      sev: (aligned ? 'ok' : 'mute') as Sev,
      testid: 'scan-angle',
    },
    {
      label: 'Flip',
      value: flipValue,
      sev: (s.flipped === null ? 'mute' : props.mirrored ? 'err' : 'ok') as Sev,
      testid: 'scan-flip',
    },
    {
      label: 'Resolution',
      value: resolutionRowValue(measuredPxPerMm),
      sev: (measuredPxPerMm === null
        ? 'mute'
        : props.resolution && !props.resolution.ok
          ? 'err'
          : 'ok') as Sev,
      testid: 'scan-resolution',
    },
  ]
})

const badResolution = computed(() => resolutionBadge(props.resolution))

const pill = computed<{ text: string; sev: Sev } | null>(() => {
  switch (props.scan.state) {
    case ScanState.Unreadable:
      return { text: 'Could not read', sev: 'err' }
    case ScanState.Misaligned:
      return { text: 'Not aligned', sev: 'err' }
    case ScanState.Unlabeled:
      return { text: 'Plane not read', sev: 'warn' }
    case ScanState.Measured:
      if (badResolution.value) return { text: badResolution.value.text, sev: 'err' }
      if (props.mirrored) return { text: 'Mirrored scan', sev: 'err' }
      if (props.problem === 'duplicate') return { text: 'Nearly same angle', sev: 'warn' }
      return { text: `${props.scan.plane} plane`, sev: 'ok' }
    default:
      return null
  }
})

const stripe = computed<Sev | ''>(() => pill.value?.sev ?? '')

// The explanatory line under the pill: the engine's failure reason when the scan did not align, the
// fixed cause when it aligned but the plane-ID diagonals were not readable, or the clipping diagnosis
// when the fitted grid says a missing hole ran off an image edge.
const note = computed<string | null>(() => {
  if (props.scan.failureReason) return props.scan.failureReason
  if (badResolution.value) return badResolution.value.explanation
  if (props.mirrored)
    return (
      'The scan is mirrored. Scan the plate with its first-layer side on the glass. If it still ' +
      'reads mirrored, the plate was printed mirrored and cannot be measured.'
    )
  if (props.scan.state === ScanState.Unlabeled)
    return (
      'The plane-identifying marks near the origin corner could not be read, so this scan ' +
      'cannot be assigned to a plane. Print the current plates (they carry the marks) or rescan.'
    )
  const clipped = props.scan.clippedSides
  if (clipped.length > 0)
    return `A missing ring sits at the ${clipped.join(' and ')} image edge: the plate looks cut off there. Rescan with the whole plate inside the scan area.`
  if (props.problem === 'duplicate')
    return (
      'This scan is at nearly the same angle as another scan of this plate. ' +
      'Turn the plate further before scanning again.'
    )
  return null
})
</script>

<template>
  <div class="island" :class="stripe" data-testid="scan-island">
    <div class="preview">
      <div v-if="isPending" class="ph">
        <v-progress-circular indeterminate color="primary" size="28" />
      </div>
      <div v-else-if="isUnreadable" class="ph">
        <v-icon color="error" size="30">mdi-image-off-outline</v-icon>
      </div>
      <template v-else>
        <OverlayCanvas :bitmap="shownBitmap" />
        <div v-if="scan.mask" class="toggle" role="group" aria-label="Preview mode">
          <button type="button" :class="{ active: !showMask }" @click="showMask = false">Scan</button>
          <button
            type="button"
            :class="{ active: showMask }"
            data-testid="threshold-toggle"
            @click="showMask = true"
          >
            Threshold
          </button>
        </div>
      </template>
    </div>

    <div class="body">
      <div class="row1">
        <span class="fname">{{ scan.fileName }}</span>
        <button
          v-if="removable !== false"
          class="rm"
          type="button"
          title="Remove"
          @click="emit('remove')"
        >
          <v-icon size="16">mdi-close</v-icon>
        </button>
      </div>

      <span v-if="isPending" class="muted">Checking scan...</span>

      <template v-else-if="isUnreadable">
        <span class="pill err"><span class="dot"></span>Could not read</span>
        <p class="muted">{{ scan.error }}</p>
      </template>

      <template v-else>
        <span
          v-if="pill"
          class="pill"
          :class="pill.sev"
          :data-testid="
            badResolution ? 'scan-resolution-badge' : mirrored ? 'scan-mirrored-badge' : undefined
          "
        ><span class="dot"></span>{{ pill.text }}</span>
        <p v-if="note" class="muted" data-testid="failure-reason">
          {{ note }}
        </p>
        <div class="status">
          <template v-for="r in rows" :key="r.label">
            <v-icon :color="COLOR[r.sev]" size="16">{{ ICON[r.sev] }}</v-icon>
            <span class="slabel">{{ r.label }}</span>
            <span class="sval" :class="r.sev" :data-testid="r.testid">{{ r.value }}</span>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.island {
  display: flex;
  background: rgb(var(--v-theme-surface-bright));
  border: 1px solid rgba(var(--v-theme-on-surface), 0.09);
  border-radius: 12px;
  overflow: hidden;
  position: relative;
}
.island::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: transparent;
}
.island.ok::before {
  background: rgb(var(--v-theme-success));
}
.island.warn::before {
  background: rgb(var(--v-theme-warning));
}
.island.err::before {
  background: rgb(var(--v-theme-error));
}
.preview {
  flex: 0 0 200px;
  background: rgb(var(--v-theme-background));
  border-right: 1px solid rgba(var(--v-theme-on-surface), 0.09);
  position: relative;
  min-height: 150px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ph {
  width: 100%;
  height: 100%;
  min-height: 150px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.toggle {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  background: rgba(0, 0, 0, 0.82);
  border-radius: 8px;
  overflow: hidden;
}
.toggle button {
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.85);
  font-size: 11px;
  padding: 4px 9px;
  cursor: pointer;
}
.toggle button.active {
  background: rgb(var(--v-theme-primary));
  color: #fff;
  font-weight: 600;
}
/* Hover-capable pointers (mouse/trackpad) get the toggle out of the way until they need it; touch
   devices have no hover to reveal it with, so it stays visible there instead. */
@media (hover: hover) and (pointer: fine) {
  .toggle {
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.12s ease;
  }
  .preview:hover .toggle {
    opacity: 1;
    pointer-events: auto;
  }
}
.body {
  flex: 1 1 320px;
  padding: 14px 16px;
  min-width: 0;
}
.row1 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.fname {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rm {
  margin-left: auto;
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.35);
  color: rgba(var(--v-theme-on-surface), 0.62);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.rm:hover {
  color: rgb(var(--v-theme-on-surface));
}
.muted {
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), 0.6);
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
  margin-bottom: 12px;
}
.pill .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.pill.ok {
  background: rgba(var(--v-theme-success), 0.16);
  color: rgb(var(--v-theme-success));
}
.pill.ok .dot {
  background: rgb(var(--v-theme-success));
}
.pill.warn {
  background: rgba(var(--v-theme-warning), 0.16);
  color: rgb(var(--v-theme-warning));
}
.pill.warn .dot {
  background: rgb(var(--v-theme-warning));
}
.pill.err {
  background: rgba(var(--v-theme-error), 0.16);
  color: rgb(var(--v-theme-error));
}
.pill.err .dot {
  background: rgb(var(--v-theme-error));
}
.status {
  display: grid;
  grid-template-columns: 18px 74px 1fr;
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
.sval.err {
  color: rgb(var(--v-theme-error));
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
