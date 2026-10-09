import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultFilamentProfile, defaultPrinterProfile } from '../../../src/engine/pa/types'
import type { PrinterProfile } from '../../../src/engine/gcode/profileTypes'
import {
  extrusionMm,
  NOMINAL_WIDTH_FACTOR,
  PEDESTAL_LAYERS,
} from '../../../src/engine/gcode/emitter'
import { isCouponGeometry, type IsLine } from '../../../src/engine/is/couponGeometry'

import { defaultIsTestRequest, fitSpecToPrinter } from '../../../src/engine/is/types'
import {
  generateIsGcodeWithReport,
  IS_MEASURED_LAYERS,
} from '../../../src/engine/is/gcodeGenerator'

const profile = defaultPrinterProfile()
const filament = defaultFilamentProfile()
const spec = defaultIsTestRequest(profile)
// The fitted default the generator prints: tiers 90 / 150 mm/s, four lines per speed.
const fitted = fitSpecToPrinter(spec, profile).spec
const nominal = profile.nozzleDiameterMm * NOMINAL_WIDTH_FACTOR
const g = isCouponGeometry(fitted)
const ox = (profile.bedWidthMm - g.couponWidthMm) / 2
const oy = (profile.bedDepthMm - g.couponHeightMm) / 2
// Each line's run-up cruises at its own rung of the corner-speed ladder.
const runUpFeed = (line: IsLine) => Math.round(line.cornerSpeedMmS * 60)
const allLines = g.groups.flatMap((grp) => grp.lines)

const ePerMm = (w: number) =>
  extrusionMm(1, w, profile.layerHeightMm, filament.filamentDiameterMm)

/** A move's length between the 3-decimal coordinates the G-code prints for its two ends: the
 *  length the generator meters a move's E over. */
const printedLen = (ax: number, ay: number, bx: number, by: number) => {
  const printed = (v: number) => Number(v.toFixed(3))
  return Math.hypot(printed(bx) - printed(ax), printed(by) - printed(ay))
}

/** The printed length of a line's run-up cruise on a coupon placed at (x0, y0). */
const runUpLen = (line: IsLine, x0 = ox, y0 = oy) =>
  printedLen(x0 + line.runUp.x0, y0 + line.runUp.y0, x0 + line.runUp.x1, y0 + line.runUp.y1)

/** The full-flow run-up cruise move, ending exactly on the line's ringing corner. */
const cornerMoveStr = (line: IsLine) =>
  `G1 X${(ox + line.measured.x0).toFixed(3)} Y${(oy + line.measured.y0).toFixed(3)} ` +
  `E${(runUpLen(line) * ePerMm(nominal)).toFixed(5)} F${runUpFeed(line)}`

const firstExtrusionIndex = (lines: string[]) => lines.findIndex((l) => /^G1 .*E-?[\d.]/.test(l))
// The last printing move; the final retract (a bare G1 E-) sits after the restore block.
const lastExtrusionIndex = (lines: string[]) => {
  for (let i = lines.length - 1; i >= 0; i--) if (/^G1 X.*E[\d.]/.test(lines[i])) return i
  return -1
}

type OpenBox = { x0: number; y0: number; x1: number; y1: number }

/** The coupon's fiducial holes in bed coordinates. */
function holeBoxesOf(geo: typeof g, x0: number, y0: number): OpenBox[] {
  return geo.fiducials.map((f) => ({
    x0: x0 + f.xMm - geo.fiducialSizeMm / 2,
    y0: y0 + f.yMm - geo.fiducialSizeMm / 2,
    x1: x0 + f.xMm + geo.fiducialSizeMm / 2,
    y1: y0 + f.yMm + geo.fiducialSizeMm / 2,
  }))
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

/** Walks the travels with the retract state (stationary and moving retracts alike) and
 *  returns each travel crossing an open box, split by whether the nozzle was retracted. */
function travelsAcross(lines: string[], boxes: OpenBox[]): { primed: string[]; retracted: number } {
  let x = 0
  let y = 0
  let retracted = false
  const primed: string[] = []
  let retractedCount = 0
  lines.forEach((l, i) => {
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
const primedTravelsAcross = (lines: string[], boxes: OpenBox[]) => travelsAcross(lines, boxes).primed
const retractedTravelsAcross = (lines: string[], boxes: OpenBox[]) =>
  travelsAcross(lines, boxes).retracted

/** Layer chunks: the G-code lines between consecutive printing-layer Z moves. */
function layerChunks(lines: string[]): string[][] {
  const zIndexes = lines.flatMap((l, i) => (/^G1 Z0\./.test(l) ? [i] : []))
  return zIndexes.map((z, k) => lines.slice(z + 1, zIndexes[k + 1] ?? lines.length))
}

/** The measured layer's chunk (after the pedestal). */
function measuredChunk(lines: string[]): string[] {
  const chunks = layerChunks(lines)
  return chunks[chunks.length - 1]
}

/**
 * Phase markers of one coupon layer: the perimeter loops start at the layer's first bare
 * deretract, the test lines at the first stationary retract after it, and the band raster at
 * the first bare deretract after the last wipe-on-retract (every test line starts with a bare
 * deretract of its own, so the raster is found past the lines).
 */
function phaseMarkers(chunk: string[]): { perimeterStart: number; linesStart: number; rasterStart: number } {
  const perimeterStart = chunk.findIndex((l) => /^G1 E[\d.]/.test(l))
  const linesStart = chunk.findIndex((l, i) => i > perimeterStart && /^G1 E-/.test(l))
  let lastWipe = -1
  chunk.forEach((l, i) => {
    if (/^G1 X.* E-/.test(l)) lastWipe = i
  })
  const rasterStart = chunk.findIndex((l, i) => i > lastWipe && /^G1 E[\d.]/.test(l))
  return { perimeterStart, linesStart, rasterStart }
}

interface Seg {
  len: number
  e: number | null
  f: number
  startDist: number
}

/** The planner stop and the corner-limit commands a line carries between its moves. */
const NON_MOTION = /^(G4 P0|SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=)/

/** Walk the printing moves of one test line from its corner up to and including the wipe,
 *  stepping over the planner stop and the corner-limit commands between them. */
function walkLine(chunk: string[], cornerIdx: number, cx: number, cy: number): Seg[] {
  const segs: Seg[] = []
  let x = cx
  let y = cy
  let dist = 0
  for (let i = cornerIdx + 1; i < chunk.length; i++) {
    if (NON_MOTION.test(chunk[i])) continue
    const m = chunk[i].match(/^G1 X(-?[\d.]+) Y(-?[\d.]+)(?: E(-?[\d.]+))? F(\d+)$/)
    if (!m) break
    const nx = Number(m[1])
    const ny = Number(m[2])
    const e = m[3] === undefined ? null : Number(m[3])
    const len = Math.hypot(nx - x, ny - y)
    segs.push({ len, e, f: Number(m[4]), startDist: dist })
    if (e !== null && e < 0) break
    dist += len
    x = nx
    y = ny
  }
  return segs
}

describe('generateIsGcodeWithReport (Klipper)', () => {
  const report = generateIsGcodeWithReport(profile, filament, spec)
  const lines = report.gcode.split('\n')

  it('emits a header, start gcode, and relative extrusion setup', () => {
    expect(lines[0]).toBe('; ScanNTune input shaper resonance test')
    expect(lines[1]).toBe('; speed tiers 90, 150 mm/s, acceleration 3000 mm/s^2')
    expect(report.gcode).toContain('M83')
    expect(report.gcode).toContain('G90')
  })

  it('sets the ceiling, the profile acceleration, the speed factor and the profile corner limit before any extrusion', () => {
    // VELOCITY raises the ceiling to the fastest commanded move (the 150 mm/s tier and
    // travel speed here), so a low configured maximum can never clamp a commanded feed; the
    // corner limit starts at the profile's own 5 mm/s square corner velocity.
    const limit = lines.indexOf('SET_VELOCITY_LIMIT VELOCITY=150 ACCEL=3000 MINIMUM_CRUISE_RATIO=0')
    expect(limit).toBeGreaterThan(0)
    expect(lines.slice(limit, limit + 3)).toEqual([
      'SET_VELOCITY_LIMIT VELOCITY=150 ACCEL=3000 MINIMUM_CRUISE_RATIO=0',
      'M220 S100',
      'SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=5',
    ])
    expect(limit + 2).toBeLessThan(firstExtrusionIndex(lines))
  })

  it('disables input shaping and pressure advance before any extrusion', () => {
    const shaper = lines.indexOf('SET_INPUT_SHAPER SHAPER_FREQ_X=0 SHAPER_FREQ_Y=0')
    const pa = lines.indexOf('SET_PRESSURE_ADVANCE ADVANCE=0')
    const first = firstExtrusionIndex(lines)
    expect(shaper).toBeGreaterThan(0)
    expect(pa).toBeGreaterThan(0)
    expect(shaper).toBeLessThan(first)
    expect(pa).toBeLessThan(first)
  })

  it('places the restore comments after the last extrusion', () => {
    const last = lastExtrusionIndex(lines)
    const shaper = lines.findIndex((l) => l.includes('input shaping resumes'))
    const pa = lines.findIndex((l) => l.includes('pressure advance resumes'))
    expect(shaper).toBeGreaterThan(last)
    expect(pa).toBeGreaterThan(last)
  })

  it('replaces the numeric motion limit restore with the firmware restart note', () => {
    // The velocity ceiling and acceleration are set once; nothing re-applies a motion limit
    // after the last extrusion, the restart note does.
    expect(lines.filter((l) => l.startsWith('SET_VELOCITY_LIMIT VELOCITY='))).toHaveLength(1)
    expect(
      lines.slice(lastExtrusionIndex(lines)).some((l) => l.startsWith('SET_VELOCITY_LIMIT')),
    ).toBe(false)
    const note = lines.indexOf('; run FIRMWARE_RESTART to restore your configured motion limits')
    expect(note).toBeGreaterThan(lastExtrusionIndex(lines))
    // The old separate MINIMUM_CRUISE_RATIO note is folded into the restart note.
    expect(report.gcode).not.toContain('MINIMUM_CRUISE_RATIO resumes')
  })

  it('never pauses (single color print)', () => {
    expect(report.gcode).not.toContain('PAUSE')
  })

  it('prints one pedestal layer and one measured layer', () => {
    const zMoves = lines.filter((l) => l.startsWith('G1 Z'))
    const zs = [...new Set(zMoves.map((l) => l.match(/Z([\d.]+)/)![1]))]
    expect(PEDESTAL_LAYERS + IS_MEASURED_LAYERS).toBe(2)
    expect(zs).toEqual(['0.200', '0.400', '10'])
  })

  it('names the corner-speed excitation ladder in the header', () => {
    expect(lines[2]).toBe(
      '; corner-speed excitation ladder 20 to 40.21 mm/s across the 4 lines of each tier, ' +
        'fastest corners printed last',
    )
  })

  it('cruises each run-up at its own ladder rung (hand-pinned bottom-dense feeds)', () => {
    // Hand-derived once, times 60 and rounded: both tiers share the bottom rungs
    // 20 * (25.5 / 20)^(j/2) mm/s for j = 0..2; above them the 90 mm/s tier prints
    // 25.5 * (90 / 25.5)^(1/3) and the 150 mm/s tier 25.5 * (100 / 25.5)^(1/3).
    const expectedFeeds: Record<number, number[]> = {
      90: [1200, 1355, 1530, 2329],
      150: [1200, 1355, 1530, 2413],
    }
    const chunk = measuredChunk(lines)
    for (const group of g.groups) {
      group.lines.forEach((line, j) => {
        const idx = chunk.indexOf(cornerMoveStr(line))
        expect(idx, `line ${j}`).toBeGreaterThanOrEqual(0)
        const feed = expectedFeeds[line.speedMmS][line.rungIndex]
        expect(chunk[idx].endsWith(`F${feed}`), `line ${j}`).toBe(true)
      })
    }
  })

  it('prints the lines rung by rung, so the corner feeds never fall within a layer', () => {
    // The run-up cruise into each corner is the move ending on the corner; its feed is the
    // rung. In print order the feeds rise from F1200 to F2413 and never fall: the 90 mm/s
    // tier's F2329 top rungs come just before the line speed tier's F2413 ones.
    const chunk = measuredChunk(lines)
    const cornerFeeds = chunk
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => allLines.some((line) => l === cornerMoveStr(line)))
      .map(({ l }) => Number(l.match(/F(\d+)$/)![1]))
    expect(cornerFeeds).toHaveLength(16)
    expect(cornerFeeds).toEqual([...cornerFeeds].sort((a, b) => a - b))
    expect(cornerFeeds.slice(-4)).toEqual([2329, 2329, 2413, 2413])
  })

  it("raises the corner limit to each line's own corner speed after its first stretch, and lowers it before the wipe", () => {
    // Raise values: each tier's rung feeds (see the run-up feed test) as mm/s, rounded up to
    // 3 decimals (hand-derived); lower value: the profile's 5 mm/s.
    const raise: Record<number, string[]> = {
      90: ['20', '22.584', '25.5', '38.817'],
      150: ['20', '22.584', '25.5', '40.217'],
    }
    const chunk = measuredChunk(lines)
    for (const line of allLines) {
      const idx = chunk.indexOf(cornerMoveStr(line))
      expect(chunk[idx - 1]).toBe(
        `SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=${raise[line.speedMmS][line.rungIndex]}`,
      )
      // The lower follows the coast's planner stop and precedes the wipe.
      const wipe = chunk.findIndex((l, i) => i > idx && /^G1 X.* E-/.test(l))
      expect(chunk.slice(wipe - 2, wipe)).toEqual([
        'G4 P0',
        'SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=5',
      ])
      expect(chunk[wipe - 3]).toMatch(/^G1 X[\d.]+ Y[\d.]+ F\d+$/)
    }
  })

  it('brings the planner to rest three times per line: before the travel, the first stretch and the wipe', () => {
    const chunk = measuredChunk(lines)
    expect(chunk.filter((l) => l === 'G4 P0')).toHaveLength(48)
    for (const line of allLines) {
      const idx = chunk.indexOf(cornerMoveStr(line))
      // Backwards from the corner: raise, first stretch, stop, un-retract, travel, stop.
      expect(chunk[idx - 3]).toBe('G4 P0')
      expect(chunk[idx - 5]).toMatch(/^G0 X/)
      expect(chunk[idx - 6]).toBe('G4 P0')
    }
  })

  it('cruises the run-up straight into every corner, continuous through it', () => {
    const chunk = measuredChunk(lines)
    for (const line of allLines) {
      const idx = chunk.indexOf(cornerMoveStr(line))
      expect(idx, `run-up cruise of the ${line.speedMmS} mm/s line`).toBeGreaterThanOrEqual(0)
      // The run-up extrudes at full flow at the line's own ladder rung feedrate and ends
      // exactly on the corner; there is no separate slow approach.
      expect(chunk[idx]).toMatch(new RegExp(`F${runUpFeed(line)}$`))
      // Continuous positive E through the corner: the first move after the corner
      // extrudes at full flow at the tier feedrate.
      const next = chunk[idx + 1]
      expect(next).toMatch(new RegExp(`^G1 X.* E[\\d.]+ F${line.speedMmS * 60}$`))
    }
  })

  it('un-retracts the full retraction standing still at each line start, then prints an ordinary bead', () => {
    // Hand-derived: the profile's 0.8 mm retraction at its 35 mm/s retract speed (F2100), then
    // the 3 mm first stretch carrying only its own bead at 30 mm/s (F1800): 3 x 0.03135430 =
    // 0.09406 mm for the 0.42 x 0.2 mm measured bead, 3 x 0.02157600 = 0.06473 mm for the
    // 0.3024 x 0.2 mm pedestal bead (the rounded bead cross-section over the 1.75 mm filament).
    const [pedestal, measured] = layerChunks(lines)
    const firstStretchEnds = allLines.map(
      (l) => `G1 X${(ox + l.prime.x1).toFixed(3)} Y${(oy + l.prime.y1).toFixed(3)} E`,
    )
    // Each first stretch with the two lines before it: the un-retract and the planner stop.
    const lineStarts = (chunk: string[]) =>
      chunk.flatMap((l, i) =>
        firstStretchEnds.some((p) => l.startsWith(p)) ? [[chunk[i - 2], chunk[i - 1], l.split(' E')[1]]] : [],
      )
    expect(lineStarts(pedestal)).toEqual(Array(16).fill(['G1 E0.800 F2100', 'G4 P0', '0.06473 F1800']))
    expect(lineStarts(measured)).toEqual(Array(16).fill(['G1 E0.800 F2100', 'G4 P0', '0.09406 F1800']))
  })

  it('runs each measured segment at its tier feedrate with full flow across the whole protected span', () => {
    const chunk = measuredChunk(lines)
    const fullE = ePerMm(nominal)
    for (const line of allLines) {
      const idx = chunk.indexOf(cornerMoveStr(line))
      const segs = walkLine(chunk, idx, ox + line.measured.x0, oy + line.measured.y0)
      const wipe = segs[segs.length - 1]
      expect(wipe.e).not.toBeNull()
      expect(wipe.e!).toBeLessThan(0)
      const body = segs.slice(0, -1)
      expect(body.length).toBeGreaterThan(0)
      for (const s of body) {
        expect(s.f, `feedrate of the ${line.speedMmS} mm/s line`).toBe(line.speedMmS * 60)
        const flow = (s.e ?? 0) / (s.len * fullE)
        // No E-rate change inside the protected span: any deviation from full flow
        // (crossing dips, ramps, the end-of-line coast) starts beyond it.
        if (s.startDist < line.protectedMm) {
          expect(flow, `flow at ${s.startDist.toFixed(1)} mm`).toBeCloseTo(1, 2)
        }
      }
    }
  })

  it('extrudes at full flow through every crossing so the beads weld into the grid', () => {
    const chunk = measuredChunk(lines)
    const fullE = ePerMm(nominal)
    for (const group of g.groups) {
      for (const line of group.lines) {
        const idx = chunk.indexOf(cornerMoveStr(line))
        const segs = walkLine(chunk, idx, ox + line.measured.x0, oy + line.measured.y0)
        // The only zero-E segment on a measured line is the standard end-of-line coast;
        // crossings introduce no flow dip and no extra subsegment splits.
        const zeros = segs.slice(0, -1).filter((s) => s.e === null)
        expect(zeros).toHaveLength(1)
        expect(zeros[0].startDist + zeros[0].len).toBeCloseTo(
          Math.hypot(line.tail.x1 - line.measured.x0, line.tail.y1 - line.measured.y0),
          1,
        )
        for (const s of segs.slice(0, -1)) {
          if (s.e === null) continue
          expect((s.e ?? 0) / (s.len * fullE)).toBeCloseTo(1, 2)
        }
      }
    }
    // Lines of both groups actually carry crossings (the rung-major order interleaves the
    // groups), all past the protected span.
    for (const group of g.groups) {
      expect(group.lines.some((l) => l.crossingsMm.length > 0)).toBe(true)
      for (const line of group.lines) {
        for (const c of line.crossingsMm) expect(c).toBeGreaterThan(line.protectedMm)
      }
    }
  })

  it('prints band perimeters, then the test lines, then the band raster on every layer', () => {
    for (const chunk of layerChunks(lines)) {
      // The first bare deretract restores pressure for the perimeter loops, the stationary
      // retract after them hands over to the test lines, and the first raster strip's bare
      // deretract follows the last line's wipe (its hop skips the retract because the lines
      // left the nozzle retracted).
      const { perimeterStart, linesStart, rasterStart } = phaseMarkers(chunk)
      expect(perimeterStart).toBeGreaterThanOrEqual(0)
      expect(linesStart).toBeGreaterThan(perimeterStart)
      expect(rasterStart).toBeGreaterThan(linesStart)
      // Perimeter extrusions actually exist between the deretract and the lines phase.
      expect(
        chunk.slice(perimeterStart + 1, linesStart).some((l) => /^G1 X.*E[\d.]/.test(l)),
      ).toBe(true)
      for (const line of allLines) {
        // The corner point is the endpoint of the run-up move only; the pedestal layer
        // caps the run-up feedrate, so match by coordinates alone.
        const coords = cornerMoveStr(line).split(' E')[0]
        const idx = chunk.findIndex((l) => l.startsWith(coords))
        expect(idx).toBeGreaterThan(linesStart)
        expect(idx).toBeLessThan(rasterStart)
      }
    }
  })

  it('zeroes the band flow where its passes cross the through-band leg stretches', () => {
    const legs = allLines.map((l) => ({
      x0: ox + l.prime.x0,
      y0: oy + l.prime.y0,
      x1: ox + l.runUp.x1,
      y1: oy + l.runUp.y1,
    }))
    const distToLeg = (px: number, py: number) =>
      Math.min(
        ...legs.map((s) => {
          const dx = s.x1 - s.x0
          const dy = s.y1 - s.y0
          const t = Math.max(
            0,
            Math.min(1, ((px - s.x0) * dx + (py - s.y0) * dy) / (dx * dx + dy * dy)),
          )
          return Math.hypot(px - (s.x0 + t * dx), py - (s.y0 + t * dy))
        }),
      )
    const yGroup = g.groups.find((grp) => grp.axis === 'y')!
    const xGroup = g.groups.find((grp) => grp.axis === 'x')!
    for (const chunk of layerChunks(lines)) {
      const bandStart = chunk.findIndex((l) => /^G1 E[\d.]/.test(l))
      const stop = chunk.findIndex((l) => l.includes('resumes'))
      const end = stop === -1 ? chunk.length : stop
      let x = NaN
      let y = NaN
      let nearY = 0
      let nearX = 0
      for (let i = 0; i < end; i++) {
        const m = chunk[i].match(/^G([01]) X(-?[\d.]+) Y(-?[\d.]+)(?: E-?[\d.]+)?(?: F\d+)?$/)
        if (!m) continue
        const nx = Number(m[2])
        const ny = Number(m[3])
        if (i > bandStart && m[1] === '1' && !chunk[i].includes('E') && !Number.isNaN(x)) {
          const mx = (x + nx) / 2
          const my = (y + ny) / 2
          if (distToLeg(mx, my) < 0.5) {
            if (my < oy + g.windowBox.y0) nearY++
            if (mx > ox + g.windowBox.x1) nearX++
          }
        }
        x = nx
        y = ny
      }
      // Every leg is crossed several times per layer (window perimeter loops plus the
      // raster), in the bottom band for the Y legs and the right band for the X legs.
      expect(nearY).toBeGreaterThanOrEqual(yGroup.lines.length * 2)
      expect(nearX).toBeGreaterThanOrEqual(xGroup.lines.length * 2)
    }
  })

  it('keeps the fan off on the pedestal layer and runs it at full for the measured lines only', () => {
    const zIndexes = lines.flatMap((l, i) => (/^G1 Z0\./.test(l) ? [i] : []))
    for (let k = 0; k < zIndexes.length; k++) {
      const pedestal = /^G1 Z0\.200\b/.test(lines[zIndexes[k]])
      const chunk = lines.slice(zIndexes[k] + 1, zIndexes[k + 1] ?? lines.length)
      const on = chunk.indexOf('M106 S255')
      if (pedestal) {
        expect(on).toBe(-1)
        continue
      }
      const off = chunk.indexOf('M107')
      // Phase markers as in the layer-order test: the fan turns on after the band
      // perimeters (which print with the fan off, like the raster) and off before the
      // raster starts.
      const { linesStart, rasterStart } = phaseMarkers(chunk)
      const firstCorner = Math.min(...allLines.map((l) => chunk.indexOf(cornerMoveStr(l))))
      expect(on).toBeGreaterThanOrEqual(linesStart)
      expect(on).toBeLessThan(firstCorner)
      expect(off).toBeGreaterThan(on)
      expect(off).toBeLessThan(rasterStart)
    }
  })

  it('extrudes a decel tail scaling with speed squared, then coasts and wipe-retracts', () => {
    const chunk = measuredChunk(lines)
    const coastMm = 1.5 * profile.nozzleDiameterMm
    for (const line of allLines) {
      const idx = chunk.indexOf(cornerMoveStr(line))
      const segs = walkLine(chunk, idx, ox + line.measured.x0, oy + line.measured.y0)
      const wipe = segs[segs.length - 1]
      const endCoast = segs[segs.length - 2]
      const tailExtrude = segs[segs.length - 3]
      // Tail length past the weld: the full kinematic stopping distance plus the margin.
      const tailLen = line.speedMmS ** 2 / (2 * fitted.accelMmS2) + 1
      expect(tailExtrude.e).not.toBeNull()
      expect(tailExtrude.len).toBeCloseTo(tailLen - coastMm, 2)
      expect(endCoast.e).toBeNull()
      expect(endCoast.len).toBeCloseTo(coastMm, 2)
      expect(wipe.e!).toBeCloseTo(-profile.retractMm, 3)
    }
  })

  it('never travels across the open window or a fiducial hole without retracting first', () => {
    // Any length counts: a primed nozzle strings a film across an opening however short the
    // hop. The window and the hole boxes are the coupon's own open areas.
    const open = [
      {
        x0: ox + g.windowBox.x0,
        y0: oy + g.windowBox.y0,
        x1: ox + g.windowBox.x1,
        y1: oy + g.windowBox.y1,
      },
      ...holeBoxesOf(g, ox, oy),
    ]
    const primed = primedTravelsAcross(lines, open)
    expect(primed, primed.join('\n')).toEqual([])
    // The scan is not vacuous: retracted travels across the window do occur.
    expect(retractedTravelsAcross(lines, open)).toBeGreaterThan(0)
  })

  it('keeps every coordinate on the bed and inside the coupon footprint', () => {
    for (const m of report.gcode.matchAll(/^G[01] X(-?[\d.]+) Y(-?[\d.]+)/gm)) {
      expect(Number(m[1])).toBeGreaterThanOrEqual(0)
      expect(Number(m[1])).toBeLessThanOrEqual(profile.bedWidthMm)
      expect(Number(m[2])).toBeGreaterThanOrEqual(0)
      expect(Number(m[2])).toBeLessThanOrEqual(profile.bedDepthMm)
    }
    const moves = [...report.gcode.matchAll(/^G1 X(-?[\d.]+) Y(-?[\d.]+) E[\d.]/gm)]
    for (const m of moves) {
      expect(Number(m[1])).toBeGreaterThanOrEqual(ox - 0.001)
      expect(Number(m[1])).toBeLessThanOrEqual(ox + g.couponWidthMm + 0.001)
      expect(Number(m[2])).toBeGreaterThanOrEqual(oy - 0.001)
      expect(Number(m[2])).toBeLessThanOrEqual(oy + g.couponHeightMm + 0.001)
    }
  })

  it('warns on a high-flow 200 mm/s tier instead of capping the speed', () => {
    const fast = generateIsGcodeWithReport(profile, filament, {
      ...spec,
      speedsMmS: [150, 200],
    })
    // 200 mm/s x 0.07541592 mm^2 (the 0.42 x 0.2 mm rounded bead) = 15.08 mm^3/s, hand-derived.
    expect(fast.warnings).toContain(
      "Lower the 200 mm/s line speed, or raise the filament's max volumetric flow only if the " +
        'hotend can melt 15.1 mm^3/s. Above the 12 mm^3/s a typical hotend melts, the lines ' +
        'under-extrude.',
    )
    expect(fast.gcode).toContain('F12000')
  })

  it('warns once, at the line speed, when both speed tiers exceed the flow limit', () => {
    // A 5 mm^3/s filament limit sits below both default tiers: 90 x 0.07541592 mm^2 = 6.79 and
    // 150 x 0.07541592 mm^2 = 11.31 mm^3/s (the 0.42 x 0.2 mm rounded bead), hand-derived.
    const weak = { ...filament, maxVolumetricFlowMm3S: 5 }
    const flowWarnings = generateIsGcodeWithReport(profile, weak, spec).warnings.filter((w) =>
      w.includes('mm^3/s'),
    )
    expect(flowWarnings).toEqual([
      "Lower the 150 mm/s line speed, or raise the filament's max volumetric flow only if the " +
        "hotend can melt 11.3 mm^3/s. Above the filament's 5 mm^3/s max volumetric flow, the " +
        'lines under-extrude.',
    ])
  })
})

describe('contrastBase', () => {
  const baseSpec = { ...spec, contrastBase: true }
  const report = generateIsGcodeWithReport(profile, filament, baseSpec)
  const lines = report.gcode.split('\n')
  const pauseIndex = lines.indexOf('PAUSE')

  /** Coupon layer chunks after the pause: the pedestal and the measured layer. */
  function chunksAfterPause(): string[][] {
    const zIndexes = lines.flatMap((l, i) =>
      i > pauseIndex && /^G1 Z0\./.test(l) ? [i] : [],
    )
    return zIndexes.map((z, k) => lines.slice(z + 1, zIndexes[k + 1] ?? lines.length))
  }

  it('emits the pause gcode only when contrastBase is set', () => {
    expect(pauseIndex).toBeGreaterThan(0)
    expect(report.gcode).toContain('; if your pause macro already retracts')
    const plain = generateIsGcodeWithReport(profile, filament, spec)
    expect(plain.gcode).not.toContain('PAUSE')
    expect(plain.gcode).not.toContain('; if your pause macro already retracts')
  })

  it('brackets the pause with a retract and an unretract', () => {
    expect(lines[pauseIndex - 1]).toMatch(/^G1 E-/)
    expect(lines[pauseIndex + 1]).toBe(
      '; if your pause macro already retracts, set retractMm to 0 in the profile',
    )
    expect(lines[pauseIndex + 2]).toMatch(/^G1 E[^-]/)
  })

  it('prints two solid base layers under the full footprint, window included, before the pause', () => {
    const preZs = [
      ...new Set(
        lines
          .slice(0, pauseIndex)
          .filter((l) => l.startsWith('G1 Z'))
          .map((l) => l.match(/Z([\d.]+)/)![1]),
      ),
    ]
    expect(preZs).toEqual(['0.200', '0.400'])
    // The base backs the open window: some base extrusion midpoint lies inside it.
    const win = {
      x0: ox + g.windowBox.x0,
      y0: oy + g.windowBox.y0,
      x1: ox + g.windowBox.x1,
      y1: oy + g.windowBox.y1,
    }
    let x = 0
    let y = 0
    let inWindow = false
    for (const l of lines.slice(0, pauseIndex)) {
      const m = l.match(/^G([01]) X(-?[\d.]+) Y(-?[\d.]+)/)
      if (!m) continue
      const nx = Number(m[2])
      const ny = Number(m[3])
      if (m[1] === '1' && /E[\d.]/.test(l)) {
        const mx = (x + nx) / 2
        const my = (y + ny) / 2
        if (mx > win.x0 && mx < win.x1 && my > win.y0 && my < win.y1) inWindow = true
      }
      x = nx
      y = ny
    }
    expect(inWindow).toBe(true)
  })

  it('keeps the fiducial hole boxes free of extrusion on the base layers', () => {
    const holeBoxes = g.fiducials.map((f) => ({
      x0: ox + f.xMm - g.fiducialSizeMm / 2,
      y0: oy + f.yMm - g.fiducialSizeMm / 2,
      x1: ox + f.xMm + g.fiducialSizeMm / 2,
      y1: oy + f.yMm + g.fiducialSizeMm / 2,
    }))
    const crossesHole = (x0: number, y0: number, x1: number, y1: number) => {
      // Sample the segment densely; the hole boxes are 5 mm, so 0.5 mm steps cannot skip one.
      const len = Math.hypot(x1 - x0, y1 - y0)
      const n = Math.max(2, Math.ceil(len / 0.5))
      for (let k = 0; k <= n; k++) {
        const px = x0 + ((x1 - x0) * k) / n
        const py = y0 + ((y1 - y0) * k) / n
        for (const b of holeBoxes) {
          if (px > b.x0 && px < b.x1 && py > b.y0 && py < b.y1) return true
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
        expect(crossesHole(x, y, nx, ny), `extrusion through a fiducial hole: ${l}`).toBe(false)
      }
      x = nx
      y = ny
    }
  })

  it('never travels across an open fiducial hole while primed, base layers included', () => {
    // The base backs the window, so on the base layers only the holes are open; above the
    // base the window is open too. The base raster's approach once crossed a hole primed.
    const holes = holeBoxesOf(g, ox, oy)
    const window = {
      x0: ox + g.windowBox.x0,
      y0: oy + g.windowBox.y0,
      x1: ox + g.windowBox.x1,
      y1: oy + g.windowBox.y1,
    }
    const base = primedTravelsAcross(lines.slice(0, pauseIndex), holes)
    expect(base, base.join('\n')).toEqual([])
    const coupon = primedTravelsAcross(lines.slice(pauseIndex), [...holes, window])
    expect(coupon, coupon.join('\n')).toEqual([])
    expect(retractedTravelsAcross(lines.slice(0, pauseIndex), holes)).toBeGreaterThan(0)
  })

  it('shifts the pedestal and measured layers up by the two base layers', () => {
    const zMoves = lines.filter((l) => l.startsWith('G1 Z'))
    const zs = [...new Set(zMoves.map((l) => l.match(/Z([\d.]+)/)![1]))]
    expect(zs).toEqual(['0.200', '0.400', '0.600', '0.800', '10'])
  })

  it('keeps the perimeters-lines-raster order on the shifted coupon layers', () => {
    const chunks = chunksAfterPause()
    expect(chunks).toHaveLength(2)
    for (const chunk of chunks) {
      const { perimeterStart, linesStart, rasterStart } = phaseMarkers(chunk)
      expect(perimeterStart).toBeGreaterThanOrEqual(0)
      expect(linesStart).toBeGreaterThan(perimeterStart)
      expect(rasterStart).toBeGreaterThan(linesStart)
      for (const line of allLines) {
        const coords = cornerMoveStr(line).split(' E')[0]
        const idx = chunk.findIndex((l) => l.startsWith(coords))
        expect(idx).toBeGreaterThan(linesStart)
        expect(idx).toBeLessThan(rasterStart)
      }
    }
  })

  it('keeps the fan off on the base and pedestal and at full for the measured lines only', () => {
    expect(lines.slice(0, pauseIndex)).not.toContain('M106 S255')
    const [pedestal, measured] = chunksAfterPause()
    expect(pedestal).not.toContain('M106 S255')
    const on = measured.indexOf('M106 S255')
    const off = measured.indexOf('M107')
    expect(on).toBeGreaterThanOrEqual(0)
    expect(off).toBeGreaterThan(on)
  })

  it('keeps every coordinate on the bed and inside the coupon footprint', () => {
    const moves = [...report.gcode.matchAll(/^G1 X(-?[\d.]+) Y(-?[\d.]+) E[\d.]/gm)]
    expect(moves.length).toBeGreaterThan(0)
    for (const m of moves) {
      expect(Number(m[1])).toBeGreaterThanOrEqual(ox - 0.001)
      expect(Number(m[1])).toBeLessThanOrEqual(ox + g.couponWidthMm + 0.001)
      expect(Number(m[2])).toBeGreaterThanOrEqual(oy - 0.001)
      expect(Number(m[2])).toBeLessThanOrEqual(oy + g.couponHeightMm + 0.001)
    }
  })

  it('reports pause gcode placeholders only with a contrast base', () => {
    const weird: PrinterProfile = { ...profile, pauseGcode: 'M600 S[not_a_real_variable]' }
    const withBase = generateIsGcodeWithReport(weird, filament, baseSpec)
    expect(withBase.unknownVariables).toContain('not_a_real_variable')
    const plain = generateIsGcodeWithReport(weird, filament, spec)
    expect(plain.unknownVariables).not.toContain('not_a_real_variable')
  })
})

describe('bed fitting', () => {
  it('drops the derived 90 mm/s tier with a note when the coupon overflows an 80 mm bed', () => {
    const small: PrinterProfile = { ...profile, bedWidthMm: 80, bedDepthMm: 80 }
    const r = generateIsGcodeWithReport(small, filament, spec)
    expect(r.warnings.some((w) => w.includes('90 mm/s') && w.includes('removed'))).toBe(true)
    // Only the 150 mm/s line feed remains on the measured lines.
    expect(r.gcode).not.toMatch(/^G1 X.* E[\d.]+ F5400$/m)
    expect(r.gcode).toMatch(/^G1 X.* E[\d.]+ F9000$/m)
  })

  it('generates a front-placed coupon that ends inside the far edge of a 110 mm bed', () => {
    const bed110: PrinterProfile = { ...profile, bedWidthMm: 110, bedDepthMm: 110 }
    const r = generateIsGcodeWithReport(bed110, filament, { ...spec, placement: 'front' })
    expect(r.warnings).toContain(
      'The measured lines were shortened from 30 mm to 25 mm so the coupon fits the configured bed.',
    )
    const ys = [...r.gcode.matchAll(/^G[01] X(-?[\d.]+) Y(-?[\d.]+)/gm)].map((m) => Number(m[2]))
    // The four-line 99.283 mm coupon starts at the 10 mm front margin and ends at 109.283 mm.
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(10)
    expect(Math.max(...ys)).toBeLessThanOrEqual(109.283 + 0.001)
  })

  it('throws when even the smallest coupon overflows the bed', () => {
    const tiny: PrinterProfile = { ...profile, bedWidthMm: 70, bedDepthMm: 70 }
    expect(() => generateIsGcodeWithReport(tiny, filament, spec)).toThrow(/fit/i)
  })
})

describe('validation and reporting', () => {
  it('propagates the spec validation throws', () => {
    expect(() => generateIsGcodeWithReport(profile, filament, { ...spec, axes: [] })).toThrow(
      /axis/i,
    )
    expect(() =>
      generateIsGcodeWithReport(profile, filament, { ...spec, speedsMmS: [] }),
    ).toThrow(/speed tiers/i)
  })

  it('prints one tier, with the note, when the line speed is too slow for two', () => {
    // The tiers of a 33 mm/s line speed are 19 and 33 mm/s; the 19 mm/s tier is below the
    // 20 mm/s bottom rung, so the coupon prints the 33 mm/s tier alone. Lines this slow follow
    // ringing only on a well damped frame, here 0.2; at the 0.03 design damping the request is
    // refused.
    const r = generateIsGcodeWithReport(profile, filament, {
      ...spec,
      followabilityDampingRatio: 0.2,
      cornerSpeedMmS: 20,
      speedsMmS: [19, 33],
    })
    expect(r.gcode.split('\n')[1]).toBe('; speed tiers 33 mm/s, acceleration 3000 mm/s^2')
    expect(r.warnings).toContain(
      'The 19 mm/s speed tier was removed because it is slower than the 20 mm/s lowest corner ' +
        'speed. With one speed tier, the analysis cannot tell print and scan patterns apart from ' +
        'ringing. Raise the line speed to at least 34 mm/s to keep both speed tiers.',
    )
  })

  it('reports unknown slicer variables from the start gcode', () => {
    const weird: PrinterProfile = { ...profile, startGcode: 'M104 S[not_a_real_variable]' }
    const r = generateIsGcodeWithReport(weird, filament, spec)
    expect(r.unknownVariables).toContain('not_a_real_variable')
  })

  it('warns when the start gcode sets no temperatures', () => {
    const cold: PrinterProfile = { ...profile, startGcode: 'G28' }
    const r = generateIsGcodeWithReport(cold, filament, spec)
    expect(r.warnings.some((w) => w.includes('sets no temperatures'))).toBe(true)
  })

  it('matches the same generation with placement and contrastBase set to their defaults', () => {
    const explicit = { ...spec, placement: 'center' as const, contrastBase: false }
    const r = generateIsGcodeWithReport(profile, filament, explicit)
    expect(r.gcode).toBe(generateIsGcodeWithReport(profile, filament, spec).gcode)
  })

  it('uses the profile acceleration without an upper cap', () => {
    const fast: PrinterProfile = { ...profile, printAccelMmS2: 20000 }
    const spec20k = defaultIsTestRequest(fast)
    expect(spec20k.accelMmS2).toBe(20000)
    const gcode = generateIsGcodeWithReport(fast, filament, spec20k).gcode
    expect(gcode).toContain('SET_VELOCITY_LIMIT VELOCITY=150 ACCEL=20000 MINIMUM_CRUISE_RATIO=0')
  })
})

describe('default G-code snapshot', () => {
  it('leaves the default G-code byte-identical to the pinned snapshot', () => {
    const fixture = readFileSync(
      join(__dirname, '../../fixtures/is_default.gcode'),
      'utf8',
    )
    expect(generateIsGcodeWithReport(profile, filament, spec).gcode).toBe(fixture)
  })
})

describe('filament flow settings', () => {
  it('scales every extrusion by the filament extrusion multiplier', () => {
    const rich = { ...filament, extrusionMultiplier: 1.2 }
    const gcode = generateIsGcodeWithReport(profile, rich, spec).gcode
    const line = allLines[0]
    const scaled =
      `G1 X${(ox + line.measured.x0).toFixed(3)} Y${(oy + line.measured.y0).toFixed(3)} ` +
      `E${(runUpLen(line) * ePerMm(nominal) * 1.2).toFixed(5)} F${runUpFeed(line)}`
    expect(gcode).toContain(scaled)
  })

  it('judges the high-flow warning against the filament limit when configured', () => {
    // A 170 mm/s tier extrudes 170 x 0.07541592 mm^2 (the 0.42 x 0.2 mm rounded bead) =
    // 12.82 mm^3/s: above the 12 default, below a 20 limit. The default 150 mm/s tier
    // (11.31 mm^3/s) stays under the 12 default.
    const fast = { ...spec, speedsMmS: [170] }
    expect(
      generateIsGcodeWithReport(profile, filament, spec).warnings.some((w) =>
        w.includes('mm^3/s'),
      ),
    ).toBe(false)
    expect(
      generateIsGcodeWithReport(profile, filament, fast).warnings.some((w) =>
        w.includes('typical hotend'),
      ),
    ).toBe(true)
    const strong = { ...filament, maxVolumetricFlowMm3S: 20 }
    expect(
      generateIsGcodeWithReport(profile, strong, fast).warnings.some((w) =>
        w.includes('mm^3/s'),
      ),
    ).toBe(false)
    const weak = { ...filament, maxVolumetricFlowMm3S: 10 }
    expect(
      generateIsGcodeWithReport(profile, weak, fast).warnings.some((w) =>
        w.includes("filament's 10 mm^3/s max volumetric flow"),
      ),
    ).toBe(true)
  })

  it('judges the flow of the bead it commands, extrusion multiplier included', () => {
    // 11.31 mm^3/s at a 1.0 multiplier sits under a 13 mm^3/s filament limit; a 1.2
    // multiplier lifts the commanded bead to 13.57 mm^3/s (hand-derived), past it.
    const limited = { ...filament, maxVolumetricFlowMm3S: 13 }
    expect(
      generateIsGcodeWithReport(profile, limited, spec).warnings.some((w) => w.includes('mm^3/s')),
    ).toBe(false)
    expect(
      generateIsGcodeWithReport(profile, { ...limited, extrusionMultiplier: 1.2 }, spec).warnings,
    ).toContain(
      "Lower the 150 mm/s line speed, or raise the filament's max volumetric flow only if the " +
        "hotend can melt 13.6 mm^3/s. Above the filament's 13 mm^3/s max volumetric flow, the " +
        'lines under-extrude.',
    )
  })
})

describe('first layer speed', () => {
  const firstLayerFeed = profile.firstLayerSpeedMmS * 60

  it('prints the whole first coupon layer at the profile first layer speed', () => {
    const report = generateIsGcodeWithReport(profile, filament, spec)
    const chunks = layerChunks(report.gcode.split('\n'))
    const feedsOf = (chunk: string[]) =>
      chunk
        .map((l) => l.match(/^G1 X.*E[\d.]+ F(\d+)$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => Number(m[1]))
    // Layer 1: the first layer speed caps every printing move; the ladder's slowest
    // run-up rungs legitimately cruise below the cap.
    const feeds = feedsOf(chunks[0])
    expect(feeds.every((f) => f <= firstLayerFeed)).toBe(true)
    expect(feeds.some((f) => f === firstLayerFeed)).toBe(true)
    // The measured layer keeps its normal speeds.
    expect(feedsOf(chunks[chunks.length - 1]).some((f) => f > firstLayerFeed)).toBe(true)
  })

  it('caps the first stretch of every pedestal line at the first layer speed', () => {
    // A 20 mm/s first layer speed caps the 30 mm/s first stretch to F1200 on the pedestal
    // layer; the measured layer keeps F1800. Hand-derived feeds.
    const slowFirst: PrinterProfile = { ...profile, firstLayerSpeedMmS: 20 }
    const chunks = layerChunks(generateIsGcodeWithReport(slowFirst, filament, spec).gcode.split('\n'))
    // A first stretch ends where the line's prime segment ends; its feed is the last field.
    const primeEnds = allLines.map(
      (l) => `G1 X${(ox + l.prime.x1).toFixed(3)} Y${(oy + l.prime.y1).toFixed(3)} E`,
    )
    const primeFeeds = (chunk: string[]) =>
      chunk
        .filter((l) => primeEnds.some((p) => l.startsWith(p)))
        .map((l) => Number(l.match(/ F(\d+)$/)![1]))
    const pedestalPrimes = primeFeeds(chunks[0])
    const measuredPrimes = primeFeeds(chunks[chunks.length - 1])
    // One first stretch per test line on each layer: eight lines per axis, both axes.
    expect(pedestalPrimes).toEqual(Array(16).fill(1200))
    expect(measuredPrimes).toEqual(Array(16).fill(1800))
  })

  it('caps only the base first layer when a contrast base is printed', () => {
    const report = generateIsGcodeWithReport(profile, filament, { ...spec, contrastBase: true })
    const chunks = layerChunks(report.gcode.split('\n'))
    const feedsOf = (chunk: string[]) =>
      chunk
        .map((l) => l.match(/^G1 X.*E[\d.]+ F(\d+)$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => Number(m[1]))
    expect(feedsOf(chunks[0]).every((f) => f === firstLayerFeed)).toBe(true)
    // The second base layer runs at the normal raster speed again.
    expect(feedsOf(chunks[1]).some((f) => f > firstLayerFeed)).toBe(true)
  })
})
