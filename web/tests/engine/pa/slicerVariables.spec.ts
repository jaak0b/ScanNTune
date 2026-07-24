import { describe, expect, it } from 'vitest'
import {
  substituteSlicerVariables,
  unresolvedVariablesWarning,
  type SlicerGenerationContext,
} from '../../../src/engine/pa/slicerVariables'
import { defaultFilamentProfile, defaultPrinterProfile } from '../../../src/engine/pa/types'
import type { FilamentProfile, PrinterProfile } from '../../../src/engine/pa/types'

function printer(overrides: Partial<PrinterProfile> = {}): PrinterProfile {
  return { ...defaultPrinterProfile(), ...overrides }
}

function filament(overrides: Partial<FilamentProfile> = {}): FilamentProfile {
  return { ...defaultFilamentProfile(), ...overrides }
}

function substitute(
  gcode: string,
  p: Partial<PrinterProfile> = {},
  f: Partial<FilamentProfile> = {},
  context?: SlicerGenerationContext,
): { gcode: string; unknown: string[]; warnings: string[] } {
  return substituteSlicerVariables(gcode, printer(p), filament(f), context)
}

describe('substituteSlicerVariables', () => {
  it('substitutes square-bracket variables', () => {
    const r = substitute(
      'M104 S[first_layer_temperature]\nM140 S[first_layer_bed_temperature]',
      {},
      { nozzleTempC: 215, bedTempC: 65 },
    )
    expect(r.gcode).toBe('M104 S215\nM140 S65')
    expect(r.unknown).toEqual([])
  })

  it('substitutes curly-brace variables', () => {
    const r = substitute('M104 S{temperature}', {}, { nozzleTempC: 200 })
    expect(r.gcode).toBe('M104 S200')
  })

  it('ignores a numeric index suffix in both syntaxes', () => {
    const r = substitute('M104 S[first_layer_temperature[0]] T{temperature[0]}', {}, {
      nozzleTempC: 230,
    })
    expect(r.gcode).toBe('M104 S230 T230')
    expect(r.unknown).toEqual([])
  })

  it('maps every documented variable name', () => {
    const p: Partial<PrinterProfile> = {
      layerHeightMm: 0.2,
      nozzleDiameterMm: 0.4,
      travelSpeedMmS: 150,
    }
    const f: Partial<FilamentProfile> = {
      nozzleTempC: 210,
      bedTempC: 60,
      chamberTempC: 40,
      filamentType: 'ABS',
      filamentDiameterMm: 1.75,
    }
    const src = [
      '[first_layer_temperature] [temperature] [nozzle_temperature] [first_layer_nozzle_temperature]',
      '[first_layer_bed_temperature] [bed_temperature] [first_layer_bed_temp]',
      '[chamber_temperature] [chamber_temp]',
      '[filament_type]',
      '[layer_height] [first_layer_height]',
      '[nozzle_diameter] [filament_diameter] [travel_speed]',
    ].join('\n')
    const r = substitute(src, p, f)
    expect(r.gcode).toBe(
      ['210 210 210 210', '60 60 60', '40 40', 'ABS', '0.2 0.2', '0.4 1.75 150'].join('\n'),
    )
    expect(r.unknown).toEqual([])
  })

  it('substitutes the PrusaSlicer PRINT_START example line with default values', () => {
    const r = substitute(
      'M117\nPRINT_START BED=[first_layer_bed_temperature] HOTEND=[first_layer_temperature] FILAMENT_TYPE=[filament_type] CHAMBER_TEMP=[chamber_temperature]',
    )
    expect(r.gcode).toBe(
      'M117\nPRINT_START BED=60 HOTEND=210 FILAMENT_TYPE=PLA CHAMBER_TEMP=0',
    )
    expect(r.unknown).toEqual([])
  })

  it('leaves unknown placeholders verbatim and reports them deduplicated', () => {
    const r = substitute(
      'START [machine_start_gcode] {machine_start_gcode} [machine_start_gcode]',
    )
    expect(r.gcode).toBe('START [machine_start_gcode] {machine_start_gcode} [machine_start_gcode]')
    expect(r.unknown).toEqual(['machine_start_gcode'])
  })

  it('leaves Klipper jinja and dotted object refs untouched and unreported', () => {
    const src = [
      '{% if printer.extruder.target > 0 %}',
      'M104 S{printer.extruder.target}',
      '{% endif %}',
      '; comment with [brackets like this?] and {1+2}',
    ].join('\n')
    const r = substitute(src)
    expect(r.gcode).toBe(src)
    expect(r.unknown).toEqual([])
  })

  it('does not treat non-identifier bracket content as a placeholder', () => {
    const src = 'G1 X10 ; [10mm] {not-a-var} [a b] [_ok_though]'
    const r = substitute(src)
    expect(r.gcode).toBe('G1 X10 ; [10mm] {not-a-var} [a b] [_ok_though]')
    expect(r.unknown).toEqual(['_ok_though'])
  })

  it('treats Object.prototype property names as unknown, not as variables', () => {
    const r = substitute('{constructor} [toString] {hasOwnProperty}')
    expect(r.gcode).toBe('{constructor} [toString] {hasOwnProperty}')
    expect(r.unknown).toEqual(['constructor', 'toString', 'hasOwnProperty'])
  })

  it('is case-sensitive', () => {
    const r = substitute('[Temperature]')
    expect(r.gcode).toBe('[Temperature]')
    expect(r.unknown).toEqual(['Temperature'])
  })

  it('evaluates the Klipper tool-changer PRINT_START macro for the single tool', () => {
    const macro =
      'PRINT_START TOOL_TEMP={first_layer_temperature[initial_tool]} {if is_extruder_used[0]}T0_TEMP={first_layer_temperature[0]}{endif} {if is_extruder_used[1]}T1_TEMP={first_layer_temperature[1]}{endif} {if is_extruder_used[2]}T2_TEMP={first_layer_temperature[2]}{endif} {if is_extruder_used[3]}T3_TEMP={first_layer_temperature[3]}{endif} {if is_extruder_used[4]}T4_TEMP={first_layer_temperature[4]}{endif} {if is_extruder_used[5]}T5_TEMP={first_layer_temperature[5]}{endif} BED_TEMP=[first_layer_bed_temperature] TOOL=[initial_tool]'
    const r = substitute(macro, {}, { nozzleTempC: 210, bedTempC: 60 })
    expect(r.gcode.replace(/\s+/g, ' ').trim()).toBe(
      'PRINT_START TOOL_TEMP=210 T0_TEMP=210 BED_TEMP=60 TOOL=0',
    )
    expect(r.unknown).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('evaluates nested conditionals', () => {
    const src = '{if is_extruder_used[0]}A{if initial_tool == 0}B{endif}C{endif}D'
    const r = substitute(src)
    expect(r.gcode).toBe('ABCD')
    expect(r.unknown).toEqual([])
  })

  it('keeps the else branch when the condition is false', () => {
    const src = '{if is_extruder_used[1]}NO{else}YES{endif}'
    const r = substitute(src)
    expect(r.gcode).toBe('YES')
    expect(r.unknown).toEqual([])
  })

  it('takes an elif branch', () => {
    const src = '{if is_extruder_used[1]}A{elif is_extruder_used[0]}B{else}C{endif}'
    const r = substitute(src)
    expect(r.gcode).toBe('B')
  })

  it('leaves an unresolvable conditional literal with a single warning naming the condition', () => {
    const src = 'X {if some_unknown_flag > 3}Y{endif} Z'
    const r = substitute(src)
    expect(r.gcode).toBe(src)
    expect(r.unknown).toEqual([])
    expect(r.warnings).toEqual([
      'The conditional "{if some_unknown_flag > 3}" could not be evaluated, so the whole block ' +
        'was left in the G-code exactly as written. Review the block in your start G-code, and ' +
        'either fix the condition or replace the block with the lines from the branch you ' +
        'intend to use.',
    ])
  })

  it('reports a genuinely unknown setting even inside a kept branch', () => {
    const src = '{if is_extruder_used[0]}[some_unmapped_setting]{endif}'
    const r = substitute(src)
    expect(r.gcode).toBe('[some_unmapped_setting]')
    expect(r.unknown).toEqual(['some_unmapped_setting'])
  })

  it('never reports if/elif/else/endif as unknown variables', () => {
    const src = '{if is_extruder_used[1]}A{elif is_extruder_used[2]}B{else}C{endif}'
    const r = substitute(src)
    expect(r.unknown).toEqual([])
  })

  it('leaves jinja conditionals untouched and unreported', () => {
    const src = '{% if x %}\nM104 S{printer.extruder.target}\n{% endif %}'
    const r = substitute(src)
    expect(r.gcode).toBe(src)
    expect(r.unknown).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('maps nozzle_temperature_initial_layer and bed_temperature_initial_layer_single to the filament temperatures', () => {
    const r = substitute(
      '[nozzle_temperature_initial_layer] [bed_temperature_initial_layer_single]',
      {},
      { nozzleTempC: 220, bedTempC: 70 },
    )
    expect(r.gcode).toBe('220 70')
    expect(r.unknown).toEqual([])
  })

  it('substitutes filament_max_volumetric_speed when the filament has one configured', () => {
    const r = substitute('[filament_max_volumetric_speed]', {}, { maxVolumetricFlowMm3S: 15 })
    expect(r.gcode).toBe('15')
    expect(r.unknown).toEqual([])
  })

  it('leaves filament_max_volumetric_speed unresolved rather than substituting 0 when unset', () => {
    const r = substitute('MAX_FLOW=[filament_max_volumetric_speed]', {}, { maxVolumetricFlowMm3S: 0 })
    expect(r.gcode).toBe('MAX_FLOW=[filament_max_volumetric_speed]')
    expect(r.unknown).toEqual(['filament_max_volumetric_speed'])
  })

  it('substitutes outer_wall_speed and outer_wall_line_width from the generation context', () => {
    const r = substitute('SPEED=[outer_wall_speed] WIDTH=[outer_wall_line_width]', {}, {}, {
      outerWallSpeedMmS: 45.5,
      outerWallLineWidthMm: 0.42,
    })
    expect(r.gcode).toBe('SPEED=45.5 WIDTH=0.42')
    expect(r.unknown).toEqual([])
  })

  it('leaves outer_wall_speed and outer_wall_line_width unresolved without a generation context', () => {
    const r = substitute('SPEED=[outer_wall_speed] WIDTH=[outer_wall_line_width]')
    expect(r.gcode).toBe('SPEED=[outer_wall_speed] WIDTH=[outer_wall_line_width]')
    expect(r.unknown).toEqual(['outer_wall_speed', 'outer_wall_line_width'])
  })

  it('substitutes first_layer_print_min/max components via the indexed [name[idx]] form', () => {
    const context: SlicerGenerationContext = {
      firstLayerBboxMm: { minXMm: 10, minYMm: 5, maxXMm: 90, maxYMm: 45 },
    }
    const r = substitute(
      'MINX=[first_layer_print_min[0]] MINY=[first_layer_print_min[1]] ' +
        'MAXX={first_layer_print_max[0]} MAXY={first_layer_print_max[1]}',
      {},
      {},
      context,
    )
    expect(r.gcode).toBe('MINX=10 MINY=5 MAXX=90 MAXY=45')
    expect(r.unknown).toEqual([])
  })

  it('substitutes first_layer_print_min as a comma-joined pair in the bare, unindexed form', () => {
    const context: SlicerGenerationContext = {
      firstLayerBboxMm: { minXMm: 10, minYMm: 5, maxXMm: 90, maxYMm: 45 },
    }
    const r = substitute('[first_layer_print_min]', {}, {}, context)
    expect(r.gcode).toBe('10,5')
    expect(r.unknown).toEqual([])
  })

  it('leaves first_layer_print_min/max unresolved without a generation context', () => {
    const r = substitute('[first_layer_print_min[0]]')
    expect(r.gcode).toBe('[first_layer_print_min[0]]')
    expect(r.unknown).toEqual(['first_layer_print_min'])
  })

  it('evaluates the {if first_layer_print_min[0] < 50 and first_layer_print_min[1] < 20} conditional true branch', () => {
    const context: SlicerGenerationContext = {
      firstLayerBboxMm: { minXMm: 10, minYMm: 5, maxXMm: 90, maxYMm: 45 },
    }
    const src =
      '{if first_layer_print_min[0] < 50 and first_layer_print_min[1] < 20}small{else}large{endif}'
    const r = substitute(src, {}, {}, context)
    expect(r.gcode).toBe('small')
    expect(r.warnings).toEqual([])
  })

  it('evaluates the {if first_layer_print_min[0] < 50 and first_layer_print_min[1] < 20} conditional else branch', () => {
    const context: SlicerGenerationContext = {
      firstLayerBboxMm: { minXMm: 60, minYMm: 30, maxXMm: 140, maxYMm: 70 },
    }
    const src =
      '{if first_layer_print_min[0] < 50 and first_layer_print_min[1] < 20}small{else}large{endif}'
    const r = substitute(src, {}, {}, context)
    expect(r.gcode).toBe('large')
    expect(r.warnings).toEqual([])
  })

  it('evaluates a conditional on a bare scalar profile variable, e.g. layer_height', () => {
    const src = '{if layer_height < 0.2}THIN{else}THICK{endif}'
    const thin = substitute(src, { layerHeightMm: 0.12 })
    expect(thin.gcode).toBe('THIN')
    expect(thin.warnings).toEqual([])
    const thick = substitute(src, { layerHeightMm: 0.28 })
    expect(thick.gcode).toBe('THICK')
    expect(thick.warnings).toEqual([])
  })

  it('evaluates a conditional on an indexed single-tool scalar variable, e.g. retraction_length[0]', () => {
    const src = '{if retraction_length[0] < 1}SHORT{else}LONG{endif}'
    const short = substitute(src, { retractMm: 0.5 })
    expect(short.gcode).toBe('SHORT')
    const long = substitute(src, { retractMm: 5 })
    expect(long.gcode).toBe('LONG')
  })

  it('evaluates a conditional comparing a string-valued variable to a quoted string literal', () => {
    const src = '{if filament_type == "PETG"}PETG SETTINGS{else}OTHER SETTINGS{endif}'
    const petg = substitute(src, {}, { filamentType: 'PETG' })
    expect(petg.gcode).toBe('PETG SETTINGS')
    expect(petg.warnings).toEqual([])
    const pla = substitute(src, {}, { filamentType: 'PLA' })
    expect(pla.gcode).toBe('OTHER SETTINGS')
    expect(pla.warnings).toEqual([])
  })

  it('leaves a conditional on an unknown identifier unevaluated with the standard warning', () => {
    const src = '{if some_unmapped_setting > 3}A{else}B{endif}'
    const r = substitute(src)
    expect(r.gcode).toBe(src)
    expect(r.warnings).toEqual([
      'The conditional "{if some_unmapped_setting > 3}" could not be evaluated, so the whole ' +
        'block was left in the G-code exactly as written. Review the block in your start ' +
        'G-code, and either fix the condition or replace the block with the lines from the ' +
        'branch you intend to use.',
    ])
  })

  describe('unresolvedVariablesWarning', () => {
    it('produces the exact user-facing text', () => {
      expect(unresolvedVariablesWarning(['foo', 'bar'])).toBe(
        'These slicer variables could not be filled in: foo, bar. ' +
          'They were left exactly as written in the G-code, and a printer macro that reads one ' +
          'of them as a number will fail. Replace each one with a real number in your start ' +
          'G-code, in the profile editor, before printing.',
      )
    })
  })

  it('resolves this real user profile fixture end to end: all eight variables, the bbox conditional (both branches), and the unevaluated bowden-length expression', () => {
    const macro =
      'PRINT_START EXTRUDER=[nozzle_temperature_initial_layer] BED=[bed_temperature_initial_layer_single] ' +
      'MAX_FLOW=[filament_max_volumetric_speed] WALL_SPEED=[outer_wall_speed] WALL_WIDTH=[outer_wall_line_width] ' +
      'BOWDEN_LENGTH=[retraction_length[0]*0.75]\n' +
      '{if first_layer_print_min[0] < 50 and first_layer_print_min[1] < 20}\n' +
      '; small part start\n' +
      '{else}\n' +
      '; large part start\n' +
      '{endif}'
    const p: Partial<PrinterProfile> = { retractMm: 0.8 }
    const f: Partial<FilamentProfile> = {
      nozzleTempC: 230,
      bedTempC: 65,
      maxVolumetricFlowMm3S: 11,
    }
    const smallContext: SlicerGenerationContext = {
      outerWallSpeedMmS: 40,
      outerWallLineWidthMm: 0.45,
      firstLayerBboxMm: { minXMm: 10, minYMm: 5, maxXMm: 40, maxYMm: 15 },
    }
    const expressionWarning =
      'The expression "[retraction_length[0]*0.75]" was left exactly as written in the G-code. ' +
      'This tool does not evaluate slicer arithmetic expressions. Replace the whole expression ' +
      'with the computed number before printing.'
    const small = substitute(macro, p, f, smallContext)
    expect(small.unknown).toEqual([])
    expect(small.warnings).toEqual([expressionWarning])
    expect(small.gcode).toContain(
      'PRINT_START EXTRUDER=230 BED=65 MAX_FLOW=11 WALL_SPEED=40 WALL_WIDTH=0.45 ' +
        'BOWDEN_LENGTH=[retraction_length[0]*0.75]',
    )
    expect(small.gcode).toContain('; small part start')
    expect(small.gcode).not.toContain('; large part start')

    const largeContext: SlicerGenerationContext = {
      ...smallContext,
      firstLayerBboxMm: { minXMm: 60, minYMm: 30, maxXMm: 200, maxYMm: 150 },
    }
    const large = substitute(macro, p, f, largeContext)
    expect(large.unknown).toEqual([])
    expect(large.warnings).toEqual([expressionWarning])
    expect(large.gcode).toContain('; large part start')
    expect(large.gcode).not.toContain('; small part start')
  })

  describe('unevaluated slicer arithmetic expressions', () => {
    it('resolves a plain retraction_length[0] placeholder to retractMm', () => {
      const r = substitute('BOWDEN=[retraction_length[0]]', { retractMm: 0.8 })
      expect(r.gcode).toBe('BOWDEN=0.8')
      expect(r.unknown).toEqual([])
      expect(r.warnings).toEqual([])
    })

    it('leaves an expression referencing retraction_length[0] verbatim and warns, without an unresolved-variable warning', () => {
      const r = substitute('BOWDEN_LENGTH={retraction_length[0]*0.75}', { retractMm: 0.8 })
      expect(r.gcode).toBe('BOWDEN_LENGTH={retraction_length[0]*0.75}')
      expect(r.unknown).toEqual([])
      expect(r.warnings).toEqual([
        'The expression "{retraction_length[0]*0.75}" was left exactly as written in the ' +
          'G-code. This tool does not evaluate slicer arithmetic expressions. Replace the ' +
          'whole expression with the computed number before printing.',
      ])
    })
  })
})
