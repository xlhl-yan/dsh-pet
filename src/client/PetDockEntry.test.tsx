// @vitest-environment jsdom
/**
 * The hidden-state summon button opts into the L2 semantic attributes
 * (issue #506): it carries data-dsh-part="summon-button" so skins can target
 * it without hash-class selectors.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
// The npm SDK's client half is a closure-factory bundle for the GUI's
// __ModuleLoader__ (not importable under vitest); provide the defineStore
// the pet store needs (same fake-store pattern as the settings-card tests).
vi.mock('@deepseek-ai/dsh-client-store', () => ({
  defineStore: (spec: {
    init: () => unknown
    actions: Record<string, (draft: never, ...args: never[]) => void>
  }) => ({
    create: () => {
      let value = spec.init()
      const listeners = new Set<() => void>()
      const actions: Record<string, (...args: unknown[]) => void> = {}
      for (const [name, fn] of Object.entries(spec.actions)) {
        actions[name] = (...args: unknown[]) => {
          fn(value as never, ...(args as never[]))
          for (const listener of listeners) listener()
        }
      }
      return {
        getSnapshot: () => value,
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        actions,
      }
    },
  }),
}))
import { PetDockEntry, type PetInjected } from './PetDockEntry.tsx'
import { createPetStore } from './pet-store.ts'
import { t } from './locales.ts'
import type { PetStateView } from '../service.ts'

beforeAll(() => {
  document.documentElement.lang = 'zh'
})

afterEach(cleanup)

/** Snapshot fixture with the pet hidden (the summon-button state). */
const hiddenSnapshot: PetStateView = {
  animation: 'idle',
  phase: 'idle',
  sessionActive: false,
  affinity: {
    points: 0,
    rank: '幼鲸',
    rankEmoji: '*',
    pets: 0,
    feeds: 0,
    turns: 0,
    petCooldown: false,
    feedCooldown: false,
  },
  display: { visible: false, size: 160, right: 24, bottom: 20, bubbleScale: 1, edgeMarginLeft: 24, edgeMarginRight: 8 },
  pet: { id: 'whale-girl', displayName: '鲸鱼娘', description: '测试用鲸鱼娘' },
  name: '泡泡',
  treats: { stocked: 0, max: 5 },
}

function injected(): PetInjected {
  return {
    store: createPetStore().create(),
    ensure: vi.fn(),
    pet: vi.fn(),
    feed: vi.fn(),
    hide: vi.fn(),
    summon: vi.fn(),
    dragEnd: vi.fn(),
    rename: vi.fn(),
    dialogueLine: vi.fn(),
    panelAction: vi.fn(),
    openSession: vi.fn(),
    feedbackDone: vi.fn(),
    gameplay: {
      touch: vi.fn(),
      setMode: vi.fn(),
      workTick: vi.fn(),
      buy: vi.fn(),
      setSkin: vi.fn(async () => ({ ok: true })),
    },
  }
}

describe('PetDockEntry L2 semantic attributes (#506)', () => {
  it('tags the summon button as the summon-button part', () => {
    const props = injected()
    props.store.actions.setSnapshot(hiddenSnapshot)
    render(<PetDockEntry {...props} t={t} />)
    const summon = screen.getByTestId('pet-summon')
    expect(summon.getAttribute('data-dsh-part')).toBe('summon-button')
  })
})

/** Snapshot fixture with two pets on screen at different positions. */
const twoPetSnapshot: PetStateView = {
  ...hiddenSnapshot,
  display: { visible: true, size: 160, right: 24, bottom: 20, bubbleScale: 1, edgeMarginLeft: 24, edgeMarginRight: 8 },
  pets: [
    { id: 'whale-girl', name: '泡泡', animation: 'idle', phase: 'idle', right: 24, bottom: 120 },
    { id: 'ouo-neko', name: '猫猫', animation: 'jumping', phase: 'done', bubble: '收工！', right: 300, bottom: 60 },
  ],
}

/** A renderable sprite2d definition; `tracks` must cover every animation. */
function spriteDefinition(id: string, displayName: string): never {
  const track = (frames: number[], durations: number[]) => ({ frames, durations, loop: true })
  return {
    id,
    displayName,
    description: '',
    renderer: 'sprite2d',
    cell: { width: 192, height: 208 },
    columns: 8,
    rows: [6, 8, 8, 4, 5, 8, 6, 6, 6],
    atlasRows: 9,
    tracks: {
      idle: track([0, 1, 2, 3, 4, 5], [400, 400, 400, 400, 400, 400]),
      'running-right': track([0, 1, 2, 3, 4, 5, 6, 7], [225, 225, 225, 225, 225, 225, 225, 225]),
      'running-left': track([0, 1, 2, 3, 4, 5, 6, 7], [225, 225, 225, 225, 225, 225, 225, 225]),
      waving: track([0, 1, 2, 3], [350, 350, 350, 350]),
      jumping: track([0, 1, 2, 3, 4], [300, 300, 300, 300, 300]),
      failed: track([0, 1, 2, 3, 4, 5, 6, 7], [450, 450, 450, 450, 450, 450, 450, 450]),
      waiting: track([0, 1, 2, 3, 4, 5], [450, 450, 450, 450, 450, 450]),
      running: track([0, 1, 2, 3, 4, 5], [250, 250, 250, 250, 250, 250]),
      review: track([0, 1, 2, 3, 4, 5], [550, 550, 550, 550, 550, 550]),
    },
    atlasUrl: '/pet/' + id + '/spritesheet.webp',
    manifestUrl: '/pet/' + id + '/pet.json',
  } as never
}

describe('PetDockEntry multi-pet coexistence', () => {
  it('renders one sprite per on-screen pet', () => {
    const props = injected()
    props.store.actions.setPets([
      spriteDefinition('whale-girl', '鲸鱼娘'),
      spriteDefinition('ouo-neko', 'OUO Neko'),
    ])
    props.store.actions.setSnapshot(twoPetSnapshot)
    render(<PetDockEntry {...props} t={t} />)
    // Each pet mounts its own sprite, addressed by its manifest display name.
    expect(screen.getByLabelText('鲸鱼娘')).toBeTruthy()
    expect(screen.getByLabelText('OUO Neko')).toBeTruthy()
  })

  it('skips a pet whose registry definition is missing', () => {
    // A list naming an uninstalled pet must not render a broken sprite; the
    // remaining pets still show.
    const props = injected()
    props.store.actions.setPets([spriteDefinition('whale-girl', '鲸鱼娘')])
    props.store.actions.setSnapshot(twoPetSnapshot)
    render(<PetDockEntry {...props} t={t} />)
    expect(screen.getByLabelText('鲸鱼娘')).toBeTruthy()
    expect(screen.queryByLabelText('OUO Neko')).toBeNull()
  })

  it('falls back to the singular pet field when the host serves no list', () => {
    // A browser half running against a host that predates coexistence still
    // has to render its one pet instead of blanking.
    const props = injected()
    props.store.actions.setPets([spriteDefinition('whale-girl', '鲸鱼娘')])
    const legacy: PetStateView = { ...twoPetSnapshot }
    delete legacy.pets
    props.store.actions.setSnapshot(legacy)
    render(<PetDockEntry {...props} t={t} />)
    expect(screen.getByLabelText('鲸鱼娘')).toBeTruthy()
  })
})
