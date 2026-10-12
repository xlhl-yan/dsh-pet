/**
 * The ledger's remark pools are fed from two layers: the pet manifest's own
 * pools (`remarks` in pet.json) and the voice packs (a pet directory's
 * voice.json over the global `$DSH_HOME/pets/.voice.json`). The service seats
 * both layers on startup, on a pet switch, and whenever the settings surface
 * applies a committed section. A call site that passed only the manifest layer
 * dropped every voice-pack line, so a pet whose remarks a voice pack had
 * translated answered from the built-in pools again as soon as the settings
 * surface applied - which is immediately, since it applies on every change.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { loadPetRegistry, petPackageRoot } from './registry.ts'
import { PetService, type PetSettingsSection } from './service.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-pet-service-'))
}

/** A root context stub: the service registers itself and listens for events. */
function fakeRootContext(): Context {
  return {
    reflect: { provide: () => {} },
    on: () => () => {},
    get: () => undefined,
  } as unknown as Context
}

/**
 * A service over the shipped pets plus one temporary user directory carrying the
 * given voice-pack remark pools. `petsDir` is disabled so the legacy hatch-pet
 * source cannot leak the machine's own pets into the fixture.
 */
function serviceWithVoicePack(remarks: Record<string, string[]>): PetService {
  const petsDir = tempDir()
  writeFileSync(join(petsDir, '.voice.json'), JSON.stringify({ voicePackVersion: 1, remarks }))
  const registry = loadPetRegistry({
    packageRoot: petPackageRoot(import.meta.url),
    petsDir: '',
    dshPetsDir: petsDir,
  })
  return new PetService(fakeRootContext(), { registry, persistDir: tempDir() })
}

/**
 * A service over the shipped pets plus one temporary pet directory whose pet.json
 * declares no remark pools and whose voice.json carries them - the writing the
 * voice-pack docs recommend (a pet's lines live in one place). `petsDir` is
 * disabled so the legacy hatch-pet source cannot leak the machine's own pets.
 */
function serviceWithPetVoicePack(id: string, remarks: Record<string, string[]>): PetService {
  const petsDir = tempDir()
  const petDir = join(petsDir, id)
  mkdirSync(petDir, { recursive: true })
  writeFileSync(join(petDir, 'pet.json'), JSON.stringify({
    petManifestVersion: 2,
    id,
    displayName: 'Mumbler',
    license: 'CC0-1.0',
    renderer: 'sprite2d',
    sprite2d: { spritesheetPath: 'spritesheet.webp' },
  }), 'utf8')
  writeFileSync(join(petDir, 'spritesheet.webp'), 'webp', 'utf8')
  writeFileSync(join(petDir, 'voice.json'), JSON.stringify({ voicePackVersion: 1, remarks }), 'utf8')
  const registry = loadPetRegistry({
    packageRoot: petPackageRoot(import.meta.url),
    petsDir: '',
    dshPetsDir: petsDir,
  })
  return new PetService(fakeRootContext(), { registry, persistDir: tempDir() })
}

/** The display fields the settings surface always commits. */
function section(petId: string): PetSettingsSection {
  return { petId, visible: true, size: 160, right: 24, bottom: 20 }
}

describe('PetService remark layers', () => {
  it('user keeps the voice-pack remarks after the settings surface applies a section', async () => {
    const voice = { pet: ['Голос: погладили'], noTreats: ['Голос: нет угощений'] }
    const service = serviceWithVoicePack(voice)

    // The startup path seats both layers: the first petting answers from the
    // voice pack.
    expect((await service.interact('pet')).reaction).toBe(voice.pet[0])

    // Applying a section re-seats the pools. The voice layer must survive it;
    // this is the regression: the manifest layers alone came back, so the pet
    // answered from the built-in pools again.
    service.applySettingsSection(section(service.selectedPetId()))
    expect((await service.interact('feed')).reaction).toBe(voice.noTreats[0])
  })

  it('user keeps the voice-pack remarks after switching pets through the RPC', async () => {
    const voice = { pet: ['Голос: погладили'], noTreats: ['Голос: нет угощений'] }
    const service = serviceWithVoicePack(voice)
    // A pet whose own manifest declares no remark pools: the voice pack is its
    // only layer. A manifest-declared pool outranks the voice packs by contract
    // (RemarkPicker: manifest, then voice, then built-in), so such a pet is not
    // what this case pins.
    const other = service
      .registrySnapshot()
      .entries
      .find(entry => entry.id !== service.selectedPetId() && entry.remarks === undefined)

    expect(other).toBeDefined()
    expect(await service.setPetId(other!.id)).toEqual({ ok: true, petId: other!.id })
    expect((await service.interact('feed')).reaction).toBe(voice.noTreats[0])
  })

  it('user keeps a pet-directory voice pack remarks after the settings surface applies a section', async () => {
    const voice = { pet: ['呼……好多了'], noTreats: ['现在不困啦～'] }
    const service = serviceWithPetVoicePack('mumbler', voice)

    // The reported repro (issue #10): the pet declares no remarks in pet.json,
    // so its own voice pack is the only layer, and the settings surface applies
    // a committed section on every change - that apply seats the pet and its
    // pools. The voice layer has to survive it, or the pet answers from the
    // built-in pools while its panel copy stays translated.
    service.applySettingsSection(section('mumbler'))
    expect(service.selectedPetId()).toBe('mumbler')
    expect((await service.interact('pet')).reaction).toBe(voice.pet[0])
    expect((await service.interact('feed')).reaction).toBe(voice.noTreats[0])
  })
})

/** A service over the shipped pets with an isolated persistence directory. */
function service(): PetService {
  const registry = loadPetRegistry({
    packageRoot: petPackageRoot(import.meta.url),
    petsDir: '',
    dshPetsDir: '',
  })
  return new PetService(fakeRootContext(), { registry, persistDir: tempDir() })
}

/** Two registry ids that exist in the shipped asset set. */
function twoPetIds(svc: PetService): [string, string] {
  const ids = svc.registrySnapshot().entries.map(entry => entry.id)
  expect(ids.length).toBeGreaterThanOrEqual(2)
  return [ids[0]!, ids[1]!]
}

describe('PetService multi-pet coexistence', () => {
  it('reports every on-screen pet in its own state row', async () => {
    const svc = service()
    const [a, b] = twoPetIds(svc)
    await svc.setPets([
      { id: a, right: 10, bottom: 20 },
      { id: b, right: 300, bottom: 40 },
    ])
    const view = await svc.state()
    expect(view.pets?.map(pet => pet.id)).toEqual([a, b])
    // Each row carries its own position, which is what lets two sprites sit
    // apart instead of stacking on the shared display fallback.
    expect(view.pets?.map(pet => pet.right)).toEqual([10, 300])
    expect(view.pets?.map(pet => pet.bottom)).toEqual([20, 40])
    // The singular fields mirror pets[0] for a browser half that predates the
    // list.
    expect(view.pet.id).toBe(a)
  })

  it('drops unknown ids rather than wedging the list', async () => {
    const svc = service()
    const [a] = twoPetIds(svc)
    const result = await svc.setPets([
      { id: a, right: 10, bottom: 20 },
      { id: 'no-such-pet', right: 5, bottom: 5 },
    ])
    expect(result.pets.map(pet => pet.id)).toEqual([a])
  })

  it('keeps the current list when every id is unknown', async () => {
    const svc = service()
    const [a] = twoPetIds(svc)
    await svc.setPets([{ id: a, right: 1, bottom: 2 }])
    const result = await svc.setPets([{ id: 'ghost', right: 9, bottom: 9 }])
    // "No pets at all" is expressed by hiding, so an unusable list must not
    // empty the screen.
    expect(result.pets.map(pet => pet.id)).toEqual([a])
  })

  it('moves one pet without disturbing the other', async () => {
    const svc = service()
    const [a, b] = twoPetIds(svc)
    await svc.setPets([
      { id: a, right: 10, bottom: 20 },
      { id: b, right: 300, bottom: 40 },
    ])
    await svc.setConfig({ right: 700, bottom: 100 }, b)
    const view = await svc.state()
    // The whole point of the petId-scoped write: dragging one sprite must not
    // drag the other.
    expect(view.pets?.find(pet => pet.id === b)).toMatchObject({ right: 700, bottom: 100 })
    expect(view.pets?.find(pet => pet.id === a)).toMatchObject({ right: 10, bottom: 20 })
  })

  it('renames one pet without renaming the other', async () => {
    const svc = service()
    const [a, b] = twoPetIds(svc)
    await svc.setPets([
      { id: a, right: 10, bottom: 20 },
      { id: b, right: 300, bottom: 40 },
    ])
    const originalA = svc.petName(a)
    expect(await svc.setName('新名字', b)).toEqual({ ok: true, name: '新名字' })
    const view = await svc.state()
    expect(view.pets?.find(pet => pet.id === b)?.name).toBe('新名字')
    expect(view.pets?.find(pet => pet.id === a)?.name).toBe(originalA)
  })

  it('rejects a rename aimed at a pet that is not on screen', async () => {
    const svc = service()
    const [a, b] = twoPetIds(svc)
    await svc.setPets([{ id: a, right: 1, bottom: 2 }])
    // Storing a name nothing renders would be dead state.
    expect(await svc.setName('幽灵', b)).toEqual({ ok: false, error: 'unknown-pet' })
  })

  it('collapses to one pet when the single-pet selection RPC is used', async () => {
    const svc = service()
    const [a, b] = twoPetIds(svc)
    await svc.setPets([
      { id: a, right: 10, bottom: 20 },
      { id: b, right: 300, bottom: 40 },
    ])
    // setPetId predates coexistence and still means "make this the only pet".
    expect(await svc.setPetId(b)).toEqual({ ok: true, petId: b })
    const view = await svc.state()
    expect(view.pets?.map(pet => pet.id)).toEqual([b])
  })

  it('keeps the second pet when an unrelated settings edit lands', async () => {
    const svc = service()
    const [a, b] = twoPetIds(svc)
    await svc.setPets([
      { id: a, right: 10, bottom: 20 },
      { id: b, right: 300, bottom: 40 },
    ])
    // The settings surface commits the whole section on every change, always
    // carrying the primary petId. Treating that as a selection change would
    // silently drop the user's second pet on a mere size tweak.
    svc.applySettingsSection({ petId: a, visible: true, size: 200, right: 10, bottom: 20 })
    const view = await svc.state()
    expect(view.pets?.map(pet => pet.id)).toEqual([a, b])
    expect(view.display.size).toBe(200)
  })

  it('persists the list across a restart', async () => {
    const dir = tempDir()
    const registry = loadPetRegistry({
      packageRoot: petPackageRoot(import.meta.url),
      petsDir: '',
      dshPetsDir: '',
    })
    const first = new PetService(fakeRootContext(), { registry, persistDir: dir })
    const [a, b] = twoPetIds(first)
    await first.setPets([
      { id: a, right: 10, bottom: 20 },
      { id: b, right: 300, bottom: 40 },
    ])
    // A fresh service over the same directory must restore both pets and their
    // positions, not just the primary one.
    const second = new PetService(fakeRootContext(), { registry, persistDir: dir })
    const view = await second.state()
    expect(view.pets?.map(pet => pet.id)).toEqual([a, b])
    expect(view.pets?.map(pet => pet.right)).toEqual([10, 300])
  })
})
