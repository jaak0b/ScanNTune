export type Firmware = 'Klipper' | 'Marlin' | 'RepRapFirmware'

export interface FilamentProfile {
  id: string
  name: string
  filamentType: string
  filamentDiameterMm: number
  nozzleTempC: number
  bedTempC: number
  chamberTempC: number
}

export interface PrinterProfile {
  id: string
  name: string
  firmware: Firmware
  bedWidthMm: number
  bedDepthMm: number
  nozzleDiameterMm: number
  filaments: FilamentProfile[]
  selectedFilamentId: string | null
  travelSpeedMmS: number
  printAccelMmS2: number
  /** Klipper square corner velocity, Marlin XY jerk, in mm/s. */
  squareCornerVelocityMmS: number
  layerHeightMm: number
  retractMm: number
  retractSpeedMmS: number
  startGcode: string
  pauseGcode: string
  endGcode: string
}

export interface PaTestSpec {
  lineCount: number
  paStart: number
  paEnd: number
  slowSegmentMm: number
  fastSegmentMm: number
  slowSpeedMmS: number
  fastSpeedMmS: number
  linePitchMm: number
  marginMm: number
  lineWidthMm: number
}

export interface Fiducial {
  xMm: number
  yMm: number
}

export interface CouponGeometry {
  baseWidthMm: number
  baseHeightMm: number
  fiducialInsetMm: number
  fiducialSizeMm: number
  fiducials: Fiducial[]
  /** Line-local x of the two speed transitions. */
  transitionXsMm: [number, number]
  /** Origin (min-x, min-y in coupon frame) of line i's start point. */
  lineStartXMm: number
  lineStartYMm: (index: number) => number
}

export interface PaLineScore {
  index: number
  paValue: number
  /** RMS width deviation in transition windows, in mm of width. */
  score: number
  medianWidthMm: number
  measured: boolean
}

export interface PaResult {
  success: boolean
  failureReason: string | null
  lines: PaLineScore[]
  /** Discrete best line index, null on failure. */
  bestLineIndex: number | null
  /** Parabolic-interpolated PA at the score minimum, null on failure. */
  bestPa: number | null
  flipped: boolean
  rotationQuarterTurns: number
}

export function defaultFilamentProfile(): FilamentProfile {
  return {
    id: '',
    name: 'Default',
    filamentType: 'PLA',
    filamentDiameterMm: 1.75,
    nozzleTempC: 210,
    bedTempC: 60,
    chamberTempC: 0,
  }
}

export function defaultPrinterProfile(): PrinterProfile {
  return {
    id: '',
    name: 'My printer',
    firmware: 'Klipper',
    bedWidthMm: 220,
    bedDepthMm: 220,
    nozzleDiameterMm: 0.4,
    filaments: [defaultFilamentProfile()],
    selectedFilamentId: null,
    travelSpeedMmS: 150,
    printAccelMmS2: 3000,
    squareCornerVelocityMmS: 5,
    layerHeightMm: 0.2,
    retractMm: 0.8,
    retractSpeedMmS: 35,
    startGcode: 'G28\nG90\nM83',
    pauseGcode: 'PAUSE',
    endGcode: 'M104 S0\nM140 S0\nG91\nG1 Z10 F600\nG90\nM84',
  }
}

export function defaultPaTestSpec(): PaTestSpec {
  return {
    lineCount: 16,
    paStart: 0,
    paEnd: 0.06,
    slowSegmentMm: 20,
    fastSegmentMm: 40,
    slowSpeedMmS: 25,
    fastSpeedMmS: 100,
    linePitchMm: 4,
    marginMm: 8,
    lineWidthMm: 0.45,
  }
}

export function paValueForLine(spec: PaTestSpec, index: number): number {
  return spec.paStart + ((spec.paEnd - spec.paStart) * index) / (spec.lineCount - 1)
}

// The optimum sitting on the first or last line means the sweep didn't bracket it: offer a range
// shifted so the current best PA sits in the middle. Takes the spec the analysis was actually run
// against, not any later live form state, so a result stays consistent with what produced it.
export function edgeShiftRange(
  spec: PaTestSpec,
  bestLineIndex: number | null,
): { start: number; end: number } | null {
  if (bestLineIndex === null) return null
  if (bestLineIndex !== 0 && bestLineIndex !== spec.lineCount - 1) return null
  const range = spec.paEnd - spec.paStart
  const centre = paValueForLine(spec, bestLineIndex)
  const start = Math.max(0, centre - range / 2)
  const end = start + range
  // The bottom-edge clamp case (bestLineIndex 0, paStart already 0) produces a shift identical to
  // the current range: offer a refinement narrowing the sweep toward zero instead of a no-op rerun.
  if (bestLineIndex === 0 && start === spec.paStart && end === spec.paEnd) {
    return { start: 0, end: (spec.paEnd - spec.paStart) / 2 }
  }
  return { start, end }
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

/**
 * The largest line count whose baseHeightMm stays within maxHeightMm, inverting
 * baseHeightMm = (n-1)*linePitchMm + 2*marginMm.
 */
export function maxLineCountForHeight(spec: PaTestSpec, maxHeightMm: number): number {
  return Math.floor((maxHeightMm - 2 * spec.marginMm) / spec.linePitchMm) + 1
}

export function couponGeometry(spec: PaTestSpec): CouponGeometry {
  const lineLen = 2 * spec.slowSegmentMm + spec.fastSegmentMm
  const baseWidthMm = lineLen + 2 * spec.marginMm
  const baseHeightMm = (spec.lineCount - 1) * spec.linePitchMm + 2 * spec.marginMm
  const inset = 4
  const size = 5
  return {
    baseWidthMm,
    baseHeightMm,
    fiducialInsetMm: inset,
    fiducialSizeMm: size,
    // Hole centers; the (min-x, min-y) origin corner deliberately has none.
    fiducials: [
      { xMm: baseWidthMm - inset - size / 2, yMm: inset + size / 2 },
      { xMm: baseWidthMm - inset - size / 2, yMm: baseHeightMm - inset - size / 2 },
      { xMm: inset + size / 2, yMm: baseHeightMm - inset - size / 2 },
    ],
    transitionXsMm: [spec.slowSegmentMm, spec.slowSegmentMm + spec.fastSegmentMm],
    lineStartXMm: spec.marginMm,
    lineStartYMm: (index: number) => spec.marginMm + index * spec.linePitchMm,
  }
}
