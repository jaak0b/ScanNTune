import type { PrinterProfile } from '../pa/types'
import {
  MEASURED_LAYERS,
  NOMINAL_WIDTH_FACTOR,
  PEDESTAL_LAYERS,
  PEDESTAL_WIDTH_FACTOR,
} from '../gcode/emitter'

export { MEASURED_LAYERS, PEDESTAL_LAYERS, PEDESTAL_WIDTH_FACTOR }
export const FRAME_BAND_MM = 12
export const RAIL_WIDTH_MM = 4
export const BLOCK_GAP_MM = 2
export const INNER_MARGIN_MM = 3
/**
 * Narrowest open gap a flatbed scanner reads without bias through the coupon's depth.
 * Diagnostic scans of printed coupons (dark and light filament, 600 dpi) show the
 * through-depth slit shadow inflating the measured bead width for gaps below roughly
 * this figure, and an unbiased readout at and above it. This is scanner physics in
 * absolute millimetres, so it does not scale with the nozzle.
 */
const MIN_OPEN_GAP_MM = 0.65
/**
 * Over-extrusion envelope the tightest gap must survive: the sweep's minimum pitch is
 * derived so the gap stays at MIN_OPEN_GAP_MM even when the printer deposits beads 15%
 * wider than nominal, the worst flow error the coupon is expected to correct.
 */
const GAP_HEADROOM_FACTOR = 1.15
/**
 * Pitch sweep span as a fraction of the nominal width. Half a nominal width over the
 * default 9 blocks keeps the per-block pitch step near the previous validated design's
 * while the whole coupon stays within a 120 mm bed.
 */
const PITCH_SWEEP_SPAN_FACTOR = 0.5
/** Conservative default volumetric flow cap used to derive the default speed. */
const DEFAULT_MAX_FLOW_MM3_S = 8

export interface EmTestSpec {
  pitchMinMm: number
  pitchMaxMm: number
  blockCount: number
  linesPerBlock: number
  lineLengthMm: number
  printSpeedMmS: number
  nominalLineWidthMm: number
  /** Where the coupon sits on the bed: centered, or pushed to the front/back edge. */
  placement: 'center' | 'front' | 'back'
  /** Whether the coupon prints on a contrasting-color base layer (consumed by the generator). */
  contrastBase: boolean
}

/** A stage event of the EM analysis. */
export interface EmProgress {
  stage: 'decode' | 'align' | 'measure' | 'render'
}

export type EmProgressCallback = (progress: EmProgress) => void

export function defaultEmTestSpec(profile: PrinterProfile): EmTestSpec {
  const nominal = profile.nozzleDiameterMm * NOMINAL_WIDTH_FACTOR
  const round2 = (v: number) => Math.round(v * 100) / 100
  // The minimum pitch is rounded UP so rounding can never squeeze the tightest gap below
  // the readable floor; the maximum only positions the top of the sweep.
  const ceil2 = (v: number) => Math.ceil(v * 100) / 100
  const speedCap = DEFAULT_MAX_FLOW_MM3_S / (nominal * profile.layerHeightMm)
  const pitchMinMm = ceil2(nominal * GAP_HEADROOM_FACTOR + MIN_OPEN_GAP_MM)
  return {
    pitchMinMm,
    pitchMaxMm: round2(pitchMinMm + nominal * PITCH_SWEEP_SPAN_FACTOR),
    blockCount: 9,
    linesPerBlock: 5,
    lineLengthMm: 25,
    printSpeedMmS: Math.min(profile.travelSpeedMmS / 2, Math.floor(speedCap)),
    nominalLineWidthMm: nominal,
    placement: 'center',
    contrastBase: false,
  }
}

export function pitchForBlock(spec: EmTestSpec, index: number): number {
  return spec.pitchMinMm + ((spec.pitchMaxMm - spec.pitchMinMm) * index) / (spec.blockCount - 1)
}

export interface EmBlock {
  index: number
  pitchMm: number
  x0Mm: number
  widthMm: number
  lineXsMm: number[]
}

export interface EmCouponGeometry {
  couponWidthMm: number
  couponHeightMm: number
  frameBandMm: number
  railWidthMm: number
  fiducialInsetMm: number
  fiducialSizeMm: number
  fiducials: { xMm: number; yMm: number }[]
  topRow: EmBlock[]
  bottomRow: EmBlock[]
  topRowY0Mm: number
  topRowY1Mm: number
  railY0Mm: number
  railY1Mm: number
  bottomRowY0Mm: number
  bottomRowY1Mm: number
}

function buildRow(spec: EmTestSpec, x0: number, reversed: boolean): EmBlock[] {
  const order = [...Array(spec.blockCount).keys()]
  if (reversed) order.reverse()
  const blocks: EmBlock[] = []
  let x = x0
  for (const index of order) {
    const pitch = pitchForBlock(spec, index)
    const width = (spec.linesPerBlock - 1) * pitch + spec.nominalLineWidthMm
    const first = x + spec.nominalLineWidthMm / 2
    const lineXsMm = [...Array(spec.linesPerBlock).keys()].map((j) => first + j * pitch)
    blocks.push({ index, pitchMm: pitch, x0Mm: x, widthMm: width, lineXsMm })
    x += width + BLOCK_GAP_MM
  }
  return blocks
}

export function emCouponGeometry(spec: EmTestSpec): EmCouponGeometry {
  const blocksWidth =
    [...Array(spec.blockCount).keys()]
      .map((i) => (spec.linesPerBlock - 1) * pitchForBlock(spec, i) + spec.nominalLineWidthMm)
      .reduce((a, b) => a + b, 0) +
    (spec.blockCount - 1) * BLOCK_GAP_MM
  const couponWidthMm = blocksWidth + 2 * INNER_MARGIN_MM + 2 * FRAME_BAND_MM
  const couponHeightMm = 2 * spec.lineLengthMm + RAIL_WIDTH_MM + 2 * FRAME_BAND_MM
  const inset = 4
  const size = 5
  const rowX0 = FRAME_BAND_MM + INNER_MARGIN_MM
  const topRowY0Mm = FRAME_BAND_MM
  const topRowY1Mm = topRowY0Mm + spec.lineLengthMm
  const railY0Mm = topRowY1Mm
  const railY1Mm = railY0Mm + RAIL_WIDTH_MM
  const bottomRowY0Mm = railY1Mm
  const bottomRowY1Mm = bottomRowY0Mm + spec.lineLengthMm
  return {
    couponWidthMm,
    couponHeightMm,
    frameBandMm: FRAME_BAND_MM,
    railWidthMm: RAIL_WIDTH_MM,
    fiducialInsetMm: inset,
    fiducialSizeMm: size,
    // Hole centers; the (min-x, min-y) origin corner deliberately has none (PA convention).
    fiducials: [
      { xMm: couponWidthMm - inset - size / 2, yMm: inset + size / 2 },
      { xMm: couponWidthMm - inset - size / 2, yMm: couponHeightMm - inset - size / 2 },
      { xMm: inset + size / 2, yMm: couponHeightMm - inset - size / 2 },
    ],
    topRow: buildRow(spec, rowX0, false),
    bottomRow: buildRow(spec, rowX0, true),
    topRowY0Mm,
    topRowY1Mm,
    railY0Mm,
    railY1Mm,
    bottomRowY0Mm,
    bottomRowY1Mm,
  }
}

export function volumetricFlowMm3S(spec: EmTestSpec, layerHeightMm: number): number {
  return spec.printSpeedMmS * spec.nominalLineWidthMm * layerHeightMm
}

export function accelRampMm(speedMmS: number, accelMmS2: number): number {
  return (speedMmS * speedMmS) / (2 * accelMmS2)
}
