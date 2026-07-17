import { describe, expect, it } from 'vitest'
import { bilinear, gradientCentroid } from '../../src/engine/subpixelEdge'

// 2x2 image, row-major: (0,0)=0, (1,0)=100, (0,1)=200, (1,1)=240.
const grid = new Uint8Array([0, 100, 200, 240])

describe('bilinear', () => {
  it('returns the exact pixel value at an integer coordinate', () => {
    expect(bilinear(grid, 2, 2, 0, 0)).toBe(0)
  })

  it('returns the four-pixel average at the cell center', () => {
    expect(bilinear(grid, 2, 2, 0.5, 0.5)).toBe(135)
  })

  it('interpolates along the x axis only when y is integer', () => {
    expect(bilinear(grid, 2, 2, 0.5, 0)).toBe(50)
  })

  it('returns NaN for a negative x', () => {
    expect(bilinear(grid, 2, 2, -0.5, 0)).toBeNaN()
  })

  it('returns NaN for a negative y', () => {
    expect(bilinear(grid, 2, 2, 0, -0.5)).toBeNaN()
  })

  it('returns NaN when the right interpolation neighbor falls outside the image', () => {
    expect(bilinear(grid, 2, 2, 1, 0)).toBeNaN()
  })

  it('returns NaN when y is beyond the last row', () => {
    expect(bilinear(grid, 2, 2, 0, 2)).toBeNaN()
  })
})

describe('gradientCentroid', () => {
  it('returns null when the window carries no gradient weight', () => {
    expect(gradientCentroid(() => 0, 2, 1, 0, 4)).toBeNull()
  })

  it('returns the weighted mean position of the gradient samples', () => {
    // Window k = 1..3 with gradients 1, 3, 0: moment 7 over weight 4.
    const grad = (k: number) => (k === 1 ? 1 : k === 2 ? 3 : 0)
    expect(gradientCentroid(grad, 2, 1, 0, 4)).toBe(1.75)
  })
})
