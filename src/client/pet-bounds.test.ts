// @vitest-environment jsdom
/**
 * Pet viewport bounds: a sprite must stay fully inside the window.
 *
 * The reported bug was a pet parked with half its body past the left edge. The
 * cause was two clamps with different, wrong bounds — the drag path used a
 * hardcoded 40px that ignored the sprite's own width, while the roam path used
 * a correct-but-tiny 8px margin. These cases pin the shared bounds, and the
 * left margin specifically, since that is the edge the float is anchored away
 * from and the one the user saw clipping.
 */
import { describe, expect, it } from 'vitest'
import {
  PET_EDGE_MARGIN_LEFT,
  PET_EDGE_MARGIN_RIGHT,
  PET_EDGE_MARGIN_VERTICAL,
  clampPetOffset,
  edgeMarginsOf,
  petBottomBounds,
  petRightBounds,
} from './PetSprite.tsx'

/** The window the report came from, and the default sprite size. */
const VIEWPORT = { width: 1295, height: 829 }
const SPRITE = { width: 148, height: 160 }

describe('edgeMarginsOf', () => {
  it('falls back per field when a host serves no margins', () => {
    // An older host has no margin fields at all; the shipped gaps apply rather
    // than 0, which would pin every pet to the viewport edge.
    expect(edgeMarginsOf({})).toEqual({ left: PET_EDGE_MARGIN_LEFT, right: PET_EDGE_MARGIN_RIGHT })
    expect(edgeMarginsOf({ edgeMarginLeft: 60 })).toEqual({ left: 60, right: PET_EDGE_MARGIN_RIGHT })
  })

  it('ignores a non-finite value rather than letting NaN reach the clamp', () => {
    // Math.min/max propagate NaN, which would collapse the bounds and strand
    // the sprite at an arbitrary offset.
    expect(edgeMarginsOf({ edgeMarginLeft: Number.NaN })).toEqual({
      left: PET_EDGE_MARGIN_LEFT,
      right: PET_EDGE_MARGIN_RIGHT,
    })
  })
})

describe('petRightBounds', () => {
  it('keeps the sprite clear of both horizontal edges', () => {
    const { min, max } = petRightBounds(VIEWPORT.width, SPRITE.width)
    expect(min).toBe(PET_EDGE_MARGIN_RIGHT)
    // `right` grows leftwards, so the max is what keeps the sprite off the LEFT
    // edge: viewport - sprite - left margin.
    expect(max).toBe(VIEWPORT.width - SPRITE.width - PET_EDGE_MARGIN_LEFT)
    // The shipped left margin is the wider one: that is the edge the user saw
    // the pet clipped against.
    expect(PET_EDGE_MARGIN_LEFT).toBeGreaterThan(PET_EDGE_MARGIN_RIGHT)
  })

  it('honours a configured margin', () => {
    const { max } = petRightBounds(VIEWPORT.width, SPRITE.width, { left: 100, right: 4 })
    expect(max).toBe(VIEWPORT.width - SPRITE.width - 100)
    // A smaller left margin lets the pet get closer to the edge, which is what
    // the user asked for after the first (too cautious) default.
    const shipped = petRightBounds(VIEWPORT.width, SPRITE.width).max
    expect(max).toBeLessThan(shipped)
    expect(petRightBounds(VIEWPORT.width, SPRITE.width, { left: 4, right: 4 }).max).toBeGreaterThan(shipped)
  })

  it('rejects the offset that put the pet past the left edge', () => {
    // The persisted value from the report: 1203 put the sprite's left edge at
    // -56px, i.e. more than a third of its body outside the window.
    const { max } = petRightBounds(VIEWPORT.width, SPRITE.width, { left: 72, right: 8 })
    expect(1203).toBeGreaterThan(max)
    const clamped = clampPetOffset({ right: 1203, bottom: 120 }, VIEWPORT, SPRITE, { left: 72, right: 8 })
    expect(clamped.right).toBe(max)
    // The whole sprite is inside the viewport now.
    expect(VIEWPORT.width - clamped.right - SPRITE.width).toBeGreaterThanOrEqual(72)
  })

  it('never inverts on a viewport narrower than the sprite', () => {
    const { min, max } = petRightBounds(100, SPRITE.width)
    // A negative max would let the sprite escape to the left; it sits at the
    // right margin instead.
    expect(max).toBeGreaterThanOrEqual(min)
  })
})

describe('petBottomBounds', () => {
  it('keeps the sprite clear of both vertical edges', () => {
    const { min, max } = petBottomBounds(VIEWPORT.height, SPRITE.height)
    expect(min).toBe(PET_EDGE_MARGIN_VERTICAL)
    expect(max).toBe(VIEWPORT.height - SPRITE.height - PET_EDGE_MARGIN_VERTICAL)
  })

  it('never inverts on a viewport shorter than the sprite', () => {
    const { min, max } = petBottomBounds(100, SPRITE.height)
    expect(max).toBeGreaterThanOrEqual(min)
  })
})

describe('clampPetOffset', () => {
  it('leaves an in-bounds offset untouched', () => {
    const offset = { right: 24, bottom: 120 }
    expect(clampPetOffset(offset, VIEWPORT, SPRITE)).toEqual(offset)
  })

  it('pulls an out-of-bounds offset back on both axes', () => {
    const clamped = clampPetOffset({ right: 9999, bottom: 9999 }, VIEWPORT, SPRITE)
    expect(clamped.right).toBe(petRightBounds(VIEWPORT.width, SPRITE.width).max)
    expect(clamped.bottom).toBe(petBottomBounds(VIEWPORT.height, SPRITE.height).max)
  })

  it('keeps a negative offset at the near margin rather than off-screen', () => {
    const clamped = clampPetOffset({ right: -500, bottom: -500 }, VIEWPORT, SPRITE)
    expect(clamped.right).toBe(PET_EDGE_MARGIN_RIGHT)
    expect(clamped.bottom).toBe(PET_EDGE_MARGIN_VERTICAL)
  })

  it('accounts for the sprite size, not a fixed constant', () => {
    // A larger pet must be allowed a smaller maximum offset, or its left side
    // would hang out exactly as the reported one did.
    const small = petRightBounds(VIEWPORT.width, 100).max
    const large = petRightBounds(VIEWPORT.width, 300).max
    expect(large).toBeLessThan(small)
    expect(small - large).toBe(200)
  })
})
