import { median } from './math'

// Shared scan-resolution gates for the calibration flows. The fiducial aligners use the
// degenerate floor to reject blobs that cannot be a coupon at any usable resolution; the
// analyzers use the measurement floor to refuse scans whose pixels are too coarse for the
// sub-pixel width and gap readouts, before any numbers are produced from them.

/**
 * Degenerate-alignment floor for the aligners' blob-area gates. Below 1 px/mm (about 26 dpi)
 * a printed test bead spans under half a pixel, so nothing downstream could trace a line even
 * if the plate were located; a blob smaller than the coupon at this scale cannot be a usable
 * coupon scan. Every real flatbed setting (75 dpi and up) clears it by a wide margin, so it
 * rejects only non-coupon blobs, never a plausible scan.
 */
export const MIN_ALIGN_PX_PER_MM = 1

/**
 * Minimum scan resolution for the measurements themselves. The sub-pixel width and gap readouts
 * locate each edge by a gradient centroid pooled over a few hundred samples per feature, which in
 * testing recovers the calibration signal down to about 150 dpi on the pressure advance coupon.
 * The floor sits at 5.5 px/mm, just under 150 dpi (5.9 px/mm), so a real 150 dpi scan still clears
 * it after print shrinkage and anything coarser is refused. Higher resolution yields a deeper, more
 * confident score minimum, and the finer-featured flows (input shaper ringing near 0.1 mm) gain the
 * most from scanning well above this floor.
 */
export const MIN_MEASUREMENT_PX_PER_MM = 5.5

/**
 * User-worded refusal for a scan below the measurement resolution floor, or null when the
 * resolution suffices. A non-positive px/mm is a degenerate alignment, which the aligner
 * reports as its own failure, so it also returns null here.
 */
export function insufficientResolutionReason(pxPerMm: number): string | null {
  if (!(pxPerMm > 0)) return null
  if (pxPerMm >= MIN_MEASUREMENT_PX_PER_MM) return null
  return (
    `The scan resolution is about ${Math.round(pxPerMm * 25.4)} dpi, below the 150 dpi this ` +
    'measurement needs to resolve the measured features. Rescan at 150 dpi or higher.'
  )
}

/**
 * Relative px/mm tolerance for "these scans were taken at the same scanner resolution setting".
 * This is a setting-mismatch detector, not a measurement: flatbed resolution settings are
 * discrete (75/150/300/600 dpi, factors of two apart), while a real scanner's scale error is
 * around one percent, so a 20 percent band cleanly separates same-setting jitter from a
 * different-setting scan without ever judging the measurement itself.
 */
export const RESOLUTION_SETTING_TOLERANCE = 0.2

/** The resolution verdict of one scan within an analyzed set. */
export interface ScanResolutionVerdict {
  ok: boolean
  /** The geometrically measured resolution, rounded to whole dpi, for display. */
  approxDpi: number
  /** User-worded refusal when not ok; null when the scan passes. */
  reason: string | null
}

const approxDpiOf = (pxPerMm: number): number => Math.round(pxPerMm * 25.4)

const sameSetting = (pxPerMmA: number, pxPerMmB: number): boolean =>
  Math.abs(pxPerMmA / pxPerMmB - 1) <= RESOLUTION_SETTING_TOLERANCE

/**
 * Judges the geometrically measured resolution of every scan in one analysis. Per scan, in
 * order: the measurement floor (see MIN_MEASUREMENT_PX_PER_MM); against the expected resolution
 * when one is known (a scanner calibration or an entered DPI); otherwise against the rest of the
 * set, where the largest same-setting cluster is the baseline and scans outside it are refused
 * (a tie between clusters refuses every scan, since no baseline exists). Driven only by measured
 * px/mm figures, never by file metadata.
 */
export function evaluateScanSetResolution(
  scans: { pxPerMm: number }[],
  expected?: { pxPerMm: number; dpi: number } | null,
): ScanResolutionVerdict[] {
  const verdicts: ScanResolutionVerdict[] = scans.map((s) => {
    const reason = insufficientResolutionReason(s.pxPerMm)
    return { ok: reason === null, approxDpi: approxDpiOf(s.pxPerMm), reason }
  })

  if (expected && expected.pxPerMm > 0) {
    scans.forEach((s, i) => {
      if (!verdicts[i].ok || sameSetting(s.pxPerMm, expected.pxPerMm)) return
      verdicts[i].ok = false
      verdicts[i].reason =
        `This scan measures about ${verdicts[i].approxDpi} dpi, but the expected resolution is ` +
        `${Math.round(expected.dpi)} dpi. Rescan at the expected resolution, or recalibrate ` +
        'the scanner at this one.'
    })
    return verdicts
  }

  // No expectation: the scans must agree among themselves. Cluster the floor-passing scans by
  // the same setting tolerance (sorted, so each cluster is anchored at its smallest member).
  const candidates = scans
    .map((s, index) => ({ index, pxPerMm: s.pxPerMm }))
    .filter((c) => verdicts[c.index].ok)
    .sort((a, b) => a.pxPerMm - b.pxPerMm)
  const clusters: { index: number; pxPerMm: number }[][] = []
  for (const c of candidates) {
    const current = clusters[clusters.length - 1]
    if (current && sameSetting(c.pxPerMm, current[0].pxPerMm)) current.push(c)
    else clusters.push([c])
  }
  if (clusters.length < 2) return verdicts

  const largest = Math.max(...clusters.map((c) => c.length))
  const majority = clusters.filter((c) => c.length === largest)
  if (majority.length === 1) {
    const baselineDpi = approxDpiOf(median(majority[0].map((c) => c.pxPerMm)))
    for (const cluster of clusters) {
      if (cluster === majority[0]) continue
      for (const c of cluster) {
        verdicts[c.index].ok = false
        verdicts[c.index].reason =
          `This scan measures about ${verdicts[c.index].approxDpi} dpi while the other scans ` +
          `measure about ${baselineDpi} dpi. All scans in one analysis must use the same resolution.`
      }
    }
    return verdicts
  }

  // A tie between the largest clusters: no majority to trust, so every scan is refused.
  const list = clusters.map((c) => approxDpiOf(median(c.map((m) => m.pxPerMm))))
  const listText =
    list.length === 2 ? `${list[0]} and ${list[1]}` : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
  const reason =
    `The scans measure different resolutions (about ${listText} dpi). All scans in one ` +
    'analysis must use the same resolution.'
  for (const cluster of clusters) {
    for (const c of cluster) {
      verdicts[c.index].ok = false
      verdicts[c.index].reason = reason
    }
  }
  return verdicts
}
