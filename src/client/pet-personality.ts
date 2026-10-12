/**
 * The shipped interaction rules, and the per-pet personality that makes two
 * pets answer the same event differently.
 *
 * Personality offset
 * ------------------
 * The host feeds every pet the same session activity, so without something
 * pet-specific they would always move in lockstep. A profile here is that
 * something: it says which tracks a pet reaches for, how readily it joins in,
 * and how it reacts to a given event kind. Rules read the profile instead of
 * hardcoding a track, so the same "someone is celebrating" event makes one pet
 * jump along and another glance over.
 *
 * Everything here is data plus pure functions: no React, no timers, no store.
 *
 * @module @linxin666/dsh-pet/client/pet-personality
 */

import type { PetAnimation } from '../state.ts'
import type { Reaction, ReactionRule, World, WorldEvent } from './world.ts'

/**
 * How one pet answers the world.
 *
 * Every field is optional so a pet with no declared profile still works: the
 * shipped defaults apply, and the pet behaves like a neutral companion rather
 * than being excluded from interactions.
 */
export interface PetPersonality {
  /** How readily this pet joins in, 0–1 (higher = more likely to react). */
  sociability?: number
  /**
   * What this pet does when it notices another pet celebrating.
   *
   * The offset lives here: a playful pet jumps along, an aloof one only looks
   * over. Absent means the shipped default for that event kind.
   */
  onCelebrate?: PetAnimation
  /** What this pet does when it notices another pet failing. */
  onFailure?: PetAnimation
  /** Lines this pet may say when reacting; one is picked at random. */
  lines?: Partial<Record<EventKind, string[]>>
}

/**
 * The event kinds the shipped rules understand.
 *
 * Deliberately a small closed set here while {@link WorldEvent.kind} stays an
 * open string: these are the kinds the SHIPPED rules speak, and new sources can
 * add their own without extending this union.
 */
export type EventKind = 'celebrate' | 'failure' | 'arrive'

/**
 * Shipped personalities, keyed by registry id.
 *
 * Sociability is the probability a pet reacts at all, and it is set high on
 * purpose: this is a visible feature, and a pet that ignores its neighbour more
 * often than not reads as broken rather than aloof. The OFFSET between pets is
 * what carries the personality — the dragon still answers a celebration with a
 * glance while the whale girl jumps along — so lowering every number to make
 * them "calmer" would only hide the feature.
 */
export const PET_PERSONALITIES: Record<string, PetPersonality> = {
  // The whale girl is the outgoing one: she joins a celebration instead of
  // only watching it.
  'whale-girl': {
    sociability: 1,
    onCelebrate: 'jumping',
    onFailure: 'failed',
    lines: {
      celebrate: ['耶！', '搞定收工～'],
      failure: ['哎呀……', '没关系，再来一次'],
    },
  },
  'whale-girl-refined': {
    sociability: 0.85,
    onCelebrate: 'waving',
    onFailure: 'waiting',
    lines: {
      celebrate: ['做得不错。', '嗯，收工了。'],
      failure: ['……下次小心。'],
    },
  },
  // The dragon is the aloof one: she acknowledges a celebration rather than
  // joining it, which is the personality offset made visible.
  'long-niang': {
    sociability: 0.8,
    onCelebrate: 'review',
    onFailure: 'waiting',
    lines: {
      celebrate: ['……哦。', '值得高兴吗？'],
      failure: ['早说了吧。'],
    },
  },
  'ouo-neko': {
    sociability: 0.95,
    onCelebrate: 'jumping',
    onFailure: 'failed',
    lines: {
      celebrate: ['喵！', '好耶喵～'],
      failure: ['喵呜……'],
    },
  },
}

/** What an undeclared pet does — a neutral, moderately social companion. */
export const DEFAULT_PERSONALITY: Required<Pick<PetPersonality, 'sociability' | 'onCelebrate' | 'onFailure'>> = {
  sociability: 0.8,
  onCelebrate: 'waving',
  onFailure: 'waiting',
}

/**
 * Resolve one pet's profile, filling the shipped defaults.
 * @param petId - registry id.
 * @returns the effective profile; never partial.
 */
export function personalityOf(petId: string): Required<Pick<PetPersonality, 'sociability' | 'onCelebrate' | 'onFailure'>> & PetPersonality {
  const declared = PET_PERSONALITIES[petId]
  return {
    ...declared,
    sociability: declared?.sociability ?? DEFAULT_PERSONALITY.sociability,
    onCelebrate: declared?.onCelebrate ?? DEFAULT_PERSONALITY.onCelebrate,
    onFailure: declared?.onFailure ?? DEFAULT_PERSONALITY.onFailure,
  }
}

/**
 * Whether a pet joins in, given its sociability.
 *
 * Deterministic by default (`roll` injected) so the rule engine stays pure and
 * the tests do not depend on `Math.random`.
 * @param petId - registry id.
 * @param roll - a 0–1 value; defaults to `Math.random`.
 * @returns true when the pet reacts.
 */
export function joinsIn(petId: string, roll: number = Math.random()): boolean {
  return roll < personalityOf(petId).sociability
}

/** Pick one of a pet's lines for an event kind, or undefined when it has none. */
export function lineFor(petId: string, kind: EventKind, roll: number = Math.random()): string | undefined {
  const lines = personalityOf(petId).lines?.[kind]
  if (lines === undefined || lines.length === 0) return undefined
  return lines[Math.floor(roll * lines.length)] ?? lines[0]
}

/**
 * The shipped rules.
 *
 * One rule per event kind, each reading the audience's personality rather than
 * naming tracks directly — that is what keeps a new pet from needing a rule of
 * its own.
 *
 * @param roll - a 0–1 source for the "does this pet join in" decision, injected
 * so the engine can be tested deterministically.
 * @returns the rules, in evaluation order.
 */
export function defaultRules(roll: () => number = Math.random): ReactionRule[] {
  /**
   * Shared shape for the two "notice what another pet did" rules: everyone else
   * on screen is a candidate, each decides for itself whether to join in, and
   * the reaction comes from that pet's own profile.
   */
  const noticeRule = (options: {
    id: string
    kind: EventKind
    track: (petId: string) => PetAnimation
  }): ReactionRule => ({
    id: options.id,
    matches: (event: WorldEvent) => event.kind === options.kind,
    // Everyone except the source. Proximity is deliberately NOT a filter here:
    // a pet noticing a celebration from across the screen reads as more alive
    // than one that only reacts when the two happen to be close.
    audience: (event: WorldEvent, world: World) => world.ids().filter(id => id !== event.source),
    react: (petId: string, event: WorldEvent): Reaction | undefined => {
      if (!joinsIn(petId, roll())) return undefined
      const bubble = lineFor(petId, options.kind, roll())
      return {
        animation: options.track(petId),
        ...(bubble === undefined ? {} : { bubble }),
        holdMs: 2200,
        // The reaction does not re-raise the same kind, which is what keeps a
        // two-pet exchange from ping-ponging forever even without the caps.
        emit: { source: petId, kind: 'reacted', payload: { to: event.source, about: options.kind } },
      }
    },
  })

  return [
    noticeRule({
      id: 'celebrate-notice',
      kind: 'celebrate',
      track: petId => personalityOf(petId).onCelebrate,
    }),
    noticeRule({
      id: 'failure-notice',
      kind: 'failure',
      track: petId => personalityOf(petId).onFailure,
    }),
  ]
}
