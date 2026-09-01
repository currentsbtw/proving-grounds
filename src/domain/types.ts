export type ZoneId = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'command';
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
  /** Untapped mana the seat is representing — roughly `min(turn, 8)`. */
  openMana: number;
}

export interface Seat {
  id: SeatId;
  life: number;
  commanderDamage: number;
  eliminated: boolean;
  /** 0–10 pressure rating. Rises every opponent window, falls when damaged. */
  threat: number;
  silhouette: Silhouette;
}

export type EventType = 'wipe' | 'removal' | 'counter' | 'combat' | 'clock' | 'resource';

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
  /** Sub-kind: wipe `creatures`/`nonlands`, resource `discard`/`sacrifice`/`tax`. */
  variant?: string;
  /** Removal target, or the spell held by a counter. Resolution may override it. */
  targetIid?: string;
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

export interface RunRecord {
  id: string;
  deckId: string;
  deckName: string;
  seed: string;
  bracket: number;
  startedAt: number;
  endedAt?: number;
  result?: RunResult;
  log: LogEntry[];
}

export interface SettingRecord {
  key: string;
  value: unknown;
}
