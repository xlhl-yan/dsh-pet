// @vitest-environment jsdom
/**
 * The interaction loop end to end, through the driver.
 *
 * These cases exist because the unit tests for the engine and the rules all
 * passed while the feature was, in practice, dead: the world was fed from the
 * host snapshot, which is `idle` forever under `autonomous`, so no rule ever
 * saw a celebrating pet. The chain has three links that each look fine alone —
 * the sprite reporting its resolved animation, the world storing it, and the
 * driver raising an event on the transition — and only the whole chain proves
 * the feature works.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import type { PetAnimation } from '../state.ts'
import { usePetInteractions, usePetWorldPresence } from './interaction-driver.ts'
import { createPetStore, type PetStoreInstance } from './pet-store.ts'
import { World } from './world.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/**
 * A dock of two pets wired the way `PetDockEntry` wires them: the driver runs
 * once for the group, and each pet publishes its presence plus a reporter the
 * sprite calls with its resolved animation.
 */
function dock(ids: readonly string[]): {
  world: World
  store: PetStoreInstance
  report: (petId: string, animation: PetAnimation) => void
} {
  const world = new World()
  const store = createPetStore().create()
  const reporters = new Map<string, (animation: string) => void>()

  function PetProbe(props: { id: string; right: number }): null {
    const report = usePetWorldPresence(world, {
      id: props.id,
      phase: 'idle',
      right: props.right,
      bottom: 120,
      width: 148,
      height: 160,
    })
    reporters.set(props.id, report)
    return null
  }
  function Dock(): null {
    usePetInteractions({ store, enabled: true, world, roll: () => 0 })
    return null
  }

  render(createElement(
    'div',
    null,
    createElement(Dock),
    ...ids.map((id, index) => createElement(PetProbe, { key: id, id, right: index * 200 })),
  ))

  return {
    world,
    store,
    report: (petId, animation) => {
      const report = reporters.get(petId)
      if (report === undefined) throw new Error('no reporter for ' + petId)
      report(animation)
    },
  }
}

/** Let the driver's 250ms poll run. */
async function poll(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(300)
  })
}

describe('interaction loop', () => {
  it('publishes a presence for every pet on the dock', () => {
    vi.useFakeTimers()
    const { world } = dock(['whale-girl', 'long-niang'])
    expect(world.ids()).toEqual(['whale-girl', 'long-niang'])
  })

  it('reacts when one pet reports entering a notable animation', async () => {
    vi.useFakeTimers()
    const { world, store, report } = dock(['whale-girl', 'long-niang'])
    // Nothing has happened yet.
    expect(store.getSnapshot().feedback).toEqual({})

    // The whale girl finishes something and jumps — the sprite reports its
    // resolved track, which is the only link that works under `autonomous`.
    await act(async () => { report('whale-girl', 'jumping') })
    expect(world.presence('whale-girl')?.animation).toBe('jumping')

    await poll()

    // The dragon looks over rather than joining the jump: her declared
    // personality answers a celebration with `review`.
    const reaction = store.getSnapshot().feedback['long-niang']
    expect(reaction).toBeDefined()
    expect(reaction?.animation).toBe('review')
    expect(reaction?.text).toBe('……哦。')
    // The pet that jumped does not react to itself.
    expect(store.getSnapshot().feedback['whale-girl']).toBeUndefined()
  })

  it('does not re-raise while a pet HOLDS a notable animation', async () => {
    vi.useFakeTimers()
    const { store, report } = dock(['whale-girl', 'long-niang'])
    await act(async () => { report('whale-girl', 'jumping') })
    await poll()
    const first = store.getSnapshot().feedback['long-niang']
    expect(first).toBeDefined()

    // Clear the reaction the way its hold expiring would, then keep the pet
    // jumping. Without the transition check the same held state would raise the
    // event on every 250ms tick.
    await act(async () => { store.actions.setFeedback('long-niang', null) })
    await poll()
    await poll()
    expect(store.getSnapshot().feedback['long-niang']).toBeUndefined()
  })

  it('reacts again after the pet leaves and re-enters the notable state', async () => {
    vi.useFakeTimers()
    const { store, report } = dock(['whale-girl', 'long-niang'])
    await act(async () => { report('whale-girl', 'jumping') })
    await poll()
    expect(store.getSnapshot().feedback['long-niang']).toBeDefined()

    // Back to idle, past the cooldown, then jump again.
    await act(async () => { report('whale-girl', 'idle') })
    await act(async () => { vi.advanceTimersByTime(1000) })
    await act(async () => { store.actions.setFeedback('long-niang', null) })
    await act(async () => { report('whale-girl', 'jumping') })
    await poll()
    expect(store.getSnapshot().feedback['long-niang']).toBeDefined()
  })

  it('answers a failure as well as a celebration', async () => {
    vi.useFakeTimers()
    const { store, report } = dock(['whale-girl', 'long-niang'])
    await act(async () => { report('whale-girl', 'failed') })
    await poll()
    expect(store.getSnapshot().feedback['long-niang']?.animation).toBe('waiting')
  })

  it('ignores a pet that leaves the screen', async () => {
    vi.useFakeTimers()
    const { world, store, report } = dock(['whale-girl', 'long-niang'])
    // The dragon unmounts; her presence must go with her, or a rule could
    // address a pet that is no longer rendered.
    cleanup()
    expect(world.ids()).toEqual([])
    expect(store.getSnapshot().feedback).toEqual({})
    void report
  })

  it('stays silent while the driver is parked', async () => {
    vi.useFakeTimers()
    const world = new World()
    const store = createPetStore().create()
    const report = vi.fn()
    function Dock(): null {
      usePetInteractions({ store, enabled: false, world, roll: () => 0 })
      return null
    }
    function PetProbe(): null {
      const publish = usePetWorldPresence(world, {
        id: 'whale-girl', phase: 'idle', right: 0, bottom: 0, width: 1, height: 1,
      })
      report.mockImplementation(publish)
      return null
    }
    render(createElement('div', null, createElement(Dock), createElement(PetProbe)))

    await act(async () => { report('jumping') })
    await poll()
    expect(store.getSnapshot().feedback).toEqual({})
  })
})
