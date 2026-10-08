import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createFlowSettingsStore, type FieldKinds } from '../../src/stores/createFlowSettingsStore'
import { usePrinterProfiles } from '../../src/stores/usePrinterProfiles'
import { defaultPrinterProfile } from '../../src/engine/pa/types'

type TestSettings = { a: number | null; mode: 'x' | 'y' }

const FIELDS: FieldKinds<TestSettings> = {
  a: { kind: 'nullableNumber' },
  mode: { kind: 'enum', values: ['x', 'y'] },
}

const FLAT_KEY = 'test.settings.flat'
const KEYED_KEY = 'test.settings.keyed'

const useFlat = createFlowSettingsStore<TestSettings>({
  storeId: 'testFlatSettings',
  storageKey: FLAT_KEY,
  shape: 'flat',
  fields: FIELDS,
})
const useKeyed = createFlowSettingsStore<TestSettings>({
  storeId: 'testKeyedSettings',
  storageKey: KEYED_KEY,
  shape: 'perProfile',
  fields: FIELDS,
})

function addProfile(name: string): string {
  const profiles = usePrinterProfiles()
  const id = profiles.upsert({ ...defaultPrinterProfile(), name })
  profiles.select(id)
  return id
}

describe('createFlowSettingsStore (flat shape)', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('starts without a stored entry', () => {
    const store = useFlat()
    expect(store.settings).toBeNull()
    expect(store.hasStored).toBe(false)
  })

  it('round-trips a saved entry across store instances', () => {
    const a = useFlat()
    a.save({ a: 42, mode: 'y' })
    expect(a.hasStored).toBe(true)
    setActivePinia(createPinia())
    const b = useFlat()
    expect(b.settings).toEqual({ a: 42, mode: 'y' })
  })

  it('stores the entry as a flat object under its own key', () => {
    useFlat().save({ a: 1, mode: 'x' })
    expect(JSON.parse(localStorage.getItem(FLAT_KEY)!)).toEqual({ a: 1, mode: 'x' })
  })

  it('accepts null for a nullable numeric field', () => {
    useFlat().save({ a: null, mode: 'x' })
    setActivePinia(createPinia())
    expect(useFlat().settings).toEqual({ a: null, mode: 'x' })
  })

  it('reset removes the entry, flips hasStored, and clears the storage key', () => {
    const store = useFlat()
    store.save({ a: 3, mode: 'x' })
    store.reset()
    expect(store.settings).toBeNull()
    expect(store.hasStored).toBe(false)
    expect(localStorage.getItem(FLAT_KEY)).toBeNull()
  })

  it('drops an entry with a non-finite or wrongly typed numeric field', () => {
    localStorage.setItem(FLAT_KEY, JSON.stringify({ a: 'twelve', mode: 'x' }))
    expect(useFlat().settings).toBeNull()
  })

  it('drops an entry with a value outside the enumerated set, never partially applied', () => {
    localStorage.setItem(FLAT_KEY, JSON.stringify({ a: 1, mode: 'sideways' }))
    const store = useFlat()
    expect(store.settings).toBeNull()
    expect(store.hasStored).toBe(false)
  })

  it('drops an entry with a missing field', () => {
    localStorage.setItem(FLAT_KEY, JSON.stringify({ a: 1 }))
    expect(useFlat().settings).toBeNull()
  })

  it('ignores undeclared fields on load', () => {
    localStorage.setItem(FLAT_KEY, JSON.stringify({ a: 1, mode: 'x', junk: 'yes' }))
    expect(useFlat().settings).toEqual({ a: 1, mode: 'x' })
  })

  it('drops corrupt storage without throwing', () => {
    localStorage.setItem(FLAT_KEY, '{nope')
    expect(useFlat().settings).toBeNull()
  })
})

describe('createFlowSettingsStore (per-profile shape)', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('has no settings and ignores save while no profile is selected', () => {
    const store = useKeyed()
    expect(store.settings).toBeNull()
    store.save({ a: 1, mode: 'x' })
    expect(store.hasStored).toBe(false)
    expect(localStorage.getItem(KEYED_KEY)).toBeNull()
  })

  it('stores one entry per profile and follows the selection', () => {
    const profiles = usePrinterProfiles()
    const p1 = addProfile('One')
    const store = useKeyed()
    store.save({ a: 1, mode: 'x' })
    const p2 = addProfile('Two')
    expect(store.settings).toBeNull()
    store.save({ a: 2, mode: 'y' })
    profiles.select(p1)
    expect(store.settings).toEqual({ a: 1, mode: 'x' })
    profiles.select(p2)
    expect(store.settings).toEqual({ a: 2, mode: 'y' })
    expect(JSON.parse(localStorage.getItem(KEYED_KEY)!)).toEqual({
      [p1]: { a: 1, mode: 'x' },
      [p2]: { a: 2, mode: 'y' },
    })
  })

  it('round-trips a per-profile entry across store instances', () => {
    const p1 = addProfile('One')
    useKeyed().save({ a: 7, mode: 'y' })
    setActivePinia(createPinia())
    usePrinterProfiles().select(p1)
    expect(useKeyed().settings).toEqual({ a: 7, mode: 'y' })
  })

  it('prunes entries whose profile id no longer exists', () => {
    const p1 = addProfile('One')
    localStorage.setItem(
      KEYED_KEY,
      JSON.stringify({ [p1]: { a: 1, mode: 'x' }, gone: { a: 2, mode: 'y' } }),
    )
    const store = useKeyed()
    expect(store.settings).toEqual({ a: 1, mode: 'x' })
    // The orphan is gone from the loaded state: the next persist writes it out.
    store.save({ a: 5, mode: 'x' })
    expect(JSON.parse(localStorage.getItem(KEYED_KEY)!)).toEqual({ [p1]: { a: 5, mode: 'x' } })
  })

  it('drops a corrupt entry for one profile while keeping the valid ones', () => {
    const profiles = usePrinterProfiles()
    const p1 = addProfile('One')
    const p2 = addProfile('Two')
    localStorage.setItem(
      KEYED_KEY,
      JSON.stringify({ [p1]: { a: 1, mode: 'x' }, [p2]: { a: 'bad', mode: 'x' } }),
    )
    const store = useKeyed()
    expect(store.settings).toBeNull()
    profiles.select(p1)
    expect(store.settings).toEqual({ a: 1, mode: 'x' })
  })

  it('reset removes only the selected profile entry and flips hasStored', () => {
    const profiles = usePrinterProfiles()
    const p1 = addProfile('One')
    const store = useKeyed()
    store.save({ a: 1, mode: 'x' })
    const p2 = addProfile('Two')
    store.save({ a: 2, mode: 'y' })
    store.reset()
    expect(store.hasStored).toBe(false)
    profiles.select(p1)
    expect(store.settings).toEqual({ a: 1, mode: 'x' })
    expect(JSON.parse(localStorage.getItem(KEYED_KEY)!)).toEqual({ [p1]: { a: 1, mode: 'x' } })
    expect(p2).not.toBe(p1)
  })

  it('removes the storage key once the last entry is reset', () => {
    addProfile('One')
    const store = useKeyed()
    store.save({ a: 1, mode: 'x' })
    store.reset()
    expect(localStorage.getItem(KEYED_KEY)).toBeNull()
  })
})
