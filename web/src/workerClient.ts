import * as Comlink from 'comlink'
import type { AnalysisApi, ScanProcessing } from './worker/analysis.worker'
import type { CouponSpec, ScaleReferenceResult } from './engine/types'

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

export async function measureCardScan(
  bytes: Uint8Array,
  knownLongSideMm: number,
  nominalDpi: number,
): Promise<ScaleReferenceResult> {
  const b = bytes.slice().buffer
  return getApi().measureCardScan(Comlink.transfer(b, [b]), knownLongSideMm, nominalDpi)
}

export type { ScanProcessing }
