<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'

const props = defineProps<{ bitmap: ImageBitmap | null; label?: string }>()
const canvas = ref<HTMLCanvasElement | null>(null)

function draw(): void {
  const c = canvas.value
  const b = props.bitmap
  if (!c || !b) return
  try {
    c.width = b.width
    c.height = b.height
    c.getContext('2d')?.drawImage(b, 0, 0)
  } catch (e) {
    // A bitmap can be detached (closed) between a store update and this redraw; skip rather than
    // throwing an uncaught InvalidStateError.
    console.warn('Could not draw overlay bitmap', e)
  }
}

onMounted(draw)
watch(() => props.bitmap, draw)
</script>

<template>
  <figure class="ma-0">
    <canvas ref="canvas" class="overlay" />
    <figcaption v-if="label" class="text-caption text-center mt-1">{{ label }}</figcaption>
  </figure>
</template>

<style scoped>
figure {
  width: 100%;
  height: 100%;
}
.overlay {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
  border-radius: 6px;
}
</style>
