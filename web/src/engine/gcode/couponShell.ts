import type { FilamentProfile, PrinterProfile } from './profileTypes'
import { substituteSlicerVariables, type SlicerGenerationContext } from '../pa/slicerVariables'
import {
  BASE_LAYERS,
  basePerimeters,
  type Box,
  COLD_PRINT_WARNING,
  type Emitter,
  extrude,
  motionLimitCommands,
  PERIMETER_LOOPS,
  perimeterBandMm,
  rasterBase,
  retract,
  shellSpeedMmS,
  startGcodeHeats,
  travel,
} from './emitter'

export type { SlicerGenerationContext }

/**
 * The generation context every coupon generator must build and pass to `prepareProfile`: the
 * shell's actual line width and print speed (the same values `baseLayers` below will use to
 * print the outer wall) and the first layer's bounding box (the same `ox`/`oy`/width/height the
 * generator's own `couponOrigin` call already produced). Centralizing this here means a slicer
 * placeholder can never see a value the generator did not actually print (rule: single source).
 */
export function shellSlicerContext(
  profile: PrinterProfile,
  lineWidthMm: number,
  ox: number,
  oy: number,
  widthMm: number,
  heightMm: number,
): SlicerGenerationContext {
  return {
    outerWallSpeedMmS: shellSpeedMmS(profile),
    outerWallLineWidthMm: lineWidthMm,
    firstLayerBboxMm: { minXMm: ox, minYMm: oy, maxXMm: ox + widthMm, maxYMm: oy + heightMm },
  }
}

/** A profile and filament with slicer variables substituted, plus the substitution report. */
export interface PreparedProfile {
  profile: PrinterProfile
  filament: FilamentProfile
  unknownVariables: string[]
  warnings: string[]
}

/**
 * Substitute slicer placeholder variables in the profile's start/pause/end G-code and the
 * filament's start/end G-code, deduplicate the unresolved placeholders and warnings across
 * the blocks, and warn when the start G-code sets no temperatures. When `includePause` is
 * false the pause G-code is left verbatim and its placeholders are not reported (the coupon
 * never emits it).
 */
export function prepareProfile(
  profile: PrinterProfile,
  filament: FilamentProfile,
  context: SlicerGenerationContext,
  opts?: { includePause?: boolean },
): PreparedProfile {
  const start = substituteSlicerVariables(profile.startGcode, profile, filament, context)
  const pause =
    (opts?.includePause ?? true)
      ? substituteSlicerVariables(profile.pauseGcode, profile, filament, context)
      : { gcode: profile.pauseGcode, unknown: [] as string[], warnings: [] as string[] }
  const end = substituteSlicerVariables(profile.endGcode, profile, filament, context)
  const filamentStart = substituteSlicerVariables(filament.startGcode, profile, filament, context)
  const filamentEnd = substituteSlicerVariables(filament.endGcode, profile, filament, context)
  const substituted: PrinterProfile = {
    ...profile,
    startGcode: start.gcode,
    pauseGcode: pause.gcode,
    endGcode: end.gcode,
  }
  const substitutedFilament: FilamentProfile = {
    ...filament,
    startGcode: filamentStart.gcode,
    endGcode: filamentEnd.gcode,
  }
  const blocks = [start, pause, end, filamentStart, filamentEnd]
  const unknownVariables = [...new Set(blocks.flatMap((b) => b.unknown))]
  const warnings = [...new Set(blocks.flatMap((b) => b.warnings))]
  if (!startGcodeHeats(start.gcode)) warnings.push(COLD_PRINT_WARNING)
  return { profile: substituted, filament: substitutedFilament, unknownVariables, warnings }
}

export type CouponPlacement = 'center' | 'front' | 'back'

/** Clearance from the bed edge for the 'front'/'back' placements. */
export const EDGE_MARGIN_MM = 10

/**
 * The bed depth a coupon may occupy at `placement`: the whole depth when centered, and the
 * depth less EDGE_MARGIN_MM when the coupon sits against the front or back edge, which keeps
 * that margin to the edge it is pushed against. Bed fits size a coupon against this, and
 * couponOrigin refuses one that exceeds it.
 */
export function availableBedDepthMm(profile: PrinterProfile, placement: CouponPlacement): number {
  return placement === 'center' ? profile.bedDepthMm : profile.bedDepthMm - EDGE_MARGIN_MM
}

/**
 * Bed origin (min-x, min-y) of the coupon: centered on X, placed on Y per `placement`
 * ('front'/'back' sit EDGE_MARGIN_MM from that bed edge). Throws when the coupon overhangs
 * the configured bed at either edge, the far one included.
 */
export function couponOrigin(
  profile: PrinterProfile,
  couponWidthMm: number,
  couponHeightMm: number,
  placement: CouponPlacement = 'center',
): { ox: number; oy: number } {
  const ox = (profile.bedWidthMm - couponWidthMm) / 2
  const oy =
    placement === 'front'
      ? EDGE_MARGIN_MM
      : placement === 'back'
        ? profile.bedDepthMm - couponHeightMm - EDGE_MARGIN_MM
        : (profile.bedDepthMm - couponHeightMm) / 2
  if (ox < 0 || couponHeightMm > availableBedDepthMm(profile, placement)) {
    throw new Error('Coupon does not fit on the configured bed')
  }
  return { ox, oy }
}

/**
 * Shared coupon preamble: header comments, the (already substituted) printer start G-code
 * followed by the filament's start G-code in slicer order, relative extrusion and absolute
 * positioning restated in case the start G-code changed them, and the firmware's motion
 * limit commands (overridable via `motionLines`). The motion limits are always set, which is
 * why couponOverriddenSettings lists them for every coupon.
 */
export function setupPreamble(
  profile: PrinterProfile,
  filament: FilamentProfile,
  headerComments: string[],
  opts?: { motionLines?: string[] },
): string[] {
  return [
    ...headerComments,
    ...profile.startGcode.split('\n'),
    ...gcodeBlockLines(filament.startGcode),
    'M83',
    'G90',
    ...(opts?.motionLines ?? motionLimitCommands(profile)),
  ]
}

/**
 * Firmware state a coupon changes for its test and leaves changed when the print ends. None
 * of it is re-applied numerically: the restore is a firmware restart (or the saved
 * configuration), so no printer settings need to be stored for it.
 */
export type OverriddenSetting =
  | 'inputShaping'
  | 'pressureAdvance'
  | 'flowPercentage'
  | 'speedFactor'
  | 'motionLimits'

interface OverriddenSettingText {
  /** The end-of-print G-code comment naming how the setting comes back. */
  comment: string
}

const OVERRIDDEN_SETTING_TEXT: Record<OverriddenSetting, OverriddenSettingText> = {
  inputShaping: {
    comment: '; input shaping resumes with the next firmware restart or saved configuration',
  },
  pressureAdvance: {
    comment: '; pressure advance resumes with the next firmware restart or saved configuration',
  },
  flowPercentage: {
    comment: '; the M221 flow percentage resumes with the next firmware restart',
  },
  speedFactor: {
    comment: '; the M220 speed factor resumes with the next firmware restart',
  },
  motionLimits: {
    comment: '; run FIRMWARE_RESTART to restore your configured motion limits',
  },
}

/**
 * Everything a coupon leaves changed: the flow's own test overrides, then the motion limits.
 * Every coupon's preamble (setupPreamble) sets the acceleration and corner limit, either the
 * profile's values or a test's own, which replaces whatever the firmware had configured, so
 * the motion limits belong in every flow's end-of-print comments.
 */
export function couponOverriddenSettings(
  testOverrides: readonly OverriddenSetting[],
): readonly OverriddenSetting[] {
  return [...testOverrides, 'motionLimits']
}

/** End-of-print comments, one per overridden setting, naming how each comes back. */
export function restartNoteComments(overridden: readonly OverriddenSetting[]): string[] {
  return overridden.map((s) => OVERRIDDEN_SETTING_TEXT[s].comment)
}

/**
 * Shared coupon ending: the restart comments for the settings the coupon overrode, the final
 * retract, then the (already substituted) filament end G-code followed by the printer's end
 * G-code, in slicer order.
 */
export function finishCoupon(
  e: Emitter,
  profile: PrinterProfile,
  filament: FilamentProfile,
  overridden: readonly OverriddenSetting[],
): void {
  e.lines.push(...restartNoteComments(overridden))
  retract(e, profile, 1)
  e.lines.push(...gcodeBlockLines(filament.endGcode), ...profile.endGcode.split('\n'))
}

/** The block's lines, or nothing at all when the block is empty or whitespace. */
function gcodeBlockLines(block: string): string[] {
  return block.trim() === '' ? [] : block.split('\n')
}

/** The coupon's square fiducial holes as boxes in bed coordinates. */
export function fiducialHoleBoxes(
  fiducials: readonly { xMm: number; yMm: number }[],
  sizeMm: number,
  ox: number,
  oy: number,
): Box[] {
  return fiducials.map((f) => ({
    x0: ox + f.xMm - sizeMm / 2,
    y0: oy + f.yMm - sizeMm / 2,
    x1: ox + f.xMm + sizeMm / 2,
    y1: oy + f.yMm + sizeMm / 2,
  }))
}

/**
 * The solid base of a coupon: `BASE_LAYERS` full-rectangle layers, each with perimeter
 * loops around the outline and the fiducial holes first, then the serpentine raster inset
 * behind them (the raster's hole boxes are grown by the same inset). The first base layer
 * prints at the profile's first layer speed for bed adhesion.
 */
export function baseLayers(
  e: Emitter,
  profile: PrinterProfile,
  filament: FilamentProfile,
  lineWidthMm: number,
  ox: number,
  oy: number,
  widthMm: number,
  heightMm: number,
  holes: Box[],
): void {
  const infillInset = perimeterBandMm(PERIMETER_LOOPS, lineWidthMm, profile.layerHeightMm)
  const rasterHoles = holes.map((h) => ({
    x0: h.x0 - infillInset,
    y0: h.y0 - infillInset,
    x1: h.x1 + infillInset,
    y1: h.y1 + infillInset,
  }))
  for (let layer = 0; layer < BASE_LAYERS; layer++) {
    const z = profile.layerHeightMm * (layer + 1)
    e.lines.push(`G1 Z${z.toFixed(3)} F600`)
    const speed = layer === 0 ? profile.firstLayerSpeedMmS : undefined
    basePerimeters(e, profile, filament, lineWidthMm, ox, oy, widthMm, heightMm,
      holes, extrude, speed)
    rasterBase(e, profile, filament, lineWidthMm, ox + infillInset, oy + infillInset,
      widthMm - 2 * infillInset, heightMm - 2 * infillInset,
      layer % 2 === 0, rasterHoles, extrude, speed)
  }
}

/**
 * Filament change to the contrasting color: retract, the profile's (already substituted)
 * pause G-code, a note for pause macros that retract on their own, and the deretract.
 */
export function filamentSwapPause(e: Emitter, profile: PrinterProfile): void {
  retract(e, profile, 1)
  e.lines.push(...profile.pauseGcode.split('\n'))
  e.lines.push('; if your pause macro already retracts, set retractMm to 0 in the profile')
  retract(e, profile, -1)
}

/**
 * Layer change bracketed for the open window: retract before the Z push, travel to
 * (x, y) while still retracted (the move may cross open area), then restore pressure.
 * With `bracket` false only the Z push is emitted (a first layer with nothing to ooze
 * over needs no bracket).
 */
export function layerZBracket(
  e: Emitter,
  profile: PrinterProfile,
  zMm: number,
  x: number,
  y: number,
  bracket = true,
): void {
  if (bracket) retract(e, profile, 1)
  e.lines.push(`G1 Z${zMm.toFixed(3)} F600`)
  if (bracket) {
    travel(e, profile, x, y)
    retract(e, profile, -1)
  }
}

/**
 * The speed cap for a coupon layer: on the bed (no contrast base) the first coupon layer
 * prints at the profile's first layer speed for adhesion; everywhere else the generator's
 * own speeds apply.
 */
export function firstLayerSpeedCap(
  profile: PrinterProfile,
  contrastBase: boolean,
  layer: number,
): number | undefined {
  return !contrastBase && layer === 0 ? profile.firstLayerSpeedMmS : undefined
}
