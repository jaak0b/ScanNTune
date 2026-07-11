import * as Comlink from 'comlink'
import { loadOpenCv } from '../engine/opencv'
import type { Mat, OpenCv } from '../engine/opencv'
import { analyzeCoupon } from '../engine/couponAnalyzer'
import { measureCard } from '../engine/cardEdgeMeasurer'
import { renderOverlayMat, renderDetectionOverlayMat, contentRect } from '../engine/overlayRenderer'
import { asAligned } from '../engine/types'
import type {
  AlignedResult,
  CalibrationResult,
  CouponSpec,
  DetectedRing,
  Orientation,
  ScaleReferenceResult,
} from '../engine/types'
import { analyzePaCoupon } from '../engine/pa/paAnalyzer'
import { renderPaOverlayMat } from '../engine/pa/paOverlayRenderer'
import type { PaAlignment } from '../engine/pa/fiducialAligner'
import type { PaProgressCallback, PaResult, PaTestSpec } from '../engine/pa/types'
import { analyzeEmCoupon } from '../engine/em/emAnalyzer'
import type { EmResult } from '../engine/em/emAnalyzer'
import { renderEmOverlayMat } from '../engine/em/emOverlayRenderer'
import type { EmAlignment } from '../engine/em/fiducialAligner'
import type { EmProgressCallback, EmTestSpec } from '../engine/em/types'
import type { ScaleReference } from '../engine/scannerCalibration'
import { decodeToBgr, matToImageBitmap, grayMatToImageBitmap } from './decode'

// The CV pipeline runs here, off the main thread, so the UI never freezes during analysis. The worker
// only ever analyses ONE scan (analyzeScan): decode, detect, map, fit, and render the two card images.
// Reconciling scans into a printer result is pure arithmetic and runs on the main thread, so there is
// no second worker round-trip.

/**
 * The outcome of analysing one scan: the always-present CalibrationResult (its measurement is null
 * when the scan couldn't be aligned) plus the two images the card toggles between, cropped to the
 * same frame. Only a genuinely unreadable image rejects; a misaligned scan resolves normally.
 */
export interface ScanProcessing {
  result: CalibrationResult
  overlay: ImageBitmap
  mask: ImageBitmap | null
}

async function analyzeScan(bytes: ArrayBuffer, coupon: CouponSpec): Promise<ScanProcessing> {
  const cv = await loadOpenCv()
  const img = await decodeToBgr(cv, bytes)
  const maskHolder: { mask?: Mat } = {}
  try {
    // pxPerMm is deferred to the main-thread reconcile, so a DPI change never re-runs this CV pass.
    const result = analyzeCoupon(cv, img, { coupon, pxPerMm: null }, undefined, maskHolder)
    const overlay = result.aligned
      ? await renderOverlayBitmap(cv, img, asAligned(result))
      : await renderDetectionBitmap(cv, img, result.rings)
    let mask: ImageBitmap | null = null
    try {
      mask = maskHolder.mask
        ? await renderMaskBitmap(cv, maskHolder.mask, result.rings, result.orientation)
        : null
    } catch (e) {
      overlay.close() // don't orphan the overlay if the mask render fails
      throw e
    }
    const transfer: Transferable[] = mask ? [overlay, mask] : [overlay]
    return Comlink.transfer({ result, overlay, mask }, transfer)
  } finally {
    maskHolder.mask?.delete()
    img.delete()
  }
}

async function renderOverlayBitmap(cv: OpenCv, image: Mat, result: AlignedResult): Promise<ImageBitmap> {
  const mat = renderOverlayMat(cv, image, result)
  try {
    return await matToImageBitmap(cv, mat)
  } finally {
    mat.delete()
  }
}

async function renderDetectionBitmap(cv: OpenCv, image: Mat, rings: DetectedRing[]): Promise<ImageBitmap> {
  const mat = renderDetectionOverlayMat(cv, image, rings)
  try {
    return await matToImageBitmap(cv, mat)
  } finally {
    mat.delete()
  }
}

// Crop the threshold mask to the same content rectangle the overlay used, so the Scan/Threshold toggle
// shows the same frame at the same size. With no rings the whole mask is shown.
async function renderMaskBitmap(
  cv: OpenCv,
  mask: Mat,
  rings: DetectedRing[],
  orientation: Orientation | null,
): Promise<ImageBitmap> {
  if (rings.length === 0) return await grayMatToImageBitmap(cv, mask)
  const r = contentRect(rings, orientation, mask.cols, mask.rows)
  const roi = mask.roi(new cv.Rect(r.x, r.y, r.width, r.height))
  try {
    return await grayMatToImageBitmap(cv, roi)
  } finally {
    roi.delete()
  }
}

/**
 * The outcome of analysing one pressure-advance coupon scan: the PaResult plus an overlay showing
 * each measured line tinted by its score and the best line highlighted. When the coupon could not
 * be aligned the overlay is the plain decoded scan, so the UI always has an image to show.
 */
export interface PaProcessing {
  result: PaResult
  overlay: ImageBitmap
}

// Wraps the caller's (Comlink-proxied, fire-and-forget) progress callback: forwards each stage event
// without awaiting it, and logs how long each stage took when the next one starts.
function stageReporter<P extends { stage: string }>(
  label: string,
  onProgress?: (progress: P) => void,
): {
  report: (progress: P) => void
  finish: () => void
} {
  let lastStage: string | null = null
  let lastStart = 0
  const logStage = () => {
    if (lastStage) console.info(`${label} analyze: ${lastStage} ${Math.round(performance.now() - lastStart)} ms`)
  }
  return {
    report: (p) => {
      if (p.stage !== lastStage) {
        logStage()
        lastStage = p.stage
        lastStart = performance.now()
      }
      if (onProgress) {
        void Promise.resolve(onProgress(p)).catch((e) => console.error(`${label} progress callback failed`, e))
      }
    },
    finish: logStage,
  }
}

async function analyzePaScan(
  bytes: ArrayBuffer,
  spec: PaTestSpec,
  onProgress?: PaProgressCallback,
): Promise<PaProcessing> {
  const { report, finish } = stageReporter('PA', onProgress)
  const cv = await loadOpenCv()
  report({ stage: 'decode' })
  const img = await decodeToBgr(cv, bytes)
  try {
    const holder: { alignment?: PaAlignment } = {}
    const result = analyzePaCoupon(cv, img, spec, holder, report)
    report({ stage: 'render' })
    const overlay = holder.alignment?.success
      ? await renderPaOverlayBitmap(cv, img, holder.alignment, spec, result)
      : await matToImageBitmap(cv, img)
    finish()
    return Comlink.transfer({ result, overlay }, [overlay])
  } finally {
    img.delete()
  }
}

async function renderPaOverlayBitmap(
  cv: OpenCv,
  image: Mat,
  alignment: PaAlignment,
  spec: PaTestSpec,
  result: PaResult,
): Promise<ImageBitmap> {
  const mat = renderPaOverlayMat(cv, image, alignment, spec, result)
  try {
    return await matToImageBitmap(cv, mat)
  } finally {
    mat.delete()
  }
}

/**
 * The outcome of analysing one extrusion-multiplier coupon scan: the EmResult plus an overlay
 * tinting each measured test block by its agreement with the overall estimate. When the coupon
 * could not be aligned the overlay is the plain decoded scan, so the UI always has an image to show.
 */
export interface EmProcessing {
  result: EmResult
  overlay: ImageBitmap
}

async function analyzeEmScan(
  bytes: ArrayBuffer,
  spec: EmTestSpec,
  scanPxPerMm: ScaleReference,
  onProgress?: EmProgressCallback,
): Promise<EmProcessing> {
  const { report, finish } = stageReporter('EM', onProgress)
  const cv = await loadOpenCv()
  report({ stage: 'decode' })
  const img = await decodeToBgr(cv, bytes)
  try {
    const holder: { alignment?: EmAlignment } = {}
    const result = analyzeEmCoupon(cv, img, spec, scanPxPerMm, holder, report)
    report({ stage: 'render' })
    const overlay = holder.alignment?.success
      ? await renderEmOverlayBitmap(cv, img, holder.alignment, spec, result)
      : await matToImageBitmap(cv, img)
    finish()
    return Comlink.transfer({ result, overlay }, [overlay])
  } finally {
    img.delete()
  }
}

async function renderEmOverlayBitmap(
  cv: OpenCv,
  image: Mat,
  alignment: EmAlignment,
  spec: EmTestSpec,
  result: EmResult,
): Promise<ImageBitmap> {
  const mat = renderEmOverlayMat(cv, image, alignment, spec, result)
  try {
    return await matToImageBitmap(cv, mat)
  } finally {
    mat.delete()
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

const api = { analyzeScan, analyzePaScan, analyzeEmScan, measureCardScan }
export type AnalysisApi = typeof api

Comlink.expose(api)
