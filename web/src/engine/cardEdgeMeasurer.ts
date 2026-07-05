import type { Mat, OpenCv } from './opencv'
import type { ScaleReferenceResult } from './types'
import { median } from './math'
import { analyzeThresholdBands } from './cvUtils'

// Measures a reference card's long side to sub-pixel precision: locates the card by validating both
// threshold polarities against the ISO/IEC 7810 ID-1 shape, fits each long edge as a straight line
// from sub-pixel gradient-peak edge points (one per scan row), and takes the perpendicular distance
// between the two lines. The long side is measured in a frame where it runs horizontally (portrait
// is transposed).

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
}

export function measureCard(
  cv: OpenCv,
  image: Mat,
  knownLongSideMm: number,
  nominalDpi: number,
): ScaleReferenceResult {
  if (!image || image.empty()) throw new Error('Image is null or empty.')
  if (knownLongSideMm <= 0) throw new Error('The reference length must be positive.')

  const gray = toGray(cv, image)
  let transposed: Mat | null = null
  try {
    const found = tryFindCardBox(cv, image)
    if (!found.ok) return fail(found.error)
    const box = found.box

    const portrait = box.height > box.width
    let work = gray
    let wbox = box
    if (portrait) {
      transposed = new cv.Mat()
      cv.transpose(gray, transposed)
      work = transposed
      wbox = { x: box.y, y: box.x, width: box.height, height: box.width }
    }

    const data = work.data as Uint8Array
    const cols = work.cols
    const halfWin = clampInt(Math.trunc(wbox.width * 0.02), 12, 60)
    const y0 = wbox.y + Math.trunc(wbox.height * 0.15)
    const y1 = wbox.y + Math.trunc(wbox.height * 0.85)

    const left = fitVerticalEdge(data, cols, y0, y1, wbox.x, halfWin) // wbox.Left
    const right = fitVerticalEdge(data, cols, y0, y1, wbox.x + wbox.width, halfWin) // wbox.Right
    if (left.n < 15 || right.n < 15)
      return fail(
        "Couldn't trace the card's long edges. Check the scan contrast and that the whole card is on the glass.",
      )

    const yMid = (y0 + y1) / 2.0
    const xL = left.m * yMid + left.c
    const xR = right.m * yMid + right.c
    const mAvg = (left.m + right.m) / 2.0
    const widthPx = (xR - xL) / Math.sqrt(1 + mAvg * mAvg)
    if (widthPx <= 0) return fail("The detected edges don't bound a card. Try re-scanning.")

    const pxPerMm = widthPx / knownLongSideMm
    const parallelDeg = (Math.abs(Math.atan(left.m) - Math.atan(right.m)) * 180.0) / Math.PI
    const straightness = Math.max(left.rms, right.rms)
    const detectedMm = nominalDpi > 0 ? widthPx / (nominalDpi / 25.4) : 0

    return {
      success: true,
      pxPerMm,
      measuredWidthPx: widthPx,
      detectedMm,
      straightnessPx: straightness,
      parallelismDegrees: parallelDeg,
      edgePointCount: Math.min(left.n, right.n),
    }
  } finally {
    gray.delete()
    transposed?.delete()
  }
}

function toGray(cv: OpenCv, image: Mat): Mat {
  const gray = new cv.Mat()
  if (image.channels() === 1) image.copyTo(gray)
  else cv.cvtColor(image, gray, cv.COLOR_BGR2GRAY)
  // Input is always 8-bit here (decoded from a canvas or a PNG), so no high-bit-depth path is needed.
  return gray
}

// The ISO/IEC 7810 ID-1 card is 85.60 x 53.98 mm; its side ratio identifies it among the other
// rectangles a scan can contain (backing sheet, lid margin). The 5% bound is generous cover for
// scanner anisotropy (below 1%), the sub-pixel raggedness of a thresholded outline, and worn card
// edges; the nearest competing rectangle, an ISO 216 paper sheet at ratio sqrt(2) ~ 1.414, sits
// about 11% away, so the bound separates the two cleanly.
const CARD_SIDE_RATIO = 85.6 / 53.98
const CARD_RATIO_TOLERANCE = 0.05

// Finds the card by hypothesis testing: no threshold or polarity is guessed. Every threshold-band
// hypothesis is searched for the largest card-shaped rectangle (minAreaRect side ratio matching
// ID-1, so a slight rotation doesn't distort the test). The same physical card resurfaces in
// several hypotheses, so candidates are merged by overlap; exactly one distinct rectangle makes it
// the card. None means no card is in view; several distinct ones mean the scene is ambiguous.
function tryFindCardBox(cv: OpenCv, image: Mat): { ok: true; box: Rect } | { ok: false; error: string } {
  const candidates = analyzeThresholdBands(cv, image, (objectWhite) =>
    cardCandidate(cv, objectWhite),
  ).filter((c) => c !== null)

  const distinct: Rect[] = []
  for (const c of candidates) {
    if (!distinct.some((d) => sameObject(d, c))) distinct.push(c)
  }

  if (distinct.length === 0)
    return {
      ok: false,
      error:
        'No card-shaped object was found. Place the card flat on the glass; a pale card needs a dark sheet behind it.',
    }
  if (distinct.length > 1)
    return {
      ok: false,
      error:
        'More than one card-shaped object was found, so the card could not be told from the background. Rescan with only the card on a plain backing.',
    }
  return { ok: true, box: distinct[0] }
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

// The largest card-shaped external contour in one part-white binary, as its upright bounding box
// (the edge tracer works on the upright box), or null when nothing card-shaped is present.
function cardCandidate(cv: OpenCv, objectWhite: Mat): Rect | null {
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
        if (short < 120) continue // too small to trace sub-pixel edges on
        if (Math.abs(long / short - CARD_SIDE_RATIO) / CARD_SIDE_RATIO > CARD_RATIO_TOLERANCE) continue
        const area = long * short
        if (area > bestArea) {
          bestArea = area
          best = cv.boundingRect(contour) as Rect
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
// outlier-rejection pass so a stray row can't tilt the edge.
function fitVerticalEdge(
  data: Uint8Array,
  cols: number,
  y0: number,
  y1: number,
  xCentre: number,
  halfWin: number,
): EdgeFit {
  const ys: number[] = []
  const xs: number[] = []
  for (let y = y0; y <= y1; y++) {
    const xe = subPixEdge(data, cols, y, xCentre - halfWin, xCentre + halfWin)
    if (!Number.isNaN(xe)) {
      ys.push(y)
      xs.push(xe)
    }
  }
  if (ys.length < 3) return { m: 0, c: 0, rms: 0, n: ys.length }

  let { c, m } = fitLine(ys, xs) // x = c + m*y

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
      return { m: fit.m, c: fit.c, rms: rms(y2, x2, fit.m, fit.c), n: y2.length }
    }
  }
  return { m, c, rms: rms(ys, xs, m, c), n: ys.length }
}

// Sub-pixel column of the strongest intensity step within [xLo, xHi] on row y, via the gradient
// magnitude peak with parabolic interpolation. Magnitude (not sign) so it finds either polarity.
function subPixEdge(data: Uint8Array, cols: number, y: number, xLo: number, xHi: number): number {
  xLo = Math.max(1, xLo)
  xHi = Math.min(cols - 2, xHi)
  const row = y * cols
  let best = -1
  let bx = -1
  for (let x = xLo; x <= xHi; x++) {
    const g = Math.abs(data[row + x + 1] - data[row + x - 1])
    if (g > best) {
      best = g
      bx = x
    }
  }
  if (bx <= xLo || bx >= xHi || best < 8) return NaN // a flat, noise-only window

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

function clampInt(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}

function fail(message: string): ScaleReferenceResult {
  return {
    success: false,
    pxPerMm: 0,
    measuredWidthPx: 0,
    detectedMm: 0,
    straightnessPx: 0,
    parallelismDegrees: 0,
    edgePointCount: 0,
    message,
  }
}
