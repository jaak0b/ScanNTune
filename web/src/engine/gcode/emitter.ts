import type { FilamentProfile, PrinterProfile } from './profileTypes'

export interface Emitter {
  lines: string[]
  x: number
  y: number
}

export type Box = { x0: number; y0: number; x1: number; y1: number }

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

export function travel(e: Emitter, p: PrinterProfile, x: number, y: number): void {
  e.lines.push(`G0 X${x.toFixed(3)} Y${y.toFixed(3)} F${Math.round(p.travelSpeedMmS * 60)}`)
  e.x = x
  e.y = y
}

/** One bead's filament length: the geometric extrusion scaled by the filament's
 *  extrusion multiplier. Every printing move goes through this, so the multiplier has a
 *  single home; a generator that must print at exactly 1.0 (the extrusion multiplier
 *  test) passes a filament with the multiplier pinned to 1. */
export function beadExtrusionMm(
  p: PrinterProfile,
  f: FilamentProfile,
  lengthMm: number,
  lineWidthMm: number,
): number {
  return f.extrusionMultiplier * extrusionMm(lengthMm, lineWidthMm, p.layerHeightMm, f.filamentDiameterMm)
}

/** The volumetric flow above which a high-flow warning fires: the filament's configured
 *  maximum when set, else the conservative typical-hotend default. */
export function flowWarningLimitMm3S(f: FilamentProfile): number {
  return f.maxVolumetricFlowMm3S > 0 ? f.maxVolumetricFlowMm3S : HIGH_FLOW_WARNING_THRESHOLD_MM3_S
}

export function extrude(
  e: Emitter,
  p: PrinterProfile,
  f: FilamentProfile,
  lineWidthMm: number,
  x: number,
  y: number,
  speedMmS: number,
): void {
  const len = Math.hypot(x - e.x, y - e.y)
  const eAmt = beadExtrusionMm(p, f, len, lineWidthMm)
  e.lines.push(
    `G1 X${x.toFixed(3)} Y${y.toFixed(3)} E${eAmt.toFixed(5)} F${Math.round(speedMmS * 60)}`,
  )
  e.x = x
  e.y = y
}

export function retract(e: Emitter, p: PrinterProfile, sign: 1 | -1): void {
  e.lines.push(`G1 E${(sign * -p.retractMm).toFixed(3)} F${Math.round(p.retractSpeedMmS * 60)}`)
}

/**
 * Pluggable extrusion move: the band emitters below accept one so a coupon generator can
 * modulate the flow (e.g. zero it over an already-printed bead) without changing the
 * default emission of the other generators. Defaults to `extrude` everywhere.
 */
export type ExtrudeFn = (
  e: Emitter,
  p: PrinterProfile,
  f: FilamentProfile,
  lineWidthMm: number,
  x: number,
  y: number,
  speedMmS: number,
) => void

/** Return the sub-ranges of [a, b] along the parametric line that lie OUTSIDE the box. */
function clipRangeAgainstBox(
  bx: number,
  by: number,
  ux: number,
  uy: number,
  a: number,
  b: number,
  box: Box,
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

export const BASE_LAYERS = 2
/** Raster line pitch as a fraction of line width, for a slight overlap giving a solid layer. */
export const RASTER_STEP_FACTOR = 0.9
/** Raster fill speed as a fraction of the profile's travel speed. */
export const RASTER_SPEED_FACTOR = 1 / 3
/** Concentric perimeter loops around the part outline and each fiducial hole. */
export const PERIMETER_LOOPS = 2
/** Loops around each fiducial hole; one more than elsewhere so raster ends stay clear. */
export const HOLE_PERIMETER_LOOPS = 3
/** Nominal single-bead width as a fraction of the nozzle diameter (standard slicer default). */
export const NOMINAL_WIDTH_FACTOR = 1.05
/** First-layer lines print narrower so z-offset squish is absorbed below the measured layers. */
export const PEDESTAL_WIDTH_FACTOR = 0.72
export const PEDESTAL_LAYERS = 1
export const MEASURED_LAYERS = 2
/** Volumetric flow above which typical hotends under-extrude; generators warn past it. */
export const HIGH_FLOW_WARNING_THRESHOLD_MM3_S = 12

/** One closed rectangular loop: travel to a corner, then four extrude moves. */
export function rectLoop(
  e: Emitter,
  p: PrinterProfile,
  f: FilamentProfile,
  lineWidthMm: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  speedMmS: number,
  doExtrude: ExtrudeFn = extrude,
): void {
  travel(e, p, x0, y0)
  doExtrude(e, p, f, lineWidthMm, x1, y0, speedMmS)
  doExtrude(e, p, f, lineWidthMm, x1, y1, speedMmS)
  doExtrude(e, p, f, lineWidthMm, x0, y1, speedMmS)
  doExtrude(e, p, f, lineWidthMm, x0, y0, speedMmS)
}

/** Perimeter loops inset from the part outline and outset around each fiducial hole. */
export function basePerimeters(
  e: Emitter,
  p: PrinterProfile,
  f: FilamentProfile,
  lineWidthMm: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  holes: Box[],
  doExtrude: ExtrudeFn = extrude,
  speedMmS?: number,
): void {
  const speed = speedMmS ?? p.travelSpeedMmS * RASTER_SPEED_FACTOR
  for (let k = 0; k < PERIMETER_LOOPS; k++) {
    const ins = (k + 0.5) * lineWidthMm
    rectLoop(e, p, f, lineWidthMm, x0 + ins, y0 + ins, x0 + w - ins, y0 + h - ins, speed, doExtrude)
  }
  for (const hole of holes) {
    for (let k = 0; k < PERIMETER_LOOPS; k++) {
      const out = (k + 0.5) * lineWidthMm
      rectLoop(e, p, f, lineWidthMm, hole.x0 - out, hole.y0 - out, hole.x1 + out, hole.y1 + out, speed, doExtrude)
    }
  }
}

/** Raster-fill a rectangle at a 45 or 135 degree angle, skipping fiducial holes. */
export function rasterBase(
  e: Emitter,
  p: PrinterProfile,
  f: FilamentProfile,
  lineWidthMm: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  angle45: boolean,
  holes: Box[],
  doExtrude: ExtrudeFn = extrude,
  speedMmS?: number,
): void {
  const speed = speedMmS ?? p.travelSpeedMmS * RASTER_SPEED_FACTOR
  const step = lineWidthMm * RASTER_STEP_FACTOR
  // Diagonal raster: iterate scanlines along the diagonal direction. Each
  // scanline is clipped against the rectangle and split around holes.
  const dir = angle45 ? { dx: 1, dy: 1 } : { dx: -1, dy: 1 }
  const norm = Math.SQRT1_2
  const ux = dir.dx * norm
  const uy = dir.dy * norm
  // Perpendicular offsets covering the rectangle's diagonal extent.
  const diag = w + h
  let scanIndex = 0
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
    // Serpentine: odd scanlines print back toward the previous scanline's end.
    const ordered: [number, number][] =
      scanIndex % 2 === 1 ? [...ranges].reverse().map(([a, b]) => [b, a]) : ranges
    for (const [a, b] of ordered) {
      if (Math.abs(b - a) < lineWidthMm) continue
      travel(e, p, bx + a * ux, by + a * uy)
      doExtrude(e, p, f, lineWidthMm, bx + b * ux, by + b * uy, speed)
    }
    scanIndex++
  }
}

/**
 * One frame-band layer shared by the open-window coupons: outline and window perimeters, the
 * band infill rastered as four strips so no scanline (or its connecting travel) ever crosses
 * the open window, then the fiducial hole perimeters. The hole loops are drawn after the
 * raster so they seal its ragged line-ends under a clean continuous bead (a frayed edge
 * biases the centroid the aligner reads). Each strip hop is retract-bracketed.
 */
export function frameBandLayer(
  e: Emitter,
  p: PrinterProfile,
  f: FilamentProfile,
  lineWidthMm: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  bandMm: number,
  holes: Box[],
  angle45: boolean,
  doExtrude: ExtrudeFn = extrude,
  speedMmS?: number,
): void {
  // The interior window is a hole box: it turns the solid fill into a frame band.
  const windowBox: Box = { x0: x0 + bandMm, y0: y0 + bandMm, x1: x0 + w - bandMm, y1: y0 + h - bandMm }
  basePerimeters(e, p, f, lineWidthMm, x0, y0, w, h, [windowBox], doExtrude, speedMmS)
  frameBandInfill(e, p, f, lineWidthMm, x0, y0, w, h, bandMm, holes, angle45, doExtrude, false, speedMmS)
}

/**
 * The infill half of a frame-band layer: the band raster strips followed by the fiducial
 * hole perimeters (see frameBandLayer for the reasoning behind that order). Split out so a
 * coupon generator can print its own geometry between the band perimeters and this fill.
 * Expects the nozzle primed on entry, like frameBandLayer after its perimeters; pass
 * `startRetracted` when the nozzle enters retracted, so the first strip hop does not
 * retract a second time.
 */
export function frameBandInfill(
  e: Emitter,
  p: PrinterProfile,
  f: FilamentProfile,
  lineWidthMm: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  bandMm: number,
  holes: Box[],
  angle45: boolean,
  doExtrude: ExtrudeFn = extrude,
  startRetracted = false,
  speedMmS?: number,
): void {
  const infillInset = PERIMETER_LOOPS * lineWidthMm
  // Raster clearance around a fiducial hole: past the outermost of its perimeter loops.
  const holeClearance = HOLE_PERIMETER_LOOPS * lineWidthMm
  const expanded = holes.map((b) => ({
    x0: b.x0 - holeClearance,
    y0: b.y0 - holeClearance,
    x1: b.x1 + holeClearance,
    y1: b.y1 + holeClearance,
  }))
  const strips = [
    // Top and bottom strips carry the fiducial holes; left/right span between them. The side
    // strips butt exactly against the top/bottom strips (their y ranges share a boundary at
    // bandMm - infillInset) so the corner seams have no unfilled sliver.
    { sx: x0 + infillInset, sy: y0 + infillInset, w: w - 2 * infillInset, h: bandMm - 2 * infillInset },
    { sx: x0 + infillInset, sy: y0 + h - bandMm + infillInset, w: w - 2 * infillInset, h: bandMm - 2 * infillInset },
    { sx: x0 + infillInset, sy: y0 + bandMm - infillInset, w: bandMm - 2 * infillInset, h: h - 2 * bandMm + 2 * infillInset },
    { sx: x0 + w - bandMm + infillInset, sy: y0 + bandMm - infillInset, w: bandMm - 2 * infillInset, h: h - 2 * bandMm + 2 * infillInset },
  ]
  strips.forEach((s, i) => {
    if (!(startRetracted && i === 0)) retract(e, p, 1)
    travel(e, p, s.sx, s.sy)
    retract(e, p, -1)
    rasterBase(e, p, f, lineWidthMm, s.sx, s.sy, s.w, s.h, angle45, expanded, doExtrude, speedMmS)
  })
  for (const hole of holes) {
    for (let k = 0; k < HOLE_PERIMETER_LOOPS; k++) {
      const out = (k + 0.5) * lineWidthMm
      rectLoop(e, p, f, lineWidthMm, hole.x0 - out, hole.y0 - out, hole.x1 + out, hole.y1 + out,
        speedMmS ?? p.travelSpeedMmS * RASTER_SPEED_FACTOR, doExtrude)
    }
  }
}

/** Firmware-specific print acceleration and corner velocity (jerk) limit commands. */
export function motionLimitCommands(profile: PrinterProfile): string[] {
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

export const COLD_PRINT_WARNING =
  'Your start G-code sets no temperatures; the printer may not heat. Add heating to your start G-code.'

/** Temperature-setting commands the printer understands: set/wait for nozzle or bed, or wait. */
const TEMP_COMMAND = /\b(M104|M109|M140|M190|M116)\b/i
/** Print-start macros that heat internally (Klipper-style PRINT_START/START_PRINT). */
const START_MACRO = /(PRINT_START|START_PRINT)/i
/** A temperature-ish parameter token accompanying a print-start macro. No word boundaries: real
 *  params are compound tokens like BED_TEMP, TOOL_TEMP, HOTEND, BED=. */
const TEMP_PARAM = /(BED|HOTEND|EXTRUDER|CHAMBER|TEMP)/i

/**
 * True when the (already substituted) start G-code heats the printer: either via an explicit
 * temperature command, or via a print-start macro carrying a temperature parameter.
 */
export function startGcodeHeats(gcode: string): boolean {
  if (TEMP_COMMAND.test(gcode)) return true
  return START_MACRO.test(gcode) && TEMP_PARAM.test(gcode)
}

const A4_SHORT_MM = 210
const A4_LONG_MM = 297

/** True if a widthMm x heightMm footprint fits an A4 sheet in either orientation. */
export function fitsA4(widthMm: number, heightMm: number): boolean {
  return (
    (widthMm <= A4_SHORT_MM && heightMm <= A4_LONG_MM) ||
    (widthMm <= A4_LONG_MM && heightMm <= A4_SHORT_MM)
  )
}
