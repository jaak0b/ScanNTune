import { describe, expect, it } from 'vitest'
import {
  generatePaGcode,
  generatePaGcodeWithReport,
  extrusionMm,
} from '../../../src/engine/pa/gcodeGenerator'
import {
  defaultFilamentProfile,
  defaultPrinterProfile,
  defaultPaTestSpec,
  defaultSmoothTimeTestSpec,
  paValueForLine,
  couponGeometry,
} from '../../../src/engine/pa/types'

describe('extrusionMm', () => {
  it('computes E along the PrusaSlicer flow chain', () => {
    // 100 mm of 0.45 x 0.2 mm bead from 1.75 mm filament: Flow::mm3_per_mm returns the float
    // 0.08141592890024185 mm^2 (the rounded bead), Extruder::e_per_mm3 is
    // 1 / (1.75 * 1.75 * 0.25 * pi) = 0.41575169, so E = 0.41575169 x 0.08141593 x 100 =
    // 3.38488099 (3.38488 once quantized). The flat 0.45 x 0.2 rectangle would give 3.7417.
    expect(extrusionMm(100, 0.45, 0.2, 1.75)).toBeCloseTo(3.384881, 6)
  })
})

describe('generatePaGcode', () => {
  const profile = defaultPrinterProfile()
  const filament = defaultFilamentProfile()
  const spec = defaultPaTestSpec()

  it('emits resolved heat lines from the start gcode, plus homing and relative extrusion', () => {
    const g = generatePaGcode(profile, filament, spec)
    expect(g).toContain('M104 S210')
    expect(g).toContain('M140 S60')
    expect(g).toContain('M190 S60')
    expect(g).toContain('M109 S210')
    expect(g).toContain('G28')
    expect(g).toContain('M83')
  })

  it('emits the heat commands only inside the start gcode, not as a separate preamble', () => {
    const g = generatePaGcode(profile, filament, spec)
    const lines = g.split('\n')
    // Each heat command appears exactly once (no double-heat from a generator preamble).
    for (const cmd of ['M140 S60', 'M104 S210', 'M190 S60', 'M109 S210']) {
      expect(lines.filter((l) => l === cmd).length, cmd).toBe(1)
    }
    // The heat commands sit after the header comments (they come from the start gcode block,
    // which the generator emits after its two header comment lines), and before homing/G90.
    const g28At = lines.indexOf('G28')
    for (const cmd of ['M140 S60', 'M104 S210', 'M190 S60', 'M109 S210']) {
      expect(lines.indexOf(cmd), cmd).toBeLessThan(g28At)
    }
  })

  it('emits the filament start gcode right after the printer start gcode and the filament end gcode right before the printer end gcode', () => {
    const f = {
      ...filament,
      startGcode: 'SET_PRESSURE_ADVANCE ADVANCE=0.05 ; filament start\nM106 S0',
      endGcode: '; filament end\nM400',
    }
    const g = generatePaGcode(profile, f, spec)
    const lines = g.split('\n')
    // Start: the filament block sits between the printer start gcode's last line (G90 from
    // the default profile) and the shared M83 the preamble restates.
    const filamentStartAt = lines.indexOf('SET_PRESSURE_ADVANCE ADVANCE=0.05 ; filament start')
    expect(filamentStartAt).toBeGreaterThan(lines.indexOf('G28'))
    expect(lines[filamentStartAt + 1]).toBe('M106 S0')
    expect(lines[filamentStartAt + 2]).toBe('M83')
    // End: the filament block sits immediately before the printer end gcode's first line.
    const filamentEndAt = lines.indexOf('; filament end')
    expect(lines[filamentEndAt + 1]).toBe('M400')
    expect(lines[filamentEndAt + 2]).toBe('M104 S0')
  })

  it('emits nothing extra when the filament gcode blocks are empty', () => {
    const g = generatePaGcode(profile, filament, spec)
    const withBlank = generatePaGcode(profile, { ...filament, startGcode: ' \n ', endGcode: '' }, spec)
    expect(withBlank).toBe(g)
  })

  it('substitutes slicer variables in the filament gcode blocks', () => {
    const f = { ...filament, startGcode: '; filament block temp [first_layer_temperature]' }
    const g = generatePaGcode(profile, f, spec)
    expect(g).toContain('; filament block temp 210')
  })

  it('emits one PA command per line with the stepped value', () => {
    const g = generatePaGcode(profile, filament, spec)
    for (let i = 0; i < spec.lineCount; i++) {
      const v = paValueForLine(spec, i)
      expect(g).toContain(`SET_PRESSURE_ADVANCE ADVANCE=${v.toFixed(4)}`)
    }
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

  it('never travels across an open fiducial hole while primed', () => {
    // Any length counts. The base raster's approach once crossed a hole primed on the first
    // base layer; now every hole crossing is made retracted.
    const lines = generatePaGcode(profile, filament, spec).split('\n')
    const geo = couponGeometry(spec)
    const ox = (profile.bedWidthMm - geo.baseWidthMm) / 2
    const oy = (profile.bedDepthMm - geo.baseHeightMm) / 2
    const holes = geo.fiducials.map((f) => ({
      x0: ox + f.xMm - geo.fiducialSizeMm / 2,
      y0: oy + f.yMm - geo.fiducialSizeMm / 2,
      x1: ox + f.xMm + geo.fiducialSizeMm / 2,
      y1: oy + f.yMm + geo.fiducialSizeMm / 2,
    }))
    const crossesHole = (ax: number, ay: number, bx: number, by: number) => {
      const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.01))
      for (let k = 1; k < n; k++) {
        const sx = ax + ((bx - ax) * k) / n
        const sy = ay + ((by - ay) * k) / n
        if (holes.some((h) => sx > h.x0 && sx < h.x1 && sy > h.y0 && sy < h.y1)) return true
      }
      return false
    }
    let x = 0
    let y = 0
    let retracted = false
    let retractedCrossings = 0
    const primed: string[] = []
    lines.forEach((l, i) => {
      if (/^G1 .*E-/.test(l)) retracted = true
      else if (/^G1 .*E[\d.]/.test(l)) retracted = false
      const m = l.match(/^G([01]) X(-?[\d.]+) Y(-?[\d.]+)/)
      if (!m) return
      const nx = Number(m[2])
      const ny = Number(m[3])
      if (m[1] === '0' && crossesHole(x, y, nx, ny)) {
        if (retracted) retractedCrossings++
        else primed.push(`line ${i}: ${l}`)
      }
      x = nx
      y = ny
    })
    expect(primed, primed.join('\n')).toEqual([])
    expect(retractedCrossings).toBeGreaterThan(0)
  })

  it('prints each test line from x 72.125 to 147.875, switching speed at x 90 and x 130', () => {
    // The default 96 x 76 mm coupon sits at bed origin (62, 72), so line 0 runs at y 72 + 8 = 80.
    // The nominal line spans coupon x 8 to 88 with its transitions at 28 and 68 (bed 90 and 130).
    // The top-left hole spans coupon x 4 to 9, its two 0.45 mm perimeter loops reach at most
    // 0.9 mm past it at any layer height (0.836 mm at 0.2 mm), and the bead's half width adds
    // 0.225 mm, so the line starts at coupon 10.125 (bed
    // 72.125); the right holes start at coupon 87, so it ends at 85.875 (bed 147.875). At
    // 0.0338488 mm of filament per mm of bead (the extrusionMm case above), the 17.875 mm slow
    // segments take E 0.60505 and the 40 mm fast segment E 1.35395.
    const lines = generatePaGcode(profile, filament, spec).split('\n')
    const start = lines.indexOf('G0 X72.125 Y80.000 F9000')
    expect(start).toBeGreaterThan(0)
    expect(lines.slice(start + 1, start + 5)).toEqual([
      'G1 E0.800 F2100',
      'G1 X90.000 Y80.000 E0.60505 F1500',
      'G1 X130.000 Y80.000 E1.35395 F6000',
      'G1 X147.875 Y80.000 E0.60505 F1500',
    ])
  })

  it('notes after the last test line that the motion limits come back with a firmware restart', () => {
    // The preamble set the profile's acceleration and corner limit, replacing what the
    // firmware had configured, so the end-of-print comments name the motion limits too.
    const lines = generatePaGcode(profile, filament, spec).split('\n')
    const note = lines.indexOf('; run FIRMWARE_RESTART to restore your configured motion limits')
    const lastExtrusion = lines.reduce((last, l, i) => (/^G1 X.* E\d/.test(l) ? i : last), -1)
    expect(note).toBeGreaterThan(lastExtrusion)
    expect(note).toBeLessThan(lines.indexOf('M104 S0'))
  })

  it('rasters the base serpentine-style without long travel-backs', () => {
    const g = generatePaGcode(profile, filament, spec)
    const pauseAt = g.indexOf('\nPAUSE\n')
    let x = 0
    let y = 0
    let seenExtrude = false
    const longTravels: number[] = []
    for (const line of g.slice(0, pauseAt).split('\n')) {
      const mx = /X(-?\d+\.?\d*)/.exec(line)
      const my = /Y(-?\d+\.?\d*)/.exec(line)
      if (!mx && !my) continue
      const nx = mx ? Number(mx[1]) : x
      const ny = my ? Number(my[1]) : y
      if (line.startsWith('G0') && seenExtrude) {
        const d = Math.hypot(nx - x, ny - y)
        if (d > 20) longTravels.push(d)
      }
      if (line.startsWith('G1') && /E\d/.test(line)) seenExtrude = true
      x = nx
      y = ny
    }
    // Only the few perimeter-to-perimeter and perimeter-to-raster hops per layer
    // may be long; the per-scanline full-width travel-backs must be gone.
    expect(longTravels.length).toBeLessThanOrEqual(10)
  })

  it('prints two perimeter loops around the part and each fiducial hole at PrusaSlicer perimeter spacing', () => {
    // The default coupon sits at bed origin (62, 72). The external loop's centre lies half the
    // 0.45 mm width inside the outline (0.225); the second loop one rounded bead spacing further,
    // 0.45 - 0.2 * (1 - pi / 4) = 0.4070796 mm, so at 0.6320796. Around the holes (bed x 149 or 66,
    // y 76 or 139 at their min corners) the same insets apply outward.
    const g = generatePaGcode(profile, filament, spec)
    expect(g).toContain('G0 X62.225 Y72.225 ')
    expect(g).toContain('X62.225 Y72.225 E')
    expect(g).toContain('X62.632 Y72.632 E')
    for (const corner of [
      'X148.775 Y75.775 E', 'X148.368 Y75.368 E',
      'X148.775 Y138.775 E', 'X148.368 Y138.368 E',
      'X65.775 Y138.775 E', 'X65.368 Y138.368 E',
    ]) {
      expect(g).toContain(corner)
    }
  })

  it('starts the base raster where the perimeter loops end', () => {
    // PrusaSlicer's infill boundary: the inner loop's centre (0.6320796) plus half a spacing
    // (0.2035398) puts the raster's edge 0.8356194 mm inside the outline, bed x 62.836 and y 72.836.
    // Before the loops moved to the rounded bead spacing the raster started at 0.9 mm (62.900).
    const lines = generatePaGcode(profile, filament, spec).split('\n')
    const base = lines.slice(0, lines.indexOf('PAUSE'))
    const endpoints = base
      .map((l) => l.match(/^G1 X([\d.]+) Y([\d.]+) E\d/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => [Number(m[1]), Number(m[2])])
    const rasterXs = endpoints.map(([x]) => x).filter((x) => x > 62.7 && x < 70)
    const rasterYs = endpoints.map(([, y]) => y).filter((y) => y > 72.7 && y < 80)
    expect(Math.min(...rasterXs)).toBe(62.836)
    expect(Math.min(...rasterYs)).toBe(72.836)
  })

  it('ends with the end gcode', () => {
    const g = generatePaGcode(profile, filament, spec)
    expect(g.trimEnd().endsWith('M84')).toBe(true)
  })

  it('notes after the last test line that pressure advance comes back with a firmware restart', () => {
    // The coupon leaves pressure advance at the last line's value; nothing is re-applied
    // numerically, so the restore is the restart comment, before the end gcode.
    for (const s of [spec, { ...spec, sweep: 'smoothTime' as const, fixedAdvance: 0.04 }]) {
      const lines = generatePaGcode(profile, filament, s).split('\n')
      const note = lines.indexOf(
        '; pressure advance resumes with the next firmware restart or saved configuration',
      )
      const lastExtrusion = lines.reduce((last, l, i) => (/^G1 X.* E\d/.test(l) ? i : last), -1)
      expect(lastExtrusion).toBeGreaterThan(0)
      expect(note).toBeGreaterThan(lastExtrusion)
      expect(note).toBeLessThan(lines.indexOf('M104 S0'))
    }
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

describe('test line clearance from the fiducial holes', () => {
  type Box = { x0: number; y0: number; x1: number; y1: number }
  type Segment = { from: [number, number]; to: [number, number]; line: string }

  // The extrusion moves of the line layer (everything printed after the filament swap), each
  // with the position it starts from.
  function lineLayerExtrusions(gcode: string): Segment[] {
    let x = 0
    let y = 0
    let afterSwap = false
    const segments: Segment[] = []
    for (const l of gcode.split('\n')) {
      if (l === 'PAUSE') afterSwap = true
      const m = l.match(/^G([01]) X(-?[\d.]+) Y(-?[\d.]+)( E([\d.]+))?/)
      if (!m) continue
      const nx = Number(m[2])
      const ny = Number(m[3])
      if (afterSwap && m[1] === '1' && m[5] !== undefined) {
        segments.push({ from: [x, y], to: [nx, ny], line: l })
      }
      x = nx
      y = ny
    }
    return segments
  }

  // True when a point of the path lies strictly inside the box, sampled every 0.01 mm.
  function entersBox(s: Segment, b: Box): boolean {
    const n = Math.max(2, Math.ceil(Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]) / 0.01))
    for (let k = 0; k <= n; k++) {
      const px = s.from[0] + ((s.to[0] - s.from[0]) * k) / n
      const py = s.from[1] + ((s.to[1] - s.from[1]) * k) / n
      if (px > b.x0 && px < b.x1 && py > b.y0 && py < b.y1) return true
    }
    return false
  }

  // Each 5 mm hole grown by 0.9 mm, the widest band the two 0.45 mm perimeter loops around it
  // reach at any layer height (0.836 mm at the default 0.2 mm), plus the 0.225 mm half width of a
  // bead: a path inside one of these boxes lays its bead on the hole or on its loops. The default 96 x 76 mm coupon sits at bed origin (62, 72), its holes at bed
  // x 149 to 154 (right) and 66 to 71 (left), y 76 to 81 (bottom) and 139 to 144 (top).
  const DEFAULT_KEEP_OUT: Box[] = [
    { x0: 147.875, y0: 74.875, x1: 155.125, y1: 82.125 },
    { x0: 147.875, y0: 137.875, x1: 155.125, y1: 145.125 },
    { x0: 64.875, y0: 137.875, x1: 72.125, y1: 145.125 },
  ]
  // The 10 line coupon is 96 x 52 mm at bed origin (62, 84): holes at y 88 to 93 and 127 to 132.
  const TEN_LINE_KEEP_OUT: Box[] = [
    { x0: 147.875, y0: 86.875, x1: 155.125, y1: 94.125 },
    { x0: 147.875, y0: 125.875, x1: 155.125, y1: 133.125 },
    { x0: 64.875, y0: 125.875, x1: 72.125, y1: 133.125 },
  ]

  // Moves per coupon: the prime line plus three segments per test line.
  it.each([
    ['the default advance sweep', defaultPaTestSpec(), DEFAULT_KEEP_OUT, 49],
    ['the smooth time sweep', defaultSmoothTimeTestSpec(0.03), DEFAULT_KEEP_OUT, 49],
    ['a 10 line advance sweep', { ...defaultPaTestSpec(), lineCount: 10 }, TEN_LINE_KEEP_OUT, 31],
  ])('keeps every line layer bead of %s off the fiducial holes and their perimeter loops', (_, spec, keepOut, moves) => {
    const g = generatePaGcode(defaultPrinterProfile(), defaultFilamentProfile(), spec)

    const segments = lineLayerExtrusions(g)
    const intrusions = segments.filter((s) => keepOut.some((b) => entersBox(s, b))).map((s) => s.line)

    expect(segments).toHaveLength(moves)
    expect(intrusions).toEqual([])
  })
})

describe('motion limits', () => {
  const spec = defaultPaTestSpec()

  function linesOf(): string[] {
    return generatePaGcode(defaultPrinterProfile(), defaultFilamentProfile(), spec).split('\n')
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
    assertAfterStartBeforeFirstMove(linesOf(), [
      'SET_VELOCITY_LIMIT ACCEL=3000 SQUARE_CORNER_VELOCITY=5',
    ])
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

  it('warns when the start gcode sets no temperatures', () => {
    const p = { ...defaultPrinterProfile(), startGcode: 'G28\nG90' }
    const r = generatePaGcodeWithReport(p, defaultFilamentProfile(), defaultPaTestSpec())
    expect(r.warnings.some((w) => /sets no temperatures/i.test(w))).toBe(true)
  })

  it('does not warn for a Klipper print-start macro that heats via temperature params', () => {
    const p = { ...defaultPrinterProfile(), startGcode: 'PRINT_START TOOL_TEMP=230 BED_TEMP=60 TOOL=0' }
    const r = generatePaGcodeWithReport(p, defaultFilamentProfile(), defaultPaTestSpec())
    expect(r.warnings.some((w) => /sets no temperatures/i.test(w))).toBe(false)
  })

  it('warns for a print-start macro carrying no temperature parameter', () => {
    const p = { ...defaultPrinterProfile(), startGcode: 'PRINT_START\nG28' }
    const r = generatePaGcodeWithReport(p, defaultFilamentProfile(), defaultPaTestSpec())
    expect(r.warnings.some((w) => /sets no temperatures/i.test(w))).toBe(true)
  })

  it('does not warn for the default profile, whose start gcode heats via placeholders', () => {
    const p = defaultPrinterProfile()
    const r = generatePaGcodeWithReport(p, defaultFilamentProfile(), defaultPaTestSpec())
    expect(r.warnings.some((w) => /sets no temperatures/i.test(w))).toBe(false)
  })

  it('does not double-heat or warn for an imported start gcode that already heats', () => {
    const p = {
      ...defaultPrinterProfile(),
      startGcode: 'M140 S[first_layer_bed_temperature]\nM104 S[first_layer_temperature]\nPRINT_START\nG28',
    }
    const r = generatePaGcodeWithReport(p, defaultFilamentProfile(), defaultPaTestSpec())
    expect(r.warnings.some((w) => /sets no temperatures/i.test(w))).toBe(false)
    const lines = r.gcode.split('\n')
    expect(lines.filter((l) => l === 'M104 S210').length).toBe(1)
    expect(lines.filter((l) => l === 'M140 S60').length).toBe(1)
  })

  it('reports nothing for the default profile and matches generatePaGcode', () => {
    const p = defaultPrinterProfile()
    const r = generatePaGcodeWithReport(p, defaultFilamentProfile(), defaultPaTestSpec())
    expect(r.unknownVariables).toEqual([])
    expect(r.gcode).toBe(generatePaGcode(p, defaultFilamentProfile(), defaultPaTestSpec()))
  })
})
