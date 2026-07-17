import { onBeforeUnmount, ref, shallowRef } from 'vue'

/**
 * Runs one scan analysis under a page's analyzing lock: clears the previous error, locks,
 * captures a thrown failure into the error ref (and logs it under `errorLabel`), and always
 * releases the lock before running the optional `settle` cleanup.
 */
export async function runGuardedAnalysis(
  state: { analyzing: { value: boolean }; error: { value: string } },
  errorLabel: string,
  fn: () => Promise<void>,
  settle?: () => void,
): Promise<void> {
  state.analyzing.value = true
  state.error.value = ''
  try {
    await fn()
  } catch (err) {
    console.error(errorLabel, err)
    state.error.value = err instanceof Error ? err.message : String(err)
  } finally {
    state.analyzing.value = false
    settle?.()
  }
}

export interface ScanAnalysisOptions {
  /** How many scan files the analysis accepts at most. */
  maxFiles: number
  /** Hint shown when a pick exceeds `maxFiles`; the overflow files are not added. */
  tooManyHint: string
  /** Label for the console log when an analysis throws. */
  errorLabel: string
  /** Extra guard evaluated on every pick; a pick is ignored while it returns false. */
  canPick?: () => boolean
  /** Called whenever the current result is cleared, for page-held result snapshots. */
  onReset?: () => void
  /** Called after every analysis settles (success or failure), for progress cleanup. */
  onSettled?: () => void
}

/**
 * The scan-upload step shared by the flow pages that collect scan files and analyze them as a
 * batch: the picked files, the pick hint, the analyzing/started locks, the error text, the
 * result with its overlay lifecycle (bitmaps closed on reset and unmount), the zoom dialog
 * state, and the guarded analyze wrapper.
 */
export function useScanAnalysis<P extends { overlays: ImageBitmap[] }>(
  options: ScanAnalysisOptions,
) {
  const scanFiles = ref<File[]>([])
  const scanPickHint = ref('')
  const analyzing = ref(false)
  // True once an analysis was started; the per-file delete buttons give way to the
  // "Start over" reset until the step is cleared again.
  const analysisStarted = ref(false)
  const scanError = ref('')
  const processing = shallowRef<P | null>(null)
  // The overlay a scan card was clicked on, shown full size in a dialog; null when closed.
  const zoomed = shallowRef<ImageBitmap | null>(null)

  function resetProcessing(): void {
    zoomed.value = null
    processing.value?.overlays.forEach((bitmap: ImageBitmap) => bitmap.close())
    processing.value = null
    options.onReset?.()
  }

  onBeforeUnmount(resetProcessing)

  function onPickScans(e: Event): void {
    const input = e.target as HTMLInputElement
    const picked = Array.from(input.files ?? [])
    // Clear the input so picking the same file again still fires change.
    input.value = ''
    // A disabled input still receives drops in some browsers; a running or finished analysis
    // must not be doubled up, and the page's own pick guard is honoured.
    if (
      picked.length === 0 ||
      analyzing.value ||
      analysisStarted.value ||
      !(options.canPick?.() ?? true)
    )
      return
    scanPickHint.value = ''
    const room = options.maxFiles - scanFiles.value.length
    if (picked.length > room) scanPickHint.value = options.tooManyHint
    scanFiles.value = [...scanFiles.value, ...picked.slice(0, Math.max(0, room))]
  }

  function removeScan(index: number): void {
    if (analyzing.value || analysisStarted.value) return
    scanFiles.value = scanFiles.value.filter((_, i) => i !== index)
    scanPickHint.value = ''
  }

  // Clears the whole scan step (files, result, overlays, and errors) so new scans can be
  // picked and analyzed from a clean slate.
  function startOver(): void {
    if (analyzing.value) return
    resetProcessing()
    scanFiles.value = []
    scanPickHint.value = ''
    scanError.value = ''
    analysisStarted.value = false
  }

  // Runs `fn` as the analysis: clears the previous result first and lands the returned
  // processing under the guarded lock, with failures surfaced in `scanError`.
  async function analyzeWith(fn: () => Promise<P>): Promise<void> {
    analysisStarted.value = true
    resetProcessing()
    await runGuardedAnalysis(
      { analyzing, error: scanError },
      options.errorLabel,
      async () => {
        processing.value = await fn()
      },
      options.onSettled,
    )
  }

  return {
    scanFiles,
    scanPickHint,
    analyzing,
    analysisStarted,
    scanError,
    processing,
    zoomed,
    resetProcessing,
    onPickScans,
    removeScan,
    startOver,
    analyzeWith,
  }
}
