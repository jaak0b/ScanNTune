import { describe, expect, it } from 'vitest'
import { defaultFilamentProfile, defaultPrinterProfile } from '../../../src/engine/pa/types'
import { defaultEmTestSpec, emCouponGeometry, PEDESTAL_WIDTH_FACTOR } from '../../../src/engine/em/types'
import { extrusionMm } from '../../../src/engine/gcode/emitter'
import {
  ANCHOR_OVERLAP_MM,
  EDGE_MARGIN_MM,
  generateEmGcodeWithReport,
} from '../../../src/engine/em/gcodeGenerator'

const profile = defaultPrinterProfile()
const filament = defaultFilamentProfile()
const spec = defaultEmTestSpec(profile)

describe('generateEmGcodeWithReport', () => {
  const report = generateEmGcodeWithReport(profile, filament, spec)
  const lines = report.gcode.split('\n')

  it('emits a header, start gcode, and motion limits', () => {
    expect(lines[0]).toContain('extrusion multiplier test')
    expect(report.gcode).toContain('M83')
    expect(report.gcode).toContain('G90')
    expect(report.gcode).toContain('SET_VELOCITY_LIMIT') // Klipper default profile
  })

  it('prints four layers', () => {
    const zMoves = lines.filter((l) => l.startsWith('G1 Z'))
    const zs = [...new Set(zMoves.map((l) => l.match(/Z([\d.]+)/)![1]))]
    expect(zs).toEqual(['0.200', '0.400', '0.600', '10'])
  })

  it('contains no pause and pins the firmware flow override to 100 percent', () => {
    expect(report.gcode).not.toContain('PAUSE')
    // The test's baseline is exactly 1.0, so a leftover flow override is neutralized and
    // never re-applied elsewhere.
    expect(lines.filter((l) => l.startsWith('M221'))).toEqual(['M221 S100'])
  })

  it('never travels far across the open window without retracting first', () => {
    const g = emCouponGeometry(spec)
    const ox = (profile.bedWidthMm - g.couponWidthMm) / 2
    const oy = (profile.bedDepthMm - g.couponHeightMm) / 2
    // Window interior, shrunk a little so band-edge moves do not count.
    const win = {
      x0: ox + g.frameBandMm + 1,
      y0: oy + g.frameBandMm + 1,
      x1: ox + g.couponWidthMm - g.frameBandMm - 1,
      y1: oy + g.couponHeightMm - g.frameBandMm - 1,
    }
    const inWindow = (x: number, y: number) =>
      x > win.x0 && x < win.x1 && y > win.y0 && y < win.y1
    let x = 0
    let y = 0
    let retracted = false
    for (const l of lines) {
      if (/^G1 E-/.test(l)) retracted = true
      else if (/^G1 E[^-]/.test(l)) retracted = false
      const m = l.match(/^G([01]) X(-?[\d.]+) Y(-?[\d.]+)/)
      if (!m) continue
      const nx = Number(m[2])
      const ny = Number(m[3])
      if (m[1] === '0') {
        const len = Math.hypot(nx - x, ny - y)
        const crossesWindow = inWindow((x + nx) / 2, (y + ny) / 2) || inWindow(nx, ny)
        if (len > 5 && crossesWindow) {
          expect(retracted, `unretracted ${len.toFixed(1)}mm travel over the window: ${l}`).toBe(true)
        }
      }
      x = nx
      y = ny
    }
  })

  it('uses the pedestal width on layer 1 and the nominal width on the top layer for comb lines', () => {
    // A full-length vertical comb line's E value identifies its commanded width; each line
    // overruns its row by the anchor overlap on both ends.
    const combLen = spec.lineLengthMm + 2 * ANCHOR_OVERLAP_MM
    const eFor = (w: number) =>
      extrusionMm(combLen, w, profile.layerHeightMm, filament.filamentDiameterMm)
    const pedestalE = eFor(PEDESTAL_WIDTH_FACTOR * spec.nominalLineWidthMm).toFixed(5)
    const nominalE = eFor(spec.nominalLineWidthMm).toFixed(5)
    expect(report.gcode).toContain(`E${pedestalE}`)
    expect(report.gcode).toContain(`E${nominalE}`)
  })

  it('emits one comb move per line per layer', () => {
    const g = emCouponGeometry(spec)
    const eFor = (w: number) =>
      extrusionMm(spec.lineLengthMm + 2 * ANCHOR_OVERLAP_MM, w, profile.layerHeightMm,
        filament.filamentDiameterMm)
    const nominalE = `E${eFor(spec.nominalLineWidthMm).toFixed(5)}`
    const combMoves = lines.filter((l) => l.includes(nominalE))
    // 2 measured layers x 2 rows x blockCount x linesPerBlock
    expect(combMoves.length).toBe(2 * 2 * spec.blockCount * spec.linesPerBlock)
    expect(g.topRow).toHaveLength(spec.blockCount)
  })

  it('throws when the coupon exceeds the bed', () => {
    const tiny = { ...profile, bedWidthMm: 50, bedDepthMm: 50 }
    expect(() => generateEmGcodeWithReport(tiny, filament, spec)).toThrow(/fit/i)
  })

  it('retracts and unretracts across every layer transition (no ooze drag)', () => {
    // Negative-E retract lines: one retract per block per row per layer (retract only, the
    // matching unretract is a positive-E line), plus one retract+unretract pair (2 negative-E
    // lines... only the retract half is negative) at each of the 3 layer transitions, plus the
    // final retract before the end gcode.
    const retractLines = lines.filter((l) => /^G1 E-/.test(l))
    const totalLayers = 3 // PEDESTAL_LAYERS + MEASURED_LAYERS from defaultEmTestSpec's profile
    const perLayerCombRetracts = 2 * spec.blockCount // 2 rows x blockCount blocks
    const perLayerStripRetracts = 4 // one per band raster strip
    const perLayerRailRetracts = 1 // approach travel to the rail crosses the window
    const layerTransitions = totalLayers - 1
    const expected =
      totalLayers * (perLayerCombRetracts + perLayerStripRetracts + perLayerRailRetracts) +
      layerTransitions +
      1
    expect(retractLines.length).toBe(expected)
  })

  it('does not travel directly from the last comb of one layer to the first frame move of the next', () => {
    // Every G1 Z line for layer > 0 must be immediately preceded by a retract.
    const layerZs = ['0.200', '0.400', '0.600']
    const zIndexes = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => layerZs.some((z) => l === `G1 Z${z} F600`))
      .map(({ i }) => i)
    expect(zIndexes.length).toBe(3) // the three layer-loop Z pushes, not the end gcode's lift
    for (const i of zIndexes.slice(1)) {
      expect(lines[i - 1]).toMatch(/^G1 E-/)
      // Still retracted for the travel to the frame corner; pressure restored only after it.
      expect(lines[i + 1]).toMatch(/^G0 /)
      expect(lines[i + 2]).toMatch(/^G1 E[^-]/)
    }
  })

  it('stays inside the bed even when the coupon nearly fills it', () => {
    const g = emCouponGeometry(spec)
    const tight = { ...profile, bedWidthMm: g.couponWidthMm + 0.5, bedDepthMm: g.couponHeightMm + 0.5 }
    const r = generateEmGcodeWithReport(tight, filament, spec)
    const coords = [...r.gcode.matchAll(/[XY](-?[\d.]+)/g)].map((m) => Number(m[1]))
    expect(coords.every((v) => v >= 0)).toBe(true)
  })

  it('throws on a non-positive line length', () => {
    const bad = { ...spec, lineLengthMm: 0 }
    expect(() => generateEmGcodeWithReport(profile, filament, bad)).toThrow(/line length/i)
  })

  it('throws on a non-positive nominal line width', () => {
    const bad = { ...spec, nominalLineWidthMm: -1 }
    expect(() => generateEmGcodeWithReport(profile, filament, bad)).toThrow(/line width/i)
  })

  it('warns on high volumetric flow instead of blocking', () => {
    const fast = { ...spec, printSpeedMmS: 300 }
    const r = generateEmGcodeWithReport(profile, filament, fast)
    expect(r.warnings.some((w) => w.includes('mm^3/s'))).toBe(true)
  })

  it('warns when acceleration ramps eat the line middle', () => {
    const slowAccel = { ...profile, printAccelMmS2: 500 }
    const fast = { ...spec, printSpeedMmS: 300 }
    const r = generateEmGcodeWithReport(slowAccel, filament, fast)
    expect(r.warnings.some((w) => w.toLowerCase().includes('speed'))).toBe(true)
  })

  it('reports unknown slicer variables from the start gcode', () => {
    const weird = { ...profile, startGcode: 'M104 S[not_a_real_variable]' }
    const r = generateEmGcodeWithReport(weird, filament, spec)
    expect(r.unknownVariables).toContain('not_a_real_variable')
  })

  it('matches the same generation with placement and contrastBase set to their defaults', () => {
    const explicit = { ...spec, placement: 'center' as const, contrastBase: false }
    const r = generateEmGcodeWithReport(profile, filament, explicit)
    expect(r.gcode).toBe(report.gcode)
  })
})

describe('contrastBase', () => {
  const baseSpec = { ...spec, contrastBase: true }
  const report = generateEmGcodeWithReport(profile, filament, baseSpec)
  const lines = report.gcode.split('\n')

  it('emits the pause gcode only when contrastBase is set', () => {
    expect(report.gcode).toContain('PAUSE')
    expect(report.gcode).toContain('; if your pause macro already retracts')
    const plain = generateEmGcodeWithReport(profile, filament, spec)
    expect(plain.gcode).not.toContain('PAUSE')
    expect(plain.gcode).not.toContain('; if your pause macro already retracts')
  })

  it('shifts the coupon layers up by the two base layers', () => {
    const zMoves = lines.filter((l) => l.startsWith('G1 Z'))
    const zs = [...new Set(zMoves.map((l) => l.match(/Z([\d.]+)/)![1]))]
    expect(zs).toEqual(['0.200', '0.400', '0.600', '0.800', '1.000', '10'])
  })

  it('brackets the pause with a retract and an unretract', () => {
    const i = lines.indexOf('PAUSE')
    expect(i).toBeGreaterThan(0)
    expect(lines[i - 1]).toMatch(/^G1 E-/)
    expect(lines[i + 1]).toBe('; if your pause macro already retracts, set retractMm to 0 in the profile')
    expect(lines[i + 2]).toMatch(/^G1 E[^-]/)
  })

  it('keeps the fiducial hole boxes free of extrusion on the base layers', () => {
    const g = emCouponGeometry(baseSpec)
    const ox = (profile.bedWidthMm - g.couponWidthMm) / 2
    const oy = (profile.bedDepthMm - g.couponHeightMm) / 2
    const holes = g.fiducials.map((f) => ({
      x0: ox + f.xMm - g.fiducialSizeMm / 2,
      y0: oy + f.yMm - g.fiducialSizeMm / 2,
      x1: ox + f.xMm + g.fiducialSizeMm / 2,
      y1: oy + f.yMm + g.fiducialSizeMm / 2,
    }))
    const pauseIndex = lines.indexOf('PAUSE')
    const crossesHole = (x0: number, y0: number, x1: number, y1: number) => {
      // Sample the segment densely; the hole boxes are 5 mm, so 0.5 mm steps cannot skip one.
      const len = Math.hypot(x1 - x0, y1 - y0)
      const n = Math.max(2, Math.ceil(len / 0.5))
      for (let k = 0; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n
        const y = y0 + ((y1 - y0) * k) / n
        for (const h of holes) {
          if (x > h.x0 + 0.01 && x < h.x1 - 0.01 && y > h.y0 + 0.01 && y < h.y1 - 0.01) return true
        }
      }
      return false
    }
    let x = 0
    let y = 0
    for (const l of lines.slice(0, pauseIndex)) {
      const m = l.match(/^G([01]) X(-?[\d.]+) Y(-?[\d.]+)/)
      if (!m) continue
      const nx = Number(m[2])
      const ny = Number(m[3])
      if (m[1] === '1' && /E[\d.]/.test(l)) {
        expect(crossesHole(x, y, nx, ny), `extrusion over a fiducial hole: ${l}`).toBe(false)
      }
      x = nx
      y = ny
    }
  })

  it('prints two solid base layers over the full rectangle before the pause', () => {
    const g = emCouponGeometry(baseSpec)
    const ox = (profile.bedWidthMm - g.couponWidthMm) / 2
    const pauseIndex = lines.indexOf('PAUSE')
    const preZs = [
      ...new Set(
        lines
          .slice(0, pauseIndex)
          .filter((l) => l.startsWith('G1 Z'))
          .map((l) => l.match(/Z([\d.]+)/)![1]),
      ),
    ]
    expect(preZs).toEqual(['0.200', '0.400'])
    // Solid base: some extrusion crosses the window interior mid-width before the pause.
    const midX = ox + g.couponWidthMm / 2
    const crossesMid = lines.slice(0, pauseIndex).some((l) => {
      const m = l.match(/^G1 X(-?[\d.]+) Y(-?[\d.]+) E/)
      return m !== null && Math.abs(Number(m[1]) - midX) < g.couponWidthMm / 4
    })
    expect(crossesMid).toBe(true)
  })
})

describe('placement', () => {
  const yExtentsOfExtrusionMoves = (gcode: string) => {
    const ys: number[] = []
    for (const l of gcode.split('\n')) {
      const m = l.match(/^G1 X(-?[\d.]+) Y(-?[\d.]+).*E(-?[\d.]+)/)
      if (m && Number(m[3]) > 0) ys.push(Number(m[2]))
    }
    return { minY: Math.min(...ys), maxY: Math.max(...ys) }
  }

  it('center placement centers the coupon vertically (unchanged default behavior)', () => {
    const g = emCouponGeometry(spec)
    const oy = (profile.bedDepthMm - g.couponHeightMm) / 2
    const r = generateEmGcodeWithReport(profile, filament, { ...spec, placement: 'center' })
    const { minY, maxY } = yExtentsOfExtrusionMoves(r.gcode)
    expect(minY).toBeGreaterThanOrEqual(oy - 0.001)
    expect(maxY).toBeLessThanOrEqual(oy + g.couponHeightMm + 0.001)
  })

  it('front placement puts the coupon near the front edge', () => {
    const r = generateEmGcodeWithReport(profile, filament, { ...spec, placement: 'front' })
    const { minY } = yExtentsOfExtrusionMoves(r.gcode)
    expect(minY).toBeGreaterThanOrEqual(EDGE_MARGIN_MM - 0.001)
    expect(minY).toBeLessThan(EDGE_MARGIN_MM + 5)
  })

  it('back placement puts the coupon near the back edge', () => {
    const r = generateEmGcodeWithReport(profile, filament, { ...spec, placement: 'back' })
    const { maxY } = yExtentsOfExtrusionMoves(r.gcode)
    const expectedBackEdge = profile.bedDepthMm - EDGE_MARGIN_MM
    expect(maxY).toBeLessThanOrEqual(expectedBackEdge + 0.001)
    expect(maxY).toBeGreaterThan(expectedBackEdge - 5)
  })

  it('throws when a front/back placement pushes the coupon off the bed', () => {
    const g = emCouponGeometry(spec)
    const tiny = { ...profile, bedDepthMm: g.couponHeightMm + EDGE_MARGIN_MM - 1 }
    expect(() =>
      generateEmGcodeWithReport(tiny, filament, { ...spec, placement: 'back' }),
    ).toThrow(/fit/i)
  })
})

describe('extrusion multiplier pinning', () => {
  it('prints identically for any filament extrusion multiplier (baseline is 1.0)', () => {
    const rich = { ...filament, extrusionMultiplier: 1.25 }
    expect(generateEmGcodeWithReport(profile, rich, spec).gcode).toBe(
      generateEmGcodeWithReport(profile, filament, spec).gcode,
    )
  })

  it('judges the high-flow warning against the filament limit when configured', () => {
    // 120 mm/s at 0.42 mm width and 0.2 mm layers is 10.1 mm^3/s: silent by default,
    // warned past a configured 8 mm^3/s filament limit, naming that limit.
    const fast = { ...spec, printSpeedMmS: 120 }
    expect(generateEmGcodeWithReport(profile, filament, fast).warnings
      .some((w) => w.includes('mm^3/s'))).toBe(false)
    const weak = { ...filament, maxVolumetricFlowMm3S: 8 }
    expect(generateEmGcodeWithReport(profile, weak, fast).warnings
      .some((w) => w.includes("filament's configured 8 mm^3/s"))).toBe(true)
  })
})

describe('first layer speed', () => {
  it('prints the whole first coupon layer at the profile first layer speed', () => {
    const firstLayerFeed = profile.firstLayerSpeedMmS * 60
    const lines = generateEmGcodeWithReport(profile, filament, spec).gcode.split('\n')
    const chunks: string[][] = []
    let current: string[] | null = null
    for (const l of lines) {
      if (/^G1 Z0\./.test(l)) {
        current = []
        chunks.push(current)
      } else if (current) current.push(l)
    }
    const feedsOf = (chunk: string[]) =>
      chunk
        .map((l) => l.match(/^G1 X.*E[\d.]+ F(\d+)$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => Number(m[1]))
    expect(feedsOf(chunks[0]).every((f) => f === firstLayerFeed)).toBe(true)
    expect(feedsOf(chunks[chunks.length - 1]).some((f) => f > firstLayerFeed)).toBe(true)
  })
})
