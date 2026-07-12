// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  MIN_ALIGN_PX_PER_MM,
  MIN_MEASUREMENT_PX_PER_MM,
  evaluateScanSetResolution,
  insufficientResolutionReason,
} from '../../src/engine/resolutionGate'

const DPI_150 = 150 / 25.4
const DPI_300 = 300 / 25.4

describe('resolutionGate', () => {
  it('keeps the degenerate-alignment floor below the measurement floor', () => {
    expect(MIN_ALIGN_PX_PER_MM).toBe(1)
    expect(MIN_MEASUREMENT_PX_PER_MM).toBe(5.5)
    expect(MIN_ALIGN_PX_PER_MM).toBeLessThan(MIN_MEASUREMENT_PX_PER_MM)
  })

  it('accepts a 150 dpi scan', () => {
    expect(insufficientResolutionReason(150 / 25.4)).toBeNull()
  })

  it('accepts a 600 dpi scan', () => {
    expect(insufficientResolutionReason(600 / 25.4)).toBeNull()
  })

  it('accepts exactly the measurement floor', () => {
    expect(insufficientResolutionReason(MIN_MEASUREMENT_PX_PER_MM)).toBeNull()
  })

  it('refuses a 100 dpi scan with the measured resolution in the reason', () => {
    const reason = insufficientResolutionReason(100 / 25.4)
    expect(reason).toContain('100 dpi')
    expect(reason).toContain('150 dpi')
  })

  it('returns null for a degenerate scale, which is the aligner failure instead', () => {
    expect(insufficientResolutionReason(0)).toBeNull()
    expect(insufficientResolutionReason(-3)).toBeNull()
    expect(insufficientResolutionReason(NaN)).toBeNull()
  })
})

describe('evaluateScanSetResolution', () => {
  it('passes exactly the measurement floor and refuses just below it', () => {
    const [atFloor] = evaluateScanSetResolution([{ pxPerMm: MIN_MEASUREMENT_PX_PER_MM }])
    expect(atFloor.ok).toBe(true)
    expect(atFloor.reason).toBeNull()
    const [below] = evaluateScanSetResolution([{ pxPerMm: MIN_MEASUREMENT_PX_PER_MM - 0.01 }])
    expect(below.ok).toBe(false)
    expect(below.reason).toContain('150 dpi')
  })

  it('accepts a single scan with no expectation', () => {
    const [v] = evaluateScanSetResolution([{ pxPerMm: DPI_300 }])
    expect(v.ok).toBe(true)
  })

  it('accepts same-setting jitter within one percent', () => {
    const verdicts = evaluateScanSetResolution([
      { pxPerMm: DPI_150 },
      { pxPerMm: DPI_150 * 1.01 },
      { pxPerMm: DPI_150 * 0.99 },
    ])
    expect(verdicts.every((v) => v.ok)).toBe(true)
  })

  it('flags both scans of a 150/300 pair (a tie, no majority)', () => {
    const verdicts = evaluateScanSetResolution([{ pxPerMm: DPI_150 }, { pxPerMm: DPI_300 }])
    expect(verdicts.every((v) => !v.ok)).toBe(true)
    for (const v of verdicts) {
      expect(v.reason).toContain('different resolutions')
      expect(v.reason).toContain('150')
      expect(v.reason).toContain('300')
    }
  })

  it('flags only the outlier of a 150/150/300 set', () => {
    const verdicts = evaluateScanSetResolution([
      { pxPerMm: DPI_150 },
      { pxPerMm: DPI_150 * 1.005 },
      { pxPerMm: DPI_300 },
    ])
    expect(verdicts[0].ok).toBe(true)
    expect(verdicts[1].ok).toBe(true)
    expect(verdicts[2].ok).toBe(false)
    expect(verdicts[2].reason).toContain('about 300 dpi')
    expect(verdicts[2].reason).toContain('about 150 dpi')
  })

  it('passes scans matching the expected resolution within the setting tolerance', () => {
    const verdicts = evaluateScanSetResolution(
      [{ pxPerMm: DPI_300 * 0.99 }, { pxPerMm: DPI_300 * 1.01 }],
      { pxPerMm: DPI_300, dpi: 300 },
    )
    expect(verdicts.every((v) => v.ok)).toBe(true)
  })

  it('refuses a scan that mismatches the expected resolution, naming both figures', () => {
    const [v] = evaluateScanSetResolution([{ pxPerMm: DPI_150 }], { pxPerMm: DPI_300, dpi: 300 })
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('about 150 dpi')
    expect(v.reason).toContain('expected resolution is 300 dpi')
  })

  it('skips the set comparison when an expectation is given', () => {
    // With an expectation, each scan is judged against it alone: the matching scan passes even
    // though the other scan disagrees with it.
    const verdicts = evaluateScanSetResolution(
      [{ pxPerMm: DPI_300 }, { pxPerMm: DPI_150 }],
      { pxPerMm: DPI_300, dpi: 300 },
    )
    expect(verdicts[0].ok).toBe(true)
    expect(verdicts[1].ok).toBe(false)
  })

  it('skips the expectation check when none is given', () => {
    const verdicts = evaluateScanSetResolution([{ pxPerMm: DPI_150 }], null)
    expect(verdicts[0].ok).toBe(true)
  })

  it('rounds approxDpi to whole dpi', () => {
    const [v] = evaluateScanSetResolution([{ pxPerMm: 11.811 }])
    expect(v.approxDpi).toBe(300)
    const [w] = evaluateScanSetResolution([{ pxPerMm: 23.584 }])
    expect(w.approxDpi).toBe(599)
  })
})
