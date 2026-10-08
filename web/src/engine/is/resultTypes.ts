import type { IsAxis } from './types'
import type { ShaperOption } from './shaperRecommender'
import type { LineFitRefusalCategory, LineJointExclusion, SecondMode } from './ringAnalyzer'
import type { DetectedArtifact } from './artifactSearch'
import type { CornerModelKind } from './ringRegressors'

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

/** Outcome of a check: assessed and passed or failed, or not assessed (too little data, or the
 *  coupon layout does not support it). */
export type CheckState = 'passed' | 'failed' | 'not-assessed'

/**
 * The two-tier speed check: 'confirmed' when the frequency is demonstrably the same at both
 * speeds (the arc-length pattern hypothesis rejected, no change detected), 'changed' when it
 * demonstrably changed with the speed, 'not-confirmed' when a tier showed no ringing or the
 * precision decides neither, 'not-assessed' with one tier.
 */
export type SpeedCheckState = 'confirmed' | 'changed' | 'not-confirmed' | 'not-assessed'

/**
 * The along-track lag correction of an axis (ringAnalyzer.poolCouponAxes): 'corrected' when its
 * estimate is corrected for the other axis's ring shifting the nozzle along its lines,
 * 'other-axis-not-measured' when the other axis has no accepted ring to correct with (refused, or
 * not on the coupon), 'joint-fit-failed' when the joint fit of both axes could not be completed
 * (it did not settle, left too few lines, or left no standard error).
 */
export type AlongTrackLagState = 'corrected' | 'other-axis-not-measured' | 'joint-fit-failed'

/** One speed tier's part of the speed check. */
export interface TierCheck {
  speedMmS: number
  /** True when the tier's own lines show the ringing near the axis estimate. */
  detected: boolean
  /** Bonferroni bound of the tier's local detection; null when the tier had no lines. */
  detectionPBound: number | null
  frequencyHz: number | null
  frequencySeHz: number | null
}

export interface SpeedCheck {
  state: SpeedCheckState
  /** Slowest tier first; empty when not assessed. */
  tiers: TierCheck[]
}

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
  /** The line's rung of the corner-speed excitation ladder, mm/s. */
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
  /** True when ringing is detected on this line alone (its detection bound at the flow's
   *  false-alarm level). */
  detected: boolean
  /** Bonferroni bound of the line's own detection statistic; null without a fit window. */
  detectionPBound: number | null
  /** The line's own fitted ringing frequency, Hz (diagnostic); null for a line without
   *  detected ringing. */
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
  /** Standard error of the jointly fitted frequency, Hz (statistical error only). */
  frequencySeHz: number | null
  /** Bonferroni bound of the axis detection over the whole search grid; null when no line had a
   *  fit window. */
  detectionPBound: number | null
  /** Lines whose own detection bound passed the flow's false-alarm level. */
  linesDetected: number
  /** Whether the zeta = 0 boundary test found the ring decaying; null when not fitted. */
  decayDemonstrated: boolean | null
  /** Input proportionality: 'passed' when the ring grows with the corner speed. */
  proportionality: CheckState
  speedCheck: SpeedCheck
  replicateCheck: CheckState
  /** One-tier check that the detection survives leaving out any one line. */
  influenceCheck: CheckState
  /** Whether a change point in the lines' lateral offsets along the print order shows a layer
   *  shift; null when too few lines were traced to test. */
  layerShiftDetected: boolean | null
  /** Median over every line in the joint fit of that line's ring amplitude at the start of
   *  its fit window (the start of the free ringdown), mm (diagnostic). */
  amplitudeMm: number | null
  /** Bonferroni bound of the search for a second mode with the first one in the null design;
   *  null when the axis was refused. */
  secondModePBound: number | null
  /** The axis's second mode when the search detected one; the axis's own frequency and damping
   *  are then the dominant mode's. Its proportionality 'failed' marks a steady tone, which the
   *  shaper selection ignores. */
  secondMode: SecondMode | null
  /** The residual vibration Marlin's ZV shaper at the dominant mode leaves at the second mode, as
   *  a fraction; null without a second mode. */
  zvSecondModeResidual: number | null
  /** Arc-length artifacts (belt teeth, JPEG blocks, other stationary patterns of the print or the
   *  scan) the analysis detected and carried in its model; empty without a search. */
  artifacts: DetectedArtifact[]
  /** The corner model the analysis chose and its scale (flow-lag time constant in seconds, or
   *  bead-drag length in millimetres); null when the axis had too few lines to fit. */
  cornerModel: { kind: CornerModelKind; scale: number } | null
  /** The along-track lag correction of the estimate; null when this axis was refused before its
   *  ring was fitted. */
  alongTrackLag: AlongTrackLagState | null
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
