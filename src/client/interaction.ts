/**
 * The interaction engine: feed an event, get back who reacts and how.
 *
 * Three protections keep a pair of pets from reacting to each other forever —
 * the failure mode the design notes called out as the one that must not happen:
 *
 * 1. **Chain depth.** A reaction may emit a follow-up event, but only up to
 *    {@link DEFAULT_LIMITS.maxChainDepth} hops from the original. Without it,
 *    "A jumps → B looks → A looks back → B looks back" never ends.
 * 2. **Per-pair cooldown.** The same rule cannot fire for the same pet twice
 *    inside {@link DEFAULT_LIMITS.cooldownMs}, so a pet that keeps jumping does
 *    not keep drawing a reaction.
 * 3. **One reaction per pet per pass.** A pet already assigned a reaction in a
 *    pass is skipped by later rules, so two matching rules cannot both drive one
 *    sprite and fight over its track.
 *
 * The engine is pure apart from the cooldown bookkeeping it owns; the clock is
 * injected so tests are deterministic.
 *
 * @module @linxin666/dsh-pet/client/interaction
 */

import type { PetAnimation } from '../state.ts'
import type { Reaction, ReactionRule, World, WorldEvent } from './world.ts'

/** Tuning for the anti-storm guards. */
export interface InteractionLimits {
  /** How many follow-up hops a chain may take before it stops. */
  maxChainDepth: number
  /** Minimum ms between two firings of one rule for one pet. */
  cooldownMs: number
}

/** The shipped limits. */
export const DEFAULT_LIMITS: InteractionLimits = {
  maxChainDepth: 3,
  cooldownMs: 800,
}

/** One resolved reaction, as the caller applies it. */
export interface AppliedReaction {
  /** Pet that reacts. */
  petId: string
  /** Rule that produced it. */
  ruleId: string
  /** Animation to play, when the reaction names one. */
  animation?: PetAnimation
  /** Bubble copy, when the reaction has one. */
  bubble?: string
  /** How long to hold, ms. */
  holdMs?: number
}

/** Why a matched reaction was dropped. */
export interface SuppressedReaction {
  /** Rule that matched. */
  ruleId: string
  /** Pet that would have reacted. */
  petId: string
  /** Machine-readable reason. */
  reason: 'cooldown' | 'already-reacting'
}

/** The engine's answer for one event. */
export interface InteractionResult {
  /** Reactions to apply, in resolution order. */
  reactions: AppliedReaction[]
  /** Events raised by those reactions, for the caller to feed back in. */
  followUps: WorldEvent[]
  /** Matched-but-dropped reactions, for diagnostics. */
  suppressed: SuppressedReaction[]
  /** The depth this pass ran at (0 for an event fed in directly). */
  depth: number
}

/**
 * The rule engine.
 *
 * Owns only the cooldown table; every other input comes from the caller, which
 * keeps it trivially testable and keeps the world free of engine state.
 */
export class InteractionEngine {
  private readonly limits: InteractionLimits
  /** `${ruleId}:${petId}` → epoch ms of the last firing. */
  private readonly lastFired = new Map<string, number>()
  private readonly clock: () => number

  /**
   * @param options.rules - the rules to evaluate, in order.
   * @param options.limits - anti-storm tuning.
   * @param options.now - clock injection for tests.
   */
  constructor(private readonly options: {
    rules: readonly ReactionRule[]
    limits?: Partial<InteractionLimits>
    now?: () => number
  }) {
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) }
    this.clock = options.now ?? (() => Date.now())
  }

  /** The rules in force. */
  get rules(): readonly ReactionRule[] {
    return this.options.rules
  }

  /**
   * Run one event through every rule.
   *
   * @param event - the event to resolve.
   * @param world - the world the rules read.
   * @param depth - how many hops from the originating event (default 0).
   * @returns the reactions to apply plus anything suppressed.
   */
  resolve(event: WorldEvent, world: World, depth = 0): InteractionResult {
    const reactions: AppliedReaction[] = []
    const suppressed: SuppressedReaction[] = []
    const claimed = new Set<string>()
    const at = this.clock()

    // Depth cap: a chain at the limit resolves nothing, so the caller's loop
    // terminates instead of relying on it to count.
    if (depth >= this.limits.maxChainDepth) {
      return { reactions, followUps: [], suppressed, depth }
    }

    for (const rule of this.options.rules) {
      if (!rule.matches(event, world)) continue
      for (const petId of rule.audience(event, world)) {
        // A pet is never the audience of its own event, and never reacts twice
        // in one pass.
        if (petId === event.source) continue
        if (claimed.has(petId)) {
          suppressed.push({ ruleId: rule.id, petId, reason: 'already-reacting' })
          continue
        }
        const key = rule.id + ':' + petId
        const last = this.lastFired.get(key)
        if (last !== undefined && at - last < this.limits.cooldownMs) {
          suppressed.push({ ruleId: rule.id, petId, reason: 'cooldown' })
          continue
        }
        const reaction = rule.react(petId, event, world)
        if (reaction === undefined) continue
        claimed.add(petId)
        this.lastFired.set(key, at)
        reactions.push({
          petId,
          ruleId: rule.id,
          ...(reaction.animation === undefined ? {} : { animation: reaction.animation }),
          ...(reaction.bubble === undefined ? {} : { bubble: reaction.bubble }),
          ...(reaction.holdMs === undefined ? {} : { holdMs: reaction.holdMs }),
        })
      }
    }

    const followUps: WorldEvent[] = []
    for (const { petId, ruleId } of reactions) {
      const rule = this.options.rules.find(candidate => candidate.id === ruleId)
      const reaction = rule?.react(petId, event, world)
      if (reaction?.emit === undefined) continue
      followUps.push(world.record(reaction.emit))
    }
    return { reactions, followUps, suppressed, depth }
  }

  /**
   * Resolve an event and everything it cascades into.
   *
   * Breadth-first, with each hop carrying an incremented depth so the cap
   * applies to the whole chain rather than to a single rule. The `guard` bounds
   * the total work even if a rule emits without a matching reaction, which is
   * the one way the depth cap alone could be bypassed.
   * @param event - the originating event.
   * @param world - the world the rules read.
   * @param guard - hard ceiling on total reactions per call.
   * @returns every reaction in application order.
   */
  resolveChain(event: WorldEvent, world: World, guard = 32): InteractionResult {
    const root = this.resolve(event, world, 0)
    const reactions = [...root.reactions]
    const suppressed = [...root.suppressed]
    let frontier = root.followUps
    let depth = 1
    while (frontier.length > 0 && depth < this.limits.maxChainDepth && reactions.length < guard) {
      const next: WorldEvent[] = []
      for (const followUp of frontier) {
        const result = this.resolve(followUp, world, depth)
        for (const reaction of result.reactions) {
          if (reactions.length >= guard) break
          reactions.push(reaction)
        }
        suppressed.push(...result.suppressed)
        next.push(...result.followUps)
      }
      frontier = next
      depth += 1
    }
    return { reactions, followUps: [], suppressed, depth }
  }

  /** Forget every cooldown (used when the pet list changes). */
  reset(): void {
    this.lastFired.clear()
  }
}
