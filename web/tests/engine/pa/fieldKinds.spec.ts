import { describe, expect, it } from 'vitest'
import { FIELD_KINDS } from '../../../src/engine/pa/slicerImport'
import { defaultFilamentProfile, defaultPrinterProfile } from '../../../src/engine/pa/types'

const PRINTER_FIELDS = new Set([
  'firmware',
  'bedWidthMm',
  'bedDepthMm',
  'nozzleDiameterMm',
  'retractMm',
  'retractSpeedMmS',
  'printAccelMmS2',
  'squareCornerVelocityMmS',
  'startGcode',
  'pauseGcode',
  'endGcode',
])

const FILAMENT_FIELDS = new Set([
  'filamentType',
  'filamentDiameterMm',
  'nozzleTempC',
  'bedTempC',
  'chamberTempC',
  'extrusionMultiplier',
  'maxVolumetricFlowMm3S',
])

describe('FIELD_KINDS', () => {
  it('classifies every mapped printer and filament field', () => {
    // id, name, and the filament list itself aren't slicer-import targets; layerHeightMm,
    // travelSpeedMmS, and firstLayerSpeedMmS are deliberately excluded (process/print
    // settings that slicer machine or filament presets don't carry, so import never touches
    // them); every other PrinterProfile and FilamentProfile key must be classified.
    const skip = new Set([
      'id',
      'name',
      'filaments',
      'selectedFilamentId',
      'layerHeightMm',
      'travelSpeedMmS',
      'firstLayerSpeedMmS',
    ])
    const mappedKeys = [
      ...Object.keys(defaultPrinterProfile()),
      ...Object.keys(defaultFilamentProfile()),
    ].filter((k) => !skip.has(k))
    for (const key of mappedKeys) {
      expect(FIELD_KINDS).toHaveProperty(key)
    }
  })

  it('agrees with the expected printer/filament split', () => {
    for (const [field, kind] of Object.entries(FIELD_KINDS)) {
      if (PRINTER_FIELDS.has(field)) expect(kind).toBe('printer')
      else if (FILAMENT_FIELDS.has(field)) expect(kind).toBe('filament')
      else throw new Error(`Unexpected FIELD_KINDS entry: ${field}`)
    }
  })
})
