import type { Citation } from '../data/citations';
import type { SeatProfileId } from '../data/profiles';

/**
 * `stack` is bookkeeping, not a rules engine: a card sits there only while the
 * player has declared it cast and has not yet said what happened to it. Nothing
 * moves onto or off it except by the player saying so.
 */
export type ZoneId =
  | 'library'
  | 'hand'
  | 'battlefield'
  | 'graveyard'
  | 'exile'
  | 'command'
  | 'stack';
export type Phase = 'untap' | 'upkeep' | 'draw' | 'main1' | 'combat' | 'main2' | 'end';

/** Cached subset of a Scryfall card object. */
export interface CardData {
  scryfallId: string;
  name: string;
  manaCost: string;
  manaValue: number;
  typeLine: string;
  oracleText: string;
  power?: string;
  toughness?: string;
  colorIdentity: string[];
  imageNormal?: string;
  imageSmall?: string;
  layout: string;
  /**
   * Scryfall's own list of the keywords printed on the card. Optional because
   * cards cached before it was mapped are still perfectly good cards — nothing
   * re-fetches on a schema addition, and the glossary reads the oracle text
   * rather than this list, so an absent one costs nothing.
   */
  keywords?: string[];
}

export interface TokenSpec {
  name: string;
  power?: string;
  toughness?: string;
  colors?: string[];
  typeLine?: string;
}

/** One physical card at the table. */
export interface CardInstance {
  iid: string;
  scryfallId: string | null;
  zone: ZoneId;
  tapped: boolean;
  faceDown: boolean;
  counters: Record<string, number>;
  isCommander: boolean;
  isToken: boolean;
  tokenSpec?: TokenSpec;
  /**
   * Monotonic stamp from the store's move counter, bumped every time this card
   * is created or changes zone. Orders the unordered zones (hand, battlefield,
   * graveyard, exile, command) — higher is more recently arrived. Deterministic
   * per run, not wall-clock, so replaying a seed reproduces the same ordering.
   */
  movedAt: number;
}

export type SeatId = 'A' | 'B' | 'C';

/**
 * An opponent seat's abstract board. Never a real card list — the seats are not
 * simulated players, they are a threat level plus this shape. Every field is a
 * whole number; the engine rounds stochastically as it grows them so the
 * silhouette always reads as a plausible board.
 */
export interface Silhouette {
  /** How many creatures the seat is presenting. */
  creatures: number;
  /** Total power across those creatures. */
  power: number;
  /** Noncreature permanents worth respecting (artifacts + enchantments). */
  artifacts: number;
  /** Untapped mana the seat is representing — roughly `min(turn, 8)` plus `bonusMana`. */
  openMana: number;
  /**
   * Mana the seat banked outside its land drop, and the only part of `openMana`
   * that growth does not overwrite every window. A Treasure the player declined
   * to tax their way out of lives here, so it is still a mana two turns later —
   * which is the whole reason the punish is worth avoiding.
   */
  bonusMana: number;
}

export interface Seat {
  id: SeatId;
  life: number;
  commanderDamage: number;
  eliminated: boolean;
  /** 0–10 pressure rating. Rises every opponent window, falls when damaged. */
  threat: number;
  silhouette: Silhouette;
  /**
   * The highest threat this seat has held this run, and the board it held it
   * with. Killing a seat must never relieve pressure: burning it down sheds
   * threat on the way, so elimination redistributes these peaks rather than the
   * post-damage numbers. Absent on a seat that has never been scored.
   */
  peakThreat?: number;
  peakSilhouette?: Silhouette;
  /**
   * The archetype this seat is piloting, drawn once at run start. Still not a
   * decklist and still no abilities (PRODUCT.md): a label, a colour identity
   * the citation table is filtered against, and a set of multipliers over the
   * hazard curves. Absent on a run that started before profiles existed, and on
   * any caller that has not assigned them — the engine then falls back to
   * `neutral`, whose multipliers are all exactly 1.0 and whose colours are all
   * five, so an unprofiled seat inherits no archetype's opinions. `neutral` is
   * never dealt to a seat; it only ever shows up as that fallback.
   */
  profile?: SeatProfileId;
}

export type EventType = 'wipe' | 'removal' | 'counter' | 'combat' | 'clock' | 'resource';

/**
 * The real card a seat cast to produce an event, frozen onto the event itself.
 *
 * The seats hold no decks, so this is attribution rather than simulation: the
 * engine picks it out of `src/data/citations.ts` by the event's shape, the
 * seat's available mana, the bracket and the turn, and no event fires without
 * one. It is what makes a prompt something that can happen at a real table, and
 * it is what the player resolves by hand — so `effect` is the card's actual
 * effect and `zone` is where the cards it touches really go.
 */
export type EventCitation = Omit<
  Citation,
  'brackets' | 'minTurn' | 'maxTurn' | 'targets' | 'minTargetMv' | 'excludes' | 'counters'
>;

/**
 * Lifecycle of a pressure event.
 * - `pending`   — queued, not yet in front of the player.
 * - `responded` — the player claimed an answer on the table (honor system).
 * - `negated`   — terminal state that follows `responded`; nothing was applied.
 * - `resolved`  — the event's bookkeeping was applied to the board.
 */
export type PressureEventState = 'pending' | 'responded' | 'resolved' | 'negated';

export interface PressureEvent {
  /** Deterministic per seed: `w<window>-<type>-<seat>`. Never random. */
  id: string;
  type: EventType;
  seatId: SeatId;
  /** The player turn this event arrived in front of (the turn about to begin). */
  turn: number;
  /** Human-readable table prompt, built from the seat's silhouette. */
  prompt: string;
  /** Machine-readable magnitudes for M2's scorecard. Keys vary by type. */
  severity: Record<string, number>;
  /**
   * Sub-kind: a wipe's is its `CitationSweep` (`creatures`/`nonland`/`ace`),
   * a resource's is `discard`/`sacrifice`/`tax`. Logs written before the sweep
   * vocabulary was unified say `nonlands`; the scorers normalise that on read.
   */
  variant?: string;
  /** Removal target, or the spell held by a counter. Resolution may override it. */
  targetIid?: string;
  /**
   * The card the seat cast. Present on every type but `combat`, which is the
   * silhouette turning sideways rather than a spell.
   */
  card?: EventCitation;
  state: PressureEventState;
}

/** A seat that wins on its next turn unless answered by the end of `deadlineTurn`. */
export interface ClockState {
  seatId: SeatId;
  /** Last player turn that may complete before the run is lost. */
  deadlineTurn: number;
  /** Player turn the clock spawned on. */
  spawnedTurn: number;
}

/** A seat holding up interaction: spells of `threshold`+ mana value get countered. */
export interface CounterArmed {
  seatId: SeatId;
  threshold: number;
}

export type StackItemKind = 'spell' | 'ability' | 'counter';

/**
 * One entry in the manual stack tray. The tray holds the order the player
 * declared and hands it back top first; it never decides what triggers, who has
 * priority, or whether any of it is legal.
 */
export interface StackItem {
  /** Deterministic per run — `stk-<moveCounter stamp>`, never random. */
  id: string;
  kind: StackItemKind;
  /** Card name for a spell, the typed text for an ability, the seat's claim for a counter. */
  label: string;
  /** `spell`: the card, whose zone is 'stack'. `counter`: the spell it is held over. */
  iid?: string;
  /** `counter` only: the `PressureEvent.id` the tray item stands for. */
  eventId?: string;
  /** `counter` only: the seat holding it. */
  seatId?: SeatId;
}

export type LogKind =
  | 'move'
  | 'draw'
  | 'shuffle'
  | 'mull'
  | 'life'
  | 'counter'
  | 'tap'
  | 'token'
  | 'phase'
  | 'turn'
  | 'commander'
  | 'damage'
  | 'note'
  | 'run'
  /** An opponent window resolved between the player's turns. */
  | 'window'
  /** A pressure event was created, activated, or resolved. */
  | 'event'
  /** The player claimed an answer on the table and negated an event. */
  | 'respond'
  /** Something was put on, resolved off, or taken off the manual stack tray. */
  | 'stack'
  /** A seat's threat meter or silhouette changed outside a window. */
  | 'threat';

export interface LogEntry {
  seq: number;
  turn: number;
  phase: Phase;
  kind: LogKind;
  message: string;
  payload: Record<string, unknown>;
  at: number;
}

export interface DeckCardRef {
  scryfallId: string;
  qty: number;
}

export interface Deck {
  id: string;
  name: string;
  commanderIds: string[];
  cards: DeckCardRef[];
  bracket: 1 | 2 | 3 | 4 | 5;
  createdAt: number;
  updatedAt: number;
}

export type RunResult = 'win' | 'loss' | 'concede' | 'abandoned';

/** Card facts frozen at run start so a persisted run scores without the card cache. */
export interface RosterEntry {
  scryfallId: string | null;
  name: string;
  manaValue: number;
  typeLine: string;
  isCommander: boolean;
}

export interface RunRecord {
  id: string;
  deckId: string;
  deckName: string;
  seed: string;
  bracket: number;
  startedAt: number;
  endedAt?: number;
  result?: RunResult;
  /**
   * Every non-token instance the run started with, keyed by iid. The log records
   * movements by iid and display name only, so without this a persisted run
   * cannot be scored for board value once the Scryfall cache has moved on.
   * Optional because runs persisted before M2 lack it — the scorer falls back to
   * resolving facts by name and marks the scorecard `partial`.
   */
  roster?: Record<string, RosterEntry>;
  log: LogEntry[];
}

export interface SettingRecord {
  key: string;
  value: unknown;
}
