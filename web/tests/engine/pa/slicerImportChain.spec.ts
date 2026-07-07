import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importSlicerConfigs } from '../../../src/engine/pa/slicerImport'

const fixturesDir = join(__dirname, '../../fixtures/slicer')
function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8')
}

const chubechanger = readFixture('orca_machine_chubechanger.json')

// Minimal synthetic parent: not shipped in the repo (it lives in the OrcaSlicer install), so the
// chain-resolution test constructs the parent preset inline instead of depending on a real system file.
const voron24Parent = JSON.stringify({
  type: 'machine',
  name: 'Voron 2.4 300 0.4 nozzle',
  from: 'system',
  version: '2.3.1.10',
  printable_area: ['0x0', '300x0', '300x300', '0x300'],
  gcode_flavor: 'klipper',
  nozzle_diameter: ['0.4'],
  retraction_length: ['0.6'],
  retraction_speed: ['40'],
})

describe('importSlicerConfigs: multi-file Orca inherits resolution', () => {
  it('resolves the chain identically regardless of upload order', () => {
    const orderA = importSlicerConfigs([
      { fileName: 'orca_machine_chubechanger.json', content: chubechanger },
      { fileName: 'voron24_parent.json', content: voron24Parent },
    ])
    const orderB = importSlicerConfigs([
      { fileName: 'voron24_parent.json', content: voron24Parent },
      { fileName: 'orca_machine_chubechanger.json', content: chubechanger },
    ])
    expect(orderA.fields).toEqual(orderB.fields)
    expect(orderA.fields.printer.bedWidthMm).toBe(300)
    expect(orderA.fields.printer.bedDepthMm).toBe(300)
    expect(orderA.fields.printer.firmware).toBe('Klipper')
    // Child's own retraction_length (0.8) wins over the parent's (0.6).
    expect(orderA.fields.printer.retractMm).toBe(0.8)
  })

  it('has no unresolved-inherits warning once the parent is uploaded', () => {
    const result = importSlicerConfigs([
      { fileName: 'orca_machine_chubechanger.json', content: chubechanger },
      { fileName: 'voron24_parent.json', content: voron24Parent },
    ])
    expect(result.warnings.some((w) => w.toLowerCase().includes('inherit'))).toBe(false)
  })

  it('keeps the unresolved-inherits warning with a parent-path hint when uploaded alone', () => {
    const result = importSlicerConfigs([
      { fileName: 'orca_machine_chubechanger.json', content: chubechanger },
    ])
    const warning = result.warnings.find((w) => w.toLowerCase().includes('inherit'))
    expect(warning).toBeDefined()
    expect(warning).toContain('Voron 2.4 300 0.4 nozzle')
    expect(warning).toContain('resources\\profiles\\<vendor>\\machine\\')
  })

  it('does not hang on a two-preset inherits cycle and warns instead', () => {
    const a = JSON.stringify({
      type: 'machine',
      name: 'Cycle A',
      inherits: 'Cycle B',
      printable_area: ['0x0', '100x0', '100x100', '0x100'],
      gcode_flavor: 'klipper',
    })
    const b = JSON.stringify({
      type: 'machine',
      name: 'Cycle B',
      inherits: 'Cycle A',
      printable_area: ['0x0', '100x0', '100x100', '0x100'],
      gcode_flavor: 'klipper',
    })
    const result = importSlicerConfigs([
      { fileName: 'a.json', content: a },
      { fileName: 'b.json', content: b },
    ])
    expect(result.warnings.some((w) => w.toLowerCase().includes('cycle'))).toBe(true)
  })

  it('single non-chain file behaves the same as importSlicerConfig', () => {
    const result = importSlicerConfigs([
      { fileName: 'orca_machine_chubechanger.json', content: chubechanger },
    ])
    expect(result.fields.printer.nozzleDiameterMm).toBe(0.4)
    expect(result.fields.printer.retractMm).toBe(0.8)
  })

  it('prefixes generic per-file warnings with the source file name', () => {
    const percentIni = 'retract_length = 75%\nbed_shape = 0x0,10x0,10x10,0x10\n'
    const result = importSlicerConfigs([{ fileName: 'weird.ini', content: percentIni }])
    expect(result.warnings.some((w) => w.startsWith('weird.ini:'))).toBe(true)
  })
})
