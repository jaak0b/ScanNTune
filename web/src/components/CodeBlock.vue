<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{ code: string; caption?: string | null }>()
const copied = ref(false)

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.code)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch (e) {
    console.warn('Copy to clipboard failed', e)
  }
}
</script>

<template>
  <div class="mb-2">
    <div v-if="caption" class="text-caption mb-1">{{ caption }}</div>
    <v-sheet color="grey-darken-4" rounded border class="pa-2 d-flex align-center ga-2">
      <pre class="code flex-grow-1">{{ code }}</pre>
      <v-btn
        icon
        size="x-small"
        variant="text"
        :title="copied ? 'Copied' : 'Copy'"
        :aria-label="copied ? 'Copied' : 'Copy'"
        @click="copy"
      >
        <v-icon size="16">{{ copied ? 'mdi-check' : 'mdi-content-copy' }}</v-icon>
      </v-btn>
    </v-sheet>
  </div>
</template>

<style scoped>
.code {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Roboto Mono', ui-monospace, monospace;
  font-size: 0.9rem;
}
</style>
