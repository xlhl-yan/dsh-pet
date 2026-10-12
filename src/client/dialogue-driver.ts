/**
 * The conversation driver: decides when two on-screen pets talk, and feeds
 * their lines into the store one turn at a time.
 *
 * Kept apart from {@link module:@linxin666/dsh-pet/client/dialogue} on purpose:
 * that module is pure (script lookup, pair choice, turn planning) and therefore
 * trivially testable, while this one owns the timers, the store writes and the
 * React lifecycle.
 *
 * The driver reads the pet list from the store rather than taking it as a prop,
 * so a pet added or removed mid-session is picked up on the next roll without
 * restarting anything.
 *
 * @module @linxin666/dsh-pet/client/dialogue-driver
 */

import { useEffect, useRef } from 'react'
import type { PetStoreInstance } from './pet-store.ts'
import {
  DEFAULT_DIALOGUE_CONFIG,
  DEFAULT_DIALOGUE_SCRIPT,
  nextPair,
  nextUtterance,
  scriptedProducer,
  type DialogueConfig,
  type DialogueProducer,
  type DialogueScript,
} from './dialogue.ts'

/** Everything the driver needs, with the shipped defaults pre-applied. */
export interface DialogueDriverOptions {
  /** The store the lines are written into. */
  store: PetStoreInstance
  /** Whether conversations run at all (the settings switch). */
  enabled: boolean
  /** The scripted pairs; a model-backed producer replaces this. */
  script?: DialogueScript
  /** The line source; defaults to the scripted producer over `script`. */
  producer?: DialogueProducer
  /** Loop tuning. */
  config?: DialogueConfig
}

/**
 * Run the conversation loop for the pets currently on screen.
 *
 * One conversation at a time, separated by the configured interval, and capped
 * at `maxTurns` lines. A pet removed mid-conversation ends it: the remaining
 * lines would otherwise be spoken by a sprite that is no longer there.
 * @param options - store, enable flag and script/tuning overrides.
 */
export function usePetDialogue(options: DialogueDriverOptions): void {
  const { store, enabled } = options
  const script = options.script ?? DEFAULT_DIALOGUE_SCRIPT
  const config = options.config ?? DEFAULT_DIALOGUE_CONFIG
  // The producer and config are read through refs so changing them (a settings
  // edit, an HMR swap) never restarts the loop and loses the cooldown.
  const producerRef = useRef<DialogueProducer>(options.producer ?? scriptedProducer(script))
  producerRef.current = options.producer ?? scriptedProducer(script)
  const configRef = useRef(config)
  configRef.current = config
  /** Conversations run this session; drives the opener rotation. */
  const conversationIndexRef = useRef(0)

  useEffect(() => {
    if (!enabled) return undefined
    let cancelled = false
    let timer = 0
    /** Pending line timeout, cleared when a conversation ends early. */
    const lineTimers: number[] = []

    const clearLineTimers = (): void => {
      for (const id of lineTimers.splice(0)) window.clearTimeout(id)
    }

    const runConversation = async (): Promise<void> => {
      if (cancelled) return
      const state = store.getSnapshot()
      const petIds = (state.snapshot?.pets ?? []).map(pet => pet.id)
      const pair = nextPair(script, petIds, conversationIndexRef.current)
      if (pair === undefined) return
      conversationIndexRef.current += 1
      const { lineMs, maxTurns } = configRef.current
      let previous: string | undefined
      for (let turn = 0; turn < maxTurns; turn += 1) {
        if (cancelled) return
        const utterance = await nextUtterance(producerRef.current, pair, turn, previous, maxTurns)
        if (utterance === undefined) return
        if (cancelled) return
        // A pet that left the screen mid-conversation takes the rest of it
        // with it: speaking for an absent sprite would leave a bubble with no
        // owner.
        const stillOnScreen = (store.getSnapshot().snapshot?.pets ?? []).some(pet => pet.id === utterance.petId)
        if (!stillOnScreen) return
        previous = utterance.text
        store.actions.setFeedback(utterance.petId, {
          text: utterance.text,
          kind: 'dialogue',
          at: Date.now(),
          ...(utterance.animation === undefined ? {} : { animation: utterance.animation }),
        })
        // Hold the line for its own duration, then clear it so the pet does not
        // keep a stale bubble until the next poll.
        await new Promise<void>((resolve) => {
          const id = window.setTimeout(() => {
            const index = lineTimers.indexOf(id)
            if (index >= 0) lineTimers.splice(index, 1)
            if (!cancelled) store.actions.setFeedback(utterance.petId, null)
            resolve()
          }, lineMs)
          lineTimers.push(id)
        })
      }
    }

    // Offset the first roll by half an interval so the pets do not talk the
    // instant the page loads, and so this timer interleaves with the ambient
    // roam's rather than landing on the same tick.
    const lead = window.setTimeout(() => {
      if (Math.random() < configRef.current.probability) void runConversation()
      timer = window.setInterval(() => {
        if (Math.random() < configRef.current.probability) void runConversation()
      }, configRef.current.intervalMs)
    }, Math.round(configRef.current.intervalMs / 2))

    return () => {
      cancelled = true
      window.clearTimeout(lead)
      window.clearInterval(timer)
      clearLineTimers()
    }
  }, [store, enabled, script])
}
