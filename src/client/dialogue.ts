/**
 * Pet-to-pet dialogue: two pets on screen talk to each other.
 *
 * Scope and boundaries:
 * - **Client-side only.** The conversation is a property of the sprites the user
 *   is looking at, not of the host. It reads the on-screen pet list from the
 *   polled snapshot and writes speech bubbles straight into the store, so it
 *   works with `autonomous` on (the host serves no session activity at all) and
 *   needs no new endpoint.
 * - **Scripted first, model later.** A conversation advances one turn at a time
 *   through a {@link DialogueProducer}. The shipped producer reads a script
 *   table; a model-backed one can `await` an LLM behind the same interface
 *   without the driver changing.
 * - **Bounded.** A turn budget caps how long a conversation runs, a cooldown
 *   separates conversations, and only one conversation is in flight at a time.
 *   Without those, two pets would talk forever and the screen would never settle.
 *
 * @module @linxin666/dsh-pet/client/dialogue
 */

import type { PetAnimation } from '../state.ts'

/** One scripted line: what a pet says, and what it does while saying it. */
export interface DialogueLine {
  /** Bubble copy. */
  text: string
  /**
   * Animation to play while the line is up. Absent leaves the pet on whatever
   * its idle routine is showing. `waving` is the natural greeting.
   */
  animation?: PetAnimation
}

/** What a producer knows when asked for a line. */
export interface DialogueTurnContext {
  /** Pet speaking this turn. */
  speakerId: string
  /** Pet being addressed. */
  listenerId: string
  /** 0-based index of this turn within the conversation. */
  turn: number
  /**
   * The pair's opener — the pet whose direction in the script this exchange
   * belongs to. A scripted producer needs it because the table is keyed by who
   * opens, while `speakerId` flips every turn.
   */
  openerId: string
  /** What the other pet said immediately before, when any. */
  previous?: string
}

/**
 * Produces the next line of a conversation, or undefined to end it.
 *
 * This is the seam for a model-backed generator: the shipped implementation is
 * a synchronous table lookup, and an async LLM call fits the same signature
 * because the driver awaits the result either way.
 */
export type DialogueProducer = (
  context: DialogueTurnContext,
) => DialogueLine | undefined | Promise<DialogueLine | undefined>

/**
 * A producer that answers synchronously.
 *
 * The scripted implementation is always synchronous, and saying so lets callers
 * (and tests) read `.text` off the result without an `await` that would only be
 * there to satisfy the union in {@link DialogueProducer}.
 */
export type SyncDialogueProducer = (context: DialogueTurnContext) => DialogueLine | undefined

/**
 * A shipped conversation table: opener → partner → lines in turn order.
 *
 * The array is the whole exchange as heard, not one pet's side of it: line 0 is
 * what the OPENER says, line 1 the partner's reply, line 2 the opener again,
 * and so on. The two pets therefore alternate off a single array, and a pair is
 * scripted in one direction only — the direction that names who opens.
 *
 * That is why {@link nextPair} rotates the opener: a pair scripted as
 * `whale-girl → long-niang` reads "the whale opens and the dragon answers", and
 * letting the dragon open would swap the meaning of every line.
 *
 * Kept deliberately tiny and in-character: the point is to prove the mechanism
 * and to be immediately readable, not to be a personality engine.
 */
export type DialogueScript = Record<string, Record<string, DialogueLine[]>>

/** The shipped pairs. */
export const DEFAULT_DIALOGUE_SCRIPT: DialogueScript = {
  'whale-girl': {
    'long-niang': [
      { text: 'hello！', animation: 'waving' },
      { text: 'world', animation: 'review' },
      { text: '你这龙，怎么回得这么敷衍', animation: 'failed' },
      { text: '因为我在忙着吃 token', animation: 'jumping' },
    ],
    'ouo-neko': [
      { text: 'hello！', animation: 'waving' },
      { text: '喵？', animation: 'waiting' },
    ],
    'whale-girl-refined': [
      { text: 'hello！', animation: 'waving' },
      { text: '……你是我吗？', animation: 'review' },
    ],
  },
  'long-niang': {
    'whale-girl': [
      { text: 'world', animation: 'waving' },
      { text: 'hello！', animation: 'waving' },
      { text: '你就只会这一句？', animation: 'failed' },
      { text: '省点 token 不好吗', animation: 'review' },
    ],
    'ouo-neko': [
      { text: 'world', animation: 'waving' },
      { text: '喵喵！', animation: 'jumping' },
    ],
  },
  'ouo-neko': {
    'whale-girl': [
      { text: '喵～', animation: 'waving' },
      { text: 'hello！', animation: 'waving' },
    ],
    'long-niang': [
      { text: '喵喵！', animation: 'waving' },
      { text: 'world', animation: 'waiting' },
    ],
  },
  'whale-girl-refined': {
    'whale-girl': [
      { text: 'hello，另一个我', animation: 'waving' },
      { text: '……别学我说话', animation: 'failed' },
    ],
  },
}

/** Tuning for the conversation loop. */
export interface DialogueConfig {
  /** How long to wait before even considering a conversation, ms. */
  intervalMs: number
  /** Chance of starting one when the timer fires (0–1). */
  probability: number
  /** How long one line stays on screen, ms. */
  lineMs: number
  /** Hard cap on turns per conversation; the pets stop even mid-script. */
  maxTurns: number
}

/**
 * The shipped tuning: a rare, short exchange.
 *
 * The interval is long and the probability low on purpose — a scripted loop on
 * a short timer is charming once and unbearable by the tenth repetition.
 */
export const DEFAULT_DIALOGUE_CONFIG: DialogueConfig = {
  intervalMs: 45_000,
  probability: 0.4,
  lineMs: 2600,
  maxTurns: 4,
}

/** One scheduled line, as the driver hands it to the UI. */
export interface DialogueUtterance {
  /** Pet that speaks. */
  petId: string
  /** Bubble copy. */
  text: string
  /** Animation to play while the line is up. */
  animation?: PetAnimation
  /** When the line was scheduled (epoch ms). */
  at: number
}

/**
 * The scripted producer: turn N of the pair's exchange, or undefined when the
 * script runs out.
 *
 * Looks the exchange up by the OPENER's direction and indexes it by the
 * conversation-wide turn, because the table lists both pets' lines in order.
 * Indexing by `speakerId` instead would read the wrong side on every reply.
 * @param script - the scripted pairs.
 * @returns a producer over that script.
 */
export function scriptedProducer(script: DialogueScript): SyncDialogueProducer {
  return (context) => {
    // The exchange is keyed by (opener, opener's partner). `speakerId` flips
    // every turn, so derive the partner from the opener rather than reading the
    // table by whoever happens to be talking.
    const partnerId = context.openerId === context.speakerId ? context.listenerId : context.speakerId
    return script[context.openerId]?.[partnerId]?.[context.turn]
  }
}

/**
 * The speaker of one turn, alternating from the opener.
 * @param pair - who opened the conversation.
 * @param turn - 0-based turn index.
 * @returns the pet that speaks on that turn.
 */
export function speakerForTurn(
  pair: { speakerId: string; listenerId: string },
  turn: number,
): string {
  return turn % 2 === 0 ? pair.speakerId : pair.listenerId
}

/**
 * Whether a pet can open an exchange with another.
 *
 * The table is keyed by who opens, so only the forward direction counts: a pair
 * scripted as `b → a` is one where `b` opens and `a` answers, and `a` has
 * nothing to start with. Rotating the opener (see {@link nextPair}) is what
 * gives each pet its turn to lead.
 * @param script - the scripted pairs.
 * @param opener - the pet that would open.
 * @param partner - the pet it would address.
 * @returns true when this direction has at least one line.
 */
export function canOpenWith(script: DialogueScript, opener: string, partner: string): boolean {
  const lines = script[opener]?.[partner]
  return lines !== undefined && lines.length > 0
}

/**
 * Pick the pair to talk, preferring a pair that actually has a script.
 *
 * The opener rotates across conversations so the same pet does not always
 * start. A random partner is tried first; when that pair is unscripted the
 * remaining candidates are scanned, so two pets that have nothing to say to
 * each other do not silently block the ones that do.
 * @param script - the scripted pairs.
 * @param petIds - the pets currently on screen, in render order.
 * @param conversationIndex - how many conversations have run this session.
 * @param random - injected for tests.
 * @returns the pair to talk, or undefined when no pair can.
 */
export function nextPair(
  script: DialogueScript,
  petIds: readonly string[],
  conversationIndex: number,
  random: () => number = Math.random,
): { speakerId: string; listenerId: string } | undefined {
  if (petIds.length < 2) return undefined
  const speakerId = petIds[conversationIndex % petIds.length]!
  const others = petIds.filter(id => id !== speakerId)
  if (others.length === 0) return undefined
  // Try a random partner first so the choice is not always the same pet, then
  // fall back to scanning for any partner this pet can actually open with.
  const first = others[Math.floor(random() * others.length)]!
  if (canOpenWith(script, speakerId, first)) return { speakerId, listenerId: first }
  const scripted = others.find(id => canOpenWith(script, speakerId, id))
  return scripted === undefined ? undefined : { speakerId, listenerId: scripted }
}

/**
 * Build one turn's utterance, or undefined when the conversation is over.
 *
 * The single place a turn is produced, so the scripted and model-backed paths
 * cannot drift apart.
 * @param producer - the line source.
 * @param pair - who is talking.
 * @param turn - 0-based turn index.
 * @param previous - what the other pet said last, when any.
 * @param maxTurns - hard cap on turns.
 * @returns the utterance to show, or undefined to end.
 */
export async function nextUtterance(
  producer: DialogueProducer,
  pair: { speakerId: string; listenerId: string },
  turn: number,
  previous: string | undefined,
  maxTurns: number,
): Promise<DialogueUtterance | undefined> {
  if (turn >= maxTurns) return undefined
  const petId = speakerForTurn(pair, turn)
  const line = await producer({
    speakerId: petId,
    listenerId: petId === pair.speakerId ? pair.listenerId : pair.speakerId,
    openerId: pair.speakerId,
    turn,
    ...(previous === undefined ? {} : { previous }),
  })
  if (line === undefined) return undefined
  return {
    petId,
    text: line.text,
    ...(line.animation === undefined ? {} : { animation: line.animation }),
    at: Date.now(),
  }
}
