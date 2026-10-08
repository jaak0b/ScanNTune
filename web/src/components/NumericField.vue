<script setup lang="ts">
import { onMounted, ref } from 'vue'

// A labelled numeric stepper. No Maximum (never cap what the user may enter); a sensible floor and
// per-field increment are passed in. `precision` sets the decimal places (0 = integer, the default of
// the underlying control, which would otherwise round decimals away).
const props = defineProps<{
  label: string
  modelValue: number | null
  step?: number
  min?: number
  precision?: number
  placeholder?: string
  /** Shows the placeholder while the field is empty, not only while it has focus. */
  persistentPlaceholder?: boolean
  hint?: string
  /** Shows a small muted info icon next to the field; the text opens in a tooltip on hover or click/tap. */
  tooltip?: string
  disabled?: boolean
  /** Forwarded as `data-testid` onto the underlying `<input>`, for tests to target directly. */
  testid?: string
}>()
defineEmits<{ 'update:modelValue': [number | null] }>()

// Vuetify's v-number-input absorbs a plain `data-testid` fallthrough attribute onto its own root
// wrapper, not the actual <input> it renders internally, so a testid prop is applied to the real
// input element directly once it exists.
const numberInputRef = ref()
onMounted(() => {
  if (!props.testid) return
  const input = numberInputRef.value?.$el?.querySelector('input')
  input?.setAttribute('data-testid', props.testid)
})
</script>

<template>
  <v-number-input
    ref="numberInputRef"
    :label="label"
    :model-value="modelValue"
    :step="step ?? 1"
    :min="min"
    :precision="precision"
    :placeholder="placeholder"
    :persistent-placeholder="persistentPlaceholder"
    :hint="hint"
    :disabled="disabled"
    :persistent-hint="!!hint"
    control-variant="stacked"
    density="comfortable"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <template v-if="tooltip" #prepend-inner>
      <!-- VField focuses its input on any mousedown inside the field (VTextField's
           onControlMousedown), which on a phone opens the keyboard when the icon is tapped;
           the tooltip opens on click, so the mousedown stops here. -->
      <span class="tooltip-anchor" @mousedown.stop>
        <v-icon icon="mdi-information-outline" size="small" color="on-surface-variant" style="opacity: 0.6" />
        <v-tooltip activator="parent" open-on-hover open-on-click location="top" max-width="280">
          {{ tooltip }}
        </v-tooltip>
      </span>
    </template>
  </v-number-input>
</template>

<style scoped>
.tooltip-anchor {
  display: inline-flex;
  align-items: center;
  cursor: help;
}
</style>
