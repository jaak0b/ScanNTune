<script setup lang="ts">
import { computed } from 'vue'
import type { Firmware } from '../engine/gcode/profileTypes'
import type { IsAxisResult, IsResult } from '../engine/is/resultTypes'
import {
  formatKlipperShaper,
  formatMarlinShaper,
  formatRrfShaper,
} from '../engine/is/shaperRecommender'
import CodeBlock from './CodeBlock.vue'
import MetricTile from './MetricTile.vue'

// Renders the outcome of the two-scan input shaper analysis: per-axis figures or refusals,
// the shaper comparison table, and the firmware snippet for the profile's firmware. Pure
// presentation over the IsResult; the firmware is the one selected when the scans were analyzed.
const props = defineProps<{ result: IsResult; firmware: Firmware }>()

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

// Several lines of an axis often fail for the same reason, and the engine reports each line;
// verbatim repetition adds no information, so identical reasons are collapsed with a count.
function dedupedRefusals(a: IsAxisResult): string[] {
  const counts = new Map<string, number>()
  for (const reason of a.refusals) counts.set(reason, (counts.get(reason) ?? 0) + 1)
  return [...counts.entries()].map(([reason, n]) => (n > 1 ? `${n} lines: ${reason}` : reason))
}

// On a measured axis the refusals only concern the skipped minority, so the note leads with
// the skipped count; without it the reason list can read as contradicting the measured chip.
function skippedNote(a: IsAxisResult): string {
  const skipped = a.linesTraced - a.linesUsed
  return `${skipped} of ${a.linesTraced} lines skipped: ${dedupedRefusals(a).join(' ')}`
}

// The ready-to-paste snippet in the selected firmware's own configuration language. Klipper
// takes a persistent [input_shaper] block; Marlin and RepRapFirmware take M593 commands.
const snippet = computed(() => {
  const accepted = acceptedAxes.value
  if (accepted.length === 0) return null
  switch (props.firmware) {
    case 'Klipper': {
      const lines = accepted.flatMap((a) => [
        ...formatKlipperShaper(a.axis, a.recommended!).split('\n'),
        `damping_ratio_${a.axis}: ${a.dampingRatio!.toFixed(3)}`,
      ])
      return { code: ['[input_shaper]', ...lines].join('\n'), note: 'Add the block to printer.cfg and restart the firmware.' }
    }
    case 'Marlin':
      return {
        code: accepted.map((a) => formatMarlinShaper(a.axis, a.frequencyHz!, a.dampingRatio!)).join('\n'),
        note:
          'Marlin implements the ZV shaper, so the command carries the measured frequency and ' +
          'damping ratio. Add M500 to save the values.',
      }
    case 'RepRapFirmware':
      return {
        code: accepted.map((a) => formatRrfShaper(a.recommended!)).join('\n'),
        note:
          accepted.length > 1
            ? 'RepRapFirmware applies one shaper to all axes, so only one of the commands can ' +
              'be active. Put the chosen line in config.g.'
            : 'Put the command in config.g to make it permanent.',
      }
  }
  return null
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
              label="Lines used"
              :value="`${axis.linesUsed} of ${axis.linesTraced}`"
              :testid="`is-lines-${axis.axis}`"
            />
          </div>
          <v-alert
            v-if="axis.refusals.length > 0"
            type="info"
            variant="tonal"
            density="compact"
            class="mb-2 soft-alert"
            :text="skippedNote(axis)"
            :data-testid="`is-notes-${axis.axis}`"
          />
          <v-table density="compact" class="shaper-table" :data-testid="`is-shapers-${axis.axis}`">
            <thead>
              <tr>
                <th>Shaper</th>
                <th>Residual vibration across the tolerance band</th>
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
          <p v-for="(reason, i) in dedupedRefusals(axis)" :key="i" class="refusal">{{ reason }}</p>
        </v-alert>
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
.shaper-table .recommended {
  background: rgba(var(--v-theme-primary), 0.1);
}
.refusal {
  margin: 0;
}
.refusal + .refusal {
  margin-top: 6px;
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
