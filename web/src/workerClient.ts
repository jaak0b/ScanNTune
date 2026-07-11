import * as Comlink from 'comlink'
import type { AnalysisApi, EmProcessing, PaProcessing, ScanProcessing } from './worker/analysis.worker'
import type { CouponSpec, ScaleReferenceResult } from './engine/types'
import type { ScaleReference } from './engine/scannerCalibration'
import type { PaProgressCallback, PaTestSpec } from './engine/pa/types'
import type { EmProgressCallback, EmTestSpec } from './engine/em/types'

// Lazily create the analysis worker (which pulls in OpenCV.js) only when the user first analyzes a
// scan, so the wasm is not loaded on the initial page paint.
let api: Comlink.Remote<AnalysisApi> | null = null

function getApi(): Comlink.Remote<AnalysisApi> {
  if (!api) {
    const worker = new Worker(new URL('./worker/analysis.worker.ts', import.meta.url), {
      type: 'module',
    })
    api = Comlink.wrap<AnalysisApi>(worker)
  }
  return api
}

// Analyse one scan the moment it is uploaded: detect rings, map the grid, fit the affine, and render
// the overlay + threshold mask. Reference-free; the pxPerMm reference is applied on the main thread
// when the results are reconciled.
export async function analyzeScan(bytes: Uint8Array, coupon: CouponSpec): Promise<ScanProcessing> {
  const b = bytes.slice().buffer
  return getApi().analyzeScan(Comlink.transfer(b, [b]), coupon)
}

// Analyse one pressure-advance coupon scan: align the fiducials, profile the test lines, and render
// the score overlay, all inside the worker.
export async function analyzePaScan(
  bytes: Uint8Array,
  spec: PaTestSpec,
  onProgress?: PaProgressCallback,
): Promise<PaProcessing> {
  const b = bytes.slice().buffer
  return getApi().analyzePaScan(
    Comlink.transfer(b, [b]),
    spec,
    onProgress ? Comlink.proxy(onProgress) : undefined,
  )
}

// Analyse one extrusion-multiplier coupon scan: align the fiducials, measure the comb gaps, and
// render the block overlay, all inside the worker.
export async function analyzeEmScan(
  bytes: Uint8Array,
  spec: EmTestSpec,
  scanPxPerMm: ScaleReference,
  onProgress?: EmProgressCallback,
): Promise<EmProcessing> {
  const b = bytes.slice().buffer
  return getApi().analyzeEmScan(
    Comlink.transfer(b, [b]),
    spec,
    scanPxPerMm,
    onProgress ? Comlink.proxy(onProgress) : undefined,
  )
}

export async function measureCardScan(
  bytes: Uint8Array,
  knownLongSideMm: number,
  nominalDpi: number,
): Promise<ScaleReferenceResult> {
  const b = bytes.slice().buffer
  return getApi().measureCardScan(Comlink.transfer(b, [b]), knownLongSideMm, nominalDpi)
}

export type { EmProcessing, PaProcessing, ScanProcessing }
