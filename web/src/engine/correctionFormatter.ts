import type { AxisScale, Correction, CouponSpec, PlaneSkew } from './types'

// Same maths as the Vector 3D "Califlower" calculator, exposed per-flavour: shrinkage =
// (1 + error)*100, part scale = 100/(1 + error), rotation distance by (1 + error), Klipper
// SET_SKEW from the baseline triangle.

export const SHRINKAGE = 'Shrinkage %'
export const ROTATION_DISTANCE = 'Rotation distance'
export const SCALE = 'Scale %'

export const sizeFlavours: readonly string[] = [SHRINKAGE, ROTATION_DISTANCE, SCALE]

export function currentValueLabel(sizeFlavour: string): string | null {
  switch (sizeFlavour) {
    case ROTATION_DISTANCE:
      return 'current rot. dist.'
    default:
      return null
  }
}

export function skewCorrection(skewDegrees: number, coupon: CouponSpec): Correction {
  // skewDegrees is the measured corner-angle error (angle - 90). The shear Klipper models,
  // x' = x + tan*y, CLOSES the corner, so its coefficient is the negation of the angle error.
  const tan = Math.tan((-skewDegrees * Math.PI) / 180.0)
  if (!Number.isFinite(tan) || Math.abs(skewDegrees) >= 45.0)
    return {
      code: 'skew out of range, check the scan',
      hint: 'A real plate skews well under 1 degree; this suggests a detection problem.',
    }

  // The reference square's side is the baseline over sqrt(2), not the baseline itself, so the
  // emitted diagonals read near the baseline instead of near baseline*sqrt(2): purely a
  // presentation choice for visual parity with the Califlower calculator's output. Klipper
  // recovers the same skew factor from any consistent square side, so the correction is identical.
  const l = coupon.baselineMm / Math.SQRT2
  const ac = l * Math.sqrt((1.0 + tan) * (1.0 + tan) + 1.0)
  const bd = l * Math.sqrt((tan - 1.0) * (tan - 1.0) + 1.0)
  const ad = l * Math.sqrt(tan * tan + 1.0)
  return {
    code: `SET_SKEW XY=${upTo3(ac)},${upTo3(bd)},${upTo3(ad)}\nSKEW_PROFILE SAVE=ScanNTune\nSAVE_CONFIG`,
    hint: "The three values are the two diagonals and one side of a reference square that encodes the measured skew, in Klipper's AC, BD, AD order. They give the same result as measuring a printed test square by hand.",
    primaryCaption: 'Paste into the Klipper console:',
    secondaryCaption: 'Add this to your start g-code:',
    secondaryCode: 'SKEW_PROFILE LOAD=ScanNTune',
  }
}

/**
 * The command that clears any skew correction already active on the printer. A coupon printed with a
 * correction still on has that correction baked into its geometry, so the measured skew would reflect
 * the old correction instead of the printer's real skew: this must run (and the plate be printed fresh)
 * before the coupon in the calibration flow.
 */
export const RESET_SKEW_COMMAND: Correction = {
  code: 'SET_SKEW CLEAR=1',
  hint: 'Send SET_SKEW CLEAR=1 in the console before printing. Check your printer start G-code and remove any SKEW_PROFILE LOAD line; otherwise the profile is reapplied on every print. Restart Klipper after editing the config or start G-code.',
}

// Per-plane skew, converted to Klipper's shear factor (x' = x + tan*y closes the corner, so the
// coefficient is the negation of the corner-angle error).
function planeTan(skewDegrees: number): number {
  return Math.tan((-skewDegrees * Math.PI) / 180.0)
}

/**
 * Skew correction across every measured plane (any subset of XY/XZ/YZ). A plane whose skew is out
 * of range is dropped from the command and noted in the hint rather than poisoning the whole
 * snippet.
 */
export function skewCorrectionMulti(skews: readonly PlaneSkew[], coupon: CouponSpec): Correction {
  const usable = skews.filter((s) => Number.isFinite(s.skewDegrees) && Math.abs(s.skewDegrees) < 45.0)
  const dropped = skews.filter((s) => !usable.includes(s))
  const outOfRange = dropped.map((s) => s.plane)
  const rangeHint =
    outOfRange.length > 0
      ? `${outOfRange.join(', ')} skew is out of range and was left out; check that scan. `
      : ''

  if (usable.length === 0)
    return {
      code: 'skew out of range, check the scans',
      hint: 'A real plate skews well under 1 degree; this suggests a detection problem.',
    }

  // One SET_SKEW carrying every measured plane's baseline triangle, keyed by the plane name.
  // Side = baseline / sqrt(2) for visual parity with the Califlower calculator (see
  // skewCorrection above); the recovered skew factor is unchanged.
  const l = coupon.baselineMm / Math.SQRT2
  const parts = usable.map((s) => {
    const tan = planeTan(s.skewDegrees)
    const ac = l * Math.sqrt((1.0 + tan) * (1.0 + tan) + 1.0)
    const bd = l * Math.sqrt((tan - 1.0) * (tan - 1.0) + 1.0)
    const ad = l * Math.sqrt(tan * tan + 1.0)
    return `${s.plane}=${upTo3(ac)},${upTo3(bd)},${upTo3(ad)}`
  })
  return {
    code: `SET_SKEW ${parts.join(' ')}\nSKEW_PROFILE SAVE=ScanNTune\nSAVE_CONFIG`,
    hint: rangeHint.trim(),
    primaryCaption: 'Paste into the Klipper console:',
    secondaryCaption: 'Add this to your start g-code:',
    secondaryCode: 'SKEW_PROFILE LOAD=ScanNTune',
  }
}

/**
 * Size correction across the reconciled physical axes (X/Y, plus Z when a standing plate measured
 * it). Z is reported but flagged: a printer's Z error is layer-height driven, not extrusion
 * shrinkage, so it should not be lumped into the XY shrinkage figure.
 */
export function axisSizeCorrection(
  flavour: string,
  scales: readonly AxisScale[],
  currents: Partial<Record<'X' | 'Y' | 'Z' | 'XY', number | null>>,
): Correction {
  const bad = scales.some((s) => !Number.isFinite(s.scalePercent) || Math.abs(s.scalePercent) >= 10.0)
  if (bad)
    return {
      code: 'scale out of range, check the scan and DPI',
      hint: "A real printer errs well under 2%; this suggests the scan DPI doesn't match the calibration, or a detection problem.",
    }

  const hasZ = scales.some((s) => s.axis === 'Z')
  const zNote = hasZ
    ? ' Z is layer-height driven, not extrusion shrinkage: apply it on its own, not as part of XY shrinkage.'
    : ''
  const frac = (s: AxisScale): number => s.scalePercent / 100.0

  switch (flavour) {
    case ROTATION_DISTANCE: {
      const parts = scales
        .filter((s) => currents[s.axis] != null)
        .map((s) => `${s.axis} ${f4((1.0 + frac(s)) * currents[s.axis]!)}`)
      if (parts.length === 0)
        return {
          code: 'enter current rotation distance above',
          hint: 'New = current * (1 + error), per axis.',
        }
      return { code: parts.join('   '), hint: `Set rotation_distance in printer.cfg (Klipper).${zNote}` }
    }

    case SCALE: {
      const parts = scales.map((s) => `${s.axis} ${f2(100.0 / (1.0 + frac(s)))} %`)
      return { code: parts.join('   '), hint: `Scale the model per-axis in your slicer.${zNote}` }
    }

    default: {
      // Shrinkage: a single XY figure (slicers apply one value), from the X and Y axes only,
      // plus a separate Z figure when a standing plate measured it. The current value active in
      // the slicer when the coupon printed is already baked into the printed geometry, so the
      // correction compounds onto it (K' = K_cur * (1 + frac)) rather than starting from 100.
      const xy = scales.filter((s) => s.axis === 'X' || s.axis === 'Y')
      if (xy.length === 0)
        return { code: 'no XY scale measured', hint: 'Scan the XY (or XZ and YZ) plate for shrinkage.' }
      const avg = xy.reduce((sum, s) => sum + frac(s), 0) / xy.length
      // Empty/null means no compensation is active (100). A present value must fall inside a sane
      // band for a shrinkage compensation percentage; anything else (a factor like 0.98, a typo like
      // 9800) is refused rather than silently substituted, mirroring the measured-scale guard above.
      const k = (v: number | null | undefined): number => (v == null ? 100 : Number.isFinite(v) ? v! : NaN)
      const inBand = (v: number): boolean => Number.isFinite(v) && v >= 80.0 && v <= 125.0
      const kXY = k(currents.XY)
      const kZ = k(currents.Z)
      const z = scales.find((s) => s.axis === 'Z')
      if (!inBand(kXY) || (z != null && !inBand(kZ)))
        return {
          code: 'check the entered compensation',
          hint: "The current shrinkage compensation field takes the slicer's shrinkage compensation in percent, normally close to 100.",
        }
      const parts = [`XY ${f2(kXY * (1.0 + avg))} %`]
      if (z) parts.push(`Z ${f2(kZ * (1.0 + frac(z)))} %`)
      const compounded = kXY !== 100 || (z != null && kZ !== 100)
      const hint = compounded
        ? 'OrcaSlicer / SuperSlicer: Filament -> Advanced -> Shrinkage compensation. The value shown already includes the compensation that was active when the plate printed, so replace the old figure rather than adding to it.'
        : 'OrcaSlicer / SuperSlicer: Filament -> Advanced -> Shrinkage compensation.'
      return { code: parts.join('   '), hint }
    }
  }
}

// Number formatting matching the C# invariant-culture format strings.
function f2(n: number): string {
  return n.toFixed(2)
}
function f4(n: number): string {
  return n.toFixed(4)
}
// C# "0.###": up to 3 decimals, trailing zeros trimmed.
function upTo3(n: number): string {
  return parseFloat(n.toFixed(3)).toString()
}
