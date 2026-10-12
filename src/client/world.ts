/**
 * The shared world: what every on-screen pet is doing, and what just happened.
 *
 * Why this lives in the browser half
 * ----------------------------------
 * The host projects ONE session activity stream, so every pet's machine is fed
 * the same input and they end up showing the same phase — the "always in sync"
 * problem the design notes flagged. With `autonomous` on, the host serves no
 * activity at all, so there is nothing to differentiate pets from up there.
 *
 * The pets' real, independent behaviour (idle routines, ambient roaming,
 * gameplay loops, dialogue) is driven client-side. This module is therefore the
 * first place that can answer "what is each pet actually doing right now", which
 * is exactly what an interaction rule needs to read.
 *
 * What it is NOT
 * --------------
 * Not a store and not a renderer. It holds no React state and does not draw
 * anything: pets publish their state, rules read it, and the subscribers decide
 * what to do. Keeping it framework-free is what lets the rule engine be tested
 * as plain functions.
 *
 * @module @linxin666/dsh-pet/client/world
 */

import type { ActivityPhase, PetAnimation } from '../state.ts'

/** One pet's presence in the world. */
export interface PetPresence {
  /** Registry id. */
  id: string
  /** Animation the sprite is playing right now. */
  animation: PetAnimation
  /** Activity phase driving it. */
  phase: ActivityPhase
  /** Horizontal inset from the viewport right edge, px. */
  right: number
  /** Vertical inset from the viewport bottom edge, px. */
  bottom: number
  /** Rendered sprite size, px — needed to reason about proximity. */
  width: number
  /** Rendered sprite size, px. */
  height: number
  /** Epoch ms this presence was last written. */
  at: number
}

/**
 * Something one pet did that another pet could react to.
 *
 * `kind` is an open string rather than a closed union on purpose: new event
 * sources (a model switch, a token theft) are meant to be added by emitting a
 * new kind, without touching this type or the engine.
 */
export interface WorldEvent {
  /** Epoch ms the event was raised. */
  at: number
  /** Pet that caused it. */
  source: string
  /** What happened. */
  kind: string
  /** Pet it was aimed at, when the event is directed. */
  target?: string
  /** Free-form detail for rules that need it. */
  payload?: unknown
}

/** A reaction one pet may have to an event. */
export interface Reaction {
  /** Animation to play. */
  animation?: PetAnimation
  /** Bubble copy. */
  bubble?: string
  /** How long the reaction holds, ms (informational for the caller). */
  holdMs?: number
  /**
   * A follow-up event this reaction raises, which is how chains form. The
   * engine caps how deep they may go.
   */
  emit?: Omit<WorldEvent, 'at'>
}

/** A rule: when an event matches, which pets react and how. */
export interface ReactionRule {
  /** Stable id, used for cooldown bookkeeping and diagnostics. */
  id: string
  /** Whether this event concerns this rule. */
  matches: (event: WorldEvent, world: World) => boolean
  /**
   * The pets that react, excluding the source.
   *
   * Returns ids rather than a single one so a rule can address several pets
   * (everyone looks up at a celebration, for instance).
   */
  audience: (event: WorldEvent, world: World) => string[]
  /**
   * One pet's reaction, or undefined when this pet sits it out.
   *
   * Per pet rather than per rule: two pets watching the same event should be
   * able to answer differently, which is the whole point of the split.
   */
  react: (petId: string, event: WorldEvent, world: World) => Reaction | undefined
}

/** The result of feeding one event through the engine. */
export interface InteractionOutcome {
  /** One entry per reacting pet, in resolution order. */
  reactions: { petId: string; reaction: Reaction }[]
  /** Events raised by reactions, which the caller may feed back in. */
  followUps: WorldEvent[]
  /** Rules that matched but were suppressed, for diagnostics. */
  suppressed: { ruleId: string; petId: string; reason: string }[]
}

/**
 * The world: pet presences plus a bounded recent-event log.
 *
 * A plain class rather than a hook so the rule engine can be exercised without
 * React, and so the host-side code could reuse it later if interactions ever
 * need to be authoritative outside the browser.
 */
export class World {
  private readonly presences = new Map<string, PetPresence>()
  private readonly log: WorldEvent[] = []
  private clock: number

  /**
   * @param options.now - clock injection, for deterministic tests.
   * @param options.maxEvents - how many recent events to retain.
   */
  constructor(private readonly options: { now?: () => number; maxEvents?: number } = {}) {
    this.clock = 0
  }

  /** Current time according to the injected clock. */
  now(): number {
    this.clock = this.options.now?.() ?? Date.now()
    return this.clock
  }

  /** How many events the log retains (default 32). */
  get maxEvents(): number {
    return this.options.maxEvents ?? 32
  }

  /**
   * Record or update one pet's presence.
   * @param presence - the pet's current state.
   */
  setPresence(presence: Omit<PetPresence, 'at'>): void {
    this.presences.set(presence.id, { ...presence, at: this.now() })
  }

  /** Drop a pet that left the screen. */
  remove(id: string): void {
    this.presences.delete(id)
  }

  /** One pet's presence, when it is on screen. */
  presence(id: string): PetPresence | undefined {
    return this.presences.get(id)
  }

  /** Every presence, in insertion order (the render order). */
  all(): PetPresence[] {
    return [...this.presences.values()]
  }

  /** Every on-screen pet id, in insertion order. */
  ids(): string[] {
    return [...this.presences.keys()]
  }

  /**
   * Record an event.
   *
   * The log is bounded and trimmed oldest-first: rules only ever ask about
   * recent activity, and an unbounded log would grow for the life of the page.
   * @param event - the event, stamped with the current time.
   */
  record(event: Omit<WorldEvent, 'at'>): WorldEvent {
    const stamped: WorldEvent = { ...event, at: this.now() }
    this.log.push(stamped)
    while (this.log.length > this.maxEvents) this.log.shift()
    return stamped
  }

  /** The recent events, oldest first. */
  recent(): readonly WorldEvent[] {
    return this.log
  }

  /**
   * The most recent event of a kind within a window, if any.
   * @param kind - the event kind to look for.
   * @param withinMs - how far back to look.
   */
  lastOfKind(kind: string, withinMs: number): WorldEvent | undefined {
    const cutoff = this.now() - withinMs
    for (let index = this.log.length - 1; index >= 0; index -= 1) {
      const event = this.log[index]!
      if (event.at < cutoff) break
      if (event.kind === kind) return event
    }
    return undefined
  }

  /**
   * Euclidean distance between two pets' centres, px.
   * @param a - one pet id.
   * @param b - the other pet id.
   * @returns the distance, or undefined when either pet is not on screen.
   */
  distanceBetween(a: string, b: string): number | undefined {
    const first = this.presences.get(a)
    const second = this.presences.get(b)
    if (first === undefined || second === undefined) return undefined
    // `right`/`bottom` are insets from the viewport's right/bottom edges, so the
    // horizontal axis points the other way; only the magnitude matters here.
    const dx = first.right - second.right
    const dy = first.bottom - second.bottom
    return Math.hypot(dx, dy)
  }

  /** Drop every presence and event (used when the dock unmounts). */
  clear(): void {
    this.presences.clear()
    this.log.length = 0
  }
}
