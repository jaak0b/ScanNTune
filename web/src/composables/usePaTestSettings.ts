import { computed, ref } from 'vue'
import { usePrinterProfiles } from '../stores/usePrinterProfiles'
import { usePaSettings } from '../stores/usePaSettings'
import { usePaSmoothTimeSettings } from '../stores/usePaSmoothTimeSettings'
import { useFlowSettingsForm } from './useFlowSettingsForm'
import { defaultPaTestSpec, defaultSmoothTimeTestSpec } from '../engine/pa/types'
import type { PaTestSpec } from '../engine/pa/types'

/**
 * The pressure advance page's persisted test settings, per printer profile: the test range of
 * step 2 and the smooth time sweep of step 5, each its own stored entry so that resetting the
 * test range never touches step 5, with the specs both coupons are generated and analyzed with.
 */
export function usePaTestSettings() {
  const profiles = usePrinterProfiles()
  const specDefaults = defaultPaTestSpec()
  const range = useFlowSettingsForm(
    usePaSettings(),
    () => ({
      paStart: specDefaults.paStart,
      paEnd: specDefaults.paEnd,
      lineCount: specDefaults.lineCount,
      slowSpeedMmS: specDefaults.slowSpeedMmS,
      fastSpeedMmS: specDefaults.fastSpeedMmS,
    }),
    () => profiles.selectedId,
  )

  // The step 5 pressure advance defaults to the value measured in this session, so the prefill
  // after an analysis is the default rather than a stored change, and a profile with nothing
  // stored offers the measured value instead of an empty field.
  const measuredPressureAdvance = ref<number | null>(null)
  const stDefaults = defaultSmoothTimeTestSpec(0)
  const smoothTime = useFlowSettingsForm(
    usePaSmoothTimeSettings(),
    () => ({
      smoothTimeStart: stDefaults.paStart,
      smoothTimeEnd: stDefaults.paEnd,
      pressureAdvance: measuredPressureAdvance.value,
    }),
    () => profiles.selectedId,
  )

  const spec = computed<PaTestSpec>(() => ({
    ...defaultPaTestSpec(),
    paStart: range.form.paStart.value ?? specDefaults.paStart,
    paEnd: range.form.paEnd.value ?? specDefaults.paEnd,
    lineCount: range.form.lineCount.value ?? specDefaults.lineCount,
    slowSpeedMmS: range.form.slowSpeedMmS.value ?? specDefaults.slowSpeedMmS,
    fastSpeedMmS: range.form.fastSpeedMmS.value ?? specDefaults.fastSpeedMmS,
  }))

  // Null while the pressure advance is empty: the smooth time coupon is never generated or
  // analyzed with a pressure advance the user did not set.
  const smoothTimeSpec = computed<PaTestSpec | null>(() => {
    const advance = smoothTime.form.pressureAdvance.value
    if (advance === null) return null
    return {
      ...defaultSmoothTimeTestSpec(advance),
      paStart: smoothTime.form.smoothTimeStart.value ?? stDefaults.paStart,
      paEnd: smoothTime.form.smoothTimeEnd.value ?? stDefaults.paEnd,
    }
  })

  /**
   * Prefills the smooth time step's pressure advance with a freshly measured value, rounded to
   * the field's 4 decimals; the value also becomes that field's default for the session.
   */
  function prefillPressureAdvance(value: number): void {
    const rounded = Number(value.toFixed(4))
    measuredPressureAdvance.value = rounded
    smoothTime.form.pressureAdvance.value = rounded
  }

  return {
    range: range.form,
    rangeStored: range.hasStored,
    resetRange: range.reset,
    smoothTime: {
      start: smoothTime.form.smoothTimeStart,
      end: smoothTime.form.smoothTimeEnd,
      pressureAdvance: smoothTime.form.pressureAdvance,
    },
    spec,
    smoothTimeSpec,
    prefillPressureAdvance,
  }
}
