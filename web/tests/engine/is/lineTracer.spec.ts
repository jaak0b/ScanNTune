// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getCv } from '../../helpers/cv'
import { renderIsScan } from '../../helpers/isRender'
import { rgbaToBgrMat } from '../../../src/engine/imageData'
import { alignIsCoupon } from '../../../src/engine/is/isFiducialAligner'
import { isCouponGeometry } from '../../../src/engine/is/couponGeometry'
import { traceGroup } from '../../../src/engine/is/lineTracer'
import { defaultIsTestRequest, fitSpecToPrinter } from '../../../src/engine/is/types'
import type { IsAxis } from '../../../src/engine/is/types'
import { defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'
import { median } from '../../../src/engine/math'

// The tracer's lateral sign relative to the run-up, through the scan's mirror and quarter turns.
// The renderer (tests/helpers/isRender.ts) draws each line's lateral displacement toward +Y for
// the Y group, whose run-up travels +Y, and toward +X for the X group, whose run-up travels -X.
// Every line carries only a slow corner lobe, 0.3 mm on the top rung decaying with 50 ms, so the
// first millimetres of a top-rung trace sit 0.15 to 0.25 mm off the nominal centerline: toward
// the run-up on the Y lines, against it on the X lines.

const PX_PER_MM = 12
const profile = defaultPrinterProfile()
const spec = fitSpecToPrinter(defaultIsTestRequest(profile), profile).spec
const LOBE_ONLY = { frequencyHz: 60, dampingRatio: 0.05, ringAmpMm: 0, lobeAmpMm: 0.3, lobeTauS: 0.05 }

/** The median of lateralTowardRunUp * lateral deviation over the first 40 samples of each
 *  top-rung line of a group, traced in a mirrored scan turned `quarterTurns`. */
async function earlyDisplacementTowardRunUp(axis: IsAxis, quarterTurns: 0 | 1): Promise<number[]> {
  const cv = await getCv()
  const bgr = rgbaToBgrMat(cv, renderIsScan({ spec, truth: { x: LOBE_ONLY, y: LOBE_ONLY }, pxPerMm: PX_PER_MM, quarterTurns, flipped: true }))
  const gray = new cv.Mat()
  try {
    cv.cvtColor(bgr, gray, cv.COLOR_BGR2GRAY)
    const alignment = alignIsCoupon(cv, bgr, spec)
    expect(alignment.success).toBe(true)
    const group = isCouponGeometry(spec).groups.find((g) => g.axis === axis)!
    const traced = traceGroup(cv, gray, alignment, spec, group, PX_PER_MM)
    return group.lines
      .map((line, i) => ({ line, trace: traced.traces[i] }))
      .filter(({ line }) => line.rungIndex === spec.linesPerSpeed - 1)
      .map(({ trace }) => median(Array.from(trace!.lateralMm.subarray(0, 40), (v) => trace!.lateralTowardRunUp * v)))
  } finally {
    bgr.delete()
    gray.delete()
  }
}

describe('traceGroup lateral sign', () => {
  it.each([0, 1] as const)(
    'reads the Y lines displaced toward their run-up in a mirrored scan turned %i quarter turns',
    async (quarterTurns) => {
      // One top-rung line per speed tier.
      const displacements = await earlyDisplacementTowardRunUp('y', quarterTurns)
      expect(displacements).toHaveLength(2)
      expect(Math.min(...displacements)).toBeGreaterThan(0.1)
    },
    120_000,
  )

  it.each([0, 1] as const)(
    'reads the X lines displaced against their run-up in a mirrored scan turned %i quarter turns',
    async (quarterTurns) => {
      const displacements = await earlyDisplacementTowardRunUp('x', quarterTurns)
      expect(displacements).toHaveLength(2)
      expect(Math.max(...displacements)).toBeLessThan(-0.1)
    },
    120_000,
  )
})
