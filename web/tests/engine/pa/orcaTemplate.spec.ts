import { describe, expect, it } from 'vitest'
import { evaluateCondition, evaluateTemplate } from '../../../src/engine/pa/orcaTemplate'

const resolve = (name: string): string | null => {
  if (name === 'first_layer_temperature' || name === 'temperature') return '210'
  if (name === 'first_layer_bed_temperature') return '60'
  return null
}

describe('evaluateCondition', () => {
  it('treats the single tool as extruder 0', () => {
    expect(evaluateCondition('is_extruder_used[0]')).toBe(true)
    expect(evaluateCondition('is_extruder_used[1]')).toBe(false)
    expect(evaluateCondition('is_extruder_used[initial_tool]')).toBe(true)
  })

  it('evaluates comparisons and boolean logic', () => {
    expect(evaluateCondition('initial_tool == 0')).toBe(true)
    expect(evaluateCondition('current_extruder != 0')).toBe(false)
    expect(evaluateCondition('is_extruder_used[0] and not is_extruder_used[1]')).toBe(true)
    expect(evaluateCondition('(is_extruder_used[1] or is_extruder_used[0])')).toBe(true)
    expect(evaluateCondition('1 < 2')).toBe(true)
  })

  it('returns null for anything outside the grammar', () => {
    expect(evaluateCondition('some_unknown_flag > 3')).toBeNull()
    expect(evaluateCondition('is_extruder_used')).toBeNull()
    expect(evaluateCondition('1 +')).toBeNull()
    expect(evaluateCondition('is_extruder_used[foo]')).toBeNull()
  })
})

describe('evaluateCondition with a context resolver', () => {
  const bbox = { first_layer_print_min: [10, 5], first_layer_print_max: [90, 45] } as const
  const resolveIndexed = (name: string, idx?: number): string | null => {
    const vec = (bbox as Record<string, readonly number[]>)[name]
    if (vec === undefined || idx === undefined) return null
    return String(vec[idx])
  }

  it('resolves a context-provided indexed variable numerically', () => {
    expect(evaluateCondition('first_layer_print_min[0] < 50', resolveIndexed)).toBe(true)
    expect(evaluateCondition('first_layer_print_min[1] < 3', resolveIndexed)).toBe(false)
  })

  it('evaluates the compound bbox condition true branch', () => {
    expect(
      evaluateCondition(
        'first_layer_print_min[0] < 50 and first_layer_print_min[1] < 20',
        resolveIndexed,
      ),
    ).toBe(true)
  })

  it('evaluates the compound bbox condition false branch', () => {
    const largeResolve = (name: string, idx?: number): string | null => {
      const vec: Record<string, readonly number[]> = {
        first_layer_print_min: [60, 30],
        first_layer_print_max: [200, 150],
      }
      const v = vec[name]
      if (v === undefined || idx === undefined) return null
      return String(v[idx])
    }
    expect(
      evaluateCondition(
        'first_layer_print_min[0] < 50 and first_layer_print_min[1] < 20',
        largeResolve,
      ),
    ).toBe(false)
  })

  it('is unevaluable when no resolver is given for a context variable (defaults to resolving nothing)', () => {
    expect(evaluateCondition('first_layer_print_min[0] < 50')).toBeNull()
  })

  it('is unevaluable when the resolver has no value for that index', () => {
    const alwaysNull = () => null
    expect(evaluateCondition('first_layer_print_min[0] < 50', alwaysNull)).toBeNull()
  })

  it('resolves a bare scalar variable through the same generic resolver', () => {
    const resolveLayerHeight = (name: string): string | null =>
      name === 'layer_height' ? '0.2' : null
    expect(evaluateCondition('layer_height < 0.3', resolveLayerHeight)).toBe(true)
    expect(evaluateCondition('layer_height < 0.1', resolveLayerHeight)).toBe(false)
  })

  it('resolves an indexed reference to a single-tool scalar variable to its scalar value', () => {
    const resolveRetraction = (name: string, idx?: number): string | null =>
      name === 'retraction_length' && idx !== undefined ? '0.8' : null
    expect(evaluateCondition('retraction_length[0] < 1', resolveRetraction)).toBe(true)
    expect(evaluateCondition('retraction_length[0] < 0.5', resolveRetraction)).toBe(false)
  })

  it('is unevaluable for an identifier the resolver genuinely does not know', () => {
    const resolveNothing = (): string | null => null
    expect(evaluateCondition('unknown_setting_name > 3', resolveNothing)).toBeNull()
  })

  it('compares a string-valued variable to a quoted string literal', () => {
    const resolveFilamentType = (name: string): string | null =>
      name === 'filament_type' ? 'PETG' : null
    expect(evaluateCondition('filament_type == "PETG"', resolveFilamentType)).toBe(true)
    expect(evaluateCondition('filament_type == "PLA"', resolveFilamentType)).toBe(false)
    expect(evaluateCondition('filament_type != "PLA"', resolveFilamentType)).toBe(true)
  })

  it('is unevaluable when a string variable is compared against a numeric literal (type mismatch)', () => {
    const resolveFilamentType = (name: string): string | null =>
      name === 'filament_type' ? 'PETG' : null
    expect(evaluateCondition('filament_type == 5', resolveFilamentType)).toBeNull()
    expect(evaluateCondition('filament_type < 5', resolveFilamentType)).toBeNull()
  })
})

describe('evaluateTemplate', () => {
  it('resolves indexed settings regardless of index', () => {
    const r = evaluateTemplate('{first_layer_temperature[initial_tool]}/[temperature[3]]', resolve)
    expect(r.text).toBe('210/210')
    expect(r.unknown).toEqual([])
  })

  it('drops false branches and keeps true ones', () => {
    const r = evaluateTemplate('{if is_extruder_used[1]}A{else}B{endif}', resolve)
    expect(r.text).toBe('B')
  })

  it('evaluates a context-indexed conditional inside evaluateTemplate', () => {
    const resolveWithBbox = (name: string, idx?: number): string | null => {
      if (name === 'first_layer_print_min' && idx !== undefined) {
        return String([10, 5][idx])
      }
      return resolve(name)
    }
    const src =
      '{if first_layer_print_min[0] < 50 and first_layer_print_min[1] < 20}small{else}large{endif}'
    const r = evaluateTemplate(src, resolveWithBbox)
    expect(r.text).toBe('small')
    expect(r.warnings).toEqual([])
  })
})
