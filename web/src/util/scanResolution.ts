import { evaluateScanSetResolution } from '../engine/resolutionGate'
import type { ScanResolutionVerdict } from '../engine/resolutionGate'
import {
  isUsableCalibration,
  isotropicPxPerMm,
  scaleReferenceAtDpi,
} from '../engine/scannerCalibration'
import type { ScannerCalibration } from '../engine/types'

// Shared presentation of the engine's per-scan resolution verdicts, so every flow's scan card
// renders the same badge, explanation, and raw diagnostic row instead of re-deriving them.

export type { ScanResolutionVerdict }
export { evaluateScanSetResolution }

/**
 * The expected resolution derived from a stored scanner calibration, priced at the calibration's
 * own DPI (the resolution every flow tells the user to scan at). Null when there is no usable
 * calibration.
 */
export function expectedFromCalibration(
  calibration: ScannerCalibration | null,
): { pxPerMm: number; dpi: number } | null {
  if (!calibration || !isUsableCalibration(calibration)) return null
  return {
    pxPerMm: isotropicPxPerMm(scaleReferenceAtDpi(calibration, calibration.dpi)),
    dpi: calibration.dpi,
  }
}

/** The expected resolution from a user-entered DPI figure; null when none was entered. */
export function expectedFromDpi(dpi: number | null): { pxPerMm: number; dpi: number } | null {
  return dpi != null && dpi > 0 ? { pxPerMm: dpi / 25.4, dpi } : null
}

/** Badge shown on the card of a scan whose resolution verdict failed; null when it passed. */
export function resolutionBadge(
  verdict: ScanResolutionVerdict | undefined | null,
): { text: string; explanation: string } | null {
  if (!verdict || verdict.ok) return null
  return { text: 'Wrong resolution', explanation: verdict.reason ?? '' }
}

/** Whether a per-scan measured resolution figure is usable for display. */
export function hasMeasuredResolution(
  measuredPxPerMm: number | null | undefined,
): measuredPxPerMm is number {
  return measuredPxPerMm != null && measuredPxPerMm > 0
}

/** The raw per-scan diagnostic value for a "Resolution" row, from a measured px/mm figure. */
export function resolutionRowValue(measuredPxPerMm: number | null | undefined): string {
  if (!hasMeasuredResolution(measuredPxPerMm)) return 'Not resolved'
  return `about ${Math.round(measuredPxPerMm * 25.4)} dpi`
}
