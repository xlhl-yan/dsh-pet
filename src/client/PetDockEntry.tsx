/**
 * Global floating pet entry. The pet is host-global (its state, display and
 * interactions live on '/api/pet/*' endpoints with no session dimension), so
 * it must not ride a session-scoped slot — on the new-conversation screen no
 * session exists to scope a slot by, and the pet would vanish (issue #48).
 * The client half therefore mounts this entry straight onto 'document.body'
 * (see index.ts): while visible it renders the floating PetSprite (a portal
 * into the plugin root, so the root owns the whole surface), while hidden it
 * renders a fixed-position summon button. Which sprite renders is decided by
 * the host snapshot's pet id resolved against the registry list — no per-pet
 * component exists.
 * @module @linxin666/dsh-pet/client/PetDockEntry
 */

import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactElement } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PetDisplayConfig } from '../persist.ts'
import type { PetDefinition } from '../registry.ts'
import type { PetInstanceView, PetStateView } from '../service.ts'
import type { PetFeedback, PetStoreInstance } from './pet-store.ts'
import { PetSprite } from './PetSprite.tsx'
import { PetRendererSwitch } from './renderers/PetRendererSwitch.tsx'
import { createDragStream, type DragStream } from './drag-stream.ts'
import { GameplayHud, type GameplayApi, type GameplayBus } from './gameplay-hud.tsx'
import { useAmbientRoam } from './ambient-roam.ts'
import { usePetDialogue } from './dialogue-driver.ts'
import { usePetInteractions, usePetWorldPresence } from './interaction-driver.ts'
import { useSpontaneousActs } from './spontaneous-acts.ts'
import { World } from './world.ts'
import { NS } from './locales.ts'
import styles from './pet.module.css'

/** Injected actions handed to the dock entry component. */
export interface PetInjected {
  /** The app-wide pet store instance (snapshot + registry list + feedback). */
  store: PetStoreInstance
  /** Ensure the first snapshot (and registry list) is fetched (called on mount). */
  ensure: () => void
  /** Pet one sprite (click). The id scopes the reaction bubble to that pet. */
  pet: (petId: string) => void
  /** Feed one sprite. The id scopes the reaction bubble to that pet. */
  feed: (petId: string) => void
  /** Hide the sprite. */
  hide: () => void
  /** Summon the hidden sprite back. */
  summon: () => void
  /**
   * Persist a drag position for one on-screen pet. The id is what keeps two
   * pets independently placed: without it the drag would move the shared
   * display fallback and both sprites would jump together.
   */
  dragEnd: (petId: string, right: number, bottom: number) => void
  /** Rename one on-screen pet (persisted by the host). */
  rename: (petId: string, name: string) => void
  /**
   * Show a one-off line on one pet's bubble.
   *
   * The same channel a dialogue turn uses, so a pet's spontaneous act can speak
   * without owning a bubble surface of its own.
   */
  dialogueLine: (petId: string, text: string) => void
  /**
   * Report a click on one plugin-registered panel action (issue #6). The host
   * dispatches it to the plugin that registered the action; the panel itself
   * only renders the button the state snapshot served.
   */
  panelAction: (id: string) => void
  /** Navigate the GUI to the session a bubble reports on. */
  openSession: (sessionId: string) => void
  /** Clear one pet's reaction bubble. */
  feedbackDone: (petId: string) => void
  /** Gameplay verb API (miku-pet generalization); wired but unused for pets without a gameplay block. */
  gameplay: GameplayApi
}

/** Composed props of the global pet entry (locale + injected; no slot runtime share). */
export type PetDockEntryProps =
  PetInjected
  & PropsLocale<typeof NS>
  & {
    /**
     * DOM node the floating sprite chrome portals into. Defaults to
     * document.body; the plugin apply passes its [data-dsh-plugin="pet"]
     * root so root-keyed suppressors (the portrait mobile layer) and skins
     * own the whole pet surface as one unit.
     */
    portalTarget?: Element
  }

const DEFAULT_DISPLAY: PetDisplayConfig = {
  visible: true,
  size: 160,
  right: 24,
  bottom: 20,
  bubbleScale: 1,
  edgeMarginLeft: 24,
  edgeMarginRight: 8,
}

/**
 * One pet's sprite, given the host snapshot and its own instance row.
 *
 * The sprite component predates coexistence and reads a whole
 * {@link PetStateView}, so the row is projected back into a per-pet snapshot
 * rather than threading a new prop through the chrome. That keeps the bubble
 * stack, panel, drag and gameplay wiring untouched: each sprite simply sees a
 * snapshot describing itself, exactly as it did when there was only one pet.
 * @param props - the shared injected actions plus this pet's row and definition.
 * @returns the renderer-switched sprite for one pet.
 */
function PetInstanceSprite(props: {
  snapshot: PetStateView
  instance: PetInstanceView
  definition: PetDefinition
  display: PetDisplayConfig
  feedback: PetFeedback | null
  aux: { bus: GameplayBus; drag: DragStream }
  injected: PetInjected
  t: PropsLocale<typeof NS>['t']
  portalTarget?: Element
  /** The shared world this pet publishes its state into. */
  world: World
}): ReactElement {
  const { snapshot, instance, definition, display, aux, injected, t } = props
  // The per-pet view: everything global (affinity, treats, sessions,
  // announcements, panel actions) is shared, while the identity, animation,
  // position and skin come from this pet's own row.
  const perPet: PetStateView = {
    ...snapshot,
    animation: instance.animation,
    phase: instance.phase,
    ...(instance.bubble === undefined ? { bubble: undefined } : { bubble: instance.bubble }),
    pet: {
      id: definition.id,
      displayName: definition.displayName,
      description: definition.description,
    },
    name: instance.name,
    ...(instance.skin === undefined ? { skin: undefined } : { skin: instance.skin }),
  }
  // Position rides the display block the sprite reads; the global display
  // stays the fallback for pets that were never dragged.
  const perPetDisplay: PetDisplayConfig = {
    ...display,
    right: instance.right,
    bottom: instance.bottom,
  }
  // The sprite's rendered size, needed by the world so rules can reason about
  // where a pet actually is on screen.
  const spriteSize = {
    width: Math.round(definition.cell.width * (perPetDisplay.size / definition.cell.height)),
    height: Math.round(definition.cell.height * (perPetDisplay.size / definition.cell.height)),
  }
  const gameplay = definition.gameplay
  // Ambient roaming for pets the gameplay layer does not already walk. A pet
  // with a gameplay block keeps its own roam timer (its author chose that
  // cadence), so running this too would double-drive the same sprite.
  useAmbientRoam({
    definition,
    bus: aux.bus,
    drag: aux.drag,
    enabled: gameplay === undefined,
  })
  // Spontaneous acts: the pet doing something of its own. Only in autonomous
  // mode — with the session driving the pets, the host already supplies the
  // expressive states and this would fight it for the sprite.
  useSpontaneousActs({
    definition,
    bus: aux.bus,
    enabled: snapshot.autonomous === true,
    onLine: (text) => {
      injected.dialogueLine(instance.id, text)
    },
  })
  // Publish what this pet is actually playing, so the interaction rules can see
  // it. The sprite reports its RESOLVED track through the bus (see
  // `onAnimation`), because the host snapshot is `idle` whenever the pets run
  // autonomously — a presence built from it would never show a celebrating pet.
  const reportAnimation = usePetWorldPresence(props.world, {
    id: instance.id,
    phase: perPet.phase,
    right: instance.right,
    bottom: instance.bottom,
    width: spriteSize.width,
    height: spriteSize.height,
  })
  // Assigned during render, not in an effect. React runs a child's effects
  // before its parent's, so a sprite that read `bus.onAnimation` inside its own
  // effect would see `undefined` on the first pass and — since the value is
  // captured in that effect's dependencies — never report anything at all.
  aux.bus.onAnimation = reportAnimation
  return (
    <PetRendererSwitch
      definition={definition}
      phase={instance.phase}
      onPet={() => injected.pet(instance.id)}
      drag={aux.drag}
      bus={aux.bus}
      t={t}
    >
      <PetSprite
        snapshot={perPet}
        definition={definition}
        display={perPetDisplay}
        feedback={props.feedback}
        onPet={() => injected.pet(instance.id)}
        onFeed={() => injected.feed(instance.id)}
        onHide={injected.hide}
        onDragEnd={(right, bottom) => injected.dragEnd(instance.id, right, bottom)}
        onRename={(name) => injected.rename(instance.id, name)}
        onPanelAction={injected.panelAction}
        onOpenSession={injected.openSession}
        onFeedbackDone={() => injected.feedbackDone(instance.id)}
        portalTarget={props.portalTarget}
        dragDisabled={snapshot.gameplay?.mode === 'work'}
        bus={aux.bus}
        {...(gameplay === undefined
          ? {}
          : {
              onGameplayTap: (fx: number, fy: number) => aux.bus.tap?.(fx, fy),
              onGameplayMenu: () => aux.bus.openCard?.(),
              hud: (
                <GameplayHud
                  definition={definition}
                  store={injected.store}
                  api={injected.gameplay}
                  bus={aux.bus}
                  drag={aux.drag}
                  t={t}
                />
              ),
            })}
        t={t}
      />
    </PetRendererSwitch>
  )
}

/**
 * Dock entry: while the pets are visible, mount one floating sprite per
 * on-screen pet (each portals itself onto document.body); while hidden, render
 * the summon button so they can always come back. The store is the
 * plugin-owned single instance — the slot system provides none because the pet
 * is host-global, not session-scoped.
 */
export function PetDockEntry(props: PetDockEntryProps): ReactElement {
  const { store, ensure } = props
  const ui = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const snapshot = ui.snapshot
  const visible = snapshot?.display.visible ?? true

  useEffect(() => {
    ensure()
  }, [ensure])

  // Pet-to-pet conversations. One driver for the whole dock, not one per
  // sprite: a conversation is a property of the group on screen, and per-sprite
  // drivers would each start their own exchange.
  usePetDialogue({ store, enabled: visible && (snapshot?.pets?.length ?? 0) > 1 })

  // The shared world, created once for the dock's lifetime. The sprites publish
  // their state into it; the interaction driver reads it and writes reactions
  // back through the store.
  const world = useMemo(() => new World(), [])
  usePetInteractions({
    store,
    enabled: visible && (snapshot?.pets?.length ?? 0) > 1,
    world,
  })

  // One gameplay bus + drag stream per pet, keyed by id so a re-render does
  // not reset a live drag or drop an open HUD.
  const auxRef = useRef(new Map<string, { bus: GameplayBus; drag: DragStream }>())
  const auxOf = (id: string): { bus: GameplayBus; drag: DragStream } => {
    let aux = auxRef.current.get(id)
    if (aux === undefined) {
      aux = { bus: {}, drag: createDragStream() }
      auxRef.current.set(id, aux)
    }
    return aux
  }

  // Which pets render. The host list is authoritative once it lands; the
  // singular `pet` field is the fallback for a host that predates coexistence,
  // so an older host still shows its one pet instead of nothing.
  const instances: PetInstanceView[] = snapshot === null
    ? []
    : snapshot.pets !== undefined && snapshot.pets.length > 0
      ? snapshot.pets
      : [{
          id: snapshot.pet.id,
          name: snapshot.name,
          animation: snapshot.animation,
          phase: snapshot.phase,
          ...(snapshot.bubble === undefined ? {} : { bubble: snapshot.bubble }),
          right: snapshot.display.right,
          bottom: snapshot.display.bottom,
          ...(snapshot.skin === undefined ? {} : { skin: snapshot.skin }),
        }]

  if (visible && snapshot !== null) {
    return (
      <span data-pet-dock data-testid="pet-dock">
        {instances.map((instance) => {
          const definition = ui.pets.find(entry => entry.id === instance.id) ?? null
          if (definition === null) return null
          return (
            <PetInstanceSprite
              key={instance.id}
              snapshot={snapshot}
              instance={instance}
              definition={definition}
              display={snapshot.display}
              feedback={ui.feedback[instance.id] ?? null}
              aux={auxOf(instance.id)}
              injected={props}
              t={props.t}
              world={world}
              {...(props.portalTarget === undefined ? {} : { portalTarget: props.portalTarget })}
            />
          )
        })}
      </span>
    )
  }
  if (visible) {
    return <span data-pet-dock data-testid="pet-dock" />
  }
  const display = snapshot?.display ?? DEFAULT_DISPLAY
  return (
    <button
      type="button"
      className={styles.summon}
      style={{
        position: 'fixed',
        right: display.right,
        bottom: display.bottom,
        zIndex: 2147483000,
      }}
      onClick={props.summon}
      data-testid="pet-summon"
      data-dsh-part="summon-button"
    >
      {props.t('pet.summon', { name: snapshot?.name ?? '' })}
    </button>
  )
}
