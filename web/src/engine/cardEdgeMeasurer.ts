import type { Mat, OpenCv } from './opencv'
import type { ScaleReferenceResult } from './types'
import { median } from './math'
import { analyzeThresholdBands, valueChannel } from './cvUtils'
import { evaluateScanSetResolution } from './resolutionGate'

// Measures a reference card's long side to sub-pixel precision: locates the card by validating both
// threshold polarities against the ISO/IEC 7810 ID-1 shape, fits each long edge as a straight line
// from sub-pixel gradient-peak edge points (one per scan row), refines each edge's location with an
// ISO 12233 style slanted-edge projection, and takes the perpendicular distance between the two
// lines. Only the long dimension feeds the scale: the short edges sit where a
// scanner lid shadow can bias one of them, and scanner anisotropy is separated by the coupon's own
// two-scan combine instead. The long side is measured in a frame where it runs horizontally
// (portrait is transposed).

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface EdgeFit {
  m: number
  c: number
  rms: number
  n: number
  // The MAD-inlier rows the fit kept; the slanted-edge refinement projects pixels from exactly
  // these rows so an outlier row (a glare spot, a torn corner) never feeds the ESF.
  ys: number[]
}

interface SpanMeasurement {
  spanPx: number
  parallelismDegrees: number
  straightnessPx: number
  edgePointCount: number
}

export function measureCard(
  cv: OpenCv,
  image: Mat,
  knownLongSideMm: number,
  nominalDpi: number,
): ScaleReferenceResult {
  if (!image || image.empty()) throw new Error('Image is null or empty.')
  if (knownLongSideMm <= 0) throw new Error('The reference length must be positive.')
  if (nominalDpi <= 0) throw new Error('The nominal scan dpi must be positive.')

  // The tracer runs on the same HSV value channel the detector thresholds, so a saturated coloured
  // card that detects also traces (BGR-to-gray luma can lose the contrast the value channel has).
  const value = valueChannel(cv, image)
  let transposed: Mat | null = null
  try {
    const found = tryFindCardBox(cv, image, knownLongSideMm, nominalDpi)
    if (!found.ok) return fail(found.error, found.rejectedLongSidePx)
    const box = found.box

    const portrait = box.height > box.width
    let work = value
    let wbox = box
    if (portrait) {
      transposed = new cv.Mat()
      cv.transpose(value, transposed)
      work = transposed
      wbox = { x: box.y, y: box.x, width: box.height, height: box.width }
    }

    // The short edges (near vertical in the landscape frame) bound the long side.
    const long = measureSpan(work, wbox, nominalDpi)
    if (!long)
      return fail(
        "Couldn't trace the card's long edges. Check the scan contrast and that the whole card is on the glass.",
      )
    if (long.spanPx <= 0) return fail("The detected edges don't bound a card. Try re-scanning.")

    const pxPerMm = long.spanPx / knownLongSideMm
    const detectedMm = nominalDpi > 0 ? long.spanPx / (nominalDpi / 25.4) : 0

    // The MEASURED px/mm gates the resolution, never the entered DPI, so a coarse scan cannot
    // sneak past a mistyped nominal figure and store an unusable calibration.
    const [resolution] = evaluateScanSetResolution([{ pxPerMm }])
    if (!resolution.ok) return fail(resolution.reason!, long.spanPx)

    return {
      success: true,
      pxPerMm,
      // In the original scan frame: a portrait card's long side runs along the image y axis.
      measuredAxis: portrait ? 'vertical' : 'horizontal',
      measuredWidthPx: long.spanPx,
      detectedMm,
      straightnessPx: long.straightnessPx,
      parallelismDegrees: long.parallelismDegrees,
      edgePointCount: long.edgePointCount,
    }
  } finally {
    value.delete()
    transposed?.delete()
  }
}

// The half-width of the edge search and projection window, in millimetres. 1.7 mm equals the 2%
// of the 85.60 mm long side the window used to be sized from, restated as a physical length so
// every dpi sees the same physical neighbourhood of the edge.
const EDGE_HALF_WINDOW_MM = 1.7

// Traces the two near-vertical edges of `box` in `work`, refines each edge's intercept with an
// ISO 12233 style slanted-edge projection (see refineEdgeIntercept), and returns the perpendicular
// span between them, or null when either edge yields too few points to trust or the refined edge
// has no significant gradient peak.
function measureSpan(work: Mat, box: Rect, nominalDpi: number): SpanMeasurement | null {
  const data = work.data as Uint8Array
  const cols = work.cols
  // A physical window; the floor only guarantees the window holds enough samples to interpolate.
  const halfWin = Math.max(2, Math.round((EDGE_HALF_WINDOW_MM * nominalDpi) / 25.4))
  const y0 = box.y + Math.trunc(box.height * 0.15)
  const y1 = box.y + Math.trunc(box.height * 0.85)

  const left = fitVerticalEdge(data, cols, y0, y1, box.x, halfWin)
  const right = fitVerticalEdge(data, cols, y0, y1, box.x + box.width, halfWin)
  if (left.n < 15 || right.n < 15) return null

  const cL = refineEdgeIntercept(data, cols, left, halfWin, nominalDpi)
  const cR = refineEdgeIntercept(data, cols, right, halfWin, nominalDpi)
  if (cL === null || cR === null) return null

  const yMid = (y0 + y1) / 2.0
  const xL = left.m * yMid + cL
  const xR = right.m * yMid + cR
  const mAvg = (left.m + right.m) / 2.0
  return {
    spanPx: (xR - xL) / Math.sqrt(1 + mAvg * mAvg),
    parallelismDegrees: (Math.abs(Math.atan(left.m) - Math.atan(right.m)) * 180.0) / Math.PI,
    straightnessPx: Math.max(left.rms, right.rms),
    edgePointCount: Math.min(left.n, right.n),
  }
}

// --- Slanted-edge sub-pixel refinement ------------------------------------------------------
//
// The per-row gradient-peak trace above localizes each row's edge from three discrete pixel
// gradients. A scanner edge profile is not symmetric (a shadow or halo hugs the card's physical
// edge), so the discrete peak carries a fixed sub-pixel offset from the true edge; and because the
// two long-side profiles mirror each other, the two per-edge offsets add OUTWARD in the span
// instead of cancelling. A fixed pixel offset per edge is a fixed relative error proportional to
// 1/dpi, which is exactly the dpi-dependent scale disagreement observed between scans.
//
// The fix is the ISO 12233 slanted-edge method: project every pixel in a band around the fitted
// edge line onto the edge normal, pooling hundreds of rows whose sub-pixel edge phases differ into
// one densely supersampled edge spread function (ESF). Working in millimetres, with the smoothing
// matched to the pixel aperture (below), the ESF and its gradient peak are the same physical curve
// at every dpi, so the residual localization offset is the same physical length at every dpi and
// the 1/dpi-proportional error disappears.

// The total mm-domain blur the smoothed ESF carries, as the standard deviation of the combined
// pixel-aperture and smoothing-kernel blur. Each dpi's pixel aperture already blurs by
// p^2/12 (the variance of a box of width p = 25.4/dpi mm), so the Gaussian regression kernel gets
// the remainder: sigma_k = sqrt(sigma_tot^2 - p^2/12) (pixel-aperture blur matching). The value is
// derived, not tuned: kernel regression over the binned ESF needs sigma_k >= p/2 at the lowest
// supported dpi of 150, which requires sigma_tot >= p/sqrt(3) = 0.098 mm; 0.10 mm is that bound
// rounded up.
const ESF_SIGMA_TOTAL_MM = 0.1

// The ESF is linearly binned at 0.02 mm pitch (comfortably below sigma_k, so binning adds no
// resolvable blur) and the smoothed ESF is evaluated on a 0.005 mm grid, fine enough that the
// 3-point parabolic peak refinement operates on a locally quadratic sampling of the derivative.
const ESF_BIN_PITCH_MM = 0.02
const ESF_GRID_STEP_MM = 0.005

// Refines one traced edge's intercept `c` by locating the gradient-magnitude peak of the pooled,
// mm-domain edge spread function, and returns the refined intercept, or null when the smoothed
// derivative has no peak that stands above its own noise floor (the same median + 3 MAD-derived
// sigma rule the per-row tracer uses). The projection is recentred on the refined line and run a
// second time so the window is symmetric about the found edge, which makes the kernel regression's
// support symmetric and the estimate self-consistent.
function refineEdgeIntercept(
  data: Uint8Array,
  cols: number,
  fit: EdgeFit,
  halfWin: number,
  nominalDpi: number,
): number | null {
  const mmPerPx = 25.4 / nominalDpi
  const apertureVariance = (mmPerPx * mmPerPx) / 12
  const kernelVariance = ESF_SIGMA_TOTAL_MM * ESF_SIGMA_TOTAL_MM - apertureVariance
  if (kernelVariance <= 0) {
    throw new Error(`The scan resolution (${nominalDpi} dpi) is too low for sub-pixel edge refinement.`)
  }
  const sigmaK = Math.sqrt(kernelVariance)

  let c = fit.c
  for (let pass = 0; pass < 2; pass++) {
    const du = esfGradientPeakOffsetMm(data, cols, fit.m, c, fit.ys, halfWin, mmPerPx, sigmaK)
    if (du === null) return null
    // The offset is measured along the edge normal in mm; convert it back to an x intercept shift.
    c += (du / mmPerPx) * Math.sqrt(1 + fit.m * fit.m)
  }
  return c
}

// Projects the band's pixels onto the edge normal (ISO 12233 slanted-edge projection), smooths the
// pooled samples with a binned Gaussian kernel regression (Nadaraya-Watson estimator), and returns
// the sub-grid offset of the gradient-magnitude peak from the current line, in millimetres, or
// null when no significant peak exists.
function esfGradientPeakOffsetMm(
  data: Uint8Array,
  cols: number,
  m: number,
  c: number,
  ys: number[],
  halfWin: number,
  mmPerPx: number,
  sigmaK: number,
): number | null {
  const norm = Math.sqrt(1 + m * m)
  const binCount = Math.round((2 * EDGE_HALF_WINDOW_MM) / ESF_BIN_PITCH_MM) + 1
  const binWeight = new Float64Array(binCount)
  const binValue = new Float64Array(binCount)

  for (const y of ys) {
    const xc = m * y + c
    const x0 = Math.ceil(xc - halfWin)
    const x1 = Math.floor(xc + halfWin)
    if (x0 < 0 || x1 > cols - 1) continue // a row whose window leaves the image contributes nothing
    const row = y * cols
    for (let x = x0; x <= x1; x++) {
      const uMm = (((x - xc) / norm) * mmPerPx + EDGE_HALF_WINDOW_MM) / ESF_BIN_PITCH_MM
      const i0 = Math.floor(uMm)
      if (i0 < 0 || i0 >= binCount) continue
      const w1 = uMm - i0 // linear binning: the sample splits between its two nearest bins
      const v = data[row + x]
      binWeight[i0] += 1 - w1
      binValue[i0] += (1 - w1) * v
      if (i0 + 1 < binCount) {
        binWeight[i0 + 1] += w1
        binValue[i0 + 1] += w1 * v
      }
    }
  }

  // Nadaraya-Watson Gaussian kernel regression evaluated on the fine grid, computed over the bins
  // (each bin stands for its pooled samples, which the linear binning placed to first order).
  const gridCount = Math.round((2 * EDGE_HALF_WINDOW_MM) / ESF_GRID_STEP_MM) + 1
  const esf = new Float64Array(gridCount)
  for (let i = 0; i < gridCount; i++) {
    const g = -EDGE_HALF_WINDOW_MM + i * ESF_GRID_STEP_MM
    let num = 0
    let den = 0
    for (let j = 0; j < binCount; j++) {
      if (binWeight[j] === 0) continue
      const b = -EDGE_HALF_WINDOW_MM + j * ESF_BIN_PITCH_MM
      const t = (g - b) / sigmaK
      const w = Math.exp(-0.5 * t * t)
      num += w * binValue[j]
      den += w * binWeight[j]
    }
    if (den <= 0) return null // an empty stretch of the window: the band ran off the data
    esf[i] = num / den
  }

  // Central-difference derivative magnitude on the uniform grid.
  const da = new Float64Array(gridCount - 2)
  for (let i = 1; i < gridCount - 1; i++) {
    da[i - 1] = Math.abs((esf[i + 1] - esf[i - 1]) / (2 * ESF_GRID_STEP_MM))
  }
  let pi = 0
  for (let i = 1; i < da.length; i++) if (da[i] > da[pi]) pi = i
  if (pi <= 0 || pi >= da.length - 1) return null

  // The peak must stand above the smoothed derivative's own noise floor (median + 3 MAD sigmas).
  const daArr = Array.from(da)
  const med = median(daArr)
  const sigma = 1.4826 * median(daArr.map((v) => Math.abs(v - med)))
  if (da[pi] <= med + EDGE_PEAK_MAD_SIGMAS * sigma) return null

  // 3-point parabolic refinement: safe here because the grid is uniform and the mm-domain
  // smoothing is identical at every dpi, so the parabola sees the same physical curve everywhere.
  const dm = da[pi - 1]
  const dc = da[pi]
  const dp = da[pi + 1]
  const denom = dm - 2 * dc + dp
  const sub = Math.abs(denom) < 1e-12 ? 0 : (0.5 * (dm - dp)) / denom
  return -EDGE_HALF_WINDOW_MM + (pi + 1 + sub) * ESF_GRID_STEP_MM
}

// The ISO/IEC 7810 ID-1 card is 85.60 x 53.98 mm; its side ratio identifies it among the other
// rectangles a scan can contain (backing sheet, lid margin). The 5% bound is generous cover for
// scanner anisotropy (below 1%), the sub-pixel raggedness of a thresholded outline, and worn card
// edges; the nearest competing rectangle, an ISO 216 paper sheet at ratio sqrt(2) ~ 1.414, sits
// about 11% away, so the bound separates the two cleanly.
const CARD_SIDE_RATIO = 85.6 / 53.98
const CARD_RATIO_TOLERANCE = 0.05

// Size gate against the known card geometry: the expected long side in pixels follows from the
// known card length and the scan's nominal dpi, so a candidate whose long side is far from it
// cannot be the card. The +-25% bound is a feasibility bound, not a tuned constant: physical
// scanner dpi error is on the order of 1%, so any real card lands well inside it, while
// card-ratio graphics printed ON the card (a logo) are several times smaller and fall far outside.
const CARD_SIZE_TOLERANCE = 0.25

// Sub-pixel edge tracing needs enough edge rows to fit a line robustly; below this the candidate
// cannot be measured regardless of what it is.
const MIN_SHORT_SIDE_PX = 120

// An inner box is discarded as a feature OF its container (a chip, a logo) only when it is much
// smaller than the container. The bound follows from the card geometry: the largest legitimate
// interior feature of an ID-1 card covers well under half the card face, while a true card nested
// inside a card-ratio encloser (a sleeve, a backing cut to card shape) is comparable in size to it
// and must stay in play.
const SUB_FEATURE_AREA_FRACTION = 0.5

// Finds the card by hypothesis testing: no threshold or polarity is guessed. Every threshold-band
// hypothesis is searched for the largest card-shaped rectangle (minAreaRect side ratio matching
// ID-1, so a slight rotation doesn't distort the test) near the size the nominal dpi predicts.
// The same physical card resurfaces in several hypotheses, so candidates are merged by overlap.
// A small box inside a larger candidate (a graphic printed on the card) is discarded; a nested
// near-equal pair (the card inside a card-shaped encloser) is resolved by which long side matches
// the size the dpi predicts. Exactly one rectangle remaining makes it the card. None means no card
// is in view; several distinct, non-nested ones mean the scene is ambiguous.
function tryFindCardBox(
  cv: OpenCv,
  image: Mat,
  knownLongSideMm: number,
  nominalDpi: number,
): { ok: true; box: Rect } | { ok: false; error: string; rejectedLongSidePx: number | null } {
  const expectedLongPx = nominalDpi > 0 ? (knownLongSideMm * nominalDpi) / 25.4 : 0
  // Card-shaped candidates the size gate rejected, kept so a "no card" outcome can still say
  // "something card-shaped was there, but at the wrong size" (a scan at a different resolution).
  const sizeRejected: Rect[] = []
  const candidates = analyzeThresholdBands(cv, image, (objectWhite) =>
    cardCandidate(cv, objectWhite, expectedLongPx, sizeRejected),
  ).filter((c) => c !== null)

  const merged: Rect[] = []
  for (const c of candidates) {
    if (!merged.some((d) => sameObject(d, c))) merged.push(c)
  }

  const distinct = merged.filter(
    (c) =>
      !merged.some(
        (d) => d !== c && containsBox(d, c) && boxArea(c) < SUB_FEATURE_AREA_FRACTION * boxArea(d),
      ),
  )

  if (distinct.length === 0) {
    // The best size-rejected candidate is the largest: refinds of the same object across threshold
    // hypotheses all qualify, and the largest box is the least eroded outline of it.
    const bestRejected = sizeRejected.reduce<Rect | null>(
      (a, b) => (a === null || boxArea(b) > boxArea(a) ? b : a),
      null,
    )
    return {
      ok: false,
      error:
        'No card-shaped object was found. Place the card flat on the glass; a pale card needs a dark sheet behind it.',
      rejectedLongSidePx: bestRejected ? longSide(bestRejected) : null,
    }
  }
  if (distinct.length > 1) {
    const resolved = resolveNestedCandidates(distinct, expectedLongPx)
    if (resolved) return { ok: true, box: resolved }
    return {
      ok: false,
      error:
        'More than one card-shaped object was found, so the card could not be told from the background. Rescan with only the card on a plain backing.',
      rejectedLongSidePx: null,
    }
  }
  return { ok: true, box: distinct[0] }
}

// When every surviving candidate is nested inside another (a containment chain: card in sleeve in
// backing), exactly one of them is the physical card, and the known card size names it: the one
// whose long side is closest to what the dpi predicts. Non-nested candidates are genuinely distinct
// objects and stay ambiguous, so null is returned and the caller reports the ambiguity.
function resolveNestedCandidates(distinct: Rect[], expectedLongPx: number): Rect | null {
  if (expectedLongPx <= 0) return null
  for (let i = 0; i < distinct.length; i++) {
    for (let j = i + 1; j < distinct.length; j++) {
      if (!containsBox(distinct[i], distinct[j]) && !containsBox(distinct[j], distinct[i])) return null
    }
  }
  return distinct.reduce((a, b) =>
    Math.abs(longSide(b) - expectedLongPx) < Math.abs(longSide(a) - expectedLongPx) ? b : a,
  )
}

function longSide(r: Rect): number {
  return Math.max(r.width, r.height)
}

function boxArea(r: Rect): number {
  return r.width * r.height
}

// Whether two boxes describe the same physical object: intersection-over-union above 0.8. Refinds
// of one card across threshold hypotheses differ only by the thresholded outline's few-pixel drift,
// so their IoU is near 1; genuinely different rectangles in a scan overlap far less or not at all.
function sameObject(a: Rect, b: Rect): boolean {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  const inter = ix * iy
  const union = a.width * a.height + b.width * b.height - inter
  return union > 0 && inter / union > 0.8
}

// Whether box `inner` lies entirely inside box `outer`.
function containsBox(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}

// The largest card-shaped external contour in one part-white binary, as its upright bounding box
// (the edge tracer works on the upright box), or null when nothing card-shaped is present. When
// the expected long side is known (nominal dpi given), size-gates candidates against it. A box
// touching the image border is rejected outright: a card fully on the glass never reaches the scan
// border, so such a contour is backing or lid, or a card that cannot be measured anyway.
function cardCandidate(
  cv: OpenCv,
  objectWhite: Mat,
  expectedLongPx: number,
  sizeRejected: Rect[],
): Rect | null {
  const closed = new cv.Mat()
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  try {
    const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5))
    cv.morphologyEx(objectWhite, closed, cv.MORPH_CLOSE, kernel)
    kernel.delete()

    cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

    let bestArea = 0
    let best: Rect | null = null
    const count = contours.size()
    for (let i = 0; i < count; i++) {
      const contour = contours.get(i)
      try {
        const rot = cv.minAreaRect(contour)
        const long = Math.max(rot.size.width, rot.size.height)
        const short = Math.min(rot.size.width, rot.size.height)
        if (short < MIN_SHORT_SIDE_PX) continue // too small to trace sub-pixel edges on
        if (Math.abs(long / short - CARD_SIDE_RATIO) / CARD_SIDE_RATIO > CARD_RATIO_TOLERANCE) continue
        if (expectedLongPx > 0 && Math.abs(long - expectedLongPx) / expectedLongPx > CARD_SIZE_TOLERANCE) {
          sizeRejected.push(cv.boundingRect(contour) as Rect)
          continue
        }
        const box = cv.boundingRect(contour) as Rect
        if (
          box.x <= 0 ||
          box.y <= 0 ||
          box.x + box.width >= objectWhite.cols ||
          box.y + box.height >= objectWhite.rows
        )
          continue
        const area = long * short
        if (area > bestArea) {
          bestArea = area
          best = box
        }
      } finally {
        contour.delete()
      }
    }
    return best
  } finally {
    closed.delete()
    contours.delete()
    hierarchy.delete()
  }
}

// Fits x = c + m*y to a near-vertical edge (one sub-pixel edge point per row), then one robust (MAD)
// outlier-rejection pass so a stray row can't tilt the edge. Two window passes: the first centres
// every row's search window at the upright bounding-box edge (constant over rows), which on a
// rotated card loses the extremes; the second re-centres each row's window on the first fit's
// prediction, so the whole traced span stays inside the window. One iteration suffices because the
// first fit's inliers already pin the slope.
function fitVerticalEdge(
  data: Uint8Array,
  cols: number,
  y0: number,
  y1: number,
  xCentre: number,
  halfWin: number,
): EdgeFit {
  const first = fitEdgePass(data, cols, y0, y1, () => xCentre, halfWin)
  if (first.n < 3) return first
  return fitEdgePass(data, cols, y0, y1, (y) => first.m * y + first.c, halfWin)
}

function fitEdgePass(
  data: Uint8Array,
  cols: number,
  y0: number,
  y1: number,
  predictX: (y: number) => number,
  halfWin: number,
): EdgeFit {
  const ys: number[] = []
  const xs: number[] = []
  for (let y = y0; y <= y1; y++) {
    const xc = Math.round(predictX(y))
    const xe = subPixEdge(data, cols, y, xc - halfWin, xc + halfWin)
    if (!Number.isNaN(xe)) {
      ys.push(y)
      xs.push(xe)
    }
  }
  if (ys.length < 3) return { m: 0, c: 0, rms: 0, n: ys.length, ys }

  const { c, m } = fitLine(ys, xs) // x = c + m*y

  const absResiduals = ys.map((yy, i) => Math.abs(xs[i] - (m * yy + c)))
  const sigma = 1.4826 * median(absResiduals)
  if (sigma > 1e-6) {
    const y2: number[] = []
    const x2: number[] = []
    for (let i = 0; i < ys.length; i++) {
      if (absResiduals[i] <= 3 * sigma) {
        y2.push(ys[i])
        x2.push(xs[i])
      }
    }
    if (y2.length >= 3) {
      const fit = fitLine(y2, x2)
      return { m: fit.m, c: fit.c, rms: rms(y2, x2, fit.m, fit.c), n: y2.length, ys: y2 }
    }
  }
  return { m, c, rms: rms(ys, xs, m, c), n: ys.length, ys }
}

// A row's gradient peak counts as an edge only when it stands above the row's own noise: the
// standard robust rule of the median plus three MAD-derived standard deviations of the window's
// gradient magnitudes. A flat window rejects itself (peak equals median); a genuine step exceeds
// the noise floor at any contrast or dpi, which a fixed absolute floor cannot promise.
const EDGE_PEAK_MAD_SIGMAS = 3

// Sub-pixel column of the strongest intensity step within [xLo, xHi] on row y, via the gradient
// magnitude peak with parabolic interpolation. Magnitude (not sign) so it finds either polarity.
// Known limitation: a scanner halo or shadow hugging the card edge can carry a gradient step of its
// own; the strongest step in the window wins, so a halo stronger than the physical edge shifts the
// traced line outward. The polarity of the card against its backing is not carried down to this
// tracer, so the step's sign cannot be gated here.
function subPixEdge(data: Uint8Array, cols: number, y: number, xLo: number, xHi: number): number {
  xLo = Math.max(1, xLo)
  xHi = Math.min(cols - 2, xHi)
  if (xHi < xLo) return NaN
  const row = y * cols
  const mags: number[] = []
  let best = -1
  let bx = -1
  for (let x = xLo; x <= xHi; x++) {
    const g = Math.abs(data[row + x + 1] - data[row + x - 1])
    mags.push(g)
    if (g > best) {
      best = g
      bx = x
    }
  }
  if (bx <= xLo || bx >= xHi) return NaN
  const med = median(mags)
  const sigma = 1.4826 * median(mags.map((g) => Math.abs(g - med)))
  if (best <= med + EDGE_PEAK_MAD_SIGMAS * sigma) return NaN // indistinguishable from the row's noise

  const gm = Math.abs(data[row + bx] - data[row + bx - 2])
  const gc = Math.abs(data[row + bx + 1] - data[row + bx - 1])
  const gp = Math.abs(data[row + bx + 2] - data[row + bx])
  const denom = gm - 2 * gc + gp
  const sub = Math.abs(denom) < 1e-9 ? 0 : (0.5 * (gm - gp)) / denom
  return bx + Math.min(1, Math.max(-1, sub))
}

// Least-squares fit of x = c + m*y (matches MathNet Fit.Line).
function fitLine(ys: number[], xs: number[]): { c: number; m: number } {
  const n = ys.length
  let sy = 0
  let sx = 0
  for (let i = 0; i < n; i++) {
    sy += ys[i]
    sx += xs[i]
  }
  const my = sy / n
  const mx = sx / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const dy = ys[i] - my
    num += dy * (xs[i] - mx)
    den += dy * dy
  }
  const m = den === 0 ? 0 : num / den
  const c = mx - m * my
  return { c, m }
}

function rms(ys: number[], xs: number[], m: number, c: number): number {
  if (ys.length === 0) return 0
  let s = 0
  for (let i = 0; i < ys.length; i++) {
    const e = xs[i] - (m * ys[i] + c)
    s += e * e
  }
  return Math.sqrt(s / ys.length)
}

function fail(message: string, rejectedLongSidePx: number | null = null): ScaleReferenceResult {
  return {
    success: false,
    pxPerMm: 0,
    measuredWidthPx: 0,
    detectedMm: 0,
    straightnessPx: 0,
    parallelismDegrees: 0,
    edgePointCount: 0,
    message,
    rejectedLongSidePx,
  }
}
