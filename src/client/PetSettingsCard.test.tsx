// @vitest-environment jsdom
/**
 * The pet settings card under the aggregate shell, which serves no Host
 * settings form for the 'pet' namespace: the pet choice and its visibility
 * switch both write through the pet API, so the pet can still be turned off
 * when the Host form is absent.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { PetSettingsCard, PetSettingsCardController, type PetSettings } from './PetSettingsCard.tsx'
import { t } from './locales.ts'

vi.mock('@deepseek-ai/dsh-client-store', () => ({ // test-standards-allow: the SDK client bundle is a browser module factory and cannot be imported by Vitest
  createSnapshotStore: (initial: unknown) => {
    let value = initial
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => value,
      set: (next: unknown) => { value = next; for (const listener of listeners) listener() },
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
  },
}))

function unavailableForm() {
  const mutate = vi.fn(async () => false)
  const scope = {
    getSnapshot: () => ({ status: 'unavailable', writable: true, value: undefined, base: undefined, user: undefined }),
    subscribe: () => () => {},
    mutate,
  } as unknown as ConfigForm<PetSettings>
  return { scope, mutate }
}

function response(value: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => value } as Response
}

/**
 * A Host-served pet namespace: the settings document, its user layer, and a
 * mutate that applies the card's batch and publishes the settled view back,
 * which is what the card's read-back judgment reads.
 */
function readyForm(value: PetSettings) {
  let section: PetSettings = { ...value }
  // The Host document's user layer is keyed by field name, so the test seam
  // writes through a record view of the same shape the form contract serves.
  let user: Record<string, unknown> = {}
  const listeners = new Set<() => void>()
  const publish = () => { for (const listener of listeners) listener() }
  const mutate = vi.fn(async (ops: ReadonlyArray<{ op: 'set' | 'unset'; path: string[]; value?: unknown }>) => {
    for (const op of ops) {
      const field = op.path[0] as string
      if (op.op === 'set') user[field] = op.value
      else delete user[field]
    }
    section = { ...value, ...user }
    publish()
    return true
  })
  const scope = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: section, base: value, user, revision: 1 }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate,
  } as unknown as ConfigForm<PetSettings>
  return { scope, mutate, value: () => ({ user }) }
}

beforeAll(() => {
  document.documentElement.lang = 'zh'
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('pet selection without a Host settings form', () => {
  it('user saves the on-screen pet list through its persisted API and confirms the read-back', async () => {
    // Given the aggregate shell exposes no pet configuration form
    vi.useFakeTimers()
    const { scope, mutate } = unavailableForm()
    let onScreen = ['whale-girl']
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/pet/pets') return response([{ id: 'whale-girl', displayName: '鲸鱼娘' }, { id: 'jyn', displayName: '女仆鲸鱼娘' }])
      if (path === '/api/pet/state') {
        return response({
          pet: { id: onScreen[0] },
          pets: onScreen.map((id, index) => ({ id, right: 24 + index * 180, bottom: 120 })),
          display: { visible: true, right: 24, bottom: 120 },
        })
      }
      if (path === '/api/pet/set-pets') {
        const body = JSON.parse(String(init?.body)) as { pets: { id: string }[] }
        onScreen = body.pets.map(pet => pet.id)
        return response({ ok: true, pets: body.pets })
      }
      throw new Error('unexpected request: ' + path)
    })
    vi.stubGlobal('fetch', fetch)
    const controller = new PetSettingsCardController(scope)
    await vi.advanceTimersByTimeAsync(0)
    const face = controller.inject()
    const state = () => face.hooks.petSettingsCard.getSnapshot()

    // When the user adds the maid whale to the on-screen list and clicks Save
    expect(state()).toMatchObject({ petSelectionFallback: true, selectedPetIds: ['whale-girl'], dirty: false })
    face.togglePet('jyn')
    expect(state()).toMatchObject({ dirty: true, selectedPetIds: ['whale-girl', 'jyn'] })
    face.save()
    await vi.waitFor(() => { expect(state().saving).toBe(false) })

    // Then the pet service holds both, the draft clears, and the absent Host
    // form is untouched
    expect(onScreen).toEqual(['whale-girl', 'jyn'])
    expect(state()).toMatchObject({ dirty: false, failed: false, selectedPetIds: ['whale-girl', 'jyn'] })
    expect(mutate).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledWith('/api/pet/set-pets', expect.objectContaining({
      body: expect.stringContaining('"id":"jyn"'),
    }))
    controller.dispose()
  })

  it('gives a newly added pet a position of its own', async () => {
    // Given one pet on screen at a known spot
    vi.useFakeTimers()
    const { scope } = unavailableForm()
    let sent: { id: string; right: number; bottom: number }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/pet/pets') return response([{ id: 'whale-girl', displayName: '鲸鱼娘' }, { id: 'jyn', displayName: '女仆鲸鱼娘' }])
      if (path === '/api/pet/state') {
        return response({
          pet: { id: 'whale-girl' },
          pets: [{ id: 'whale-girl', right: 24, bottom: 120 }],
          display: { visible: true, right: 24, bottom: 120 },
        })
      }
      if (path === '/api/pet/set-pets') {
        const body = JSON.parse(String(init?.body)) as { pets: typeof sent }
        sent = body.pets
        return response({ ok: true, pets: body.pets })
      }
      throw new Error('unexpected request: ' + path)
    }))
    const controller = new PetSettingsCardController(scope)
    await vi.advanceTimersByTimeAsync(0)
    const face = controller.inject()

    // When a second pet is added
    face.togglePet('jyn')
    face.save()
    await vi.waitFor(() => { expect(face.hooks.petSettingsCard.getSnapshot().saving).toBe(false) })

    // Then the pet already on screen keeps its spot, and the new one is offset
    // so it does not land exactly on top of it.
    expect(sent[0]).toEqual({ id: 'whale-girl', right: 24, bottom: 120 })
    expect(sent[1]!.id).toBe('jyn')
    expect(sent[1]!.right).toBeGreaterThan(sent[0]!.right)
    controller.dispose()
  })

  it('user keeps the draft when the pet API refuses the list', async () => {
    // Given the Host has no pet form and the pet API still serves its selection
    vi.useFakeTimers()
    const { scope } = unavailableForm()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/pet/pets') return response([{ id: 'whale-girl', displayName: '鲸鱼娘' }, { id: 'jyn', displayName: '女仆鲸鱼娘' }])
      if (path === '/api/pet/state') {
        return response({
          pet: { id: 'whale-girl' },
          pets: [{ id: 'whale-girl', right: 24, bottom: 120 }],
          display: { visible: true, right: 24, bottom: 120 },
        })
      }
      if (path === '/api/pet/set-pets') return response({ ok: false, error: 'unknown-pet' })
      throw new Error('unexpected request: ' + path)
    }))
    const controller = new PetSettingsCardController(scope)
    await vi.advanceTimersByTimeAsync(0)
    const face = controller.inject()
    // When the user saves a list the pet API refuses
    face.togglePet('jyn')
    face.save()
    await vi.waitFor(() => { expect(face.hooks.petSettingsCard.getSnapshot().saving).toBe(false) })
    // Then the list remains staged and the failure is visible
    expect(face.hooks.petSettingsCard.getSnapshot()).toMatchObject({
      dirty: true,
      failed: true,
      selectedPetIds: ['whale-girl', 'jyn'],
    })
    controller.dispose()
  })

  it('refuses to remove the last pet, since the host keeps at least one', async () => {
    vi.useFakeTimers()
    const { scope } = unavailableForm()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/pet/pets') return response([{ id: 'whale-girl', displayName: '鲸鱼娘' }])
      if (path === '/api/pet/state') {
        return response({
          pet: { id: 'whale-girl' },
          pets: [{ id: 'whale-girl', right: 24, bottom: 120 }],
          display: { visible: true, right: 24, bottom: 120 },
        })
      }
      throw new Error('unexpected request: ' + path)
    }))
    const controller = new PetSettingsCardController(scope)
    await vi.advanceTimersByTimeAsync(0)
    const face = controller.inject()

    // Toggling the only selected pet off is a no-op rather than a staged empty
    // list, which the host would silently ignore on save.
    face.togglePet('whale-girl')
    expect(face.hooks.petSettingsCard.getSnapshot()).toMatchObject({
      dirty: false,
      selectedPetIds: ['whale-girl'],
    })
    controller.dispose()
  })
})

describe('pet visibility without a Host settings form', () => {
  it('user turns the pet off through its persisted API and confirms the read-back', async () => {
    // Given the aggregate shell exposes no pet configuration form and the pet is showing
    vi.useFakeTimers()
    const { scope, mutate } = unavailableForm()
    let visible = true
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/pet/pets') return response([{ id: 'whale-girl', displayName: '鲸鱼娘' }])
      if (path === '/api/pet/state') return response({ pet: { id: 'whale-girl' }, display: { visible } })
      if (path === '/api/pet/set-visible') {
        visible = JSON.parse(String(init?.body)).visible as boolean
        return response({ ok: true, display: { visible } })
      }
      throw new Error('unexpected request: ' + path)
    })
    vi.stubGlobal('fetch', fetch)
    const controller = new PetSettingsCardController(scope)
    await vi.advanceTimersByTimeAsync(0)
    const face = controller.inject()
    const state = () => face.hooks.petSettingsCard.getSnapshot()

    // When the user switches the pet off and clicks Save
    expect(state()).toMatchObject({ petSelectionFallback: true, visible: { text: 'true' }, dirty: false })
    face.edit('visible', 'false')
    expect(state()).toMatchObject({ dirty: true, visible: { text: 'false' } })
    face.save()
    await vi.waitFor(() => { expect(state().saving).toBe(false) })

    // Then the pet service holds it, the draft clears, and the absent Host form is untouched
    expect(visible).toBe(false)
    expect(state()).toMatchObject({ dirty: false, failed: false, visible: { text: 'false' } })
    expect(mutate).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledWith('/api/pet/set-visible', expect.objectContaining({ body: JSON.stringify({ visible: false }) }))
    controller.dispose()
  })

  it('user keeps the draft when the pet API refuses the visibility write', async () => {
    // Given the Host has no pet form and the pet API refuses visibility writes
    vi.useFakeTimers()
    const { scope } = unavailableForm()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/pet/pets') return response([{ id: 'whale-girl', displayName: '鲸鱼娘' }])
      if (path === '/api/pet/state') return response({ pet: { id: 'whale-girl' }, display: { visible: true } })
      if (path === '/api/pet/set-visible') return response({ ok: false }, false)
      throw new Error('unexpected request: ' + path)
    }))
    const controller = new PetSettingsCardController(scope)
    await vi.advanceTimersByTimeAsync(0)
    const face = controller.inject()
    // When the user saves a visibility the pet API refuses
    face.edit('visible', 'false')
    face.save()
    await vi.waitFor(() => { expect(face.hooks.petSettingsCard.getSnapshot().saving).toBe(false) })
    // Then the switch keeps the draft and the failure is visible
    expect(face.hooks.petSettingsCard.getSnapshot()).toMatchObject({ dirty: true, failed: true, visible: { text: 'false' } })
    controller.dispose()
  })
})

describe('pet settings card rendered without a Host settings form', () => {
  it('shows the visibility switch beside the pet choice and hides the Host-only fields', async () => {
    // Given the aggregate shell exposes no pet configuration form
    vi.useFakeTimers()
    const { scope } = unavailableForm()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/pet/pets') return response([{ id: 'whale-girl', displayName: '鲸鱼娘' }])
      if (path === '/api/pet/state') return response({ pet: { id: 'whale-girl' }, display: { visible: true } })
      throw new Error('unexpected request: ' + path)
    }))
    const controller = new PetSettingsCardController(scope)
    await vi.advanceTimersByTimeAsync(0)
    const face = controller.inject()
    const store = face.hooks.petSettingsCard

    // When the card renders
    render(
      <PetSettingsCard
        t={t}
        usePetSettingsCard={select => useSyncExternalStore(store.subscribe, () => select(store.getSnapshot()))}
        save={face.save}
        discard={face.discard}
        edit={face.edit}
        resetField={face.resetField}
        togglePet={face.togglePet}
      />,
    )

    // Then the pet choice and the switch that turns the pet off are both on screen
    expect(screen.getByLabelText(t('settings.pet'))).toBeTruthy()
    expect(screen.getByLabelText(t('settings.visible'))).toBeTruthy()
    // ...while the fields only the absent Host form owns stay hidden
    expect(screen.queryByLabelText(t('settings.enabled'))).toBeNull()
    expect(screen.queryByLabelText(t('settings.size'))).toBeNull()
    controller.dispose()
  })
})

describe('the status bubble switch on the Host settings form', () => {
  it('user switches the pet own bubbles off and the form writes the mode', async () => {
    // Given a Host that serves the pet namespace with the shipped default
    vi.useFakeTimers()
    const { scope, value, mutate } = readyForm({ statusBubbles: 'auto' })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/pet/pets') return response([{ id: 'whale-girl', displayName: '鲸鱼娘' }])
      if (path === '/api/pet/state') return response({ pet: { id: 'whale-girl' }, display: { visible: true } })
      throw new Error('unexpected request: ' + path)
    }))
    const controller = new PetSettingsCardController(scope)
    await vi.advanceTimersByTimeAsync(0)
    const face = controller.inject()
    const state = () => face.hooks.petSettingsCard.getSnapshot()

    // When the card renders, the switch is on screen beside the other fields
    render(
      <PetSettingsCard
        t={t}
        usePetSettingsCard={select => useSyncExternalStore(face.hooks.petSettingsCard.subscribe, () => select(face.hooks.petSettingsCard.getSnapshot()))}
        save={face.save}
        discard={face.discard}
        edit={face.edit}
        resetField={face.resetField}
        togglePet={face.togglePet}
      />,
    )
    expect(screen.getByLabelText(t('settings.statusBubbles'))).toBeTruthy()
    expect(state()).toMatchObject({ statusBubbles: { text: 'auto', invalid: false } })

    // When the user picks Off and saves
    face.edit('statusBubbles', 'off')
    expect(state()).toMatchObject({ dirty: true, statusBubbles: { text: 'off' } })
    face.save()
    await vi.waitFor(() => { expect(state().saving).toBe(false) })

    // Then the settings document holds the mode, and the draft clears
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['statusBubbles'], value: 'off' }])
    expect(value().user?.statusBubbles).toBe('off')
    expect(state()).toMatchObject({ dirty: false, failed: false, statusBubbles: { text: 'off' } })
    controller.dispose()
  })

  it('refuses a draft the switch does not accept instead of writing it', () => {
    const { scope } = readyForm({ statusBubbles: 'auto' })
    const face = new PetSettingsCardController(scope).inject()

    face.edit('statusBubbles', 'maybe')

    // The save stays blocked: a mode the host schema has no union member for
    // must never reach the settings document.
    expect(face.hooks.petSettingsCard.getSnapshot()).toMatchObject({
      invalid: true,
      statusBubbles: { text: 'maybe', invalid: true },
    })
  })
})

describe('the pet list on the Host settings form', () => {
  /**
   * The regression this pins: the list is staged OUTSIDE the settings form, so
   * the form's own dirty plan knows nothing about it. Ticking a pet therefore
   * left Save disabled and the edit unreachable, because `dirty` came straight
   * from `shell.dirty`.
   */
  it('enables Save when only the pet list changed', async () => {
    vi.useFakeTimers()
    const { scope } = readyForm({})
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/pet/pets') {
        return response([{ id: 'whale-girl', displayName: '鲸鱼娘' }, { id: 'jyn', displayName: '女仆鲸鱼娘' }])
      }
      if (path === '/api/pet/state') {
        return response({
          pet: { id: 'whale-girl' },
          pets: [{ id: 'whale-girl', right: 24, bottom: 120 }],
          display: { visible: true, right: 24, bottom: 120 },
        })
      }
      throw new Error('unexpected request: ' + path)
    }))
    const controller = new PetSettingsCardController(scope)
    await vi.advanceTimersByTimeAsync(0)
    const face = controller.inject()
    const state = () => face.hooks.petSettingsCard.getSnapshot()

    // Given the served form with nothing staged
    expect(state()).toMatchObject({ dirty: false, selectedPetIds: ['whale-girl'] })

    // When the user ticks a second pet
    face.togglePet('jyn')

    // Then the card is dirty, so the Save control is live
    expect(state()).toMatchObject({ dirty: true, selectedPetIds: ['whale-girl', 'jyn'] })
    controller.dispose()
  })

  it('clears a staged list on Discard without touching the form drafts', async () => {
    vi.useFakeTimers()
    const { scope } = readyForm({})
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/pet/pets') {
        return response([{ id: 'whale-girl', displayName: '鲸鱼娘' }, { id: 'jyn', displayName: '女仆鲸鱼娘' }])
      }
      if (path === '/api/pet/state') {
        return response({
          pet: { id: 'whale-girl' },
          pets: [{ id: 'whale-girl', right: 24, bottom: 120 }],
          display: { visible: true, right: 24, bottom: 120 },
        })
      }
      throw new Error('unexpected request: ' + path)
    }))
    const controller = new PetSettingsCardController(scope)
    await vi.advanceTimersByTimeAsync(0)
    const face = controller.inject()

    face.togglePet('jyn')
    face.edit('size', '240')
    expect(face.hooks.petSettingsCard.getSnapshot()).toMatchObject({ dirty: true })

    face.discard()

    // The list is dropped AND the form's own staged size goes with it, so
    // Discard means the same thing on both paths.
    expect(face.hooks.petSettingsCard.getSnapshot()).toMatchObject({
      dirty: false,
      selectedPetIds: ['whale-girl'],
    })
    controller.dispose()
  })
})
