<script setup lang="ts">
defineProps<{ label: string; value: string; testid?: string }>()
</script>

<template>
  <div class="tile">
    <div class="tlab">{{ label }}</div>
    <div class="tval" :data-testid="testid">{{ value }}</div>
  </div>
</template>

<style scoped>
.tile {
  background: rgb(var(--v-theme-surface-bright));
  border-radius: 10px;
  padding: 10px 8px;
  text-align: center;
}
.tlab {
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.6);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.tval {
  font-size: clamp(15px, 4.2vw, 20px);
  white-space: nowrap;
  font-weight: 500;
  font-family: 'Roboto Mono', ui-monospace, monospace;
  margin-top: 2px;
}
</style>
