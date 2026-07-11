import type { ScannerCalibration } from './types'

// Derived quantities for a stored scanner calibration. CorrectionFactor is the scanner's isotropic
// scale error relative to its nominal DPI and is roughly constant across DPI settings, so
// pxPerMmAtDpi can apply the same calibration to a coupon scanned at any resolution.

/** Pixels-per-mm the DPI setting nominally implies (DPI / 25.4), before the scanner's error. */
export function nominalPxPerMm(c: ScannerCalibration): number {
  return c.dpi / 25.4
}

/** Measured px/mm / nominal px/mm: the scanner's isotropic scale error (~1.0). */
export function correctionFactor(c: ScannerCalibration): number {
  const nominal = nominalPxPerMm(c)
  return nominal > 0 ? c.pxPerMm / nominal : 1.0
}

/** The DPI the scanner effectively resolves at (px/mm * 25.4). */
export function effectiveDpi(c: ScannerCalibration): number {
  return c.pxPerMm * 25.4
}

/** The scale error as a percentage of nominal (negative = the scanner reads small). */
export function percentVsNominal(c: ScannerCalibration): number {
  return (correctionFactor(c) - 1.0) * 100.0
}

/** The true px/mm for a scan taken at the given DPI, applying the stored error. */
export function pxPerMmAtDpi(c: ScannerCalibration, dpi: number): number {
  return (dpi / 25.4) * correctionFactor(c)
}

/**
 * Per-axis px/mm of a scan image. Horizontal is the image x axis (the sensor line of the scan
 * head), vertical the image y axis (the carriage travel).
 */
export interface AxisPxPerMm {
  horizontal: number
  vertical: number
}

/** A scale reference: one isotropic px/mm (CIS or plain DPI), or a per-axis pair (CCD). */
export type ScaleReference = number | AxisPxPerMm

/**
 * The scale reference for a scan taken at the given DPI. A CIS calibration applies the stored
 * error to both axes. A CCD calibration applies it only to the image axis the card was measured
 * along, since the card's long side can only sense that one axis; the other axis stays at the
 * nominal resolution. Calibrations stored before the axis was recorded lack the field and are
 * treated as horizontal.
 */
export function scaleReferenceAtDpi(c: ScannerCalibration, dpi: number): ScaleReference {
  if (c.scannerType !== 'CCD') return pxPerMmAtDpi(c, dpi)
  const corrected = pxPerMmAtDpi(c, dpi)
  const nominal = dpi / 25.4
  return c.measuredAxis === 'vertical'
    ? { horizontal: nominal, vertical: corrected }
    : { horizontal: corrected, vertical: nominal }
}

/** True for a positive, finite reference (both axes for a pair). */
export function isUsableReference(ref: ScaleReference): boolean {
  const ok = (v: number) => v > 0 && Number.isFinite(v)
  return typeof ref === 'number' ? ok(ref) : ok(ref.horizontal) && ok(ref.vertical)
}

/**
 * The effective px/mm along an image-space direction (ux, uy). The scanner maps true millimetres
 * to image pixels through the diagonal scale S = diag(horizontal, vertical), so an image length L
 * along the unit direction u corresponds to |S^-1 (L u)| true millimetres; the px/mm along u is
 * therefore |u| / |S^-1 u|. Exact for a diagonal scale, and equal to the scalar for an isotropic
 * reference.
 */
export function referenceAlongDirection(ref: ScaleReference, ux: number, uy: number): number {
  if (typeof ref === 'number') return ref
  const n = Math.hypot(ux, uy)
  if (!(n > 0)) throw new Error('The direction of a scale reference must be a non-zero vector.')
  return n / Math.hypot(ux / ref.horizontal, uy / ref.vertical)
}

/**
 * The reference's isotropic equivalent (the geometric mean of the axes for a pair), for
 * order-of-magnitude checks such as the resolution-swap diagnosis.
 */
export function isotropicPxPerMm(ref: ScaleReference): number {
  return typeof ref === 'number' ? ref : Math.sqrt(ref.horizontal * ref.vertical)
}

/** A non-positive DPI or px/mm is degenerate and is treated as uncalibrated. */
export function isUsableCalibration(c: ScannerCalibration): boolean {
  return c.dpi > 0 && c.pxPerMm > 0
}
