/**
 * Personality offset: two pets answer the SAME event differently.
 *
 * This is the fix for the problem the design notes flagged — every pet reading
 * one shared projection moves in lockstep, so nothing reads as a relationship.
 * The profiles are what make a celebration draw a jump out of one pet and only a
 * glance out of another.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PERSONALITY,
  PET_PERSONALITIES,
  defaultRules,
  joinsIn,
  lineFor,
  personalityOf,
} from './pet-personality.ts'
import { World, type WorldEvent } from './world.ts'

/** A world holding the given pets, all idle. */
function worldWith(ids: string[]): World {
  const world = new World()
  for (const id of ids) {
    world.setPresence({ id, animation: 'idle', phase: 'idle', right: 0, bottom: 0, width: 1, height: 1 })
  }
  return world
}

describe('personalityOf', () => {
  it('returns a declared profile', () => {
    const profile = personalityOf('long-niang')
    expect(profile.onCelebrate).toBe('review')
  })

  it('fills every field for an undeclared pet', () => {
    // A pet with no profile must still be able to interact, not be excluded.
    const profile = personalityOf('some-new-pet')
    expect(profile.sociability).toBe(DEFAULT_PERSONALITY.sociability)
    expect(profile.onCelebrate).toBe(DEFAULT_PERSONALITY.onCelebrate)
    expect(profile.onFailure).toBe(DEFAULT_PERSONALITY.onFailure)
  })
})

describe('joinsIn', () => {
  it('reacts when the roll is below the pet\'s sociability', () => {
    // Read the declared value rather than hardcoding it: the shipped numbers are
    // a tuning decision, and a test that pins them would break on every tweak
    // while proving nothing about the comparison itself.
    const sociability = personalityOf('whale-girl').sociability
    expect(joinsIn('whale-girl', 0)).toBe(true)
    expect(joinsIn('whale-girl', Math.max(0, sociability - 0.01))).toBe(true)
    expect(joinsIn('whale-girl', Math.min(1, sociability + 0.01))).toBe(false)
  })

  it('gives a less social pet a narrower window', () => {
    // The dragon must be strictly less eager than the whale girl — that gap IS
    // the personality offset, whatever the absolute numbers are tuned to.
    const whale = personalityOf('whale-girl').sociability
    const dragon = personalityOf('long-niang').sociability
    expect(dragon).toBeLessThan(whale)
    // A roll between the two moves the whale and leaves the dragon.
    const between = (whale + dragon) / 2
    expect(joinsIn('whale-girl', between)).toBe(true)
    expect(joinsIn('long-niang', between)).toBe(false)
  })
})

describe('lineFor', () => {
  it('picks from the pet\'s own pool', () => {
    expect(lineFor('whale-girl', 'celebrate', 0)).toBe('耶！')
    expect(lineFor('long-niang', 'celebrate', 0)).toBe('……哦。')
  })

  it('is undefined for a pet or kind with no lines', () => {
    expect(lineFor('some-new-pet', 'celebrate')).toBeUndefined()
    expect(lineFor('whale-girl', 'arrive')).toBeUndefined()
  })
})

describe('defaultRules', () => {
  /** Resolve one event against the shipped rules with a fixed roll. */
  function react(kind: string, ids: string[], source: string, roll = 0): ReturnType<ReturnType<typeof defaultRules>[number]['react']>[] {
    const world = worldWith(ids)
    const rules = defaultRules(() => roll)
    const event: WorldEvent = { at: 0, source, kind }
    const results = []
    for (const rule of rules) {
      if (!rule.matches(event, world)) continue
      for (const petId of rule.audience(event, world)) {
        results.push(rule.react(petId, event, world))
      }
    }
    return results
  }

  it('answers a celebration with each pet\'s own track', () => {
    // The whale girl jumps along; the dragon only looks over. Same event, two
    // different animations — the whole point.
    const [whale, dragon] = react('celebrate', ['whale-girl', 'long-niang'], 'other', 0)
    expect(whale?.animation).toBe('jumping')
    expect(dragon?.animation).toBe('review')
  })

  it('answers a failure with each pet\'s own track', () => {
    const [whale, dragon] = react('failure', ['whale-girl', 'long-niang'], 'other', 0)
    expect(whale?.animation).toBe('failed')
    expect(dragon?.animation).toBe('waiting')
  })

  it('carries a line from the reacting pet', () => {
    const [whale, dragon] = react('celebrate', ['whale-girl', 'long-niang'], 'other', 0)
    expect(whale?.bubble).toBe('耶！')
    expect(dragon?.bubble).toBe('……哦。')
  })

  it('lets a pet sit the event out', () => {
    // A roll above the dragon's sociability means she does not react at all,
    // rather than reacting with a default track. The value is read from the
    // profile so tuning the shipped numbers cannot break this.
    const dragonSociability = personalityOf('long-niang').sociability
    const [, dragon] = react('celebrate', ['whale-girl', 'long-niang'], 'other', Math.min(1, dragonSociability + 0.01))
    expect(dragon).toBeUndefined()
  })

  it('emits a follow-up that is NOT the same kind, so a pair cannot ping-pong', () => {
    const [whale] = react('celebrate', ['whale-girl', 'long-niang'], 'other', 0)
    // The emit is 'reacted', which no shipped rule matches — the structural
    // reason a two-pet exchange terminates even without the engine's caps.
    expect(whale?.emit?.kind).toBe('reacted')
    const kinds = defaultRules(() => 0).map(rule => rule.id)
    expect(kinds).toEqual(['celebrate-notice', 'failure-notice'])
  })

  it('never makes the source react to its own event', () => {
    const world = worldWith(['whale-girl', 'long-niang'])
    const event: WorldEvent = { at: 0, source: 'whale-girl', kind: 'celebrate' }
    for (const rule of defaultRules(() => 0)) {
      expect(rule.audience(event, world)).toEqual(['long-niang'])
    }
  })

  it('covers every shipped pet with a declared profile', () => {
    // A pet with no profile still works, but the ones we ship should each have
    // an opinion, or the offset is invisible in practice.
    for (const id of ['whale-girl', 'long-niang', 'ouo-neko', 'whale-girl-refined']) {
      expect(PET_PERSONALITIES[id]).toBeDefined()
    }
  })
})
