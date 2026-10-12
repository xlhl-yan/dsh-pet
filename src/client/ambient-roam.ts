/**
 * Ambient roaming for every pet, independent of the gameplay layer.
 *
 * The walking machinery already exists: `PetSprite` registers `bus.walk`, which
 * interpolates the sprite across the viewport and persists the resting spot
 * exactly like a drag. Until now only a `gameplay.roam` manifest block reached
 * it, so a plain sprite2d pet could only ever play its in-place running art.
 *
 * This driver is the missing trigger, and it deliberately owns nothing else:
 * no stats, no currency, no modes. It rolls on an interval, asks the sprite to
 * walk, and holds the matching directional track for exactly the travel time.
 * A pet with no walk art still moves — the track is simply left to the phase
 * mapping — so the feature degrades to "the pet slides" rather than breaking.
 *
 * Suppression is shared with the other owners of the pet's visual: a mode, a
 * drag, a touch reaction, a gameplay roam or an idle-director act all win, and
 * this driver stands down for that tick.
 * @module @linxin666/dsh-pet/client/ambient-roam
 */

import { useEffect, useRef } from 'react'
import type { PetDefinition } from '../registry.ts'
import type { PetAnimation } from '../state.ts'
import type { DragStream } from './drag-stream.ts'
import type { GameplayBus } from './gameplay-hud.tsx'

/** The four directions the sprite can walk, matching the manifest vocabulary. */
export type AmbientRoamDirection = 'up' | 'down' | 'left' | 'right'

/** Every direction, used when a pet declares none. */
const ALL_DIRECTIONS: readonly AmbientRoamDirection[] = ['up', 'down', 'left', 'right']

/**
 * Tuning for the ambient driver. Defaults are deliberately calm: a pet that
 * paced constantly would be worse than one that stays put, so the roll is
 * biased towards standing still and the interval is measured in tens of
 * seconds.
 */
export interface AmbientRoamConfig {
  /** How often to roll, ms. */
  intervalMs: number
  /** Chance of walking on a roll (0–1). */
  probability: number
  /** Shortest walk, px. */
  distanceMin: number
  /** Longest walk, px. */
  distanceMax: number
  /** Walk speed, px/s. */
  speed: number
  /** Directions to consider; defaults to all four. */
  directions?: readonly AmbientRoamDirection[]
}

/** The shipped tuning: a slow wander, most rolls ending in no movement. */
export const DEFAULT_AMBIENT_ROAM: AmbientRoamConfig = {
  intervalMs: 15_000,
  probability: 0.35,
  distanceMin: 80,
  distanceMax: 220,
  speed: 90,
}

/**
 * The walk track for a direction, when the pet's atlas has one.
 *
 * `sprite2d` pets draw `running-left` / `running-right` as a walk cycle, so a
 * horizontal walk can show real leg movement. Vertical walks have no art in the
 * 9-row contract (there is no front/back row), so they keep whatever the pet is
 * already playing and read as a slide — acceptable, and better than refusing to
 * move. Returns undefined when the pet's definition has no such track.
 * @param definition - the pet's resolved definition.
 * @param direction - the direction being walked.
 * @returns the track to hold, or undefined to leave the phase mapping alone.
 */
export function walkTrackFor(
  definition: PetDefinition,
  direction: AmbientRoamDirection,
): PetAnimation | undefined {
  if (direction === 'left') return definition.tracks['running-left'] === undefined ? undefined : 'running-left'
  if (direction === 'right') return definition.tracks['running-right'] === undefined ? undefined : 'running-right'
  return undefined
}

/**
 * Read the roaming tuning for one pet.
 *
 * A `gameplay.roam` block wins when the pet declares one: that pet's author
 * already chose its cadence, and the gameplay HUD drives it. Otherwise the
 * shipped defaults apply, so every pet wanders out of the box.
 * @param definition - the pet's resolved definition.
 * @returns the tuning this driver should use.
 */
export function ambientRoamFor(definition: PetDefinition): AmbientRoamConfig {
  const declared = definition.gameplay?.roam
  if (declared === undefined) return DEFAULT_AMBIENT_ROAM
  return {
    intervalMs: declared.intervalMs,
    probability: declared.probability,
    distanceMin: declared.distanceMin,
    distanceMax: declared.distanceMax,
    speed: declared.speed,
    ...(declared.directions === undefined ? {} : { directions: declared.directions as readonly AmbientRoamDirection[] }),
  }
}

/**
 * Drive one pet's ambient wandering.
 *
 * Mounted for every pet, including the ones with a gameplay block — for those
 * the declared cadence is reused, so the pet keeps the rhythm its author chose
 * rather than gaining a second, competing timer.
 *
 * @param props.definition - the pet being driven.
 * @param props.bus - the sprite's coordination bus (`walk` / `setTrack`).
 * @param props.drag - the shared drag stream, so a live drag suppresses a roll.
 * @param props.enabled - false parks the driver entirely (the settings switch).
 */
export function useAmbientRoam(props: {
  definition: PetDefinition
  bus: GameplayBus
  drag: DragStream
  enabled: boolean
}): void {
  const { definition, bus, drag, enabled } = props
  const draggingRef = useRef(false)
  /** True while this driver owns the visual, so its own timer is not pre-empted. */
  const heldRef = useRef(false)
  const releaseTimerRef = useRef(0)

  useEffect(() => {
    return drag.subscribe((dragging) => {
      draggingRef.current = dragging
    })
  }, [drag])

  useEffect(() => {
    if (!enabled) return undefined
    const config = ambientRoamFor(definition)
    /** Drop this driver's claim on the shared track-override slot. */
    const release = (): void => {
      if (releaseTimerRef.current !== 0) {
        window.clearTimeout(releaseTimerRef.current)
        releaseTimerRef.current = 0
      }
      if (!heldRef.current) return
      heldRef.current = false
      bus.setTrack?.(undefined)
    }
    const roll = (): void => {
      // A live drag owns the pet; the walk would fight the pointer.
      if (draggingRef.current) return
      if (heldRef.current) return
      if (Math.random() >= config.probability) return
      const span = config.distanceMax - config.distanceMin
      const distance = config.distanceMin + Math.random() * span
      const directions = config.directions ?? ALL_DIRECTIONS
      const direction = directions[Math.floor(Math.random() * directions.length)] ?? 'left'
      const travelled = bus.walk?.(direction, distance, config.speed) ?? 0
      // The sprite refused (unmounted, already walking, or nowhere to go).
      if (travelled === 0) return
      heldRef.current = true
      // Tell the other owners of this slot (the spontaneous acts) that a walk
      // is in flight, so one does not start mid-walk and then release the slot
      // out from under it.
      bus.roaming = true
      // Only pets whose atlas has a walk row get a directional track; the rest
      // slide on their current animation instead of being forced into a track
      // the atlas cannot draw.
      const track = walkTrackFor(definition, direction)
      if (track !== undefined) bus.setTrack?.(track)
      releaseTimerRef.current = window.setTimeout(() => {
        releaseTimerRef.current = 0
        if (!heldRef.current) return // another owner already took the slot
        heldRef.current = false
        bus.roaming = false
        bus.setTrack?.(undefined)
      }, Math.max(150, (Math.abs(travelled) / Math.max(1, config.speed)) * 1000))
    }
    // Offset the first roll by half an interval so this driver's ticks
    // interleave with the gameplay HUD's rather than landing on the same
    // instant for a pet that has both.
    let timer = 0
    const lead = window.setTimeout(() => {
      roll()
      timer = window.setInterval(roll, config.intervalMs)
    }, Math.round(config.intervalMs / 2))
    return () => {
      window.clearTimeout(lead)
      window.clearInterval(timer)
      release()
    }
  }, [definition, bus, enabled])
}
