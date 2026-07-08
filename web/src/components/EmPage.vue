<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { usePrinterProfiles } from '../stores/usePrinterProfiles'
import { generateEmGcodeWithReport, HIGH_FLOW_WARNING_THRESHOLD_MM3_S } from '../engine/em/gcodeGenerator'
import {
  accelRampMm,
  defaultEmTestSpec,
  emCouponGeometry,
  volumetricFlowMm3S,
  type EmTestSpec,
} from '../engine/em/types'
import { fitsA4 } from '../engine/gcode/emitter'
import { defaultPrinterProfile } from '../engine/pa/types'
import PrinterProfileCard from './PrinterProfileCard.vue'
import NumericField from './NumericField.vue'

const store = usePrinterProfiles()

// Spec defaults follow the selected printer; the fields start prefilled with them and
// refill whenever another printer is selected (edits between switches are one-shot).
const specDefaults = computed(() => defaultEmTestSpec(store.selected ?? defaultPrinterProfile()))
const pitchMin = ref<number | null>(specDefaults.value.pitchMinMm)
const pitchMax = ref<number | null>(specDefaults.value.pitchMaxMm)
const blockCount = ref<number | null>(specDefaults.value.blockCount)
const linesPerBlock = ref<number | null>(specDefaults.value.linesPerBlock)
const printSpeed = ref<number | null>(specDefaults.value.printSpeedMmS)
watch(
  () => store.selected?.id,
  () => {
    pitchMin.value = specDefaults.value.pitchMinMm
    pitchMax.value = specDefaults.value.pitchMaxMm
    blockCount.value = specDefaults.value.blockCount
    linesPerBlock.value = specDefaults.value.linesPerBlock
    printSpeed.value = specDefaults.value.printSpeedMmS
  },
)

const spec = computed<EmTestSpec>(() => ({
  ...specDefaults.value,
  pitchMinMm: pitchMin.value ?? specDefaults.value.pitchMinMm,
  pitchMaxMm: pitchMax.value ?? specDefaults.value.pitchMaxMm,
  blockCount: blockCount.value ?? specDefaults.value.blockCount,
  linesPerBlock: linesPerBlock.value ?? specDefaults.value.linesPerBlock,
  printSpeedMmS: printSpeed.value ?? specDefaults.value.printSpeedMmS,
}))

const geometry = computed(() => emCouponGeometry(spec.value))
const footprintText = computed(
  () => `coupon ${Math.round(geometry.value.couponWidthMm)} x ${Math.round(geometry.value.couponHeightMm)} mm`,
)
const exceedsA4 = computed(() => !fitsA4(geometry.value.couponWidthMm, geometry.value.couponHeightMm))
const layerHeight = computed(() => (store.selected ?? defaultPrinterProfile()).layerHeightMm)
const flowText = computed(() => `${volumetricFlowMm3S(spec.value, layerHeight.value).toFixed(1)} mm^3/s`)
const highFlow = computed(
  () => volumetricFlowMm3S(spec.value, layerHeight.value) > HIGH_FLOW_WARNING_THRESHOLD_MM3_S,
)
const rampWarning = computed(() => {
  const p = store.selected
  if (!p) return false
  return 2 * accelRampMm(spec.value.printSpeedMmS, p.printAccelMmS2) > spec.value.lineLengthMm / 2
})

const generateError = ref('')
const unknownVariables = ref<string[]>([])
const templateWarnings = ref<string[]>([])
const canGenerate = computed(() => store.selected !== null && store.selectedFilament !== null)

function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'printer'
}
const filename = computed(() =>
  store.selected ? `em_flow_test_${sanitizeName(store.selected.name)}.gcode` : '',
)

function generate(): void {
  const profile = store.selected
  const filament = store.selectedFilament
  if (!profile || !filament) return
  generateError.value = ''
  unknownVariables.value = []
  templateWarnings.value = []
  let gcode: string
  try {
    const report = generateEmGcodeWithReport(profile, filament, spec.value)
    gcode = report.gcode
    unknownVariables.value = report.unknownVariables
    templateWarnings.value = report.warnings
  } catch (e) {
    generateError.value = e instanceof Error ? e.message : String(e)
    console.error('EM G-code generation failed', e)
    return
  }
  const blob = new Blob([gcode], { type: 'text/x-gcode' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.value
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <v-container class="page">
    <header class="mb-4">
      <h1 class="text-h5 font-weight-bold">Flow calibration</h1>
      <p class="text-body-2 text-medium-emphasis mt-1">
        Print a single-color test coupon of comb lines at a swept line pitch and the app gives you
        the extrusion multiplier / flow correction to set.
      </p>
    </header>

    <!-- 1. Printer profile -->
    <PrinterProfileCard />

    <!-- 2. Test settings -->
    <section class="step mb-3">
      <div class="step-head mb-2">
        <span class="num">2</span><span class="step-title">Test settings</span>
      </div>
      <div class="field-group">
        <span class="group-label">Pitch sweep</span>
        <div class="fields">
          <NumericField v-model="pitchMin" label="Pitch min (mm)" :step="0.01" :min="0.01" :precision="4" />
          <NumericField v-model="pitchMax" label="Pitch max (mm)" :step="0.01" :min="0.01" :precision="4" />
          <NumericField v-model="blockCount" label="Blocks" :step="1" :min="3" />
          <NumericField v-model="linesPerBlock" label="Lines per block" :step="1" :min="2" />
        </div>
      </div>
      <div class="field-group mt-1">
        <span class="group-label">Print speed</span>
        <div class="fields">
          <NumericField v-model="printSpeed" label="Print speed (mm/s)" :step="1" :min="1" />
        </div>
      </div>
      <div class="facts mt-2">
        <v-chip size="small" variant="tonal" prepend-icon="mdi-ruler-square">{{ footprintText }}</v-chip>
        <v-chip size="small" variant="tonal" prepend-icon="mdi-water">{{ flowText }}</v-chip>
        <span v-if="!canGenerate" class="tip mt-0">Choose a printer profile first.</span>
      </div>
      <v-alert
        v-if="exceedsA4"
        type="warning"
        variant="tonal"
        density="compact"
        class="mt-3 soft-alert"
        data-testid="em-a4-warning"
        text="The coupon is larger than A4. Most flatbed scanners cannot scan it in one pass. Reduce the block count or lines per block unless your scanner is larger."
      />
      <v-alert
        v-if="highFlow"
        type="warning"
        variant="tonal"
        density="compact"
        class="mt-3 soft-alert"
        data-testid="em-flow-warning"
        text="This volumetric flow is intended for high-flow hotends. A standard hotend may under-extrude and mask the real result."
      />
      <v-alert
        v-if="rampWarning"
        type="warning"
        variant="tonal"
        density="compact"
        class="mt-3 soft-alert"
        data-testid="em-ramp-warning"
        text="At this speed and acceleration the line middles never reach the commanded speed; lower the speed, raise the acceleration, or lengthen the lines."
      />
    </section>

    <!-- 3. Generate -->
    <section class="step mb-3">
      <div class="step-head mb-2">
        <span class="num">3</span><span class="step-title">Generate</span>
      </div>
      <div class="gen-row">
        <v-btn
          color="primary"
          prepend-icon="mdi-download"
          :disabled="!canGenerate"
          data-testid="em-generate"
          @click="generate"
        >
          Generate G-code
        </v-btn>
        <span v-if="filename" class="tip mt-0">{{ filename }}</span>
      </div>
      <v-alert
        v-if="generateError"
        type="error"
        variant="tonal"
        class="mt-3"
        :text="generateError"
        data-testid="em-generate-error"
      />
      <v-alert
        v-if="unknownVariables.length > 0"
        type="warning"
        variant="tonal"
        class="mt-3"
        :text="`Unknown slicer variables left as-is: ${unknownVariables.join(', ')}. Replace them with real values if your firmware does not resolve them.`"
        data-testid="em-unknown-variables-warning"
      />
      <v-alert
        v-if="templateWarnings.length > 0"
        type="warning"
        variant="tonal"
        class="mt-3"
        :text="templateWarnings.join(' ')"
        data-testid="em-template-warnings"
      />
    </section>

    <p class="tip">
      <v-icon size="14" class="mr-1">mdi-information-outline</v-icon>
      Print with a single filament color (no filament change), then scan the finished part top face
      down on a flatbed scanner. The result is only valid near the printed speed. Filament diameter
      variation limits repeatability to about 1%.
    </p>
  </v-container>
</template>

<style scoped>
.page {
  max-width: 760px;
}
.step {
  background: rgb(var(--v-theme-surface-light));
  border-radius: 12px;
  padding: 16px;
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
.tip {
  font-size: 12.5px;
  color: rgba(var(--v-theme-on-surface), 0.6);
  margin-top: 8px;
}
.fields {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.fields > * {
  flex: 1 1 160px;
}
.field-group .group-label {
  display: block;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.55;
  margin-bottom: 4px;
}
.facts {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.soft-alert {
  font-size: 0.875rem;
}
.gen-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
</style>
