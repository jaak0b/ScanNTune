import type { IsAxis } from './types'
import type { ShaperOption } from './shaperRecommender'
import type { LineFitRefusalCategory, LineJointExclusion } from './ringAnalyzer'

/**
 * Why a line was left out of the axis's joint fit, as a category the UI can count and label:
 * the fit-level categories, 'frequency-outlier' for a line whose own fitted frequency lies
 * far from the other lines', and 'not-traced' for a line the tracer never followed.
 */
export type IsLineRefusalCategory = LineFitRefusalCategory | 'frequency-outlier' | 'not-traced'

/**
 * Why a line was excluded from the axis's joint fit: the fit-level exclusions plus
 * 'not-traced' for a line the tracer never followed.
 */
export type IsLineExclusion = LineJointExclusion | 'not-traced'

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
  /** The line's rung of the corner-speed excitation ladder, mm/s (the spec's corner
   *  speed on every line when the sweep is enabled). */
  cornerSpeedMmS: number
  /** True when the tracer could follow the line's bead in the scan. */
  traced: boolean
  /** True when the line entered the joint fit of a measured axis. */
  accepted: boolean
  /** True when the line's record entered the axis's joint ringing fit. */
  usedInJointFit: boolean
  /** Why the line was excluded from the joint fit; null for a line that entered it, and
   *  for a line never attempted because its axis was not assigned a scan. */
  exclusion: IsLineExclusion | null
  /** User-worded reason the line was left out of the joint fit; null for a line that entered
   *  it (whether or not its axis was measured), and for a line never attempted because its
   *  axis was not assigned a scan. */
  refusalReason: string | null
  /** Category of refusalReason for counting and labeling; null exactly when it is null. */
  refusalCategory: IsLineRefusalCategory | null
  /** The line's own fitted ringing frequency, Hz (diagnostic); null without a per-line fit. */
  frequencyHz: number | null
  /** The line's ring amplitude at the start of its free ringdown (its fit-window start), mm:
   *  from the joint fit when the line entered it, else from its own fit; null without
   *  either. */
  amplitudeMm: number | null
  startPx: IsPointPx | null
  endPx: IsPointPx | null
}

/** Per-machine-axis outcome of the input shaper measurement. */
export interface IsAxisResult {
  axis: IsAxis
  /** True when the axis produced a trustworthy frequency and damping estimate. */
  accepted: boolean
  /** User-worded axis-level reasons the axis could not be measured; per-line reasons live
   *  in `lines`, summarized by their categories. */
  refusals: string[]
  frequencyHz: number | null
  dampingRatio: number | null
  /** 95% confidence halfwidth of the frequency, Hz. */
  frequencyCi95Hz: number | null
  /** Standard error of the jointly fitted frequency, Hz. */
  frequencySeHz: number | null
  /** Extra-sum-of-squares F statistic of the joint ring fit against drift only. */
  fStatistic: number | null
  /** Median over every line in the joint fit of that line's ring amplitude at the start of
   *  its fit window (the start of the free ringdown), mm (diagnostic). */
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
