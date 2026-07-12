import { median } from './math'

// Shared validity gate for the surface a flow measures against (the "backdrop"): the printed
// base behind the PA test lines, the floor showing through the EM comb gaps, the open window
// behind the IS test lines. Sub-pixel edge and width readouts assume the backdrop presents a
// single tone that contrasts with the plastic; a backdrop that is too similar in brightness or
// too uneven (a dark textured build plate showing through the openings) shifts every mid-level
// edge crossing and biases the measurement, so such a scan is refused rather than mis-measured.
// Each flow samples its own feature and backdrop tones through its solved alignment and words
// its own user-facing refusal; this module owns only the judgment.

/**
 * Minimum brightness separation, in gray levels, between the measured features and the backdrop
 * for edge localization to work in either polarity.
 */
export const MIN_BACKDROP_CONTRAST = 30

/**
 * Maximum backdrop tone spread relative to the feature/backdrop contrast. The mid-level edge
 * threshold sits halfway between the two tones, so a backdrop whose spread is a substantial
 * fraction of the contrast moves the threshold and the located edges by a comparable fraction
 * of the edge spread; a quarter keeps that displacement a minor effect. Real scans separate by
 * an order of magnitude on each side of this bound (about 0.02 to 0.1 against a lid or paper
 * backing, about 0.6 through a textured build plate).
 */
export const MAX_BACKDROP_SPREAD_RATIO = 0.25

export interface BackdropAssessment {
  /** Polarity-free contrast: median absolute deviation of feature tones from the backdrop median. */
  contrast: number
  /** Backdrop tone spread (MAD) relative to the contrast; meaningful only when contrast is nonzero. */
  spreadRatio: number
  failure: 'low-contrast' | 'uneven' | null
}

/**
 * Judges whether the backdrop can support sub-pixel measurement of the features in front of it.
 * `featureTones` are gray levels sampled on the measured plastic, `backdropTones` on the backdrop
 * directly behind or beside it; both through the solved alignment, so a few mis-landed samples
 * are tolerated by the medians.
 */
export function assessMeasurementBackdrop(
  featureTones: number[],
  backdropTones: number[],
): BackdropAssessment {
  if (featureTones.length === 0 || backdropTones.length === 0) {
    return { contrast: 0, spreadRatio: 0, failure: 'low-contrast' }
  }
  const backdropMedian = median(backdropTones)
  const contrast = median(featureTones.map((v) => Math.abs(v - backdropMedian)))
  if (contrast < MIN_BACKDROP_CONTRAST) {
    return { contrast, spreadRatio: 0, failure: 'low-contrast' }
  }
  const spread = median(backdropTones.map((v) => Math.abs(v - backdropMedian)))
  const spreadRatio = spread / contrast
  if (spreadRatio > MAX_BACKDROP_SPREAD_RATIO) {
    return { contrast, spreadRatio, failure: 'uneven' }
  }
  return { contrast, spreadRatio, failure: null }
}
