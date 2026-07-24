import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importSlicerConfigs } from '../../../src/engine/pa/slicerImport'

const fixturesDir = join(__dirname, '../../fixtures/slicer')
function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8')
}

const chubechanger = readFixture('orca_machine_chubechanger.json')
const treedPc = readFixture('orca_filament_treed_pc.json')

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

  it('names the result after the uploaded leaf preset, not a resolved parent', () => {
    const result = importSlicerConfigs([
      { fileName: 'orca_machine_chubechanger.json', content: chubechanger },
      { fileName: 'voron24_parent.json', content: voron24Parent },
    ])
    expect(result.presetName).toBe('Chubechanger')
  })

  it('trims surrounding whitespace from the leaf preset name', () => {
    const spaced = JSON.stringify({
      type: 'machine',
      name: '  Spaced Name  ',
      from: 'User',
      version: '2.3.1.10',
      printable_area: ['0x0', '300x0', '300x300', '0x300'],
      gcode_flavor: 'klipper',
      nozzle_diameter: ['0.4'],
    })
    const result = importSlicerConfigs([{ fileName: 'spaced.json', content: spaced }])
    expect(result.presetName).toBe('Spaced Name')
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
    expect(warning).toContain('resources\\profiles\\<vendor>\\machine\\Voron 2.4 300 0.4 nozzle.json')
  })

  it('exposes the unresolved parent structurally with a real vendor guess', () => {
    const result = importSlicerConfigs([
      { fileName: 'orca_machine_chubechanger.json', content: chubechanger },
    ])
    expect(result.unresolvedParents).toEqual([
      {
        presetName: 'Voron 2.4 300 0.4 nozzle',
        pathHint: 'OrcaSlicer\\resources\\profiles\\Voron\\machine\\Voron 2.4 300 0.4 nozzle.json',
        pathIsExactFile: true,
        fileToFind: 'Voron 2.4 300 0.4 nozzle.json',
        fileName: 'orca_machine_chubechanger.json',
      },
    ])
  })

  it('has no structured unresolvedParents once the parent is uploaded', () => {
    const result = importSlicerConfigs([
      { fileName: 'orca_machine_chubechanger.json', content: chubechanger },
      { fileName: 'voron24_parent.json', content: voron24Parent },
    ])
    expect(result.unresolvedParents).toEqual([])
  })

  it('emits the resources\\profiles base folder when no candidate name is a known vendor', () => {
    const preset = JSON.stringify({
      type: 'machine',
      name: 'Weird Child',
      inherits: '0.4 Generic Nozzle',
      printable_area: ['0x0', '100x0', '100x100', '0x100'],
      gcode_flavor: 'klipper',
    })
    const result = importSlicerConfigs([{ fileName: 'weird_name.json', content: preset }])
    expect(result.unresolvedParents).toEqual([
      {
        presetName: '0.4 Generic Nozzle',
        pathHint: 'OrcaSlicer\\resources\\profiles\\',
        pathIsExactFile: false,
        fileToFind: '0.4 Generic Nozzle.json',
        fileName: 'weird_name.json',
      },
    ])
  })

  it('emits the base folder honoring the install path when no candidate name is a known vendor', () => {
    const preset = JSON.stringify({
      type: 'machine',
      name: '0.4 nozzle child',
      inherits: '0.4 Generic Nozzle',
      printable_area: ['0x0', '100x0', '100x100', '0x100'],
      gcode_flavor: 'klipper',
    })
    const result = importSlicerConfigs(
      [{ fileName: 'weird_name.json', content: preset }],
      [],
      'C:\\Program Files\\OrcaSlicer\\',
    )
    expect(result.unresolvedParents).toEqual([
      {
        presetName: '0.4 Generic Nozzle',
        pathHint: 'C:\\Program Files\\OrcaSlicer\\resources\\profiles\\',
        pathIsExactFile: false,
        fileToFind: '0.4 Generic Nozzle.json',
        fileName: 'weird_name.json',
      },
    ])
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

  it('reads the singular chamber_temperature key on a real Orca filament preset', () => {
    const result = importSlicerConfigs([
      { fileName: 'orca_filament_treed_pc.json', content: treedPc },
    ])
    expect(result.fields.filament.chamberTempC).toBe(90)
    expect(result.fields.filament.nozzleTempC).toBe(285)
    expect(result.missing).toContain('bedTempC')
    expect(result.missing).toContain('filamentType')
    expect(result.warnings.some((w) => w.toLowerCase().includes('generic pc @system'))).toBe(true)
    // Filament preset locations are irregular, so no exact file is fabricated: pathHint is the
    // resources\profiles base folder and the UI tells the user to find the file inside it.
    expect(result.unresolvedParents).toEqual([
      {
        presetName: 'Generic PC @System',
        pathHint: 'OrcaSlicer\\resources\\profiles\\',
        pathIsExactFile: false,
        fileToFind: 'Generic PC @System.json',
        fileName: 'orca_filament_treed_pc.json',
      },
    ])
  })

  it('resolves the chain from a cached parent preset without re-upload', () => {
    const result = importSlicerConfigs(
      [{ fileName: 'orca_machine_chubechanger.json', content: chubechanger }],
      [{ fileName: 'Voron 2.4 300 0.4 nozzle.json', content: voron24Parent }],
    )
    expect(result.unresolvedParents).toEqual([])
    expect(result.warnings.some((w) => w.toLowerCase().includes('inherit'))).toBe(false)
    expect(result.fields.printer.bedWidthMm).toBe(300)
    expect(result.fields.printer.bedDepthMm).toBe(300)
    // Child's own retraction_length (0.8) wins over the cached parent's (0.6).
    expect(result.fields.printer.retractMm).toBe(0.8)
  })

  it('reports a parent resolved from the cache under resolvedFromCache', () => {
    const result = importSlicerConfigs(
      [{ fileName: 'orca_machine_chubechanger.json', content: chubechanger }],
      [{ fileName: 'Voron 2.4 300 0.4 nozzle.json', content: voron24Parent }],
    )
    expect(result.resolvedFromCache).toEqual([{ presetName: 'Voron 2.4 300 0.4 nozzle' }])
    expect(result.unresolvedParents).toEqual([])
  })

  it('does not report an uploaded (non-cached) parent as resolved from cache', () => {
    const result = importSlicerConfigs([
      { fileName: 'orca_machine_chubechanger.json', content: chubechanger },
      { fileName: 'voron24_parent.json', content: voron24Parent },
    ])
    expect(result.resolvedFromCache).toEqual([])
  })

  it('never imports a cached preset standalone: cache alone with no upload fills nothing', () => {
    const result = importSlicerConfigs(
      [],
      [{ fileName: 'Voron 2.4 300 0.4 nozzle.json', content: voron24Parent }],
    )
    expect(result.imported).toEqual([])
    expect(result.fields.printer).toEqual({})
  })

  it('an uploaded preset wins over a cached preset of the same name', () => {
    const staleCached = JSON.stringify({
      type: 'machine',
      name: 'Voron 2.4 300 0.4 nozzle',
      printable_area: ['0x0', '250x0', '250x250', '0x250'],
      gcode_flavor: 'klipper',
    })
    const result = importSlicerConfigs(
      [
        { fileName: 'orca_machine_chubechanger.json', content: chubechanger },
        { fileName: 'voron24_parent.json', content: voron24Parent },
      ],
      [{ fileName: 'stale.json', content: staleCached }],
    )
    expect(result.fields.printer.bedWidthMm).toBe(300)
  })

  it('makes the parent path hint absolute when an install path is given', () => {
    const result = importSlicerConfigs(
      [{ fileName: 'orca_machine_chubechanger.json', content: chubechanger }],
      [],
      'C:\\Program Files\\OrcaSlicer\\',
    )
    expect(result.unresolvedParents).toEqual([
      {
        presetName: 'Voron 2.4 300 0.4 nozzle',
        pathHint:
          'C:\\Program Files\\OrcaSlicer\\resources\\profiles\\Voron\\machine\\Voron 2.4 300 0.4 nozzle.json',
        pathIsExactFile: true,
        fileToFind: 'Voron 2.4 300 0.4 nozzle.json',
        fileName: 'orca_machine_chubechanger.json',
      },
    ])
  })

  it('uses forward slashes and avoids duplicate resources dir for macOS install path', () => {
    const result = importSlicerConfigs(
      [{ fileName: 'orca_machine_chubechanger.json', content: chubechanger }],
      [],
      '/Applications/OrcaSlicer.app/Contents/Resources',
    )
    expect(result.unresolvedParents).toEqual([
      {
        presetName: 'Voron 2.4 300 0.4 nozzle',
        pathHint:
          '/Applications/OrcaSlicer.app/Contents/Resources/profiles/Voron/machine/Voron 2.4 300 0.4 nozzle.json',
        pathIsExactFile: true,
        fileToFind: 'Voron 2.4 300 0.4 nozzle.json',
        fileName: 'orca_machine_chubechanger.json',
      },
    ])
  })

  it('uses forward slashes and appends resources/profiles/ for Linux install path', () => {
    const result = importSlicerConfigs(
      [{ fileName: 'orca_machine_chubechanger.json', content: chubechanger }],
      [],
      '/usr/share/OrcaSlicer',
    )
    expect(result.unresolvedParents).toEqual([
      {
        presetName: 'Voron 2.4 300 0.4 nozzle',
        pathHint:
          '/usr/share/OrcaSlicer/resources/profiles/Voron/machine/Voron 2.4 300 0.4 nozzle.json',
        pathIsExactFile: true,
        fileToFind: 'Voron 2.4 300 0.4 nozzle.json',
        fileName: 'orca_machine_chubechanger.json',
      },
    ])
  })


  it('reports a per-file sources breakdown of imported fields', () => {
    const result = importSlicerConfigs([
      { fileName: 'orca_machine_chubechanger.json', content: chubechanger },
      { fileName: 'voron24_parent.json', content: voron24Parent },
    ])
    // The parent is consumed by the chain, so only the child appears as a source.
    expect(result.sources?.map((s) => s.fileName)).toEqual(['orca_machine_chubechanger.json'])
    expect(result.sources?.[0].imported).toContain('bedWidthMm')
  })

  it('prefixes generic per-file warnings with the source file name', () => {
    const percentIni = 'retract_length = 75%\nbed_shape = 0x0,10x0,10x10,0x10\n'
    const result = importSlicerConfigs([{ fileName: 'weird.ini', content: percentIni }])
    expect(result.warnings.some((w) => w.startsWith('weird.ini:'))).toBe(true)
  })

  it('falls back to the referencing child name when the missing parent name has no vendor word', () => {
    const child = JSON.stringify({
      type: 'machine',
      name: 'Voron X 0.4 nozzle',
      inherits: 'fdm_klipper_common',
      printable_area: ['0x0', '300x0', '300x300', '0x300'],
      gcode_flavor: 'klipper',
    })
    const result = importSlicerConfigs([{ fileName: 'voron_x.json', content: child }])
    const parent = result.unresolvedParents?.find((p) => p.presetName === 'fdm_klipper_common')
    expect(parent?.pathHint).toBe(
      'OrcaSlicer\\resources\\profiles\\Voron\\machine\\fdm_klipper_common.json',
    )
  })

  it('falls back to the referencing child name with an install path given', () => {
    const child = JSON.stringify({
      type: 'machine',
      name: 'Voron X 0.4 nozzle',
      inherits: 'fdm_klipper_common',
      printable_area: ['0x0', '300x0', '300x300', '0x300'],
      gcode_flavor: 'klipper',
    })
    const result = importSlicerConfigs(
      [{ fileName: 'voron_x.json', content: child }],
      [],
      'C:\\Program Files\\OrcaSlicer\\',
    )
    const parent = result.unresolvedParents?.find((p) => p.presetName === 'fdm_klipper_common')
    expect(parent?.pathHint).toBe(
      'C:\\Program Files\\OrcaSlicer\\resources\\profiles\\Voron\\machine\\fdm_klipper_common.json',
    )
  })

  it('prefers an intermediate system preset over the user root when both carry a vendor-shaped word', () => {
    // 4-level chain: user root ("Mybox custom", vendor-shaped but not a real vendor) inherits a
    // system preset ("Voron X 0.4 nozzle", the real vendor) inherits fdm_klipper_common inherits
    // the unresolved fdm_machine_common. The correct vendor sits in the middle of the chain, not
    // at the root, so the candidate list must walk the whole ancestry, nearest first.
    const grandparent = JSON.stringify({
      type: 'machine',
      name: 'fdm_klipper_common',
      inherits: 'fdm_machine_common',
      gcode_flavor: 'klipper',
    })
    const parentPreset = JSON.stringify({
      type: 'machine',
      name: 'Voron X 0.4 nozzle',
      inherits: 'fdm_klipper_common',
      printable_area: ['0x0', '300x0', '300x300', '0x300'],
      gcode_flavor: 'klipper',
    })
    const child = JSON.stringify({
      type: 'machine',
      name: 'Mybox custom',
      inherits: 'Voron X 0.4 nozzle',
      printable_area: ['0x0', '300x0', '300x300', '0x300'],
      gcode_flavor: 'klipper',
    })
    const result = importSlicerConfigs([
      { fileName: 'mybox.json', content: child },
      { fileName: 'voron_x.json', content: parentPreset },
      { fileName: 'klipper_common.json', content: grandparent },
    ])
    const parent = result.unresolvedParents?.find((p) => p.presetName === 'fdm_machine_common')
    expect(parent?.pathHint).toBe(
      'OrcaSlicer\\resources\\profiles\\Voron\\machine\\fdm_machine_common.json',
    )
  })

  it('emits the base folder for a machine base whose only candidate is a non-vendor name', () => {
    // "Mybox custom" is vendor-shaped but not a real Orca vendor folder, and nothing nearer carries
    // one, so no exact file is fabricated; the UI shows the base folder to search inside instead.
    const child = JSON.stringify({
      type: 'machine',
      name: 'Mybox custom',
      inherits: 'fdm_machine_common',
      printable_area: ['0x0', '300x0', '300x300', '0x300'],
      gcode_flavor: 'klipper',
    })
    const result = importSlicerConfigs([{ fileName: 'mybox.json', content: child }])
    const parent = result.unresolvedParents?.find((p) => p.presetName === 'fdm_machine_common')
    expect(parent?.pathHint).toBe('OrcaSlicer\\resources\\profiles\\')
    expect(parent?.pathIsExactFile).toBe(false)
    expect(parent?.fileToFind).toBe('fdm_machine_common.json')
  })
})
