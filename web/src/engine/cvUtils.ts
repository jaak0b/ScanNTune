import type { Mat, OpenCv } from './opencv'

/** Which side of the threshold the object of interest is assumed to be on. */
export type Polarity = 'bright' | 'dark'

// Otsu-thresholds the image's value channel and runs `analyze` on both polarities of the binary
// (object above the threshold, then below). Which polarity is right is NOT guessed from image
// statistics (a border mean flips when the backing sheet stops short of the scan bed and bright
// scanner-lid margins reach the border); the caller validates each result against the geometry it
// knows (coupon grid, card shape) and keeps the one that fits: model selection, no tuned guess.
// `analyze` gets the object rendered white and must not mutate the binary (it is reused inverted).
export function analyzeBothPolarities<T>(
  cv: OpenCv,
  image: Mat,
  analyze: (objectWhite: Mat, polarity: Polarity) => T,
): { bright: T; dark: T } {
  if (!image || image.empty()) throw new Error('Image is null or empty.')
  const value = image.channels() === 1 ? image : valueChannel(cv, image)
  const binary = new cv.Mat()
  try {
    cv.threshold(value, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU)
    const bright = analyze(binary, 'bright')
    cv.bitwise_not(binary, binary)
    const dark = analyze(binary, 'dark')
    return { bright, dark }
  } finally {
    if (value !== image) value.delete()
    binary.delete()
  }
}

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

// Runs `analyze` on every threshold-band hypothesis of the image's value channel: the two
// polarities of the single Otsu threshold, every band and band-union of the two-level Otsu
// split (Otsu's method extended to three classes), and every band and contiguous band-union of
// the three-level Otsu split (four classes). A scene with three intensity populations (a
// backing sheet, the object, a bright scanner-lid margin) has no single threshold that isolates the
// object; one of the three-class bands does. A part scanned on its textured build plate adds a
// fourth population (the plate's dark speckle between the plate bulk and the plastic), which only
// a four-class band separates. As with analyzeBothPolarities, the caller validates
// each hypothesis against known geometry and keeps what fits. Duplicate bands are analysed once.
// `analyze` must not retain or mutate the binary it is given. When `isDone` is provided, band
// evaluation stops as soon as it returns true for a result, and the results collected so far are
// returned; without it every band is analysed.
export function analyzeThresholdBands<T>(
  cv: OpenCv,
  image: Mat,
  analyze: (objectWhite: Mat) => T,
  isDone?: (result: T) => boolean,
): T[] {
  if (!image || image.empty()) throw new Error('Image is null or empty.')
  const value = image.channels() === 1 ? image : valueChannel(cv, image)
  const binary = new cv.Mat()
  try {
    const t = cv.threshold(value, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU)
    const hist = histogram256(value)
    const [t1, t2] = twoLevelOtsu(hist)
    const [u0, u1, u2] = threeLevelOtsu(hist)
    const bands = new Set<string>()
    const results: T[] = []
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
      const key = `${lo}-${hi}`
      if (bands.has(key)) continue
      bands.add(key)
      const low = new cv.Mat(value.rows, value.cols, value.type(), new cv.Scalar(lo))
      const high = new cv.Mat(value.rows, value.cols, value.type(), new cv.Scalar(hi))
      try {
        cv.inRange(value, low, high, binary)
      } finally {
        low.delete()
        high.delete()
      }
      const result = analyze(binary)
      results.push(result)
      if (isDone && isDone(result)) return results
    }
    return results
  } finally {
    if (value !== image) value.delete()
    binary.delete()
  }
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
