/**
 * The pet store's poll-publish contract against the real client-store engine:
 * an unchanged snapshot must skip the write (immer records no modification,
 * zustand never notifies), while any transition that matters still publishes.
 */
import { describe, expect, it, vi } from 'vitest'
import type { PetStateView } from '../service.ts'
import { createPetStore } from './pet-store.ts'

const snapshot = (over: Partial<PetStateView> = {}): PetStateView => ({
  animation: 'idle',
  phase: 'idle',
  sessionActive: false,
  affinity: {
    points: 3,
    rank: '好奇',
    rankEmoji: '',
    pets: 1,
    feeds: 0,
    turns: 0,
    petCooldown: false,
    feedCooldown: false,
  },
  display: { visible: true, size: 160, right: 24, bottom: 120, bubbleScale: 1, edgeMarginLeft: 24, edgeMarginRight: 8 },
  pet: { id: 'whale-girl', displayName: 'Whale', description: '' },
  name: 'Whale',
  treats: { stocked: 2, max: 10 },
  ...over,
})

describe('pet store setSnapshot publish skipping', () => {
  it('does not notify when a poll republishes an unchanged snapshot', () => {
    const store = createPetStore().create()
    const listener = vi.fn()
    store.subscribe(listener)

    const first = snapshot()
    store.actions.setSnapshot(first)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().state).toBe('ready')

    // A fresh, deep-equal object is what every poll tick delivers.
    store.actions.setSnapshot(snapshot())
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().snapshot).toBe(first)

    // Any content change publishes again.
    store.actions.setSnapshot(snapshot({ phase: 'thinking', animation: 'running' }))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('publishes after an error state even when the payload is unchanged', () => {
    const store = createPetStore().create()
    const listener = vi.fn()
    store.subscribe(listener)
    store.actions.setSnapshot(snapshot())

    store.actions.setState('error', 'pet.state transport error')
    expect(listener).toHaveBeenCalledTimes(2)

    // The success transition (error -> ready) must land despite the equal
    // payload, or the UI would stay stuck on the transport-error banner.
    store.actions.setSnapshot(snapshot())
    expect(listener).toHaveBeenCalledTimes(3)
    expect(store.getSnapshot().state).toBe('ready')
    expect(store.getSnapshot().error).toBeNull()
  })

  it('still patches the gameplay view and feedback on top of a skipped poll', () => {
    const store = createPetStore().create()
    store.actions.setSnapshot(snapshot())
    const base = store.getSnapshot().snapshot!

    store.actions.setGameplayView({ stats: { mood: 70 }, mode: 'work' })
    expect(store.getSnapshot().snapshot).not.toBe(base)
    expect(store.getSnapshot().snapshot?.gameplay).toEqual({ stats: { mood: 70 }, mode: 'work' })

    store.actions.setFeedback('whale-girl', { text: '喵', kind: 'pet', at: 1 })
    expect(store.getSnapshot().feedback['whale-girl']).toEqual({ text: '喵', kind: 'pet', at: 1 })

    // The next identical poll (a fresh but deep-equal object) skips the
    // publish and keeps the exact snapshot reference the UI already holds.
    const before = store.getSnapshot().snapshot
    store.actions.setSnapshot(snapshot({ gameplay: { stats: { mood: 70 }, mode: 'work' } }))
    expect(store.getSnapshot().snapshot).toBe(before)
  })
})

describe('pet store per-pet reaction bubbles', () => {
  it('keeps each pet\'s bubble separate', () => {
    const store = createPetStore().create()
    // With several pets on screen a shared slot made every sprite wear the
    // same bubble: petting one pet answered from all of them.
    store.actions.setFeedback('whale-girl', { text: '摸头！', kind: 'pet', at: 1 })
    store.actions.setFeedback('long-niang', { text: '别碰我', kind: 'pet', at: 2 })
    const feedback = store.getSnapshot().feedback
    expect(feedback['whale-girl']?.text).toBe('摸头！')
    expect(feedback['long-niang']?.text).toBe('别碰我')
  })

  it('clears only the pet that finished its bubble', () => {
    const store = createPetStore().create()
    store.actions.setFeedback('whale-girl', { text: 'A', kind: 'pet', at: 1 })
    store.actions.setFeedback('long-niang', { text: 'B', kind: 'pet', at: 2 })

    store.actions.setFeedback('whale-girl', null)

    expect(store.getSnapshot().feedback['whale-girl']).toBeUndefined()
    expect(store.getSnapshot().feedback['long-niang']?.text).toBe('B')
  })

  it('skips the publish when clearing a pet that has no bubble', () => {
    const store = createPetStore().create()
    const listener = vi.fn()
    store.subscribe(listener)
    // The expiry path runs on every render tick; a needless write would
    // republish the store and re-render every sprite.
    store.actions.setFeedback('whale-girl', null)
    expect(listener).not.toHaveBeenCalled()
  })
})
