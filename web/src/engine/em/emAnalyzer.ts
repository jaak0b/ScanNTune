import type { Mat, OpenCv } from '../opencv'
import type { EmProgressCallback, EmTestSpec } from './types'
import { emCouponGeometry } from './types'
import { alignEmCoupon, mmToPx } from './fiducialAligner'
import type { EmAlignment } from './fiducialAligner'
import type { BlockMeasurement, EmMeasurement } from './gapMeasurer'
import { measureEmCoupon } from './gapMeasurer'
import { valueChannel } from '../cvUtils'
import { median } from '../math'
import { assessMeasurementBackdrop, detrendTones } from '../measurementBackdrop'
import type { BackdropAssessment, TonePoint } from '../measurementBackdrop'
import { evaluateScanSetResolution } from '../resolutionGate'
import { isotropicPxPerMm } from '../scannerCalibration'
import type { ScaleReference } from '../scannerCalibration'

// Top-level EM analysis: aligns the coupon, measures its comb geometry, and estimates the
// deposited bead width. The estimator per gap g between adjacent lines j, j+1 is the gap
// complement w = localPitch - g, where localPitch is the MEASURED centre spacing of the two
// lines: the material per pitch cell is what the air does not fill. Line centres are immune to
// width errors and to symmetric edge blur, so the estimator needs no assumed pitch and absorbs
// any printer axis stretch automatically (the stretch moves centres and gap edges together).
// The per-gap samples are pooled over both rows and all blocks, cleaned by the standard MAD
// outlier rule (reject |x - median| > 3.5 * 1.4826 * MAD, the normal-consistent MAD scale),
// and summarized by the median of the survivors.
//
// The block separators provide an independent cross-check at a different duty cycle: the same
// gap-complement estimator across each separator (centre distance of the flanking lines minus
// the measured separator width) must agree with the in-block estimate. `biasMm` reports that
// residual, the median of (measured separator width) - (centre distance - wMm): a nonzero value
// flags a systematic edge-measurement bias (e.g. asymmetric scanner bloom) that the coupon's
// geometry cannot itself correct, so it is surfaced as a diagnostic rather than subtracted.

/**
 * Per-scan diagnostics of one analyzed scan within an EM analysis, so the UI can report each
 * scan's alignment, orientation, and resolution as its own card when two scans are pooled.
 */
export interface EmScanDiagnostics {
  /** Why this scan stopped the analysis; null for a fully measured scan. */
  failureReason: string | null
  /** Geometrically measured scan scale from the solved affine; null before alignment. */
  measuredPxPerMm: number | null
  flipped: boolean
  rotationQuarterTurns: number
  /** Test blocks measured on this scan (0 before measurement). */
  blocksMeasured: number
  /** This scan's printer X-scale diagnostic; null before measurement. */
  pitchScale: number | null
}

export interface EmResult {
  success: boolean
  failureReason: string | null
  /** Deposited bead width in true mm: each scan's median after MAD rejection, combined as
   *  the equal-weight mean over the analyzed scans. Null on failure. */
  wMm: number | null
  /** Separator cross-check residual in mm; near zero when block and separator agree. */
  biasMm: number | null
  /**
   * Estimated one-sided edge shift in mm from a scanner-lamp penumbra (median left offset plus
   * median right offset). Zero for a symmetric edge spread; nonzero flags a lamp shadow that
   * biases the measured bead width. Null on failure.
   */
  flankAsymmetryMm: number | null
  /** True when the flank asymmetry implies a bead-width bias above the 1% flow-ratio action step. */
  shadowWarning: boolean
  /** Printer X-scale diagnostic (1 = perfect). */
  pitchScale: number | null
  /** Per-gap w estimates kept after rejection (diagnostics/overlay). */
  samples: { row: 0 | 1; blockIndex: number; wMm: number }[]
  blocksMeasured: number
  /**
   * Geometrically measured scan scale from the solved affine; null before alignment. With more
   * than one scan this and the two orientation fields describe the first scan; per-scan values
   * live in `scans`.
   */
  measuredPxPerMm: number | null
  flipped: boolean
  rotationQuarterTurns: number
  /** One entry per analyzed scan, in input order; a scan after a failed one is not listed. */
  scans: EmScanDiagnostics[]
}

const MIN_BLOCKS = 8
const MIN_SAMPLES = 30
const W_MIN_MM = 0.2
const W_MAX_MM = 2
/** Normal-consistency factor for the MAD (sigma = 1.4826 * MAD for Gaussian data). */
const MAD_TO_SIGMA = 1.4826
const MAD_CUTOFF = 3.5

/**
 * Analyzes an EM coupon scan. `alignmentHolder`, when given, receives the solved fiducial
 * alignment (successful or not) so callers such as the overlay renderer can place coupon-frame
 * geometry in scan pixels without re-running the aligner.
 */
export function analyzeEmCoupon(
  cv: OpenCv,
  imageBgr: Mat,
  spec: EmTestSpec,
  scanPxPerMm: ScaleReference,
  expectedDpi: number | null = null,
  alignmentHolder?: { alignment?: EmAlignment },
  onProgress?: EmProgressCallback,
): EmResult {
  return analyzeEmCoupons(
    cv,
    [imageBgr],
    spec,
    scanPxPerMm,
    expectedDpi,
    alignmentHolder ? [alignmentHolder] : undefined,
    onProgress,
  )
}

/**
 * Analyzes one or two scans of the SAME printed EM coupon. Each scan is aligned, measured,
 * cleaned, and summarized independently, and the per-scan medians are combined with equal
 * weight (the mean, a paired-design estimator). The optional second scan is the coupon
 * rotated on the glass, typically 180 degrees: a one-sided scanner-lamp bias then enters the
 * two orientations with opposite signs and cancels in the equal-weight combination. With one
 * image this is exactly the single-scan analysis. `result.scans` reports each scan's own
 * alignment, orientation, and resolution.
 */
export function analyzeEmCoupons(
  cv: OpenCv,
  imagesBgr: Mat[],
  spec: EmTestSpec,
  scanPxPerMm: ScaleReference,
  expectedDpi: number | null = null,
  alignmentHolders?: { alignment?: EmAlignment }[],
  onProgress?: EmProgressCallback,
): EmResult {
  if (imagesBgr.length === 0) throw new Error('At least one scan image is required.')
  for (const img of imagesBgr) {
    if (!img || img.empty()) throw new Error('Image is null or empty.')
  }

  // Failure reasons name the offending scan only when there is more than one to tell apart.
  const scanLabel = (i: number) => (imagesBgr.length > 1 ? `Scan ${i + 1}: ` : '')
  const scans: EmScanDiagnostics[] = []

  onProgress?.({ stage: 'align' })
  const alignments: EmAlignment[] = []
  for (let i = 0; i < imagesBgr.length; i++) {
    const alignment = alignEmCoupon(cv, imagesBgr[i], spec)
    const holder = alignmentHolders?.[i]
    if (holder) holder.alignment = alignment
    if (!alignment.success || !alignment.affine) {
      const reason = alignment.failureReason ?? 'The coupon could not be located in the scan.'
      scans.push(scanDiagnostics(alignment, null, reason))
      return failure(
        scanLabel(i) + reason,
        alignment.flipped,
        alignment.rotationQuarterTurns,
        null,
        scans,
      )
    }
    alignments.push(alignment)
    scans.push(scanDiagnostics(alignment, Math.hypot(alignment.affine.a, alignment.affine.c)))
  }

  const failAt = (i: number, reason: string) => {
    scans[i].failureReason = reason
    return failure(
      scanLabel(i) + reason,
      alignments[i].flipped,
      alignments[i].rotationQuarterTurns,
      scans[i].measuredPxPerMm,
      scans,
    )
  }

  // The affine's scale prices each scan's resolution: a scan too coarse for the sub-pixel gap
  // readout is refused, and a scan whose measured resolution disagrees with the calibration's
  // expected one is refused before any wrongly scaled numbers come out of it. The whole set is
  // judged together so that, without an expected resolution, the scans must agree among
  // themselves.
  const resolutions = evaluateScanSetResolution(
    scans.map((s) => ({ pxPerMm: s.measuredPxPerMm! })),
    expectedDpi != null && expectedDpi > 0
      ? { pxPerMm: isotropicPxPerMm(scanPxPerMm), dpi: expectedDpi }
      : null,
  )
  for (let i = 0; i < resolutions.length; i++) {
    if (!resolutions[i].ok) return failAt(i, resolutions[i].reason!)
  }

  onProgress?.({ stage: 'measure' })
  const measurements: EmMeasurement[] = []
  for (let i = 0; i < imagesBgr.length; i++) {
    const gray = valueChannel(cv, imagesBgr[i])
    let measurement
    try {
      // Measurement-backdrop gate: the floor showing through the comb gaps must present a single
      // tone that contrasts with the plastic, or every gap edge reads shifted (a dark textured
      // build plate behind the gaps biases the width wide).
      const backdrop = assessEmBackdrop(gray, alignments[i], spec)
      if (backdrop.failure) {
        return failAt(
          i,
        backdrop.failure === 'low-contrast'
          ? 'The backing showing through the coupon gaps is too similar in brightness to the plastic to measure against. Scan against a lighter backing: remove the part and use the lid or a sheet of paper, or print the coupon on a contrasting base.'
          : 'The backing showing through the coupon gaps is too uneven in brightness to measure against, which happens when a textured build plate shows through. Print the coupon on a contrasting base, or remove the part and scan it against the lid or a sheet of paper.',
        )
      }
      measurement = measureEmCoupon(cv, gray, alignments[i], spec, scanPxPerMm)
    } catch (error) {
      // A coupon that aligns but shows no readable comb is a normal bad-scan outcome for the
      // analyzer, reported as a failed result rather than an exception.
      if (error instanceof Error && error.message.startsWith('No test block')) {
        return failAt(i, error.message)
      }
      throw error
    } finally {
      gray.delete()
    }

    if (measurement.blocks.length < MIN_BLOCKS) {
      return failAt(
        i,
        `Only ${measurement.blocks.length} of the coupon's test blocks could be measured (at least ${MIN_BLOCKS} are needed). Rescan at a higher resolution with the coupon flat on the glass.`,
      )
    }
    measurements.push(measurement)
    scans[i].blocksMeasured = measurement.blocks.length
    scans[i].pitchScale = measurement.pitchScale
  }

  // Each scan is summarized on its own (the existing MAD cleaning, then the median of its
  // per-gap w samples) and the scans are combined with equal weight, as the mean of the
  // per-scan medians (a paired-design estimator). The two orientations of a 180 degree pair
  // carry opposite-sign lamp biases, and equal weighting cancels them exactly even when the
  // cleaning leaves the scans with unequal sample counts; a sample-level pool would lean
  // toward whichever scan kept more samples. With a single scan this is the plain cleaned
  // median, unchanged.
  const perScan = measurements.map((m) => cleanedScanSamples(m))
  const samples = perScan.flatMap((p) => p.samples)

  // Summary-stage refusals carry no single offending scan; they are reported on the last one.
  const lastScan = imagesBgr.length - 1
  if (samples.length < MIN_SAMPLES) {
    return failAt(
      lastScan,
      `Only ${samples.length} consistent width samples were found (at least ${MIN_SAMPLES} are needed). The scan is too noisy or the print too irregular; reprint or rescan the coupon.`,
    )
  }

  const wMm = mean(perScan.map((p) => p.wMm))
  if (!(wMm > W_MIN_MM && wMm < W_MAX_MM)) {
    return failAt(
      lastScan,
      `The measured bead width (${wMm.toFixed(3)} mm) is outside the plausible ${W_MIN_MM} to ${W_MAX_MM} mm range. The scan probably does not show a valid EM coupon.`,
    )
  }

  const flankAsymmetryMm = flankAsymmetry(measurements)

  return {
    success: true,
    failureReason: null,
    wMm,
    biasMm: separatorBiasMm(measurements, spec, wMm),
    flankAsymmetryMm,
    // A symmetric point spread shifts both flanks equally and oppositely, so the two medians sum
    // to zero; a one-sided lamp penumbra shifts one flank only, and that residual tracks
    // the bead-width bias (each gap loses the shift, w gains it). Warn once the implied error
    // exceeds one percent of the width, the smallest flow-ratio step a user acts on; a benign
    // scan's baseline asymmetry sits an order of magnitude below that. The per-scan asymmetries
    // are combined with equal weight, so a lamp bias that cancels between two orientations does
    // not warn.
    shadowWarning: flankAsymmetryMm !== null && Math.abs(flankAsymmetryMm) > 0.01 * wMm,
    pitchScale: median(measurements.map((m) => m.pitchScale)),
    samples,
    blocksMeasured: measurements.reduce((sum, m) => sum + m.blocks.length, 0),
    measuredPxPerMm: scans[0].measuredPxPerMm,
    flipped: alignments[0].flipped,
    rotationQuarterTurns: alignments[0].rotationQuarterTurns,
    scans,
  }
}

function scanDiagnostics(
  alignment: EmAlignment,
  measuredPxPerMm: number | null,
  failureReason: string | null = null,
): EmScanDiagnostics {
  return {
    failureReason,
    measuredPxPerMm,
    flipped: alignment.flipped,
    rotationQuarterTurns: alignment.rotationQuarterTurns,
    blocksMeasured: 0,
    pitchScale: null,
  }
}

// The separator cross-check residual: each measured separator width is compared against the
// width the flanking line centres and the estimated bead width imply (centre distance - wMm),
// and the median residual is returned. Zero means the separators and the in-block gaps tell the
// same story; a systematic offset flags an edge-measurement bias the coupon cannot correct.
// Returns null when no separator has both flanking blocks measured. The residuals are pooled
// over all analyzed scans before the median.
function separatorBiasMm(
  measurements: EmMeasurement[],
  spec: EmTestSpec,
  wMm: number,
): number | null {
  // Visual (along +X) position of a block in its row: the top row is laid out in pitch order,
  // the bottom row reversed (see emCouponGeometry/buildRow).
  const visualPos = (b: BlockMeasurement) =>
    b.row === 0 ? b.blockIndex : spec.blockCount - 1 - b.blockIndex

  const residuals: number[] = []
  for (const measurement of measurements) {
    const byPos = new Map<string, BlockMeasurement>()
    for (const b of measurement.blocks) byPos.set(`${b.row}:${visualPos(b)}`, b)

    for (const s of measurement.separators) {
      const left = byPos.get(`${s.row}:${s.index}`)
      const right = byPos.get(`${s.row}:${s.index + 1}`)
      if (!left || !right) continue
      const centerDistMm =
        right.lineCentersMm[0] - left.lineCentersMm[left.lineCentersMm.length - 1]
      residuals.push(s.widthMm - (centerDistMm - wMm))
    }
  }
  return residuals.length > 0 ? median(residuals) : null
}

// The one-sided scanner-lamp shadow estimate: the sum of the median left-flank and median
// right-flank sub-pixel edge offsets. A symmetric edge spread widens both flanks equally and
// oppositely, so the medians cancel; a one-sided penumbra shifts a single flank, leaving a
// nonzero sum that equals the bead-width bias. Null when no flank offsets were collected.
// Samples plastic tones on the frame band and rail, and backdrop tones at every commanded gap
// midpoint of both comb rows plus the three fiducial holes, all through the solved affine, and
// judges them with the shared measurement-backdrop gate.
function assessEmBackdrop(
  gray: { data: unknown; cols: number; rows: number },
  alignment: EmAlignment,
  spec: EmTestSpec,
): BackdropAssessment {
  const g = emCouponGeometry(spec)
  const data = gray.data as Uint8Array
  // Backdrop tones keep their scan-pixel position so a smooth spatial trend can be removed.
  const sample = (xMm: number, yMm: number): TonePoint | null => {
    const p = mmToPx(alignment, xMm, yMm)
    const x = Math.round(p.x)
    const y = Math.round(p.y)
    if (x < 0 || y < 0 || x >= gray.cols || y >= gray.rows) return null
    return { x, y, tone: data[y * gray.cols + x] }
  }

  const plastic: number[] = []
  const band = g.frameBandMm
  // Frame band midpoints along all four sides, and the rail centreline.
  for (let t = 0.1; t <= 0.9; t += 0.1) {
    plastic.push(
      sample(g.couponWidthMm * t, band / 2)?.tone ?? NaN,
      sample(g.couponWidthMm * t, g.couponHeightMm - band / 2)?.tone ?? NaN,
      sample(g.couponWidthMm * t, (g.railY0Mm + g.railY1Mm) / 2)?.tone ?? NaN,
    )
    plastic.push(
      sample(band / 2, g.couponHeightMm * t)?.tone ?? NaN,
      sample(g.couponWidthMm - band / 2, g.couponHeightMm * t)?.tone ?? NaN,
    )
  }

  const backdrop: TonePoint[] = []
  const rowYs: [typeof g.topRow, number][] = [
    [g.topRow, (g.topRowY0Mm + g.topRowY1Mm) / 2],
    [g.bottomRow, (g.bottomRowY0Mm + g.bottomRowY1Mm) / 2],
  ]
  for (const [rowBlocks, yMm] of rowYs) {
    for (const block of rowBlocks) {
      for (let j = 0; j + 1 < block.lineXsMm.length; j++) {
        const p = sample((block.lineXsMm[j] + block.lineXsMm[j + 1]) / 2, yMm)
        if (p) backdrop.push(p)
      }
    }
  }
  for (const f of g.fiducials) {
    const p = sample(f.xMm, f.yMm)
    if (p) backdrop.push(p)
  }

  // Least squares detrend (first-degree polynomial over the scan coordinates): a smooth
  // low-frequency brightness gradient from one-sided scanner-lamp shading is measurable and must
  // not trip the unevenness refusal, so the spread criterion is applied to the residuals only.
  // High-frequency unevenness (a textured build plate) survives the detrend and still fails.
  return assessMeasurementBackdrop(plastic.filter(Number.isFinite), detrendTones(backdrop))
}

const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length

/**
 * One scan's cleaned width samples and their median: one w sample per gap (the measured
 * local pitch between adjacent line centres minus the gap), MAD outlier cleaning, median.
 * This is the original single-scan summary, factored out so multi-scan analyses can combine
 * the per-scan medians with equal weight.
 */
function cleanedScanSamples(measurement: EmMeasurement): {
  samples: { row: 0 | 1; blockIndex: number; wMm: number }[]
  wMm: number
} {
  const all: { row: 0 | 1; blockIndex: number; wMm: number }[] = []
  for (const b of measurement.blocks) {
    for (let j = 0; j < b.gapsMm.length; j++) {
      const localPitch = b.lineCentersMm[j + 1] - b.lineCentersMm[j]
      all.push({ row: b.row, blockIndex: b.blockIndex, wMm: localPitch - b.gapsMm[j] })
    }
  }
  const values = all.map((s) => s.wMm)
  const center = median(values)
  const mad = median(values.map((v) => Math.abs(v - center)))
  const cutoff = MAD_CUTOFF * MAD_TO_SIGMA * mad
  // A zero MAD means over half the samples agree exactly; keep those rather than reject all.
  const samples =
    mad > 0 ? all.filter((s) => Math.abs(s.wMm - center) <= cutoff) : all.filter((s) => s.wMm === center)
  return { samples, wMm: median(samples.map((s) => s.wMm)) }
}

// Each scan's asymmetry (its median left flank offset plus median right flank offset) is
// combined as an equal-weight mean, matching the width estimator: a lamp-side shift that
// enters two orientations with opposite signs cancels here regardless of how many flank
// samples each scan kept.
function flankAsymmetry(measurements: EmMeasurement[]): number | null {
  const perScan = measurements
    .map((m) =>
      m.leftFlankOffsetsMm.length > 0 && m.rightFlankOffsetsMm.length > 0
        ? median(m.leftFlankOffsetsMm) + median(m.rightFlankOffsetsMm)
        : null,
    )
    .filter((v): v is number => v !== null)
  return perScan.length === 0 ? null : mean(perScan)
}

function failure(
  reason: string,
  flipped: boolean,
  rotationQuarterTurns: number,
  measuredPxPerMm: number | null = null,
  scans: EmScanDiagnostics[] = [],
): EmResult {
  return {
    success: false,
    failureReason: reason,
    wMm: null,
    biasMm: null,
    flankAsymmetryMm: null,
    shadowWarning: false,
    pitchScale: null,
    samples: [],
    blocksMeasured: 0,
    measuredPxPerMm,
    flipped,
    rotationQuarterTurns,
    scans,
  }
}
