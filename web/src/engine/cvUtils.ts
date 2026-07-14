import type { Mat, OpenCv } from './opencv'
import type { BackdropAssessment } from './measurementBackdrop'

// The HSV value channel (V = max(B, G, R)) as a fresh single-channel Mat the caller deletes. A
// single-channel input is copied as-is. Note: this build of OpenCV.js does not export extractChannel,
// so the channel is taken via split; MatVector.get(i) hands out a wrapper sharing the vector's native
// memory, so the channel must be cloned before the vector is deleted.
export function valueChannel(cv: OpenCv, image: Mat): Mat {
  if (image.channels() === 1) return image.clone()
  const hsv = new cv.Mat()
  cv.cvtColor(image, hsv, cv.COLOR_BGR2HSV)
  const channels = new cv.MatVector()
  cv.split(hsv, channels)
  const channel = channels.get(2)
  const v = channel.clone()
  channel.delete()
  channels.delete()
  hsv.delete()
  return v
}

// The HSV saturation channel as a fresh single-channel Mat the caller deletes. S marks chromatic
// pixels, so it separates colored plastic from a neutral (white or gray) backdrop that matches it
// in brightness. A single-channel input carries no color, so asking for its saturation is a caller
// bug and throws. Same split-and-clone dance as valueChannel (no extractChannel in this build).
export function saturationChannel(cv: OpenCv, image: Mat): Mat {
  if (image.channels() === 1)
    throw new Error('Saturation channel requested for a single-channel image.')
  const hsv = new cv.Mat()
  cv.cvtColor(image, hsv, cv.COLOR_BGR2HSV)
  const channels = new cv.MatVector()
  cv.split(hsv, channels)
  const channel = channels.get(1)
  const s = channel.clone()
  channel.delete()
  channels.delete()
  hsv.delete()
  return s
}

/**
 * Minimum sample triples per class for the discriminant: a 2x2 within-class scatter in
 * chromaticity needs more samples than dimensions per class to be a stable (full-information)
 * estimate, so at least one more than the 2 chromaticity dimensions.
 */
const MIN_DISCRIMINANT_SAMPLES = 3

// Reads the BGR triple at each pixel position of a 3-channel 8-bit image, rounding fractional
// positions to the nearest pixel and skipping positions outside the image. This is how the flows
// turn their gate sample positions into the class samples discriminantChannel needs; the class
// means and scatter only need representative colors, not sub-pixel interpolation.
export function sampleBgrTriples(image: Mat, points: { x: number; y: number }[]): number[][] {
  if (image.channels() !== 3) return []
  const data = image.data as Uint8Array
  const cols = image.cols
  const rows = image.rows
  const triples: number[][] = []
  for (const p of points) {
    const x = Math.round(p.x)
    const y = Math.round(p.y)
    if (x < 0 || y < 0 || x >= cols || y >= rows) continue
    const i = (y * cols + x) * 3
    triples.push([data[i], data[i + 1], data[i + 2]])
  }
  return triples
}

// The normalized-rgb chromaticity of a BGR triple: (r, g) = (R/(R+G+B), G/(R+G+B)). A pure
// black pixel (sum 0) has no chromaticity, so it maps to the neutral point (1/3, 1/3): claiming
// any hue for it would be inventing information.
const chromaticity = (b: number, g: number, r: number): [number, number] => {
  const sum = b + g + r
  if (sum === 0) return [1 / 3, 1 / 3]
  return [r / sum, g / sum]
}

const meanChromaticity = (samples: number[][]): [number, number] => {
  const m: [number, number] = [0, 0]
  for (const s of samples) {
    const [r, g] = chromaticity(s[0], s[1], s[2])
    m[0] += r
    m[1] += g
  }
  m[0] /= samples.length
  m[1] /= samples.length
  return m
}

// Solves the 2x2 linear system A x = b in closed form, returning null when the determinant is
// degenerate relative to the matrix's scale (a dimensionless guard, the same construction the
// tone detrend's plane fit uses).
function solve2(A: number[][], b: number[]): [number, number] | null {
  const det = A[0][0] * A[1][1] - A[0][1] * A[1][0]
  let norm = 0
  for (const row of A) for (const v of row) norm += v * v
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9 * Math.max(norm, 1e-12)) {
    return null
  }
  return [(b[0] * A[1][1] - b[1] * A[0][1]) / det, (b[1] * A[0][0] - b[0] * A[1][0]) / det]
}

/**
 * Fisher linear discriminant (LDA projection to one dimension) of a BGR image in normalized-rgb
 * chromaticity coordinates, against two color classes: the flow's plastic-tone samples and its
 * backdrop-tone samples. Each color maps to (r, g) = (R/(R+G+B), G/(R+G+B)) first; this
 * chromaticity space is invariant to multiplicative illumination change, so scanner-lamp shadow
 * and paper wrinkle shading cancel by construction (the standard shadow-robust color
 * segmentation representation), where a raw-BGR discriminant would project a shadowed backdrop
 * onto the plastic side. The Fisher criterion then finds the projection axis w maximizing
 * between-class separation over within-class variance in (r, g): Sw w = m1 - m2 (the pooled 2x2
 * within-class scatter against the mean difference, solved in closed form); a degenerate
 * scatter falls back to w = m1 - m2, the nearest-mean projection. The projection is mapped to
 * 8 bits linearly with the provided samples' own projection range spanning [0, 255] (values
 * outside saturate), so the normalization is defined entirely by the data. Returns null when
 * the classes are too small for a stable scatter estimate or carry no mean separation;
 * otherwise a CV_8UC1 Mat the caller deletes.
 */
export function discriminantChannel(
  cv: OpenCv,
  imageBgr: Mat,
  featureBgr: number[][],
  backdropBgr: number[][],
): Mat | null {
  if (imageBgr.channels() !== 3) return null
  if (
    featureBgr.length < MIN_DISCRIMINANT_SAMPLES ||
    backdropBgr.length < MIN_DISCRIMINANT_SAMPLES
  ) {
    return null
  }
  const m1 = meanChromaticity(featureBgr)
  const m2 = meanChromaticity(backdropBgr)
  const diff: [number, number] = [m1[0] - m2[0], m1[1] - m2[1]]
  if (diff[0] === 0 && diff[1] === 0) return null

  // Pooled within-class scatter Sw = sum over both classes of (x - m)(x - m)^T in (r, g).
  const sw = [
    [0, 0],
    [0, 0],
  ]
  for (const [samples, m] of [
    [featureBgr, m1],
    [backdropBgr, m2],
  ] as const) {
    for (const s of samples) {
      const [r, g] = chromaticity(s[0], s[1], s[2])
      const d = [r - m[0], g - m[1]]
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) sw[i][j] += d[i] * d[j]
    }
  }
  const w = solve2(sw, diff) ?? diff

  // Linear 8-bit mapping: the samples' own projections define the range mapped onto [0, 255].
  const project = (s: number[]) => {
    const [r, g] = chromaticity(s[0], s[1], s[2])
    return w[0] * r + w[1] * g
  }
  let min = Infinity
  let max = -Infinity
  for (const s of featureBgr) {
    const p = project(s)
    if (p < min) min = p
    if (p > max) max = p
  }
  for (const s of backdropBgr) {
    const p = project(s)
    if (p < min) min = p
    if (p > max) max = p
  }
  if (!(max > min)) return null

  // The per-pixel chromaticity normalization is nonlinear in BGR, so no cv.transform kernel can
  // apply it; a single pass over the 8UC3 data buffer computes the scaled projection directly
  // into a preallocated CV_8UC1 plane with no per-pixel allocation.
  const scale = 255 / (max - min)
  const dst = new cv.Mat(imageBgr.rows, imageBgr.cols, cv.CV_8UC1)
  const src = imageBgr.data as Uint8Array
  const out = dst.data as Uint8Array
  const wr = w[0]
  const wg = w[1]
  const neutral = (wr + wg) / 3
  for (let i = 0, j = 0; j < out.length; i += 3, j++) {
    const bb = src[i]
    const gg = src[i + 1]
    const rr = src[i + 2]
    const sum = bb + gg + rr
    const p = sum === 0 ? neutral : (wr * rr + wg * gg) / sum
    const v = (p - min) * scale
    out[j] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v)
  }
  return dst
}

// Selects the grayscale plane a flow measures on, judged by its own measurement-backdrop gate:
// the value channel, for a color input the saturation channel, and, when the caller provides
// class color samples, the Fisher discriminant plane are each assessed, and the passing
// candidate with the highest contrast wins (the value channel wins ties by coming
// first). A saturated coupon on a white backdrop matches it in value but not in saturation, so
// only the S plane carries measurable contrast there; a colored coupon on a backdrop matching it
// in both brightness and saturation separates only in the discriminant plane; a neutral scene
// keeps the value plane, unchanged. This is the same model selection between channel hypotheses
// the threshold-band sweep applies to alignment. When no candidate passes, the highest-contrast
// one is returned so the reported failure describes the best hypothesis, not an arbitrary one.
// `colorSamples` are BGR triples read at the same positions the flow's gate samples its feature
// and backdrop tones from. Losing candidates are deleted here; the caller deletes the returned
// Mat.
export function selectMeasurementChannel(
  cv: OpenCv,
  image: Mat,
  assess: (gray: Mat) => BackdropAssessment,
  colorSamples?: { feature: number[][]; backdrop: number[][] },
): { gray: Mat; assessment: BackdropAssessment } {
  const candidates = [valueChannel(cv, image)]
  if (image.channels() >= 3) {
    candidates.push(saturationChannel(cv, image))
    if (colorSamples) {
      const discriminant = discriminantChannel(
        cv,
        image,
        colorSamples.feature,
        colorSamples.backdrop,
      )
      if (discriminant) candidates.push(discriminant)
    }
  }

  let best: { gray: Mat; assessment: BackdropAssessment } | null = null
  for (const gray of candidates) {
    const assessment = assess(gray)
    const passes = assessment.failure === null
    const bestPasses = best !== null && best.assessment.failure === null
    const better =
      best === null ||
      (passes && !bestPasses) ||
      (passes === bestPasses && assessment.contrast > best.assessment.contrast)
    if (better) {
      best?.gray.delete()
      best = { gray, assessment }
    } else {
      gray.delete()
    }
  }
  return best!
}

// Runs `analyze` on every threshold-band hypothesis of the image's value channel: the two
// polarities of the single Otsu threshold, every band and band-union of the two-level Otsu
// split (Otsu's method extended to three classes), and every band and contiguous band-union of
// the three-level Otsu split (four classes). A scene with three intensity populations (a
// backing sheet, the object, a bright scanner-lid margin) has no single threshold that isolates the
// object; one of the three-class bands does. A part scanned on its textured build plate adds a
// fourth population (the plate's dark speckle between the plate bulk and the plastic), which only
// a four-class band separates. Which hypothesis is right is NOT guessed from image statistics
// (a border mean flips when the backing sheet stops short of the scan bed and bright scanner-lid
// margins reach the border); the caller validates each hypothesis against known geometry and
// keeps what fits: model selection, no tuned guess. Duplicate bands are analysed once.
// For a color input the same band sweep then runs over the saturation channel: a saturated coupon
// on a white backdrop matches it in value but not in saturation, so only an S band isolates it.
// The first validated hypothesis wins, whichever channel it came from. `analyze` must not retain
// or mutate the binary it is given. When `isDone` is provided, band evaluation stops as soon as it
// returns true for a result, and the results collected so far are returned; without it every band
// is analysed.
export function analyzeThresholdBands<T>(
  cv: OpenCv,
  image: Mat,
  analyze: (objectWhite: Mat) => T,
  isDone?: (result: T) => boolean,
): T[] {
  if (!image || image.empty()) throw new Error('Image is null or empty.')
  const results: T[] = []
  const bands = new Set<string>()
  const binary = new cv.Mat()

  // Sweeps every threshold-band hypothesis of one single-channel plane, appending to the shared
  // results. Returns true when isDone accepted a result, so the caller stops sweeping channels.
  // Bands are deduplicated per channel: numerically identical bands on different channels are
  // different hypotheses.
  const sweepChannel = (channelName: string, channel: Mat): boolean => {
    const t = cv.threshold(channel, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU)
    const hist = histogram256(channel)
    const [t1, t2] = twoLevelOtsu(hist)
    const [u0, u1, u2] = threeLevelOtsu(hist)
    for (const [lo, hi] of [
      [t + 1, 255], // single-Otsu bright
      [0, t], // single-Otsu dark
      [0, t1],
      [t1 + 1, t2],
      [t2 + 1, 255],
      [0, t2],
      [t1 + 1, 255],
      // Four-class bands and their contiguous unions, tried last so scenes the three-class split
      // already handles keep their early exit.
      [0, u0],
      [u0 + 1, u1],
      [u1 + 1, u2],
      [u2 + 1, 255],
      [0, u1],
      [u0 + 1, u2],
      [u1 + 1, 255],
      [0, u2],
      [u0 + 1, 255],
    ]) {
      if (lo > hi) continue
      const key = `${channelName}:${lo}-${hi}`
      if (bands.has(key)) continue
      bands.add(key)
      const low = new cv.Mat(channel.rows, channel.cols, channel.type(), new cv.Scalar(lo))
      const high = new cv.Mat(channel.rows, channel.cols, channel.type(), new cv.Scalar(hi))
      try {
        cv.inRange(channel, low, high, binary)
      } finally {
        low.delete()
        high.delete()
      }
      const result = analyze(binary)
      results.push(result)
      if (isDone && isDone(result)) return true
    }
    return false
  }

  try {
    const value = image.channels() === 1 ? image : valueChannel(cv, image)
    try {
      if (sweepChannel('value', value)) return results
    } finally {
      if (value !== image) value.delete()
    }
    if (image.channels() >= 3) {
      const saturation = saturationChannel(cv, image)
      try {
        sweepChannel('saturation', saturation)
      } finally {
        saturation.delete()
      }
    }
    return results
  } finally {
    binary.delete()
  }
}

// Picks the failed attempt to report when every threshold-band hypothesis fails: the attempt
// that progressed furthest through the caller's pipeline (the highest stage) carries the most
// actionable reason, because a band that found the object and failed late explains the scan
// better than one whose binary never resembled the object. First among ties wins, preserving
// band order for equally deep attempts. Returns null when there are no attempts.
export function deepestFailure<T>(attempts: T[], stageOf: (attempt: T) => number): T | null {
  let best: T | null = null
  for (const attempt of attempts) {
    if (best === null || stageOf(attempt) > stageOf(best)) best = attempt
  }
  return best
}

// Majority (median) filter over a binary image: speckle smaller than about half the kernel is
// voted away while larger structures keep their outline and, because the filter is symmetric,
// their centroids. Used to clean a threshold band of the texture speckle a build plate shows
// through a coupon's openings before hole extraction. `kernelPx` is rounded up to the next odd
// size, floored at 3. Returns a fresh Mat the caller deletes.
export function majorityFilterBinary(cv: OpenCv, binary: Mat, kernelPx: number): Mat {
  let k = Math.max(3, Math.round(kernelPx))
  if (k % 2 === 0) k++
  const filtered = new cv.Mat()
  cv.medianBlur(binary, filtered, k)
  return filtered
}

// Crops a copy of `image` to `rect` grown by `marginPx` on every side, clamped to the image
// bounds. Used to restrict local per-pixel stages (median filter, morphological close, contour
// extraction) to the region that can contain their features: for a kernel-sized margin the
// results inside the rectangle are identical to a full-image run, at a fraction of the cost.
// Returns a fresh Mat the caller deletes (Mat.roi hands out a view sharing the source's memory,
// so the view is cloned and released here) plus the clamped crop origin, which the caller adds
// back onto any coordinate measured inside the crop.
export function roiAround(
  cv: OpenCv,
  image: Mat,
  rect: { x: number; y: number; width: number; height: number },
  marginPx: number,
): { roi: Mat; x: number; y: number } {
  const m = Math.max(0, Math.ceil(marginPx))
  const x = Math.max(0, rect.x - m)
  const y = Math.max(0, rect.y - m)
  const width = Math.min(image.cols, rect.x + rect.width + m) - x
  const height = Math.min(image.rows, rect.y + rect.height + m) - y
  const view = image.roi(new cv.Rect(x, y, width, height))
  try {
    return { roi: view.clone(), x, y }
  } finally {
    view.delete()
  }
}

// The 256-bin intensity histogram of a single-channel 8-bit Mat.
function histogram256(gray: Mat): Float64Array {
  const hist = new Float64Array(256)
  const data = gray.data as Uint8Array
  for (let i = 0; i < data.length; i++) hist[data[i]]++
  return hist
}

// Otsu's method extended to three classes: the exhaustive search over threshold pairs (t1 < t2)
// maximizing the between-class variance of the three resulting populations. O(256^2) over the
// histogram, so cost is independent of image size.
function twoLevelOtsu(hist: Float64Array): [number, number] {
  // Prefix sums so any class's weight and mean are O(1).
  const w = new Float64Array(257)
  const s = new Float64Array(257)
  for (let i = 0; i < 256; i++) {
    w[i + 1] = w[i] + hist[i]
    s[i + 1] = s[i] + i * hist[i]
  }
  const total = w[256]
  const sumAll = s[256]
  if (total === 0) return [85, 170]
  const meanAll = sumAll / total

  let best = -1
  let bt1 = 85
  let bt2 = 170
  for (let t1 = 0; t1 < 255; t1++) {
    const w0 = w[t1 + 1]
    if (w0 === 0) continue
    const m0 = s[t1 + 1] / w0
    for (let t2 = t1 + 1; t2 < 256; t2++) {
      const w1 = w[t2 + 1] - w[t1 + 1]
      const w2 = total - w[t2 + 1]
      if (w1 === 0 || w2 === 0) continue
      const m1 = (s[t2 + 1] - s[t1 + 1]) / w1
      const m2 = (sumAll - s[t2 + 1]) / w2
      const between =
        w0 * (m0 - meanAll) * (m0 - meanAll) +
        w1 * (m1 - meanAll) * (m1 - meanAll) +
        w2 * (m2 - meanAll) * (m2 - meanAll)
      if (between > best) {
        best = between
        bt1 = t1
        bt2 = t2
      }
    }
  }
  return [bt1, bt2]
}

// Otsu's method extended to four classes: the exhaustive search over threshold triples
// (t0 < t1 < t2) maximizing the between-class variance of the four resulting populations.
// O(256^3) over the histogram, so cost is independent of image size.
function threeLevelOtsu(hist: Float64Array): [number, number, number] {
  // Prefix sums so any class's weight and mean are O(1).
  const w = new Float64Array(257)
  const s = new Float64Array(257)
  for (let i = 0; i < 256; i++) {
    w[i + 1] = w[i] + hist[i]
    s[i + 1] = s[i] + i * hist[i]
  }
  const total = w[256]
  const sumAll = s[256]
  if (total === 0) return [64, 128, 192]
  const meanAll = sumAll / total

  let best = -1
  let bt0 = 64
  let bt1 = 128
  let bt2 = 192
  for (let t0 = 0; t0 < 254; t0++) {
    const w0 = w[t0 + 1]
    if (w0 === 0) continue
    const m0 = s[t0 + 1] / w0
    const v0 = w0 * (m0 - meanAll) * (m0 - meanAll)
    for (let t1 = t0 + 1; t1 < 255; t1++) {
      const w1 = w[t1 + 1] - w[t0 + 1]
      if (w1 === 0) continue
      const m1 = (s[t1 + 1] - s[t0 + 1]) / w1
      const v1 = v0 + w1 * (m1 - meanAll) * (m1 - meanAll)
      for (let t2 = t1 + 1; t2 < 256; t2++) {
        const w2 = w[t2 + 1] - w[t1 + 1]
        const w3 = total - w[t2 + 1]
        if (w2 === 0 || w3 === 0) continue
        const m2 = (s[t2 + 1] - s[t1 + 1]) / w2
        const m3 = (sumAll - s[t2 + 1]) / w3
        const between =
          v1 + w2 * (m2 - meanAll) * (m2 - meanAll) + w3 * (m3 - meanAll) * (m3 - meanAll)
        if (between > best) {
          best = between
          bt0 = t0
          bt1 = t1
          bt2 = t2
        }
      }
    }
  }
  return [bt0, bt1, bt2]
}
