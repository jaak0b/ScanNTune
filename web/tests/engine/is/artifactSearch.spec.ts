// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { gridCandidates, knownCandidates } from '../../../src/engine/is/artifactSearch'
import { analyzeTracedLine } from '../../../src/engine/is/ringAnalyzer'
import { lineBasis } from '../../../src/engine/is/ringGls'
import { defaultIsTestRequest, fitSpecToPrinter } from '../../../src/engine/is/types'
import { defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'
import { simulateAxis } from '../../helpers/isTraceSim'

describe('gridCandidates', () => {
  it('spans the band both tiers search, at the fast tier one hertz step', () => {
    // Tiers 90 and 150 mm/s: spatial frequencies 20 / 150 = 0.1333 to 200 / 90 = 2.2222
    // cycles/mm at a step of 1 / 150, 314 candidates, periods 7.5 mm down to 1 / 2.22 = 0.45045 mm
    // (hand-computed).
    const periods = gridCandidates([90, 150]).map((c) => c.periodMm)
    expect(periods).toHaveLength(314)
    expect(periods[0]).toBeCloseTo(7.5, 9)
    expect(periods[periods.length - 1]).toBeCloseTo(0.45045, 4)
  })
})

describe('knownCandidates', () => {
  it('keeps the GT2 pitch and harmonic and drops JPEG blocks outside the band at 600 dpi', () => {
    // At 600 dpi the 8 px block is 0.339 mm, which reads above 200 Hz on both tiers (266 and
    // 443 Hz); the 16 px block is 0.677 mm, 133 Hz at 90 mm/s, inside the band. 2 mm reads 45 and
    // 75 Hz, 1 mm 90 and 150 Hz.
    const profile = defaultPrinterProfile()
    const spec = { ...fitSpecToPrinter(defaultIsTestRequest(profile), profile).spec, axes: ['y' as const] }
    const lines = simulateAxis({ seed: 1, spec, noise: { model: 'iid', sigmaPx: 0.1 } })
    const bases = lines.map((l) => lineBasis(analyzeTracedLine(l.trace).window!))
    const periods = knownCandidates(bases).map((c) => c.periodMm)
    expect(periods.slice(0, 2)).toEqual([2, 1])
    expect(periods).toHaveLength(3)
    expect(periods[2]).toBeCloseTo(0.67733, 4)
  })

  it('adds the 8 and 16 px JPEG blocks at 300 dpi, where both read inside the band', () => {
    // At 300 dpi (11.81 px/mm) the 8 px block is 0.677 mm, 133 Hz at 90 mm/s; the 16 px block is
    // 1.355 mm, 66 Hz at 90 mm/s and 111 Hz at 150.
    const profile = defaultPrinterProfile()
    const spec = { ...fitSpecToPrinter(defaultIsTestRequest(profile), profile).spec, axes: ['y' as const] }
    const lines = simulateAxis({ seed: 1, spec, noise: { model: 'iid', sigmaPx: 0.1 }, pxPerMm: 300 / 25.4 })
    const bases = lines.map((l) => lineBasis(analyzeTracedLine(l.trace).window!))
    const periods = knownCandidates(bases).map((c) => c.periodMm)
    expect(periods.slice(0, 2)).toEqual([2, 1])
    expect(periods).toHaveLength(4)
    expect(periods[2]).toBeCloseTo(0.67733, 4)
    expect(periods[3]).toBeCloseTo(1.3547, 3)
  })
})
