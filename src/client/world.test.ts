/**
 * The world: pet presences plus a bounded event log.
 *
 * The clock is injected everywhere so nothing here depends on wall time, and
 * the bounded log is asserted explicitly because an unbounded one would grow for
 * the life of the page.
 */
import { describe, expect, it } from 'vitest'
import { World, type PetPresence } from './world.ts'

/** A presence with sane defaults, so each case states only what it cares about. */
function presence(id: string, over: Partial<Omit<PetPresence, 'id'>> = {}): Omit<PetPresence, 'at'> {
  return {
    id,
    animation: 'idle',
    phase: 'idle',
    right: 24,
    bottom: 120,
    width: 148,
    height: 160,
    ...over,
  }
}

/** A world with a controllable clock. */
function makeWorld(maxEvents?: number): { world: World; advance: (ms: number) => void } {
  let now = 1000
  const world = new World({ now: () => now, ...(maxEvents === undefined ? {} : { maxEvents }) })
  return { world, advance: (ms: number) => { now += ms } }
}

describe('World presences', () => {
  it('records and reads one pet back', () => {
    const { world } = makeWorld()
    world.setPresence(presence('whale-girl', { animation: 'jumping', phase: 'done' }))
    expect(world.presence('whale-girl')).toMatchObject({
      id: 'whale-girl',
      animation: 'jumping',
      phase: 'done',
    })
  })

  it('stamps each write with the current time', () => {
    const { world, advance } = makeWorld()
    world.setPresence(presence('a'))
    advance(500)
    world.setPresence(presence('a'))
    expect(world.presence('a')?.at).toBe(1500)
  })

  it('keeps insertion order, which is the render order', () => {
    const { world } = makeWorld()
    world.setPresence(presence('a'))
    world.setPresence(presence('b'))
    world.setPresence(presence('c'))
    expect(world.ids()).toEqual(['a', 'b', 'c'])
    // A rewrite must not move a pet to the end: the render order is the host's.
    world.setPresence(presence('a'))
    expect(world.ids()).toEqual(['a', 'b', 'c'])
  })

  it('drops a pet that left the screen', () => {
    const { world } = makeWorld()
    world.setPresence(presence('a'))
    world.remove('a')
    expect(world.presence('a')).toBeUndefined()
    expect(world.ids()).toEqual([])
  })

  it('reports an unknown pet rather than inventing one', () => {
    const { world } = makeWorld()
    expect(world.presence('nobody')).toBeUndefined()
  })
})

describe('World event log', () => {
  it('records events oldest-first with a timestamp', () => {
    const { world, advance } = makeWorld()
    world.record({ source: 'a', kind: 'celebrate' })
    advance(100)
    world.record({ source: 'b', kind: 'failure' })
    expect(world.recent().map(event => event.kind)).toEqual(['celebrate', 'failure'])
    expect(world.recent()[1]?.at).toBe(1100)
  })

  it('bounds the log, dropping the oldest first', () => {
    const { world } = makeWorld(3)
    for (let index = 0; index < 5; index += 1) {
      world.record({ source: 'a', kind: 'k' + index })
    }
    // An unbounded log would grow for the life of the page; only recent events
    // are ever consulted.
    expect(world.recent().map(event => event.kind)).toEqual(['k2', 'k3', 'k4'])
  })

  it('finds the most recent event of a kind inside a window', () => {
    const { world, advance } = makeWorld()
    world.record({ source: 'a', kind: 'celebrate' })
    advance(5000)
    world.record({ source: 'b', kind: 'failure' })
    expect(world.lastOfKind('failure', 1000)?.source).toBe('b')
    // The celebration is outside the window.
    expect(world.lastOfKind('celebrate', 1000)).toBeUndefined()
    expect(world.lastOfKind('celebrate', 10_000)?.source).toBe('a')
  })

  it('returns nothing for a kind that never happened', () => {
    const { world } = makeWorld()
    expect(world.lastOfKind('nope', 10_000)).toBeUndefined()
  })
})

describe('World distance', () => {
  it('measures between two pets', () => {
    const { world } = makeWorld()
    world.setPresence(presence('a', { right: 0, bottom: 0 }))
    world.setPresence(presence('b', { right: 3, bottom: 4 }))
    expect(world.distanceBetween('a', 'b')).toBe(5)
  })

  it('is undefined when either pet is off screen', () => {
    const { world } = makeWorld()
    world.setPresence(presence('a'))
    expect(world.distanceBetween('a', 'b')).toBeUndefined()
    expect(world.distanceBetween('b', 'a')).toBeUndefined()
  })
})

describe('World clear', () => {
  it('drops every presence and event', () => {
    const { world } = makeWorld()
    world.setPresence(presence('a'))
    world.record({ source: 'a', kind: 'celebrate' })
    world.clear()
    expect(world.ids()).toEqual([])
    expect(world.recent()).toEqual([])
  })
})
