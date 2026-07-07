import type { FilamentProfile, PrinterProfile, PaTestSpec } from './types'
import { couponGeometry, paValueForLine } from './types'
import { substituteSlicerVariables } from './slicerVariables'

/** Standard slicer volumetric flow: bead cross-section approximated as w * h. */
export function extrusionMm(
  lengthMm: number,
  lineWidthMm: number,
  layerHeightMm: number,
  filamentDiameterMm: number,
): number {
  const filamentArea = Math.PI * (filamentDiameterMm / 2) ** 2
  return (lineWidthMm * layerHeightMm * lengthMm) / filamentArea
}

export function paCommand(firmware: PrinterProfile['firmware'], value: number): string {
  const v = value.toFixed(4)
  if (firmware === 'Marlin') return `M900 K${v}`
  if (firmware === 'RepRapFirmware') return `M572 D0 S${v}`
  return `SET_PRESSURE_ADVANCE ADVANCE=${v}`
}

interface Emitter {
  lines: string[]
  x: number
  y: number
}

function travel(e: Emitter, p: PrinterProfile, x: number, y: number): void {
  e.lines.push(`G0 X${x.toFixed(3)} Y${y.toFixed(3)} F${Math.round(p.travelSpeedMmS * 60)}`)
  e.x = x
  e.y = y
}

function extrude(
  e: Emitter,
  p: PrinterProfile,
  f: FilamentProfile,
  spec: PaTestSpec,
  x: number,
  y: number,
  speedMmS: number,
): void {
  const len = Math.hypot(x - e.x, y - e.y)
  const eAmt = extrusionMm(len, spec.lineWidthMm, p.layerHeightMm, f.filamentDiameterMm)
  e.lines.push(
    `G1 X${x.toFixed(3)} Y${y.toFixed(3)} E${eAmt.toFixed(5)} F${Math.round(speedMmS * 60)}`,
  )
  e.x = x
  e.y = y
}

function retract(e: Emitter, p: PrinterProfile, sign: 1 | -1): void {
  e.lines.push(`G1 E${(sign * -p.retractMm).toFixed(3)} F${Math.round(p.retractSpeedMmS * 60)}`)
}

/** Return the sub-ranges of [a, b] along the parametric line that lie OUTSIDE the box. */
function clipRangeAgainstBox(
  bx: number,
  by: number,
  ux: number,
  uy: number,
  a: number,
  b: number,
  box: { x0: number; y0: number; x1: number; y1: number },
): [number, number][] {
  // Liang-Barsky style slab intersection of the parametric line with the box.
  let tMin = -Infinity
  let tMax = Infinity
  let parallelOutside = false
  const slabs: [number, number, number][] = [
    [ux, box.x0 - bx, box.x1 - bx],
    [uy, box.y0 - by, box.y1 - by],
  ]
  for (const [d, lo, hi] of slabs) {
    if (Math.abs(d) < 1e-9) {
      if (lo > 0 || hi < 0) parallelOutside = true
    } else {
      const t0 = lo / d
      const t1 = hi / d
      tMin = Math.max(tMin, Math.min(t0, t1))
      tMax = Math.min(tMax, Math.max(t0, t1))
    }
  }
  if (parallelOutside || tMin >= tMax) return [[a, b]] // no intersection with the box
  // Clip the intersection interval [tMin, tMax] to [a, b] and remove it.
  const iMin = Math.max(tMin, a)
  const iMax = Math.min(tMax, b)
  if (iMin >= iMax) return [[a, b]] // intersection doesn't overlap this range
  const out: [number, number][] = []
  if (a < iMin) out.push([a, iMin])
  if (iMax < b) out.push([iMax, b])
  return out.filter(([s, t]) => t > s)
}

const BASE_LAYERS = 2
/** Raster line pitch as a fraction of line width, for a slight overlap giving a solid layer. */
const RASTER_STEP_FACTOR = 0.9
/** Raster fill speed as a fraction of the profile's travel speed. */
const RASTER_SPEED_FACTOR = 1 / 3

/** Raster-fill a rectangle at a 45 or 135 degree angle, skipping fiducial holes. */
function rasterBase(
  e: Emitter,
  p: PrinterProfile,
  f: FilamentProfile,
  spec: PaTestSpec,
  x0: number,
  y0: number,
  w: number,
  h: number,
  angle45: boolean,
  holes: { x0: number; y0: number; x1: number; y1: number }[],
): void {
  const step = spec.lineWidthMm * RASTER_STEP_FACTOR
  // Diagonal raster: iterate scanlines along the diagonal direction. Each
  // scanline is clipped against the rectangle and split around holes.
  const dir = angle45 ? { dx: 1, dy: 1 } : { dx: -1, dy: 1 }
  const norm = Math.SQRT1_2
  const ux = dir.dx * norm
  const uy = dir.dy * norm
  // Perpendicular offsets covering the rectangle's diagonal extent.
  const diag = w + h
  for (let c = -diag; c <= diag; c += step / norm) {
    // Line: points q with (q - corner) . perpendicular = c. Parameterize and
    // clip to the rectangle by intersecting with its four edges.
    const px = -uy
    const py = ux
    const bx = x0 + px * c
    const by = y0 + py * c
    // Intersect the parametric line (bx + t*ux, by + t*uy) with the rect.
    const ts: number[] = []
    if (Math.abs(ux) > 1e-9) {
      ts.push((x0 - bx) / ux, (x0 + w - bx) / ux)
    }
    if (Math.abs(uy) > 1e-9) {
      ts.push((y0 - by) / uy, (y0 + h - by) / uy)
    }
    const inside = ts
      .map((t) => ({ t, x: bx + t * ux, y: by + t * uy }))
      .filter((q) => q.x >= x0 - 1e-6 && q.x <= x0 + w + 1e-6 && q.y >= y0 - 1e-6 && q.y <= y0 + h + 1e-6)
      .sort((a, b) => a.t - b.t)
    if (inside.length < 2) continue

    // Split the segment around holes (axis-aligned boxes): collect sub-ranges
    // that lie outside every hole box.
    const t0 = inside[0].t
    const t1 = inside[inside.length - 1].t
    let ranges: [number, number][] = [[t0, t1]]
    for (const hole of holes) {
      const next: [number, number][] = []
      for (const [a, b] of ranges) {
        next.push(...clipRangeAgainstBox(bx, by, ux, uy, a, b, hole))
      }
      ranges = next
    }
    for (const [a, b] of ranges) {
      if (b - a < spec.lineWidthMm) continue
      travel(e, p, bx + a * ux, by + a * uy)
      extrude(e, p, f, spec, bx + b * ux, by + b * uy, p.travelSpeedMmS * RASTER_SPEED_FACTOR)
    }
  }
}

export function generatePaGcode(
  profile: PrinterProfile,
  filament: FilamentProfile,
  spec: PaTestSpec,
): string {
  return generatePaGcodeWithReport(profile, filament, spec).gcode
}

/** Firmware-specific print acceleration and corner velocity (jerk) limit commands. */
function motionLimitCommands(profile: PrinterProfile): string[] {
  const accel = profile.printAccelMmS2
  const scv = profile.squareCornerVelocityMmS
  if (profile.firmware === 'Marlin') {
    return [`M204 P${accel} T${accel}`, `M205 X${scv} Y${scv}`]
  }
  if (profile.firmware === 'RepRapFirmware') {
    // M566 takes mm/min.
    return [`M204 P${accel} T${accel}`, `M566 X${scv * 60} Y${scv * 60}`]
  }
  return [`SET_VELOCITY_LIMIT ACCEL=${accel} SQUARE_CORNER_VELOCITY=${scv}`]
}

/**
 * Generate the PA test G-code, substituting slicer placeholder variables in the profile's
 * start/pause/end G-code, and report any placeholders that were left verbatim.
 */
export function generatePaGcodeWithReport(
  profile: PrinterProfile,
  filament: FilamentProfile,
  spec: PaTestSpec,
): { gcode: string; unknownVariables: string[] } {
  if (spec.fastSpeedMmS <= spec.slowSpeedMmS) {
    throw new Error('Fast speed must exceed slow speed')
  }
  const start = substituteSlicerVariables(profile.startGcode, profile, filament)
  const pause = substituteSlicerVariables(profile.pauseGcode, profile, filament)
  const end = substituteSlicerVariables(profile.endGcode, profile, filament)
  const substituted: PrinterProfile = {
    ...profile,
    startGcode: start.gcode,
    pauseGcode: pause.gcode,
    endGcode: end.gcode,
  }
  const unknownVariables = [...new Set([...start.unknown, ...pause.unknown, ...end.unknown])]
  return { gcode: emitPaGcode(substituted, filament, spec), unknownVariables }
}

function emitPaGcode(profile: PrinterProfile, filament: FilamentProfile, spec: PaTestSpec): string {
  const g = couponGeometry(spec)
  // Center the coupon on the bed.
  const ox = (profile.bedWidthMm - g.baseWidthMm) / 2
  const oy = (profile.bedDepthMm - g.baseHeightMm) / 2
  if (ox < 0 || oy < 0) {
    throw new Error('Coupon does not fit on the configured bed')
  }
  const holes = g.fiducials.map((f) => ({
    x0: ox + f.xMm - g.fiducialSizeMm / 2,
    y0: oy + f.yMm - g.fiducialSizeMm / 2,
    x1: ox + f.xMm + g.fiducialSizeMm / 2,
    y1: oy + f.yMm + g.fiducialSizeMm / 2,
  }))

  const e: Emitter = { lines: [], x: 0, y: 0 }
  const L = e.lines
  L.push('; ScanNTune pressure advance test')
  L.push('; fiducial holes preserved')
  L.push(`M140 S${filament.bedTempC}`)
  L.push(`M104 S${filament.nozzleTempC}`)
  L.push(`M190 S${filament.bedTempC}`)
  L.push(`M109 S${filament.nozzleTempC}`)
  L.push(...profile.startGcode.split('\n'))
  L.push('M83') // relative extrusion, restated in case start gcode changed it
  L.push('G90')
  L.push(...motionLimitCommands(profile))

  // Base layers.
  for (let layer = 0; layer < BASE_LAYERS; layer++) {
    const z = profile.layerHeightMm * (layer + 1)
    L.push(`G1 Z${z.toFixed(3)} F600`)
    rasterBase(e, profile, filament, spec, ox, oy, g.baseWidthMm, g.baseHeightMm, layer === 0, holes)
  }

  // Filament change to the contrasting color.
  retract(e, profile, 1)
  L.push(...profile.pauseGcode.split('\n'))
  // Printers whose PAUSE/M600 macro already retracts may see a small blob at the prime
  // line start; set retractMm to 0 in the profile if that happens.
  L.push('; if your pause macro already retracts, set retractMm to 0 in the profile')
  retract(e, profile, -1)

  // Prime line along the bottom base edge, outside the measured region.
  const z3 = profile.layerHeightMm * (BASE_LAYERS + 1)
  L.push(`G1 Z${z3.toFixed(3)} F600`)
  L.push(paCommand(profile.firmware, 0))
  travel(e, profile, ox + 2, oy + 1.5)
  extrude(e, profile, filament, spec, ox + g.baseWidthMm - 2, oy + 1.5, spec.slowSpeedMmS)

  // Test lines.
  for (let i = 0; i < spec.lineCount; i++) {
    L.push(paCommand(profile.firmware, paValueForLine(spec, i)))
    const y = oy + g.lineStartYMm(i)
    const x0 = ox + g.lineStartXMm
    retract(e, profile, 1)
    travel(e, profile, x0, y)
    retract(e, profile, -1)
    extrude(e, profile, filament, spec, x0 + spec.slowSegmentMm, y, spec.slowSpeedMmS)
    extrude(e, profile, filament, spec, x0 + spec.slowSegmentMm + spec.fastSegmentMm, y, spec.fastSpeedMmS)
    extrude(e, profile, filament, spec, x0 + 2 * spec.slowSegmentMm + spec.fastSegmentMm, y, spec.slowSpeedMmS)
  }

  retract(e, profile, 1)
  L.push(...profile.endGcode.split('\n'))
  return L.join('\n') + '\n'
}

/**
 * Rough print time estimate: base raster distance at the raster speed, plus the test lines at
 * their segment speeds and travel between them, plus a flat heat-up allowance. Reuses the same
 * raster step/speed constants the generator itself uses, so the estimate tracks the generated
 * G-code rather than duplicating separately tuned numbers. Ignores acceleration.
 */
export function estimatePaPrintSeconds(profile: PrinterProfile, spec: PaTestSpec): number {
  const g = couponGeometry(spec)
  const rasterStep = spec.lineWidthMm * RASTER_STEP_FACTOR
  const rasterSpeedMmS = profile.travelSpeedMmS * RASTER_SPEED_FACTOR
  const baseDist = (BASE_LAYERS * (g.baseWidthMm * g.baseHeightMm)) / rasterStep
  const baseSeconds = baseDist / rasterSpeedMmS
  const lineSeconds =
    spec.lineCount *
    ((2 * spec.slowSegmentMm) / spec.slowSpeedMmS +
      spec.fastSegmentMm / spec.fastSpeedMmS +
      (g.baseWidthMm + spec.linePitchMm) / profile.travelSpeedMmS)
  const heatUpSeconds = 180
  return baseSeconds + lineSeconds + heatUpSeconds
}
