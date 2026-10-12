// @vitest-environment jsdom
/**
 * Pet-to-pet dialogue: pair selection, scripted turn order, and the driver's
 * bounded loop.
 *
 * The pure half (pair choice, turn planning, script lookup) is tested directly;
 * the driver is exercised with fake timers against a real store so the bubble
 * writes and the turn cap are covered end to end.
 *
 * The script table's semantics matter to every case here: it is keyed by who
 * OPENS, and the array inside is the whole exchange in order (line 0 the
 * opener, line 1 the reply, ...). The two pets alternate off that one array.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import type { PetStateView } from '../service.ts'
import { createPetStore, type PetStoreInstance } from './pet-store.ts'
import {
  DEFAULT_DIALOGUE_CONFIG,
  DEFAULT_DIALOGUE_SCRIPT,
  canOpenWith,
  nextPair,
  nextUtterance,
  scriptedProducer,
  speakerForTurn,
  type DialogueScript,
} from './dialogue.ts'
import { usePetDialogue } from './dialogue-driver.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** A snapshot carrying the given pets, each with a distinct position. */
function snapshotWith(petIds: string[]): PetStateView {
  return {
    animation: 'idle',
    phase: 'idle',
    sessionActive: false,
    affinity: {
      points: 0, rank: '幼鲸', rankEmoji: '', pets: 0, feeds: 0, turns: 0,
      petCooldown: false, feedCooldown: false,
    },
    display: { visible: true, size: 160, right: 24, bottom: 120, bubbleScale: 1, edgeMarginLeft: 24, edgeMarginRight: 8 },
    pet: { id: petIds[0] ?? 'whale-girl', displayName: 'W', description: '' },
    name: 'W',
    treats: { stocked: 0, max: 20 },
    pets: petIds.map((id, index) => ({
      id,
      name: id,
      animation: 'idle' as const,
      phase: 'idle' as const,
      right: 24 + index * 200,
      bottom: 120,
    })),
  }
}

describe('speakerForTurn', () => {
  it('alternates from the opener', () => {
    const pair = { speakerId: 'a', listenerId: 'b' }
    expect(speakerForTurn(pair, 0)).toBe('a')
    expect(speakerForTurn(pair, 1)).toBe('b')
    expect(speakerForTurn(pair, 2)).toBe('a')
  })
})

describe('canOpenWith', () => {
  it('is directional: only the scripted way counts', () => {
    const script: DialogueScript = { a: { b: [{ text: 'hi' }] } }
    expect(canOpenWith(script, 'a', 'b')).toBe(true)
    // 'b' has nothing scripted TO 'a', so it cannot open with it.
    expect(canOpenWith(script, 'b', 'a')).toBe(false)
  })

  it('treats an empty script as unable to open', () => {
    expect(canOpenWith({ a: { b: [] } }, 'a', 'b')).toBe(false)
  })
})

describe('nextPair', () => {
  it('returns nothing with fewer than two pets', () => {
    expect(nextPair(DEFAULT_DIALOGUE_SCRIPT, ['whale-girl'], 0)).toBeUndefined()
    expect(nextPair(DEFAULT_DIALOGUE_SCRIPT, [], 0)).toBeUndefined()
  })

  it('rotates the opener across conversations', () => {
    const ids = ['whale-girl', 'long-niang']
    const first = nextPair(DEFAULT_DIALOGUE_SCRIPT, ids, 0)
    const second = nextPair(DEFAULT_DIALOGUE_SCRIPT, ids, 1)
    // The same pet must not always start, or the exchange reads as a monologue
    // with a reply bolted on.
    expect(first?.speakerId).toBe('whale-girl')
    expect(second?.speakerId).toBe('long-niang')
  })

  it('skips a partner this pet cannot open with', () => {
    // 'a' has a script only for 'c'; a random pick of 'b' must fall through to
    // the scripted partner instead of ending the conversation.
    const script: DialogueScript = { a: { c: [{ text: 'hi' }] } }
    const pair = nextPair(script, ['a', 'b', 'c'], 0, () => 0)
    expect(pair).toEqual({ speakerId: 'a', listenerId: 'c' })
  })

  it('returns nothing when the opener has no scripted partner', () => {
    const script: DialogueScript = { x: { y: [{ text: 'hi' }] } }
    // 'a' is the opener and has no lines at all.
    expect(nextPair(script, ['a', 'b'], 0)).toBeUndefined()
  })
})

describe('scriptedProducer', () => {
  it('walks the exchange in turn order, both sides off one array', () => {
    const produce = scriptedProducer(DEFAULT_DIALOGUE_SCRIPT)
    const opener = { openerId: 'whale-girl', speakerId: 'whale-girl', listenerId: 'long-niang', turn: 0 }
    const reply = { openerId: 'whale-girl', speakerId: 'long-niang', listenerId: 'whale-girl', turn: 1 }
    expect(produce(opener)?.text).toBe('hello！')
    // The reply is line 1 of the OPENER's array, not line 1 of the dragon's own
    // direction — reading it by speaker would return 'hello！' again.
    expect(produce(reply)?.text).toBe('world')
  })

  it('ends the conversation when the script runs out', () => {
    const produce = scriptedProducer({ a: { b: [{ text: 'only' }] } })
    expect(produce({ openerId: 'a', speakerId: 'a', listenerId: 'b', turn: 0 })?.text).toBe('only')
    expect(produce({ openerId: 'a', speakerId: 'b', listenerId: 'a', turn: 1 })).toBeUndefined()
  })

  it('reads only the direction the exchange was opened from', () => {
    // A reverse-only script must not let the opener deliver the reply's line.
    const produce = scriptedProducer({ b: { a: [{ text: 'reverse' }] } })
    expect(produce({ openerId: 'a', speakerId: 'a', listenerId: 'b', turn: 0 })).toBeUndefined()
  })
})

describe('nextUtterance', () => {
  it('alternates speakers and carries the animation', async () => {
    const produce = scriptedProducer(DEFAULT_DIALOGUE_SCRIPT)
    const pair = { speakerId: 'whale-girl', listenerId: 'long-niang' }
    const first = await nextUtterance(produce, pair, 0, undefined, 4)
    const second = await nextUtterance(produce, pair, 1, first?.text, 4)
    expect(first?.petId).toBe('whale-girl')
    expect(first?.animation).toBe('waving')
    expect(second?.petId).toBe('long-niang')
    expect(second?.text).toBe('world')
  })

  it('stops at the turn cap even with script left', async () => {
    const produce = scriptedProducer(DEFAULT_DIALOGUE_SCRIPT)
    const pair = { speakerId: 'whale-girl', listenerId: 'long-niang' }
    // The whale/dragon script has four lines; a cap of two truncates it.
    expect(await nextUtterance(produce, pair, 2, 'x', 2)).toBeUndefined()
  })

  it('supports an async producer, the seam a model-backed one uses', async () => {
    const produce = async (): Promise<{ text: string }> => {
      await Promise.resolve()
      return { text: 'from a model' }
    }
    const utterance = await nextUtterance(produce, { speakerId: 'a', listenerId: 'b' }, 0, undefined, 1)
    expect(utterance?.text).toBe('from a model')
  })
})

describe('usePetDialogue', () => {
  /** Mount the driver over a store seeded with the given pets. */
  function mount(petIds: string[], enabled = true): PetStoreInstance {
    const store = createPetStore().create()
    store.actions.setSnapshot(snapshotWith(petIds))
    function Probe(): null {
      usePetDialogue({ store, enabled })
      return null
    }
    render(createElement(Probe))
    return store
  }

  it('runs a scripted exchange between two pets', async () => {
    vi.useFakeTimers()
    // Always start a conversation, so the test does not depend on the roll.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const store = mount(['whale-girl', 'long-niang'])

    // The first roll lands half an interval in.
    await act(async () => {
      vi.advanceTimersByTime(DEFAULT_DIALOGUE_CONFIG.intervalMs / 2 + 10)
    })
    // The opener speaks the scripted first line, on its own bubble.
    expect(store.getSnapshot().feedback['whale-girl']?.text).toBe('hello！')
    expect(store.getSnapshot().feedback['whale-girl']?.kind).toBe('dialogue')
    // The other pet has said nothing yet.
    expect(store.getSnapshot().feedback['long-niang']).toBeUndefined()

    // After the line's own duration the reply lands on the other pet.
    await act(async () => {
      vi.advanceTimersByTime(DEFAULT_DIALOGUE_CONFIG.lineMs + 10)
    })
    expect(store.getSnapshot().feedback['long-niang']?.text).toBe('world')
  })

  it('carries the line animation so the pet visibly reacts', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const store = mount(['whale-girl', 'long-niang'])

    await act(async () => {
      vi.advanceTimersByTime(DEFAULT_DIALOGUE_CONFIG.intervalMs / 2 + 10)
    })
    // 'hello！' is scripted with a wave: speaking must not be text-only.
    expect(store.getSnapshot().feedback['whale-girl']?.animation).toBe('waving')
  })

  it('does nothing while the driver is parked', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const store = mount(['whale-girl', 'long-niang'], false)

    await act(async () => {
      vi.advanceTimersByTime(DEFAULT_DIALOGUE_CONFIG.intervalMs * 3)
    })
    expect(store.getSnapshot().feedback).toEqual({})
  })

  it('stands down when only one pet is on screen', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const store = mount(['whale-girl'])

    await act(async () => {
      vi.advanceTimersByTime(DEFAULT_DIALOGUE_CONFIG.intervalMs * 3)
    })
    expect(store.getSnapshot().feedback).toEqual({})
  })

  it('clears a line after its own duration', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const store = mount(['whale-girl', 'long-niang'])

    await act(async () => {
      vi.advanceTimersByTime(DEFAULT_DIALOGUE_CONFIG.intervalMs / 2 + 10)
    })
    expect(store.getSnapshot().feedback['whale-girl']).toBeDefined()

    await act(async () => {
      vi.advanceTimersByTime(DEFAULT_DIALOGUE_CONFIG.lineMs + 10)
    })
    // The opener's bubble is gone; the reply has taken over the other pet.
    expect(store.getSnapshot().feedback['whale-girl']).toBeUndefined()
  })

  it('never exceeds the turn cap within one conversation', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const store = mount(['whale-girl', 'long-niang'])
    const seen: string[] = []
    store.subscribe(() => {
      for (const bubble of Object.values(store.getSnapshot().feedback)) {
        if (bubble !== undefined && seen[seen.length - 1] !== bubble.text) seen.push(bubble.text)
      }
    })

    // Step one line at a time: each turn is scheduled by an awaited promise, so
    // a single big jump would run the first line and leave the rest pending.
    await act(async () => {
      vi.advanceTimersByTime(DEFAULT_DIALOGUE_CONFIG.intervalMs / 2 + 10)
    })
    for (let turn = 0; turn < DEFAULT_DIALOGUE_CONFIG.maxTurns; turn += 1) {
      await act(async () => {
        vi.advanceTimersByTime(DEFAULT_DIALOGUE_CONFIG.lineMs + 10)
      })
    }

    // The script has exactly four lines, so the first conversation is the whole
    // script and nothing more. (A second conversation may repeat it later; this
    // pins the per-conversation bound.)
    expect(seen).toEqual(['hello！', 'world', '你这龙，怎么回得这么敷衍', '因为我在忙着吃 token'])
  })
})
