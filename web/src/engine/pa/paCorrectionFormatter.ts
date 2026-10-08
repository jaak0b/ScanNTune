import type { Correction } from '../types'
import type { PaTestSpec } from './types'
import { paCommand, smoothTimeCommand } from './gcodeGenerator'

export function paCorrection(paValue: number): Correction {
  const v = paValue.toFixed(4)
  return {
    code: paCommand(paValue),
    hint: 'For a permanent setting, add the line below to the [extruder] section of printer.cfg.',
    secondaryCaption: 'printer.cfg',
    secondaryCode: `pressure_advance: ${v}`,
  }
}

/** Smooth time result: the live command plus the printer.cfg line. */
export function smoothTimeCorrection(paValue: number, smoothTime: number): Correction {
  return {
    code: smoothTimeCommand(paValue, smoothTime),
    hint: 'For a permanent setting, add the line below to the [extruder] section of printer.cfg.',
    secondaryCaption: 'printer.cfg',
    secondaryCode: `pressure_advance_smooth_time: ${smoothTime.toFixed(4)}`,
  }
}

/**
 * The correction matching the spec's sweep kind: the best value is a pressure advance K for an
 * 'advance' sweep and a smooth time (seconds) for a 'smoothTime' sweep.
 */
export function sweepCorrection(spec: PaTestSpec, bestValue: number): Correction {
  if (spec.sweep === 'smoothTime') {
    if (spec.fixedAdvance === undefined) {
      throw new Error('A smooth time sweep needs a fixed pressure advance value (fixedAdvance).')
    }
    return smoothTimeCorrection(spec.fixedAdvance, bestValue)
  }
  return paCorrection(bestValue)
}
