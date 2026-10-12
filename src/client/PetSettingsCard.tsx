/**
 * The pet settings card: pet selection plus display layout, staged over the
 * 'pet' profile entry's own configuration (a plugin's settings ARE its Cordis
 * Config since 0.1.7, so the Host serves one form per profile entry).
 * Rendered as an always-open first-level settings page; the section wrapper
 * below mounts it as the content of the top-level 'settings.section' nav
 * entry. The petId choices come from the registry endpoint ('/api/pet/pets') —
 * the same list the sprite renders from — so the card carries no per-pet
 * knowledge.
 */

import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
// Type-only: pulls the settings-surface SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { PluginSettingsCard, ValueField, BooleanField, ChoiceField, MultiChoiceField } from './PluginSettingsCard.tsx'
import { CardForm, booleanField, choiceField, numberField, type CardActions, type CardShell, type FieldState as CardFieldState } from './settings-form.ts'
import { EDGE_MARGIN_MIN } from '../persist.ts'
import sectionCss from './settings-section.module.css'

/** The pet's settings fields this card edits (the namespace's full schema). */
export interface PetSettings {
  /** Master switch for the plugin. */
  enabled?: boolean
  /** Master switch. */
  visible?: boolean
  /** Scale of the rendered pet in px (sprite cell height). */
  size?: number
  /** Horizontal inset from the viewport right edge, px. */
  right?: number
  /** Vertical inset from the viewport bottom edge, px. */
  bottom?: number
  /** Bubble typography multiplier on the automatic size following (#1549). */
  bubbleScale?: number
  /** Gap kept between a sprite and the left viewport edge, px. */
  edgeMarginLeft?: number
  /** Gap kept between a sprite and the right viewport edge, px. */
  edgeMarginRight?: number
  /** Selected pet id (a registry entry). */
  petId?: string
  /** Status-decoration master switch (pet-center M5, #567). */
  decorationEnabled?: boolean
  /** Whether the pet's own session/status bubbles render (issue #6). */
  statusBubbles?: string
  /** Whether the pets ignore the DSH session lifecycle. */
  autonomous?: boolean
}

/** What the pet settings card renders. */
export interface PetSettingsCardState extends CardShell {
  /** The aggregate shell has no Host settings form; pet selection uses its own persisted API. */
  petSelectionFallback: boolean
  /** Plugin master switch. */
  enabled: CardFieldState
  /** Master switch. */
  visible: CardFieldState
  /** Pet scale. */
  size: CardFieldState
  /** Right inset. */
  right: CardFieldState
  /** Bottom inset. */
  bottom: CardFieldState
  /** Bubble typography multiplier. */
  bubbleScale: CardFieldState
  /** Gap kept between a sprite and the left viewport edge. */
  edgeMarginLeft: CardFieldState
  /** Gap kept between a sprite and the right viewport edge. */
  edgeMarginRight: CardFieldState
  /** Selected pet. */
  petId: CardFieldState
  /** Every pet currently on screen, in render order (the first is the primary). */
  selectedPetIds: readonly string[]
  /** Whether the persisted on-screen list has loaded; false disables the control. */
  selectionKnown: boolean
  /** Status-decoration master switch. */
  decorationEnabled: CardFieldState
  /** Whether the pet's own session/status bubbles render. */
  statusBubbles: CardFieldState
  /** Whether the pets ignore the DSH session lifecycle. */
  autonomous: CardFieldState
  /** Pet choices (registry ids + display names), loaded from the host. */
  petChoices: readonly { value: string; label: string }[]
}

/** The registration-side face the card's slot entry injects. */
export interface PetSettingsCardFace extends CardActions {
  /**
   * Add or remove one pet from the on-screen list.
   *
   * The list is an array, which the staged scalar form cannot express, so it
   * gets its own action rather than riding `edit`. The change is staged and
   * written by the card's save, exactly like every other field.
   * @param petId - the registry id to toggle.
   */
  togglePet: (petId: string) => void
  hooks: {
    /** Card snapshot bound by the renderer as usePetSettingsCard. */
    petSettingsCard: SnapshotStore<PetSettingsCardState>
  }
}

/**
 * The bubble modes this card can write, in render order. Mirrors the host
 * schema's union (see PetStatusBubbleMode); the browser half never imports the
 * host module for a value, so the accepted set is spelled here as literals.
 */
const STATUS_BUBBLE_CHOICES = ['auto', 'off'] as const

/** One registry choice as served by '/api/pet/pets'. */
interface PetChoice {
  id: string
  displayName: string
}

/** Fetch the registry list (the same data the sprite renders from). */
async function fetchPetChoices(): Promise<PetChoice[]> {
  const response = await fetch('/api/pet/pets')
  if (!response.ok) throw new Error('pet pets failed: ' + response.status)
  return (await response.json()) as PetChoice[]
}

/** The persisted state the card mirrors: the on-screen pets and their visibility. */
interface PetState {
  /** Every pet currently on screen, in render order; the first is the primary. */
  pets: { id: string; right: number; bottom: number }[]
  /** Whether the pets are currently rendered. */
  visible: boolean
  /** The global display insets, used to place a newly added pet. */
  right: number
  /** The global display insets, used to place a newly added pet. */
  bottom: number
}

/**
 * Read the on-screen pets and visibility from the same persisted state the
 * sprites render from.
 *
 * The list is authoritative: `pets[]` is what the host actually renders, so a
 * selection the registry no longer knows (or a pet the user removed elsewhere)
 * is reflected here instead of being reconstructed from the singular field.
 * Each pet's own insets ride along, so a save can rewrite the list without
 * resetting positions the user dragged. A host predating coexistence serves
 * only `pet`, which becomes a one-element list so the card still works.
 */
async function fetchPetState(): Promise<PetState> {
  const response = await fetch('/api/pet/state')
  if (!response.ok) throw new Error('pet state failed: ' + response.status)
  const body = (await response.json()) as {
    pet?: { id?: unknown }
    pets?: unknown
    display?: { visible?: unknown; right?: unknown; bottom?: unknown }
  }
  const right = typeof body.display?.right === 'number' ? body.display.right : 24
  const bottom = typeof body.display?.bottom === 'number' ? body.display.bottom : 120
  const listed = Array.isArray(body.pets)
    ? body.pets.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return []
        const record = entry as { id?: unknown; right?: unknown; bottom?: unknown }
        if (typeof record.id !== 'string' || record.id === '') return []
        return [{
          id: record.id,
          right: typeof record.right === 'number' ? record.right : right,
          bottom: typeof record.bottom === 'number' ? record.bottom : bottom,
        }]
      })
    : []
  const pets = listed.length > 0
    ? listed
    : typeof body.pet?.id === 'string' && body.pet.id !== ''
      ? [{ id: body.pet.id, right, bottom }]
      : []
  if (pets.length === 0) throw new Error('pet state has no on-screen pet')
  // A Host without the display block predates the visibility switch; the pet shows.
  return { pets, visible: body.display?.visible !== false, right, bottom }
}

/**
 * The horizontal gap between two pets placed by the card, px.
 *
 * Wide enough that the default 160px sprite does not overlap its neighbour when
 * the user adds a second pet from the settings page.
 */
const PET_ADD_OFFSET_PX = 180

/** Whether two id lists name the same pets in the same order. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

/** Bridges the 'pet' scope onto the card's staged form. */
export class PetSettingsCardController {
  private readonly form: CardForm<PetSettings>
  private readonly store: SnapshotStore<PetSettingsCardState>
  // The choice list rides a mutable array shared with the choiceField spec,
  // so loading the registry re-validates and re-formats the petId field
  // without rebuilding the form.
  private readonly petChoices: string[] = []
  private readonly petLabels = new Map<string, string>()
  /** Every pet on screen, in render order (the first is the primary). */
  private selectedPets: PetState['pets'] | undefined
  private selectedVisible: boolean | undefined
  /** Global insets, used to place a pet the user adds from this card. */
  private selectedRight = 24
  private selectedBottom = 120
  /** The staged on-screen list, before the user saves. */
  private stagedPetIds: string[] | undefined
  private stagedVisible: boolean | undefined
  private savingPet = false
  private petSaveFailed = false
  private loaded = false
  private attempts = 0
  private disposed = false
  /** Pending deferred-load or retry timer; cancelled by dispose(). */
  private pendingTimer: number | undefined

  /** @param scope - the bound configuration form for the 'pet' entry. */
  constructor(scope: ConfigForm<PetSettings>) {
    this.form = new CardForm(scope, [
      booleanField('enabled'),
      booleanField('decorationEnabled'),
      // The bubble switch is a two-value mode, not a boolean: 'off' is the
      // opt-out, and a future mode (say, one that keeps only the current
      // session's bubble) has to be able to join the same field without
      // breaking every settings document already written.
      choiceField('statusBubbles', STATUS_BUBBLE_CHOICES),
      // The pets' independence from the DSH session lifecycle. On by default;
      // turning it off restores the original session-driven animation and the
      // status readout (the two switches above then matter again).
      booleanField('autonomous'),
      booleanField('visible'),
      numberField('size'),
      numberField('right'),
      numberField('bottom'),
      numberField('bubbleScale'),
      // The gaps a pet keeps from the viewport edges. They are display fields
      // like the position ones, persisted in the same block.
      numberField('edgeMarginLeft', { integer: true, min: EDGE_MARGIN_MIN }),
      numberField('edgeMarginRight', { integer: true, min: EDGE_MARGIN_MIN }),
      choiceField('petId', this.petChoices),
    ])
    this.store = this.form.bind(() => this.projection())
    // Client plugins are applied synchronously during shell startup. Defer
    // the first registry request until that pass completes so transport
    // plugins (notably remote-web-ui on a paired non-loopback origin) can
    // install their fetch channel before /api/pet/pets is issued.
    this.pendingTimer = window.setTimeout(() => {
      this.pendingTimer = undefined
      if (this.disposed) return
      void this.loadPets()
      void this.loadPetState()
    }, 0)
  }

  /** Resolve the registry choices once (retried a few times on failure). */
  private async loadPets(): Promise<void> {
    if (this.loaded || this.disposed) return
    try {
      const list = await fetchPetChoices()
      if (this.disposed) return
      this.petChoices.splice(0, this.petChoices.length, ...list.map(choice => choice.id))
      for (const choice of list) this.petLabels.set(choice.id, choice.displayName)
      this.loaded = true
      this.store.set(this.projection())
    } catch {
      if (this.disposed) return
      this.attempts += 1
      if (this.attempts < 3) {
        this.pendingTimer = window.setTimeout(() => {
          this.pendingTimer = undefined
          if (this.disposed) return
          void this.loadPets()
        }, 3000)
      }
    }
  }

  private async loadPetState(): Promise<void> {
    try {
      const state = await fetchPetState()
      if (this.disposed) return
      this.selectedPets = state.pets
      this.selectedVisible = state.visible
      this.selectedRight = state.right
      this.selectedBottom = state.bottom
      this.store.set(this.projection())
    } catch {
      // The Host form remains the authority when it is available. An absent
      // pet API leaves the selection unavailable rather than inventing state.
    }
  }

  private fallback(): boolean {
    const shell = this.form.shell()
    return shell.available && !shell.exposed && this.selectedPets !== undefined
  }

  /** The on-screen list as it stands now, staged draft first. */
  private currentPetIds(): string[] {
    return this.stagedPetIds ?? this.selectedPets?.map(pet => pet.id) ?? []
  }

  /**
   * The visibility the fallback switch renders: the staged draft when the user
   * moved it, the persisted value otherwise. There is no user layer to override
   * here, so the field is never marked overridden.
   */
  private fallbackVisible(): CardFieldState {
    const value = this.stagedVisible ?? this.selectedVisible
    return { text: value === undefined ? '' : String(value), overridden: false, invalid: false }
  }

  /**
   * Persist the staged pet list and visibility through the pet API — the only
   * writer available when the aggregate shell serves this card, since there is
   * no Host settings form to mutate — then confirm the read-back before the
   * drafts are cleared.
   *
   * The list rides `/api/pet/set-pets` in one call, which is what makes adding
   * a pet and moving the existing ones a single atomic write: the poll can
   * never observe a half-applied list.
   */
  private async saveFallback(): Promise<void> {
    const petIds = this.stagedPetIds
    const visible = this.stagedVisible
    if (this.savingPet) return
    if (petIds === undefined && visible === undefined) return
    // An empty list is not a selection: the host keeps its current list, so
    // saving one would silently do nothing while reporting success.
    if (petIds !== undefined && petIds.length === 0) return
    this.savingPet = true
    this.petSaveFailed = false
    this.store.set(this.projection())
    try {
      if (petIds !== undefined) {
        const persisted = await this.persistPetList(petIds)
        if (!sameIds(persisted.map(pet => pet.id), petIds)) {
          throw new Error('pet list was not persisted')
        }
      }
      if (visible !== undefined) {
        const response = await fetch('/api/pet/set-visible', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ visible }),
        })
        if (!response.ok) throw new Error('pet visibility was not persisted')
      }
      const confirmed = await fetchPetState()
      if (petIds !== undefined && !sameIds(confirmed.pets.map(pet => pet.id), petIds)) {
        throw new Error('pet list was not persisted')
      }
      if (visible !== undefined && confirmed.visible !== visible) throw new Error('pet visibility was not persisted')
      this.selectedPets = confirmed.pets
      this.selectedVisible = confirmed.visible
      if (this.stagedPetIds === petIds) this.stagedPetIds = undefined
      if (this.stagedVisible === visible) this.stagedVisible = undefined
    } catch {
      this.petSaveFailed = true
    } finally {
      this.savingPet = false
      if (!this.disposed) this.store.set(this.projection())
    }
  }

  /**
   * Write the on-screen list, giving any newly added pet a position of its own.
   *
   * Pets already on screen keep the insets the host reported (and therefore the
   * spot the user dragged them to); only an id the host did not previously hold
   * gets a fresh offset beside the global fallback, so adding a second pet does
   * not stack it exactly on top of the first and look like nothing happened.
   *
   * The positions come from the live read rather than a cached copy: a drag that
   * landed since the card loaded must not be undone by this save.
   * @param petIds - the desired on-screen list, in render order.
   * @returns the list the host reports back, with its positions.
   */
  private async persistPetList(petIds: readonly string[]): Promise<PetState['pets']> {
    const live = await fetchPetState()
    const known = new Map(live.pets.map(pet => [pet.id, pet] as const))
    let added = 0
    const pets = petIds.map((id) => {
      const existing = known.get(id)
      if (existing !== undefined) return existing
      added += 1
      return {
        id,
        right: this.selectedRight + added * PET_ADD_OFFSET_PX,
        bottom: this.selectedBottom,
      }
    })
    const response = await fetch('/api/pet/set-pets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pets }),
    })
    const result = (await response.json()) as { ok?: boolean; pets?: unknown }
    if (!response.ok || result.ok !== true || !Array.isArray(result.pets)) {
      throw new Error('pet list was not persisted')
    }
    return result.pets.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return []
      const record = entry as { id?: unknown; right?: unknown; bottom?: unknown }
      if (typeof record.id !== 'string') return []
      return [{
        id: record.id,
        right: typeof record.right === 'number' ? record.right : this.selectedRight,
        bottom: typeof record.bottom === 'number' ? record.bottom : this.selectedBottom,
      }]
    })
  }

  private projection(): PetSettingsCardState {
    const fallback = this.fallback()
    const shell = this.form.shell()
    const petIds = this.currentPetIds()
    // The selection is always served from the pet API, never from the settings
    // document: the list is an array while every Config field is a scalar, and
    // the host's own `setPetId` means "collapse to this one pet". Both card
    // modes therefore render the same multi-select, and saving writes the list
    // through `/api/pet/set-pets` whichever mode is active.
    const selectionKnown = this.selectedPets !== undefined
    const persistedIds = this.selectedPets?.map(pet => pet.id) ?? []
    // The list is staged OUTSIDE the settings form, so the form's own plan knows
    // nothing about it. Both the dirty flag and the save button have to be told,
    // or ticking a pet leaves Save disabled and the edit unreachable.
    const selectionDirty = this.stagedPetIds !== undefined && !sameIds(this.stagedPetIds, persistedIds)
    const visibilityDirty = this.stagedVisible !== undefined && this.stagedVisible !== this.selectedVisible
    return {
      ...shell,
      dirty: shell.dirty || selectionDirty || visibilityDirty,
      // A pet-list write crosses the wire outside the settings form, so its
      // in-flight and failure states have to ride along too: otherwise the Save
      // button stays live during the write and a refusal is never surfaced.
      saving: shell.saving || this.savingPet,
      failed: shell.failed || this.petSaveFailed,
      ...(fallback ? {
        exposed: true,
        writable: true,
        dirty: selectionDirty || visibilityDirty,
        invalid: false,
        saving: this.savingPet,
        failed: this.petSaveFailed,
        failedReason: undefined,
      } : {}),
      petSelectionFallback: fallback,
      enabled: this.form.field('enabled'),
      decorationEnabled: this.form.field('decorationEnabled'),
      statusBubbles: this.form.field('statusBubbles'),
      autonomous: this.form.field('autonomous'),
      visible: fallback ? this.fallbackVisible() : this.form.field('visible'),
      size: this.form.field('size'),
      right: this.form.field('right'),
      bottom: this.form.field('bottom'),
      bubbleScale: this.form.field('bubbleScale'),
      edgeMarginLeft: this.form.field('edgeMarginLeft'),
      edgeMarginRight: this.form.field('edgeMarginRight'),
      petId: {
        text: petIds[0] ?? '',
        overridden: false,
        invalid: petIds.length === 0 && selectionKnown,
      },
      selectedPetIds: petIds,
      selectionKnown,
      petChoices: this.petChoices.map(id => ({ value: id, label: this.petLabels.get(id) ?? id })),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): PetSettingsCardFace {
    const actions = this.form.actions()
    return {
      hooks: { petSettingsCard: this.store },
      edit: (field, value) => {
        if (!this.fallback()) return actions.edit(field, value)
        if (field === 'visible') this.stagedVisible = value === '' ? undefined : value === 'true'
        else return
        this.petSaveFailed = false
        this.store.set(this.projection())
      },
      resetField: (field) => {
        if (!this.fallback()) return actions.resetField(field)
        if (field === 'visible') this.stagedVisible = undefined
        else return
        this.petSaveFailed = false
        this.store.set(this.projection())
      },
      togglePet: (petId) => {
        // Staged against the list as it stands, so several toggles compose
        // before a single save writes them.
        const current = this.currentPetIds()
        const next = current.includes(petId)
          ? current.filter(id => id !== petId)
          : [...current, petId]
        // The host keeps at least one pet, so an empty list is not a state the
        // user can stage: removing the last one would silently do nothing on
        // save, which reads as a broken control.
        if (next.length === 0) return
        this.stagedPetIds = sameIds(next, this.selectedPets?.map(pet => pet.id) ?? []) ? undefined : next
        this.petSaveFailed = false
        this.store.set(this.projection())
      },
      save: () => { if (this.fallback()) void this.saveFallback(); else void this.saveSelection() },
      discard: () => {
        // The list and the visibility switch are staged outside the settings
        // form, so Discard has to clear them on both paths; the form's own
        // drafts are dropped by its own discard.
        this.stagedPetIds = undefined
        this.stagedVisible = undefined
        this.petSaveFailed = false
        if (!this.fallback()) actions.discard()
        this.store.set(this.projection())
      },
    }
  }

  /**
   * Persist the staged selection when the Host settings form IS available.
   *
   * The list and the visibility switch both go through the pet API rather than
   * the settings document (see {@link projection}), so this is the same write
   * the fallback path makes; it additionally flushes whatever other fields the
   * form staged, so one Save click means one write for the whole card.
   */
  private async saveSelection(): Promise<void> {
    if (this.stagedPetIds !== undefined || this.stagedVisible !== undefined) {
      await this.saveFallback()
    }
    this.form.actions().save()
  }

  /**
   * Release the card's scope subscription, bound stores and pending load
   * timers; the slot disposer calls this on teardown.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.pendingTimer !== undefined) {
      window.clearTimeout(this.pendingTimer)
      this.pendingTimer = undefined
    }
    this.form.dispose()
  }
}

/** Props the renderer binds for the pet settings card. */
export type PetSettingsCardProps =
  PropsLocale<'pet'>
  & InjectFace<PetSettingsCardFace>

/**
 * Render the pet settings card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function PetSettingsCard(props: PetSettingsCardProps) {
  const { t } = props
  const state = props.usePetSettingsCard(snapshot => snapshot)
  const disabled = !state.writable
  const fieldProps = {
    overriddenLabel: t('settings.overridden'),
    resetLabel: t('settings.reset'),
    invalidLabel: t('settings.invalidNumber'),
    disabled,
  }
  return (
    <PluginSettingsCard
      t={t}
      titleKey="settings.title"
      descriptionKey="settings.description"
      descriptionNode={state.petSelectionFallback ? t('settings.petHint') : undefined}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
      alwaysOpen
    >
      {state.petSelectionFallback ? null : <BooleanField
        id="settings-pet-enabled"
        label={t('settings.enabled')}
        hint={t('settings.enabledHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.enabled}
        onEdit={(text) => { props.edit('enabled', text) }}
        onReset={() => { props.resetField('enabled') }}
      />}
      {state.petSelectionFallback ? null : <BooleanField
        id="settings-pet-autonomous"
        label={t('settings.autonomous')}
        hint={t('settings.autonomousHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.autonomous}
        onEdit={(text) => { props.edit('autonomous', text) }}
        onReset={() => { props.resetField('autonomous') }}
      />}
      {state.petSelectionFallback ? null : <BooleanField
        id="settings-pet-decoration"
        label={t('settings.decoration')}
        hint={t('settings.decorationHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.decorationEnabled}
        onEdit={(text) => { props.edit('decorationEnabled', text) }}
        onReset={() => { props.resetField('decorationEnabled') }}
      />}
      {state.petSelectionFallback ? null : <ChoiceField
        id="settings-pet-status-bubbles"
        label={t('settings.statusBubbles')}
        hint={t('settings.statusBubblesHint')}
        inheritLabel={t('settings.inherit')}
        {...fieldProps}
        {...state.statusBubbles}
        choices={[
          { value: STATUS_BUBBLE_CHOICES[0], label: t('settings.on') },
          { value: STATUS_BUBBLE_CHOICES[1], label: t('settings.off') },
        ]}
        onEdit={(text) => { props.edit('statusBubbles', text) }}
        onReset={() => { props.resetField('statusBubbles') }}
      />}
      <MultiChoiceField
        id="settings-pet-pet"
        label={t('settings.pet')}
        hint={t('settings.petHint')}
        choices={state.petChoices}
        selected={state.selectedPetIds}
        disabled={disabled || !state.selectionKnown}
        onToggle={(value) => { props.togglePet(value) }}
        selectedLabel={t('settings.petLastSelected')}
      />
      <BooleanField
        id="settings-pet-visible"
        label={t('settings.visible')}
        hint={t('settings.visibleHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.visible}
        onEdit={(text) => { props.edit('visible', text) }}
        onReset={() => { props.resetField('visible') }}
      />
      {state.petSelectionFallback ? null : <ValueField
        id="settings-pet-size"
        label={t('settings.size')}
        hint={t('settings.sizeHint')}
        numeric
        {...fieldProps}
        {...state.size}
        onEdit={(text) => { props.edit('size', text) }}
        onReset={() => { props.resetField('size') }}
      />}
      {state.petSelectionFallback ? null : <ValueField
        id="settings-pet-right"
        label={t('settings.right')}
        hint={t('settings.rightHint')}
        numeric
        {...fieldProps}
        {...state.right}
        onEdit={(text) => { props.edit('right', text) }}
        onReset={() => { props.resetField('right') }}
      />}
      {state.petSelectionFallback ? null : <ValueField
        id="settings-pet-bottom"
        label={t('settings.bottom')}
        hint={t('settings.bottomHint')}
        numeric
        {...fieldProps}
        {...state.bottom}
        onEdit={(text) => { props.edit('bottom', text) }}
        onReset={() => { props.resetField('bottom') }}
      />}
      {state.petSelectionFallback ? null : <ValueField
        id="settings-pet-bubble-scale"
        label={t('settings.bubbleScale')}
        hint={t('settings.bubbleScaleHint')}
        numeric
        {...fieldProps}
        {...state.bubbleScale}
        onEdit={(text) => { props.edit('bubbleScale', text) }}
        onReset={() => { props.resetField('bubbleScale') }}
      />}
      {state.petSelectionFallback ? null : <ValueField
        id="settings-pet-edge-margin-left"
        label={t('settings.edgeMarginLeft')}
        hint={t('settings.edgeMarginLeftHint')}
        numeric
        {...fieldProps}
        {...state.edgeMarginLeft}
        onEdit={(text) => { props.edit('edgeMarginLeft', text) }}
        onReset={() => { props.resetField('edgeMarginLeft') }}
      />}
      {state.petSelectionFallback ? null : <ValueField
        id="settings-pet-edge-margin-right"
        label={t('settings.edgeMarginRight')}
        hint={t('settings.edgeMarginRightHint')}
        numeric
        {...fieldProps}
        {...state.edgeMarginRight}
        onEdit={(text) => { props.edit('edgeMarginRight', text) }}
        onReset={() => { props.resetField('edgeMarginRight') }}
      />}
    </PluginSettingsCard>
  )
}

/** Props the settings section binds for the pet card page. */
export type PetSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'pet'>
  & InjectFace<PetSettingsCardFace>

/** Render the pet settings card as a first-level settings page. */
export function PetSettingsSection(props: PetSettingsSectionProps): ReactNode {
  const { t, usePetSettingsCard, save, discard, edit, resetField, togglePet } = props
  return (
    <ul className={sectionCss.sectionList}>
      <PetSettingsCard t={t} usePetSettingsCard={usePetSettingsCard} save={save} discard={discard} edit={edit} resetField={resetField} togglePet={togglePet} />
    </ul>
  )
}
