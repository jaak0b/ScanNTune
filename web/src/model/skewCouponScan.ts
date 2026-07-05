import { markRaw } from 'vue'
import type { CalibrationResult, ClipSide, Plane } from '../engine/types'
import type { ScanProcessing } from '../workerClient'

export enum ScanState {
  /** Uploaded, analysis not finished yet. */
  Pending,
  /** The image could not be decoded/read at all. */
  Unreadable,
  /** Analysed, but the coupon grid could not be aligned. */
  Misaligned,
  /** Aligned, but the plane-ID diagonals were not read, so it can't be assigned to a plane. */
  Unlabeled,
  /** Aligned and labelled with a plane: ready to feed the Analyze math. */
  Measured,
}

// One uploaded picture and the outcome of processing it. Owns its rendered images (overlay + threshold
// mask) so the Results page can reuse them and disposal is one call. Everything the card shows is a
// getter off `result`, so there is a single source of truth per scan.
export class SkewCouponScan {
  result: CalibrationResult | null = null
  error: string | null = null
  overlay: ImageBitmap | null = null
  mask: ImageBitmap | null = null

  constructor(
    readonly id: number,
    readonly fileName: string,
    readonly bytes: Uint8Array,
  ) {}

  // Store the worker's outcome. Bitmaps are marked raw so Vue's reactive proxy never wraps them (a
  // proxied ImageBitmap fails the canvas drawImage brand check). Re-processing releases the previous
  // outcome's bitmaps first, so they never outlive the result they belong to.
  applyProcessing(p: ScanProcessing): void {
    this.dispose()
    this.error = null
    this.result = p.result
    this.overlay = markRaw(p.overlay)
    this.mask = p.mask ? markRaw(p.mask) : null
  }

  // A failed (re-)analysis must not leave a stale earlier result behind: the card would report the
  // error while getters and any consumer reading `result` still served the outdated measurement.
  fail(message: string): void {
    this.dispose()
    this.result = null
    this.error = message
  }

  get state(): ScanState {
    if (this.error) return ScanState.Unreadable
    if (!this.result) return ScanState.Pending
    if (!this.result.aligned) return ScanState.Misaligned
    if (!this.result.plane) return ScanState.Unlabeled
    return ScanState.Measured
  }

  get isMeasured(): boolean {
    return this.state === ScanState.Measured
  }

  get aligned(): boolean {
    return this.result?.aligned ?? false
  }

  get ringsFound(): number {
    return this.result?.ringsDetected ?? 0
  }

  get ringsExpected(): number {
    return this.result?.ringsExpected ?? 0
  }

  get plane(): Plane | null {
    return this.result?.plane ?? null
  }

  get failureReason(): string | null {
    return this.result?.failureReason ?? null
  }

  get clippedSides(): ClipSide[] {
    return this.result?.clippedSides ?? []
  }

  get flipped(): boolean | null {
    return this.result?.orientation?.flipped ?? null
  }

  dispose(): void {
    this.overlay?.close()
    this.mask?.close()
    this.overlay = null
    this.mask = null
  }
}
