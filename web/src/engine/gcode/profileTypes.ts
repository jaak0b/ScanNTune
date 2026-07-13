export type Firmware = 'Klipper' | 'Marlin' | 'RepRapFirmware'

export interface FilamentProfile {
  id: string
  name: string
  filamentType: string
  filamentDiameterMm: number
  nozzleTempC: number
  bedTempC: number
  chamberTempC: number
  /** Extrusion multiplier / flow ratio the filament prints with; scales every extrusion
   *  move. The extrusion multiplier test itself always prints at 1.0 so its result stays
   *  the absolute value to set. */
  extrusionMultiplier: number
  /** The filament's maximum volumetric flow in mm^3/s; 0 means not configured, and the
   *  high-flow warnings then judge against a conservative default instead. */
  maxVolumetricFlowMm3S: number
}

export interface PrinterProfile {
  id: string
  name: string
  firmware: Firmware
  bedWidthMm: number
  bedDepthMm: number
  nozzleDiameterMm: number
  filaments: FilamentProfile[]
  selectedFilamentId: string | null
  travelSpeedMmS: number
  /** Speed cap for everything printed on the first layer, for bed adhesion. */
  firstLayerSpeedMmS: number
  printAccelMmS2: number
  /** Klipper square corner velocity, Marlin XY jerk, in mm/s. */
  squareCornerVelocityMmS: number
  layerHeightMm: number
  retractMm: number
  retractSpeedMmS: number
  startGcode: string
  pauseGcode: string
  endGcode: string
}

export function defaultFilamentProfile(): FilamentProfile {
  return {
    id: '',
    name: 'Default',
    filamentType: 'PLA',
    filamentDiameterMm: 1.75,
    nozzleTempC: 210,
    bedTempC: 60,
    chamberTempC: 0,
    extrusionMultiplier: 1,
    maxVolumetricFlowMm3S: 0,
  }
}

export function defaultPrinterProfile(): PrinterProfile {
  return {
    id: '',
    name: 'My printer',
    firmware: 'Klipper',
    bedWidthMm: 220,
    bedDepthMm: 220,
    nozzleDiameterMm: 0.4,
    filaments: [defaultFilamentProfile()],
    selectedFilamentId: null,
    travelSpeedMmS: 150,
    firstLayerSpeedMmS: 30,
    printAccelMmS2: 3000,
    squareCornerVelocityMmS: 5,
    layerHeightMm: 0.2,
    retractMm: 0.8,
    retractSpeedMmS: 35,
    startGcode:
      'M140 S[first_layer_bed_temperature]\n' +
      'M104 S[first_layer_temperature]\n' +
      'M190 S[first_layer_bed_temperature]\n' +
      'M109 S[first_layer_temperature]\n' +
      'G28\n' +
      'G90',
    pauseGcode: 'PAUSE',
    endGcode: 'M104 S0\nM140 S0\nG91\nG1 Z10 F600\nG90\nM84',
  }
}
