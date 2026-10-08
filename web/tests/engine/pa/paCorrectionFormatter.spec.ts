import { describe, expect, it } from 'vitest'
import { paCorrection } from '../../../src/engine/pa/paCorrectionFormatter'

describe('paCorrection', () => {
  it('formats Klipper', () => {
    const c = paCorrection(0.0314)
    expect(c.code).toBe('SET_PRESSURE_ADVANCE ADVANCE=0.0314')
    expect(c.secondaryCode).toBe('pressure_advance: 0.0314')
    expect(c.secondaryCaption).toBe('printer.cfg')
  })
})
