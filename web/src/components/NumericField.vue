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
  hint?: string
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
    :hint="hint"
    :disabled="disabled"
    :persistent-hint="!!hint"
    control-variant="stacked"
    density="comfortable"
    @update:model-value="$emit('update:modelValue', $event)"
  />
</template>
