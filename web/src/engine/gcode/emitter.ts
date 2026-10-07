import type { FilamentProfile, PrinterProfile } from './profileTypes'

export type Box = { x0: number; y0: number; x1: number; y1: number }

export interface Emitter {
  lines: string[]
  x: number
  y: number
  /** True while the filament is retracted. Every retract, un-retract, and priming move
   *  updates it, so a travel knows whether it still has to retract. */
  retracted: boolean
  /**
   * The regions of the layer being printed where no material lies under the nozzle path:
   * the coupon's open fiducial holes, plus its open window on the coupon layers (a solid
   * base layer backs the window). The generator sets them from the coupon's own geometry;
   * `travel` retract-brackets every primed travel that crosses one of them.
   */
  openAreas: Box[]
}

/** A fresh emitter at the bed origin, primed, with the given open areas. */
export function newEmitter(openAreas: Box[] = []): Emitter {
  return { lines: [], x: 0, y: 0, retracted: false, openAreas }
}

// The coupon extrusion math below is PrusaSlicer 2.9.6's, operation for operation, so a coupon
// commands exactly the filament PrusaSlicer would emit for the same bead: the cross-section
// (Flow::mm3_per_mm), the filament per mm^3 with the extrusion multiplier applied first
// (Extruder::e_per_mm3), the filament per mm of path (GCodeGenerator::_extrude, e_per_mm =
// e_per_mm3 * mm3_per_mm), the segment length taken between the printed 3-decimal coordinates
// (GCodeGenerator::point_to_gcode_quantized), and the E value quantized to 5 decimals
// (GCodeFormatter::quantize_e). OrcaSlicer runs the same formulas but measures segment length
// between its internal 1e-6 mm coordinates, so its E can occasionally differ in the fifth digit.

/**
 * The cross-section of a non-bridge bead as PrusaSlicer, OrcaSlicer and SuperSlicer model it
 * (PrusaSlicer Flow::mm3_per_mm), mm^2: a rectangle with semicircular ends, where the width is
 * the bead's outer silhouette, the width a scan of the bead measures. Flow stores width and
 * height as float and returns the cross-section as float; both roundings are reproduced.
 */
export function roundedBeadCrossSectionMm2(lineWidthMm: number, layerHeightMm: number): number {
  const w = Math.fround(lineWidthMm)
  const h = Math.fround(layerHeightMm)
  return Math.fround(h * (w - h * (1 - 0.25 * Math.PI)))
}

/**
 * The centre distance at which adjacent rounded beads fill a layer solid, mm (PrusaSlicer
 * Flow::rounded_rectangle_extrusion_spacing): the width less the h * (1 - pi / 4) the
 * semicircular ends leave open, evaluated in float as PrusaSlicer does. Throws where the
 * spacing is not positive (PrusaSlicer's FlowErrorNegativeSpacing): a bead that narrow for its
 * layer height cannot fill a layer.
 */
export function roundedRectangleExtrusionSpacingMm(lineWidthMm: number, layerHeightMm: number): number {
  const w = Math.fround(lineWidthMm)
  const h = Math.fround(layerHeightMm)
  const spacing = Math.fround(w - Math.fround(h * Math.fround(1 - 0.25 * Math.PI)))
  if (spacing <= 0) {
    throw new Error(
      `Use a wider line or a lower layer height. A ${lineWidthMm} mm line is too narrow to ` +
        `fill a ${layerHeightMm} mm layer.`,
    )
  }
  return spacing
}

/** The bead cross-section every coupon commands, mm^2: the rounded bead, as PrusaSlicer
 *  commands it. */
export function beadCrossSectionMm2(lineWidthMm: number, layerHeightMm: number): number {
  return roundedBeadCrossSectionMm2(lineWidthMm, layerHeightMm)
}

/** Filament length per mm^3 of bead (PrusaSlicer Extruder::e_per_mm3): the extrusion
 *  multiplier divided by the filament cross-section d * d * 0.25 * PI. */
export function ePerMm3(extrusionMultiplier: number, filamentDiameterMm: number): number {
  return extrusionMultiplier / (filamentDiameterMm * filamentDiameterMm * 0.25 * Math.PI)
}

/**
 * Filament length for a bead of the given path length (PrusaSlicer GCodeGenerator::_extrude):
 * e_per_mm = e_per_mm3 * mm3_per_mm, times the length. Unquantized; the move that emits it
 * quantizes the E value with quantizeE.
 */
export function extrusionMm(
  lengthMm: number,
  lineWidthMm: number,
  layerHeightMm: number,
  filamentDiameterMm: number,
  extrusionMultiplier = 1,
): number {
  const ePerMm =
    ePerMm3(extrusionMultiplier, filamentDiameterMm) * beadCrossSectionMm2(lineWidthMm, layerHeightMm)
  return ePerMm * lengthMm
}

/** E quantized to the 5 decimals G-code carries, rounded half away from zero (PrusaSlicer
 *  GCodeFormatter::quantize_e: std::round(v * 10^5) * 10^-5). */
export function quantizeE(e: number): number {
  const scaled = e * 100000
  return (scaled < 0 ? -Math.round(-scaled) : Math.round(scaled)) * 0.00001
}

/** A coordinate as the G-code prints it, 3 decimals: the value a printed segment's length is
 *  measured from (PrusaSlicer GCodeGenerator::point_to_gcode_quantized). */
export function printedCoordinate(v: number): number {
  return Number(v.toFixed(3))
}

/** The length of a move between two points as printed (3 decimals): the Euclidean norm of the
 *  printed coordinate difference, as PrusaSlicer takes it ((p - prev).norm()). */
export function printedSegmentLengthMm(x0: number, y0: number, x1: number, y1: number): number {
  const dx = printedCoordinate(x1) - printedCoordinate(x0)
  const dy = printedCoordinate(y1) - printedCoordinate(y0)
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * The parameter interval [tMin, tMax] over which the line (bx, by) + t * (ux, uy) lies in
 * the box (Liang-Barsky slab intersection), or null when the line misses it.
 */
function lineBoxInterval(
  bx: number,
  by: number,
  ux: number,
  uy: number,
  box: Box,
): [number, number] | null {
  let tMin = -Infinity
  let tMax = Infinity
  const slabs: [number, number, number][] = [
    [ux, box.x0 - bx, box.x1 - bx],
    [uy, box.y0 - by, box.y1 - by],
  ]
  for (const [d, lo, hi] of slabs) {
    if (Math.abs(d) < 1e-9) {
      if (lo > 0 || hi < 0) return null
    } else {
      const t0 = lo / d
      const t1 = hi / d
      tMin = Math.max(tMin, Math.min(t0, t1))
      tMax = Math.min(tMax, Math.max(t0, t1))
    }
  }
  return tMin < tMax ? [tMin, tMax] : null
}

/** Below this length (mm) a path only grazes a box edge or corner; it is floating-point
 *  noise, not a crossing. */
const GRAZE_MM = 1e-6

/**
 * True when the straight path from (ax, ay) to (bx, by) passes through the box interior.
 * A path running along an edge or touching a corner does not cross: the box boundary is
 * where the surrounding material ends, not the opening itself.
 */
export function pathCrossesBox(ax: number, ay: number, bx: number, by: number, box: Box): boolean {
  const len = Math.hypot(bx - ax, by - ay)
  if (len < GRAZE_MM) return false
  const ux = (bx - ax) / len
  const uy = (by - ay) / len
  const interval = lineBoxInterval(ax, ay, ux, uy, box)
  if (interval === null) return false
  const s0 = Math.max(interval[0], 0)
  const s1 = Math.min(interval[1], len)
  if (s1 - s0 < GRAZE_MM) return false
  const mx = ax + ux * ((s0 + s1) / 2)
  const my = ay + uy * ((s0 + s1) / 2)
  return mx > box.x0 && mx < box.x1 && my > box.y0 && my < box.y1
}

/**
 * Rapid travel to (x, y). A primed travel whose path crosses one of the emitter's open
 * areas is retract-bracketed (retract, travel, un-retract), so the pressurized nozzle
 * cannot string a film across the opening; the bracket hands the nozzle back primed, the
 * state it found. A travel made while already retracted, or one over printed area or area
 * the layer is about to fill, stays a plain travel: the standard slicer rule of retracting
 * only where the move leaves the part.
 */
export function travel(e: Emitter, p: PrinterProfile, x: number, y: number): void {
  const bracket = !e.retracted && e.openAreas.some((b) => pathCrossesBox(e.x, e.y, x, y, b))
  if (bracket) retract(e, p, 1)
  e.lines.push(`G0 X${x.toFixed(3)} Y${y.toFixed(3)} F${Math.round(p.travelSpeedMmS * 60)}`)
  e.x = x
  e.y = y
  if (bracket) retract(e, p, -1)
}

/** One bead's filament length, unquantized: extrusionMm with the filament's extrusion
 *  multiplier. Every printing move goes through this, so the multiplier has a single home; a
 *  generator that must print at exactly 1.0 (the extrusion multiplier test) passes a filament
 *  with the multiplier pinned to 1. */
export function beadExtrusionMm(
  p: PrinterProfile,
  f: FilamentProfile,
  lengthMm: number,
  lineWidthMm: number,
): number {
  return extrusionMm(lengthMm, lineWidthMm, p.layerHeightMm, f.filamentDiameterMm, f.extrusionMultiplier)
}

/**
 * The volumetric flow a bead commands at `speedMmS`, mm^3/s: the cross-section every printing
 * move commands, scaled by the filament's extrusion multiplier exactly as beadExtrusionMm
 * scales it, times the speed. A generator that pins the multiplier passes the same pinned
 * filament it prints with.
 */
export function beadVolumetricFlowMm3S(
  p: PrinterProfile,
  f: FilamentProfile,
  lineWidthMm: number,
  speedMmS: number,
): number {
  return f.extrusionMultiplier * beadCrossSectionMm2(lineWidthMm, p.layerHeightMm) * speedMmS
}

/** The volumetric flow above which a high-flow warning fires: the filament's configured
 *  maximum when set, else the conservative typical-hotend default. */
export function flowWarningLimitMm3S(f: FilamentProfile): number {
  return f.maxVolumetricFlowMm3S > 0 ? f.maxVolumetricFlowMm3S : HIGH_FLOW_WARNING_THRESHOLD_MM3_S
}

/**
 * The one high-flow warning every coupon shows, or null when the bead stays within the flow
 * limit: the two remedies, then what happens past the limit. `speedName` is the settings
 * field that sets the speed, as the page labels it ("fast speed", "line speed").
 */
export function highFlowWarning(
  p: PrinterProfile,
  f: FilamentProfile,
  lineWidthMm: number,
  speedMmS: number,
  speedName: string,
): string | null {
  const flow = beadVolumetricFlowMm3S(p, f, lineWidthMm, speedMmS)
  const limit = flowWarningLimitMm3S(f)
  if (flow <= limit) return null
  const limitText =
    f.maxVolumetricFlowMm3S > 0
      ? `the filament's ${limit} mm^3/s max volumetric flow`
      : `the ${limit} mm^3/s a typical hotend melts`
  return (
    `Lower the ${speedName}, or raise the filament's max volumetric flow only if the hotend ` +
    `can melt ${flow.toFixed(1)} mm^3/s. Above ${limitText}, the lines under-extrude.`
  )
}

/** A printing move to (x, y): the bead's filament over the printed segment length, quantized
 *  as PrusaSlicer quantizes it. */
export function extrude(
  e: Emitter,
  p: PrinterProfile,
  f: FilamentProfile,
  lineWidthMm: number,
  x: number,
  y: number,
  speedMmS: number,
): void {
  const len = printedSegmentLengthMm(e.x, e.y, x, y)
  const eAmt = quantizeE(beadExtrusionMm(p, f, len, lineWidthMm))
  e.lines.push(
    `G1 X${x.toFixed(3)} Y${y.toFixed(3)} E${eAmt.toFixed(5)} F${Math.round(speedMmS * 60)}`,
  )
  e.x = x
  e.y = y
}

/** A stationary retract (sign 1) or un-retract (sign -1) by the profile's retraction. */
export function retract(e: Emitter, p: PrinterProfile, sign: 1 | -1): void {
  e.lines.push(`G1 E${(sign * -p.retractMm).toFixed(3)} F${Math.round(p.retractSpeedMmS * 60)}`)
  e.retracted = sign === 1
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
  const interval = lineBoxInterval(bx, by, ux, uy, box)
  if (interval === null) return [[a, b]] // no intersection with the box
  const [tMin, tMax] = interval
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

/**
 * The centreline inset of each of `loops` perimeter loops from the boundary they follow, mm,
 * outermost first, placed as PrusaSlicer's PerimeterGenerator (classic) places them: the
 * external loop half its width inside the boundary (offset by ext_perimeter_width / 2), so its
 * bead's outer side lies on the boundary; the first internal loop ext_perimeter_spacing2, the mean
 * of ext_perimeter_spacing and perimeter_spacing, further in; every further loop perimeter_spacing
 * in from the one before. A coupon prints its external and internal perimeters at one width, so
 * all three spacings are the rounded bead spacing (Flow::spacing, which is
 * rounded_rectangle_extrusion_spacing): adjacent loops overlap by exactly the h * (1 - pi / 4)
 * their rounded sides leave open, and the band they form fills solid.
 */
export function perimeterLoopInsetsMm(loops: number, lineWidthMm: number, layerHeightMm: number): number[] {
  const extPerimeterSpacing = roundedRectangleExtrusionSpacingMm(lineWidthMm, layerHeightMm)
  const perimeterSpacing = extPerimeterSpacing
  const extPerimeterSpacing2 = 0.5 * (extPerimeterSpacing + perimeterSpacing)
  const insets: number[] = []
  for (let k = 0; k < loops; k++) {
    if (k === 0) insets.push(lineWidthMm / 2)
    else insets.push(insets[k - 1] + (k === 1 ? extPerimeterSpacing2 : perimeterSpacing))
  }
  return insets
}

/**
 * How far `loops` perimeter loops reach from the boundary they follow, mm: PrusaSlicer's infill
 * boundary, the innermost loop's centreline offset inward by half its spacing (perimeter_spacing
 * / 2, or ext_perimeter_spacing / 2 when the external loop is the only one), taken without
 * PrusaSlicer's infill_overlap so the raster behind the loops meets them with neither a gap nor a
 * double layer. Also the clearance a raster keeps around a fiducial hole's loops.
 */
export function perimeterBandMm(loops: number, lineWidthMm: number, layerHeightMm: number): number {
  if (loops <= 0) return 0
  const insets = perimeterLoopInsetsMm(loops, lineWidthMm, layerHeightMm)
  return insets[loops - 1] + roundedRectangleExtrusionSpacingMm(lineWidthMm, layerHeightMm) / 2
}

/**
 * The widest perimeterBandMm can be at this line width, whatever the layer height, mm: one full
 * width per loop. The rounded bead spacing only falls below the width as the layer height grows,
 * so the loops never reach past it. For geometry that must stay clear of the loops but is defined
 * without a layer height.
 */
export function widestPerimeterBandMm(loops: number, lineWidthMm: number): number {
  return loops * lineWidthMm
}

/** The shell/perimeter print speed used by every base-layer perimeter and raster fill that
 *  takes no explicit speed override (see `basePerimeters`, `rasterBase`, `frameBandLayer`,
 *  `frameBandInfill`): a fraction of the profile's travel speed. The single source for what a
 *  coupon's outer wall actually prints at, so a slicer placeholder reporting it never drifts
 *  from what the generator emits. */
export function shellSpeedMmS(p: PrinterProfile): number {
  return p.travelSpeedMmS * RASTER_SPEED_FACTOR
}

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

/**
 * Perimeter loops inset from the part outline and outset around each fiducial hole, at
 * PrusaSlicer's perimeter spacing (perimeterLoopInsetsMm).
 */
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
  const speed = speedMmS ?? shellSpeedMmS(p)
  const insets = perimeterLoopInsetsMm(PERIMETER_LOOPS, lineWidthMm, p.layerHeightMm)
  for (const ins of insets) {
    rectLoop(e, p, f, lineWidthMm, x0 + ins, y0 + ins, x0 + w - ins, y0 + h - ins, speed, doExtrude)
  }
  for (const hole of holes) {
    for (const out of insets) {
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
  const speed = speedMmS ?? shellSpeedMmS(p)
  // Adjacent scanlines sit one bead spacing apart, measured perpendicular to them, so the
  // rounded beads fill the layer solid with no void and no overlap ridge.
  const spacing = roundedRectangleExtrusionSpacingMm(lineWidthMm, p.layerHeightMm)
  // Diagonal raster: iterate scanlines along the diagonal direction. Each
  // scanline is clipped against the rectangle and split around holes.
  const dir = angle45 ? { dx: 1, dy: 1 } : { dx: -1, dy: 1 }
  const norm = Math.SQRT1_2
  const ux = dir.dx * norm
  const uy = dir.dy * norm
  // Perpendicular offsets covering the rectangle's diagonal extent.
  const diag = w + h
  let scanIndex = 0
  for (let k = 0; -diag + k * spacing <= diag; k++) {
    const c = -diag + k * spacing
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
    // Every hop, the serpentine connector to the previous row and a jump between the
    // sub-ranges a hole split this row into alike, goes through travel, which retract-
    // brackets exactly the hops whose path crosses an open hole. A hop that only cuts the
    // clearance ring around a hole (the `holes` boxes here are grown by it) stays primed. A
    // raster entered retracted (a band strip's approach) restores pressure right before its
    // first bead.
    for (const [a, b] of ordered) {
      if (Math.abs(b - a) < lineWidthMm) continue
      travel(e, p, bx + a * ux, by + a * uy)
      if (e.retracted) retract(e, p, -1)
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
  frameBandInfill(e, p, f, lineWidthMm, x0, y0, w, h, bandMm, holes, angle45, doExtrude, speedMmS)
}

/**
 * The infill half of a frame-band layer: the band raster strips followed by the fiducial
 * hole perimeters (see frameBandLayer for the reasoning behind that order). Split out so a
 * coupon generator can print its own geometry between the band perimeters and this fill.
 * Each strip hop retracts (unless the nozzle already arrives retracted), travels straight to
 * the strip's first scanline, and restores pressure there, so no strip starts with a primed
 * approach along the band.
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
  speedMmS?: number,
): void {
  const infillInset = perimeterBandMm(PERIMETER_LOOPS, lineWidthMm, p.layerHeightMm)
  // Raster clearance around a fiducial hole: past the outermost of its perimeter loops.
  const holeClearance = perimeterBandMm(HOLE_PERIMETER_LOOPS, lineWidthMm, p.layerHeightMm)
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
  for (const s of strips) {
    // The raster's first travel is the strip hop itself, made retracted; rasterBase restores
    // pressure on arrival at the first scanline.
    if (!e.retracted) retract(e, p, 1)
    rasterBase(e, p, f, lineWidthMm, s.sx, s.sy, s.w, s.h, angle45, expanded, doExtrude, speedMmS)
  }
  const holeInsets = perimeterLoopInsetsMm(HOLE_PERIMETER_LOOPS, lineWidthMm, p.layerHeightMm)
  for (const hole of holes) {
    for (const out of holeInsets) {
      rectLoop(e, p, f, lineWidthMm, hole.x0 - out, hole.y0 - out, hole.x1 + out, hole.y1 + out,
        speedMmS ?? shellSpeedMmS(p), doExtrude)
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
