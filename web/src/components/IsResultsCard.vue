<script setup lang="ts">
import { computed } from 'vue'
import type {
  IsAxisResult,
  IsLineExclusion,
  IsLineOutcome,
  IsLineRefusalCategory,
  IsResult,
} from '../engine/is/resultTypes'
import { isCheckRows } from './isCheckRows'
import { F_MIN_HZ, F_MAX_HZ } from '../engine/is/types'
import { formatKlipperShaper } from '../engine/is/shaperRecommender'
import CodeBlock from './CodeBlock.vue'
import MetricTile from './MetricTile.vue'

// Renders the outcome of the two-scan input shaper analysis: per-axis figures or refusals,
// the shaper comparison table, and the Klipper configuration snippet. Pure presentation over
// the IsResult.
const props = defineProps<{ result: IsResult }>()

const axes = computed(() => props.result.axes)
const acceptedAxes = computed(() => axes.value.filter((a) => a.accepted))

function axisName(a: IsAxisResult): string {
  return `${a.axis.toUpperCase()} axis`
}

function frequencyText(a: IsAxisResult): string {
  const ci = a.frequencyCi95Hz !== null ? ` ± ${a.frequencyCi95Hz.toFixed(1)}` : ''
  return `${a.frequencyHz!.toFixed(1)}${ci} Hz`
}

function percent(v: number): string {
  return `${(100 * v).toFixed(1)}%`
}

// With a second mode that grows with the corner speed, the shapers are scored by the share of the
// two modes' spectrum they leave above the reduction floor, not by the residual across one mode's
// tolerance band.
function residualHeader(a: IsAxisResult): string {
  return a.secondMode !== null && a.secondMode.proportionality !== 'failed'
    ? 'Remaining vibration over both modes'
    : 'Residual vibration across the tolerance band'
}

// The refused lines of a refused axis are summarized in its alert as one labeled count per
// refusal category, so the alert reads as a short list of facts instead of repeated prose;
// each label describes what the line looked like, not which internal gate refused it. Only a
// line with a refusal category is counted; a line in the joint fit has none. An axis refused
// before its joint fit (no ringing detected, or too few lines left after the screening) puts
// no line in a joint fit, so the table below shows "In joint fit: no" also for lines the
// counts leave out. On a measured axis the table alone shows the per-line outcomes.
const CATEGORY_LABELS: Record<NonNullable<IsLineRefusalCategory>, string> = {
  'irregular-trace': 'Trace too irregular to read as ringing',
  'out-of-band': `Ringing outside the ${F_MIN_HZ} to ${F_MAX_HZ} Hz measurable range`,
  'frequency-outlier': 'Ringing frequency far from the other lines',
  'not-traced': 'Line not found in the scan',
}

// Per-line diagnostic rows: each underlying fact is its own labeled column with the exact
// value (joint-fit membership as yes/no, the exclusion as a category label, frequency and
// amplitude as numbers with units). The amplitude is the ring's at the start of the free
// ringdown, from the joint fit for a line in it and from the line's own fit otherwise.
// An axis never assigned a scan has no per-line measurements, so it gets no table.
const EXCLUSION_LABELS: Record<IsLineExclusion, string> = {
  'no-free-response': 'No free ringdown after the corner',
  'out-of-band': `Fitted frequency at the edge of the ${F_MIN_HZ} to ${F_MAX_HZ} Hz search range`,
  'frequency-outlier': 'Fitted frequency is an outlier among the lines',
  'not-traced': 'Line not found in the scan',
}

function lineExclusionText(line: IsLineOutcome): string {
  return line.exclusion !== null ? EXCLUSION_LABELS[line.exclusion] : ''
}

function lineFrequencyText(line: IsLineOutcome): string {
  return line.frequencyHz !== null ? `${line.frequencyHz.toFixed(1)} Hz` : ''
}

function lineAmplitudeText(line: IsLineOutcome): string {
  return line.amplitudeMm !== null ? `${line.amplitudeMm.toFixed(3)} mm` : ''
}

function refusalCounts(a: IsAxisResult): string[] {
  const counts = new Map<IsLineRefusalCategory, number>()
  for (const line of a.lines) {
    if (line.refusalCategory !== null) {
      counts.set(line.refusalCategory, (counts.get(line.refusalCategory) ?? 0) + 1)
    }
  }
  return (Object.keys(CATEGORY_LABELS) as IsLineRefusalCategory[])
    .filter((c) => counts.has(c))
    .map((c) => `${CATEGORY_LABELS[c]}: ${counts.get(c)} ${counts.get(c) === 1 ? 'line' : 'lines'}`)
}

// The ready-to-paste Klipper snippet: a persistent [input_shaper] block for printer.cfg.
const snippet = computed(() => {
  const accepted = acceptedAxes.value
  if (accepted.length === 0) return null
  // The formatter sets the damping ratio the recommended shaper was designed at (the measured one
  // for one mode, Klipper's default for two), so the firmware builds the shaper that was scored.
  // A damping ratio at the upper bound of the fit is not a measurement: the shaper is then
  // designed at Klipper's default, and the formatter writes that value.
  const lines = accepted.flatMap((a) => formatKlipperShaper(a.axis, a.recommended!).split('\n'))
  return { code: ['[input_shaper]', ...lines].join('\n'), note: 'Add the block to printer.cfg and restart the firmware.' }
})
</script>

<template>
  <div>
    <v-alert
      v-if="!result.aligned"
      type="error"
      variant="tonal"
      :text="result.failureReason ?? 'The scans could not be aligned.'"
      data-testid="is-failure"
    />

    <template v-else>
      <div v-for="axis in axes" :key="axis.axis" class="mb-4">
        <div class="axis-head mb-2">
          <span class="axis-title">{{ axisName(axis) }}</span>
          <v-chip
            size="x-small"
            variant="tonal"
            :color="axis.accepted ? 'success' : 'warning'"
            :data-testid="`is-axis-status-${axis.axis}`"
          >
            {{ axis.accepted ? 'measured' : 'not measured' }}
          </v-chip>
        </div>

        <template v-if="axis.accepted">
          <div class="tiles mb-2">
            <MetricTile
              label="Resonance frequency"
              :value="frequencyText(axis)"
              :testid="`is-frequency-${axis.axis}`"
            />
            <MetricTile
              label="Damping ratio"
              :value="axis.dampingRatio!.toFixed(3)"
              :testid="`is-damping-${axis.axis}`"
            />
            <MetricTile
              label="Frequency standard error"
              :value="axis.frequencySeHz !== null ? `${axis.frequencySeHz.toFixed(2)} Hz` : 'n/a'"
              :testid="`is-frequency-se-${axis.axis}`"
            />
            <MetricTile
              label="Lines used"
              :value="`${axis.linesUsed} of ${axis.linesTraced}`"
              :testid="`is-lines-${axis.axis}`"
            />
          </div>
          <p class="tip mt-0 mb-2">The interval covers the statistical error of the fit only.</p>
          <v-table density="compact" class="shaper-table" :data-testid="`is-shapers-${axis.axis}`">
            <thead>
              <tr>
                <th>Shaper</th>
                <th>{{ residualHeader(axis) }}</th>
                <th>Max accel</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="option in axis.shapers!"
                :key="option.type"
                :class="{ recommended: option.type === axis.recommended!.type }"
              >
                <td>
                  {{ option.type }}
                  <v-chip
                    v-if="option.type === axis.recommended!.type"
                    size="x-small"
                    color="primary"
                    variant="tonal"
                    class="ml-1"
                  >
                    recommended
                  </v-chip>
                </td>
                <td>{{ percent(option.bandResidualVibration) }}</td>
                <td>{{ Math.round(option.maxAccelMmS2) }} mm/s^2</td>
              </tr>
            </tbody>
          </v-table>
        </template>

        <v-alert
          v-else
          type="warning"
          variant="tonal"
          density="compact"
          class="soft-alert"
          :data-testid="`is-refusals-${axis.axis}`"
        >
          <p v-for="(reason, i) in axis.refusals" :key="i" class="refusal">{{ reason }}</p>
          <p v-for="(row, i) in refusalCounts(axis)" :key="`c${i}`" class="refusal count-row">{{ row }}</p>
        </v-alert>

        <v-table
          v-if="axis.scanIndex !== null && axis.lines.length > 0"
          density="compact"
          class="line-table mt-2"
          :data-testid="`is-checks-${axis.axis}`"
        >
          <tbody>
            <tr v-for="row in isCheckRows(axis)" :key="row.label">
              <td>{{ row.label }}</td>
              <td>{{ row.value }}</td>
            </tr>
          </tbody>
        </v-table>

        <v-table
          v-if="axis.scanIndex !== null && axis.lines.length > 0"
          density="compact"
          class="line-table mt-2"
          :data-testid="`is-line-detail-${axis.axis}`"
        >
          <thead>
            <tr>
              <th>Line</th>
              <th>Line speed</th>
              <th>Corner speed</th>
              <th>Ringing detected</th>
              <th>In joint fit</th>
              <th>Exclusion</th>
              <th>Frequency</th>
              <th>Free ringdown amplitude</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="line in axis.lines" :key="line.lineIndex">
              <td>{{ line.lineIndex + 1 }}</td>
              <td>{{ line.speedMmS }} mm/s</td>
              <td>{{ Math.round(line.cornerSpeedMmS) }} mm/s</td>
              <td>{{ line.traced ? (line.detected ? 'yes' : 'no') : '' }}</td>
              <td>{{ line.usedInJointFit ? 'yes' : 'no' }}</td>
              <td>{{ lineExclusionText(line) }}</td>
              <td>{{ lineFrequencyText(line) }}</td>
              <td>{{ lineAmplitudeText(line) }}</td>
            </tr>
          </tbody>
        </v-table>
      </div>

      <template v-if="snippet">
        <CodeBlock :code="snippet.code" data-testid="is-code" />
        <p class="tip mt-0 mb-0">{{ snippet.note }}</p>
      </template>
    </template>
  </div>
</template>

<style scoped>
.axis-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.axis-title {
  font-weight: 500;
  font-size: 14px;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 8px;
}
.shaper-table {
  background: rgb(var(--v-theme-surface-bright));
  border-radius: 10px;
}
.line-table {
  background: rgb(var(--v-theme-surface-bright));
  border-radius: 10px;
  font-size: 12.5px;
}
.shaper-table .recommended {
  background: rgba(var(--v-theme-primary), 0.1);
}
.refusal {
  margin: 0;
}
.refusal + .refusal {
  margin-top: 6px;
}
.refusal + .count-row,
.count-row + .count-row {
  margin-top: 2px;
}
.soft-alert {
  font-size: 0.875rem;
}
.tip {
  font-size: 12.5px;
  color: rgba(var(--v-theme-on-surface), 0.6);
  margin-top: 8px;
}
</style>
