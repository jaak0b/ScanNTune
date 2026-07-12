import type { Mat, OpenCv } from '../opencv'
import type { EmProgressCallback, EmTestSpec } from './types'
import { emCouponGeometry } from './types'
import { alignEmCoupon, mmToPx } from './fiducialAligner'
import type { EmAlignment } from './fiducialAligner'
import type { BlockMeasurement, EmMeasurement } from './gapMeasurer'
import { measureEmCoupon } from './gapMeasurer'
import { valueChannel } from '../cvUtils'
import { median } from '../math'
import { assessMeasurementBackdrop } from '../measurementBackdrop'
import type { BackdropAssessment } from '../measurementBackdrop'
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

export interface EmResult {
  success: boolean
  failureReason: string | null
  /** Deposited bead width in true mm (median after MAD rejection), null on failure. */
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
  /** Geometrically measured scan scale from the solved affine; null before alignment. */
  measuredPxPerMm: number | null
  flipped: boolean
  rotationQuarterTurns: number
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
  if (!imageBgr || imageBgr.empty()) throw new Error('Image is null or empty.')

  onProgress?.({ stage: 'align' })
  const alignment = alignEmCoupon(cv, imageBgr, spec)
  if (alignmentHolder) alignmentHolder.alignment = alignment
  if (!alignment.success || !alignment.affine) {
    return failure(
      alignment.failureReason ?? 'The coupon could not be located in the scan.',
      alignment.flipped,
      alignment.rotationQuarterTurns,
    )
  }

  const measuredPxPerMm = Math.hypot(alignment.affine.a, alignment.affine.c)
  const fail = (reason: string) =>
    failure(reason, alignment.flipped, alignment.rotationQuarterTurns, measuredPxPerMm)

  // The affine's scale prices the scan's resolution: a scan too coarse for the sub-pixel gap
  // readout is refused, and a scan whose measured resolution disagrees with the calibration's
  // expected one is refused before any wrongly scaled numbers come out of it.
  const [resolution] = evaluateScanSetResolution(
    [{ pxPerMm: measuredPxPerMm }],
    expectedDpi != null && expectedDpi > 0
      ? { pxPerMm: isotropicPxPerMm(scanPxPerMm), dpi: expectedDpi }
      : null,
  )
  if (!resolution.ok) return fail(resolution.reason!)

  onProgress?.({ stage: 'measure' })
  const gray = valueChannel(cv, imageBgr)
  let measurement
  try {
    // Measurement-backdrop gate: the floor showing through the comb gaps must present a single
    // tone that contrasts with the plastic, or every gap edge reads shifted (a dark textured
    // build plate behind the gaps biases the width wide).
    const backdrop = assessEmBackdrop(gray, alignment, spec)
    if (backdrop.failure) {
      return fail(
        backdrop.failure === 'low-contrast'
          ? 'The backing showing through the coupon gaps is too similar in brightness to the plastic to measure against. Scan against a lighter backing: remove the part and use the lid or a sheet of paper, or print the coupon on a contrasting base.'
          : 'The backing showing through the coupon gaps is too uneven in brightness to measure against, which happens when a textured build plate shows through. Print the coupon on a contrasting base, or remove the part and scan it against the lid or a sheet of paper.',
      )
    }
    measurement = measureEmCoupon(cv, gray, alignment, spec, scanPxPerMm)
  } catch (error) {
    // A coupon that aligns but shows no readable comb is a normal bad-scan outcome for the
    // analyzer, reported as a failed result rather than an exception.
    if (error instanceof Error && error.message.startsWith('No test block')) {
      return fail(error.message)
    }
    throw error
  } finally {
    gray.delete()
  }

  if (measurement.blocks.length < MIN_BLOCKS) {
    return fail(
      `Only ${measurement.blocks.length} of the coupon's test blocks could be measured (at least ${MIN_BLOCKS} are needed). Rescan at a higher resolution with the coupon flat on the glass.`,
    )
  }

  // One w sample per gap: the measured local pitch (adjacent line centres) minus the gap.
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

  if (samples.length < MIN_SAMPLES) {
    return fail(
      `Only ${samples.length} consistent width samples were found (at least ${MIN_SAMPLES} are needed). The scan is too noisy or the print too irregular; reprint or rescan the coupon.`,
    )
  }

  const wMm = median(samples.map((s) => s.wMm))
  if (!(wMm > W_MIN_MM && wMm < W_MAX_MM)) {
    return fail(
      `The measured bead width (${wMm.toFixed(3)} mm) is outside the plausible ${W_MIN_MM} to ${W_MAX_MM} mm range. The scan probably does not show a valid EM coupon.`,
    )
  }

  const flankAsymmetryMm = flankAsymmetry(measurement)

  return {
    success: true,
    failureReason: null,
    wMm,
    biasMm: separatorBiasMm(measurement, spec, wMm),
    flankAsymmetryMm,
    // A symmetric point spread shifts both flanks equally and oppositely, so the two medians sum
    // to zero; a one-sided lamp penumbra shifts one flank only, and that residual tracks
    // the bead-width bias (each gap loses the shift, w gains it). Warn once the implied error
    // exceeds one percent of the width, the smallest flow-ratio step a user acts on; a benign
    // scan's baseline asymmetry sits an order of magnitude below that.
    shadowWarning: flankAsymmetryMm !== null && Math.abs(flankAsymmetryMm) > 0.01 * wMm,
    pitchScale: measurement.pitchScale,
    samples,
    blocksMeasured: measurement.blocks.length,
    measuredPxPerMm,
    flipped: alignment.flipped,
    rotationQuarterTurns: alignment.rotationQuarterTurns,
  }
}

// The separator cross-check residual: each measured separator width is compared against the
// width the flanking line centres and the estimated bead width imply (centre distance - wMm),
// and the median residual is returned. Zero means the separators and the in-block gaps tell the
// same story; a systematic offset flags an edge-measurement bias the coupon cannot correct.
// Returns null when no separator has both flanking blocks measured.
function separatorBiasMm(
  measurement: EmMeasurement,
  spec: EmTestSpec,
  wMm: number,
): number | null {
  // Visual (along +X) position of a block in its row: the top row is laid out in pitch order,
  // the bottom row reversed (see emCouponGeometry/buildRow).
  const visualPos = (b: BlockMeasurement) =>
    b.row === 0 ? b.blockIndex : spec.blockCount - 1 - b.blockIndex
  const byPos = new Map<string, BlockMeasurement>()
  for (const b of measurement.blocks) byPos.set(`${b.row}:${visualPos(b)}`, b)

  const residuals: number[] = []
  for (const s of measurement.separators) {
    const left = byPos.get(`${s.row}:${s.index}`)
    const right = byPos.get(`${s.row}:${s.index + 1}`)
    if (!left || !right) continue
    const centerDistMm =
      right.lineCentersMm[0] - left.lineCentersMm[left.lineCentersMm.length - 1]
    residuals.push(s.widthMm - (centerDistMm - wMm))
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
  const sample = (xMm: number, yMm: number): number | null => {
    const p = mmToPx(alignment, xMm, yMm)
    const x = Math.round(p.x)
    const y = Math.round(p.y)
    if (x < 0 || y < 0 || x >= gray.cols || y >= gray.rows) return null
    return data[y * gray.cols + x]
  }

  const plastic: number[] = []
  const band = g.frameBandMm
  // Frame band midpoints along all four sides, and the rail centreline.
  for (let t = 0.1; t <= 0.9; t += 0.1) {
    plastic.push(
      sample(g.couponWidthMm * t, band / 2) ?? NaN,
      sample(g.couponWidthMm * t, g.couponHeightMm - band / 2) ?? NaN,
      sample(g.couponWidthMm * t, (g.railY0Mm + g.railY1Mm) / 2) ?? NaN,
    )
    plastic.push(
      sample(band / 2, g.couponHeightMm * t) ?? NaN,
      sample(g.couponWidthMm - band / 2, g.couponHeightMm * t) ?? NaN,
    )
  }

  const backdrop: number[] = []
  const rowYs: [typeof g.topRow, number][] = [
    [g.topRow, (g.topRowY0Mm + g.topRowY1Mm) / 2],
    [g.bottomRow, (g.bottomRowY0Mm + g.bottomRowY1Mm) / 2],
  ]
  for (const [rowBlocks, yMm] of rowYs) {
    for (const block of rowBlocks) {
      for (let j = 0; j + 1 < block.lineXsMm.length; j++) {
        backdrop.push(sample((block.lineXsMm[j] + block.lineXsMm[j + 1]) / 2, yMm) ?? NaN)
      }
    }
  }
  for (const f of g.fiducials) backdrop.push(sample(f.xMm, f.yMm) ?? NaN)

  return assessMeasurementBackdrop(
    plastic.filter(Number.isFinite),
    backdrop.filter(Number.isFinite),
  )
}

function flankAsymmetry(measurement: EmMeasurement): number | null {
  const { leftFlankOffsetsMm, rightFlankOffsetsMm } = measurement
  if (leftFlankOffsetsMm.length === 0 || rightFlankOffsetsMm.length === 0) return null
  return median(leftFlankOffsetsMm) + median(rightFlankOffsetsMm)
}

function failure(
  reason: string,
  flipped: boolean,
  rotationQuarterTurns: number,
  measuredPxPerMm: number | null = null,
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
  }
}
