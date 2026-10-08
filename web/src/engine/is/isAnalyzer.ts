import type { Mat, OpenCv } from '../opencv'
import type { IsAxis, IsTestSpec } from './types'
import { isCouponGeometry } from './couponGeometry'
import type { IsLineGroup } from './couponGeometry'
import { alignIsCoupon, mmToPx } from './isFiducialAligner'
import type { IsAlignment } from './isFiducialAligner'
import { assessMeasurementBackdrop } from '../measurementBackdrop'
import type { BackdropAssessment } from '../measurementBackdrop'
import { imageDirection, measuredDirection, traceGroup, tracedSpanPx } from './lineTracer'
import { analyzeTracedLine, poolCouponAxes } from './ringAnalyzer'
import type { AxisPool, LineFit } from './ringAnalyzer'
import { layerShiftDetected } from './layerShift'
import { recommendShapers, recommendShapersForModes } from './shaperRecommender'
import type { IsAxisResult, IsLineOutcome, IsResult, IsScanInfo } from './resultTypes'
import { sampleBgrTriples, selectMeasurementChannel } from '../cvUtils'
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

  // Measurement-backdrop gate per scan, doubling as channel selection: the floor showing
  // through the open window must present a single tone that contrasts with the plastic in the
  // measured plane, or the traced line edges read shifted (a dark textured build plate behind
  // the window corrupts the ring readout). A colored coupon on a brightness-matched backing
  // separates in saturation instead of value, and one on a backing matched in both only in the
  // Fisher discriminant plane, so the gate judges all candidate planes and the tracing runs on
  // the plane it accepts for that scan. The same gate positions feed both the per-candidate
  // tone assessment and the BGR class samples the discriminant is built from.
  const grays: Mat[] = []
  try {
    for (let i = 0; i < 2; i++) {
      const positions = isGatePositions(
        alignments[i],
        spec,
        geometry,
        scans[i].cols,
        scans[i].rows,
      )
      const { gray, assessment: backdrop } = selectMeasurementChannel(
        cv,
        scans[i],
        (candidate) => assessIsBackdrop(candidate, positions),
        {
          feature: sampleBgrTriples(scans[i], positions.plastic),
          backdrop: sampleBgrTriples(scans[i], positions.backdrop),
        },
      )
      grays.push(gray)
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

    // Every group is traced first; the groups' rings are then analyzed together, since each
    // group's lines run along the other group's axis, whose ring shifts the nozzle along them
    // (ringAnalyzer.poolCouponAxes). A group that could not be traced enters with no lines.
    const traced = geometry.groups.map((group) => traceAxisGroup(cv, grays, alignments, spec, group, scanReference))
    const pools = poolCouponAxes(
      traced.map((t) => ('fits' in t ? t.fits : [])),
      spec.speedsMmS,
    )
    const axes: IsAxisResult[] = geometry.groups.map((group, groupIndex) => {
      const t = traced[groupIndex]
      if (!('fits' in t)) return t.refused
      // The group's lines in the order they print within the layer.
      const printOrder = geometry.printOrder
        .filter((ref) => ref.groupIndex === groupIndex)
        .map((ref) => ref.lineIndex)
      return axisResult(group, t, pools[groupIndex], printOrder)
    })

    return {
      aligned: true,
      failureReason: null,
      scans: alignments.map(scanInfo),
      axes,
    }
  } finally {
    for (const gray of grays) gray.delete()
  }
}

/** In-bounds integer scan-pixel positions the backdrop gate samples, computed once per scan. */
interface IsGatePositions {
  plastic: { x: number; y: number }[]
  backdrop: { x: number; y: number }[]
}

// The gate's sample positions: plastic tones on the frame band, backdrop tones between adjacent
// test lines inside the open window (half a line pitch off each measured segment, early in its
// protected span, before any crossings) plus the fiducial holes, all through the solved affine.
// Computed once per scan and shared by the per-candidate tone assessment and the BGR class
// sampling the discriminant plane is built from, so both read the same scene points.
function isGatePositions(
  alignment: IsAlignment,
  spec: IsTestSpec,
  geometry: ReturnType<typeof isCouponGeometry>,
  cols: number,
  rows: number,
): IsGatePositions {
  const push = (list: { x: number; y: number }[], xMm: number, yMm: number) => {
    const p = mmToPx(alignment, xMm, yMm)
    const x = Math.round(p.x)
    const y = Math.round(p.y)
    if (x < 0 || y < 0 || x >= cols || y >= rows) return
    list.push({ x, y })
  }

  const band = geometry.frameBandMm
  const plastic: { x: number; y: number }[] = []
  for (let t = 0.1; t <= 0.9; t += 0.1) {
    push(plastic, geometry.couponWidthMm * t, band / 2)
    push(plastic, geometry.couponWidthMm * t, geometry.couponHeightMm - band / 2)
    push(plastic, band / 2, geometry.couponHeightMm * t)
    push(plastic, geometry.couponWidthMm - band / 2, geometry.couponHeightMm * t)
  }

  const backdrop: { x: number; y: number }[] = []
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
      push(backdrop, cx - dy * off, cy + dx * off)
      push(backdrop, cx + dy * off, cy - dx * off)
    }
  }
  for (const f of geometry.fiducials) push(backdrop, f.xMm, f.yMm)
  return { plastic, backdrop }
}

// Reads the gate positions' tones off one candidate measurement plane and judges them with the
// shared measurement-backdrop gate.
function assessIsBackdrop(gray: Mat, positions: IsGatePositions): BackdropAssessment {
  const data = gray.data as Uint8Array
  const cols = gray.cols
  return assessMeasurementBackdrop(
    positions.plastic.map((p) => data[p.y * cols + p.x]),
    positions.backdrop.map((p) => data[p.y * cols + p.x]),
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
    frequencySeHz: null,
    amplitudeMm: null,
    detectionPBound: null,
    linesDetected: 0,
    decayDemonstrated: null,
    proportionality: 'not-assessed',
    speedCheck: { state: 'not-assessed', tiers: [] },
    replicateCheck: 'not-assessed',
    influenceCheck: 'not-assessed',
    layerShiftDetected: null,
    secondModePBound: null,
    secondMode: null,
    artifacts: [],
    cornerModel: null,
    alongTrackLag: null,
    linesUsed: 0,
    linesTraced,
    scanIndex,
    lines,
    shapers: null,
    recommended: null,
  }
}

/**
 * Ladder-specific guidance on a refused axis: when ringing is detected only on lines whose
 * corners are faster than every line without it, the coupon self-ranged and the remedy is a
 * faster ladder, raised in small steps because the fastest corners also load the motors
 * hardest. Null when the detections do not show that split.
 */
export function ladderAdvice(lines: IsLineOutcome[]): string | null {
  const traced = lines.filter((l) => l.traced && l.detectionPBound !== null)
  const detected = traced.filter((l) => l.detected)
  const silent = traced.filter((l) => !l.detected)
  if (detected.length === 0 || silent.length === 0) return null
  const slowestDetected = Math.min(...detected.map((l) => l.cornerSpeedMmS))
  const fastestSilent = Math.max(...silent.map((l) => l.cornerSpeedMmS))
  if (slowestDetected <= fastestSilent) return null
  return (
    'Only the lines with the fastest corners showed ringing. Raise the corner speed in small ' +
    'steps and reprint, and lower it again if the print shows a layer shift.'
  )
}

const NOT_TRACED_REASON =
  'The line could not be traced in the scan. It may be damaged, incompletely printed, or ' +
  'partly outside the scan area.'

const FREQUENCY_OUTLIER_REASON =
  'The ringing frequency fitted on this line lies far from the other lines, so the line was ' +
  'left out of the joint fit. The trace may be corrupted by print defects or scan artifacts.'

const OUT_OF_BAND_REASON =
  'The ringing frequency fitted on this line sits at the edge of the search range, so the ' +
  'line was left out of the joint fit.'

const ZETA_AT_BOUND_REASON =
  'The damping ratio fitted on this line sits at the edge of the physically plausible range, ' +
  'so the line was left out of the joint fit.'

/** A group traced in its scan: its per-line outcomes and the fits of its traced lines. */
interface TracedAxisGroup {
  scanIndex: 0 | 1
  lines: IsLineOutcome[]
  /** Geometry indices of the traced lines, aligned with fits. */
  tracedIndices: number[]
  fits: LineFit[]
}

/** Traces a group in the scan that reads it along the sensor rows and prepares its lines' fits;
 *  the refused axis when no scan qualifies or no line could be traced. */
function traceAxisGroup(
  cv: OpenCv,
  grays: Mat[],
  alignments: IsAlignment[],
  spec: IsTestSpec,
  group: IsLineGroup,
  scanReference: ScaleReference,
): TracedAxisGroup | { refused: IsAxisResult } {
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
      cornerSpeedMmS: l.cornerSpeedMmS,
      traced: false,
      accepted: false,
      usedInJointFit: false,
      exclusion: null,
      refusalReason: null,
      refusalCategory: null,
      detected: false,
      detectionPBound: null,
      frequencyHz: null,
      amplitudeMm: null,
      startPx: null,
      endPx: null,
    }))
    return {
      refused: refusedAxis(
        group.axis,
        [
          `The ${group.axis.toUpperCase()} axis lines do not run along the scanner's sensor rows in ` +
            'either scan, so their ring wavelength cannot be read reliably. Scan the coupon once ' +
            'upright and once turned a quarter turn on the glass.',
        ],
        0,
        null,
        lines,
      ),
    }
  }

  const alignment = alignments[scanIndex]
  // Traces on the scan's gate-selected measurement plane; the caller owns and deletes it.
  const traced = traceGroup(cv, grays[scanIndex], alignment, spec, group, scanReference)

  // Per-line outcomes, in geometry order. Untraced lines still get their expected span from
  // the geometry through the alignment, so the overlay can point at a damaged line.
  const lines: IsLineOutcome[] = group.lines.map((l, i) => {
    const span = tracedSpanPx(alignment, spec, l)
    return {
      lineIndex: i,
      axis: group.axis,
      speedMmS: l.speedMmS,
      cornerSpeedMmS: l.cornerSpeedMmS,
      traced: traced.traces[i] !== null,
      accepted: false,
      usedInJointFit: false,
      exclusion: traced.traces[i] === null ? ('not-traced' as const) : null,
      refusalReason: traced.traces[i] === null ? NOT_TRACED_REASON : null,
      refusalCategory: traced.traces[i] === null ? ('not-traced' as const) : null,
      detected: false,
      detectionPBound: null,
      frequencyHz: null,
      amplitudeMm: null,
      startPx: span.start,
      endPx: span.end,
    }
  })

  const tracedIndices = traced.traces
    .map((t, i) => (t !== null ? i : -1))
    .filter((i) => i >= 0)

  if (tracedIndices.length === 0) {
    return {
      refused: refusedAxis(
        group.axis,
        [
          `None of the ${group.axis.toUpperCase()} axis lines could be traced in the scan. The ` +
            'coupon may be incompletely printed or partly outside the scan area.',
        ],
        0,
        scanIndex,
        lines,
      ),
    }
  }

  const fits = tracedIndices.map((i) => analyzeTracedLine(traced.traces[i]!))
  return { scanIndex, lines, tracedIndices, fits }
}

/** The axis result of a traced group from its pool (ringAnalyzer.poolCouponAxes). */
function axisResult(group: IsLineGroup, traced: TracedAxisGroup, pool: AxisPool, printOrder: number[]): IsAxisResult {
  const { scanIndex, lines, tracedIndices, fits } = traced
  for (let k = 0; k < tracedIndices.length; k++) {
    const outcome = lines[tracedIndices[k]]
    const fit = fits[k]
    const verdict = pool.lines[k]
    outcome.usedInJointFit = verdict.usedInJointFit
    outcome.exclusion = verdict.exclusion
    outcome.detected = verdict.detected
    outcome.detectionPBound = verdict.detectionPBound
    outcome.frequencyHz = verdict.frequencyHz
    outcome.amplitudeMm = verdict.amplitudeMm
    // A line "counts" when it entered the joint fit of an axis that produced a measurement.
    outcome.accepted = verdict.usedInJointFit && pool.accepted
    // Only a line left out of the joint fit was refused; a line in it was measured through the
    // joint fit even when the axis verdict refused.
    if (verdict.exclusion === null) {
      outcome.refusalReason = null
      outcome.refusalCategory = null
    } else if (verdict.exclusion === 'frequency-outlier') {
      outcome.refusalReason = FREQUENCY_OUTLIER_REASON
      outcome.refusalCategory = 'frequency-outlier'
    } else if (verdict.exclusion === 'out-of-band') {
      outcome.refusalReason = OUT_OF_BAND_REASON
      outcome.refusalCategory = 'out-of-band'
    } else if (verdict.exclusion === 'zeta-at-bound') {
      outcome.refusalReason = ZETA_AT_BOUND_REASON
      outcome.refusalCategory = 'irregular-trace'
    } else {
      outcome.refusalReason = fit.refusalReason
      outcome.refusalCategory = fit.refusalCategory
    }
  }

  // Lateral offsets of the traced lines in print order, for the layer-shift diagnostic.
  const offsetByLine = new Map<number, number>()
  tracedIndices.forEach((i, k) => {
    const offset = fits[k].offsetMm
    if (offset !== null) offsetByLine.set(i, offset)
  })
  // The group's lines are in field order, so a line's index is its slot across the field.
  const printed = printOrder.filter((i) => offsetByLine.has(i))
  const offsets = printed.map((i) => offsetByLine.get(i)!)
  const checks = {
    detectionPBound: pool.detectionPBound,
    linesDetected: pool.linesDetected,
    decayDemonstrated: pool.decayDemonstrated,
    proportionality: pool.proportionality,
    speedCheck: pool.speedCheck,
    replicateCheck: pool.replicateCheck,
    influenceCheck: pool.influenceCheck,
    layerShiftDetected: layerShiftDetected(offsets, printed),
    artifacts: pool.artifacts,
    cornerModel: pool.cornerModel,
    alongTrackLag: pool.alongTrackLag,
  }

  if (!pool.accepted) {
    const r = refusedAxis(group.axis, [...pool.refusals], tracedIndices.length, scanIndex, lines)
    Object.assign(r, checks)
    r.linesUsed = pool.linesUsed
    // A remedy specific to the coupon replaces the generic rescan advice instead of
    // competing with it.
    const advice = ladderAdvice(lines) ?? pool.rescanAdvice
    if (advice !== null) r.refusals.push(advice)
    return r
  }

  // A second mode that grows with the corner speed shapes the spectrum the shaper must cover; a
  // steady tone next to the ring does not.
  const dominant = { frequencyHz: pool.frequencyHz!, dampingRatio: pool.dampingRatio!, amplitudeMm: pool.amplitudeMm ?? 0 }
  const second = pool.secondMode !== null && pool.secondMode.proportionality !== 'failed' ? pool.secondMode : null
  const recommendation =
    second !== null
      ? recommendShapersForModes([dominant, second])
      : recommendShapers(pool.frequencyHz!, pool.dampingRatio!, pool.frequencyCi95Hz ?? 0)
  return {
    axis: group.axis,
    accepted: true,
    refusals: pool.refusals,
    frequencyHz: pool.frequencyHz,
    dampingRatio: pool.dampingRatio,
    frequencyCi95Hz: pool.frequencyCi95Hz,
    frequencySeHz: pool.frequencySeHz,
    ...checks,
    amplitudeMm: pool.amplitudeMm,
    secondModePBound: pool.secondModePBound,
    secondMode: pool.secondMode,
    linesUsed: pool.linesUsed,
    linesTraced: tracedIndices.length,
    scanIndex,
    lines,
    shapers: recommendation.options,
    recommended: recommendation.recommended,
  }
}
