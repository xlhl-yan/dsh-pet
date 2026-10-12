/**
 * Autonomous mode: the pets run independently of the DSH session lifecycle.
 *
 * The point of the mode is a real separation, not a display filter: no session
 * listener is installed at all, so the agent's activity cannot reach the pets
 * through any path. These cases pin that, plus the surfaces that must go
 * quiet with it (status bubbles, the status decoration) and the ones that must
 * survive (interaction feedback, a sibling plugin's announcement).
 *
 * The session-driven behaviour is covered by service-enabled.spec.ts, whose
 * fixtures set `autonomous: false` explicitly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { loadPetRegistry, resolvePetManifest, type PetEntry, type PetRegistry } from '../src/registry.ts'
import { makePetRoutes } from '../src/routes.ts'
import { PetService } from '../src/service.ts'

/** A two-pet registry fixture built from the shipped manifest shape. */
function fixtureRegistry(): PetRegistry {
  const warnings: string[] = []
  const whale = resolvePetManifest({
    id: 'whale-girl',
    displayName: '鲸鱼娘',
    spritesheetPath: 'spritesheet.webp',
  }, join(tmpdir(), 'whale'), { warnings })!
  const otter = resolvePetManifest({
    id: 'otter',
    displayName: '水獭',
    spritesheetPath: 'spritesheet.webp',
  }, join(tmpdir(), 'otter'), { warnings })!
  const entries: PetEntry[] = [whale, otter]
  return {
    entries,
    warnings,
    diagnostics: [],
    byId: id => entries.find(entry => entry.id === id),
    defaultEntry: () => entries[0]!,
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-pet-autonomous-'))
}

/** One turn-end event, the shape the projection consumes. */
function turnEnd(turn: number, seq: number): SessionEvent {
  return { type: 'turn/end', seq, data: { turn, reason: { kind: 'completed' } } } as unknown as SessionEvent
}

/** A session stub: the service only reads `id` and `header.origin`. */
function makeSession(id: string): Session {
  return { id, header: { origin: 'user' } } as unknown as Session
}

describe('PetService autonomous mode', () => {
  it('is on by default', async () => {
    const ctx = new Context()
    const dir = tempDir()
    try {
      const service = new PetService(ctx, { persistDir: dir, registry: fixtureRegistry() })
      const view = await service.state()
      expect(view.autonomous).toBe(true)
      expect(service.isAutonomous()).toBe(true)
      expect(view.animation).toBe('idle')
      expect(view.phase).toBe('idle')
      expect(view.sessionActive).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores session events entirely, so no agent state reaches the pets', async () => {
    const ctx = new Context()
    const dir = tempDir()
    const session = makeSession('s-autonomous')
    try {
      const service = new PetService(ctx, { persistDir: dir, registry: fixtureRegistry() })
      // A completed turn would normally animate the celebration and award a
      // turn point. In autonomous mode the plugin holds no listener at all, so
      // neither happens.
      ctx.emit('session/event', session, turnEnd(1, 1))
      const view = await service.state()
      expect(view.animation).toBe('idle')
      expect(view.phase).toBe('idle')
      expect(view.sessionActive).toBe(false)
      expect(view.affinity.turns).toBe(0)
      // No session-derived surfaces are served either.
      expect(view.sessions).toEqual([])
      expect(view.bubble).toBeUndefined()
      expect(view.decoration).toBeUndefined()
      expect(view.statusBubbles).toBe('off')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports every pet as idle regardless of the list', async () => {
    const ctx = new Context()
    const dir = tempDir()
    try {
      const service = new PetService(ctx, { persistDir: dir, registry: fixtureRegistry() })
      await service.setPets([
        { id: 'whale-girl', right: 10, bottom: 20 },
        { id: 'otter', right: 300, bottom: 40 },
      ])
      const view = await service.state()
      expect(view.pets?.map(pet => pet.id)).toEqual(['whale-girl', 'otter'])
      // Every row is idle; the per-pet positions are still independent.
      expect(view.pets?.map(pet => pet.animation)).toEqual(['idle', 'idle'])
      expect(view.pets?.map(pet => pet.phase)).toEqual(['idle', 'idle'])
      expect(view.pets?.map(pet => pet.right)).toEqual([10, 300])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still renders interaction feedback and a sibling announcement', async () => {
    const ctx = new Context()
    const dir = tempDir()
    try {
      const service = new PetService(ctx, { persistDir: dir, registry: fixtureRegistry() })
      // Petting and feeding are the pets' own business, not the agent's, so
      // they keep working with their reaction copy.
      const petting = await service.interact('pet')
      expect(petting.reaction).not.toBe('')
      expect(petting.delta).toBeGreaterThan(0)
      // A sibling plugin's announcement is an explicit push, not a readout of
      // agent state, so it survives too.
      service.announce({ source: 'dsh-pet-quota', kind: 'cost', title: '今日 tokens', amount: '1.2M', tone: 'ok' })
      expect((await service.state()).announcement?.source).toBe('dsh-pet-quota')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('takes effect immediately when switched off through the RPC', async () => {
    const ctx = new Context()
    const dir = tempDir()
    const session = makeSession('s-switch')
    try {
      const service = new PetService(ctx, { persistDir: dir, registry: fixtureRegistry() })
      // Detached: the event is ignored.
      ctx.emit('session/event', session, turnEnd(1, 1))
      expect((await service.state()).animation).toBe('idle')

      // Reattached through the RPC: the listeners are installed right away, so
      // the very next event drives the pets without a restart.
      expect(await service.setAutonomous(false)).toEqual({ ok: true, autonomous: false })
      ctx.emit('session/event', session, turnEnd(1, 2))
      const view = await service.state()
      expect(view.animation).toBe('jumping')
      expect(view.autonomous).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('clears stale activity when reattaching, so no old phase is replayed', async () => {
    const ctx = new Context()
    const dir = tempDir()
    const session = makeSession('s-stale')
    try {
      const service = new PetService(ctx, { autonomous: false, persistDir: dir, registry: fixtureRegistry() })
      // Build up an in-flight tool phase while attached.
      ctx.emit('session/event', session, {
        type: 'tool/call',
        seq: 1,
        data: { turn: 1, step: 1, callId: 'c1', name: 'shell', input: {} },
      } as unknown as SessionEvent)
      expect((await service.state()).phase).toBe('tool')

      // Detaching drops that transient activity: reattaching must not bring
      // back a phase whose terminal event may already have been missed.
      await service.setAutonomous(true)
      await service.setAutonomous(false)
      expect(await service.state()).toMatchObject({ animation: 'idle', phase: 'idle', sessionActive: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('lets the settings section switch the mode', async () => {
    const ctx = new Context()
    const dir = tempDir()
    const session = makeSession('s-section')
    try {
      const service = new PetService(ctx, { persistDir: dir, registry: fixtureRegistry() })
      expect(service.isAutonomous()).toBe(true)

      service.applySettingsSection({
        visible: true,
        size: 160,
        right: 24,
        bottom: 20,
        autonomous: false,
      })
      expect(service.isAutonomous()).toBe(false)
      ctx.emit('session/event', session, turnEnd(1, 1))
      expect((await service.state()).animation).toBe('jumping')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the current mode when a section does not mention it', async () => {
    const dir = tempDir()
    try {
      // Attached on purpose, then a partial section lands (an older settings
      // surface, or a sibling plugin applying display fields only). The absent
      // field must not silently detach the pets.
      const service = new PetService(new Context(), { autonomous: false, persistDir: dir, registry: fixtureRegistry() })
      service.applySettingsSection({ visible: true, size: 200, right: 10, bottom: 20 })
      expect(service.isAutonomous()).toBe(false)
      expect((await service.state()).autonomous).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores a settings section that does not carry the switch', async () => {
    const ctx = new Context()
    const dir = tempDir()
    try {
      // The shipped default must not be undone by an unrelated edit: a
      // settings surface that predates the switch commits the whole section on
      // every change, and every one of those would otherwise reattach the pets.
      const service = new PetService(ctx, { persistDir: dir, registry: fixtureRegistry() })
      service.applySettingsSection({ visible: true, size: 200, right: 10, bottom: 20 })
      expect(service.isAutonomous()).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('survives a restart as the stored preference', async () => {
    const dir = tempDir()
    try {
      // The switch is a plugin-level preference, so a fresh service starts
      // from its own default rather than inheriting the previous run: the
      // settings document is what carries the choice across restarts. Each
      // service needs its own Context — the pet service registers itself under
      // one name per root.
      const first = new PetService(new Context(), { autonomous: false, persistDir: dir, registry: fixtureRegistry() })
      expect(first.isAutonomous()).toBe(false)
      const second = new PetService(new Context(), { persistDir: dir, registry: fixtureRegistry() })
      expect(second.isAutonomous()).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('autonomous mode over the HTTP surface', () => {
  let server: Server
  let port = 0
  let dir = ''
  let service: PetService

  beforeAll(async () => {
    dir = tempDir()
    const ctx = new Context()
    service = new PetService(ctx, { persistDir: join(dir, 'home'), registry: fixtureRegistry() })
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

  it('serves the autonomous flag in the state view', async () => {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/pet/state`)).json()
    expect(body.autonomous).toBe(true)
    expect(body.phase).toBe('idle')
    expect(body.decoration).toBeUndefined()
  })

  it('switches the mode through the endpoint', async () => {
    const off = await fetch(`http://127.0.0.1:${port}/api/pet/set-autonomous`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autonomous: false }),
    })
    expect(await off.json()).toEqual({ ok: true, autonomous: false })
    expect((await (await fetch(`http://127.0.0.1:${port}/api/pet/state`)).json()).autonomous).toBe(false)

    const on = await fetch(`http://127.0.0.1:${port}/api/pet/set-autonomous`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autonomous: true }),
    })
    expect(await on.json()).toEqual({ ok: true, autonomous: true })
  })

  it('rejects a non-boolean value instead of guessing', async () => {
    const bad = await fetch(`http://127.0.0.1:${port}/api/pet/set-autonomous`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autonomous: 'yes' }),
    })
    expect(bad.status).toBeGreaterThanOrEqual(400)
  })
})
