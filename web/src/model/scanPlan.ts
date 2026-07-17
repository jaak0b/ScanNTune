/**
 * The two scanning choices shared by the coupon flows that print a scannable part: where the
 * scan happens (the removed part on the glass, or the whole build plate), and whether the
 * coupon prints in a single color or over a contrasting base color.
 */
export const SCAN_PLACES = ['part', 'plate'] as const
export type ScanPlace = (typeof SCAN_PLACES)[number]

export const PART_COLORS = ['single', 'base'] as const
export type PartColors = (typeof PART_COLORS)[number]

/** The scan-place picker items, worded identically in every flow that offers the choice. */
export const SCAN_PLACE_ITEMS: { title: string; value: ScanPlace }[] = [
  { title: 'Scan the removed part', value: 'part' },
  { title: 'Scan with the build plate', value: 'plate' },
]

/** The part-colors picker items, worded identically in every flow that offers the choice. */
export const PART_COLORS_ITEMS: { title: string; value: PartColors }[] = [
  { title: 'Single color', value: 'single' },
  { title: 'Two colors (contrasting base)', value: 'base' },
]

/**
 * A flow's wording for the scanning-plan note. A plate scan always states the front-edge
 * placement and appends the base or single-color consequence; a part scan states the base or
 * single-color contrast requirement on its own.
 */
export interface ScanPlanTexts {
  platePlacement: string
  plateBase: string
  plateSingle: string
  partBase: string
  partSingle: string
}

/** Assembles the scanning-plan note for the two picker choices from a flow's wording. */
export function scanPlanNoteText(
  place: ScanPlace,
  colors: PartColors,
  texts: ScanPlanTexts,
): string {
  if (place === 'plate')
    return texts.platePlacement + (colors === 'base' ? texts.plateBase : texts.plateSingle)
  return colors === 'base' ? texts.partBase : texts.partSingle
}
