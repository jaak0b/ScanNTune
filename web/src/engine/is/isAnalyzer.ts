import type { Mat, OpenCv } from '../opencv'
import type { IsAxis, IsTestSpec } from './types'
import { isCouponGeometry } from './couponGeometry'
import type { IsLineGroup } from './couponGeometry'
import { alignIsCoupon, mmToPx } from './isFiducialAligner'
import type { IsAlignment } from './isFiducialAligner'
import { assessMeasurementBackdrop } from '../measurementBackdrop'
import type { BackdropAssessment } from '../measurementBackdrop'
import { imageDirection, measuredDirection, traceGroup, tracedSpanPx } from './lineTracer'
import { analyzeTracedLine, poolAxisFits } from './ringAnalyzer'
import { recommendShapers } from './shaperRecommender'
import type { IsAxisResult, IsLineOutcome, IsResult, IsScanInfo } from './resultTypes'
import { valueChannel } from '../cvUtils'
import { evaluateScanSetResolution } from '../resolutionGate'
import { isUsableReference, isotropicPxPerMm } from '../scannerCalibration'
import type { ScaleReference } from '../scannerCalibration'

// Top-level input shaper analysis over TWO scans of the same printed coupon: the part scanned
// face down once, and again turned a quarter turn on the glass. Each scan is aligned
// independently through its fiducials, and each line group (one per machine axis) is measured
// from the one scan in which its measured direction runs along the scanner's sensor-row axis.
//
// Sensor-row assumption: a flatbed scan's image X axis is the sensor line of the scan head
// (the fast axis) and image Y the carriage transport, the same convention the scanner
// calibration's AxisPxPerMm documents. The transport axis carries low-frequency mechanical
// waviness (tens of micrometres), so ring wavelengths are only read along the sensor rows; a
// group whose measured direction maps to the transport axis in both scans is refused, not
// measured badly. The lateral ring deviations then lie along the transport axis, where the
// waviness is slow enough for the Gaussian regression detrend to remove.

/** How dominant the sensor-row component of a group's image direction must be. cos(30 deg):
 *  a coupon can sit visibly crooked on the glass and still qualify, while a genuinely
 *  transport-aligned group (about 90 deg away) never does. */
const AXIS_DOMINANCE = Math.cos(Math.PI / 6)

export function analyzeIsCoupon(
  cv: OpenCv,
  scanA: Mat,
  scanB: Mat,
  spec: IsTestSpec,
  scanReference: ScaleReference,
  expectedDpi: number | null = null,
  alignmentHolder?: { alignments?: IsAlignment[] },
): IsResult {
  if (!scanA || scanA.empty() || !scanB || scanB.empty()) {
    throw new Error('Image is null or empty.')
  }
  if (!isUsableReference(scanReference)) {
    throw new Error('The scan reference must be a positive scanner calibration.')
  }

  const geometry = isCouponGeometry(spec)
  const scans = [scanA, scanB]
  const alignments: IsAlignment[] = []
  // The caller (the worker's overlay rendering) sees every attempted alignment, including a
  // failed one at the end when the analysis stops at a scan that could not be aligned.
  if (alignmentHolder) alignmentHolder.alignments = alignments
  for (let i = 0; i < 2; i++) {
    const alignment = alignIsCoupon(cv, scans[i], spec)
    if (!alignment.success) {
      // The failed alignment still contributes its per-scan diagnostics: which pipeline
      // stages succeeded before the failure is what the UI reports per scan.
      alignments.push(alignment)
      return {
        aligned: false,
        failureReason:
          `Scan ${i + 1} could not be aligned: ` +
          (alignment.failureReason ?? 'the coupon could not be located in the scan.'),
        scans: alignments.map(scanInfo),
        axes: [],
      }
    }
    // A face-down scan of the coupon's top face is always mirrored relative to the coupon
    // frame. An unmirrored scan therefore shows the BED side: there the sharp on-glass edge
    // is the slow-printed pedestal bead (which carries no ringing), the measured layer sits
    // above the scanner's focal plane, and the first-layer fiducial rims are squish-torn, so
    // nothing downstream could measure the ring. Refuse with the flip named instead of
    // returning numbers read off the wrong layer.
    if (!alignment.flipped) {
      alignments.push(alignment) // the overlay can still show the located coupon
      return {
        aligned: false,
        failureReason:
          `Scan ${i + 1} shows the coupon's bed side. Place the coupon with the printed top ` +
          'face against the glass and rescan.',
        scans: alignments.map(scanInfo),
        axes: [],
      }
    }
    alignments.push(alignment)
  }

  // Orientation-pair gate: with both axes under test, the two scans must differ by an odd
  // number of quarter turns, or one axis's lines run along the scanner's transport axis in
  // BOTH scans and that axis is unmeasurable before any tracing. A half turn (or none)
  // between the scans keeps every group on the same scanner axis, so it is refused here as
  // a scanning mistake instead of surfacing later as a per-axis refusal.
  if (
    geometry.groups.length > 1 &&
    (alignments[0].rotationQuarterTurns - alignments[1].rotationQuarterTurns) % 2 === 0
  ) {
    return {
      aligned: false,
      failureReason:
        'The two scans differ by a half turn or not at all, so the X and Y lines cannot ' +
        'both be measured. Rescan one of them with the coupon turned a quarter turn on the glass.',
      scans: alignments.map(scanInfo),
      axes: [],
    }
  }

  // The solved affines' scales price each scan's resolution: both scans are judged together
  // (against the calibration's expected resolution when known, else against each other), so a
  // scan too coarse for the sub-pixel line tracing or taken at the wrong resolution setting is
  // refused per scan, the same way an unalignable scan is.
  const scales = alignments.map((a) => Math.hypot(a.affine!.a, a.affine!.c))
  const verdicts = evaluateScanSetResolution(
    scales.map((pxPerMm) => ({ pxPerMm })),
    expectedDpi != null && expectedDpi > 0
      ? { pxPerMm: isotropicPxPerMm(scanReference), dpi: expectedDpi }
      : null,
  )
  const badIndex = verdicts.findIndex((v) => !v.ok)
  if (badIndex >= 0) {
    return {
      aligned: false,
      failureReason: `Scan ${badIndex + 1}: ${verdicts[badIndex].reason}`,
      scans: alignments.map(scanInfo),
      axes: [],
    }
  }

  // Measurement-backdrop gate per scan: the floor showing through the open window must present
  // a single tone that contrasts with the plastic, or the traced line edges read shifted (a dark
  // textured build plate behind the window corrupts the ring readout).
  for (let i = 0; i < 2; i++) {
    const gray = valueChannel(cv, scans[i])
    let backdrop
    try {
      backdrop = assessIsBackdrop(gray, alignments[i], spec, geometry)
    } finally {
      gray.delete()
    }
    if (backdrop.failure) {
      return {
        aligned: false,
        failureReason:
          `Scan ${i + 1}: the backing showing through the coupon window is ` +
          (backdrop.failure === 'low-contrast'
            ? 'too similar in brightness to the plastic'
            : 'too uneven in brightness') +
          ' to measure against. Scan the removed part against the lid or a sheet of paper, or use a light, even build plate.',
        scans: alignments.map(scanInfo),
        axes: [],
      }
    }
  }

  const axes: IsAxisResult[] = []
  for (const group of geometry.groups) {
    axes.push(measureGroup(cv, scans, alignments, spec, group, scanReference))
  }

  return {
    aligned: true,
    failureReason: null,
    scans: alignments.map(scanInfo),
    axes,
  }
}

// Samples plastic tones on the frame band and backdrop tones between adjacent test lines inside
// the open window (half a line pitch off each measured segment, early in its protected span,
// before any crossings) plus the fiducial holes, all through the solved affine, and judges them
// with the shared measurement-backdrop gate.
function assessIsBackdrop(
  gray: Mat,
  alignment: IsAlignment,
  spec: IsTestSpec,
  geometry: ReturnType<typeof isCouponGeometry>,
): BackdropAssessment {
  const data = gray.data as Uint8Array
  const cols = gray.cols
  const rows = gray.rows
  const sample = (xMm: number, yMm: number): number => {
    const p = mmToPx(alignment, xMm, yMm)
    const x = Math.round(p.x)
    const y = Math.round(p.y)
    if (x < 0 || y < 0 || x >= cols || y >= rows) return NaN
    return data[y * cols + x]
  }

  const band = geometry.frameBandMm
  const plastic: number[] = []
  for (let t = 0.1; t <= 0.9; t += 0.1) {
    plastic.push(
      sample(geometry.couponWidthMm * t, band / 2),
      sample(geometry.couponWidthMm * t, geometry.couponHeightMm - band / 2),
      sample(band / 2, geometry.couponHeightMm * t),
      sample(geometry.couponWidthMm - band / 2, geometry.couponHeightMm * t),
    )
  }

  const backdrop: number[] = []
  for (const group of geometry.groups) {
    for (const line of group.lines) {
      const m = line.measured
      const len = Math.hypot(m.x1 - m.x0, m.y1 - m.y0)
      if (len <= 0) continue
      const dx = (m.x1 - m.x0) / len
      const dy = (m.y1 - m.y0) / len
      // Early in the protected span: inside the window, before any crossings.
      const along = Math.min(line.protectedMm, len) / 2
      const cx = m.x0 + dx * along
      const cy = m.y0 + dy * along
      const off = spec.linePitchMm / 2
      backdrop.push(sample(cx - dy * off, cy + dx * off), sample(cx + dy * off, cy - dx * off))
    }
  }
  for (const f of geometry.fiducials) backdrop.push(sample(f.xMm, f.yMm))

  return assessMeasurementBackdrop(
    plastic.filter(Number.isFinite),
    backdrop.filter(Number.isFinite),
  )
}

// The per-scan diagnostics the UI reports: how far the alignment got (plate and holes found,
// orientation solved) plus the resolved orientation itself.
function scanInfo(a: IsAlignment): IsScanInfo {
  return {
    fiducialsFound: a.fiducialsFound,
    orientationSolved: a.orientationSolved,
    flipped: a.flipped,
    rotationQuarterTurns: a.rotationQuarterTurns,
    measuredPxPerMm: a.affine ? Math.hypot(a.affine.a, a.affine.c) : null,
  }
}

function refusedAxis(
  axis: IsAxis,
  refusals: string[],
  linesTraced = 0,
  scanIndex: 0 | 1 | null = null,
  lines: IsLineOutcome[] = [],
): IsAxisResult {
  return {
    axis,
    accepted: false,
    refusals,
    frequencyHz: null,
    dampingRatio: null,
    frequencyCi95Hz: null,
    amplitudeMm: null,
    linesUsed: 0,
    linesTraced,
    scanIndex,
    lines,
    shapers: null,
    recommended: null,
  }
}

const NOT_TRACED_REASON =
  'The line could not be traced in the scan. It may be damaged, incompletely printed, or ' +
  'partly outside the scan area.'

function measureGroup(
  cv: OpenCv,
  scans: Mat[],
  alignments: IsAlignment[],
  spec: IsTestSpec,
  group: IsLineGroup,
  scanReference: ScaleReference,
): IsAxisResult {
  // Group-to-scan assignment: the scan in which the group's measured direction is most
  // sensor-row aligned, accepted only when that alignment is dominant.
  const dir = measuredDirection(group.lines[0])
  let scanIndex: 0 | 1 | null = null
  let bestDominance = 0
  for (let i = 0; i < 2; i++) {
    const { ux, uy } = imageDirection(alignments[i], dir)
    const dominance = Math.abs(ux) / Math.hypot(ux, uy)
    if (dominance >= AXIS_DOMINANCE && dominance > bestDominance) {
      bestDominance = dominance
      scanIndex = i as 0 | 1
    }
  }
  if (scanIndex === null) {
    // With no scan assigned there is no image space to place the lines in.
    const lines: IsLineOutcome[] = group.lines.map((l, i) => ({
      lineIndex: i,
      axis: group.axis,
      speedMmS: l.speedMmS,
      traced: false,
      accepted: false,
      refusalReason: null,
      refusalCategory: null,
      startPx: null,
      endPx: null,
    }))
    return refusedAxis(
      group.axis,
      [
        `The ${group.axis.toUpperCase()} axis lines do not run along the scanner's sensor rows in ` +
          'either scan, so their ring wavelength cannot be read reliably. Scan the coupon once ' +
          'upright and once turned a quarter turn on the glass.',
      ],
      0,
      null,
      lines,
    )
  }

  const alignment = alignments[scanIndex]
  const gray = valueChannel(cv, scans[scanIndex])
  let traced
  try {
    traced = traceGroup(cv, gray, alignment, spec, group, scanReference)
  } finally {
    gray.delete()
  }

  // Per-line outcomes, in geometry order. Untraced lines still get their expected span from
  // the geometry through the alignment, so the overlay can point at a damaged line.
  const lines: IsLineOutcome[] = group.lines.map((l, i) => {
    const span = tracedSpanPx(alignment, spec, l)
    return {
      lineIndex: i,
      axis: group.axis,
      speedMmS: l.speedMmS,
      traced: traced.traces[i] !== null,
      accepted: false,
      refusalReason: traced.traces[i] === null ? NOT_TRACED_REASON : null,
      refusalCategory: traced.traces[i] === null ? ('not-traced' as const) : null,
      startPx: span.start,
      endPx: span.end,
    }
  })

  const tracedIndices = traced.traces
    .map((t, i) => (t !== null ? i : -1))
    .filter((i) => i >= 0)

  if (tracedIndices.length === 0) {
    return refusedAxis(
      group.axis,
      [
        `None of the ${group.axis.toUpperCase()} axis lines could be traced in the scan. The ` +
          'coupon may be incompletely printed or partly outside the scan area.',
      ],
      0,
      scanIndex,
      lines,
    )
  }

  const fits = tracedIndices.map((i) => analyzeTracedLine(traced.traces[i]!))
  for (let k = 0; k < tracedIndices.length; k++) {
    lines[tracedIndices[k]].accepted = fits[k].accepted
    lines[tracedIndices[k]].refusalReason = fits[k].refusalReason
    lines[tracedIndices[k]].refusalCategory = fits[k].refusalCategory
  }
  const pool = poolAxisFits(
    fits,
    spec.speedsMmS,
    tracedIndices.map((i) => group.lines[i].speedMmS),
  )

  if (!pool.accepted) {
    const r = refusedAxis(group.axis, pool.refusals, tracedIndices.length, scanIndex, lines)
    r.linesUsed = pool.linesUsed
    return r
  }

  const recommendation = recommendShapers(
    pool.frequencyHz!,
    pool.dampingRatio!,
    pool.frequencyCi95Hz ?? 0,
  )
  return {
    axis: group.axis,
    accepted: true,
    refusals: pool.refusals,
    frequencyHz: pool.frequencyHz,
    dampingRatio: pool.dampingRatio,
    frequencyCi95Hz: pool.frequencyCi95Hz,
    amplitudeMm: pool.amplitudeMm,
    linesUsed: pool.linesUsed,
    linesTraced: tracedIndices.length,
    scanIndex,
    lines,
    shapers: recommendation.options,
    recommended: recommendation.recommended,
  }
}
