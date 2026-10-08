import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { effectScope, nextTick, type EffectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePaTestSettings } from '../../src/composables/usePaTestSettings'
import { usePrinterProfiles } from '../../src/stores/usePrinterProfiles'
import { defaultPrinterProfile } from '../../src/engine/pa/types'

let scope: EffectScope

function settingsForm(): ReturnType<typeof usePaTestSettings> {
  scope = effectScope()
  return scope.run(() => usePaTestSettings())!
}

/** Adds a printer profile and selects it, as picking one on the page does. */
function addProfile(name: string): void {
  const profiles = usePrinterProfiles()
  profiles.select(profiles.upsert({ ...defaultPrinterProfile(), name }))
}

describe('usePaTestSettings', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  afterEach(() => {
    scope.stop()
  })

  it('generates the smooth time sweep at the measured pressure advance, rounded to 4 decimals', () => {
    addProfile('Printer')
    const settings = settingsForm()

    settings.prefillPressureAdvance(0.04237)

    expect(settings.smoothTimeSpec.value).toMatchObject({
      sweep: 'smoothTime',
      fixedAdvance: 0.0424,
      paStart: 0.01,
      paEnd: 0.06,
    })
  })

  it('leaves the test range with nothing to reset after prefilling the measured pressure advance', async () => {
    addProfile('Printer')
    const settings = settingsForm()

    settings.prefillPressureAdvance(0.0424)
    await nextTick()

    expect(settings.rangeStored.value).toBe(false)
  })

  it('keeps the smooth time pressure advance when the test range is reset', async () => {
    addProfile('Printer')
    const settings = settingsForm()
    settings.range.paEnd.value = 0.1
    settings.prefillPressureAdvance(0.0424)
    await nextTick()

    settings.resetRange()
    await nextTick()

    expect(settings.range.paEnd.value).toBe(0.06)
    expect(settings.smoothTime.pressureAdvance.value).toBe(0.0424)
  })

  it('offers the measured pressure advance on a profile with no stored smooth time settings', async () => {
    addProfile('First')
    const settings = settingsForm()
    settings.prefillPressureAdvance(0.0424)
    await nextTick()

    addProfile('Second')
    await nextTick()

    expect(settings.smoothTime.pressureAdvance.value).toBe(0.0424)
  })

  it('builds no smooth time spec from an empty pressure advance instead of using 0', async () => {
    addProfile('Printer')
    const settings = settingsForm()
    settings.prefillPressureAdvance(0.0424)

    settings.smoothTime.pressureAdvance.value = null
    await nextTick()

    expect(settings.smoothTimeSpec.value).toBeNull()
  })
})
