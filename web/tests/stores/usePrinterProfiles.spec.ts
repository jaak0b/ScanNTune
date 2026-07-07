import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePrinterProfiles } from '../../src/stores/usePrinterProfiles'
import { defaultFilamentProfile, defaultPrinterProfile } from '../../src/engine/pa/types'

describe('usePrinterProfiles', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('starts empty and upserts with a generated id', () => {
    const store = usePrinterProfiles()
    expect(store.profiles).toHaveLength(0)
    const id = store.upsert({ ...defaultPrinterProfile(), name: 'Voron' })
    expect(store.profiles).toHaveLength(1)
    expect(store.profiles[0].id).not.toBe('')
    expect(id).toBe(store.profiles[0].id)
  })

  it('persists and reloads across store instances', () => {
    const a = usePrinterProfiles()
    a.upsert({ ...defaultPrinterProfile(), name: 'Ender' })
    a.select(a.profiles[0].id)
    setActivePinia(createPinia())
    const b = usePrinterProfiles()
    expect(b.profiles).toHaveLength(1)
    expect(b.profiles[0].name).toBe('Ender')
    expect(b.selected?.name).toBe('Ender')
  })

  it('updates an existing profile by id and removes', () => {
    const store = usePrinterProfiles()
    store.upsert({ ...defaultPrinterProfile(), name: 'A' })
    const id = store.profiles[0].id
    const updatedId = store.upsert({ ...store.profiles[0], name: 'B' })
    expect(store.profiles).toHaveLength(1)
    expect(store.profiles[0].name).toBe('B')
    expect(updatedId).toBe(id)
    expect(updatedId).toBe(store.profiles[0].id)
    store.remove(id)
    expect(store.profiles).toHaveLength(0)
    expect(store.selectedId).toBeNull()
  })

  it('fills empty filament ids on upsert and selects the first filament', () => {
    const store = usePrinterProfiles()
    const id = store.upsert({ ...defaultPrinterProfile(), name: 'Voron' })
    store.select(id)
    const saved = store.profiles[0]
    expect(saved.filaments).toHaveLength(1)
    expect(saved.filaments[0].id).not.toBe('')
    expect(saved.selectedFilamentId).toBe(saved.filaments[0].id)
    expect(store.selectedFilament?.id).toBe(saved.filaments[0].id)
  })

  it('selectFilament switches the selected filament and persists it', () => {
    const store = usePrinterProfiles()
    const profile = {
      ...defaultPrinterProfile(),
      name: 'Multi',
      filaments: [
        { ...defaultFilamentProfile(), name: 'PLA' },
        { ...defaultFilamentProfile(), name: 'PETG', filamentType: 'PETG' },
      ],
    }
    const id = store.upsert(profile)
    store.select(id)
    const petg = store.profiles[0].filaments[1]
    store.selectFilament(id, petg.id)
    expect(store.selectedFilament?.name).toBe('PETG')
    setActivePinia(createPinia())
    const reloaded = usePrinterProfiles()
    expect(reloaded.profiles[0].selectedFilamentId).toBe(petg.id)
  })

  it('ignores selectFilament for a filament id the printer does not have', () => {
    const store = usePrinterProfiles()
    const id = store.upsert({ ...defaultPrinterProfile(), name: 'Voron' })
    store.select(id)
    const before = store.profiles[0].selectedFilamentId
    store.selectFilament(id, 'not-a-filament')
    expect(store.profiles[0].selectedFilamentId).toBe(before)
  })

  it('drops a stored profile without a valid filaments array', () => {
    const invalid = { ...defaultPrinterProfile(), id: 'p1', filaments: [] }
    localStorage.setItem(
      'scanntune.printerProfiles',
      JSON.stringify({ profiles: [invalid], selectedId: 'p1' }),
    )
    const store = usePrinterProfiles()
    expect(store.profiles).toHaveLength(0)
  })

  it('repoints a dangling selectedFilamentId at the first filament on load', () => {
    const stored = {
      ...defaultPrinterProfile(),
      id: 'p1',
      filaments: [{ ...defaultFilamentProfile(), id: 'f1' }],
      selectedFilamentId: 'gone',
    }
    localStorage.setItem(
      'scanntune.printerProfiles',
      JSON.stringify({ profiles: [stored], selectedId: 'p1' }),
    )
    const store = usePrinterProfiles()
    expect(store.profiles[0].selectedFilamentId).toBe('f1')
  })

  it('drops corrupt storage without throwing', () => {
    localStorage.setItem('scanntune.printerProfiles', '{nope')
    const store = usePrinterProfiles()
    expect(store.profiles).toHaveLength(0)
  })
})
