import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSkewSettings, type SkewSettings } from '../../src/stores/useSkewSettings'
import { usePaSettings, type PaSettings } from '../../src/stores/usePaSettings'
import { useEmSettings, type EmSettings } from '../../src/stores/useEmSettings'
import { useIsSettings, type IsSettings } from '../../src/stores/useIsSettings'
import { usePrinterProfiles } from '../../src/stores/usePrinterProfiles'
import { defaultPrinterProfile } from '../../src/engine/pa/types'

const SKEW: SkewSettings = { dpi: 300, baselineMm: 100, gridN: 5 }
const PA: PaSettings = {
  paStart: 0.02,
  paEnd: 0.08,
  lineCount: 16,
  slowSpeedMmS: 25,
  fastSpeedMmS: 120,
  smoothTimeStart: 0.02,
  smoothTimeEnd: 0.05,
  smoothTimeFixedAdvance: 0.045,
}
const EM: EmSettings = {
  pitchMinMm: 0.7,
  pitchMaxMm: 1.1,
  blockCount: 13,
  linesPerBlock: 7,
  printSpeedMmS: 40,
  scanPlace: 'plate',
  partColors: 'base',
}
const IS: IsSettings = {
  lineSpeedMmS: 150,
  cornerSpeedMmS: 20,
  linesPerSpeed: 5,
  measuredLineMm: 30,
  linePitchMm: 2.5,
  scanPlace: 'part',
  partColors: 'single',
}

function addProfile(): string {
  const profiles = usePrinterProfiles()
  const id = profiles.upsert({ ...defaultPrinterProfile(), name: 'Printer' })
  profiles.select(id)
  return id
}

describe('per-flow settings stores', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('skew settings are one flat object under scanntune.settings.skew', () => {
    useSkewSettings().save(SKEW)
    expect(JSON.parse(localStorage.getItem('scanntune.settings.skew')!)).toEqual(SKEW)
  })

  it('pressure advance settings are keyed by profile id under scanntune.settings.pa', () => {
    const id = addProfile()
    usePaSettings().save(PA)
    expect(JSON.parse(localStorage.getItem('scanntune.settings.pa')!)).toEqual({ [id]: PA })
  })

  it('round-trips the smooth time sweep and its fixed pressure advance for the selected profile', () => {
    // The smooth time coupon is analyzed against these after a reload, so they must come back
    // exactly as generated, not as the defaults.
    const id = addProfile()
    usePaSettings().save(PA)
    setActivePinia(createPinia())
    usePrinterProfiles().select(id)
    const reloaded = usePaSettings().settings
    expect(reloaded?.smoothTimeStart).toBe(0.02)
    expect(reloaded?.smoothTimeEnd).toBe(0.05)
    expect(reloaded?.smoothTimeFixedAdvance).toBe(0.045)
  })

  it('loads a pressure advance entry stored before the smooth time fields existed', () => {
    const id = addProfile()
    const older = {
      paStart: 0.02,
      paEnd: 0.08,
      lineCount: 16,
      slowSpeedMmS: 25,
      fastSpeedMmS: 120,
    }
    localStorage.setItem('scanntune.settings.pa', JSON.stringify({ [id]: older }))
    setActivePinia(createPinia())
    usePrinterProfiles().select(id)
    expect(usePaSettings().settings).toEqual({
      ...older,
      smoothTimeStart: null,
      smoothTimeEnd: null,
      smoothTimeFixedAdvance: null,
    })
  })

  it('reset removes the stored smooth time sweep with the rest of the pressure advance entry', () => {
    addProfile()
    const settings = usePaSettings()
    settings.save(PA)
    settings.reset()
    expect(settings.hasStored).toBe(false)
    expect(settings.settings).toBeNull()
    expect(localStorage.getItem('scanntune.settings.pa')).toBeNull()
  })

  it('flow settings are keyed by profile id under scanntune.settings.em', () => {
    const id = addProfile()
    useEmSettings().save(EM)
    expect(JSON.parse(localStorage.getItem('scanntune.settings.em')!)).toEqual({ [id]: EM })
  })

  it('input shaper settings are keyed by profile id under scanntune.settings.is', () => {
    const id = addProfile()
    useIsSettings().save(IS)
    expect(JSON.parse(localStorage.getItem('scanntune.settings.is')!)).toEqual({ [id]: IS })
  })

  it('rejects a stored scan placement outside the allowed set', () => {
    const id = addProfile()
    localStorage.setItem(
      'scanntune.settings.em',
      JSON.stringify({ [id]: { ...EM, scanPlace: 'sideways' } }),
    )
    expect(useEmSettings().settings).toBeNull()
  })

  it('reloads a valid stored entry for the selected profile', () => {
    const id = addProfile()
    useIsSettings().save(IS)
    setActivePinia(createPinia())
    usePrinterProfiles().select(id)
    expect(useIsSettings().settings).toEqual(IS)
  })

  it('has no stored input shaper settings for a fresh profile, so the page falls back to empty speeds', () => {
    addProfile()
    expect(useIsSettings().settings).toBeNull()
  })

  it('round-trips entered input shaper speeds through localStorage for the selected profile', () => {
    const id = addProfile()
    useIsSettings().save(IS)
    setActivePinia(createPinia())
    usePrinterProfiles().select(id)
    const reloaded = useIsSettings().settings
    expect(reloaded?.lineSpeedMmS).toBe(150)
    expect(reloaded?.cornerSpeedMmS).toBe(20)
  })

  it('backfills an older stored entry that already carries numeric speeds', () => {
    const id = addProfile()
    localStorage.setItem('scanntune.settings.is', JSON.stringify({ [id]: IS }))
    setActivePinia(createPinia())
    usePrinterProfiles().select(id)
    expect(useIsSettings().settings).toEqual(IS)
  })

  it('loads an input shaper entry stored with the retired resonant run-up fields, dropping them', () => {
    // Earlier versions persisted four run-up sweep fields with every entry. They are no
    // longer settings: the entry must still load, with only the current fields.
    const id = addProfile()
    const legacy = {
      lineSpeedMmS: 150,
      cornerSpeedMmS: 20,
      linesPerSpeed: 5,
      measuredLineMm: 30,
      linePitchMm: 2.5,
      sweep: true,
      sweepFromHz: 35,
      sweepToHz: 150,
      sweepCycles: 16,
      scanPlace: 'part',
      partColors: 'single',
    }
    localStorage.setItem('scanntune.settings.is', JSON.stringify({ [id]: legacy }))
    setActivePinia(createPinia())
    usePrinterProfiles().select(id)
    expect(useIsSettings().settings).toEqual({
      lineSpeedMmS: 150,
      cornerSpeedMmS: 20,
      linesPerSpeed: 5,
      measuredLineMm: 30,
      linePitchMm: 2.5,
      scanPlace: 'part',
      partColors: 'single',
    })
  })

  it('reset removes the stored entry, so the speeds are gone rather than reverting to a number', () => {
    addProfile()
    const settings = useIsSettings()
    settings.save(IS)
    expect(settings.hasStored).toBe(true)
    settings.reset()
    expect(settings.hasStored).toBe(false)
    expect(settings.settings).toBeNull()
  })

  it('persists a saved entry whose speeds are still empty (null)', () => {
    const id = addProfile()
    const emptySpeeds: IsSettings = { ...IS, lineSpeedMmS: null, cornerSpeedMmS: null }
    useIsSettings().save(emptySpeeds)
    setActivePinia(createPinia())
    usePrinterProfiles().select(id)
    expect(useIsSettings().settings).toEqual(emptySpeeds)
  })
})
