import * as Comlink from 'comlink'
import type { AnalysisApi, TwoScanResponse } from './worker/analysis.worker'
import type { AnalysisOptions, ScaleReferenceResult } from './engine/types'

// Lazily create the analysis worker (which pulls in OpenCV.js) only when the user first analyzes, so
// the wasm is not loaded on the initial page paint.
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

export async function analyzeTwoScans(
  bytes1: Uint8Array,
  bytes2: Uint8Array,
  options: AnalysisOptions,
): Promise<TwoScanResponse> {
  const b1 = bytes1.slice().buffer
  const b2 = bytes2.slice().buffer
  return getApi().analyzeTwoScans(
    Comlink.transfer(b1, [b1]),
    Comlink.transfer(b2, [b2]),
    options,
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

export type { TwoScanResponse }
