import { describe, expect, it } from 'vitest'
import { defaultFilamentProfile, defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'
import type { Box } from '../../../src/engine/gcode/emitter'
import { rasterBase, type Emitter } from '../../../src/engine/gcode/emitter'

const profile = defaultPrinterProfile()
const filament = defaultFilamentProfile()
const nominal = 0.42

function fresh(): Emitter {
  return { lines: [], x: 0, y: 0 }
}

/** A 40 x 40 mm square starting at the origin, with a 10 x 10 mm hole boxed in its centre. */
const RECT = { x0: 0, y0: 0, w: 40, h: 40 }
const CENTRE_HOLE: Box = { x0: 15, y0: 15, x1: 25, y1: 25 }

describe('rasterBase retract bracketing', () => {
  it('brackets the hop across a fiducial hole with a retract, a travel, and an un-retract', () => {
    const e = fresh()
    rasterBase(e, profile, filament, nominal, RECT.x0, RECT.y0, RECT.w, RECT.h, true, [CENTRE_HOLE])
    // A scanline that the hole splits prints one bead, hops the open hole, then prints the far
    // bead. The hop must be a retract, a rapid travel, and an un-retract, in that order.
    const seq = e.lines
      .map((l, i) => ({ l, i }))
      .filter(
        ({ i }) =>
          /^G1 E-0\.800 F2100$/.test(e.lines[i]) &&
          /^G0 X/.test(e.lines[i + 1] ?? '') &&
          /^G1 E0\.800 F2100$/.test(e.lines[i + 2] ?? '') &&
          /^G1 X.* E[\d.]/.test(e.lines[i + 3] ?? ''),
      )
    // The centre hole splits every scanline that passes through it: several rows, so several hops.
    expect(seq.length).toBeGreaterThan(0)
    // Every raster retract is part of such a bracketed hop; none leaks out on its own.
    const retracts = e.lines.filter((l) => /^G1 E-/.test(l))
    expect(retracts).toHaveLength(seq.length)
  })

  it('emits no retract when no hole splits a row (serpentine connectors stay primed)', () => {
    const e = fresh()
    rasterBase(e, profile, filament, nominal, RECT.x0, RECT.y0, RECT.w, RECT.h, true, [])
    // Without a hole, every scanline is one contiguous bead; the row-to-row serpentine hop
    // stays close and primed, so nothing retracts inside the raster.
    expect(e.lines.some((l) => /^G1 E-/.test(l))).toBe(false)
    // The raster still printed (extrude moves exist), so the absence of retracts is real.
    expect(e.lines.some((l) => /^G1 X.* E[\d.]/.test(l))).toBe(true)
  })
})
