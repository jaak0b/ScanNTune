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
import {
  isCouponGeometry,
  type IsLine,
} from '../../../src/engine/is/couponGeometry'

import { defaultIsTestSpec } from '../../../src/engine/is/types'
import {
  generateIsGcodeWithReport,
  IS_MEASURED_LAYERS,
} from '../../../src/engine/is/gcodeGenerator'

const profile = defaultPrinterProfile()
const filament = defaultFilamentProfile()
const spec = defaultIsTestSpec(profile)
const nominal = profile.nozzleDiameterMm * NOMINAL_WIDTH_FACTOR
const g = isCouponGeometry(spec)
const ox = (profile.bedWidthMm - g.couponWidthMm) / 2
const oy = (profile.bedDepthMm - g.couponHeightMm) / 2
const runUpFeed = spec.cornerSpeedMmS * 60
const allLines = g.groups.flatMap((grp) => grp.lines)

const ePerMm = (w: number) =>
  extrusionMm(1, w, profile.layerHeightMm, filament.filamentDiameterMm)

const runUpLen = (line: IsLine) =>
  Math.hypot(line.runUp.x1 - line.runUp.x0, line.runUp.y1 - line.runUp.y0)

/** The full-flow run-up cruise move, ending exactly on the line's ringing corner. */
const cornerMoveStr = (line: IsLine) =>
  `G1 X${(ox + line.measured.x0).toFixed(3)} Y${(oy + line.measured.y0).toFixed(3)} ` +
  `E${(runUpLen(line) * ePerMm(nominal)).toFixed(5)} F${runUpFeed}`

const firstExtrusionIndex = (lines: string[]) => lines.findIndex((l) => /^G1 .*E-?[\d.]/.test(l))
// The last printing move; the final retract (a bare G1 E-) sits after the restore block.
const lastExtrusionIndex = (lines: string[]) => {
  for (let i = lines.length - 1; i >= 0; i--) if (/^G1 X.*E[\d.]/.test(lines[i])) return i
  return -1
}

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

interface Seg {
  len: number
  e: number | null
  f: number
  startDist: number
}

/** Walk the printing moves of one test line from its corner up to and including the wipe. */
function walkLine(chunk: string[], cornerIdx: number, cx: number, cy: number): Seg[] {
  const segs: Seg[] = []
  let x = cx
  let y = cy
  let dist = 0
  for (let i = cornerIdx + 1; i < chunk.length; i++) {
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
    expect(lines[1]).toContain('speed tiers 150 mm/s')
    expect(report.gcode).toContain('M83')
    expect(report.gcode).toContain('G90')
  })

  it('sets the test motion limits with the raised corner velocity before any extrusion', () => {
    // VELOCITY raises the ceiling to the fastest commanded move (the 150 mm/s tier and
    // travel speed here), so a low configured maximum can never clamp a commanded feed.
    const limit = lines.indexOf(
      'SET_VELOCITY_LIMIT VELOCITY=150 ACCEL=4000 SQUARE_CORNER_VELOCITY=100 MINIMUM_CRUISE_RATIO=0',
    )
    expect(limit).toBeGreaterThan(0)
    expect(limit).toBeLessThan(firstExtrusionIndex(lines))
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
    // No profile values are re-applied: the only SET_VELOCITY_LIMIT is the test's own.
    const velocityLimits = lines.filter((l) => l.startsWith('SET_VELOCITY_LIMIT'))
    expect(velocityLimits).toHaveLength(1)
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

  it('cruises the run-up at the 100 mm/s corner speed straight into every corner, continuous through it', () => {
    const chunk = measuredChunk(lines)
    for (const line of allLines) {
      const idx = chunk.indexOf(cornerMoveStr(line))
      expect(idx, `run-up cruise of the ${line.speedMmS} mm/s line`).toBeGreaterThanOrEqual(0)
      // The run-up extrudes at full flow at the run-up feedrate (the square corner
      // velocity) and ends exactly on the corner; there is no separate slow approach.
      expect(chunk[idx]).toMatch(new RegExp(`F${runUpFeed}$`))
      // Continuous positive E through the corner: the first move after the corner
      // extrudes at full flow at the tier feedrate.
      const next = chunk[idx + 1]
      expect(next).toMatch(new RegExp(`^G1 X.* E[\\d.]+ F${line.speedMmS * 60}$`))
    }
  })

  it('primes on the move at the leg start instead of a stationary un-retract', () => {
    const chunk = measuredChunk(lines)
    for (const line of allLines) {
      const idx = chunk.indexOf(cornerMoveStr(line))
      // Backwards from the corner: moving prime, retracted travel.
      expect(chunk[idx - 1], `prime of the ${line.speedMmS} mm/s line`).toMatch(
        /^G1 X.* E[\d.]+ F1800$/,
      )
      expect(chunk[idx - 2]).toMatch(/^G0 X/)
      const primeE = Number(chunk[idx - 1].match(/E([\d.]+)/)![1])
      expect(primeE).toBeGreaterThan(profile.retractMm)
    }
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
    // The second-printed group actually carries crossings, all past the protected span.
    expect(g.groups[1].lines.every((l) => l.crossingsMm.length > 0)).toBe(true)
    for (const line of g.groups[1].lines) {
      for (const c of line.crossingsMm) expect(c).toBeGreaterThan(line.protectedMm)
    }
  })

  it('prints band perimeters, then the test lines, then the band raster on every layer', () => {
    for (const chunk of layerChunks(lines)) {
      // Bare deretracts mark the phase starts: the first restores pressure for the
      // perimeter loops, the second is the first raster strip's (its hop skips the
      // retract because the lines left the nozzle retracted).
      const deretracts = chunk.flatMap((l, i) => (/^G1 E[\d.]/.test(l) ? [i] : []))
      const perimeterStart = deretracts[0]
      // The stationary retract after the perimeters hands over to the test lines.
      const linesStart = chunk.findIndex((l, i) => i > perimeterStart && /^G1 E-/.test(l))
      const rasterStart = deretracts.find((i) => i > linesStart)!
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
      const deretracts = chunk.flatMap((l, i) => (/^G1 E[\d.]/.test(l) ? [i] : []))
      const linesStart = chunk.findIndex((l, i) => i > deretracts[0] && /^G1 E-/.test(l))
      const rasterStart = deretracts.find((i) => i > linesStart)!
      const firstCorner = chunk.indexOf(cornerMoveStr(allLines[0]))
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
      const tailLen = line.speedMmS ** 2 / (2 * spec.accelMmS2) + 1
      expect(tailExtrude.e).not.toBeNull()
      expect(tailExtrude.len).toBeCloseTo(tailLen - coastMm, 2)
      expect(endCoast.e).toBeNull()
      expect(endCoast.len).toBeCloseTo(coastMm, 2)
      expect(wipe.e!).toBeCloseTo(-profile.retractMm, 3)
    }
  })

  it('never travels far across the open window without retracting first', () => {
    // Window interior, shrunk a little so band-edge moves do not count.
    const win = {
      x0: ox + g.windowBox.x0 + 1,
      y0: oy + g.windowBox.y0 + 1,
      x1: ox + g.windowBox.x1 - 1,
      y1: oy + g.windowBox.y1 - 1,
    }
    const inWindow = (x: number, y: number) =>
      x > win.x0 && x < win.x1 && y > win.y0 && y < win.y1
    let x = 0
    let y = 0
    let retracted = false
    for (const l of lines) {
      // Both stationary retracts and the moving wipe/prime variants carry the E state.
      if (/^G1 .*E-/.test(l)) retracted = true
      else if (/^G1 .*E[\d.]/.test(l)) retracted = false
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
    expect(fast.warnings.some((w) => w.includes('200 mm/s') && w.includes('mm^3/s'))).toBe(true)
    expect(fast.gcode).toContain('F12000')
  })
})

describe('generateIsGcodeWithReport (Marlin and RepRapFirmware)', () => {
  it('uses Marlin commands for limits, disable, and restore', () => {
    const marlin: PrinterProfile = { ...profile, firmware: 'Marlin' }
    const gcode = generateIsGcodeWithReport(marlin, filament, spec).gcode
    expect(gcode).toContain('M203 X150 Y150') // velocity ceiling in mm/s
    expect(gcode).toContain('M204 P4000 T4000') // test limits
    // No numeric restore: the restart note replaces the profile-value block.
    expect(gcode).not.toContain('M204 P3000 T3000')
    expect(gcode).toContain('M205 X100 Y100')
    // Junction-deviation equivalent of the 100 mm/s corner speed, on its own line:
    // 0.4 * 100^2 / 4000 = 1.000 mm.
    expect(gcode).toContain(`M205 J${((0.4 * 100 * 100) / spec.accelMmS2).toFixed(3)}`)
    expect(gcode).toContain(
      '; restart the printer or run M501 to restore your configured motion limits',
    )
    expect(gcode).not.toContain('M205 J junction deviation resumes')
    expect(gcode).toContain('M593 F0')
    expect(gcode).toContain('M900 K0')
    expect(gcode).not.toContain('SET_VELOCITY_LIMIT')
  })

  it('uses RepRapFirmware commands for limits, disable, and restore', () => {
    const rrf: PrinterProfile = { ...profile, firmware: 'RepRapFirmware' }
    const gcode = generateIsGcodeWithReport(rrf, filament, spec).gcode
    expect(gcode).toContain('M203 X9000 Y9000') // velocity ceiling in mm/min
    expect(gcode).toContain('M204 P4000 T4000') // test limits
    // No numeric restore: the restart note replaces the profile-value block.
    expect(gcode).not.toContain('M204 P3000 T3000')
    // Per-axis jerk in mm/min: a 90 degree corner at 100 mm/s is a 100 mm/s per-axis
    // velocity change, 6000 mm/min.
    expect(gcode).toContain('M566 X6000 Y6000')
    expect(gcode).toContain(
      '; run M98 P"config.g" or restart the printer to restore your configured motion limits',
    )
    expect(gcode).toContain('M593 P"none"')
    expect(gcode).toContain('M572 D0 S0')
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

  it('shifts the pedestal and measured layers up by the two base layers', () => {
    const zMoves = lines.filter((l) => l.startsWith('G1 Z'))
    const zs = [...new Set(zMoves.map((l) => l.match(/Z([\d.]+)/)![1]))]
    expect(zs).toEqual(['0.200', '0.400', '0.600', '0.800', '10'])
  })

  it('keeps the perimeters-lines-raster order on the shifted coupon layers', () => {
    const chunks = chunksAfterPause()
    expect(chunks).toHaveLength(2)
    for (const chunk of chunks) {
      const deretracts = chunk.flatMap((l, i) => (/^G1 E[\d.]/.test(l) ? [i] : []))
      const perimeterStart = deretracts[0]
      const linesStart = chunk.findIndex((l, i) => i > perimeterStart && /^G1 E-/.test(l))
      const rasterStart = deretracts.find((i) => i > linesStart)!
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
  it('drops a 300 mm/s tier with a note when the coupon overflows a 160 mm bed', () => {
    const small: PrinterProfile = { ...profile, bedWidthMm: 160, bedDepthMm: 160 }
    const three = { ...spec, speedsMmS: [150, 200, 300] }
    const r = generateIsGcodeWithReport(small, filament, three)
    expect(r.warnings.some((w) => w.includes('300 mm/s') && w.includes('removed'))).toBe(true)
    expect(r.gcode).not.toContain('F18000')
    expect(r.gcode).toContain('F12000')
  })

  it('throws when even the smallest coupon overflows the bed', () => {
    const tiny: PrinterProfile = { ...profile, bedWidthMm: 70, bedDepthMm: 70 }
    expect(() => generateIsGcodeWithReport(tiny, filament, spec)).toThrow(/fit/i)
  })
})

describe('validation and reporting', () => {
  it('propagates the spec validation throws', () => {
    expect(() =>
      generateIsGcodeWithReport(profile, filament, { ...spec, linesPerSpeed: 1 }),
    ).toThrow(/lines per speed/i)
    expect(() => generateIsGcodeWithReport(profile, filament, { ...spec, axes: [] })).toThrow(
      /axis/i,
    )
    expect(() =>
      generateIsGcodeWithReport(profile, filament, { ...spec, speedsMmS: [] }),
    ).toThrow(/speed tiers/i)
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
    const spec20k = defaultIsTestSpec(fast)
    expect(spec20k.accelMmS2).toBe(20000)
    const gcode = generateIsGcodeWithReport(fast, filament, spec20k).gcode
    expect(gcode).toContain(
      'SET_VELOCITY_LIMIT VELOCITY=150 ACCEL=20000 SQUARE_CORNER_VELOCITY=100 MINIMUM_CRUISE_RATIO=0',
    )
  })
})

describe('resonant run-up sweep emission', () => {
  const sweepSpec = { ...spec, sweep: true }
  const gs = isCouponGeometry(sweepSpec, profile.squareCornerVelocityMmS)
  const oxs = (profile.bedWidthMm - gs.couponWidthMm) / 2
  const oys = (profile.bedDepthMm - gs.couponHeightMm) / 2
  const report = generateIsGcodeWithReport(profile, filament, sweepSpec)
  const lines = report.gcode.split('\n')

  it('announces the sweep in the preamble', () => {
    expect(report.gcode).toContain('; resonant run-up sweep 35 to 150 Hz over 16 cycles')
    // The sweep-off default stays silent about it.
    expect(generateIsGcodeWithReport(profile, filament, spec).gcode).not.toContain(
      'resonant run-up sweep',
    )
  })

  it('extrudes every chord at full flow with its own commanded feedrate', () => {
    const chunk = measuredChunk(lines)
    for (const group of gs.groups) {
      for (const line of group.lines) {
        for (const tooth of line.teeth) {
          const len = Math.hypot(tooth.x1 - tooth.x0, tooth.y1 - tooth.y0)
          const move =
            `G1 X${(oxs + tooth.x1).toFixed(3)} Y${(oys + tooth.y1).toFixed(3)} ` +
            `E${(len * ePerMm(nominal)).toFixed(5)} F${Math.round(tooth.speedMmS * 60)}`
          expect(chunk).toContain(move)
        }
      }
    }
  })

  it('scales the pedestal chords uniformly in time to the first layer cap', () => {
    // Same path as the measured layer, every chord slowed by the same hand-derived
    // factor: the 30 mm/s first layer cap over the 101.7426 mm/s peak chord (100 mm/s
    // forward with the 18.75 mm/s accel_per_hz swing peak), so even the fastest chord
    // obeys the cap.
    const scale = 0.2948616560802966
    const pedestal = layerChunks(lines)[0]
    for (const group of gs.groups) {
      for (const line of group.lines) {
        for (const tooth of line.teeth) {
          const len = Math.hypot(tooth.x1 - tooth.x0, tooth.y1 - tooth.y0)
          const move =
            `G1 X${(oxs + tooth.x1).toFixed(3)} Y${(oys + tooth.y1).toFixed(3)} ` +
            `E${(len * ePerMm(nominal * 0.72)).toFixed(5)} ` +
            `F${Math.round(tooth.speedMmS * scale * 60)}`
          expect(pedestal).toContain(move)
        }
      }
    }
    // No pedestal chord is commanded above the 30 mm/s first layer cap.
    const maxF = Math.max(
      ...gs.groups.flatMap((grp) =>
        grp.lines.flatMap((l) => l.teeth.map((t) => Math.round(t.speedMmS * scale * 60))),
      ),
    )
    expect(maxF).toBeLessThanOrEqual(1800)
  })

  it('emits motion limit lines byte-identical to the non-sweep test on every firmware', () => {
    // The launch-corner override alone covers the sweep: the chords never rely on a
    // sweep-driven limit change.
    const limits = (gcode: string) =>
      gcode.split('\n').filter((l) => /^(SET_VELOCITY_LIMIT|M204|M205|M566)/.test(l))
    for (const firmware of ['Klipper', 'Marlin', 'RepRapFirmware'] as const) {
      const p: PrinterProfile = { ...profile, firmware }
      expect(limits(generateIsGcodeWithReport(p, filament, sweepSpec).gcode)).toEqual(
        limits(generateIsGcodeWithReport(p, filament, spec).gcode),
      )
    }
  })

  it('leaves the non-sweep default G-code byte-identical to the pinned snapshot', () => {
    const fixture = readFileSync(
      join(__dirname, '../../fixtures/is_nonsweep_default.gcode'),
      'utf8',
    )
    expect(generateIsGcodeWithReport(profile, filament, spec).gcode).toBe(fixture)
  })

  it('raises the velocity ceiling to the sweep peak when it passes the tiers', () => {
    // At a 200 mm/s corner speed the sweep peaks at hypot(200, 18.75) = 200.88 mm/s,
    // above the 200 mm/s tier and the 150 mm/s travel speed, so the ceiling rounds up
    // to 201. The default sweep peaks at 101.74 mm/s and keeps the 150 mm/s ceiling,
    // even at a 20000 mm/s^2 profile acceleration (accel_per_hz governs the swing).
    const fast = generateIsGcodeWithReport(profile, filament, {
      ...sweepSpec,
      cornerSpeedMmS: 200,
      speedsMmS: [200],
    })
    expect(fast.gcode).toContain('VELOCITY=201 ACCEL=4000')
    expect(report.gcode).toContain('VELOCITY=150 ACCEL=4000')
    const hot = generateIsGcodeWithReport(profile, filament, { ...sweepSpec, accelMmS2: 20000 })
    expect(hot.gcode).toContain('VELOCITY=150 ACCEL=20000')
  })

  it('warns when the sweep peak flow passes the hotend limit, quiet at the default', () => {
    // At a 200 mm/s corner speed the sweep peaks at 200.88 mm/s: 16.9 mm^3/s, above the
    // 12 mm^3/s default limit. The default corner speed peaks at 101.74 mm/s
    // (8.5 mm^3/s) and stays quiet.
    const fast = generateIsGcodeWithReport(profile, filament, {
      ...sweepSpec,
      cornerSpeedMmS: 200,
      speedsMmS: [200],
    })
    expect(fast.warnings.some((w) => w.includes('resonance sweep peaks at 201 mm/s'))).toBe(true)
    expect(report.warnings.some((w) => w.includes('resonance sweep'))).toBe(false)
  })

  it('keeps the corner-to-measured contract: the last tooth ends on the corner', () => {
    const chunk = measuredChunk(lines)
    for (const group of gs.groups) {
      for (const line of group.lines) {
        const last = line.teeth[line.teeth.length - 1]
        expect(last.x1).toBeCloseTo(line.measured.x0, 9)
        expect(last.y1).toBeCloseTo(line.measured.y0, 9)
        // The measured segment still prints as its own move from the corner.
        const idx = chunk.findIndex((l) =>
          l.startsWith(
            `G1 X${(oxs + line.measured.x1).toFixed(3)} Y${(oys + line.measured.y1).toFixed(3)} E`,
          ),
        )
        expect(idx).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

describe('filament flow settings', () => {
  it('scales every extrusion by the filament extrusion multiplier', () => {
    const rich = { ...filament, extrusionMultiplier: 1.2 }
    const gcode = generateIsGcodeWithReport(profile, rich, spec).gcode
    const line = allLines[0]
    const scaled =
      `G1 X${(ox + line.measured.x0).toFixed(3)} Y${(oy + line.measured.y0).toFixed(3)} ` +
      `E${(runUpLen(line) * ePerMm(nominal) * 1.2).toFixed(5)} F${runUpFeed}`
    expect(gcode).toContain(scaled)
  })

  it('judges the high-flow warning against the filament limit when configured', () => {
    // The default spec extrudes 12.6 mm^3/s: above the 12 default, below a 20 limit.
    expect(
      generateIsGcodeWithReport(profile, filament, spec).warnings.some((w) =>
        w.includes('typical hotend'),
      ),
    ).toBe(true)
    const strong = { ...filament, maxVolumetricFlowMm3S: 20 }
    expect(
      generateIsGcodeWithReport(profile, strong, spec).warnings.some((w) =>
        w.includes('mm^3/s'),
      ),
    ).toBe(false)
    const weak = { ...filament, maxVolumetricFlowMm3S: 10 }
    expect(
      generateIsGcodeWithReport(profile, weak, spec).warnings.some((w) =>
        w.includes("filament's configured 10 mm^3/s"),
      ),
    ).toBe(true)
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
    // Layer 1: every printing move at the first layer feed (pedestal lines included).
    expect(feedsOf(chunks[0]).every((f) => f === firstLayerFeed)).toBe(true)
    // The measured layer keeps its normal speeds.
    expect(feedsOf(chunks[chunks.length - 1]).some((f) => f > firstLayerFeed)).toBe(true)
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
