import { describe, expect, it } from 'vitest'
import { defaultFilamentProfile, defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'
import type { Box } from '../../../src/engine/gcode/emitter'
import {
  beadVolumetricFlowMm3S,
  extrude,
  highFlowWarning,
  newEmitter,
  quantizeE,
  rasterBase,
  roundedBeadCrossSectionMm2,
  roundedRectangleExtrusionSpacingMm,
  travel,
} from '../../../src/engine/gcode/emitter'

const profile = defaultPrinterProfile()
const filament = defaultFilamentProfile()
const nominal = 0.42

/** A 40 x 40 mm square starting at the origin, with a 10 x 10 mm hole boxed in its centre. */
const RECT = { x0: 0, y0: 0, w: 40, h: 40 }
const CENTRE_HOLE: Box = { x0: 15, y0: 15, x1: 25, y1: 25 }

/** True when the straight path passes through the box interior, judged by dense sampling
 *  (an oracle independent of the emitter's slab intersection). */
function sampledCrossing(ax: number, ay: number, bx: number, by: number, box: Box): boolean {
  const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.005))
  for (let k = 1; k < n; k++) {
    const x = ax + ((bx - ax) * k) / n
    const y = ay + ((by - ay) * k) / n
    if (x > box.x0 && x < box.x1 && y > box.y0 && y < box.y1) return true
  }
  return false
}

interface Hop {
  fromX: number
  fromY: number
  toX: number
  toY: number
  /** The nozzle was retracted while the travel ran. */
  retracted: boolean
  /** The travel's own retract-bracket: a stationary retract right before it. */
  bracketed: boolean
}

/** Every G0 travel in the emitted lines, with the retract state it ran under. */
function hopsOf(lines: string[]): Hop[] {
  const hops: Hop[] = []
  let x = 0
  let y = 0
  let retracted = false
  lines.forEach((l, i) => {
    if (/^G1 .*E-/.test(l)) retracted = true
    else if (/^G1 .*E[\d.]/.test(l)) retracted = false
    const m = l.match(/^G([01]) X(-?[\d.]+) Y(-?[\d.]+)/)
    if (!m) return
    const nx = Number(m[2])
    const ny = Number(m[3])
    if (m[1] === '0') {
      hops.push({
        fromX: x,
        fromY: y,
        toX: nx,
        toY: ny,
        retracted,
        bracketed: /^G1 E-/.test(lines[i - 1] ?? ''),
      })
    }
    x = nx
    y = ny
  })
  return hops
}

describe('rasterBase retract bracketing', () => {
  it('brackets the hop across an open hole with a retract, a travel, and an un-retract', () => {
    const e = newEmitter([CENTRE_HOLE])
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
    // The raster ends primed, the state it started in.
    expect(e.retracted).toBe(false)
  })

  it('emits no retract when no hole splits a row (serpentine connectors stay primed)', () => {
    const e = newEmitter()
    rasterBase(e, profile, filament, nominal, RECT.x0, RECT.y0, RECT.w, RECT.h, true, [])
    // Without a hole, every scanline is one contiguous bead; the row-to-row serpentine hop
    // stays close and primed, so nothing retracts inside the raster.
    expect(e.lines.some((l) => /^G1 E-/.test(l))).toBe(false)
    // The raster still printed (extrude moves exist), so the absence of retracts is real.
    expect(e.lines.some((l) => /^G1 X.* E[\d.]/.test(l))).toBe(true)
  })

  it('retracts only for hops through the open hole, not for hops that cut its clearance ring', () => {
    // The raster skips the hole grown by a 1.26 mm clearance ring (three 0.42 mm perimeter
    // loops printed afterwards), but only the hole itself is open.
    const ring: Box = { x0: 13.74, y0: 13.74, x1: 26.26, y1: 26.26 }
    const e = newEmitter([CENTRE_HOLE])
    rasterBase(e, profile, filament, nominal, RECT.x0, RECT.y0, RECT.w, RECT.h, true, [ring])
    const hops = hopsOf(e.lines)
    const throughHole = hops.filter((h) => sampledCrossing(h.fromX, h.fromY, h.toX, h.toY, CENTRE_HOLE))
    const ringOnly = hops.filter(
      (h) =>
        sampledCrossing(h.fromX, h.fromY, h.toX, h.toY, ring) &&
        !sampledCrossing(h.fromX, h.fromY, h.toX, h.toY, CENTRE_HOLE),
    )
    // Both kinds of hop occur, so each assertion below is exercised.
    expect(throughHole.length).toBeGreaterThan(0)
    expect(ringOnly.length).toBeGreaterThan(0)
    expect(throughHole.every((h) => h.bracketed)).toBe(true)
    expect(ringOnly.some((h) => h.bracketed)).toBe(false)
  })

  it('brackets the hop across a corner hole after a too-short first sub-range is skipped', () => {
    // A 5 mm hole tucked into the far corner of the 45 degree raster leaves a 0.2 mm sliver,
    // narrower than a bead, at the end of the rows that cross it. On the serpentine rows
    // printed backward that sliver is the row's first sub-range; skipping it makes the next
    // hop the first of its row, and that hop crosses the hole.
    const corner: Box = { x0: 34.8, y0: 34.8, x1: 39.8, y1: 39.8 }
    const e = newEmitter([corner])
    rasterBase(e, profile, filament, nominal, RECT.x0, RECT.y0, RECT.w, RECT.h, true, [corner])
    const across = hopsOf(e.lines).filter((h) =>
      sampledCrossing(h.fromX, h.fromY, h.toX, h.toY, corner),
    )
    expect(across.length).toBeGreaterThan(0)
    expect(across.every((h) => h.retracted)).toBe(true)
  })
})

describe('roundedRectangleExtrusionSpacingMm', () => {
  it('returns PrusaSlicer Flow::rounded_rectangle_extrusion_spacing in float', () => {
    // float(0.42) - float(float(0.2) x float(1 - pi / 4)) = 0.41999998688697815 -
    // float(0.20000000298 x 0.21460182965) = 0.41999998688697815 - 0.04292036592960358 =
    // 0.3770796060562134 as a float.
    expect(roundedRectangleExtrusionSpacingMm(0.42, 0.2)).toBe(0.3770796060562134)
  })

  it('refuses a line too narrow to fill its layer, as PrusaSlicer does', () => {
    // 0.04 - 0.0429204 is negative: rounded beads that narrow cannot fill a 0.2 mm layer.
    expect(() => roundedRectangleExtrusionSpacingMm(0.04, 0.2)).toThrow(
      'Use a wider line or a lower layer height. A 0.04 mm line is too narrow to fill a 0.2 mm layer.',
    )
  })
})

describe('rasterBase spacing', () => {
  it('places adjacent scanlines one rounded bead spacing apart, measured perpendicular to them', () => {
    const e = newEmitter()
    rasterBase(e, profile, filament, nominal, RECT.x0, RECT.y0, RECT.w, RECT.h, true, [])
    // Every extrusion of the 45 degree raster lies on one scanline; its perpendicular offset
    // is (y - x) / sqrt(2) at its end point.
    const offsets = e.lines
      .map((l) => l.match(/^G1 X(-?[\d.]+) Y(-?[\d.]+) E/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => (Number(m[2]) - Number(m[1])) / Math.SQRT2)
      .sort((a, b) => a - b)
    // Offsets within one scanline differ only by the coordinate rounding (under 0.001 mm).
    const scanlines = 1 + offsets.filter((o, i) => i > 0 && o - offsets[i - 1] > 0.1).length
    // The mean over the whole raster averages out the 3-decimal coordinate rounding: the
    // spacing is 0.3770796 mm for a 0.42 x 0.2 mm bead (PrusaSlicer's spacing), not the
    // 0.535 mm (0.9 x 0.42 / cos 45 degrees) the raster used to step.
    const meanSpacing = (offsets[offsets.length - 1] - offsets[0]) / (scanlines - 1)
    expect(meanSpacing).toBeCloseTo(0.37708, 4)
  })
})

describe('travel', () => {
  it('brackets a primed travel across an open area and hands the nozzle back primed', () => {
    const e = newEmitter([CENTRE_HOLE])
    e.x = 10
    e.y = 20
    travel(e, profile, 30, 20)
    expect(e.lines).toEqual(['G1 E-0.800 F2100', 'G0 X30.000 Y20.000 F9000', 'G1 E0.800 F2100'])
    expect(e.retracted).toBe(false)
  })

  it('leaves a travel already made retracted, or one beside the open area, plain', () => {
    const e = newEmitter([CENTRE_HOLE])
    e.x = 10
    e.y = 20
    e.retracted = true
    travel(e, profile, 30, 20)
    // Along the hole's edge, not through it: the edge is where the material ends.
    e.retracted = false
    travel(e, profile, 30, 25)
    travel(e, profile, 10, 25)
    expect(e.lines).toEqual([
      'G0 X30.000 Y20.000 F9000',
      'G0 X30.000 Y25.000 F9000',
      'G0 X10.000 Y25.000 F9000',
    ])
  })
})

// PrusaSlicer 2.9.6 golden values, hand-derived along its own chain. Flow stores width and
// height as float: float(0.42) = 0.41999998688697815, float(0.45) = 0.44999998807907104,
// float(0.2) = 0.20000000298023224. Flow::mm3_per_mm evaluates h * (w - h * (1 - pi / 4)) in
// double and returns it as float. Extruder::e_per_mm3 for 1.75 mm filament at multiplier 1 is
// 1 / (1.75 * 1.75 * 0.25 * pi) = 1 / 2.4052819 = 0.41575169 mm per mm^3.
describe('roundedBeadCrossSectionMm2', () => {
  it('returns PrusaSlicer Flow::mm3_per_mm to the float, not the double rounded bead', () => {
    // 0.42 x 0.2: the double evaluation over the float inputs is 0.0754159249091657, returned
    // as the float 0.07541592419147491. The double over the exact inputs, 0.0754159265358979,
    // is a different value: the test pins Prusa's.
    expect(roundedBeadCrossSectionMm2(0.42, 0.2)).toBe(0.07541592419147491)
    expect(roundedBeadCrossSectionMm2(0.45, 0.2)).toBe(0.08141592890024185)
  })
})

describe('extrude', () => {
  it('emits the E PrusaSlicer emits for 30 mm of a 0.42 x 0.2 mm bead', () => {
    // e_per_mm = 0.41575169 x 0.07541592 = 0.03135430; x 30 mm = 0.94062893, quantized 0.94063.
    const e = newEmitter()
    extrude(e, profile, filament, 0.42, 30, 0, 50)
    expect(e.lines).toEqual(['G1 X30.000 Y0.000 E0.94063 F3000'])
  })

  it('emits the E PrusaSlicer emits for 100 mm of a 0.45 x 0.2 mm bead', () => {
    // e_per_mm = 0.41575169 x 0.08141593 = 0.03384881; x 100 mm = 3.38488099, quantized 3.38488.
    const e = newEmitter()
    extrude(e, profile, filament, 0.45, 100, 0, 50)
    expect(e.lines).toEqual(['G1 X100.000 Y0.000 E3.38488 F3000'])
  })

  it('meters E over the printed 3-decimal coordinates, not the unrounded move', () => {
    // From the origin to x = 30.0004 prints X30.000, so the E covers exactly 30 mm: the same
    // 0.94063 as the 30 mm move above, not the 0.94064 of 30.0004 mm (0.94064147).
    const e = newEmitter()
    extrude(e, profile, filament, 0.42, 30.0004, 0, 50)
    expect(e.lines).toEqual(['G1 X30.000 Y0.000 E0.94063 F3000'])
  })
})

describe('quantizeE', () => {
  it('rounds a half away from zero, as std::round does, on both signs', () => {
    // 0.000025 x 10^5 is exactly 2.5: std::round gives 3, and -2.5 gives -3 (a JavaScript
    // Math.round would give -2).
    expect(quantizeE(0.000025).toFixed(5)).toBe('0.00003')
    expect(quantizeE(-0.000025).toFixed(5)).toBe('-0.00003')
  })
})

describe('beadVolumetricFlowMm3S and highFlowWarning', () => {
  it('commands the rounded bead cross-section times speed, scaled by the extrusion multiplier', () => {
    // Hand-derived: 0.08141593 mm^2 (0.45 x 0.2 rounded bead) x 100 mm/s = 8.141593 mm^3/s; at
    // a 1.2 multiplier 9.769911.
    expect(beadVolumetricFlowMm3S(profile, filament, 0.45, 100)).toBeCloseTo(8.141593, 6)
    const rich = { ...filament, extrusionMultiplier: 1.2 }
    expect(beadVolumetricFlowMm3S(profile, rich, 0.45, 100)).toBeCloseTo(9.769911, 6)
  })

  it('warns past the configured filament limit, multiplier included, and stays quiet below it', () => {
    const limited = { ...filament, maxVolumetricFlowMm3S: 9 }
    // 8.14 mm^3/s at a 1.0 multiplier stays under the 9 mm^3/s limit.
    expect(highFlowWarning(profile, limited, 0.45, 100, 'fast speed')).toBeNull()
    // The 1.2 multiplier lifts the same bead to 9.77 mm^3/s, past it.
    expect(highFlowWarning(profile, { ...limited, extrusionMultiplier: 1.2 }, 0.45, 100, 'fast speed')).toBe(
      'Lower the fast speed, or raise the filament\'s max volumetric flow only if the hotend can ' +
        'melt 9.8 mm^3/s. Above the filament\'s 9 mm^3/s max volumetric flow, the lines ' +
        'under-extrude.',
    )
  })

  it('judges an unset filament limit against the typical hotend', () => {
    // 0.07541592 mm^2 (0.42 x 0.2 rounded bead) x 150 mm/s = 11.31 mm^3/s stays under the
    // 12 mm^3/s typical hotend default; x 170 mm/s = 12.82 mm^3/s passes it.
    expect(highFlowWarning(profile, filament, 0.42, 150, 'line speed')).toBeNull()
    expect(highFlowWarning(profile, filament, 0.42, 170, 'line speed')).toBe(
      'Lower the line speed, or raise the filament\'s max volumetric flow only if the hotend can ' +
        'melt 12.8 mm^3/s. Above the 12 mm^3/s a typical hotend melts, the lines under-extrude.',
    )
  })
})
