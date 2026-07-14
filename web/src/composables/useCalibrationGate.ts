import { computed } from 'vue'
import { useCalibration } from '../stores/useCalibration'

/**
 * The scanner-calibration requirement shared by the scan-analyzing flow pages: the calibration
 * store, whether a calibration exists, and the status line shown in the calibrate step.
 */
export function useCalibrationGate() {
  const calibration = useCalibration()
  const isCalibrated = computed(() => calibration.calibration !== null)
  const calibrationLine = computed(() =>
    isCalibrated.value
      ? `${Math.round(calibration.calibration!.dpi)} dpi`
      : 'Not calibrated',
  )
  return { calibration, isCalibrated, calibrationLine }
}
