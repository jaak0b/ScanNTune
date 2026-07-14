// Core engine types, ported from ScanNTune.Core (C#). Pure TypeScript: no Vue, no DOM.
// Scale figures are percentage errors (measured vs nominal; positive = oversize). Skew is the
// corner-angle error in degrees (measured minus the nominal 90; positive = opened past square,
// negative = closed, i.e. sheared x' = x + t*y).

export interface CouponSpec {
  /** Centre-to-centre span of the outermost rings (mm). */
  baselineMm: number
  /** Rings per side; the grid is gridN x gridN. */
  gridN: number
  ringOuterDiameterMm: number
  ringWallMm: number
  /** Width of the lattice ribs, including the plane-ID diagonals (mm, flat-plate nominal). */
  ribWidthMm: number
}

export function defaultCouponSpec(): CouponSpec {
  return { baselineMm: 100, gridN: 5, ringOuterDiameterMm: 9, ringWallMm: 2, ribWidthMm: 2.5 }
}

/** Centre-to-centre distance between neighbouring rings. */
export function couponPitchMm(s: CouponSpec): number {
  return s.baselineMm / (s.gridN - 1)
}

export function couponInnerDiameterMm(s: CouponSpec): number {
  return s.ringOuterDiameterMm - 2 * s.ringWallMm
}

/**
 * Which pair of printer axes a coupon plate measures. XY is the flat plate; XZ and YZ are the
 * standing plates. The plate's first in-plane axis (the marker's +X) maps to the first letter and
 * the perpendicular to the second: XY -> (X, Y), XZ -> (X, Z), YZ -> (Y, Z).
 */
export type Plane = 'XY' | 'XZ' | 'YZ'

/** The two physical axes a plane measures, first = marker +X, second = perpendicular. */
export function planeAxes(p: Plane): ['X' | 'Y' | 'Z', 'X' | 'Y' | 'Z'] {
  return p === 'XY' ? ['X', 'Y'] : p === 'XZ' ? ['X', 'Z'] : ['Y', 'Z']
}

/** A ring located in the scan; the sub-pixel centre drives scale/skew (extrusion-immune). */
export interface DetectedRing {
  centerX: number
  centerY: number
  radiusPx: number
  circularity: number
}

/**
 * The coupon's pose in the image: origin fiducial and the +X unit vector (image-y downward).
 * `flipped` is false when the plate's designed scan face (the first layer, for the flat plate)
 * was on the scanner glass, true when it was scanned on the wrong face.
 */
export interface Orientation {
  flipped: boolean
  originX: number
  originY: number
  xAxisX: number
  xAxisY: number
}

/** Angle of the +X axis in image degrees (0 = right, 90 = down). */
export function xAxisAngleDegrees(o: Orientation): number {
  return (Math.atan2(o.xAxisY, o.xAxisX) * 180) / Math.PI
}

export interface AffineModel {
  scaleXPxPerMm: number
  scaleYPxPerMm: number
  skewDegrees: number
  rmsResidualPx: number
  pointCount: number
  // The fitted transform itself (px = a*mmX + b*mmY + tx, py = c*mmX + d*mmY + ty), so callers can
  // project nominal coupon positions into the image (e.g. where a missing hole should have been).
  a: number
  b: number
  c: number
  d: number
  tx: number
  ty: number
}

/** Projects a nominal coupon position (mm) into the image (px) through the fitted transform. */
export function projectMmToPx(m: AffineModel, mmX: number, mmY: number): { x: number; y: number } {
  return { x: m.a * mmX + m.b * mmY + m.tx, y: m.c * mmX + m.d * mmY + m.ty }
}

/** One ring matched to its nominal grid place. Col runs along +X, row along +Y. */
export interface GridCorrespondence {
  col: number
  row: number
  nominalXmm: number
  nominalYmm: number
  measuredXpx: number
  measuredYpx: number
}

export interface GridMapping {
  points: GridCorrespondence[]
  originX: number
  originY: number
  xAxisX: number
  xAxisY: number
  flipped: boolean
}

/**
 * The complete outcome of analysing one scan. Always produced (analyzeCoupon never throws for a scan
 * it merely can't align): the detection fields are always set, and the measurement fields are null
 * until the coupon aligns. `aligned` is the discriminator; `asAligned` narrows to a result whose
 * measurement is guaranteed present, which is all the combine math ever receives (the Analyze button
 * only lets aligned scans through).
 */
export interface CalibrationResult {
  // Detection: always present, even on a scan that could not be aligned.
  rings: DetectedRing[]
  ringsDetected: number
  ringsExpected: number
  clippedSides: ClipSide[]
  aligned: boolean
  /** Why the scan could not be aligned, worded for the user; null when aligned. */
  failureReason: string | null
  // Measurement: null unless the coupon aligned.
  orientation: Orientation | null
  /** The plate's plane from the diagonal-rib code; null when not aligned or the code wasn't read. */
  plane: Plane | null
  measuredPxPerMmX: number | null
  measuredPxPerMmY: number | null
  skewDegrees: number | null
  rmsResidualPx: number | null
  xScalePercent: number | null
  yScalePercent: number | null
}

/** A CalibrationResult whose measurement is present. The combine math operates on these only. */
export interface AlignedResult extends CalibrationResult {
  aligned: true
  failureReason: null
  orientation: Orientation
  measuredPxPerMmX: number
  measuredPxPerMmY: number
  skewDegrees: number
  rmsResidualPx: number
  xScalePercent: number
  yScalePercent: number
}

export function asAligned(result: CalibrationResult): AlignedResult {
  if (!result.aligned) throw new Error('Expected an aligned calibration result.')
  return result as AlignedResult
}

export type RingSeverity = 'ok' | 'warning' | 'error'
export type ClipSide = 'left' | 'right' | 'top' | 'bottom'

export interface ScannerDiagnostic {
  anisotropyPercent: number
  skewDegrees: number
}

/**
 * Standard error and 95% confidence range half-width of one fitted printer figure. The unit is the
 * figure's own: percent for the scale figures, degrees for skew. The range around the reported
 * estimate is [estimate - rangeHalfWidth, estimate + rangeHalfWidth].
 */
export interface FigureUncertainty {
  standardError: number
  rangeHalfWidth: number
}

/**
 * Per-figure uncertainty of the fitted printer terms, from the least-squares residuals with the
 * scale (percent) and skew (degrees) observation channels weighted by their own residual variances.
 * Only defined with enough scans for both channels to have residual degrees of freedom (four or
 * more scans of the plate); null below that.
 */
export interface CombineUncertainty {
  /** Scale along the plate's first in-plane axis (percent). */
  scaleX: FigureUncertainty
  /** Scale along the plate's second in-plane axis (percent). */
  scaleY: FigureUncertainty
  /** The plate's skew (degrees). */
  skew: FigureUncertainty
  /** Effective residual degrees of freedom of the scale channel (hat-matrix trace). */
  scaleDof: number
  /** Effective residual degrees of freedom of the skew channel (hat-matrix trace). */
  skewDof: number
  /** The confidence level of the range half-widths (0.95). */
  confidenceLevel: number
  /** How many scans of the plate went into the fit. */
  scanCount: number
}

/**
 * The result of separating printer and scanner error over N scans of one plate (N >= 2). The scans
 * were taken at different placement angles on the glass; the least-squares fit recovers the printer
 * terms (fixed to the coupon) and the scanner terms (fixed to the glass, rotating through the
 * measurements with twice the placement angle).
 */
export interface ScanSetResult {
  combined: AlignedResult
  scanner: ScannerDiagnostic
  scans: AlignedResult[]
  /** Each scan's measured placement angle (degrees, [0, 360), image frame). */
  scanAnglesDegrees: number[]
  /** Largest pairwise turn separation in the error-separation sense (degrees, 0 to 90). */
  angleSpreadDegrees: number
  /** False when the angle spread is too small to separate the errors, or on a flip mismatch. */
  rotationLooksValid: boolean
  flipMismatch: boolean
  /** Why the set could not be separated, worded for the user; null when the fit is valid. */
  failureReason: string | null
  uncertainty: CombineUncertainty | null
}

/** One plane's finished scan-set analysis, tagged with which plane it measures. */
export interface PlaneAnalysis {
  plane: Plane
  scanSet: ScanSetResult
}

/** A physical-axis scale error, reconciled across the plates that measured it. */
export interface AxisScale {
  axis: 'X' | 'Y' | 'Z'
  scalePercent: number
  /** The plane(s) whose measurement was averaged into this figure. */
  sources: Plane[]
}

/** One plane's skew (the corner-angle error, degrees). */
export interface PlaneSkew {
  plane: Plane
  skewDegrees: number
}

/** The whole-printer result: every uploaded plane, its skew, and the reconciled per-axis scales. */
export interface MultiPlaneResult {
  planes: PlaneAnalysis[]
  skews: PlaneSkew[]
  scales: AxisScale[]
}

export interface AnalysisOptions {
  coupon: CouponSpec
  /**
   * True scale of the source image in pixels per millimetre (scanner DPI / 25.4, or a reference
   * object). Required for absolute X/Y shrinkage; when null, anisotropy and skew only.
   */
  pxPerMm?: number | null
  currentStepsPerMmX?: number | null
  currentStepsPerMmY?: number | null
  currentRotationDistanceX?: number | null
  currentRotationDistanceY?: number | null
}

/** An image axis of a scan: horizontal is the image x axis, vertical the image y axis. */
export type ScanAxis = 'horizontal' | 'vertical'

/** The outcome of measuring a known-length reference (a bank card) in a scan. */
export interface ScaleReferenceResult {
  success: boolean
  pxPerMm: number
  /** The image axis the card's long side lay along; set on success. */
  measuredAxis?: ScanAxis
  measuredWidthPx: number
  detectedMm: number
  straightnessPx: number
  parallelismDegrees: number
  edgePointCount: number
  message?: string | null
  /**
   * On failure only: the long side (px) of the best card-shaped candidate that was rejected by the
   * size gate, so the caller can diagnose a scan taken at a different resolution than entered.
   * Null or absent when nothing card-shaped was seen at any size.
   */
  rejectedLongSidePx?: number | null
}

/**
 * How the scanner's scale error distributes over the two image axes. A CIS scanner distorts both
 * axes equally, so the card-measured px/mm applies isotropically. A CCD scanner is accurate along
 * the carriage axis and mis-scaled along the sensor axis (its reduction optics set that axis's
 * magnification), so the card measurement applies only to the image axis the card's long side was
 * measured along, and the other axis stays at the nominal DPI.
 */
export type ScannerType = 'CIS' | 'CCD'

/** A stored scanner calibration; the true px/mm recovered from a known-length reference. */
export interface ScannerCalibration {
  pxPerMm: number
  dpi: number
  referenceMm: number
  measuredWidthPx: number
  straightnessPx: number
  parallelismDegrees: number
  /** ISO-8601 UTC timestamp. */
  calibratedUtc: string
  /** Absent on calibrations stored before the toggle existed; treated as CIS. */
  scannerType?: ScannerType
  /** The image axis the card was measured along; absent on older calibrations (horizontal). */
  measuredAxis?: ScanAxis
}

/** A ready-to-apply firmware/slicer correction: the snippet to copy and a note on where it goes. */
export interface Correction {
  code: string
  hint: string
  primaryCaption?: string | null
  secondaryCaption?: string | null
  secondaryCode?: string | null
}
