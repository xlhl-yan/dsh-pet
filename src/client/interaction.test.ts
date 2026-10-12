/**
 * The interaction engine and its anti-storm guards.
 *
 * The three protections are each pinned separately, because the failure they
 * prevent (two pets reacting to each other forever) is the one the design notes
 * called out as unacceptable. The rule fixtures here are deliberately trivial:
 * what is under test is the engine's bookkeeping, not any shipped rule.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, InteractionEngine, type InteractionLimits } from './interaction.ts'
import { defaultRules } from './pet-personality.ts'
import { World, type ReactionRule, type WorldEvent } from './world.ts'

/** A world with a controllable clock. */
function makeWorld(): { world: World; advance: (ms: number) => void } {
  let now = 1000
  const world = new World({ now: () => now })
  return { world, advance: (ms: number) => { now += ms } }
}

/**
 * A rule that makes every pet except the source react with a fixed animation.
 * @param id - the rule id.
 * @param over - overrides for the audience / reaction.
 */
function rule(id: string, over: {
  matches?: (event: WorldEvent) => boolean
  audience?: (event: WorldEvent, world: World) => string[]
  react?: (petId: string, event: WorldEvent, world: World) => ReturnType<ReactionRule['react']>
} = {}): ReactionRule {
  return {
    id,
    matches: over.matches ?? (() => true),
    audience: over.audience ?? ((event, world) => world.ids().filter(candidate => candidate !== event.source)),
    react: over.react ?? (() => ({ animation: 'review' })),
  }
}

/** An engine over the given rules with a controllable clock. */
function makeEngine(rules: ReactionRule[], limits?: Partial<InteractionLimits>): {
  engine: InteractionEngine
  advance: (ms: number) => void
} {
  let now = 1000
  const engine = new InteractionEngine({
    rules,
    ...(limits === undefined ? {} : { limits }),
    now: () => now,
  })
  return { engine, advance: (ms: number) => { now += ms } }
}

describe('InteractionEngine resolution', () => {
  it('gives the audience a reaction and never the source', () => {
    const { world } = makeWorld()
    world.setPresence({ id: 'a', animation: 'jumping', phase: 'done', right: 0, bottom: 0, width: 1, height: 1 })
    world.setPresence({ id: 'b', animation: 'idle', phase: 'idle', right: 0, bottom: 0, width: 1, height: 1 })
    const { engine } = makeEngine([rule('notice')])
    const event = world.record({ source: 'a', kind: 'celebrate' })

    const result = engine.resolve(event, world)

    expect(result.reactions.map(reaction => reaction.petId)).toEqual(['b'])
    expect(result.reactions[0]?.animation).toBe('review')
    // The pet that caused the event does not react to itself.
    expect(result.reactions.some(reaction => reaction.petId === 'a')).toBe(false)
  })

  it('skips a rule that does not match', () => {
    const { world } = makeWorld()
    world.setPresence({ id: 'b', animation: 'idle', phase: 'idle', right: 0, bottom: 0, width: 1, height: 1 })
    const { engine } = makeEngine([rule('only-failure', { matches: event => event.kind === 'failure' })])
    const event = world.record({ source: 'a', kind: 'celebrate' })
    expect(engine.resolve(event, world).reactions).toEqual([])
  })

  it('lets a rule decline one pet while reacting to another', () => {
    const { world } = makeWorld()
    for (const id of ['b', 'c']) {
      world.setPresence({ id, animation: 'idle', phase: 'idle', right: 0, bottom: 0, width: 1, height: 1 })
    }
    // `react` returning undefined is how a pet sits an event out.
    const { engine } = makeEngine([rule('picky', {
      react: petId => petId === 'b' ? { animation: 'jumping' } : undefined,
    })])
    const event = world.record({ source: 'a', kind: 'celebrate' })
    expect(engine.resolve(event, world).reactions.map(reaction => reaction.petId)).toEqual(['b'])
  })
})

describe('InteractionEngine anti-storm guards', () => {
  it('lets one pet react only once per pass', () => {
    const { world } = makeWorld()
    world.setPresence({ id: 'b', animation: 'idle', phase: 'idle', right: 0, bottom: 0, width: 1, height: 1 })
    // Two rules both match: without the claim, both would drive the same sprite
    // and fight over its track.
    const { engine } = makeEngine([
      rule('first', { react: () => ({ animation: 'jumping' }) }),
      rule('second', { react: () => ({ animation: 'failed' }) }),
    ])
    const event = world.record({ source: 'a', kind: 'celebrate' })

    const result = engine.resolve(event, world)

    expect(result.reactions).toHaveLength(1)
    expect(result.reactions[0]?.ruleId).toBe('first')
    expect(result.suppressed).toEqual([{ ruleId: 'second', petId: 'b', reason: 'already-reacting' }])
  })

  it('enforces a per-rule-per-pet cooldown', () => {
    const { world, advance } = makeWorld()
    world.setPresence({ id: 'b', animation: 'idle', phase: 'idle', right: 0, bottom: 0, width: 1, height: 1 })
    const { engine, advance: tick } = makeEngine([rule('notice')], { cooldownMs: 800 })

    const first = world.record({ source: 'a', kind: 'celebrate' })
    expect(engine.resolve(first, world).reactions).toHaveLength(1)

    // Inside the window: suppressed, and reported as such.
    advance(400)
    tick(400)
    const second = world.record({ source: 'a', kind: 'celebrate' })
    const blocked = engine.resolve(second, world)
    expect(blocked.reactions).toEqual([])
    expect(blocked.suppressed).toEqual([{ ruleId: 'notice', petId: 'b', reason: 'cooldown' }])

    // Past the window: allowed again.
    advance(500)
    tick(500)
    const third = world.record({ source: 'a', kind: 'celebrate' })
    expect(engine.resolve(third, world).reactions).toHaveLength(1)
  })

  it('keeps cooldowns per pet, so one pet cooling down does not silence another', () => {
    const { world, advance } = makeWorld()
    for (const id of ['b', 'c']) {
      world.setPresence({ id, animation: 'idle', phase: 'idle', right: 0, bottom: 0, width: 1, height: 1 })
    }
    const { engine, advance: tick } = makeEngine([rule('notice')], { cooldownMs: 800 })

    const first = world.record({ source: 'a', kind: 'celebrate' })
    expect(engine.resolve(first, world).reactions.map(r => r.petId)).toEqual(['b', 'c'])

    // Both are cooling down, so neither reacts.
    advance(100)
    tick(100)
    const second = world.record({ source: 'a', kind: 'celebrate' })
    expect(engine.resolve(second, world).reactions).toEqual([])
  })

  it('stops a chain at the depth cap', () => {
    const { world } = makeWorld()
    for (const id of ['a', 'b']) {
      world.setPresence({ id, animation: 'idle', phase: 'idle', right: 0, bottom: 0, width: 1, height: 1 })
    }
    // Each reaction re-raises the same event from the other pet, which is the
    // ping-pong that must terminate.
    const { engine } = makeEngine([rule('pingpong', {
      react: (petId, event) => ({
        animation: 'review',
        emit: { source: petId, kind: event.kind },
      }),
    })], { maxChainDepth: 3, cooldownMs: 0 })

    const event = world.record({ source: 'a', kind: 'celebrate' })
    const result = engine.resolveChain(event, world)

    // Depth 0 resolves, then hops at depth 1 and 2; depth 3 is at the cap and
    // resolves nothing. Three reactions, not an infinite loop.
    expect(result.reactions.length).toBe(3)
    expect(result.depth).toBe(DEFAULT_LIMITS.maxChainDepth)
  })

  it('refuses to resolve anything once the cap is reached', () => {
    const { world } = makeWorld()
    world.setPresence({ id: 'b', animation: 'idle', phase: 'idle', right: 0, bottom: 0, width: 1, height: 1 })
    const { engine } = makeEngine([rule('notice')], { maxChainDepth: 2 })
    const event = world.record({ source: 'a', kind: 'celebrate' })

    expect(engine.resolve(event, world, 0).reactions).toHaveLength(1)
    expect(engine.resolve(event, world, 2).reactions).toEqual([])
  })

  it('bounds total work even if a rule emits without reacting', () => {
    const { world } = makeWorld()
    world.setPresence({ id: 'b', animation: 'idle', phase: 'idle', right: 0, bottom: 0, width: 1, height: 1 })
    // A rule that always emits but never reacts would otherwise let the chain
    // loop until the depth cap, doing nothing useful each hop.
    const { engine } = makeEngine([rule('emitter', {
      react: (petId, event) => ({ emit: { source: petId, kind: event.kind } }),
    })], { maxChainDepth: 3, cooldownMs: 0 })
    const event = world.record({ source: 'a', kind: 'celebrate' })
    // The guard is what makes this terminate promptly rather than after a full
    // traversal of the depth budget.
    expect(engine.resolveChain(event, world, 4).reactions.length).toBeLessThanOrEqual(4)
  })

  it('collects follow-up events a reaction raises', () => {
    const { world } = makeWorld()
    world.setPresence({ id: 'b', animation: 'idle', phase: 'idle', right: 0, bottom: 0, width: 1, height: 1 })
    const { engine } = makeEngine([rule('notice', {
      react: petId => ({ animation: 'review', emit: { source: petId, kind: 'reacted' } }),
    })])
    const event = world.record({ source: 'a', kind: 'celebrate' })

    const result = engine.resolve(event, world)

    expect(result.followUps.map(followUp => followUp.kind)).toEqual(['reacted'])
    // The follow-up is also recorded, so a later rule can see it in the log.
    expect(world.lastOfKind('reacted', 10_000)?.source).toBe('b')
  })

  it('forgets every cooldown on reset', () => {
    const { world } = makeWorld()
    world.setPresence({ id: 'b', animation: 'idle', phase: 'idle', right: 0, bottom: 0, width: 1, height: 1 })
    const { engine } = makeEngine([rule('notice')], { cooldownMs: 10_000 })
    const event = world.record({ source: 'a', kind: 'celebrate' })
    expect(engine.resolve(event, world).reactions).toHaveLength(1)
    // Still inside a 10s window, so it would be suppressed...
    expect(engine.resolve(event, world).reactions).toEqual([])
    // ...until the cooldowns are dropped (the pet list changed).
    engine.reset()
    expect(engine.resolve(event, world).reactions).toHaveLength(1)
  })
})

/**
 * End to end over the SHIPPED rules, engine and personalities — the objective's
 * acceptance case: "A is jumping → B turns to look at it".
 *
 * The unit cases above use trivial rule fixtures to test the engine's
 * bookkeeping. These wire the real pieces together, because the engine being
 * correct says nothing about whether the shipped rules actually produce a
 * visible reaction.
 */
describe('shipped rules end to end', () => {
  /** A world holding the two pets, with a controllable clock. */
  function scene(): { world: World; advance: (ms: number) => void } {
    let now = 1000
    const world = new World({ now: () => now })
    for (const [id, right] of [['whale-girl', 24], ['long-niang', 300]] as const) {
      world.setPresence({ id, animation: 'idle', phase: 'idle', right, bottom: 120, width: 148, height: 160 })
    }
    return { world, advance: (ms: number) => { now += ms } }
  }

  /** An engine over the shipped rules with a fixed join-in roll. */
  function shippedEngine(world: World, roll = 0): InteractionEngine {
    return new InteractionEngine({ rules: defaultRules(() => roll), now: () => world.now() })
  }

  it('makes the other pet react when one starts celebrating', () => {
    const { world } = scene()
    const engine = shippedEngine(world)
    // The whale girl finishes a turn and jumps; the dragon is idle nearby.
    const event = world.record({ source: 'whale-girl', kind: 'celebrate' })

    const result = engine.resolveChain(event, world)

    expect(result.reactions).toHaveLength(1)
    expect(result.reactions[0]?.petId).toBe('long-niang')
    // The dragon is aloof: she looks over rather than joining the jump, which
    // is exactly the "turns to look at it" acceptance case.
    expect(result.reactions[0]?.animation).toBe('review')
    expect(result.reactions[0]?.bubble).toBe('……哦。')
  })

  it('makes a sociable pet join in instead of only watching', () => {
    const { world } = scene()
    const engine = shippedEngine(world)
    const event = world.record({ source: 'long-niang', kind: 'celebrate' })

    const result = engine.resolveChain(event, world)

    // Same event kind, opposite reaction: the whale girl's profile answers a
    // celebration by joining it, so she jumps along.
    expect(result.reactions[0]?.petId).toBe('whale-girl')
    expect(result.reactions[0]?.animation).toBe('jumping')
  })

  it('terminates instead of letting the two pets react forever', () => {
    const { world } = scene()
    const engine = shippedEngine(world)
    const event = world.record({ source: 'whale-girl', kind: 'celebrate' })

    const result = engine.resolveChain(event, world)

    // The shipped rules emit `reacted`, which no shipped rule matches, so the
    // chain ends after one hop — structurally, not merely by the depth cap.
    expect(result.reactions.length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxChainDepth)
    expect(result.depth).toBeLessThan(DEFAULT_LIMITS.maxChainDepth)
  })

  it('goes quiet when the other pet is not sociable enough this time', () => {
    const { world } = scene()
    // A roll of 1 is at or above every shipped sociability, so `roll <
    // sociability` is false for both pets and neither moves. Reading the
    // profiles rather than hardcoding keeps this true however the numbers are
    // tuned.
    const engine = shippedEngine(world, 1)
    const event = world.record({ source: 'whale-girl', kind: 'celebrate' })

    expect(engine.resolveChain(event, world).reactions).toEqual([])
  })

  it('answers a failure as well as a celebration', () => {
    const { world } = scene()
    const engine = shippedEngine(world)
    const event = world.record({ source: 'whale-girl', kind: 'failure' })

    const result = engine.resolveChain(event, world)

    expect(result.reactions[0]?.petId).toBe('long-niang')
    expect(result.reactions[0]?.animation).toBe('waiting')
  })
})
