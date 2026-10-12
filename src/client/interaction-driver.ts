/**
 * The interaction driver: owns the world and the rule engine, watches what the
 * pets are actually doing, and turns significant changes into reactions.
 *
 * Why the driver watches the sprites rather than the host
 * -------------------------------------------------------
 * The host serves one shared activity projection, and with `autonomous` on it
 * serves none at all. What a pet is REALLY playing is decided in the browser:
 * an idle routine, an ambient walk, a gameplay loop, a dialogue line. So the
 * sprites publish their effective animation into the world (see
 * {@link usePetWorldPresence}) and this driver watches for the handful of
 * states worth reacting to.
 *
 * @module @linxin666/dsh-pet/client/interaction-driver
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { PetAnimation } from '../state.ts'
import type { PetStoreInstance } from './pet-store.ts'
import { InteractionEngine, type InteractionLimits } from './interaction.ts'
import { defaultRules } from './pet-personality.ts'
import { World, type WorldEvent } from './world.ts'

/**
 * Animations worth broadcasting to the other pets.
 *
 * Only the terminal, expressive states: a pet that is merely running or waiting
 * is not telling the others anything, and broadcasting every frame change would
 * flood the log with noise the cooldown would then have to absorb.
 */
const NOTABLE_ANIMATIONS: Partial<Record<PetAnimation, string>> = {
  jumping: 'celebrate',
  failed: 'failure',
}

/** How long a reaction's bubble stays up when the reaction does not say. */
const DEFAULT_HOLD_MS = 2200

/** Everything the driver needs. */
export interface InteractionDriverOptions {
  /** The store the reactions are written into. */
  store: PetStoreInstance
  /** Whether interactions run at all (the settings switch). */
  enabled: boolean
  /** The world the sprites publish into; the driver reads and records. */
  world: World
  /** Anti-storm tuning. */
  limits?: Partial<InteractionLimits>
  /** Randomness source for the "does this pet join in" roll. */
  roll?: () => number
}

/**
 * Build the world and engine for one dock.
 *
 * Memoised on the world identity so a re-render never rebuilds the engine (which
 * would drop every cooldown and let a storm through).
 * @param world - the world the sprites publish into.
 * @param limits - anti-storm tuning.
 * @param roll - randomness source.
 * @returns the engine.
 */
export function createEngine(
  world: World,
  limits?: Partial<InteractionLimits>,
  roll: () => number = Math.random,
): InteractionEngine {
  return new InteractionEngine({
    rules: defaultRules(roll),
    ...(limits === undefined ? {} : { limits }),
    now: () => world.now(),
  })
}

/**
 * Run the interaction loop.
 *
 * Watches each pet's published animation and raises an event when one of them
 * enters a notable state. Reactions are written into the store as feedback
 * bubbles carrying their animation, which is the same channel a dialogue line
 * uses — so a reacting pet visibly does something instead of only speaking.
 *
 * @param options - store, enable flag, world and tuning.
 */
export function usePetInteractions(options: InteractionDriverOptions): void {
  const { store, enabled, world } = options
  const rollRef = useRef(options.roll ?? Math.random)
  rollRef.current = options.roll ?? Math.random
  const engine = useMemo(
    () => createEngine(world, options.limits, () => rollRef.current()),
    [world, options.limits],
  )
  /** Last animation seen per pet, so only transitions raise an event. */
  const lastAnimation = useRef(new Map<string, PetAnimation>())

  useEffect(() => {
    if (!enabled) {
      lastAnimation.current.clear()
      engine.reset()
      return undefined
    }
    let timer = 0
    const pendingHolds: number[] = []

    const tick = (): void => {
      const presences = world.all()
      const live = new Set(presences.map(presence => presence.id))
      for (const id of [...lastAnimation.current.keys()]) {
        if (!live.has(id)) lastAnimation.current.delete(id)
      }
      for (const presence of presences) {
        const previous = lastAnimation.current.get(presence.id)
        lastAnimation.current.set(presence.id, presence.animation)
        // Only a TRANSITION into a notable state counts. Without this a pet
        // that holds `jumping` for a second would re-raise the event on every
        // tick, and the cooldown would be doing all the work.
        if (previous === presence.animation) continue
        const kind = NOTABLE_ANIMATIONS[presence.animation]
        if (kind === undefined) continue
        const event = world.record({ source: presence.id, kind })
        applyResult(event)
      }
    }

    const applyResult = (event: WorldEvent): void => {
      const result = engine.resolveChain(event, world)
      for (const reaction of result.reactions) {
        store.actions.setFeedback(reaction.petId, {
          text: reaction.bubble ?? '',
          kind: 'dialogue',
          at: Date.now(),
          ...(reaction.animation === undefined ? {} : { animation: reaction.animation }),
        })
        // A reaction with no copy still needs to clear, or the empty bubble
        // would sit there until the next poll replaced it.
        const holdMs = reaction.holdMs ?? DEFAULT_HOLD_MS
        const id = window.setTimeout(() => {
          const index = pendingHolds.indexOf(id)
          if (index >= 0) pendingHolds.splice(index, 1)
          store.actions.setFeedback(reaction.petId, null)
        }, holdMs)
        pendingHolds.push(id)
      }
    }

    // A short poll rather than a subscription: the sprites write into the world
    // imperatively (they are not React state), and 250ms is well below the
    // threshold at which a reaction reads as late.
    timer = window.setInterval(tick, 250)
    return () => {
      window.clearInterval(timer)
      for (const id of pendingHolds.splice(0)) window.clearTimeout(id)
    }
  }, [store, enabled, world, engine])
}

/**
 * Publish one pet's effective animation into the world.
 *
 * Called by the sprite with the animation it is ACTUALLY playing (after the
 * dialogue override, the roam override and the host snapshot have been
 * resolved), because that is what the other pets can see.
 *
 * @param world - the world to publish into.
 * @param presence - the pet's current state, or undefined while it is not
 * rendering (the hook then removes it).
 */
/**
 * Publish one pet's presence into the world, tracking the animation the sprite
 * reports rather than the one the host snapshot carries.
 *
 * The distinction matters: with `autonomous` on the host serves `idle` forever,
 * so a presence built from the snapshot would tell every rule that nothing ever
 * happens — and no interaction could ever fire. The sprite's reported animation
 * includes its own overrides (a roam walk, a gameplay act, a dialogue line),
 * which is what another pet can actually see.
 *
 * @param world - the world to publish into.
 * @param presence - the pet's identity, phase and geometry; undefined while it
 * is not rendering, which removes it from the world.
 * @returns the callback the sprite calls with its resolved animation.
 */
export function usePetWorldPresence(
  world: World,
  presence: {
    id: string
    phase: Parameters<World['setPresence']>[0]['phase']
    right: number
    bottom: number
    width: number
    height: number
  } | undefined,
): (animation: string) => void {
  const { id, phase, right, bottom, width, height } = presence ?? {}
  /** The last animation the sprite reported; survives geometry re-renders. */
  const animationRef = useRef<PetAnimation>('idle')

  useEffect(() => {
    if (id === undefined || phase === undefined) return undefined
    world.setPresence({
      id,
      animation: animationRef.current,
      phase,
      right: right ?? 0,
      bottom: bottom ?? 0,
      width: width ?? 0,
      height: height ?? 0,
    })
    return () => { world.remove(id) }
  }, [world, id, phase, right, bottom, width, height])

  // Stable per geometry, so the sprite's reporting effect does not re-fire on
  // every render (which would rewrite the presence each frame).
  return useCallback((animation: string) => {
    if (id === undefined) return
    const next = animation as PetAnimation
    if (animationRef.current === next) return
    animationRef.current = next
    world.setPresence({
      id,
      animation: next,
      phase: phase ?? 'idle',
      right: right ?? 0,
      bottom: bottom ?? 0,
      width: width ?? 0,
      height: height ?? 0,
    })
  }, [world, id, phase, right, bottom, width, height])
}
