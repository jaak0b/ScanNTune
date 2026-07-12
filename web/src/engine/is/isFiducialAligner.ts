import type { Mat, OpenCv } from '../opencv'
import type { IsTestSpec } from './types'
import type { IsCouponGeometry } from './couponGeometry'
import { isCouponGeometry } from './couponGeometry'
import { analyzeThresholdBands, majorityFilterBinary, valueChannel } from '../cvUtils'
import { solveCornerHoleCandidates } from '../cornerFiducialSolver'
import type { AffineMmToPx, CornerCandidate, Point } from '../cornerFiducialSolver'
import { median } from '../math'
import { MIN_ALIGN_PX_PER_MM } from '../resolutionGate'

// Locates the IS coupon's three square fiducial holes in a scan and solves the
// exactly-determined affine mapping coupon-frame millimetres to scan pixels, following the EM
// fiducial aligner. The coupon plate is found as the largest external contour of an Otsu
// threshold-band binary (every band hypothesis is tried and validated against the known
// geometry); the fiducials are its hole contours (RETR_CCOMP children) of the expected size and
// square shape. The open window's background regions (long slots between parallel test lines,
// the small cells of the crossing grid, and the large remaining openings) are rejected by the
// same size and squareness gates: the slots are elongated, the grid cells far smaller than the
// 5 mm fiducial, and the free window regions far larger. The hole layout leaves the origin
// corner empty; the shared corner-fiducial solver resolves rotation and mirror flip from it.

export interface IsAlignment {
  success: boolean
  failureReason: string | null
  /** Maps coupon-frame mm to scan px: px = A * mm + t. Null when alignment failed. */
  affine: AffineMmToPx | null
  /** True once three plausible corner holes were located, even if alignment later failed. */
  fiducialsFound: boolean
  /** True once a geometrically valid orientation was solved from the holes; `flipped` and
   *  `rotationQuarterTurns` are only meaningful when this is true. */
  orientationSolved: boolean
  flipped: boolean
  rotationQuarterTurns: number
}

/**
 * Upper bound on hole-sized plate openings before the subset search is refused: beyond this
 * the scene is dominated by non-fiducial openings (debris, reflections, a damaged part) and
 * an orientation picked from it would be a guess.
 */
const MAX_HOLE_CANDIDATES = 12

export function alignIsCoupon(cv: OpenCv, imageBgr: Mat, spec: IsTestSpec): IsAlignment {
  if (!imageBgr || imageBgr.empty()) throw new Error('Image is null or empty.')
  const geometry = isCouponGeometry(spec)

  // The scan is a multi-population scene (dark plastic, mid-tone scanner background showing
  // through the window and holes, a possibly bright lid margin), so no single threshold is
  // guaranteed to isolate the plate. Every threshold-band hypothesis is tried and validated
  // against the known geometry; the first that yields the three-hole corner pattern wins.
  const gray = valueChannel(cv, imageBgr)
  let attempts: AlignAttempt[]
  try {
    attempts = analyzeThresholdBands(
      cv,
      imageBgr,
      (objectWhite) => tryAlign(cv, objectWhite, gray, geometry),
      (r) => r.success,
    )
  } finally {
    gray.delete()
  }
  const aligned = attempts.find((r) => r.success)
  if (aligned) return stripStage(aligned)
  // Report the failure from the band hypothesis that got furthest through the pipeline: a
  // band that found the plate and its holes but could not verify the orientation explains
  // the scan better than one whose largest blob was the whole image.
  const best = attempts.reduce<AlignAttempt | null>(
    (acc, r) => (acc === null || r.stage > acc.stage ? r : acc),
    null,
  )
  return best ? stripStage(best) : fail('No coupon was found in the scan.', 0)
}

/** IsAlignment plus how far through the alignment pipeline the attempt progressed (higher
 *  means further: plate found, shape ok, holes found, orientation solved, content verified). */
type AlignAttempt = IsAlignment & { stage: number }

/** Stage from which the three corner holes were located. */
const STAGE_HOLES_FOUND = 3
/** Stage from which a geometrically valid orientation was solved. */
const STAGE_ORIENTATION_SOLVED = 4

function stripStage(attempt: AlignAttempt): IsAlignment {
  const { stage: _stage, ...alignment } = attempt
  return alignment
}

export function mmToPx(alignment: IsAlignment, xMm: number, yMm: number): { x: number; y: number } {
  const A = alignment.affine
  if (!A) throw new Error('The alignment did not succeed, so there is no coupon-to-scan mapping.')
  return { x: A.a * xMm + A.b * yMm + A.tx, y: A.c * xMm + A.d * yMm + A.ty }
}

// A failed attempt still reports how far it got, so the UI can state which pipeline stages
// succeeded before the failure. A stage-4 failure knows the best orientation hypothesis, so
// its flip and rotation are carried along; earlier failures leave the defaults, which the
// `orientationSolved` flag marks as meaningless.
function fail(
  reason: string,
  stage: number,
  orientation?: { flipped: boolean; rotationQuarterTurns: number },
): AlignAttempt {
  return {
    success: false,
    failureReason: reason,
    affine: null,
    fiducialsFound: stage >= STAGE_HOLES_FOUND,
    orientationSolved: stage >= STAGE_ORIENTATION_SOLVED,
    flipped: orientation?.flipped ?? false,
    rotationQuarterTurns: orientation?.rotationQuarterTurns ?? 0,
    stage,
  }
}

// One alignment attempt on one threshold band's binary (coupon plate assumed white). `gray`
// is the scan's value channel, sampled to disambiguate the corner correspondence.
function tryAlign(cv: OpenCv, objectWhite: Mat, gray: Mat, g: IsCouponGeometry): AlignAttempt {
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  try {
    cv.findContours(objectWhite, contours, hierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE)

    // The coupon plate: the largest top-level contour.
    const count = contours.size()
    let baseIndex = -1
    let baseArea = 0
    for (let i = 0; i < count; i++) {
      if (hierarchy.data32S[i * 4 + 3] !== -1) continue // not top-level
      const contour = contours.get(i)
      try {
        const area = cv.contourArea(contour)
        if (area > baseArea) {
          baseArea = area
          baseIndex = i
        }
      } finally {
        contour.delete()
      }
    }
    const nominalAreaMm2 = g.couponWidthMm * g.couponHeightMm
    // Degenerate-alignment floor: a blob smaller than the coupon at MIN_ALIGN_PX_PER_MM
    // cannot be a usable coupon scan (see resolutionGate for the derivation).
    const minBasePx = nominalAreaMm2 * MIN_ALIGN_PX_PER_MM * MIN_ALIGN_PX_PER_MM
    if (baseIndex < 0 || baseArea < minBasePx) {
      return fail(
        'No coupon was found in the scan. Place the printed coupon flat on the scanner glass so the whole plate is visible.',
        0,
      )
    }

    // Aspect-ratio gate: the largest blob must be shaped like the coupon plate.
    const baseContour = contours.get(baseIndex)
    let baseLong: number
    let baseShort: number
    try {
      const rect = cv.minAreaRect(baseContour)
      baseLong = Math.max(rect.size.width, rect.size.height)
      baseShort = Math.min(rect.size.width, rect.size.height)
    } finally {
      baseContour.delete()
    }
    const nominalLong = Math.max(g.couponWidthMm, g.couponHeightMm)
    const nominalShort = Math.min(g.couponWidthMm, g.couponHeightMm)
    if (
      baseShort <= 0 ||
      Math.abs(baseLong / baseShort - nominalLong / nominalShort) / (nominalLong / nominalShort) >
        0.1
    ) {
      return fail(
        'The largest object in the scan does not match the coupon plate shape. Remove other objects from the glass and rescan.',
        1,
      )
    }

    // Fiducial hole candidates: children of the plate contour with a plausible area and a
    // square shape. The area gate is wide on the low side because a scan of the coupon's bed
    // side reads the first layer's hole rims, which elephant-foot squish shrinks to roughly
    // half the nominal area; the upper bound stays below the smallest square-ish window
    // pockets (about 2.5 times the fiducial area).
    const estimatedPxPerMm = Math.sqrt(baseArea / nominalAreaMm2)
    const expectedHoleAreaPx = (g.fiducialSizeMm * estimatedPxPerMm) ** 2

    // A coupon scanned on its textured build plate shows the plate's speckle through every
    // opening, littering the binary with noise blobs; a majority filter well under the fiducial
    // size removes them without moving the surviving centroids. The plate is re-located in the
    // filtered binary (contour indices differ from the first pass).
    const denoised = majorityFilterBinary(
      cv,
      objectWhite,
      (g.fiducialSizeMm / 5) * estimatedPxPerMm,
    )
    const holes: Point[] = []
    const denoisedContours = new cv.MatVector()
    const denoisedHierarchy = new cv.Mat()
    try {
      cv.findContours(
        denoised,
        denoisedContours,
        denoisedHierarchy,
        cv.RETR_CCOMP,
        cv.CHAIN_APPROX_SIMPLE,
      )
      const denoisedCount = denoisedContours.size()
      let denoisedBaseIndex = -1
      let denoisedBaseArea = 0
      for (let i = 0; i < denoisedCount; i++) {
        if (denoisedHierarchy.data32S[i * 4 + 3] !== -1) continue
        const contour = denoisedContours.get(i)
        try {
          const area = cv.contourArea(contour)
          if (area > denoisedBaseArea) {
            denoisedBaseArea = area
            denoisedBaseIndex = i
          }
        } finally {
          contour.delete()
        }
      }
      for (let i = 0; i < denoisedCount; i++) {
        if (denoisedHierarchy.data32S[i * 4 + 3] !== denoisedBaseIndex) continue // not a hole in the plate
        const contour = denoisedContours.get(i)
        try {
          const area = cv.contourArea(contour)
          if (area < expectedHoleAreaPx * 0.3 || area > expectedHoleAreaPx * 1.8) continue
          // A fiducial is square, so its minimum-area rectangle is not elongated.
          const rect = cv.minAreaRect(contour)
          const long = Math.max(rect.size.width, rect.size.height)
          const short = Math.min(rect.size.width, rect.size.height)
          if (short <= 0 || long / short > 2) continue
          const m = cv.moments(contour)
          if (m.m00 <= 0) continue
          holes.push({ x: m.m10 / m.m00, y: m.m01 / m.m00 })
        } finally {
          contour.delete()
        }
      }
    } finally {
      denoised.delete()
      denoisedContours.delete()
      denoisedHierarchy.delete()
    }
    if (holes.length < 3) {
      return fail(
        `Expected the coupon's 3 corner holes but found ${holes.length}. Make sure the coupon is scanned with no hole covered.`,
        2,
      )
    }
    if (holes.length > MAX_HOLE_CANDIDATES) {
      return fail(
        'Too many hole-sized openings were detected on the coupon, so the corner holes could not be told apart. Check for debris or reflections on the scan and try again.',
        2,
      )
    }

    // Every 3-subset of the candidates is tried against the known fiducial layout; the shared
    // corner solver's right-angle and per-arm scale gates reject subsets that include a window
    // pocket, and a plate-scale gate rejects subsets whose implied px/mm disagrees with the
    // plate blob. All surviving orientation hypotheses compete in the content-probe model
    // selection below (the same doctrine that picks the threshold polarity).
    const candidates: CornerCandidate[] = []
    let lastReason: string | null = null
    for (let i = 0; i < holes.length - 2; i++) {
      for (let j = i + 1; j < holes.length - 1; j++) {
        for (let k = j + 1; k < holes.length; k++) {
          const subset = [holes[i], holes[j], holes[k]]
          const { candidates: subsetCandidates, reason } = solveCornerHoleCandidates(
            subset,
            g.fiducials,
          )
          if (reason) lastReason = reason
          for (const c of subsetCandidates) {
            const scale = Math.sqrt(Math.abs(c.affine.a * c.affine.d - c.affine.b * c.affine.c))
            if (Math.abs(scale / estimatedPxPerMm - 1) > 0.1) continue
            candidates.push(c)
          }
        }
      }
    }
    if (candidates.length === 0) {
      return fail(lastReason ?? 'The coupon orientation could not be determined.', 3)
    }
    return selectCandidateByContent(gray, g, candidates)
  } finally {
    contours.delete()
    hierarchy.delete()
  }
}

// The two-axis IS coupon is square by construction, so its two fiducial arms are equal and
// the arm lengths cannot pick the neighbour correspondence: both candidate orientations fit
// the holes equally well. They are disambiguated against the coupon CONTENT instead, the same
// dual-hypothesis model selection the ring detector uses for threshold polarity: probe points
// on the known run-up legs (straight beads, immune to the ringing displacement) must show the
// plastic tone under the true orientation, while under the false one they map into window
// regions the layout leaves empty. Tones are measured from the scan itself: the frame band
// interior gives the plastic tone, the fiducial through-holes the background tone.

/** Fraction of leg probes that must read as plastic for a candidate to be plausible. */
const MIN_PROBE_SCORE = 0.7
/** Required score margin between two surviving candidates before one is trusted. */
const MIN_PROBE_MARGIN = 0.2
/** Minimum plastic/background tone separation for the probes to mean anything. */
const MIN_TONE_CONTRAST = 10

function selectCandidateByContent(
  gray: Mat,
  g: IsCouponGeometry,
  allCandidates: CornerCandidate[],
): AlignAttempt {
  // The subset search hands in near-duplicates of the same orientation hypothesis (subsets
  // sharing two true holes plus a nearby spurious one solve to almost the same affine). The
  // probe-margin ambiguity test below must compare DISTINCT hypotheses, so candidates are
  // deduplicated first: same flip and rotation with coupon centers within half a fiducial
  // of each other are one hypothesis, represented by its best arm fit.
  const centerX = g.couponWidthMm / 2
  const centerY = g.couponHeightMm / 2
  const dedupeTolMm = g.fiducialSizeMm / 2
  const candidates: CornerCandidate[] = []
  for (const c of [...allCandidates].sort((a, b) => a.armMismatch - b.armMismatch)) {
    const scale = Math.sqrt(Math.abs(c.affine.a * c.affine.d - c.affine.b * c.affine.c))
    const cx = c.affine.a * centerX + c.affine.b * centerY + c.affine.tx
    const cy = c.affine.c * centerX + c.affine.d * centerY + c.affine.ty
    const duplicate = candidates.some((k) => {
      if (k.flipped !== c.flipped || k.rotationQuarterTurns !== c.rotationQuarterTurns) {
        return false
      }
      const kx = k.affine.a * centerX + k.affine.b * centerY + k.affine.tx
      const ky = k.affine.c * centerX + k.affine.d * centerY + k.affine.ty
      return Math.hypot(kx - cx, ky - cy) < dedupeTolMm * scale
    })
    if (!duplicate) candidates.push(c)
  }

  const band = g.frameBandMm
  // Plastic tone: the four band-edge midpoints; background tone: the fiducial hole centers.
  // Both sets map onto themselves under either candidate (the bands and holes are common to
  // both hypotheses), so the tones are orientation-independent.
  const bandPoints = [
    { x: g.couponWidthMm / 2, y: band / 2 },
    { x: g.couponWidthMm / 2, y: g.couponHeightMm - band / 2 },
    { x: band / 2, y: g.couponHeightMm / 2 },
    { x: g.couponWidthMm - band / 2, y: g.couponHeightMm / 2 },
  ]
  const holePoints = g.fiducials.map((f) => ({ x: f.xMm, y: f.yMm }))

  // Leg probes: two points per line where its straight run-up leg runs just inside the open
  // window (1 mm and 4 mm past the band edge, always below the shortest in-window leg, which
  // is at least the run-up length). Under the false orientation these map into the layout's
  // empty margin strips.
  const probes: { x: number; y: number }[] = []
  for (const group of g.groups) {
    for (const line of group.lines) {
      const vertical = line.runUp.x1 === line.runUp.x0
      for (const depth of [1, 4]) {
        if (vertical) {
          // Vertical leg entering the window across the bottom band.
          probes.push({ x: line.runUp.x0, y: band + depth })
        } else {
          // Horizontal leg entering the window across the right band.
          probes.push({ x: g.couponWidthMm - band - depth, y: line.runUp.y0 })
        }
      }
    }
  }

  const data = gray.data as Uint8Array
  const cols = gray.cols
  const rows = gray.rows
  const sample = (affine: AffineMmToPx, p: { x: number; y: number }): number => {
    const x = Math.round(affine.a * p.x + affine.b * p.y + affine.tx)
    const y = Math.round(affine.c * p.x + affine.d * p.y + affine.ty)
    if (x < 0 || y < 0 || x >= cols || y >= rows) return NaN
    return data[y * cols + x]
  }

  const scores = candidates.map((c) => {
    const bandTone = median(bandPoints.map((p) => sample(c.affine, p)).filter(Number.isFinite))
    const holeTone = median(holePoints.map((p) => sample(c.affine, p)).filter(Number.isFinite))
    if (Math.abs(bandTone - holeTone) < MIN_TONE_CONTRAST) return -1
    let plastic = 0
    let valid = 0
    for (const p of probes) {
      const v = sample(c.affine, p)
      if (!Number.isFinite(v)) continue
      valid++
      if (Math.abs(v - bandTone) < Math.abs(v - holeTone)) plastic++
    }
    return valid > 0 ? plastic / valid : -1
  })

  const order = candidates.map((_, i) => i).sort((a, b) => scores[b] - scores[a])
  const best = order[0]
  const bestScore = scores[best]
  const secondScore = order.length > 1 ? scores[order[1]] : -Infinity
  if (bestScore < MIN_PROBE_SCORE) {
    // The plate and its three corner fiducials were found and a geometrically valid
    // orientation was solved, but the printed run-up legs are not where the configured
    // geometry places them. The dominant cause is a coupon printed under different test
    // settings than are configured now (most often a different number of lines per speed,
    // which shifts every line and the whole field), so name that cause and its action.
    return fail(
      'The coupon in the scan does not match the configured test settings. The plate and its ' +
        'fiducial holes were found, but the printed lines are not where the current settings ' +
        'place them, which usually means the coupon was printed with different settings, most ' +
        'often a different number of lines per speed. Set the same print settings that ' +
        'generated this coupon, including lines per speed, and analyze again.',
      4,
      candidates[best],
    )
  }
  if (candidates.length > 1 && bestScore - secondScore < MIN_PROBE_MARGIN) {
    return fail(
      'The coupon orientation is ambiguous in this scan: both possible orientations match the ' +
        'printed pattern about equally well. Rescan the coupon flat on the glass with the lid closed.',
      4,
      candidates[best],
    )
  }
  const c = candidates[best]
  return {
    success: true,
    failureReason: null,
    affine: c.affine,
    fiducialsFound: true,
    orientationSolved: true,
    flipped: c.flipped,
    rotationQuarterTurns: c.rotationQuarterTurns,
    stage: 5,
  }
}
