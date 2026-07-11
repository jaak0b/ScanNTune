import type { Mat, OpenCv } from '../opencv'
import type { EmTestSpec } from './types'
import { BLOCK_GAP_MM, emCouponGeometry } from './types'
import type { EmAlignment } from './fiducialAligner'
import { mmToPx } from './fiducialAligner'
import { median } from '../math'
import { isUsableReference, referenceAlongDirection } from '../scannerCalibration'
import type { ScaleReference } from '../scannerCalibration'

// Measures the EM coupon's comb geometry to sub-pixel precision. For each test block, horizontal
// intensity profiles are extracted along the scan-space direction of the coupon's x-axis (walked
// in coupon millimetres through the alignment affine, so rotation and flip are handled by the
// affine itself), bilinear-sampled every 0.25 px. Nine profiles spread over the middle 60% of the
// row are median-combined per sample into one robust profile (a median rejects the occasional
// stringing or dropout defect on a single line section). Line edges are the mid-level crossings
// between the plastic and background plateau levels (percentile-estimated), refined to sub-pixel
// precision by the gradient centroid around each crossing (a moment-preserving edge localizer;
// see refineEdge for why it replaces the parabolic gradient-peak fit here).
//
// Feature LOCATIONS come from the alignment affine, but every measured DISTANCE is converted to
// true millimetres with the card-calibrated scanner px/mm, never with the affine scale: the affine
// is solved from COMMANDED fiducial positions, so it absorbs any printer axis stretch. The ratio
// of measured line-centre spans to the commanded spans is exactly that stretch, reported as
// `pitchScale`.

export interface BlockMeasurement {
  row: 0 | 1
  blockIndex: number // geometry index (pitch order), not visual order
  pitchCommandedMm: number
  /** Sub-pixel line-centre x positions in TRUE mm (scan px / scanPxPerMm), coupon-frame ordered. */
  lineCentersMm: number[]
  /** Gaps between adjacent line inner edges in TRUE mm. */
  gapsMm: number[]
}

export interface SeparatorMeasurement {
  row: 0 | 1
  index: number
  widthMm: number
}

export interface EmMeasurement {
  blocks: BlockMeasurement[]
  separators: SeparatorMeasurement[]
  /** Measured line-centre pitch span divided by the commanded span: the printer X-scale diagnostic. */
  pitchScale: number
}

const N_PROFILES = 9
const PROFILE_STEP_PX = 0.25
// Fraction of the row length sampled, centred: skips the anchor-overlap line ends where the test
// lines fuse into the frame band, plus a further safety margin at each end.
const ROW_MIDDLE_FRACTION = 0.6
// Plateau levels are the 10th/90th percentiles of the combined profile: robust order statistics
// that land on the background and plastic plateaus for any line/gap duty cycle the pitch sweep
// produces, unlike the extremes (noise) or the mean (duty-cycle dependent).
const PLATEAU_PERCENTILE = 0.1
// Gradient-centroid half-window around a mid-level crossing, in px. Two pixels covers the full
// effective edge spread (scanner optics plus the one-pixel area integration plus the bilinear
// resampling); detectLines shrinks it to half the narrowest commanded feature when the scan
// resolution is low, so the window never reaches a neighbouring edge's ramp.
const EDGE_REFINE_WINDOW_PX = 2

interface DetectedLine {
  leftPx: number // profile-local sub-pixel positions, px
  rightPx: number
  centerPx: number
}

interface BlockProfileResult {
  measurement: BlockMeasurement
  firstLeftMm: number
  lastRightMm: number
}

export function measureEmCoupon(
  cv: OpenCv,
  gray: Mat,
  alignment: EmAlignment,
  spec: EmTestSpec,
  scanReference: ScaleReference,
): EmMeasurement {
  if (!gray || gray.empty()) throw new Error('Image is null or empty.')
  if (gray.channels() !== 1 || gray.type() !== cv.CV_8UC1) {
    throw new Error('measureEmCoupon expects a CV_8UC1 (single-channel 8-bit) image.')
  }
  if (!alignment.success || !alignment.affine) {
    throw new Error('Cannot measure the coupon without a successful alignment.')
  }
  if (!isUsableReference(scanReference))
    throw new Error('The scan reference must be a positive scanner calibration.')

  const data = gray.data as Uint8Array
  const cols = gray.cols
  const rows = gray.rows
  const g = emCouponGeometry(spec)

  // The coupon +X axis mapped through the affine's linear part; its length is the affine-implied
  // px/mm along the profile direction (used only to LOCATE samples, never to scale a distance).
  const A = alignment.affine
  const affinePxPerMmX = Math.hypot(A.a, A.c)
  if (affinePxPerMmX <= 0) throw new Error('The alignment is degenerate (zero scale).')
  const ux = A.a / affinePxPerMmX
  const uy = A.c / affinePxPerMmX

  // Every distance is measured along the profile direction (ux, uy), so a per-axis (CCD)
  // reference reduces to its effective px/mm along that one image direction.
  const scanPxPerMm = referenceAlongDirection(scanReference, ux, uy)

  const rowSpecs: { row: 0 | 1; blocks: typeof g.topRow; y0Mm: number; y1Mm: number }[] = [
    { row: 0, blocks: g.topRow, y0Mm: g.topRowY0Mm, y1Mm: g.topRowY1Mm },
    { row: 1, blocks: g.bottomRow, y0Mm: g.bottomRowY0Mm, y1Mm: g.bottomRowY1Mm },
  ]

  const blocks: BlockMeasurement[] = []
  const separators: SeparatorMeasurement[] = []
  const spanRatios: number[] = []

  for (const rowSpec of rowSpecs) {
    const rowLenMm = rowSpec.y1Mm - rowSpec.y0Mm
    const yLoMm = rowSpec.y0Mm + ((1 - ROW_MIDDLE_FRACTION) / 2) * rowLenMm
    const yHiMm = rowSpec.y1Mm - ((1 - ROW_MIDDLE_FRACTION) / 2) * rowLenMm
    const yMidMm = (rowSpec.y0Mm + rowSpec.y1Mm) / 2
    const ysMm = [...Array(N_PROFILES).keys()].map(
      (i) => yLoMm + ((yHiMm - yLoMm) * i) / (N_PROFILES - 1),
    )
    // Row origin for a common along-row coordinate shared by all of this row's block profiles.
    const origin = mmToPx(alignment, 0, yMidMm)

    // Visual-order results (null where the block was dropped) so separators pair neighbours.
    const results: (BlockProfileResult | null)[] = rowSpec.blocks.map((block) =>
      measureBlock(data, cols, rows, alignment, spec, block, {
        row: rowSpec.row,
        ysMm,
        yMidMm,
        origin,
        ux,
        uy,
        affinePxPerMmX,
        scanPxPerMm,
      }),
    )

    for (const r of results) {
      if (!r) continue
      blocks.push(r.measurement)
      const centers = r.measurement.lineCentersMm
      const commandedSpanMm = (spec.linesPerBlock - 1) * r.measurement.pitchCommandedMm
      spanRatios.push((centers[centers.length - 1] - centers[0]) / commandedSpanMm)
    }
    for (let i = 0; i + 1 < results.length; i++) {
      const left = results[i]
      const right = results[i + 1]
      if (!left || !right) continue
      separators.push({
        row: rowSpec.row,
        index: i,
        widthMm: right.firstLeftMm - left.lastRightMm,
      })
    }
  }

  if (spanRatios.length === 0) {
    throw new Error(
      'No test block could be measured: the scan does not show the expected line combs.',
    )
  }
  const pitchScale = spanRatios.reduce((a, b) => a + b, 0) / spanRatios.length

  return { blocks, separators, pitchScale }
}

interface RowContext {
  row: 0 | 1
  ysMm: number[]
  yMidMm: number
  origin: { x: number; y: number }
  ux: number
  uy: number
  affinePxPerMmX: number
  scanPxPerMm: number
}

// Profiles one block (its x-span plus half a separator each side), median-combines the profiles,
// and extracts the line centres and gaps. Returns null when the detected line count differs from
// the spec (the block is unreadable; recording nothing beats recording garbage).
function measureBlock(
  data: Uint8Array,
  cols: number,
  rows: number,
  alignment: EmAlignment,
  spec: EmTestSpec,
  block: { index: number; pitchMm: number; x0Mm: number; widthMm: number; lineXsMm: number[] },
  ctx: RowContext,
): BlockProfileResult | null {
  const xStartMm = block.x0Mm - BLOCK_GAP_MM / 2
  const xEndMm = block.x0Mm + block.widthMm + BLOCK_GAP_MM / 2
  const spanPx = (xEndMm - xStartMm) * ctx.affinePxPerMmX
  const sampleCount = Math.floor(spanPx / PROFILE_STEP_PX) + 1
  if (sampleCount < 3) return null

  // Per-sample median across the N_PROFILES rows: one robust combined profile.
  const combined = new Float64Array(sampleCount)
  const column: number[] = []
  const starts = ctx.ysMm.map((yMm) => mmToPx(alignment, xStartMm, yMm))
  for (let k = 0; k < sampleCount; k++) {
    column.length = 0
    const s = k * PROFILE_STEP_PX
    for (const p0 of starts) {
      const v = bilinear(data, cols, rows, p0.x + ctx.ux * s, p0.y + ctx.uy * s)
      if (Number.isFinite(v)) column.push(v)
    }
    if (column.length === 0) return null // profile ray leaves the image: unreadable block
    combined[k] = median(column)
  }

  // Plateau levels from percentiles, then the mid-level threshold between them.
  const sorted = Array.from(combined).sort((a, b) => a - b)
  const low = percentile(sorted, PLATEAU_PERCENTILE)
  const high = percentile(sorted, 1 - PLATEAU_PERCENTILE)
  if (high - low < 1) return null // flat profile: no comb here
  const mid = (low + high) / 2

  // Polarity, median-relative like the PA line measurer: compare the tone at the commanded line
  // centres against the tone at the commanded gap midpoints (both located via the affine).
  const idxOf = (xMm: number) =>
    Math.round(((xMm - xStartMm) * ctx.affinePxPerMmX) / PROFILE_STEP_PX)
  const lineTones: number[] = []
  const gapTones: number[] = []
  for (let j = 0; j < block.lineXsMm.length; j++) {
    const li = idxOf(block.lineXsMm[j])
    if (li >= 0 && li < sampleCount) lineTones.push(combined[li])
    if (j + 1 < block.lineXsMm.length) {
      const gi = idxOf((block.lineXsMm[j] + block.lineXsMm[j + 1]) / 2)
      if (gi >= 0 && gi < sampleCount) gapTones.push(combined[gi])
    }
  }
  if (lineTones.length === 0 || gapTones.length === 0) return null
  const plasticDark = median(lineTones) < median(gapTones)

  const lines = detectLines(combined, mid, plasticDark, spec, ctx.affinePxPerMmX)
  if (lines.length !== spec.linesPerBlock) return null

  // Along-row coordinate of this profile's origin, projected on the coupon x direction, so all of
  // a row's blocks share one axis; distances are converted with the CARD px/mm, not the affine.
  const start = mmToPx(alignment, xStartMm, ctx.yMidMm)
  const tStartPx = (start.x - ctx.origin.x) * ctx.ux + (start.y - ctx.origin.y) * ctx.uy
  const toMm = (px: number) => (tStartPx + px) / ctx.scanPxPerMm

  const lineCentersMm = lines.map((l) => toMm(l.centerPx))
  const gapsMm = lines.slice(1).map((l, j) => toMm(l.leftPx) - toMm(lines[j].rightPx))

  return {
    measurement: {
      row: ctx.row,
      blockIndex: block.index,
      pitchCommandedMm: block.pitchMm,
      lineCentersMm,
      gapsMm,
    },
    firstLeftMm: toMm(lines[0].leftPx),
    lastRightMm: toMm(lines[lines.length - 1].rightPx),
  }
}

// Finds the plastic runs of a combined profile as mid-level threshold crossings, refines each
// run's two edges by gradient centroid, and returns them left to right.
function detectLines(
  profile: Float64Array,
  mid: number,
  plasticDark: boolean,
  spec: EmTestSpec,
  affinePxPerMmX: number,
): DetectedLine[] {
  const n = profile.length
  const isPlastic = (k: number) => (plasticDark ? profile[k] < mid : profile[k] > mid)
  // A genuine bead cannot binarize to less than half its commanded width; shorter runs are noise.
  const minRunSamples = Math.max(
    2,
    Math.round((0.5 * spec.nominalLineWidthMm * affinePxPerMmX) / PROFILE_STEP_PX),
  )
  // Half the narrowest commanded feature (the tightest gap or the bead itself) bounds the
  // centroid window so it can never integrate a neighbouring edge's ramp.
  const minFeatureMm = Math.min(
    spec.pitchMinMm - spec.nominalLineWidthMm,
    spec.nominalLineWidthMm,
  )
  const windowPx = Math.min(EDGE_REFINE_WINDOW_PX, 0.5 * minFeatureMm * affinePxPerMmX)
  const windowSamples = Math.max(1, Math.round(windowPx / PROFILE_STEP_PX))
  const grad = (k: number) => Math.abs(profile[k + 1] - profile[k - 1])

  const lines: DetectedLine[] = []
  let runStart = -1
  for (let k = 0; k <= n; k++) {
    const inside = k < n && isPlastic(k)
    if (inside && runStart < 0) runStart = k
    if (!inside && runStart >= 0) {
      const runEnd = k - 1
      // Runs touching the profile ends are incomplete (the profile spans half a separator beyond
      // the block, so every real line lies strictly inside).
      if (runStart > 0 && runEnd < n - 1 && runEnd - runStart + 1 >= minRunSamples) {
        // The mid-level crossing, sub-sampled by linear interpolation, seeds the estimate; a
        // gradient-centroid refinement (the first moment of gradient magnitude in a window around
        // the crossing) replaces it whenever that window carries nonzero gradient weight, and the
        // linear-interpolated crossing is kept as the fallback when it does not (e.g. a flat
        // plateau from bilinear resampling).
        const left = refineEdge(profile, mid, grad, runStart, windowSamples, n)
        const right = refineEdge(profile, mid, grad, runEnd + 1, windowSamples, n)
        if (Number.isFinite(left) && Number.isFinite(right)) {
          lines.push({
            leftPx: left * PROFILE_STEP_PX,
            rightPx: right * PROFILE_STEP_PX,
            centerPx: ((left + right) / 2) * PROFILE_STEP_PX,
          })
        }
      }
      runStart = -1
    }
  }
  return lines
}

// Sub-sample edge position near a threshold crossing. `crossK` is the first sample index on the
// far side of the crossing (profile[crossK - 1] and profile[crossK] straddle `mid`). The estimate
// is the gradient centroid over a window around the crossing: the first moment of the gradient
// magnitude, a gradient centroid (center-of-gravity) edge estimator. For any symmetric
// edge-spread function the gradient's centroid is the true edge position, and unlike a parabolic
// fit of the gradient peak it needs no locally-quadratic peak: bilinear resampling makes the
// gradient piecewise constant (flat plateaus), where a parabola quantizes to whole pixels but the
// centroid stays exact. The linear-interpolated mid-level crossing is the seed and the fallback
// when the window carries no gradient. NaN when the crossing sits at the profile boundary.
function refineEdge(
  profile: Float64Array,
  mid: number,
  grad: (k: number) => number,
  crossK: number,
  windowSamples: number,
  n: number,
): number {
  if (crossK < 1 || crossK > n - 1) return NaN
  const a = profile[crossK - 1]
  const b = profile[crossK]
  const denom = b - a
  const crossing = crossK - 1 + (Math.abs(denom) < 1e-12 ? 0.5 : (mid - a) / denom)

  // Centroid window, clamped to the differentiable interior.
  const lo = Math.max(1, crossK - windowSamples)
  const hi = Math.min(n - 2, crossK + windowSamples)
  let weight = 0
  let moment = 0
  for (let k = lo; k <= hi; k++) {
    const gk = grad(k)
    weight += gk
    moment += gk * k
  }
  if (weight <= 0) return crossing
  return moment / weight
}

// Linear-interpolated percentile of an ascending-sorted array.
function percentile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q
  const i = Math.floor(pos)
  const frac = pos - i
  return i + 1 < sorted.length ? sorted[i] * (1 - frac) + sorted[i + 1] * frac : sorted[i]
}

// Bilinear intensity at a fractional pixel position; NaN outside the image.
function bilinear(data: Uint8Array, cols: number, rows: number, x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  if (x0 < 0 || y0 < 0 || x0 + 1 >= cols || y0 + 1 >= rows) return NaN
  const fx = x - x0
  const fy = y - y0
  const p = (yy: number, xx: number) => data[yy * cols + xx]
  return (
    p(y0, x0) * (1 - fx) * (1 - fy) +
    p(y0, x0 + 1) * fx * (1 - fy) +
    p(y0 + 1, x0) * (1 - fx) * fy +
    p(y0 + 1, x0 + 1) * fx * fy
  )
}
