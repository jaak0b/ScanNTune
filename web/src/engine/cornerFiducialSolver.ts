// Shared solver for the three-hole corner fiducial convention used by the PA, EM, and IS
// coupons: three holes near three corners, the origin corner left solid. Given the three
// detected hole centroids and the coupon's nominal fiducial layout, it identifies the
// corner-adjacent hole (the one seeing the other two at a right angle), resolves the mirror
// flip from the cross-product sign of its neighbour vectors, and solves the exactly-determined
// 3-point affine (coupon mm to scan px) by Cramer's rule. Extracted verbatim from the EM
// fiducial aligner so every coupon family shares one implementation.

export interface Point {
  x: number
  y: number
}

export interface AffineMmToPx {
  a: number
  b: number
  c: number
  d: number
  tx: number
  ty: number
}

export type CornerSolveResult =
  | {
      ok: true
      affine: AffineMmToPx
      flipped: boolean
      rotationQuarterTurns: number
      /** Signed rotation of the coupon +X axis in scan space, in degrees, normalized to
       *  (-180, 180]; includes the quarter-turn part. */
      rotationDegrees: number
    }
  | { ok: false; reason: string }

/** Signed rotation of the coupon +X axis in scan space, in degrees, normalized to (-180, 180]. */
export function rotationDegreesFromAffine(affine: AffineMmToPx): number {
  const degrees = (Math.atan2(affine.c, affine.a) * 180) / Math.PI
  return degrees <= -180 ? degrees + 360 : degrees
}

function sub(p: Point, q: Point): Point {
  return { x: p.x - q.x, y: p.y - q.y }
}

export interface CornerCandidate {
  affine: AffineMmToPx
  flipped: boolean
  rotationQuarterTurns: number
  /** Signed rotation of the coupon +X axis in scan space, in degrees, normalized to
   *  (-180, 180]; includes the quarter-turn part. */
  rotationDegrees: number
  /** Arm-length assignment mismatch; smaller means the assignment fits the nominal arms better. */
  armMismatch: number
}

/**
 * Enumerates BOTH neighbour-correspondence candidates of the three-hole corner pattern,
 * keeping each candidate that passes the right-angle and per-arm scale-consistency gates.
 * When the coupon's two fiducial arms are equal (a square coupon), the arm lengths cannot
 * pick the correspondence, so the caller must disambiguate the surviving candidates against
 * the coupon content it knows (model selection, the same doctrine as the threshold-polarity
 * hypotheses). Ordered by ascending arm mismatch.
 */
export function solveCornerHoleCandidates(
  holes: Point[],
  nominal: { xMm: number; yMm: number }[],
): { candidates: CornerCandidate[]; reason: string | null } {
  let cornerIdx = -1
  let bestCos = Infinity
  for (let i = 0; i < 3; i++) {
    const u = sub(holes[(i + 1) % 3], holes[i])
    const v = sub(holes[(i + 2) % 3], holes[i])
    const lu = Math.hypot(u.x, u.y)
    const lv = Math.hypot(v.x, v.y)
    if (lu < 1 || lv < 1) {
      return {
        candidates: [],
        reason:
          'The detected coupon holes overlap; the scan is unreadable. Rescan at a higher resolution.',
      }
    }
    const cos = Math.abs((u.x * v.x + u.y * v.y) / (lu * lv))
    if (cos < bestCos) {
      bestCos = cos
      cornerIdx = i
    }
  }
  if (bestCos > 0.2) {
    return {
      candidates: [],
      reason:
        'The three detected holes do not form the coupon corner pattern. Check for debris or reflections on the scan and try again.',
    }
  }

  const nCorner = nominal[1]
  const nA = nominal[0]
  const nB = nominal[2]
  const lenNA = Math.hypot(nA.xMm - nCorner.xMm, nA.yMm - nCorner.yMm)
  const lenNB = Math.hypot(nB.xMm - nCorner.xMm, nB.yMm - nCorner.yMm)
  const nominalCross =
    (nA.xMm - nCorner.xMm) * (nB.yMm - nCorner.yMm) - (nA.yMm - nCorner.yMm) * (nB.xMm - nCorner.xMm)

  const corner = holes[cornerIdx]
  const p = holes[(cornerIdx + 1) % 3]
  const q = holes[(cornerIdx + 2) % 3]

  const candidates: CornerCandidate[] = []
  for (const [dA, dB] of [
    [p, q],
    [q, p],
  ] as [Point, Point][]) {
    const lA = Math.hypot(dA.x - corner.x, dA.y - corner.y)
    const lB = Math.hypot(dB.x - corner.x, dB.y - corner.y)
    const sA = lA / lenNA
    const sB = lB / lenNB
    if (Math.abs(sA / sB - 1) > 0.1) continue // per-arm scale consistency
    const detectedCross =
      (dA.x - corner.x) * (dB.y - corner.y) - (dA.y - corner.y) * (dB.x - corner.x)
    if (nominalCross === 0 || detectedCross === 0) continue
    const affine = solveAffine3(
      [nCorner, nA, nB].map((f) => ({ x: f.xMm, y: f.yMm })),
      [corner, dA, dB],
    )
    if (!affine) continue
    const angle = Math.atan2(affine.c, affine.a)
    candidates.push({
      affine,
      flipped: Math.sign(detectedCross) !== Math.sign(nominalCross),
      rotationQuarterTurns: ((Math.round(angle / (Math.PI / 2)) % 4) + 4) % 4,
      rotationDegrees: rotationDegreesFromAffine(affine),
      armMismatch: Math.abs(lA / lenNA - lB / lenNB),
    })
  }
  candidates.sort((a, b) => a.armMismatch - b.armMismatch)
  if (candidates.length === 0) {
    return {
      candidates: [],
      reason:
        'The detected holes do not match the coupon proportions. The scan may show a different object or a distorted coupon.',
    }
  }
  return { candidates, reason: null }
}

export type CornerSelectResult = { ok: true; holes: Point[] } | { ok: false; reason: string }

// Selecting among more than this many hole candidates would mean the binary is mostly noise;
// the O(n^3) triple search stays trivial below it.
const MAX_HOLE_CANDIDATES = 40

/**
 * Selects the three fiducial holes among the detected hole candidates by matching the
 * triple's pairwise distances against the nominal fiducial layout; even a set of exactly
 * three candidates must pass the same layout and scale gates (point-pattern matching by
 * invariant pairwise distances). A coupon scanned on its textured build plate shows the plate
 * through every opening, so speckle blobs pass the per-hole size and shape gates and the
 * fiducials must be identified by their mutual geometry instead of by count. The match must be
 * unique up to shared holes; two disjoint matching triples mean the scene is ambiguous.
 * `estimatedPxPerMm` (from the plate outline area) anchors the absolute scale so a
 * similar-shaped triple of noise blobs at a different size cannot match.
 */
export function selectCornerHoles(
  candidates: Point[],
  nominal: { xMm: number; yMm: number }[],
  estimatedPxPerMm: number,
): CornerSelectResult {
  if (candidates.length < 3) {
    return {
      ok: false,
      reason: `Expected the coupon's 3 corner holes but found ${candidates.length}. Make sure the coupon is scanned face down with no hole covered.`,
    }
  }
  if (candidates.length > MAX_HOLE_CANDIDATES) {
    return {
      ok: false,
      reason:
        'The scan shows too many hole-like shapes to identify the coupon fiducials. Clean the scanner glass and the coupon, then rescan.',
    }
  }

  const nominalDists = [
    Math.hypot(nominal[0].xMm - nominal[1].xMm, nominal[0].yMm - nominal[1].yMm),
    Math.hypot(nominal[1].xMm - nominal[2].xMm, nominal[1].yMm - nominal[2].yMm),
    Math.hypot(nominal[0].xMm - nominal[2].xMm, nominal[0].yMm - nominal[2].yMm),
  ].sort((a, b) => a - b)

  let best: { holes: Point[]; indices: number[]; score: number } | null = null
  let ambiguousWith: number[] | null = null
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      for (let k = j + 1; k < candidates.length; k++) {
        const p = [candidates[i], candidates[j], candidates[k]]
        const dists = [
          Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y),
          Math.hypot(p[1].x - p[2].x, p[1].y - p[2].y),
          Math.hypot(p[0].x - p[2].x, p[0].y - p[2].y),
        ].sort((a, b) => a - b)
        const ratios = dists.map((d, n) => d / nominalDists[n])
        const rMin = Math.min(...ratios)
        const rMax = Math.max(...ratios)
        // The same 10% scale-consistency tolerance the corner solver's anisotropy gate uses,
        // plus an absolute-scale anchor against the plate-derived px/mm.
        if (rMin <= 0 || rMax / rMin - 1 > 0.1) continue
        const rMean = (ratios[0] + ratios[1] + ratios[2]) / 3
        if (Math.abs(rMean / estimatedPxPerMm - 1) > 0.2) continue
        const score = rMax / rMin - 1
        const indices = [i, j, k]
        const prev = best
        if (!prev || score < prev.score) {
          if (prev && indices.filter((n) => prev.indices.includes(n)).length < 2) {
            ambiguousWith = prev.indices
          }
          best = { holes: p, indices, score }
        } else if (indices.filter((n) => prev.indices.includes(n)).length < 2) {
          ambiguousWith = indices
        }
      }
    }
  }
  if (!best) {
    return {
      ok: false,
      reason:
        'No three of the detected holes match the coupon fiducial layout. Make sure the coupon is scanned face down with no hole covered.',
    }
  }
  if (ambiguousWith && ambiguousWith.filter((n) => best.indices.includes(n)).length < 2) {
    return {
      ok: false,
      reason:
        'Several hole patterns in the scan match the coupon fiducial layout. Remove other objects from the glass and rescan.',
    }
  }
  return { ok: true, holes: best.holes }
}

/**
 * Solves orientation and affine from the three detected fiducial hole centroids.
 * `nominal` is the coupon's fiducial layout in coupon mm where nominal[1] is the
 * corner-adjacent hole with nominal[0] and nominal[2] as its neighbours (the layout order the
 * EM and IS geometries both produce).
 */
export function solveFromCornerHoles(holes: Point[], nominal: { xMm: number; yMm: number }[]): CornerSolveResult {
  // The corner-adjacent hole sees the other two at a right angle: pick the hole whose neighbour
  // vectors have the cosine closest to zero.
  let cornerIdx = -1
  let bestCos = Infinity
  for (let i = 0; i < 3; i++) {
    const u = sub(holes[(i + 1) % 3], holes[i])
    const v = sub(holes[(i + 2) % 3], holes[i])
    const lu = Math.hypot(u.x, u.y)
    const lv = Math.hypot(v.x, v.y)
    if (lu < 1 || lv < 1) {
      return {
        ok: false,
        reason: 'The detected coupon holes overlap; the scan is unreadable. Rescan at a higher resolution.',
      }
    }
    const cos = Math.abs((u.x * v.x + u.y * v.y) / (lu * lv))
    if (cos < bestCos) {
      bestCos = cos
      cornerIdx = i
    }
  }
  if (bestCos > 0.2) {
    return {
      ok: false,
      reason:
        'The three detected holes do not form the coupon corner pattern. Check for debris or reflections on the scan and try again.',
    }
  }

  const nCorner = nominal[1]
  const nA = nominal[0]
  const nB = nominal[2]
  const lenNA = Math.hypot(nA.xMm - nCorner.xMm, nA.yMm - nCorner.yMm)
  const lenNB = Math.hypot(nB.xMm - nCorner.xMm, nB.yMm - nCorner.yMm)

  const corner = holes[cornerIdx]
  const p = holes[(cornerIdx + 1) % 3]
  const q = holes[(cornerIdx + 2) % 3]
  const lenP = Math.hypot(p.x - corner.x, p.y - corner.y)
  const lenQ = Math.hypot(q.x - corner.x, q.y - corner.y)

  // Ambiguity gate: the two candidate correspondences are only distinguishable because the
  // nominal arm lengths differ. If the coupon spec makes the nominal arms nearly equal, both
  // candidates fit any scan almost equally well, so refuse rather than silently guess. The
  // threshold is a quarter of the anisotropy gate's 10% tolerance, derived from the nominal
  // geometry alone.
  const nominalArmRatioDiff = Math.abs(lenNA - lenNB) / Math.max(lenNA, lenNB)
  if (nominalArmRatioDiff < 0.25 * 0.1) {
    return {
      ok: false,
      reason:
        "The coupon's two fiducial arms are too similar in length to orient the scan reliably. Use a coupon spec with distinct fiducial arm lengths.",
    }
  }

  // Correspondence: assign the detected neighbours so the per-arm px/mm scales agree best.
  const mismatch = (l1: number, l2: number) => Math.abs(l1 / lenNA - l2 / lenNB)
  const [dA, dB] = mismatch(lenP, lenQ) <= mismatch(lenQ, lenP) ? [p, q] : [q, p]

  // Anisotropy gate: the two arms must imply consistent scales.
  const sA = Math.hypot(dA.x - corner.x, dA.y - corner.y) / lenNA
  const sB = Math.hypot(dB.x - corner.x, dB.y - corner.y) / lenNB
  if (Math.abs(sA / sB - 1) > 0.1) {
    return {
      ok: false,
      reason:
        'The detected holes do not match the coupon proportions. The scan may show a different object or a distorted coupon.',
    }
  }

  // Mirror flip: the cross-product sign of the corner's neighbour vectors, compared between the
  // nominal layout and the detection. A rotation preserves the sign; a flip inverts it.
  const nominalCross =
    (nA.xMm - nCorner.xMm) * (nB.yMm - nCorner.yMm) - (nA.yMm - nCorner.yMm) * (nB.xMm - nCorner.xMm)
  const detectedCross = (dA.x - corner.x) * (dB.y - corner.y) - (dA.y - corner.y) * (dB.x - corner.x)
  const collinear =
    'The detected coupon holes are collinear, so the coupon orientation could not be determined.'
  if (nominalCross === 0 || detectedCross === 0) return { ok: false, reason: collinear }
  const flipped = Math.sign(detectedCross) !== Math.sign(nominalCross)

  const affine = solveAffine3(
    [nCorner, nA, nB].map((f) => ({ x: f.xMm, y: f.yMm })),
    [corner, dA, dB],
  )
  if (!affine) return { ok: false, reason: collinear }

  // Diagnostic rotation of the coupon's +X axis: the exact angle and its quarter-turn estimate.
  const angle = Math.atan2(affine.c, affine.a)
  const rotationQuarterTurns = ((Math.round(angle / (Math.PI / 2)) % 4) + 4) % 4

  return {
    ok: true,
    affine,
    flipped,
    rotationQuarterTurns,
    rotationDegrees: rotationDegreesFromAffine(affine),
  }
}

// The exactly-determined affine from 3 point correspondences (mm -> px), via Cramer's rule on the
// 3x3 system with rows (x_i, y_i, 1); one solve each for the x' and y' components. Returns null
// when the source points are collinear (zero determinant).
export function solveAffine3(src: Point[], dst: Point[]): AffineMmToPx | null {
  const [p0, p1, p2] = src
  const det = p0.x * (p1.y - p2.y) - p0.y * (p1.x - p2.x) + (p1.x * p2.y - p2.x * p1.y)
  if (Math.abs(det) < 1e-9) return null

  const cramer = (r0: number, r1: number, r2: number) => {
    // System: [x_i y_i 1] * [u v w]^T = r_i
    const d1 = r0 * (p1.y - p2.y) - p0.y * (r1 - r2) + (r1 * p2.y - r2 * p1.y)
    const d2 = p0.x * (r1 - r2) - r0 * (p1.x - p2.x) + (p1.x * r2 - p2.x * r1)
    const d3 =
      p0.x * (p1.y * r2 - r1 * p2.y) -
      p0.y * (p1.x * r2 - r1 * p2.x) +
      r0 * (p1.x * p2.y - p2.x * p1.y)
    return [d1 / det, d2 / det, d3 / det]
  }

  const [a, b, tx] = cramer(dst[0].x, dst[1].x, dst[2].x)
  const [c, d, ty] = cramer(dst[0].y, dst[1].y, dst[2].y)
  return { a, b, c, d, tx, ty }
}
