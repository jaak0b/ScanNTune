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
    // Tiers 106 and 150 mm/s: spatial frequencies 20 / 150 = 0.1333 to 150 / 106 = 1.4151
    // cycles/mm at a step of 1 / 150, 193 candidates, periods 7.5 mm down to 0.707 mm
    // (hand-computed).
    const periods = gridCandidates([106, 150])
    expect(periods).toHaveLength(193)
    expect(periods[0]).toBeCloseTo(7.5, 9)
    expect(periods[periods.length - 1]).toBeCloseTo(0.70755, 4)
  })
})

describe('knownCandidates', () => {
  it('keeps the GT2 pitch and harmonic and drops JPEG blocks outside the band at 600 dpi', () => {
    // At 600 dpi the 8 and 16 px blocks are 0.339 and 0.677 mm, which read above 150 Hz on both
    // tiers; 2 mm reads 53 and 75 Hz, 1 mm 106 and 150 Hz.
    const profile = defaultPrinterProfile()
    const spec = { ...fitSpecToPrinter(defaultIsTestRequest(profile), profile).spec, axes: ['y' as const] }
    const lines = simulateAxis({ seed: 1, spec, noise: { model: 'iid', sigmaPx: 0.1 } })
    const bases = lines.map((l) => lineBasis(analyzeTracedLine(l.trace).window!))
    expect(knownCandidates(bases)).toEqual([2, 1])
  })

  it('adds the 16 px JPEG block at 300 dpi, where it reads inside the band', () => {
    // At 300 dpi (11.81 px/mm) the 16 px block is 1.355 mm: 78 Hz at 106 mm/s, 111 Hz at 150.
    const profile = defaultPrinterProfile()
    const spec = { ...fitSpecToPrinter(defaultIsTestRequest(profile), profile).spec, axes: ['y' as const] }
    const lines = simulateAxis({ seed: 1, spec, noise: { model: 'iid', sigmaPx: 0.1 }, pxPerMm: 300 / 25.4 })
    const bases = lines.map((l) => lineBasis(analyzeTracedLine(l.trace).window!))
    const periods = knownCandidates(bases)
    expect(periods.slice(0, 2)).toEqual([2, 1])
    expect(periods).toHaveLength(3)
    expect(periods[2]).toBeCloseTo(1.3547, 3)
  })
})
