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

type OpenBox = { x0: number; y0: number; x1: number; y1: number }

/** The centered coupon's open areas in bed coordinates: the two comb windows, then the
 *  fiducial holes. */
function openAreasOf(s: typeof spec): OpenBox[] {
  const g = emCouponGeometry(s)
  const ox = (profile.bedWidthMm - g.couponWidthMm) / 2
  const oy = (profile.bedDepthMm - g.couponHeightMm) / 2
  const windows = [
    { x0: ox + g.frameBandMm, y0: oy + g.topRowY0Mm, x1: ox + g.couponWidthMm - g.frameBandMm, y1: oy + g.topRowY1Mm },
    { x0: ox + g.frameBandMm, y0: oy + g.bottomRowY0Mm, x1: ox + g.couponWidthMm - g.frameBandMm, y1: oy + g.bottomRowY1Mm },
  ]
  const holes = g.fiducials.map((f) => ({
    x0: ox + f.xMm - g.fiducialSizeMm / 2,
    y0: oy + f.yMm - g.fiducialSizeMm / 2,
    x1: ox + f.xMm + g.fiducialSizeMm / 2,
    y1: oy + f.yMm + g.fiducialSizeMm / 2,
  }))
  return [...windows, ...holes]
}

/** True when the straight path passes through a box interior, by dense sampling. */
function crossesAny(ax: number, ay: number, bx: number, by: number, boxes: OpenBox[]): boolean {
  const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.01))
  for (let k = 1; k < n; k++) {
    const x = ax + ((bx - ax) * k) / n
    const y = ay + ((by - ay) * k) / n
    if (boxes.some((b) => x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1)) return true
  }
  return false
}

/** The travels crossing an open box, split by whether the nozzle ran them retracted. */
function travelsAcross(gcodeLines: string[], boxes: OpenBox[]): { primed: string[]; retracted: number } {
  let x = 0
  let y = 0
  let retracted = false
  const primed: string[] = []
  let retractedCount = 0
  gcodeLines.forEach((l, i) => {
    if (/^G1 .*E-/.test(l)) retracted = true
    else if (/^G1 .*E[\d.]/.test(l)) retracted = false
    const m = l.match(/^G([01]) X(-?[\d.]+) Y(-?[\d.]+)/)
    if (!m) return
    const nx = Number(m[2])
    const ny = Number(m[3])
    if (m[1] === '0' && crossesAny(x, y, nx, ny, boxes)) {
      if (retracted) retractedCount++
      else primed.push(`line ${i}: ${l}`)
    }
    x = nx
    y = ny
  })
  return { primed, retracted: retractedCount }
}

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

  it('winds the centre rail loops at PrusaSlicer perimeter spacing and rasters the rail from their inner edge', () => {
    // The default 94.6 x 78 mm coupon sits at bed origin (62.7, 71); its 4 mm rail spans bed x
    // 74.7 to 145.3, y 108 to 112. The external rail loop's centre lies half the 0.42 mm width
    // inside the rail (0.21: x 74.910, y 108.210); the second loop one rounded bead spacing,
    // 0.42 - 0.2 * (1 - pi / 4) = 0.3770796 mm, further (0.5870796: x 75.287, y 108.587). The
    // raster starts half a spacing past it, 0.7756194 mm inside the rail edges (y 108.776 to
    // 111.224), where it once started a full 0.84 mm in.
    expect(report.gcode).toContain('G1 X74.910 Y108.210 E')
    expect(report.gcode).toContain('G1 X75.287 Y108.587 E')
    const railRasterYs = lines
      .map((l) => l.match(/^G1 X([\d.]+) Y([\d.]+) E\d/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => [Number(m[1]), Number(m[2])])
      .filter(([x, y]) => x > 75.3 && x < 144.7 && y > 108.6 && y < 111.4)
      .map(([, y]) => y)

    expect(Math.min(...railRasterYs)).toBe(108.776)
    expect(Math.max(...railRasterYs)).toBe(111.224)
  })

  it('contains no pause and pins the firmware flow override to 100 percent', () => {
    expect(report.gcode).not.toContain('PAUSE')
    // The test's baseline is exactly 1.0, so a leftover flow override is neutralized and
    // never re-applied elsewhere.
    expect(lines.filter((l) => l.startsWith('M221'))).toEqual(['M221 S100'])
  })

  it('notes after the last comb line that the flow percentage comes back with a firmware restart', () => {
    // The pinned M221 S100 stays in force after the print; nothing is re-applied
    // numerically, so the restore is the restart comment, before the end gcode.
    const note = lines.indexOf('; the M221 flow percentage resumes with the next firmware restart')
    const lastExtrusion = lines.reduce((last, l, i) => (/^G1 X.* E\d/.test(l) ? i : last), -1)
    expect(lastExtrusion).toBeGreaterThan(0)
    expect(note).toBeGreaterThan(lastExtrusion)
    expect(note).toBeLessThan(lines.indexOf('M104 S0'))
  })

  it('never travels across a comb window or a fiducial hole without retracting first', () => {
    // Any length counts: a primed nozzle strings a film across an opening however short the
    // hop. The comb windows and the hole boxes are the coupon's own open areas.
    const primed = travelsAcross(lines, openAreasOf(spec)).primed
    expect(primed, primed.join('\n')).toEqual([])
    // The scan is not vacuous: the comb approaches cross the windows retracted.
    expect(travelsAcross(lines, openAreasOf(spec)).retracted).toBeGreaterThan(0)
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

  it('pairs every retract with an un-retract and never extrudes retracted (no ooze drag)', () => {
    // Every stationary retract is followed by travels (and at most a layer change) and then
    // an un-retract before the next extrusion; only the final retract before the end G-code
    // stays open. A missing un-retract would print a starved bead; a missing retract would
    // leave a primed hop, which the open-area test above catches.
    let retracted = false
    let extrudedRetracted = 0
    const openRetracts: number[] = []
    lines.forEach((l, i) => {
      if (/^G1 E-/.test(l)) {
        expect(retracted, `double retract at line ${i}`).toBe(false)
        retracted = true
        openRetracts.push(i)
      } else if (/^G1 E[\d.]/.test(l)) {
        expect(retracted, `un-retract without a retract at line ${i}`).toBe(true)
        retracted = false
        openRetracts.pop()
      } else if (/^G1 X.* E[\d.]/.test(l) && retracted) {
        extrudedRetracted++
      }
    })
    expect(extrudedRetracted).toBe(0)
    // The one retract left open is the final one, after the last restart comment.
    expect(openRetracts).toEqual([lines.indexOf('; run FIRMWARE_RESTART to restore your configured motion limits') + 1])
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

  it('never travels across an open fiducial hole while primed, base layers included', () => {
    // The base backs the comb windows, so on the base layers only the holes are open; above
    // the base the windows are open too. The base raster's approach once crossed a hole primed.
    const pauseIndex = lines.indexOf('PAUSE')
    const open = openAreasOf(baseSpec)
    const base = travelsAcross(lines.slice(0, pauseIndex), open.slice(2))
    expect(base.primed, base.primed.join('\n')).toEqual([])
    expect(base.retracted).toBeGreaterThan(0)
    const coupon = travelsAcross(lines.slice(pauseIndex), open).primed
    expect(coupon, coupon.join('\n')).toEqual([])
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
    // The coupon needs its height plus the 10 mm edge margin; one millimetre less overhangs
    // the back edge on a front placement and the front edge on a back placement.
    const g = emCouponGeometry(spec)
    const tiny = { ...profile, bedDepthMm: g.couponHeightMm + EDGE_MARGIN_MM - 1 }
    for (const placement of ['front', 'back'] as const) {
      expect(() =>
        generateEmGcodeWithReport(tiny, filament, { ...spec, placement }),
      ).toThrow('Coupon does not fit on the configured bed')
    }
    const exact = { ...profile, bedDepthMm: g.couponHeightMm + EDGE_MARGIN_MM }
    expect(() =>
      generateEmGcodeWithReport(exact, filament, { ...spec, placement: 'front' }),
    ).not.toThrow()
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
    // 120 mm/s over the 0.07541592 mm^2 rounded bead of 0.42 mm width at 0.2 mm layers is
    // 9.05 mm^3/s: silent by default, warned past a configured 8 mm^3/s filament limit,
    // naming that limit.
    const fast = { ...spec, printSpeedMmS: 120 }
    expect(generateEmGcodeWithReport(profile, filament, fast).warnings
      .some((w) => w.includes('mm^3/s'))).toBe(false)
    const weak = { ...filament, maxVolumetricFlowMm3S: 8 }
    expect(generateEmGcodeWithReport(profile, weak, fast).warnings).toContain(
      "Lower the print speed, or raise the filament's max volumetric flow only if the hotend " +
        "can melt 9.0 mm^3/s. Above the filament's 8 mm^3/s max volumetric flow, the lines " +
        'under-extrude.',
    )
  })

  it('judges the flow at the pinned 1.0 multiplier the test prints with', () => {
    // A 1.25 filament multiplier never reaches the comb lines, so 9.05 mm^3/s stays under a
    // 10.5 mm^3/s limit (11.31 mm^3/s would pass it).
    const fast = { ...spec, printSpeedMmS: 120 }
    const rich = { ...filament, extrusionMultiplier: 1.25, maxVolumetricFlowMm3S: 10.5 }
    expect(generateEmGcodeWithReport(profile, rich, fast).warnings
      .some((w) => w.includes('mm^3/s'))).toBe(false)
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
