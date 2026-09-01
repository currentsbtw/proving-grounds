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

export interface Seat {
  id: SeatId;
  life: number;
  commanderDamage: number;
  eliminated: boolean;
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
  | 'run';

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
