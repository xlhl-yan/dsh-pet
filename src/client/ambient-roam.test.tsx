// @vitest-environment jsdom
/**
 * Ambient roaming: every pet wanders, not just the ones with a gameplay block.
 *
 * The walking machinery (`bus.walk`) belongs to the sprite chrome and already
 * existed; what these cases pin is the driver that triggers it for a plain
 * sprite2d pet, the directional track it holds while walking, and the
 * suppression rules that keep it from fighting a drag or a gameplay owner.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import type { PetDefinition, PetTrackDef } from '../registry.ts'
import type { PetAnimation } from '../state.ts'
import type { GameplayBus } from './gameplay-hud.tsx'
import { createDragStream } from './drag-stream.ts'
import {
  DEFAULT_AMBIENT_ROAM,
  ambientRoamFor,
  useAmbientRoam,
  walkTrackFor,
} from './ambient-roam.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function track(frames: number[]): PetTrackDef {
  return { frames, durations: frames.map(() => 300), loop: true }
}

/** A sprite2d definition carrying the nine standard animation rows. */
function definition(overrides: Partial<PetDefinition> = {}): PetDefinition {
  const rows: PetAnimation[] = [
    'idle', 'running-right', 'running-left', 'waving', 'jumping',
    'failed', 'waiting', 'running', 'review',
  ]
  const tracks = Object.fromEntries(rows.map(row => [row, track([0, 1, 2, 3])])) as Record<PetAnimation, PetTrackDef>
  return {
    id: 'whale-girl',
    displayName: '鲸鱼娘',
    description: '',
    renderer: 'sprite2d',
    cell: { width: 192, height: 208 },
    columns: 8,
    rows: [4, 4, 4, 4, 4, 4, 4, 4, 4],
    atlasRows: 9,
    tracks,
    atlasUrl: '/pet/whale-girl/spritesheet.webp',
    manifestUrl: '/pet/whale-girl/pet.json',
    ...overrides,
  } as PetDefinition
}

/** Render the driver hook standalone and hand back its bus. */
function mountDriver(opts: { definition: PetDefinition; enabled?: boolean }): GameplayBus {
  const bus: GameplayBus = {}
  const drag = createDragStream()
  function Probe(): null {
    useAmbientRoam({
      definition: opts.definition,
      bus,
      drag,
      enabled: opts.enabled ?? true,
    })
    return null
  }
  render(createElement(Probe))
  return bus
}

describe('walkTrackFor', () => {
  it('maps a horizontal walk onto the atlas walk rows', () => {
    const def = definition()
    expect(walkTrackFor(def, 'left')).toBe('running-left')
    expect(walkTrackFor(def, 'right')).toBe('running-right')
  })

  it('has no art for a vertical walk, so the current track stays', () => {
    // The 9-row contract has no front/back row: a vertical walk reads as a
    // slide rather than being refused.
    const def = definition()
    expect(walkTrackFor(def, 'up')).toBeUndefined()
    expect(walkTrackFor(def, 'down')).toBeUndefined()
  })

  it('declines a direction the pet cannot draw', () => {
    const def = definition({ tracks: { idle: track([0, 1]) } as never })
    expect(walkTrackFor(def, 'left')).toBeUndefined()
    expect(walkTrackFor(def, 'right')).toBeUndefined()
  })
})

describe('ambientRoamFor', () => {
  it('falls back to the shipped tuning when the pet declares no roam', () => {
    expect(ambientRoamFor(definition())).toEqual(DEFAULT_AMBIENT_ROAM)
  })

  it('reuses a declared gameplay roam cadence', () => {
    const def = definition({
      gameplay: {
        roam: { state: 'move', intervalMs: 5000, probability: 0.5, distanceMin: 10, distanceMax: 20, speed: 50 },
      },
    } as never)
    const config = ambientRoamFor(def)
    // The pet's author already chose this cadence; a second, competing timer
    // would make the pet pace twice as often as declared.
    expect(config.intervalMs).toBe(5000)
    expect(config.probability).toBe(0.5)
    expect(config.speed).toBe(50)
  })

  it('ships a calm default: most rolls end in standing still', () => {
    expect(DEFAULT_AMBIENT_ROAM.probability).toBeLessThan(0.5)
    expect(DEFAULT_AMBIENT_ROAM.intervalMs).toBeGreaterThanOrEqual(10_000)
  })
})

describe('useAmbientRoam', () => {
  it('walks the sprite on a successful roll', () => {
    vi.useFakeTimers()
    const bus = mountDriver({ definition: definition() })
    const walk = vi.fn((_direction: string, _distance: number, _speed: number) => 120)
    bus.walk = walk as never
    vi.spyOn(Math, 'random').mockReturnValue(0)

    // The driver waits half an interval before its first roll.
    vi.advanceTimersByTime(DEFAULT_AMBIENT_ROAM.intervalMs)

    expect(walk).toHaveBeenCalledTimes(1)
    const [direction, distance, speed] = walk.mock.calls[0]!
    expect(['left', 'right', 'up', 'down']).toContain(direction)
    expect(distance).toBeGreaterThanOrEqual(DEFAULT_AMBIENT_ROAM.distanceMin)
    expect(distance).toBeLessThanOrEqual(DEFAULT_AMBIENT_ROAM.distanceMax)
    expect(speed).toBe(DEFAULT_AMBIENT_ROAM.speed)
    vi.restoreAllMocks()
  })

  it('stands still when the roll misses', () => {
    vi.useFakeTimers()
    const bus = mountDriver({ definition: definition() })
    const walk = vi.fn(() => 120)
    bus.walk = walk
    // 0.99 is above the default probability: the pet stays put.
    vi.spyOn(Math, 'random').mockReturnValue(0.99)

    vi.advanceTimersByTime(DEFAULT_AMBIENT_ROAM.intervalMs * 3)

    expect(walk).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('releases the walk track once the travel time elapses', () => {
    vi.useFakeTimers()
    const bus = mountDriver({ definition: definition() })
    const setTrack = vi.fn()
    bus.walk = () => 90
    bus.setTrack = setTrack
    // Math.random is called twice per roll: once for the probability check,
    // once for the direction index. Feed an explicit sequence so the roll
    // succeeds (0.2 < 0.35) and the direction is horizontal (0.75 -> index 3,
    // 'right'), which is the case that takes the override slot.
    const sequence: number[] = [0.2, 0.75]
    vi.spyOn(Math, 'random').mockImplementation(() => sequence.shift() ?? 0.75)

    // The first roll lands half an interval in; step just past it so the
    // release timer (1s for 90px at 90px/s) has not fired yet.
    vi.advanceTimersByTime(DEFAULT_AMBIENT_ROAM.intervalMs / 2 + 10)
    expect(setTrack).toHaveBeenCalled()
    setTrack.mockClear()

    // 90px at the default 90px/s is one second; the release lands just after.
    vi.advanceTimersByTime(1200)
    expect(setTrack).toHaveBeenCalledWith(undefined)
    vi.restoreAllMocks()
  })

  it('leaves the track alone for a direction the atlas cannot draw', () => {
    vi.useFakeTimers()
    const bus = mountDriver({ definition: definition() })
    const setTrack = vi.fn()
    bus.walk = () => 90
    bus.setTrack = setTrack
    // 0.2 is below the probability, so the roll walks; 0 for the direction
    // index picks 'up', which has no art in the 9-row contract.
    const calls: number[] = []
    vi.spyOn(Math, 'random').mockImplementation(() => calls.shift() ?? 0)
    calls.push(0.2, 0)

    vi.advanceTimersByTime(DEFAULT_AMBIENT_ROAM.intervalMs / 2 + 10)

    // The pet still moves (the walk was requested), but nothing forces a track
    // the atlas cannot draw — it slides on whatever it was already playing.
    expect(bus.walk).toBeDefined()
    expect(setTrack).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('does nothing while the driver is parked', () => {
    vi.useFakeTimers()
    const bus = mountDriver({ definition: definition(), enabled: false })
    const walk = vi.fn(() => 120)
    bus.walk = walk
    vi.spyOn(Math, 'random').mockReturnValue(0)

    vi.advanceTimersByTime(DEFAULT_AMBIENT_ROAM.intervalMs * 3)

    expect(walk).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('stands down for a live drag', () => {
    vi.useFakeTimers()
    const bus: GameplayBus = {}
    const drag = createDragStream()
    const walk = vi.fn(() => 120)
    bus.walk = walk
    function Probe(): null {
      useAmbientRoam({ definition: definition(), bus, drag, enabled: true })
      return null
    }
    render(createElement(Probe))
    vi.spyOn(Math, 'random').mockReturnValue(0)

    // A drag in progress owns the pet: a walk would fight the pointer.
    drag.push(true)
    vi.advanceTimersByTime(DEFAULT_AMBIENT_ROAM.intervalMs)
    expect(walk).not.toHaveBeenCalled()

    // Releasing the drag lets the next roll through.
    drag.push(false)
    vi.advanceTimersByTime(DEFAULT_AMBIENT_ROAM.intervalMs)
    expect(walk).toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('gives up when the sprite cannot move', () => {
    vi.useFakeTimers()
    const bus = mountDriver({ definition: definition() })
    // The sprite refuses (unmounted, already walking, or clamped to a wall).
    const walk = vi.fn(() => 0)
    const setTrack = vi.fn()
    bus.walk = walk
    bus.setTrack = setTrack
    vi.spyOn(Math, 'random').mockReturnValue(0)

    vi.advanceTimersByTime(DEFAULT_AMBIENT_ROAM.intervalMs)

    expect(walk).toHaveBeenCalled()
    // A refused walk must not claim the override slot, or the pet would be
    // pinned to a walk track while standing still.
    expect(setTrack).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
