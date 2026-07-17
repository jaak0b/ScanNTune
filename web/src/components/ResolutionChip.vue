<script setup lang="ts">
import { computed } from 'vue'
import { hasMeasuredResolution, resolutionRowValue } from '../util/scanResolution'

// The raw diagnostic chip for the resolution geometrically measured from the coupon itself,
// shared by the result cards of the scan flows. Renders nothing without a usable figure.
const props = defineProps<{ measuredPxPerMm: number | null | undefined; testid: string }>()

const text = computed(() =>
  hasMeasuredResolution(props.measuredPxPerMm) ? resolutionRowValue(props.measuredPxPerMm) : null,
)
</script>

<template>
  <v-chip
    v-if="text"
    size="small"
    variant="tonal"
    prepend-icon="mdi-magnify-scan"
    :data-testid="testid"
  >
    resolution {{ text }}
  </v-chip>
</template>
