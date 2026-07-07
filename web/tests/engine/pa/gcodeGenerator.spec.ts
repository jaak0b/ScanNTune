import { describe, expect, it } from 'vitest'
import {
  generatePaGcode,
  generatePaGcodeWithReport,
  extrusionMm,
  estimatePaPrintSeconds,
} from '../../../src/engine/pa/gcodeGenerator'
import { defaultFilamentProfile, defaultPrinterProfile, defaultPaTestSpec, paValueForLine, couponGeometry } from '../../../src/engine/pa/types'

describe('extrusionMm', () => {
  it('computes E from the standard volumetric flow formula', () => {
    // 100 mm of 0.45 x 0.2 mm bead from 1.75 mm filament:
    // E = (0.45 * 0.2 * 100) / (pi * 0.875^2) = 3.7417...
    expect(extrusionMm(100, 0.45, 0.2, 1.75)).toBeCloseTo(3.7417, 3)
  })
})

describe('generatePaGcode', () => {
  const profile = defaultPrinterProfile()
  const filament = defaultFilamentProfile()
  const spec = defaultPaTestSpec()

  it('emits temps, start gcode, and relative extrusion', () => {
    const g = generatePaGcode(profile, filament, spec)
    expect(g).toContain('M104 S210')
    expect(g).toContain('M140 S60')
    expect(g).toContain('M190 S60')
    expect(g).toContain('M109 S210')
    expect(g).toContain('G28')
    expect(g).toContain('M83')
  })

  it('emits one PA command per line with the stepped value', () => {
    const g = generatePaGcode(profile, filament, spec)
    for (let i = 0; i < spec.lineCount; i++) {
      const v = paValueForLine(spec, i)
      expect(g).toContain(`SET_PRESSURE_ADVANCE ADVANCE=${v.toFixed(4)}`)
    }
  })

  it('uses M900 for Marlin and M572 for RepRap', () => {
    const marlin = generatePaGcode({ ...profile, firmware: 'Marlin' }, filament, spec)
    expect(marlin).toContain('M900 K0.0000')
    const rrf = generatePaGcode({ ...profile, firmware: 'RepRapFirmware' }, filament, spec)
    expect(rrf).toContain('M572 D0 S0.0000')
  })

  it('resets PA to 0 after the filament swap, before the prime line and before the first stepped PA command', () => {
    const g = generatePaGcode(profile, filament, spec)
    const zeroPaAt = g.indexOf('SET_PRESSURE_ADVANCE ADVANCE=0.0000')
    expect(zeroPaAt).toBeGreaterThan(0)
    const primeLineAt = g.indexOf(`E${extrusionMm(
      couponGeometry(spec).baseWidthMm - 4,
      spec.lineWidthMm,
      profile.layerHeightMm,
      filament.filamentDiameterMm,
    ).toFixed(5)}`)
    expect(primeLineAt).toBeGreaterThan(0)
    expect(zeroPaAt).toBeLessThan(primeLineAt)
    const firstSteppedPaAt = g.indexOf(
      `SET_PRESSURE_ADVANCE ADVANCE=${paValueForLine(spec, 0).toFixed(4)}`,
      zeroPaAt + 1,
    )
    expect(firstSteppedPaAt).toBeGreaterThan(zeroPaAt)
  })

  it('emits the pause gcode exactly once, between base and lines', () => {
    const g = generatePaGcode(profile, filament, spec)
    const pauseAt = g.indexOf('\nPAUSE\n')
    expect(pauseAt).toBeGreaterThan(0)
    const firstPa = g.indexOf('SET_PRESSURE_ADVANCE')
    expect(pauseAt).toBeLessThan(firstPa)
    expect(g.indexOf('\nPAUSE\n', pauseAt + 1)).toBe(-1)
  })

  it('keeps all XY moves on the bed', () => {
    const g = generatePaGcode(profile, filament, spec)
    for (const line of g.split('\n')) {
      const mx = /X(-?\d+(?:\.\d+)?)/.exec(line)
      const my = /Y(-?\d+(?:\.\d+)?)/.exec(line)
      if (mx) {
        expect(Number(mx[1])).toBeGreaterThanOrEqual(0)
        expect(Number(mx[1])).toBeLessThanOrEqual(profile.bedWidthMm)
      }
      if (my) {
        expect(Number(my[1])).toBeGreaterThanOrEqual(0)
        expect(Number(my[1])).toBeLessThanOrEqual(profile.bedDepthMm)
      }
    }
  })

  it('never extrudes across a fiducial hole on base layers', () => {
    const g = generatePaGcode(profile, filament, spec)
    const geo = couponGeometry(spec)
    const ox = (profile.bedWidthMm - geo.baseWidthMm) / 2
    const oy = (profile.bedDepthMm - geo.baseHeightMm) / 2
    const holes = geo.fiducials.map((f) => ({
      x0: ox + f.xMm - geo.fiducialSizeMm / 2,
      y0: oy + f.yMm - geo.fiducialSizeMm / 2,
      x1: ox + f.xMm + geo.fiducialSizeMm / 2,
      y1: oy + f.yMm + geo.fiducialSizeMm / 2,
    }))
    const pauseAt = g.indexOf('\nPAUSE\n')
    let x = 0
    let y = 0
    for (const line of g.slice(0, pauseAt).split('\n')) {
      const mx = /X(-?\d+\.?\d*)/.exec(line)
      const my = /Y(-?\d+\.?\d*)/.exec(line)
      const me = /E(\d+\.?\d*)/.exec(line)
      const nx = mx ? Number(mx[1]) : x
      const ny = my ? Number(my[1]) : y
      if (me && Number(me[1]) > 0 && (mx || my)) {
        // Sample the segment densely; every sample must be outside all holes.
        for (let t = 0; t <= 1.0001; t += 0.02) {
          const sx = x + (nx - x) * t
          const sy = y + (ny - y) * t
          for (const h of holes) {
            const insideX = sx > h.x0 + 0.01 && sx < h.x1 - 0.01
            const insideY = sy > h.y0 + 0.01 && sy < h.y1 - 0.01
            expect(insideX && insideY).toBe(false)
          }
        }
      }
      x = nx
      y = ny
    }
  })

  it('ends with the end gcode', () => {
    const g = generatePaGcode(profile, filament, spec)
    expect(g.trimEnd().endsWith('M84')).toBe(true)
  })

  it('substitutes slicer variables in the start gcode', () => {
    const p = {
      ...defaultPrinterProfile(),
      startGcode:
        'M117\nPRINT_START BED=[first_layer_bed_temperature] HOTEND=[first_layer_temperature] FILAMENT_TYPE=[filament_type] CHAMBER_TEMP=[chamber_temperature]',
    }
    const g = generatePaGcode(p, defaultFilamentProfile(), spec)
    expect(g).toContain('PRINT_START BED=60 HOTEND=210 FILAMENT_TYPE=PLA CHAMBER_TEMP=0')
  })
})

describe('motion limits', () => {
  const spec = defaultPaTestSpec()

  function linesOf(firmware: 'Klipper' | 'Marlin' | 'RepRapFirmware'): string[] {
    return generatePaGcode({ ...defaultPrinterProfile(), firmware }, defaultFilamentProfile(), spec).split('\n')
  }

  function assertAfterStartBeforeFirstMove(lines: string[], expected: string[]): void {
    const g90At = lines.indexOf('G90')
    expect(g90At).toBeGreaterThan(0)
    const firstMoveAt = lines.findIndex((l) => l.startsWith('G1 Z'))
    expect(firstMoveAt).toBeGreaterThan(g90At)
    for (let i = 0; i < expected.length; i++) {
      const at = lines.indexOf(expected[i])
      expect(at, expected[i]).toBeGreaterThan(g90At)
      expect(at, expected[i]).toBeLessThan(firstMoveAt)
      if (i > 0) expect(at).toBeGreaterThan(lines.indexOf(expected[i - 1]))
    }
  }

  it('emits SET_VELOCITY_LIMIT for Klipper after start G-code, before the first layer move', () => {
    assertAfterStartBeforeFirstMove(linesOf('Klipper'), [
      'SET_VELOCITY_LIMIT ACCEL=3000 SQUARE_CORNER_VELOCITY=5',
    ])
  })

  it('emits M204 and M205 for Marlin after start G-code, before the first layer move', () => {
    assertAfterStartBeforeFirstMove(linesOf('Marlin'), ['M204 P3000 T3000', 'M205 X5 Y5'])
  })

  it('emits M204 and M566 in mm/min for RepRapFirmware after start G-code, before the first layer move', () => {
    assertAfterStartBeforeFirstMove(linesOf('RepRapFirmware'), ['M204 P3000 T3000', 'M566 X300 Y300'])
  })

  it('uses the profile values, not constants', () => {
    const p = { ...defaultPrinterProfile(), printAccelMmS2: 1500, squareCornerVelocityMmS: 8 }
    const g = generatePaGcode(p, defaultFilamentProfile(), spec)
    expect(g).toContain('SET_VELOCITY_LIMIT ACCEL=1500 SQUARE_CORNER_VELOCITY=8')
  })
})

describe('generatePaGcodeWithReport', () => {
  it('throws when fast speed does not exceed slow speed', () => {
    const p = defaultPrinterProfile()
    const bad = { ...defaultPaTestSpec(), slowSpeedMmS: 50, fastSpeedMmS: 50 }
    expect(() => generatePaGcodeWithReport(p, defaultFilamentProfile(), bad)).toThrow('Fast speed must exceed slow speed')
    const worse = { ...defaultPaTestSpec(), slowSpeedMmS: 60, fastSpeedMmS: 40 }
    expect(() => generatePaGcodeWithReport(p, defaultFilamentProfile(), worse)).toThrow('Fast speed must exceed slow speed')
  })

  it('reports unknown variables across start, pause, and end gcode, deduplicated', () => {
    const p = {
      ...defaultPrinterProfile(),
      startGcode: 'START [mystery_var]',
      pauseGcode: 'PAUSE {mystery_var} {other_var}',
      endGcode: 'M104 S{temperature}\nM84',
    }
    const r = generatePaGcodeWithReport(p, defaultFilamentProfile(), defaultPaTestSpec())
    expect(r.unknownVariables).toEqual(['mystery_var', 'other_var'])
    expect(r.gcode).toContain('START [mystery_var]')
    expect(r.gcode).toContain('M104 S210')
  })

  it('reports nothing for the default profile and matches generatePaGcode', () => {
    const p = defaultPrinterProfile()
    const r = generatePaGcodeWithReport(p, defaultFilamentProfile(), defaultPaTestSpec())
    expect(r.unknownVariables).toEqual([])
    expect(r.gcode).toBe(generatePaGcode(p, defaultFilamentProfile(), defaultPaTestSpec()))
  })
})

describe('estimatePaPrintSeconds', () => {
  it('estimates a finite, positive, and plausible print time for the default profile/spec', () => {
    const profile = defaultPrinterProfile()
    const spec = defaultPaTestSpec()
    const seconds = estimatePaPrintSeconds(profile, spec)
    expect(Number.isFinite(seconds)).toBe(true)
    expect(seconds).toBeGreaterThan(0)
    expect(seconds).toBeGreaterThan(3 * 60)
    expect(seconds).toBeLessThan(90 * 60)
  })
})
