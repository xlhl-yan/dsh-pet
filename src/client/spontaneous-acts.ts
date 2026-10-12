/**
 * Spontaneous acts: a pet doing something on its own, unprompted.
 *
 * Why this exists
 * ---------------
 * The interaction rules react to a pet entering an expressive state
 * (`jumping`, `failed`). With `autonomous` on, the host serves `idle` forever
 * and the pet's own idle sequence only ever cycles through `idle` / `waving` /
 * `waiting` — so nothing expressive ever happens and no rule can ever fire. A
 * pet that only ever breathes has no events to react to.
 *
 * This driver is the missing source: on a slow roll the pet plays a short act
 * of its own, which is both what makes it read as alive and what gives the
 * interaction rules something to notice.
 *
 * Acts are drawn from the pet's own atlas, so a pet whose atlas cannot draw an
 * act simply never rolls it — no manifest change is required for the feature to
 * work.
 *
 * @module @linxin666/dsh-pet/client/spontaneous-acts
 */

import { useEffect, useRef } from 'react'
import type { PetDefinition } from '../registry.ts'
import type { PetAnimation } from '../state.ts'
import type { GameplayBus } from './gameplay-hud.tsx'

/** One act a pet may perform on its own. */
export interface SpontaneousAct {
  /** Track to play. */
  track: PetAnimation
  /** How long to hold it, ms. */
  holdMs: number
  /** Relative likelihood; higher is more frequent. */
  weight: number
  /**
   * Optional lines to show while the act plays. Absent acts are silent, which
   * is what keeps the pets from narrating every stretch.
   */
  lines?: string[]
}

/** Tuning for the act loop. */
export interface SpontaneousActConfig {
  /** How often to roll, ms. */
  intervalMs: number
  /** Chance of acting on a roll (0–1). */
  probability: number
}

/**
 * The shipped cadence.
 *
 * Tuned so an interaction is actually observable. The math matters here: a pet
 * must (a) roll a hit, (b) pick a notable act rather than a silent one, and
 * (c) have the other pet's personality clear its sociability roll. With the
 * earlier 25s / 0.45 / jumping-weight-3 numbers the expected wait for the user
 * to see anything was over five minutes, which reads as "the feature is
 * broken". These values put a notable act roughly every 20–30 seconds.
 */
export const DEFAULT_ACT_CONFIG: SpontaneousActConfig = {
  intervalMs: 12_000,
  probability: 0.6,
}

/**
 * The acts every pet can perform, filtered per pet by what its atlas draws.
 *
 * `jumping` and `failed` are the two that matter for interactions: they are the
 * notable states the shipped rules listen for, so a pet performing one is how an
 * autonomous pet ever produces a `celebrate` / `failure` event. They carry the
 * highest weights for that reason — a purely cosmetic act that no rule reacts to
 * is worth less than one that starts a conversation between two pets.
 */
export const DEFAULT_ACTS: readonly SpontaneousAct[] = [
  { track: 'jumping', holdMs: 1600, weight: 5 },
  { track: 'failed', holdMs: 1600, weight: 3, lines: ['唔……', '有点累了'] },
  { track: 'waving', holdMs: 1500, weight: 3, lines: ['嗨～', '在忙吗？'] },
  { track: 'review', holdMs: 1800, weight: 2, lines: ['让我看看……', '嗯……'] },
]

/**
 * The acts a pet can actually perform.
 *
 * Filtered on the atlas: a pet with no `jumping` row must not be handed that
 * track, because the renderer would fall back to a row it can draw and the act
 * would silently become something else.
 * @param definition - the pet's resolved definition.
 * @param acts - the candidate acts.
 * @returns the performable subset, possibly empty.
 */
export function performableActs(
  definition: PetDefinition,
  acts: readonly SpontaneousAct[] = DEFAULT_ACTS,
): SpontaneousAct[] {
  return acts.filter(act => definition.tracks[act.track] !== undefined)
}

/**
 * Pick one act by weight.
 * @param acts - the candidates; must be non-empty.
 * @param roll - a 0–1 value, injected for tests.
 * @returns the chosen act.
 */
export function pickAct(acts: readonly SpontaneousAct[], roll: number = Math.random()): SpontaneousAct {
  const total = acts.reduce((sum, act) => sum + act.weight, 0)
  let target = roll * total
  for (const act of acts) {
    target -= act.weight
    if (target <= 0) return act
  }
  return acts[acts.length - 1]!
}

/** One line from an act, or undefined when the act is silent. */
export function actLine(act: SpontaneousAct, roll: number = Math.random()): string | undefined {
  if (act.lines === undefined || act.lines.length === 0) return undefined
  return act.lines[Math.floor(roll * act.lines.length)] ?? act.lines[0]
}

/** Everything the driver needs. */
export interface SpontaneousActOptions {
  /** The pet being driven. */
  definition: PetDefinition
  /** The sprite's coordination bus (`setTrack`). */
  bus: GameplayBus
  /** Whether acts run at all. */
  enabled: boolean
  /** Cadence override. */
  config?: SpontaneousActConfig
  /** Candidate acts override. */
  acts?: readonly SpontaneousAct[]
  /**
   * Report a line to show. The driver does not own a bubble surface, so the
   * caller decides where the copy goes.
   */
  onLine?: (text: string) => void
  /** Randomness source, injected for tests. */
  roll?: () => number
}

/**
 * Run the spontaneous-act loop for one pet.
 *
 * Holds the shared track-override slot for the act's duration and releases it
 * afterwards, exactly like the ambient roam — so an act never fights a walk, a
 * mode or a drag for the sprite.
 * @param options - definition, bus, enable flag and overrides.
 */
export function useSpontaneousActs(options: SpontaneousActOptions): void {
  const { definition, bus, enabled } = options
  const config = options.config ?? DEFAULT_ACT_CONFIG
  const acts = options.acts ?? DEFAULT_ACTS
  const rollRef = useRef(options.roll ?? Math.random)
  rollRef.current = options.roll ?? Math.random
  const onLineRef = useRef(options.onLine)
  onLineRef.current = options.onLine
  /** True while an act owns the visual. */
  const heldRef = useRef(false)
  const releaseTimerRef = useRef(0)
  const configRef = useRef(config)
  configRef.current = config

  useEffect(() => {
    if (!enabled) return undefined
    const performable = performableActs(definition, acts)
    // A pet whose atlas draws none of the acts simply never acts; it still
    // participates as an audience for other pets.
    if (performable.length === 0) return undefined

    const release = (): void => {
      if (releaseTimerRef.current !== 0) {
        window.clearTimeout(releaseTimerRef.current)
        releaseTimerRef.current = 0
      }
      if (!heldRef.current) return
      heldRef.current = false
      bus.setTrack?.(undefined)
    }

    const tick = (): void => {
      // An act in flight owns the sprite; starting another would cut it off.
      if (heldRef.current) return
      // A walk in flight also owns it. Starting an act here would cut the walk
      // short, and the act's later release would wipe the walk's own track —
      // the two drivers share one override slot and cannot see each other's
      // timers, so this flag is the handshake.
      if (bus.roaming === true) return
      if (rollRef.current() >= configRef.current.probability) return
      const act = pickAct(performable, rollRef.current())
      heldRef.current = true
      bus.setTrack?.(act.track)
      const line = actLine(act, rollRef.current())
      if (line !== undefined) onLineRef.current?.(line)
      releaseTimerRef.current = window.setTimeout(() => {
        releaseTimerRef.current = 0
        if (!heldRef.current) return
        heldRef.current = false
        bus.setTrack?.(undefined)
      }, act.holdMs)
    }

    // Offset the first roll by half an interval so the pets do not all act on
    // the same tick, and so this timer interleaves with the roam's.
    let timer = 0
    const lead = window.setTimeout(() => {
      tick()
      timer = window.setInterval(tick, configRef.current.intervalMs)
    }, Math.round(configRef.current.intervalMs / 2))
    return () => {
      window.clearTimeout(lead)
      window.clearInterval(timer)
      release()
    }
  }, [definition, bus, enabled, acts])
}
