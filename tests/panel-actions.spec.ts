import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { PetService } from '../src/service.ts'
import { makePetRoutes } from '../src/routes.ts'
import { loadPetRegistry } from '../src/registry.ts'

/**
 * The two plugin-facing extension points added for issue #6, at the service
 * and HTTP seam a sibling plugin actually touches:
 *
 *  - registerPanelAction(): the pet serves the registration in the state view
 *    and dispatches a click from POST /api/pet/panel-action back to the
 *    plugin's callback, and disposing the registration takes the row away;
 *  - the statusBubbles switch: the settings section's choice reaches the state
 *    view the browser half renders from, and 'off' suppresses nothing but the
 *    pet's own bubbles (the announcement bubble is still served).
 *
 * Rendering is covered by the client bundle's mount assertions.
 */

const WEBP_BYTES = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])

let dir: string
let server: Server
let port: number
let service: PetService

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-pet-panel-actions-'))
  for (const [id, name] of [['whale-girl', '鲸鱼娘'], ['doro', 'doro']] as const) {
    const entry = join(dir, 'assets', id)
    mkdirSync(entry, { recursive: true })
    writeFileSync(join(entry, 'pet.json'), JSON.stringify({ id, displayName: name, spritesheetPath: 'spritesheet.webp' }), 'utf8')
    writeFileSync(join(entry, 'spritesheet.webp'), WEBP_BYTES)
  }

  const ctx = new Context()
  const registry = loadPetRegistry({ packageRoot: dir, petsDir: '', dshPetsDir: '' })
  service = new PetService(ctx, { autonomous: false, persistDir: join(dir, 'home'), registry })
  const routes = makePetRoutes({ service, ctx })
  server = createServer((req, res) => {
    const pathname = (req.url ?? '').split('?')[0] ?? ''
    for (const route of routes) {
      if (route.kind === 'exact' && pathname === route.path) {
        void route.handler(req, res)
        return
      }
    }
    res.writeHead(404)
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
})

/** POST one JSON payload to the running route family, as the browser half does. */
async function post(path: string, body: unknown): Promise<{ status: number; payload: Record<string, unknown> }> {
  const response = await fetch('http://127.0.0.1:' + port + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, payload: await response.json() as Record<string, unknown> }
}

const panelActions = async () => (await service.state()).panelActions

describe('PetService.registerPanelAction', () => {
  it('serves a registered action in the state view and dispatches its click', async () => {
    const onSelect = vi.fn()
    service.registerPanelAction({ id: 'pet-quota-swap', label: '换装', title: '切换到下一只宠物', onSelect })

    // Then the browser half has a row to render ...
    expect(await panelActions()).toEqual([
      { id: 'pet-quota-swap', label: '换装', title: '切换到下一只宠物', order: 0 },
    ])

    // ... and a click arrives back at the plugin that registered it.
    expect(await post('/api/pet/panel-action', { id: 'pet-quota-swap' })).toEqual({
      status: 200,
      payload: { ok: true },
    })
    expect(onSelect).toHaveBeenCalledWith({ petId: await service.state().then(view => view.pet.id) })
  })

  it('reclaims the action with the registration that owns it', async () => {
    const dispose = service.registerPanelAction({ id: 'pet-quota-recycle', label: '回收', onSelect: vi.fn() })
    expect((await panelActions())?.map(action => action.id)).toContain('pet-quota-recycle')

    dispose()
    expect((await panelActions())?.map(action => action.id)).not.toContain('pet-quota-recycle')
    // A click that raced the disposal is a stale click, not a pet failure.
    expect(await post('/api/pet/panel-action', { id: 'pet-quota-recycle' }))
      .toEqual({ status: 200, payload: { ok: false, error: 'unknown-panel-action' } })
  })

  it('keeps a sibling plugin failure from surfacing as pet breakage', async () => {
    service.registerPanelAction({
      id: 'pet-quota-broken',
      label: '坏了',
      onSelect: () => { throw new Error('plugin bug') },
    })

    expect(await post('/api/pet/panel-action', { id: 'pet-quota-broken' }))
      .toEqual({ status: 200, payload: { ok: false, error: 'panel-action-failed' } })
    // The pet still answers its own state.
    expect((await service.state()).pet.id).toBeTruthy()
  })

  it('answers a malformed click with the endpoint error envelope', async () => {
    const response = await post('/api/pet/panel-action', { id: 42 })
    expect(response.status).toBe(400)
    expect(response.payload).toEqual({ ok: false, error: 'invalid-panel-action' })
  })

  it('leaves the state view exactly as before while nothing is registered', () => {
    // The registry is per-service; the shape asserted elsewhere (announce
    // tests) stays valid because an empty row is omitted, not sent as [].
    const empty = new PetService(new Context(), { persistDir: join(dir, 'home-empty'), registry: service.registrySnapshot() })
    return empty.state().then(view => expect(view.panelActions).toBeUndefined())
  })
})

describe('PetService status bubble switch', () => {
  // These cases pin the SESSION-DRIVEN mode's bubble switch. Autonomous mode
  // serves no status bubbles at all, so the switch only has meaning with the
  // session lifecycle attached; the mode itself is covered in
  // autonomous.spec.ts.
  it('serves the shipped default before anyone changes it', async () => {
    const fresh = new PetService(new Context(), { autonomous: false, persistDir: join(dir, 'home-default'), registry: service.registrySnapshot() })
    expect((await fresh.state()).statusBubbles).toBe('auto')
  })

  it('applies the settings section choice to the state view', async () => {
    service.applySettingsSection({
      visible: true,
      size: 160,
      right: 24,
      bottom: 20,
      statusBubbles: 'off',
    })

    const view = await service.state()
    // Only the rendering choice changes: the wire still carries the bubble
    // facts, so the browser half is the single place that suppresses them.
    expect(view.statusBubbles).toBe('off')
    expect(view.sessions).toEqual([])
    service.announce({ source: 'dsh-pet-quota', kind: 'cost', title: '今日 tokens', amount: '1.2M', tone: 'ok' })
    expect((await service.state()).announcement?.source).toBe('dsh-pet-quota')
    service.announce({ kind: 'cost' })
  })

  it('falls back to the shipped behavior for an unknown mode', async () => {
    // A hand-edited or older settings document must not silently lose the
    // pet's bubbles: anything that is not 'off' renders them.
    service.applySettingsSection({
      visible: true,
      size: 160,
      right: 24,
      bottom: 20,
      statusBubbles: 'nonsense' as never,
    })
    expect((await service.state()).statusBubbles).toBe('auto')
  })
})
