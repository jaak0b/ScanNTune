import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useApp } from '../../src/stores/useApp'

describe('useApp', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('starts on the skew screen', () => {
    const app = useApp()
    expect(app.screen).toBe('skew')
  })

  it('switches between screens', () => {
    const app = useApp()
    app.goCalibration()
    expect(app.screen).toBe('calibration')
    app.goPa()
    expect(app.screen).toBe('pa')
    app.goSkew()
    expect(app.screen).toBe('skew')
  })

  it('opens the profile editor with the profile id to edit', () => {
    const app = useApp()
    app.goProfile({ profileId: 'abc' })
    expect(app.screen).toBe('profile')
    expect(app.profilePayload).toEqual({ profileId: 'abc' })
  })

  it('opens the profile editor for a new profile with a null id', () => {
    const app = useApp()
    app.goProfile({ profileId: null })
    expect(app.screen).toBe('profile')
    expect(app.profilePayload).toEqual({ profileId: null })
  })

  it('returns from the profile editor to the PA page', () => {
    const app = useApp()
    app.goProfile({ profileId: 'abc' })
    app.goPa()
    expect(app.screen).toBe('pa')
  })
})
