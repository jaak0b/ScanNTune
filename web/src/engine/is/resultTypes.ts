import type { IsAxis } from './types'
import type { ShaperOption } from './shaperRecommender'

/** A point in scan-image pixels. Plain data so it survives the worker boundary. */
export interface IsPointPx {
  x: number
  y: number
}

/**
 * Per-line outcome of one axis group's trace, in the scan the axis was read from. The
 * endpoints span the traced stretch of the measured segment; for a line that could not be
 * traced at all they are its EXPECTED position from the coupon geometry mapped through the
 * alignment, so a damaged or missing line can still be pointed at in the overlay. They are
 * null only when the axis was never assigned a scan.
 */
export interface IsLineOutcome {
  /** Index of the line within its axis group (geometry order). */
  lineIndex: number
  axis: IsAxis
  speedMmS: number
  /** True when the tracer could follow the line's bead in the scan. */
  traced: boolean
  /** True when the line's ringing fit passed every per-line gate. */
  accepted: boolean
  /** User-worded reason the line was not used; null for an accepted line. */
  refusalReason: string | null
  startPx: IsPointPx | null
  endPx: IsPointPx | null
}

/** Per-machine-axis outcome of the input shaper measurement. */
export interface IsAxisResult {
  axis: IsAxis
  /** True when the axis produced a trustworthy frequency and damping estimate. */
  accepted: boolean
  /** User-worded reasons the axis (or individual lines) could not be measured. */
  refusals: string[]
  frequencyHz: number | null
  dampingRatio: number | null
  /** 95% confidence halfwidth of the frequency, Hz. */
  frequencyCi95Hz: number | null
  /** Median initial ring amplitude of the accepted lines, mm (diagnostic). */
  amplitudeMm: number | null
  linesUsed: number
  linesTraced: number
  /** Index of the scan (0 or 1) the axis was measured from; null when neither qualified. */
  scanIndex: 0 | 1 | null
  /** Per-line trace outcomes, one entry per geometry line of the axis group. */
  lines: IsLineOutcome[]
  /** All shaper options at the measured resonance; null when the axis was refused. */
  shapers: ShaperOption[] | null
  /** The recommended shaper per the selection rule; null when the axis was refused. */
  recommended: ShaperOption | null
}

/**
 * Alignment and orientation diagnostics of one analyzed scan. A scan that failed to align
 * still gets an entry reporting how far its alignment progressed; scans the analysis never
 * reached get none.
 */
export interface IsScanInfo {
  /** True when the coupon plate and its three corner fiducial holes were located. */
  fiducialsFound: boolean
  /** True when the coupon orientation was solved; `flipped` and `rotationQuarterTurns` are
   *  only meaningful when this is true. */
  orientationSolved: boolean
  flipped: boolean
  rotationQuarterTurns: number
  /** Geometrically measured scan scale from the solved affine; null when no affine solved. */
  measuredPxPerMm: number | null
}

/**
 * Result of the two-scan input shaper analysis. `aligned: false` with a `failureReason` is the
 * normal outcome for a scan pair that cannot be aligned; per-axis measurement problems are
 * refusals inside `axes`, not alignment failures.
 */
export interface IsResult {
  aligned: boolean
  failureReason: string | null
  scans: IsScanInfo[]
  axes: IsAxisResult[]
}
