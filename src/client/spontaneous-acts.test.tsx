// @vitest-environment jsdom
/**
 * Spontaneous acts: the event source that makes autonomous pets interactable.
 *
 * Without this driver an autonomous pet only ever cycles `idle` / `waving` /
 * `waiting`, so no `jumping` ever happens and the interaction rules have nothing
 * to react to. These cases pin the act selection, the atlas filter (a pet must
 * never be handed a track it cannot draw), and the loop's hold/release.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import type { PetDefinition, PetTrackDef } from '../registry.ts'
import type { PetAnimation } from '../state.ts'
import type { GameplayBus } from './gameplay-hud.tsx'
import {
  DEFAULT_ACTS,
  DEFAULT_ACT_CONFIG,
  actLine,
  performableActs,
  pickAct,
  useSpontaneousActs,
  type SpontaneousAct,
} from './spontaneous-acts.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function track(frames: number[]): PetTrackDef {
  return { frames, durations: frames.map(() => 300), loop: true }
}

/** A sprite2d definition with the standard rows; override `tracks` to narrow it. */
function definition(tracks?: Partial<Record<PetAnimation, PetTrackDef>>): PetDefinition {
  const rows: PetAnimation[] = [
    'idle', 'running-right', 'running-left', 'waving', 'jumping',
    'failed', 'waiting', 'running', 'review',
  ]
  const all = Object.fromEntries(rows.map(row => [row, track([0, 1, 2, 3])])) as Record<PetAnimation, PetTrackDef>
  return {
    id: 'whale-girl',
    displayName: '鲸鱼娘',
    description: '',
    renderer: 'sprite2d',
    cell: { width: 192, height: 208 },
    columns: 8,
    rows: [4, 4, 4, 4, 4, 4, 4, 4, 4],
    atlasRows: 9,
    tracks: { ...all, ...tracks },
    atlasUrl: '/pet/whale-girl/spritesheet.webp',
    manifestUrl: '/pet/whale-girl/pet.json',
  } as PetDefinition
}

describe('performableActs', () => {
  it('keeps only the acts the atlas can draw', () => {
    // A pet with no `jumping` row must never be handed that track: the renderer
    // would fall back to a row it can draw and the act would silently become
    // something else.
    const acts = performableActs(definition({ jumping: undefined }))
    expect(acts.map(a => a.track)).not.toContain('jumping')
    expect(acts.map(a => a.track)).toContain('waving')
  })

  it('returns nothing for an atlas that draws none of the acts', () => {
    const bare = definition({
      jumping: undefined, waving: undefined, failed: undefined, review: undefined,
    })
    expect(performableActs(bare)).toEqual([])
  })

  it('keeps every shipped act for a full atlas', () => {
    expect(performableActs(definition()).map(a => a.track)).toEqual(DEFAULT_ACTS.map(a => a.track))
  })
})

describe('pickAct', () => {
  const acts: SpontaneousAct[] = [
    { track: 'jumping', holdMs: 1, weight: 1 },
    { track: 'waving', holdMs: 1, weight: 3 },
  ]

  it('picks by weight across the whole range', () => {
    // Weights 1 and 3: the first quarter maps to `jumping`, the rest to `waving`.
    expect(pickAct(acts, 0).track).toBe('jumping')
    expect(pickAct(acts, 0.24).track).toBe('jumping')
    expect(pickAct(acts, 0.3).track).toBe('waving')
    expect(pickAct(acts, 0.99).track).toBe('waving')
  })

  it('never returns undefined at the top of the range', () => {
    // A roll of exactly 1 would walk off the end without the fallback.
    expect(pickAct(acts, 1).track).toBe('waving')
  })
})

describe('actLine', () => {
  it('picks from the act\'s pool', () => {
    const act: SpontaneousAct = { track: 'waving', holdMs: 1, weight: 1, lines: ['a', 'b'] }
    expect(actLine(act, 0)).toBe('a')
    expect(actLine(act, 0.99)).toBe('b')
  })

  it('is undefined for a silent act', () => {
    expect(actLine({ track: 'jumping', holdMs: 1, weight: 1 })).toBeUndefined()
  })
})

describe('useSpontaneousActs', () => {
  /** Mount the driver and hand back its bus and line sink. */
  function mount(options: {
    definition?: PetDefinition
    enabled?: boolean
    config?: { intervalMs: number; probability: number }
  } = {}): { bus: GameplayBus; setTrack: ReturnType<typeof vi.fn>; onLine: ReturnType<typeof vi.fn> } {
    const bus: GameplayBus = {}
    const setTrack = vi.fn()
    const onLine = vi.fn()
    bus.setTrack = setTrack
    function Probe(): null {
      useSpontaneousActs({
        definition: options.definition ?? definition(),
        bus,
        enabled: options.enabled ?? true,
        config: options.config ?? DEFAULT_ACT_CONFIG,
        onLine,
      })
      return null
    }
    render(createElement(Probe))
    return { bus, setTrack, onLine }
  }

  it('performs an act on a successful roll and releases it after its hold', async () => {
    vi.useFakeTimers()
    // The roll source must be stubbed BEFORE the effect installs its timers:
    // the lead timeout is scheduled during the mount pass.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { setTrack } = mount()

    // The first roll lands half an interval in.
    await act(async () => {
      vi.advanceTimersByTime(DEFAULT_ACT_CONFIG.intervalMs / 2 + 10)
    })
    expect(setTrack).toHaveBeenCalled()
    const track = setTrack.mock.calls[0]![0]
    expect(DEFAULT_ACTS.map(a => a.track)).toContain(track)

    setTrack.mockClear()
    // The longest shipped hold is 1800ms; step past it.
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    // The override is released, so the pet returns to its idle routine.
    expect(setTrack).toHaveBeenCalledWith(undefined)
  })

  it('stays quiet when the roll misses', async () => {
    vi.useFakeTimers()
    // Above the shipped 0.45 probability. Stubbed before mount, so no tick can
    // slip through on a real random value.
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    const { setTrack } = mount()

    await act(async () => {
      vi.advanceTimersByTime(DEFAULT_ACT_CONFIG.intervalMs * 3)
    })
    expect(setTrack).not.toHaveBeenCalled()
  })

  it('does nothing while parked', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { setTrack } = mount({ enabled: false })

    await act(async () => {
      vi.advanceTimersByTime(DEFAULT_ACT_CONFIG.intervalMs * 3)
    })
    expect(setTrack).not.toHaveBeenCalled()
  })

  it('does nothing for a pet that can draw none of the acts', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const bare = definition({
      jumping: undefined, waving: undefined, failed: undefined, review: undefined,
    })
    const { setTrack } = mount({ definition: bare })

    await act(async () => {
      vi.advanceTimersByTime(DEFAULT_ACT_CONFIG.intervalMs * 3)
    })
    expect(setTrack).not.toHaveBeenCalled()
  })

  it('reports a line when the chosen act has one', async () => {
    vi.useFakeTimers()
    // 0 for the roll, then 0.9 lands on the last act (`review`), which speaks.
    const sequence: number[] = [0, 0.9, 0]
    vi.spyOn(Math, 'random').mockImplementation(() => sequence.shift() ?? 0)
    const { onLine } = mount()

    await act(async () => {
      vi.advanceTimersByTime(DEFAULT_ACT_CONFIG.intervalMs / 2 + 10)
    })
    expect(onLine).toHaveBeenCalled()
    expect(typeof onLine.mock.calls[0]![0]).toBe('string')
  })

  it('never starts a second act while one is in flight', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { setTrack } = mount({ config: { intervalMs: 1000, probability: 1 } })

    // Run a window shorter than the chosen act's hold, so every later tick lands
    // while the first act still owns the sprite.
    await act(async () => {
      vi.advanceTimersByTime(500 + 100)
    })
    // One act started; the ticks inside its hold were ignored.
    expect(setTrack.mock.calls.filter(call => call[0] !== undefined)).toHaveLength(1)
  })

  it('stands down while an ambient roam owns the sprite', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { bus, setTrack } = mount({ config: { intervalMs: 1000, probability: 1 } })
    // The roam and the acts share one override slot; without the handshake an
    // act would cut a walk short and then release the walk's track.
    bus.roaming = true

    await act(async () => {
      vi.advanceTimersByTime(500 + 100)
    })
    expect(setTrack).not.toHaveBeenCalled()

    // Once the walk ends the acts resume.
    bus.roaming = false
    await act(async () => {
      vi.advanceTimersByTime(1000 + 100)
    })
    expect(setTrack).toHaveBeenCalled()
  })
})
