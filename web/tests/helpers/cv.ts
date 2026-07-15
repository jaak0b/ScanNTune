import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Mat, OpenCv } from '../../src/engine/opencv'
import { rgbaToBgrMat } from '../../src/engine/imageData'
import { analyzeCoupon } from '../../src/engine/couponAnalyzer'
import { asAligned, defaultCouponSpec } from '../../src/engine/types'
import type { AlignedResult, AnalysisOptions } from '../../src/engine/types'
import type { AffineSolverOptions } from '../../src/engine/affineSolver'

// OpenCV.js exports a Promise-valued module, which Vite/Vitest's ESM interop turns into a broken
// thenable namespace. Load it with a native require instead (works under the Vitest node env), the
// same path the browser worker avoids by using loadOpenCv(). Engine functions take cv as a param, so
// tests inject it however works here.
const nodeRequire = createRequire(import.meta.url)

let cvCache: Promise<OpenCv> | null = null
export function getCv(): Promise<OpenCv> {
  if (!cvCache) {
    cvCache = Promise.resolve(nodeRequire('@techstark/opencv-js') as PromiseLike<OpenCv>)
  }
  return cvCache
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PNG = (nodeRequire('pngjs') as { PNG: any }).PNG

export function decodeFixtureBgr(cv: OpenCv, name: string): Mat {
  return decodePngBgr(cv, new URL(`../fixtures/${name}`, import.meta.url))
}

// A real-scan golden JPEG shared with a Playwright flow suite (web/e2e/<flow>/golden).
export function decodeFlowGoldenJpgBgr(cv: OpenCv, flow: string, name: string): Mat {
  return decodeJpgBgr(cv, new URL(`../../e2e/${flow}/golden/${name}`, import.meta.url))
}

// Legacy real-scan PNG fixtures (web/e2e/fixtures); the directory is gone, kept only so the
// specs still referencing the retired fixtures fail on the missing file, not at import.
export function decodeE2eFixtureBgr(cv: OpenCv, name: string): Mat {
  return decodePngBgr(cv, new URL(`../../e2e/fixtures/${name}`, import.meta.url))
}

// The app accepts JPEG scans through createImageBitmap, so the JPEG fixture path mirrors a real upload.
export function decodeJpgFixtureBgr(cv: OpenCv, name: string): Mat {
  return decodeJpgBgr(cv, new URL(`../fixtures/${name}`, import.meta.url))
}

// The wide-gap EM golden scans shared with the Playwright flow suite (web/e2e/flow/golden).
export function decodeGoldenJpgBgr(cv: OpenCv, name: string): Mat {
  return decodeJpgBgr(cv, new URL(`../../e2e/flow/golden/${name}`, import.meta.url))
}

function decodeJpgBgr(cv: OpenCv, url: URL): Mat {
  const jpeg = nodeRequire('jpeg-js') as {
    decode: (
      data: Buffer,
      opts: { useTArray: boolean; maxMemoryUsageInMB: number },
    ) => { data: Uint8Array; width: number; height: number }
  }
  // A 36 MP flatbed scan needs about 1.5 GB of decoder working buffers; 4096 gives headroom for the
  // largest scans the app accepts without capping real fixtures (jpeg-js defaults to 512 MB).
  const img = jpeg.decode(readFileSync(fileURLToPath(url)), { useTArray: true, maxMemoryUsageInMB: 4096 })
  return rgbaToBgrMat(cv, { data: img.data, width: img.width, height: img.height })
}

function decodePngBgr(cv: OpenCv, url: URL): Mat {
  const png = PNG.sync.read(readFileSync(fileURLToPath(url)))
  return rgbaToBgrMat(cv, { data: png.data, width: png.width, height: png.height })
}

// Decodes a PNG from an absolute filesystem path (for the untracked real-scan corpus in Data/).
export function decodePngFileBgr(cv: OpenCv, absolutePath: string): Mat {
  const png = PNG.sync.read(readFileSync(absolutePath))
  return rgbaToBgrMat(cv, { data: png.data, width: png.width, height: png.height })
}

// Image transforms (ports of ScanNTune.Tests/CouponImageTransforms.cs). Each returns a fresh Mat the
// caller deletes.
export function stretchX(cv: OpenCv, src: Mat, factor: number): Mat {
  const dst = new cv.Mat()
  cv.resize(src, dst, new cv.Size(Math.round(src.cols * factor), src.rows), 0, 0, cv.INTER_LINEAR)
  return dst
}

export function shear(cv: OpenCv, src: Mat, degrees: number): Mat {
  const k = Math.tan((degrees * Math.PI) / 180.0)
  const extra = Math.ceil(Math.abs(k) * src.rows) + 4
  const M = cv.matFromArray(2, 3, cv.CV_64F, [1, k, 0, 0, 1, 0])
  const dst = new cv.Mat()
  cv.warpAffine(
    src,
    dst,
    M,
    new cv.Size(src.cols + extra, src.rows),
    cv.INTER_CUBIC,
    cv.BORDER_CONSTANT,
    new cv.Scalar(0, 0, 0, 0),
  )
  M.delete()
  return dst
}

export function flipY(cv: OpenCv, src: Mat): Mat {
  const dst = new cv.Mat()
  cv.flip(src, dst, 1) // flipCode > 0 = mirror about the y-axis (FlipMode.Y)
  return dst
}

export function rotate(cv: OpenCv, src: Mat, degrees: number): Mat {
  const dst = new cv.Mat()
  if (degrees === 90) cv.rotate(src, dst, cv.ROTATE_90_CLOCKWISE)
  else if (degrees === 180) cv.rotate(src, dst, cv.ROTATE_180)
  else if (degrees === 270) cv.rotate(src, dst, cv.ROTATE_90_COUNTERCLOCKWISE)
  else src.copyTo(dst)
  return dst
}

export type Transform = (cv: OpenCv, m: Mat) => Mat

// Decode TestData_2solid.png, apply the transforms in order, analyze, and clean up every Mat. The
// fixture always aligns, so this narrows to an AlignedResult for the tests that read its measurement.
export async function analyzeFixture(
  transforms: Transform[],
  options?: Partial<AnalysisOptions>,
  solverOptions?: AffineSolverOptions,
): Promise<AlignedResult> {
  const cv = await getCv()
  let mat = decodeFixtureBgr(cv, 'TestData_2solid.png')
  const created: Mat[] = [mat]
  for (const t of transforms) {
    const next = t(cv, mat)
    created.push(next)
    mat = next
  }
  try {
    return asAligned(analyzeCoupon(cv, mat, { coupon: defaultCouponSpec(), ...options }, solverOptions))
  } finally {
    for (const m of created) m.delete()
  }
}

export function blankBgr(cv: OpenCv, size = 600): Mat {
  return new cv.Mat(size, size, cv.CV_8UC3, new cv.Scalar(255, 255, 255, 0))
}

export function blankGray(cv: OpenCv, size = 400, value = 255): Mat {
  return new cv.Mat(size, size, cv.CV_8UC1, new cv.Scalar(value))
}

// A filled card rectangle (long side 856 px) on a plain background, optionally portrait or rotated.
export function syntheticCard(
  cv: OpenCv,
  bg: number,
  card: number,
  portrait: boolean,
  rotationDeg: number,
): Mat {
  const longPx = 856
  const shortPx = 540
  const w = portrait ? shortPx : longPx
  const h = portrait ? longPx : shortPx
  const image = new cv.Mat(1120, 1220, cv.CV_8UC1, new cv.Scalar(bg))
  const cx = image.cols / 2.0
  const cy = image.rows / 2.0
  const hw = w / 2.0
  const hh = h / 2.0
  const a = (rotationDeg * Math.PI) / 180.0
  const ca = Math.cos(a)
  const sa = Math.sin(a)
  const corners: Array<[number, number]> = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ]
  const pts: number[] = []
  for (const [dx, dy] of corners) {
    pts.push(Math.round(cx + dx * ca - dy * sa), Math.round(cy + dx * sa + dy * ca))
  }
  const ptsMat = cv.matFromArray(4, 1, cv.CV_32SC2, pts)
  const polys = new cv.MatVector()
  polys.push_back(ptsMat)
  cv.fillPoly(image, polys, new cv.Scalar(card), cv.LINE_4)
  ptsMat.delete()
  polys.delete()
  return image
}
