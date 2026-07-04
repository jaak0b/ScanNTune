import * as Comlink from 'comlink'
import { loadOpenCv } from '../engine/opencv'
import type { Mat, OpenCv } from '../engine/opencv'
import { analyzeCoupon } from '../engine/couponAnalyzer'
import { measureCard } from '../engine/cardEdgeMeasurer'
import { combineScans } from '../engine/scanCombiner'
import { renderOverlayMat, renderDetectionOverlayMat } from '../engine/overlayRenderer'
import { ScanAnalysisError } from '../engine/types'
import type { AnalysisOptions, CalibrationResult, ScaleReferenceResult, TwoScanResult } from '../engine/types'
import { decodeToBgr, matToImageBitmap } from './decode'

// The CV pipeline runs here, off the main thread, so the UI never freezes during analysis.

export interface TwoScanSuccess {
  ok: true
  result: TwoScanResult
  overlayA: ImageBitmap
  overlayB: ImageBitmap
}

export interface ScanFailure {
  ok: false
  isFirst: boolean
  ringCount: number
  message: string
  overlay: ImageBitmap | null
}

export type TwoScanResponse = TwoScanSuccess | ScanFailure

type OneResult = { ok: true; result: CalibrationResult } | { ok: false; error: ScanAnalysisError }

function analyzeOne(cv: OpenCv, image: Mat, options: AnalysisOptions): OneResult {
  try {
    return { ok: true, result: analyzeCoupon(cv, image, options) }
  } catch (e) {
    if (e instanceof ScanAnalysisError) return { ok: false, error: e }
    throw e
  }
}

async function renderOverlayBitmap(cv: OpenCv, image: Mat, result: CalibrationResult): Promise<ImageBitmap> {
  const mat = renderOverlayMat(cv, image, result)
  try {
    return await matToImageBitmap(cv, mat)
  } finally {
    mat.delete()
  }
}

async function failureResponse(
  cv: OpenCv,
  image: Mat,
  error: ScanAnalysisError,
  isFirst: boolean,
): Promise<ScanFailure> {
  let overlay: ImageBitmap | null = null
  if (error.detectedRings.length > 0) {
    const mat = renderDetectionOverlayMat(cv, image, error.detectedRings)
    try {
      overlay = await matToImageBitmap(cv, mat)
    } finally {
      mat.delete()
    }
  }
  const response: ScanFailure = {
    ok: false,
    isFirst,
    ringCount: error.detectedRings.length,
    message: error.message,
    overlay,
  }
  return overlay ? Comlink.transfer(response, [overlay]) : response
}

async function analyzeTwoScans(
  bytes1: ArrayBuffer,
  bytes2: ArrayBuffer,
  options: AnalysisOptions,
): Promise<TwoScanResponse> {
  const cv = await loadOpenCv()
  const img1 = await decodeToBgr(cv, bytes1)
  const img2 = await decodeToBgr(cv, bytes2)
  try {
    const a = analyzeOne(cv, img1, options)
    if (!a.ok) return await failureResponse(cv, img1, a.error, true)
    const b = analyzeOne(cv, img2, options)
    if (!b.ok) return await failureResponse(cv, img2, b.error, false)

    const result = combineScans(a.result, b.result)
    const overlayA = await renderOverlayBitmap(cv, img1, a.result)
    const overlayB = await renderOverlayBitmap(cv, img2, b.result)
    const response: TwoScanSuccess = { ok: true, result, overlayA, overlayB }
    return Comlink.transfer(response, [overlayA, overlayB])
  } finally {
    img1.delete()
    img2.delete()
  }
}

async function measureCardScan(
  bytes: ArrayBuffer,
  knownLongSideMm: number,
  nominalDpi: number,
): Promise<ScaleReferenceResult> {
  const cv = await loadOpenCv()
  const img = await decodeToBgr(cv, bytes)
  try {
    return measureCard(cv, img, knownLongSideMm, nominalDpi)
  } finally {
    img.delete()
  }
}

const api = { analyzeTwoScans, measureCardScan }
export type AnalysisApi = typeof api

Comlink.expose(api)
