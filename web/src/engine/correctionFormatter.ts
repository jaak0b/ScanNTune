import type { AxisScale, Correction, CouponSpec, Plane, PlaneSkew } from './types'

// Same maths as the Vector 3D "Califlower" calculator, exposed per-flavour: shrinkage =
// (1 + error)*100, part scale = 100/(1 + error), steps/mm scale by 1/(1 + error), rotation distance
// by (1 + error), Marlin XY_SKEW_FACTOR = tan(shear), Klipper SET_SKEW from the baseline triangle.

export const KLIPPER = 'Klipper'
export const MARLIN = 'Marlin'
export const REPRAP = 'RepRapFirmware'

export const SHRINKAGE = 'Shrinkage %'
export const STEPS_PER_MM = 'Steps/mm'
export const ROTATION_DISTANCE = 'Rotation distance'
export const SCALE = 'Scale %'

export const skewFlavours: readonly string[] = [KLIPPER, MARLIN, REPRAP]
export const sizeFlavours: readonly string[] = [SHRINKAGE, STEPS_PER_MM, ROTATION_DISTANCE, SCALE]

export function currentValueLabel(sizeFlavour: string): string | null {
  switch (sizeFlavour) {
    case STEPS_PER_MM:
      return 'current steps/mm'
    case ROTATION_DISTANCE:
      return 'current rot. dist.'
    default:
      return null
  }
}

export function skewCorrection(flavour: string, skewDegrees: number, coupon: CouponSpec): Correction {
  // skewDegrees is the measured corner-angle error (angle - 90). The shear the firmwares model,
  // x' = x + tan*y, CLOSES the corner, so its coefficient is the negation of the angle error.
  const tan = Math.tan((-skewDegrees * Math.PI) / 180.0)
  if (!Number.isFinite(tan) || Math.abs(skewDegrees) >= 45.0)
    return {
      code: 'skew out of range, check the scan',
      hint: 'A real coupon skews well under 1 degree; this suggests a detection problem.',
    }

  switch (flavour) {
    case MARLIN:
      return {
        code: `M852 I${f6(tan)}\nM500`,
        hint: `Send via console; M500 saves it. Or set #define XY_SKEW_FACTOR ${f6(tan)} in Configuration.h.`,
      }

    case REPRAP:
      // RRF's user-to-machine transform ADDS tanXY*Y (Move.cpp AxisTransform), opposite of Marlin's
      // planner which subtracts, so RRF needs the negated factor.
      return {
        code: `M556 S100 X${f3(-100.0 * tan)}`,
        hint: 'Add to config.g.',
      }

    default: {
      // Klipper
      const l = coupon.baselineMm
      const ac = l * Math.sqrt((1.0 + tan) * (1.0 + tan) + 1.0)
      const bd = l * Math.sqrt((tan - 1.0) * (tan - 1.0) + 1.0)
      const ad = l * Math.sqrt(tan * tan + 1.0)
      return {
        code: `SET_SKEW XY=${upTo3(ac)},${upTo3(bd)},${upTo3(ad)}\nSKEW_PROFILE SAVE=ScanNTune\nSAVE_CONFIG`,
        hint: '',
        primaryCaption: 'Paste into the Klipper console:',
        secondaryCaption: 'Add this to your start g-code:',
        secondaryCode: 'SKEW_PROFILE LOAD=ScanNTune',
      }
    }
  }
}

/**
 * The command that clears any skew correction already active on the printer. A coupon printed with a
 * correction still on has that correction baked into its geometry, so the measured skew would reflect
 * the old correction instead of the printer's real skew: this must run (and the plate be printed fresh)
 * before the coupon in the calibration flow.
 */
export function resetSkewCommand(flavour: string): Correction {
  switch (flavour) {
    case MARLIN:
      return { code: `M852 I0 J0 K0\nM500`, hint: 'Send via console; M500 saves it.' }
    case REPRAP:
      return { code: `M556 S100 X0 Y0 Z0`, hint: 'Send via console, or add to config.g.' }
    default:
      return { code: 'SET_SKEW CLEAR=1', hint: '' }
  }
}

// Per-plane skew, converted to the firmware shear factor (x' = x + tan*y closes the corner, so the
// coefficient is the negation of the corner-angle error).
function planeTan(skewDegrees: number): number {
  return Math.tan((-skewDegrees * Math.PI) / 180.0)
}

// The firmware tokens for each plane: Klipper SET_SKEW key, Marlin M852 letter, RRF M556 letter.
// The RRF mapping matches the Califlower/CaliLantern sheet: X=XY, Z=XZ, Y=YZ.
const PLANE_TOKENS: Record<Plane, { klipper: string; marlin: string; rrf: string }> = {
  XY: { klipper: 'XY', marlin: 'I', rrf: 'X' },
  XZ: { klipper: 'XZ', marlin: 'J', rrf: 'Z' },
  YZ: { klipper: 'YZ', marlin: 'K', rrf: 'Y' },
}

/**
 * Skew correction across every measured plane (any subset of XY/XZ/YZ), for the chosen firmware. A
 * plane whose skew is out of range is dropped from the command and noted in the hint rather than
 * poisoning the whole snippet.
 */
export function skewCorrectionMulti(
  flavour: string,
  skews: readonly PlaneSkew[],
  coupon: CouponSpec,
): Correction {
  const usable = skews.filter((s) => Number.isFinite(s.skewDegrees) && Math.abs(s.skewDegrees) < 45.0)
  const dropped = skews.filter((s) => !usable.includes(s))
  const outOfRange = dropped.map((s) => s.plane)
  const rangeHint =
    outOfRange.length > 0
      ? ` ${outOfRange.join(', ')} skew is out of range and was left out; check that scan.`
      : ''

  if (usable.length === 0)
    return {
      code: 'skew out of range, check the scans',
      hint: 'A real coupon skews well under 1 degree; this suggests a detection problem.',
    }

  switch (flavour) {
    case MARLIN: {
      const parts = usable.map((s) => `${PLANE_TOKENS[s.plane].marlin}${f6(planeTan(s.skewDegrees))}`)
      const needsZSkew = usable.some((s) => s.plane === 'XZ' || s.plane === 'YZ')
      const zSkewNote = needsZSkew
        ? ' The XZ/YZ terms (J/K) need Marlin built with SKEW_CORRECTION_FOR_Z.'
        : ''
      return {
        code: `M852 ${parts.join(' ')}\nM500`,
        hint: `Send via console; M500 saves it.${zSkewNote}${rangeHint}`,
      }
    }

    case REPRAP: {
      // RRF's AxisTransform ADDS the factor (opposite of Marlin), so the value is negated, as in the
      // single-plane path. S is the coupon baseline; the per-plane value is -baseline*tan.
      const parts = usable.map(
        (s) => `${PLANE_TOKENS[s.plane].rrf}${f3(-coupon.baselineMm * planeTan(s.skewDegrees))}`,
      )
      return {
        code: `M556 S${upTo3(coupon.baselineMm)} ${parts.join(' ')}`,
        hint: `Add to config.g.${rangeHint}`,
      }
    }

    default: {
      // Klipper: one SET_SKEW carrying every measured plane's baseline triangle.
      const l = coupon.baselineMm
      const parts = usable.map((s) => {
        const tan = planeTan(s.skewDegrees)
        const ac = l * Math.sqrt((1.0 + tan) * (1.0 + tan) + 1.0)
        const bd = l * Math.sqrt((tan - 1.0) * (tan - 1.0) + 1.0)
        const ad = l * Math.sqrt(tan * tan + 1.0)
        return `${PLANE_TOKENS[s.plane].klipper}=${upTo3(ac)},${upTo3(bd)},${upTo3(ad)}`
      })
      return {
        code: `SET_SKEW ${parts.join(' ')}\nSKEW_PROFILE SAVE=ScanNTune\nSAVE_CONFIG`,
        hint: rangeHint.trim(),
        primaryCaption: 'Paste into the Klipper console:',
        secondaryCaption: 'Add this to your start g-code:',
        secondaryCode: 'SKEW_PROFILE LOAD=ScanNTune',
      }
    }
  }
}

export function sizeCorrection(
  flavour: string,
  xScalePercent: number,
  yScalePercent: number,
  currentX: number | null,
  currentY: number | null,
): Correction {
  // A real printer's dimensional error is well under 2%; a reading beyond a few percent means a
  // wrong DPI (a 2x mismatch reads +/-50-100%) or a broken detection. Refusing to synthesize
  // firmware commands from it matters: at +100% the steps/mm branch would emit M92 X0.000.
  if (
    !Number.isFinite(xScalePercent) ||
    !Number.isFinite(yScalePercent) ||
    Math.abs(xScalePercent) >= 10.0 ||
    Math.abs(yScalePercent) >= 10.0
  )
    return {
      code: 'scale out of range, check the scan and DPI',
      hint: "A real printer errs well under 2%; this suggests the scan DPI doesn't match the calibration, or a detection problem.",
    }

  const xf = xScalePercent / 100.0
  const yf = yScalePercent / 100.0
  const avg = (xf + yf) / 2.0

  // The exact correction is the nominal/measured ratio: new = current / (1 + error). The first-order
  // form current * (1 - error) leaves an error^2 residual, so the ratio is used throughout.
  switch (flavour) {
    case STEPS_PER_MM:
      if (currentX != null && currentY != null)
        return {
          code: `M92 X${f3(currentX / (1.0 + xf))} Y${f3(currentY / (1.0 + yf))}\nM500`,
          hint: 'Send via console; M500 saves (Marlin). On Klipper use the Rotation distance flavour.',
        }
      return {
        code: 'enter current steps/mm above',
        hint: 'New = current / (1 + error), per axis.',
      }

    case ROTATION_DISTANCE:
      if (currentX != null && currentY != null)
        return {
          code: `X ${f4((1.0 + xf) * currentX)}   Y ${f4((1.0 + yf) * currentY)}`,
          hint: 'Set rotation_distance in printer.cfg (Klipper).',
        }
      return {
        code: 'enter current rotation distance above',
        hint: 'New = current * (1 + error), per axis.',
      }

    case SCALE:
      return {
        code: `X ${f2(100.0 / (1.0 + xf))} %   Y ${f2(100.0 / (1.0 + yf))} %`,
        hint: 'Scale the model per-axis in your slicer (X and Y can differ).',
      }

    default: // Shrinkage
      return {
        code: `XY shrinkage: ${f2((1.0 + avg) * 100.0)} %`,
        hint: 'OrcaSlicer / SuperSlicer: Filament → Advanced → Shrinkage compensation (XY). Single value; use Steps/mm for per-axis.',
      }
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
  currents: Partial<Record<'X' | 'Y' | 'Z', number | null>>,
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
    case STEPS_PER_MM: {
      const parts = scales
        .filter((s) => currents[s.axis] != null)
        .map((s) => `${s.axis}${f3(currents[s.axis]! / (1.0 + frac(s)))}`)
      if (parts.length === 0)
        return { code: 'enter current steps/mm above', hint: 'New = current / (1 + error), per axis.' }
      return {
        code: `M92 ${parts.join(' ')}\nM500`,
        hint: `Send via console; M500 saves (Marlin). On Klipper use the Rotation distance flavour.${zNote}`,
      }
    }

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
      // Shrinkage: a single XY figure (slicers apply one value), from the X and Y axes only.
      const xy = scales.filter((s) => s.axis === 'X' || s.axis === 'Y')
      if (xy.length === 0)
        return { code: 'no XY scale measured', hint: 'Scan the XY (or XZ and YZ) plate for shrinkage.' }
      const avg = xy.reduce((sum, s) => sum + frac(s), 0) / xy.length
      return {
        code: `XY shrinkage: ${f2((1.0 + avg) * 100.0)} %`,
        hint: `OrcaSlicer / SuperSlicer: Filament -> Advanced -> Shrinkage compensation (XY).${zNote}`,
      }
    }
  }
}

// Number formatting matching the C# invariant-culture format strings.
function f2(n: number): string {
  return n.toFixed(2)
}
function f3(n: number): string {
  return n.toFixed(3)
}
function f4(n: number): string {
  return n.toFixed(4)
}
function f6(n: number): string {
  return n.toFixed(6)
}
// C# "0.###": up to 3 decimals, trailing zeros trimmed.
function upTo3(n: number): string {
  return parseFloat(n.toFixed(3)).toString()
}
