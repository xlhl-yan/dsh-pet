/**
 * Pet host service — the `pet.*` RPC domain. A composition facade: it wires
 * the pure event projection (`event-projection`) onto the state machine,
 * delegates the affinity economy to the ledger (`ledger`), and routes
 * persistence through `persist`. The API gateway maps these methods onto
 * `pet.state` / `pet.pets` / `pet.interact` / `pet.setVisible` /
 * `pet.setConfig` / `pet.setName` / `pet.setPet` for browser consumers.
 *
 * Concurrent sessions each keep their own machine: the sprite animation
 * follows the most recent meaningful event (the display session) while the
 * state view carries one bubble per active session.
 * @module @linxin666/dsh-pet/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { AffinityConfig, PetAffinityView, PetInteraction } from './affinity.ts'
import { announcementFresh, MAX_ANNOUNCEMENTS, parseAnnouncement, type PetAnnouncement } from './announce.ts'
import type { TreatConfig } from './treats.ts'
import {
  emptyProjectionRuntime,
  isActivityPhase,
  projectAssistantStreamFrame,
  projectOfficialEvent,
  type ActivityStatusEventLike,
  type ProjectionRuntime,
} from './event-projection.ts'
import { PetLedger, type LedgerConfig, type LedgerInteractionResult } from './ledger.ts'
import { PanelActionRegistry, type PetPanelActionRegistration, type PetPanelActionView } from './panel-actions.ts'
import {
  DEFAULT_PET_NAME,
  DISPLAY_INSET_MAX,
  DISPLAY_SIZE_MAX,
  BUBBLE_SCALE_MAX,
  BUBBLE_SCALE_MIN,
  defaultDisplayConfig,
  DISPLAY_SIZE_MIN,
  EDGE_MARGIN_MAX,
  EDGE_MARGIN_MIN,
  PET_NAME_MAX_LENGTH,
  loadPetPersist,
  petHomeDir,
  savePetPersist,
  withPets,
  type PetDisplayConfig,
  type PetInstance,
} from './persist.ts'
import {
  DEFAULT_DECORATION_ID,
  decorationView,
  loadPetRegistry,
  petEntryView,
  petPackageRoot,
  type PetDefinition,
  type PetEntry,
  type PetManifest,
  type PetRegistry,
  type PetRegistryDiagnostic,
} from './registry.ts'
import { WHISPER_TTL_MS, type VoicePackOverrides, type VoicePoolsProvider } from './chatter.ts'
import { mergeVoicePacks } from './voice-pack.ts'
import type { PetRemarks } from './remarks.ts'
import type { DecorationView } from './contracts/status-decoration.ts'
import {
  defaultPetStateConfig,
  PetStateMachine,
  type PetStateConfig,
  type PetStateInput,
  type PetStateSnapshot,
} from './state.ts'
import {
  applyGameplayEffects,
  drawLotteryTier,
  initialGameplayState,
  isDeclaredMode,
  rollTouchBranch,
  rollWorkOutcome,
  settleGameplay,
  type PetGameplayManifest,
  type PetGameplayState,
} from './gameplay.ts'

/** The unified gameplay currency: the shared treat (小鱼干) ledger. */
const GAMEPLAY_TREATS_CURRENCY = 'treats'

/**
 * Clamp one edge margin, falling back per field.
 *
 * `Math.max(min, undefined)` is NaN, and NaN written into the display block
 * persists as a literal `0` (JSON has no NaN) — which silently pins every pet to
 * the viewport edge. A field that a running upgrade has not yet loaded must
 * therefore resolve to the shipped default, not to the clamp's floor.
 * @param value - the value read off the display block, possibly absent.
 * @param fallback - the shipped default for this field.
 * @returns a whole-pixel margin inside the supported range.
 */
function clampEdgeMargin(value: unknown, fallback: number): number {
  const finite = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.round(Math.min(EDGE_MARGIN_MAX, Math.max(EDGE_MARGIN_MIN, finite)))
}

/** Plugin configuration. */
export interface PetConfig {
  /** Affinity tuning. */
  affinity?: Partial<AffinityConfig>
  /** State machine tuning. */
  state?: Partial<PetStateConfig>
  /** Treat economy tuning. */
  treats?: Partial<TreatConfig>
  /** Persistence directory override (defaults to $DSH_HOME). */
  persistDir?: string
  /** Master switch for the plugin (browser half + host routes). */
  enabled?: boolean
  /** Status-decoration master switch (pet-center M5, #567); defaults to on. */
  decorationEnabled?: boolean
  /** Whether the pet's own session/status bubbles render (issue #6); defaults to 'auto'. */
  statusBubbles?: PetStatusBubbleMode
  /**
   * Run the pets independently of the DSH session lifecycle; defaults to true.
   *
   * When on, the plugin subscribes to no session event at all: pets never
   * mirror what the agent is doing, keep their own idle animation, and serve
   * neither status bubbles nor the status decoration. Only interaction
   * feedback (petting / feeding) and sibling-plugin announcements still
   * render. Set to false to restore the original behaviour, where the sprite
   * follows turn/step/tool activity.
   */
  autonomous?: boolean
  /** Prebuilt registry (tests); defaults to scanning the package + user dirs. */
  registry?: PetRegistry
  /** Extra manifest entries composed by the embedding application. */
  pets?: readonly PetManifest[]
}

/**
 * The pet's settings-namespace section: the pet selection and display fields
 * the web settings surface edits. `right`/`bottom` are also updated by drag
 * interactions, which keep the settings document in sync through the service.
 * Naming is per pet and lives outside the settings document (the hover-panel
 * rename targets the selected pet).
 */
export interface PetSettingsSection {
  /** Selected pet id (a registry entry; the service clamps stale values). */
  petId?: string
  /** Master switch. */
  visible: boolean
  /** Scale of the rendered pet in px (sprite cell height). */
  size: number
  /** Horizontal inset from the viewport right edge, px. */
  right: number
  /** Vertical inset from the viewport bottom edge, px. */
  bottom: number
  /** Bubble typography multiplier (#1549); see PetDisplayConfig. */
  bubbleScale?: number
  /** Gap kept between a sprite and the left viewport edge, px. */
  edgeMarginLeft?: number
  /** Gap kept between a sprite and the right viewport edge, px. */
  edgeMarginRight?: number
  /** Master switch for the plugin (browser half + host routes). */
  enabled?: boolean
  /**
   * Status-decoration master switch (pet-center M5, #567). Defaults to on;
   * the settings surface mirrors this field and can turn it off.
   */
  decorationEnabled?: boolean
  /** Whether the pet's own session/status bubbles render (issue #6). */
  statusBubbles?: PetStatusBubbleMode
  /**
   * Run the pets independently of the DSH session lifecycle. Defaults to
   * true; the settings surface mirrors it and can turn it off.
   */
  autonomous?: boolean
}

/**
 * Whether the pet renders its own session/status bubbles (issue #6).
 *
 * `auto` is the shipped behavior: every active session keeps a bubble, and a
 * sibling plugin's announcement bubble rides the same stack above them. `off`
 * hides ONLY the pet's own bubbles — the announcement bubble, the interaction
 * feedback bubble and the sprite itself are untouched — which is what a plugin
 * that drives its own bubble surface needs. Anything unknown resolves to
 * `auto`, so an older profile or a hand-edited settings document keeps the
 * status bubbles rather than losing them silently.
 */
export type PetStatusBubbleMode = 'auto' | 'off'

/** Every accepted {@link PetStatusBubbleMode}, in settings-card order. */
export const STATUS_BUBBLE_MODES: readonly PetStatusBubbleMode[] = ['auto', 'off']

/** The shipped default; the switch changes nothing until a user turns it off. */
export const DEFAULT_STATUS_BUBBLE_MODE: PetStatusBubbleMode = 'auto'

/**
 * Normalize a stored, live or hand-edited bubble mode.
 * @param value - the value the settings document carries, when any.
 * @returns the effective mode; anything but 'off' renders the bubbles.
 */
export function statusBubbleMode(value: unknown): PetStatusBubbleMode {
  return value === 'off' ? 'off' : DEFAULT_STATUS_BUBBLE_MODE
}

/** Settings namespace of the pet capability. Spelled here rather than imported: the browser half spells the same value. */
export const PET_SETTINGS_NAMESPACE = 'pet'

/**
 * One active TOP-LEVEL session as the pet displays it. Sessions run in
 * parallel, so each gets its own bubble while the sprite itself follows the
 * most recent meaningful event (the display session). Subagent children
 * report no bubble of their own: their work is already reflected by the
 * bubble of the conversation that spawned them, and the bubble buttons
 * navigate to GUI sessions, which subagents are not.
 */
export interface PetSessionView {
  /** Session identity (stringified for the wire; never exposed as a key). */
  sessionId: string
  /** The animation this session's activity maps onto. */
  animation: PetStateSnapshot['animation']
  /** This session's status bubble copy. */
  bubble: string
  /** This session's raw activity phase. */
  phase: PetStateSnapshot['phase']
  /** This session's fresh inner whisper (碎碎念), when one is within its TTL. */
  whisper?: string
}

/** Hard cap on simultaneously displayed session bubbles (most recent first). */
export const MAX_SESSION_BUBBLES = 12

/** Snapshot returned by `pet.state`. */
export interface PetStateView {
  animation: PetStateSnapshot['animation']
  bubble?: string
  phase: PetStateSnapshot['phase']
  sessionActive: boolean
  /**
   * Per-session bubbles for every concurrently active TOP-LEVEL session:
   * the GUI's current session first when reported, the rest most recently
   * active first; optional so older hosts without the multi-session view
   * stay consumable. The single 'bubble' above mirrors the display session.
   */
  sessions?: PetSessionView[]
  /** Affinity ledger snapshot. */
  affinity: PetAffinityView
  /** Display configuration. */
  display: PetDisplayConfig
  /** The selected pet's registry identity. */
  pet: {
    /** Registry id. */
    id: string
    /** Manifest display name (unrenamed default). */
    displayName: string
    /** Manifest description. */
    description: string
  }
  /** The selected pet's display name (user rename or manifest default). */
  name: string
  /**
   * Every on-screen pet, in render order (multi-pet coexistence). `pets[0]` is
   * the primary pet, so the singular `pet` / `animation` / `phase` / `name`
   * fields above mirror it. Optional so a host predating the split stays
   * consumable, and so a browser half that predates it keeps rendering one
   * sprite from the singular fields instead of blanking.
   */
  pets?: PetInstanceView[]
  /**
   * Whether the pets are running independently of the DSH session lifecycle.
   * The browser half reads this to know that the absent status bubbles and
   * decoration are a deliberate mode, not a host that failed to produce them.
   * Optional so a host predating the mode reads as the original behaviour.
   */
  autonomous?: boolean
  /**
   * The selected frames2d skin id for this pet (absent = the pet's default
   * look). Persisted host-side, so a page reload or client restart restores
   * the user's last choice instead of falling back to the default look.
   */
  skin?: string
  /** Treat (小鱼干) stock snapshot. */
  treats: {
    /** Stocked treats now. */
    stocked: number
    /** Stock cap. */
    max: number
  }
  /**
   * The active status decoration (pet-center M5, #567), when the master
   * switch is on and the default decoration entry exists. Absent means the
   * browser half renders no ornament.
   */
  decoration?: DecorationView
  /**
   * The selected pet's gameplay view (miku-pet generalization), present
   * when the pet declares a gameplay block. Read-only projection: polling
   * settles the view in memory but never writes pet.json.
   */
  gameplay?: PetGameplayStateView
  /**
   * The freshest plugin-authored announcement, within its TTL; absent when none
   * is fresh. Rendered as a dedicated styled bubble above the session stack.
   *
   * Kept alongside `announcements` with exactly the meaning it had when the
   * contract had a single slot, so a browser half predating the per-source
   * upgrade keeps rendering one bubble instead of none (issue #1812). New
   * readers should use `announcements`.
   */
  announcement?: PetAnnouncement
  /**
   * Every fresh plugin-authored announcement, one per publishing plugin, in
   * render order (issue #1812). Absent when nothing is fresh, so a host with no
   * publisher serves exactly what it served before the upgrade.
   */
  announcements?: PetAnnouncement[]
  /**
   * Whether the pet's own session/status bubbles render (issue #6). Absent
   * on a host that predates the switch, which the browser half reads as
   * `'auto'` — the behavior that shipped before it existed. Turning it to
   * `'off'` hides those bubbles only; `announcement` and `bubble` (the
   * legacy single status bubble) are still served, so the wire contract does
   * not change with the display preference.
   */
  statusBubbles?: PetStatusBubbleMode
  /**
   * Actions a sibling plugin registered into the hover panel's action row
   * (issue #6), in render order. Absent when none is registered, so the
   * panel row is exactly what it was before the extension point existed.
   */
  panelActions?: PetPanelActionView[]
}

/** Result of `pet.interact`. */
export type PetInteractResult = LedgerInteractionResult

/**
 * One on-screen pet in the state view (multi-pet coexistence).
 *
 * Each instance carries its own animation and position so two pets can be seen
 * doing different things at different places — the whole point of the split.
 * The registry definition (atlas URL, geometry, tracks) is not repeated here;
 * the browser half joins this against the `/api/pet/pets` list by `id`.
 */
export interface PetInstanceView {
  /** Registry id; join key against the registry list. */
  id: string
  /** This pet's display name (user rename or manifest default). */
  name: string
  /** Animation this pet is playing right now. */
  animation: PetStateSnapshot['animation']
  /** This pet's raw activity phase. */
  phase: PetStateSnapshot['phase']
  /** This pet's status bubble copy, when it has one. */
  bubble?: string
  /** Horizontal inset from the viewport right edge, px. */
  right: number
  /** Vertical inset from the viewport bottom edge, px. */
  bottom: number
  /** This pet's frames2d skin id, when one is selected. */
  skin?: string
}

/** The gameplay slice of the state view (dynamic state only; defs ride the pet definition). */
export interface PetGameplayStateView {
  /** Stat values rounded for display. */
  stats: Record<string, number>
  /** Active mode id ('work' | 'sleep' | a declared extra mode) or null. */
  mode: string | null
}

/** Result of the gameplay verbs (touch / setMode / workTick / buy). */
export interface PetGameplayVerbResult {
  ok: boolean
  error?: string
  /** Touch: whether a branch hit, plus its presentation. */
  hit?: boolean
  state?: string
  stateMs?: number
  phrase?: string
  /** Work tick outcome. */
  outcome?: 'success' | 'fail'
  /** Shop purchase: the drawn prize, when the item was a lottery. */
  prize?: { amount: number; currency: string }
  view?: PetGameplayStateView
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    pet: PetService
  }
}
/** Per-session pet activity: projection runtime plus the session's own machine. */
interface SessionActivity {
  runtime: ProjectionRuntime
  machine: PetStateMachine
  /** The session's most recent meaningful input (for display fallback). */
  lastInput?: PetStateInput
  /** Latest inner whisper woken by this session's model output (碎碎念). */
  whisper?: {
    /** Whisper copy. */
    text: string
    /** Epoch ms when it appeared (view-side TTL applies). */
    at: number
  }
}

/**
 * Cordis service exposing the pet RPC domain. Lazy: nothing is scanned or
 * written until an economic event or interaction arrives; event listeners
 * update only in-memory state, and persistence happens on economic changes
 * (turn rewards, feeds, config/name changes) — never on a read.
 */
export class PetService extends Service {
  static inject: string[] = []

  private readonly stateConfig: PetStateConfig
  private readonly ledger: PetLedger
  private readonly registry: PetRegistry
  private readonly persistDir: string
  /**
   * One state machine per on-screen pet, keyed by registry id (multi-pet
   * coexistence). Every pet observes the same session activity, so the
   * machines differ only in what they have been fed — the per-pet personality
   * offset that would make them diverge is a later stage, not this one.
   *
   * Entries are created lazily by {@link machineFor} and pruned when a pet
   * leaves the screen, so the map tracks the pet list rather than growing
   * with every id ever rendered.
   */
  private readonly petMachines = new Map<string, PetStateMachine>()
  private enabled: boolean
  /** Status-decoration master switch (M5, #567); mirrored from settings. */
  private decorationEnabled: boolean
  /** Whether the pet renders its own session/status bubbles (issue #6). */
  private statusBubbles: PetStatusBubbleMode
  /**
   * Whether the pets ignore the DSH session lifecycle entirely. On by default:
   * the pets are companions, not an agent status indicator. While set, no
   * session listener is installed at all, so the pets cannot drift back into
   * mirroring the agent even if a projection would have produced a phase.
   */
  private autonomous: boolean
  /**
   * Plugin-authored announcements, one slot per `source` (issue #1812). The
   * contract started as a single slot, where a second announcing plugin
   * displaced the first; the map is the upgrade the design note predicted for
   * exactly this moment. Insertion order is the render order and re-announcing
   * a source updates its entry in place, so two publishers on different
   * cadences never swap positions.
   */
  private readonly announcements = new Map<string, PetAnnouncement>()
  private disposeActivity: (() => void) | undefined
  /** Session whose most recent meaningful event currently drives the global pet. */
  private displaySession: Session | undefined
  /**
   * Effective voice-pack overrides for the currently selected pet (M4,
   * #677). Cached per pet id; the registry is an immutable snapshot, so the
   * global pack and each entry's pack cannot change behind the cache.
   */
  private voiceCache: { petId: string; overrides: VoicePackOverrides } | undefined
  /**
   * Per-session activity, most recent last (Map insertion order). Bounded by
   * MAX_SESSION_BUBBLES so a burst of sessions cannot grow it without bound;
   * disposed sessions are removed by the 'session/disposed' listener.
   */
  private readonly sessionActivity = new Map<Session, SessionActivity>()
  /**
   * Hover-panel actions registered by sibling plugins (issue #6). The pet owns
   * the panel row and serves the registrations; each plugin owns the callback a
   * click dispatches to. Bounded, in-memory, reclaimed with the registering
   * plugin's disposer.
   */
  private readonly panelActions = new PanelActionRegistry()
  /**
   * Sessions whose reward source is the official event stream. This metadata
   * outlives transient visual resets so a derived legacy `done` cannot reward
   * the same turn again after the pet is disabled and re-enabled.
   */
  private readonly officialEventSessions = new WeakSet<Session>()
  /**
   * Resolve the settings namespace this plugin's own config is served as, when
   * the caller can read it off the composition. A plugin's settings ARE its own
   * config, so the namespace is the row's id — and an aggregate bundle renames
   * child rows (`pet` becomes `web-ui-pet`), which is why it cannot be assumed
   * to be {@link PET_SETTINGS_NAMESPACE}. `apply` sets this; absent means the
   * plugin runs outside a Loader and the package's own id stands.
   */
  settingsNamespaceProvider: (() => string | undefined) | undefined = undefined

  constructor(ctx: Context, config: PetConfig = {}) {
    super(ctx, 'pet')
    this.persistDir = config.persistDir ?? petHomeDir()
    this.registry = config.registry
      ?? loadPetRegistry({
        packageRoot: petPackageRoot(import.meta.url),
        ...(config.pets === undefined ? {} : { extra: config.pets }),
      })
    if (this.registry.entries.length === 0) {
      throw new Error('[dsh-pet] no valid pet manifests found; nothing to render')
    }
    let persist = loadPetPersist(this.persistDir)
    // Drop on-screen pets the registry no longer has (removed, or a fresh
    // install over a copied pet.json). A list that empties out falls back to
    // the registry default so the plugin always has something to render.
    const known = persist.pets.filter(pet => this.registry.byId(pet.id) !== undefined)
    if (known.length !== persist.pets.length) {
      persist = known.length === 0
        ? withPets(persist, [{ id: this.registry.defaultEntry().id, right: persist.display.right, bottom: persist.display.bottom }])
        : withPets(persist, known)
    }
    const selected = this.registry.byId(persist.petId) ?? this.registry.defaultEntry()
    const ledgerConfig: LedgerConfig = {
      affinity: config.affinity,
      treats: config.treats,
      ...this.remarkLayers(selected),
    }
    this.ledger = new PetLedger(persist, ledgerConfig)
    this.stateConfig = { ...defaultPetStateConfig, ...(config.state ?? {}) }
    this.pruneMachines()
    this.enabled = config.enabled ?? true
    this.decorationEnabled = config.decorationEnabled ?? true
    this.statusBubbles = statusBubbleMode(config.statusBubbles)
    this.autonomous = config.autonomous ?? true

    this.syncActivity()
  }

  /**
   * The draw-time voice-pool provider handed to every projection runtime.
   * It re-resolves when the selected pet changes, so live engines re-voice
   * on the next draw without being rebuilt (M4, #677).
   */
  private voicePools(): VoicePoolsProvider {
    return () => {
      const entry = this.activeEntry()
      if (this.voiceCache !== undefined && this.voiceCache.petId === entry.id) {
        return this.voiceCache.overrides
      }
      const overrides = mergeVoicePacks(this.registry.globalVoice, entry.voice)?.overrides ?? {}
      this.voiceCache = { petId: entry.id, overrides }
      return overrides
    }
  }

  /** Whether the pet service consumes session activity while enabled. */
  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * The remark layers one pet contributes to the ledger: its manifest pools
   * first, then the voice packs (a pet directory's voice.json over the global
   * `$DSH_HOME/pets/.voice.json`). Every path that seats the ledger's remark
   * pools resolves them here, so no call site can apply the manifest pools and
   * silently drop the voice layer: doing that reverted a pet whose lines a voice
   * pack had translated back to the built-in pools the moment the settings
   * surface applied.
   * @param entry - the pet whose remark pools apply.
   * @returns the layers `PetLedger.setRemarks` takes.
   */
  private remarkLayers(entry: PetEntry): { remarks?: PetRemarks; voiceRemarks?: PetRemarks } {
    return {
      remarks: entry.remarks,
      voiceRemarks: mergeVoicePacks(this.registry.globalVoice, entry.voice)?.remarks,
    }
  }

  /** Re-seat the ledger's remark pools from one pet's layers. */
  private applyRemarks(entry: PetEntry): void {
    const layers = this.remarkLayers(entry)
    this.ledger.setRemarks(layers.remarks, layers.voiceRemarks)
  }

  /** RPC: current pet state snapshot. */
  async state(currentSessionId?: string): Promise<PetStateView> {
    return this.view(currentSessionId)
  }

  /**
   * RPC: one plugin-authored announcement bubble, held in the publisher's own
   * slot keyed by `source` (issue #1812). The payload is validated into a
   * bounded PetAnnouncement; a malformed one is dropped silently — a sibling
   * plugin's bug must never surface as pet breakage. Re-announcing replaces
   * only the caller's own slot, so publishers coexist instead of displacing
   * each other. Announcements are in-memory only.
   *
   * The slot table is bounded by {@link MAX_ANNOUNCEMENTS}. Expired entries are
   * pruned first, so a silent publisher never holds a slot; when the table is
   * genuinely full, the entry that has been silent longest gives up its slot
   * to the arriving one — a publisher that keeps refreshing is never evicted.
   */
  announce(input: unknown): { ok: boolean } {
    const parsed = parseAnnouncement(input, Date.now())
    if (parsed === undefined) return { ok: false }
    const now = Date.now()
    for (const [source, entry] of this.announcements) {
      if (!announcementFresh(entry, now)) this.announcements.delete(source)
    }
    if (!this.announcements.has(parsed.source) && this.announcements.size >= MAX_ANNOUNCEMENTS) {
      let oldest = ''
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [source, entry] of this.announcements) {
        if (entry.at < oldestAt) {
          oldest = source
          oldestAt = entry.at
        }
      }
      if (oldest !== '') this.announcements.delete(oldest)
    }
    this.announcements.set(parsed.source, parsed)
    return { ok: true }
  }

  /**
   * The announcement slots still fresh, in render order. An expired entry
   * simply stops appearing (the client's 2 s poll drops it); no timer owns its
   * removal.
   */
  private freshAnnouncements(): PetAnnouncement[] {
    const now = Date.now()
    return [...this.announcements.values()].filter(entry => announcementFresh(entry, now))
  }

  /**
   * Register one action into the hover panel's action row (issue #6). The pet
   * renders the button and dispatches the click back to `onSelect`; the plugin
   * decides what the button does. Registering is a wiring step, so a malformed
   * registration throws at the caller's own apply instead of being dropped.
   *
   * The registration is reclaimed by the disposer, so the idiomatic call binds
   * it to the registering plugin's fiber:
   * ```ts
   * ctx.effect(() => ctx.pet.registerPanelAction({
   *   id: 'pet-quota-swap',
   *   label: '换装',
   *   onSelect: async () => { await cycleToNextPet(ctx.pet) },
   * }))
   * ```
   * @param action - the registration to serve in the panel row.
   * @returns a disposer that removes this registration.
   * @throws when the id, label or callback is unusable, or the row is full.
   */
  registerPanelAction(action: PetPanelActionRegistration): () => void {
    return this.panelActions.register(action)
  }

  /**
   * RPC: dispatch one hover-panel action click back to the plugin that
   * registered it. A rejected id is a stale click (the plugin disposed its
   * registration between render and click), and a throwing callback is that
   * plugin's own failure — neither may surface as pet breakage, so both answer
   * `{ ok: false }` instead of throwing out of the route.
   * @param id - the action id the browser half reported.
   * @returns whether the click reached a registered action.
   */
  async selectPanelAction(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const selected = await this.panelActions.select(id, { petId: this.selectedPetId() })
      return selected ? { ok: true } : { ok: false, error: 'unknown-panel-action' }
    } catch {
      return { ok: false, error: 'panel-action-failed' }
    }
  }

  /** Current persisted display config (read-only view). */
  display(): PetDisplayConfig {
    return { ...this.ledger.snapshot.display }
  }

  /** RPC: the registry entries the browser half renders and selects from. */
  async pets(): Promise<PetDefinition[]> {
    return this.registry.entries.map(entry => petEntryView(entry, this.registry.globalVoice))
  }

  /** The loaded registry (the asset routes serve its entries). */
  registrySnapshot(): PetRegistry {
    return this.registry
  }

  /** RPC: structured registry diagnostics (pet-center M2, issue #623). */
  async diagnostics(): Promise<{ diagnostics: PetRegistryDiagnostic[] }> {
    return { diagnostics: this.registry.diagnostics }
  }

  /**
   * The active status decoration view (M5, #567): the default 'whale' entry
   * (user directories override built-ins by id), gated by the master switch.
   */
  private activeDecoration(): DecorationView | undefined {
    if (!this.decorationEnabled) return undefined
    const entry = this.registry.decorationById?.(DEFAULT_DECORATION_ID)
    return entry === undefined ? undefined : decorationView(entry)
  }

  /** The selected pet's registry entry. */
  activeEntry(): NonNullable<PetRegistry['entries'][number]> {
    return this.registry.byId(this.selectedPetId()) ?? this.registry.defaultEntry()
  }

  /** Currently selected pet id (persisted). */
  selectedPetId(): string {
    return this.ledger.snapshot.petId
  }

  /**
   * The primary pet's state machine. A getter rather than a field so the
   * single-pet read paths (`view`, the gameplay verbs) keep their shape after
   * the multi-pet split: they all mean "the primary pet", which is `pets[0]`.
   */
  private get machine(): PetStateMachine {
    return this.machineFor(this.selectedPetId())
  }

  /**
   * The state machine for one pet, created on first use.
   * @param petId - registry id of the pet.
   * @returns that pet's machine; the primary pet's when the id is unknown.
   */
  private machineFor(petId: string): PetStateMachine {
    let machine = this.petMachines.get(petId)
    if (machine === undefined) {
      machine = new PetStateMachine(this.stateConfig)
      this.petMachines.set(petId, machine)
    }
    return machine
  }

  /**
   * Drop machines for pets that are no longer on screen, and create the ones
   * the current list needs. Called after any change to the pet list so the map
   * cannot retain a pet the user removed.
   */
  private pruneMachines(): void {
    const live = new Set(this.ledger.snapshot.pets.map(pet => pet.id))
    for (const id of [...this.petMachines.keys()]) {
      if (!live.has(id)) this.petMachines.delete(id)
    }
    for (const id of live) this.machineFor(id)
  }

  /** The on-screen pets, in render order. */
  instances(): PetInstance[] {
    return this.ledger.snapshot.pets
  }

  /** The display name of one pet (user rename or manifest displayName). */
  petName(petId: string = this.selectedPetId()): string {
    const stored = this.ledger.snapshot.names[petId]
    if (stored !== undefined && stored.trim() !== '') return stored
    return this.registry.byId(petId)?.displayName ?? DEFAULT_PET_NAME
  }

  /** RPC: switch the selected pet (persisted, settings document mirrored). */
  async setPetId(petId: string): Promise<{ ok: true; petId: string } | { ok: false; error: string }> {
    const entry = this.registry.byId(petId)
    if (entry === undefined) return { ok: false, error: 'unknown-pet' }
    // Single-pet callers mean "make this the only pet": the selection RPC
    // predates coexistence, and keeping the old meaning is what lets the
    // settings selector stay a selector instead of silently becoming "add".
    const snapshot = this.ledger.snapshot
    const existing = snapshot.pets.find(pet => pet.id === entry.id)
    this.ledger.setPets([existing ?? {
      id: entry.id,
      right: snapshot.display.right,
      bottom: snapshot.display.bottom,
    }])
    this.pruneMachines()
    this.applyRemarks(entry)
    this.flush()
    this.syncSettingsFromPet()
    return { ok: true, petId: entry.id }
  }

  /**
   * RPC: replace the on-screen pet list (multi-pet coexistence).
   *
   * Unknown ids are dropped rather than rejected: a stale client list must not
   * be able to wedge the plugin, and the returned list tells the caller what
   * actually took effect. An empty or fully-unknown input keeps the current
   * list — "no pets at all" is expressed by hiding, not by emptying.
   * @param pets - desired on-screen pets, in render order.
   */
  async setPets(pets: readonly PetInstance[]): Promise<{ ok: true; pets: PetInstance[] }> {
    const known = pets.filter(pet => this.registry.byId(pet.id) !== undefined)
    if (known.length === 0) return { ok: true, pets: this.ledger.snapshot.pets }
    this.ledger.setPets(known)
    this.pruneMachines()
    // The primary pet changed, so the remark pools and the settings mirror
    // have to follow it exactly as they do on a single-pet selection.
    this.applyRemarks(this.activeEntry())
    this.flush()
    this.syncSettingsFromPet()
    return { ok: true, pets: this.ledger.snapshot.pets }
  }

  /** Whether the pets currently ignore the DSH session lifecycle. */
  isAutonomous(): boolean {
    return this.autonomous
  }

  /**
   * RPC: switch the pets between autonomous and session-driven.
   *
   * The listeners are torn down (or installed) immediately, so the change
   * takes effect on the next poll instead of at the next restart. Turning the
   * mode off clears the activity state first, so the pets do not replay a
   * stale phase that was captured before the switch.
   * @param autonomous - true to detach the pets from the session lifecycle.
   */
  async setAutonomous(autonomous: boolean): Promise<{ ok: true; autonomous: boolean }> {
    if (this.autonomous === autonomous) return { ok: true, autonomous }
    this.autonomous = autonomous
    this.resetActivity()
    this.syncActivity()
    this.syncSettingsFromPet()
    return { ok: true, autonomous }
  }

  /** Start or stop the session-activity listeners that drive the pet. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.syncActivity()
    if (!enabled) this.resetActivity()
  }

  private syncActivity(): void {
    if (this.disposeActivity !== undefined) {
      this.disposeActivity()
      this.disposeActivity = undefined
    }
    if (!this.enabled) return
    // Autonomous mode installs no session listener at all. Gating the
    // listeners (rather than filtering their output) is what makes the
    // separation real: no projection runtime is built, no reward bookkeeping
    // runs, and a later change to the projection cannot leak agent state into
    // the pets.
    if (this.autonomous) {
      this.resetActivity()
      return
    }
    this.disposeActivity = (() => {
      const disposers = [
        this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
          const runtime = this.activityOf(session).runtime
          // `activity/status` is an optional compatibility input. It is not
          // declared as a durable event type by this package because current
          // Harness installations publish the official session vocabulary.
          if ((event.type as string) === 'activity/status') {
            const payload = ((event as unknown as { data?: unknown }).data ?? {}) as ActivityStatusEventLike
            if (typeof payload.phase !== 'string' || !isActivityPhase(payload.phase)) return
            this.applyActivity(session, {
              phase: payload.phase,
              ...(typeof payload.line === 'string' ? { line: payload.line } : {}),
              ...(typeof payload.phrase === 'string' ? { phrase: payload.phrase } : {}),
            })
            // On a legacy-only stream the compatibility event owns turn
            // rewards. Once any official activity is observed, turn/end owns
            // them and a derived legacy `done` cannot double-count.
            if (payload.phase === 'done' && !runtime.officialEventsSeen) {
              this.rewardLegacyTurn()
            }
            return
          }

          const transition = projectOfficialEvent(event, runtime)
          if (transition === undefined) return
          runtime.officialEventsSeen = true
          this.officialEventSessions.add(session)
          this.applyActivity(session, transition.input, transition.whisper)
          if (transition.completedTurn !== undefined) {
            this.rewardTurn(String(session.id), transition.completedTurn)
          }
        }),
        this.ctx.on('agent/assistant-stream', ({ agent, frame }: { agent: { session: Session }; frame: AssistantStreamFrame }) => {
          const session = agent.session
          const runtime = this.activityOf(session).runtime
          const transition = projectAssistantStreamFrame(frame, runtime)
          if (transition === undefined) return
          runtime.officialEventsSeen = true
          this.officialEventSessions.add(session)
          this.applyActivity(session, transition.input, transition.whisper)
        }),
        this.ctx.on('session/disposed', (session: Session) => {
          this.ledger.forgetSession(String(session.id))
          this.officialEventSessions.delete(session)
          this.sessionActivity.delete(session)
          if (session !== this.displaySession) return
          // The display session is gone: fall back to the most recent
          // remaining session's last input, or settle to idle when none.
          this.displaySession = undefined
          const remaining = [...this.sessionActivity.entries()].at(-1)
          if (remaining !== undefined) {
            const [nextSession, activity] = remaining
            this.displaySession = nextSession
            if (activity.lastInput !== undefined) {
              for (const id of this.ledger.snapshot.pets.map(pet => pet.id)) {
                const machine = this.machineFor(id)
                machine.onActivityStatus(activity.lastInput)
                machine.onSessionActive()
              }
            } else {
              this.resetMachines()
            }
          } else {
            this.resetMachines()
          }
        }),
      ]
      return () => { for (const dispose of disposers) dispose() }
    })()
  }

  /** Drop transient activity because terminal events missed while disabled cannot be replayed safely. */
  private resetActivity(): void {
    this.displaySession = undefined
    this.sessionActivity.clear()
    this.resetMachines()
  }

  /** Settle every on-screen pet back to idle (session gone, or activity dropped). */
  private resetMachines(): void {
    for (const id of this.ledger.snapshot.pets.map(pet => pet.id)) {
      this.machineFor(id).onSessionDisposed()
    }
  }

  /** Return the per-session activity record, creating it on first sight. */
  private activityOf(session: Session): SessionActivity {
    let activity = this.sessionActivity.get(session)
    if (activity === undefined) {
      const runtime = emptyProjectionRuntime(this.voicePools())
      runtime.officialEventsSeen = this.officialEventSessions.has(session)
      activity = {
        runtime,
        machine: new PetStateMachine(this.stateConfig),
      }
      this.sessionActivity.set(session, activity)
    }
    return activity
  }

  /**
   * Commit one activity: the session's own machine renders its bubble, and
   * the session becomes the host-global display session (most recent
   * meaningful event wins the sprite animation).
   */
  private applyActivity(session: Session, input: PetStateInput, whisper?: string): void {
    const activity = this.activityOf(session)
    activity.lastInput = input
    if (whisper !== undefined) activity.whisper = { text: whisper, at: Date.now() }
    activity.machine.onActivityStatus(input)
    activity.machine.onSessionActive()
    // Move to the tail so map order reads most-recent-last, then trim the
    // oldest session states beyond the bubble cap. The display session is
    // reassigned below, so trimming its stale predecessor is safe.
    this.sessionActivity.delete(session)
    this.sessionActivity.set(session, activity)
    while (this.sessionActivity.size > MAX_SESSION_BUBBLES) {
      const oldest = this.sessionActivity.keys().next().value
      if (oldest === undefined) break
      this.sessionActivity.delete(oldest)
    }
    this.displaySession = session
    // Feed every on-screen pet, not just the primary one. All pets currently
    // observe the same activity (the per-pet personality offset is a later
    // stage), but each keeps its OWN machine, so a pet added mid-turn starts
    // from idle and settles on its own clock instead of inheriting a phase it
    // never saw. `machine` is the primary pet and is included here.
    for (const id of this.ledger.snapshot.pets.map(pet => pet.id)) {
      const machine = this.machineFor(id)
      machine.onActivityStatus(input)
      machine.onSessionActive()
    }
  }

  /** RPC: pet or feed the pet. */
  async interact(kind: PetInteraction): Promise<PetInteractResult> {
    const nowMs = Date.now()
    const result = this.ledger.interact(kind, nowMs)
    if (this.ledger.takeDirty()) this.flush()
    return result
  }

  /* ---------------------------------------------------------------- *
   * Gameplay verbs (miku-pet generalization). The manifest block lives
   * on the registry entry; dynamic state persists per pet id. Verbs
   * settle and persist; the state view projects without writing.
   * ---------------------------------------------------------------- */

  /** The active pet's gameplay block, if it declares one. */
  private gameplayDef(): PetGameplayManifest | undefined {
    return this.activeEntry().gameplay
  }

  /** The persisted (or fresh) gameplay state of the selected pet. */
  private gameplayState(def: PetGameplayManifest, now: number): { petId: string; state: PetGameplayState } {
    const petId = this.selectedPetId()
    const stored = this.ledger.snapshot.gameplay[petId]
    return {
      petId,
      state: stored === undefined
        ? initialGameplayState(def, now)
        // Spread first so the settle remainders (restoreCarryMs / incomeCarryMs)
        // survive a verb. Enumerating the fields dropped them, so every verb
        // floored the elapsed time and threw the remainder away -- which starves
        // any interval longer than the gap between verbs (30 s sleep restore,
        // 30 min passive income).
        : { ...stored, stats: { ...stored.stats }, currencies: { ...stored.currencies } },
    }
  }

  /** Display view of one gameplay state (rounded stats; treats ride the shared treat ledger). */
  private gameplayViewOf(state: PetGameplayState): PetGameplayStateView {
    const stats: Record<string, number> = {}
    for (const [name, value] of Object.entries(state.stats)) stats[name] = Math.round(value)
    // A persisted mode the manifest no longer declares (a pet.json edit after
    // the pet was parked in it) reads as "no mode". Otherwise the client would
    // latch a mode it cannot resolve: the mode chip prints a raw i18n key, and
    // the client's roam roll — suppressed while any mode is active — would
    // never fire again.
    const def = this.gameplayDef()
    const mode = state.mode !== null && def !== undefined && !isDeclaredMode(def, state.mode) ? null : state.mode
    return { stats, mode }
  }

  /**
   * Move gameplay 'treats' currency (the unified post-wallet currency) from
   * the engine's settle work area into the shared treat ledger, capped by
   * the stock cap. The engine keeps its generic currency record for settle
   * math; this drain is the only bridge to the wallet-free economy.
   */
  private drainGameplayTreats(state: PetGameplayState): void {
    const pending = Math.floor(state.currencies[GAMEPLAY_TREATS_CURRENCY] ?? 0)
    delete state.currencies[GAMEPLAY_TREATS_CURRENCY]
    if (pending > 0) this.ledger.grantTreats(pending)
  }

  /** Persist the mutated gameplay state of one verb call. */
  private commitGameplay(petId: string, state: PetGameplayState): void {
    this.ledger.setGameplay(petId, state)
    if (this.ledger.takeDirty()) this.flush()
  }

  /**
   * RPC: a touch on the pet. 'zone' names a touch zone (roll a branch);
   * omitted means a plain click while a touch animation holds (clickBoost).
   */
  async gameplayTouch(zone?: string): Promise<PetGameplayVerbResult> {
    const def = this.gameplayDef()
    if (def === undefined) return { ok: false, error: 'no-gameplay' }
    const now = Date.now()
    const { petId, state } = this.gameplayState(def, now)
    settleGameplay(state, def, now, { sessionActive: this.machine.render().sessionActive })
    if (zone === undefined) {
      const boost = def.touch?.clickBoost
      if (boost === undefined) return { ok: false, error: 'no-touch' }
      const amount = boost.min + Math.floor(Math.random() * (boost.max - boost.min + 1))
      if (amount > 0) applyGameplayEffects(state, def, [{ stat: boost.stat, amount }])
      this.drainGameplayTreats(state)
      this.commitGameplay(petId, state)
      return { ok: true, hit: false, view: this.gameplayViewOf(state) }
    }
    const target = def.touch?.zones.find(entry => entry.name === zone)
    if (target === undefined) return { ok: false, error: 'unknown-zone' }
    const branch = rollTouchBranch(target, Math.random)
    if (branch === undefined) {
      this.drainGameplayTreats(state)
      this.commitGameplay(petId, state)
      return { ok: true, hit: false, view: this.gameplayViewOf(state) }
    }
    if (branch.effects !== undefined) applyGameplayEffects(state, def, branch.effects)
    const phrase = branch.phrases !== undefined && branch.phrases.length > 0
      ? branch.phrases[Math.floor(Math.random() * branch.phrases.length)]
      : undefined
    this.drainGameplayTreats(state)
    this.commitGameplay(petId, state)
    return {
      ok: true,
      hit: true,
      ...(branch.state === undefined ? {} : { state: branch.state }),
      ...(branch.stateMs === undefined ? {} : { stateMs: branch.stateMs }),
      ...(phrase === undefined ? {} : { phrase }),
      view: this.gameplayViewOf(state),
    }
  }

  /**
   * RPC: enter or leave a gameplay mode (null clears it). Every mode the
   * manifest declares is accepted: 'work', 'sleep', or one of the extra
   * 'modes' entries (a bath, a play session…).
   */
  async gameplaySetMode(mode: string | null): Promise<PetGameplayVerbResult> {
    const def = this.gameplayDef()
    if (def === undefined) return { ok: false, error: 'no-gameplay' }
    if (mode === 'work' && def.work === undefined) return { ok: false, error: 'no-work' }
    if (mode === 'sleep' && def.sleep === undefined) return { ok: false, error: 'no-sleep' }
    if (mode !== null && !isDeclaredMode(def, mode)) return { ok: false, error: 'unknown-mode' }
    const now = Date.now()
    const { petId, state } = this.gameplayState(def, now)
    settleGameplay(state, def, now, { sessionActive: this.machine.render().sessionActive })
    // Switching modes restarts the restore cadence: a leftover carry from the
    // previous mode must not advance the new mode's first tick.
    if (state.mode !== mode) state.restoreCarryMs = 0
    state.mode = mode
    this.drainGameplayTreats(state)
    this.commitGameplay(petId, state)
    return { ok: true, view: this.gameplayViewOf(state) }
  }

  /** RPC: one work-round adjudication (only while the work mode holds). */
  async gameplayWorkTick(): Promise<PetGameplayVerbResult> {
    const def = this.gameplayDef()
    if (def?.work === undefined) return { ok: false, error: 'no-work' }
    const now = Date.now()
    const { petId, state } = this.gameplayState(def, now)
    if (state.mode !== 'work') return { ok: false, error: 'not-working' }
    settleGameplay(state, def, now, { sessionActive: this.machine.render().sessionActive })
    const outcome = rollWorkOutcome(def.work, Math.random)
    const effects = outcome === 'success' ? def.work.success?.effects : def.work.fail?.effects
    if (effects !== undefined) applyGameplayEffects(state, def, effects)
    this.drainGameplayTreats(state)
    this.commitGameplay(petId, state)
    return { ok: true, outcome, view: this.gameplayViewOf(state) }
  }

  /** RPC: buy one shop item (effects, currency swap, or a lottery draw). */
  async gameplayBuy(itemId: string): Promise<PetGameplayVerbResult> {
    const def = this.gameplayDef()
    if (def === undefined) return { ok: false, error: 'no-gameplay' }
    const item = def.shop?.items.find(entry => entry.id === itemId)
    if (item === undefined) return { ok: false, error: 'unknown-item' }
    const now = Date.now()
    const { petId, state } = this.gameplayState(def, now)
    settleGameplay(state, def, now, { sessionActive: this.machine.render().sessionActive })
    // The unified currency is the shared treat ledger (wallet removed): shop
    // prices and prizes ride the same balance the panel shows and feeding
    // consumes, capped by the stock cap.
    const treats = item.currency === GAMEPLAY_TREATS_CURRENCY
    const balance = treats ? this.ledger.snapshot.treats.treats : (state.currencies[item.currency] ?? 0)
    if (balance < item.price) {
      return { ok: false, error: 'insufficient-funds', view: this.gameplayViewOf(state) }
    }
    if (treats) this.ledger.spendTreats(item.price)
    else state.currencies[item.currency] = balance - item.price
    if (item.effects !== undefined) applyGameplayEffects(state, def, item.effects)
    let prize: PetGameplayVerbResult['prize']
    if (item.lottery !== undefined) {
      if (item.lottery.effects !== undefined) applyGameplayEffects(state, def, item.lottery.effects)
      const tier = drawLotteryTier(item.lottery, Math.random)
      const prizeCurrency = tier.currency ?? item.lottery.currency ?? item.currency
      if (prizeCurrency === GAMEPLAY_TREATS_CURRENCY) this.ledger.grantTreats(tier.prize)
      else state.currencies[prizeCurrency] = (state.currencies[prizeCurrency] ?? 0) + tier.prize
      prize = { amount: tier.prize, currency: prizeCurrency }
    }
    this.drainGameplayTreats(state)
    this.commitGameplay(petId, state)
    return { ok: true, ...(prize === undefined ? {} : { prize }), view: this.gameplayViewOf(state) }
  }

  /** RPC: show or hide the pet. */
  async setVisible(visible: boolean): Promise<{ ok: true; display: PetDisplayConfig }> {
    this.ledger.setDisplay({ ...this.ledger.snapshot.display, visible })
    this.flush()
    this.syncSettingsFromPet()
    return { ok: true, display: this.ledger.snapshot.display }
  }

  /**
   * The persisted skin for one entry, when the manifest still declares it: a
   * stale id (skin removed from the manifest, pet swapped) reads as "default"
   * rather than pinning a track the browser half cannot resolve.
   */
  private persistedSkin(entry: NonNullable<PetRegistry['entries'][number]>): string | undefined {
    const stored = this.ledger.petSkin(entry.id)
    if (stored === undefined) return undefined
    return entry.frames2d?.skins?.some(skin => skin.id === stored) === true ? stored : undefined
  }

  /**
   * RPC: select the current pet's frames2d skin (`undefined` restores the
   * pet's default look). The choice is stored per pet, so every later state
   * view (reload, client restart, pet re-selection) serves it back.
   */
  async setSkin(skin: string | undefined): Promise<{ ok: true; skin?: string } | { ok: false; error: string }> {
    const entry = this.activeEntry()
    const declared = entry.frames2d?.skins ?? []
    if (skin === undefined) {
      this.ledger.setPetSkin(entry.id, undefined)
      this.flush()
      return { ok: true }
    }
    if (!declared.some(candidate => candidate.id === skin)) return { ok: false, error: 'unknown-skin' }
    this.ledger.setPetSkin(entry.id, skin)
    this.flush()
    return { ok: true, skin }
  }

  /**
   * RPC: update display config (size / position / bubble scale). Pixel values
   * are clamped to whole pixels.
   *
   * With `petId` the position lands on that one on-screen pet and the others
   * stay put — which is what a drag on a specific sprite means. Without it the
   * insets update the global display block, i.e. the position every pet falls
   * back to, preserving the pre-coexistence meaning for the settings form.
   * @param patch - the display fields to update.
   * @param petId - optional on-screen pet whose own position to move.
   */
  async setConfig(patch: Partial<PetDisplayConfig>, petId?: string): Promise<{ ok: true; display: PetDisplayConfig }> {
    const next = { ...this.ledger.snapshot.display, ...patch }
    next.size = Math.round(Math.min(DISPLAY_SIZE_MAX, Math.max(DISPLAY_SIZE_MIN, next.size)))
    next.right = Math.round(Math.min(DISPLAY_INSET_MAX, Math.max(0, next.right)))
    next.bottom = Math.round(Math.min(DISPLAY_INSET_MAX, Math.max(0, next.bottom)))
    next.bubbleScale = Math.min(BUBBLE_SCALE_MAX, Math.max(BUBBLE_SCALE_MIN, next.bubbleScale))
    // A field added by an upgrade is absent from the in-memory display until the
    // next load, and Math.max(0, undefined) is NaN — which would persist as a
    // literal `0` and silently pin pets to the edge. Fall back to the default
    // per field rather than trusting the spread.
    next.edgeMarginLeft = clampEdgeMargin(next.edgeMarginLeft, defaultDisplayConfig.edgeMarginLeft)
    next.edgeMarginRight = clampEdgeMargin(next.edgeMarginRight, defaultDisplayConfig.edgeMarginRight)
    this.ledger.setDisplay(next)
    if (petId !== undefined) {
      this.ledger.setPetPosition(petId, next.right, next.bottom)
    }
    this.flush()
    this.syncSettingsFromPet()
    return { ok: true, display: this.ledger.snapshot.display }
  }

  /**
   * RPC: rename one pet (trimmed, 1–20 chars, per-pet storage).
   * @param name - the new display name.
   * @param petId - the pet to rename; defaults to the primary pet, which is
   * what a pre-coexistence caller means.
   */
  async setName(name: string, petId?: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
    const target = petId ?? this.selectedPetId()
    // A rename aimed at a pet that is not on screen would store a name nothing
    // renders, so reject it instead of writing dead state.
    if (!this.ledger.snapshot.pets.some(pet => pet.id === target)) {
      return { ok: false, error: 'unknown-pet' }
    }
    const trimmed = name.trim()
    if (trimmed === '') return { ok: false, error: 'name-empty' }
    if (trimmed.length > PET_NAME_MAX_LENGTH) return { ok: false, error: 'name-too-long' }
    this.ledger.setPetName(target, trimmed)
    this.flush()
    return { ok: true, name: trimmed }
  }

  /**
   * Apply a committed settings section to the persisted selection and display
   * config. Called by the settings surface on every change; values are
   * clamped exactly like the setConfig RPC so both write paths converge.
   * @param section - the resolved settings section.
   */
  applySettingsSection(section: PetSettingsSection): void {
    this.decorationEnabled = section.decorationEnabled ?? true
    this.statusBubbles = statusBubbleMode(section.statusBubbles)
    // The autonomy switch re-installs (or tears down) the session listeners,
    // so flipping it in the settings card takes effect on the next poll.
    // An absent field keeps the current mode rather than defaulting to on: a
    // caller that does not know about the switch (an older settings surface, a
    // sibling plugin applying a partial section) must not silently detach the
    // pets from the session lifecycle.
    const autonomous = section.autonomous
    if (autonomous !== undefined && autonomous !== this.autonomous) {
      this.autonomous = autonomous
      this.resetActivity()
      this.syncActivity()
    }
    const selected = typeof section.petId === 'string' ? this.registry.byId(section.petId) : undefined
    if (selected !== undefined && selected.id !== this.selectedPetId()) {
      // Only a *changed* selection collapses the list. Every unrelated edit
      // (visibility, size, insets) also lands here, and routing those through
      // the single-pet setter would silently drop the user's second pet.
      this.ledger.setPetId(selected.id)
      this.pruneMachines()
      this.applyRemarks(selected)
    } else if (section.petId !== undefined && selected === undefined) {
      // The stored selection names a pet the registry no longer has: keep the
      // current selection and repair the settings document.
      this.syncSettingsFromPet()
    }
    const next = { ...this.ledger.snapshot.display }
    // The pet's own hide/show intent, stored verbatim. The master switch is
    // applied when the state view is produced (see the state view below), not
    // here: writing the conjunction into pet.json turned `enabled: false` into
    // a persisted "the user hid the pet" and the switch could never be undone -
    // re-enabling it (or restarting) read that stored `false` straight back
    // (#1762).
    next.visible = section.visible
    next.size = Math.round(Math.min(DISPLAY_SIZE_MAX, Math.max(DISPLAY_SIZE_MIN, section.size)))
    next.right = Math.round(Math.min(DISPLAY_INSET_MAX, Math.max(0, section.right)))
    next.bottom = Math.round(Math.min(DISPLAY_INSET_MAX, Math.max(0, section.bottom)))
    next.bubbleScale = Math.min(BUBBLE_SCALE_MAX, Math.max(BUBBLE_SCALE_MIN, section.bubbleScale ?? next.bubbleScale))
    next.edgeMarginLeft = clampEdgeMargin(section.edgeMarginLeft ?? next.edgeMarginLeft, defaultDisplayConfig.edgeMarginLeft)
    next.edgeMarginRight = clampEdgeMargin(section.edgeMarginRight ?? next.edgeMarginRight, defaultDisplayConfig.edgeMarginRight)
    this.ledger.setDisplay(next)
    this.flush()
  }

  /** Mirror the persisted display config into the settings document (best-effort). */
  private syncSettingsFromPet(): void {
    const settings = this.ctx.get('settings', false) as { update(ns: string, patch: object): Promise<void> } | undefined
    if (settings === undefined) return
    const ns = this.settingsNamespaceProvider?.() ?? PET_SETTINGS_NAMESPACE
    const snapshot = this.ledger.snapshot
    void settings.update(ns, {
      visible: snapshot.display.visible,
      size: snapshot.display.size,
      right: snapshot.display.right,
      bottom: snapshot.display.bottom,
      bubbleScale: snapshot.display.bubbleScale,
      edgeMarginLeft: snapshot.display.edgeMarginLeft,
      edgeMarginRight: snapshot.display.edgeMarginRight,
      petId: snapshot.petId,
      // The autonomy switch is a plugin-level preference like the master
      // switch, so the settings document owns it; mirroring it here keeps the
      // RPC path and the settings card on one stored value.
      autonomous: this.autonomous,
    }).catch(() => {
      // A settings write failure must not break the pet's own persistence.
    })
  }

  /** Award the turn reward once per completed turn (idempotent per session + turn). */
  private rewardTurn(sessionId: string, turn: number): void {
    if (this.ledger.rewardTurn(sessionId, turn, Date.now())) this.flush()
  }

  /** Preserve turn rewards for installations that only emit legacy activity. */
  private rewardLegacyTurn(): void {
    if (this.ledger.rewardLegacyTurn(Date.now())) this.flush()
  }

  /**
   * Project every on-screen pet into its view row.
   *
   * A pet whose registry entry vanished between the list write and this read
   * is skipped rather than rendered as a broken sprite; the next flush repairs
   * the stored list. The bubble comes from the pet's own machine, which every
   * pet currently feeds from the same session activity — so until the per-pet
   * personality offset lands, two pets show the same phase and differ only in
   * position. That is expected at this stage.
   */
  private instanceViews(autonomous = false): PetInstanceView[] {
    const snapshot = this.ledger.snapshot
    const views: PetInstanceView[] = []
    for (const instance of snapshot.pets) {
      const entry = this.registry.byId(instance.id)
      if (entry === undefined) continue
      const rendered = this.machineFor(instance.id).render()
      const skin = snapshot.skins[instance.id]
      // Autonomous pets report idle unconditionally: their machine is never
      // fed, but reading it would still leak a phase if one were ever pushed
      // in by another path.
      const animation = autonomous ? 'idle' : rendered.animation
      const phase = autonomous ? 'idle' : rendered.phase
      const bubble = autonomous ? undefined : rendered.bubble
      views.push({
        id: instance.id,
        name: this.petName(instance.id),
        animation,
        phase,
        ...(bubble === undefined ? {} : { bubble }),
        right: instance.right,
        bottom: instance.bottom,
        ...(skin === undefined ? {} : { skin }),
      })
    }
    return views
  }

  private view(currentSessionId?: string): PetStateView {
    const snapshot = this.machine.render()
    const entry = this.activeEntry()
    // Autonomous mode serves no session-derived surface at all: no per-session
    // bubble stack, no status bubble copy, no status decoration. The pets keep
    // their own idle animation and only ever speak through interaction
    // feedback or a sibling plugin's announcement. This is enforced here, at
    // the single point every consumer reads, so a browser half cannot
    // resurrect the agent readout from a stale field.
    if (this.autonomous) {
      const autonomousPets = this.instanceViews(true)
      const announcements = this.freshAnnouncements()
      const announcement = announcements.reduce<PetAnnouncement | undefined>(
        (freshest, item) => freshest === undefined || item.at > freshest.at ? item : freshest,
        undefined,
      )
      const panelActions = this.panelActions.views()
      const skin = this.persistedSkin(entry)
      const gameplayDef = this.gameplayDef()
      let gameplay: PetGameplayStateView | undefined
      if (gameplayDef !== undefined) {
        const { state } = this.gameplayState(gameplayDef, Date.now())
        // No session drives the gameplay settle in autonomous mode, so the
        // "agent is busy" input is always false and the pet's own loops own
        // the economy.
        settleGameplay(state, gameplayDef, Date.now(), { sessionActive: false })
        gameplay = this.gameplayViewOf(state)
      }
      return {
        animation: 'idle',
        phase: 'idle',
        sessionActive: false,
        sessions: [],
        autonomous: true,
        statusBubbles: 'off',
        ...(announcement === undefined ? {} : { announcement }),
        ...(announcements.length === 0 ? {} : { announcements }),
        ...(panelActions.length === 0 ? {} : { panelActions }),
        affinity: this.ledger.affinityView(Date.now()),
        display: { ...this.ledger.snapshot.display, visible: this.isEnabled() && this.ledger.snapshot.display.visible },
        pet: {
          id: entry.id,
          displayName: entry.displayName,
          description: entry.description,
        },
        pets: autonomousPets,
        name: this.petName(),
        ...(skin === undefined ? {} : { skin }),
        treats: {
          stocked: this.ledger.snapshot.treats.treats,
          max: this.ledger.treatMax,
        },
        ...(gameplay === undefined ? {} : { gameplay }),
      }
    }
    // One bubble per concurrently active TOP-LEVEL session. The GUI's current
    // session leads the stack when reported (the browser half passes its
    // session list's 'current'); everything else keeps the most recent
    // meaningful event order. Subagent children render no bubble of their own
    // (their activity already shows through the spawning conversation's
    // bubble/display, and the bubble buttons navigate to GUI sessions, which
    // subagents are not). Sessions whose own machine has settled (no bubble
    // copy) drop out, so a finished turn does not leave a stale bubble behind.
    const sessions: PetSessionView[] = []
    for (const [session, activity] of [...this.sessionActivity.entries()].reverse()) {
      if (sessions.length >= MAX_SESSION_BUBBLES) break
      if (session.header?.origin === 'subagent') continue
      const perSession = activity.machine.render()
      if (perSession.bubble === undefined) continue
      // Each session's whisper rides its own bubble while fresh; an expired
      // whisper simply stops appearing (the client's 2 s poll drops it).
      const whisper = activity.whisper
      const freshWhisper = whisper !== undefined && Date.now() - whisper.at < WHISPER_TTL_MS
        ? whisper.text
        : undefined
      sessions.push({
        sessionId: String(session.id),
        animation: perSession.animation,
        bubble: perSession.bubble,
        phase: perSession.phase,
        ...(freshWhisper === undefined ? {} : { whisper: freshWhisper }),
      })
    }
    // The browser half reports the session the user is currently on; that
    // session's bubble leads the stack (its whisper then speaks on the
    // collapsed single bubble). An unreported or absent session keeps the
    // legacy most-recent-first order.
    if (currentSessionId !== undefined) {
      const index = sessions.findIndex(session => session.sessionId === currentSessionId)
      if (index > 0) sessions.unshift(sessions.splice(index, 1)[0]!)
    }
    const decoration = this.activeDecoration()
    // Gameplay view: a read-only projection. The settle runs on a copy, so
    // polling never writes pet.json (verbs settle and persist).
    const gameplayDef = this.gameplayDef()
    let gameplay: PetGameplayStateView | undefined
    if (gameplayDef !== undefined) {
      const { state } = this.gameplayState(gameplayDef, Date.now())
      settleGameplay(state, gameplayDef, Date.now(), { sessionActive: snapshot.sessionActive })
      gameplay = this.gameplayViewOf(state)
    }
    // Read-only: the ledger settles on economic events only, never on a read,
    // so polling the state cannot trigger pet.json writes.
    // One slot per publishing plugin (issue #1812); an expired entry simply
    // stops appearing (the client's 2 s poll drops it), no timer owns removal.
    const announcements = this.freshAnnouncements()
    // The freshest entry keeps the pre-#1812 meaning of the singular field, so
    // a browser half that predates the array still renders one bubble instead
    // of none (a rolling upgrade must never blank a publisher's bubble).
    const announcement = announcements.reduce<PetAnnouncement | undefined>(
      (freshest, entry) => freshest === undefined || entry.at > freshest.at ? entry : freshest,
      undefined,
    )
    const skin = this.persistedSkin(entry)
    // The hover panel's action row extensions (issue #6). Served on every poll
    // so a plugin that mounts or disposes its registration shows up (or goes
    // away) within one tick, without a separate endpoint.
    const panelActions = this.panelActions.views()
    return {
      animation: snapshot.animation,
      ...(snapshot.bubble === undefined ? {} : { bubble: snapshot.bubble }),
      phase: snapshot.phase,
      sessionActive: snapshot.sessionActive,
      autonomous: false,
      sessions,
      ...(decoration === undefined ? {} : { decoration }),
      ...(announcement === undefined ? {} : { announcement }),
      ...(announcements.length === 0 ? {} : { announcements }),
      statusBubbles: this.statusBubbles,
      ...(panelActions.length === 0 ? {} : { panelActions }),
      affinity: this.ledger.affinityView(Date.now()),
      // The one place the two visibility answers are combined: the pet's own
      // hide/show intent AND the plugin master switch. Producing the effective
      // value here - rather than storing it - keeps the switch reversible and
      // keeps pet.json describing only what the user chose (#1762).
      display: { ...this.ledger.snapshot.display, visible: this.isEnabled() && this.ledger.snapshot.display.visible },
      pet: {
        id: entry.id,
        displayName: entry.displayName,
        description: entry.description,
      },
      // Every on-screen pet, in render order, each with its own animation and
      // position. The singular fields above mirror `pets[0]`, so a browser
      // half that predates multi-pet keeps rendering exactly one sprite.
      pets: this.instanceViews(),
      name: this.petName(),
      ...(skin === undefined ? {} : { skin }),
      treats: {
        stocked: this.ledger.snapshot.treats.treats,
        max: this.ledger.treatMax,
      },
      ...(gameplay === undefined ? {} : { gameplay }),
    }
  }

  private flush(): void {
    try {
      savePetPersist(this.ledger.snapshot, this.persistDir)
    } catch {
      // Persistence is best-effort; the in-memory ledger keeps working.
    }
  }
}
