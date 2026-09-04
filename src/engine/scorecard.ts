import { SCORING } from '../data/scorecard';
import { isLandTypeLine } from '../domain/typeLine';
import type { CitationSweep } from '../data/citations';
import { EVENT_TYPES } from './pressure';
import type {
  EventType,
  LogEntry,
  RosterEntry,
  RunRecord,
  RunResult,
  SeatId,
  ZoneId,
} from '../domain/types';

/**
 * The scoring engine. Like `engine/pressure.ts`, every export here is a pure
 * function: it reads a persisted `RunRecord` and returns numbers. Nothing
 * imports the store, touches Dexie, or reads the clock — a run scored today and
 * the same run scored a year from now produce the same scorecard.
 *
 * The log is the only input, and it is append-only, so scoring is a *replay*:
 * walk the entries in `seq` order, rebuild each card's zone as it goes, and read
 * the seven design-doc metrics off the reconstruction. Three consequences worth
 * knowing before editing:
 *
 *  - **Zones are derived, never stored.** A card's zone at entry N is whatever
 *    the entries up to N say it is. The store's own state is not consulted.
 *  - **Card facts come from `run.roster`**, frozen at run start. The log knows an
 *    iid and a display name; it does not know a mana value or a type line, so
 *    board value would be uncomputable without the roster. Runs recorded before
 *    M2 have none — `ScoreOptions.factsByName` resolves those by name, and what
 *    neither resolves counts as mana value 0 and sets `Scorecard.partial`.
 *  - **Undo is additive.** `undoLastLifeChange` never deletes the entry it
 *    reverses, it appends one carrying `undoOf: seq`. Damage tallies therefore
 *    skip every seq that some later entry claims to have undone, exactly as the
 *    store's own totals do.
 */

/**
 * 4 — standing hate pieces and pod combat. `Scorecard.hazards` counts the pieces
 * a run faced and how long each one stood, the ledger's hate rows say how each
 * one left the table, and `SeatOutcome.podDamageTaken` holds the damage seats
 * dealt each other — which is deliberately *not* damage the player dealt. 3
 * added `EventTally.nameable`, and read `AnswerRate.namedRate` against it rather
 * than against every answer: a paid tax is an answer with no card in it, so
 * counting it in the denominator made naming look worse than it was. 2 added
 * `EventTally.named`, `AnswerRate.namedRate` and the ledger's `answerCard`, when
 * answers first bound to the card that made them.
 */
export const SCORECARD_VERSION = 4;

export interface TurnRow {
  turn: number;
  /** Σ MV of non-land, non-token permanents the player deployed this turn (entered battlefield). */
  mvDeployed: number;
  landsPlayed: number;
  cardsDrawn: number;
  /** Board value (Σ MV of nonland, non-token permanents) at the END of the turn. */
  boardValueEnd: number;
  playerLifeEnd: number;
  /** Damage the player dealt to each seat this turn (life loss + commander damage, undo-corrected). */
  damageBySeat: Record<SeatId, number>;
  /** Event ids that arrived (queued) before/in this turn. */
  eventIds: string[];
}

/**
 * One vocabulary for a wipe's scope. The engine, the event and the resolution
 * all speak `CitationSweep` now; runs recorded before they agreed wrote the
 * dock's two-way toggle value `nonlands`, so that is folded into `nonland` on
 * the way in and nothing downstream has to know there were ever two words.
 * Shared with `review.ts`, which reads the same payloads.
 */
export function normalizeSweep(variant: string | undefined): CitationSweep {
  if (variant === 'nonlands' || variant === 'nonland') return 'nonland';
  if (variant === 'ace') return 'ace';
  return 'creatures';
}

export interface WipeRecovery {
  eventId: string;
  turn: number;
  variant: string;
  boardValueBefore: number;
  boardValueAfter: number;
  /** First turn after the wipe whose end-of-turn board value ≥ 70% of boardValueBefore, or null if never. */
  recoveredTurn: number | null;
  turnsToRecover: number | null;
  /** True if the player negated it (responded) — then before/after are equal and recovery is trivially 0. */
  negated: boolean;
}

export interface CommanderStats {
  firstCastTurn: number | null;
  casts: number;
  /** Times the commander left the battlefield (to command/graveyard/exile) after being cast. */
  removals: number;
  /** Turns spent off the battlefield after the first cast, up to run end. */
  downtimeTurns: number;
  totalTaxPaid: number;
  counteredCasts: number;
}

export interface EventTally {
  offered: number;
  responded: number;
  resolved: number;
  unresolved: number;
  /**
   * Answers that named the card that made them. Always ≤ `responded`: an answer
   * with no card is still an answer, it just cannot say which card it held up.
   */
  named: number;
  /**
   * Answers that *could* have named a card — every responded event except a paid
   * tax. Paying a tax is mana, not a card: nothing is asked for and nothing can
   * be bound, so counting it against `named` would only ever read as a player
   * failing to name what they were never offered the chance to.
   */
  nameable: number;
}

export interface AnswerRate {
  byType: Record<EventType, EventTally>;
  total: EventTally;
  /** responded / (responded + resolved), 0..1, null if nothing terminal. */
  rate: number | null;
  /**
   * named / nameable, 0..1, null if nothing answerable-with-a-card was answered.
   * `rate` says how often the player claimed an answer; this says how often the
   * claim came with a card behind it — the difference between measuring claims
   * and measuring answers.
   */
  namedRate: number | null;
}

export interface SeatOutcome {
  seatId: SeatId;
  /** The archetype the seat was dealt at run start, read off the seating entry. Absent on older runs. */
  profile?: string;
  damageDealt: number;
  commanderDamageDealt: number;
  /**
   * Damage this seat took from *another seat*. The pod hits itself while the
   * player untaps, and none of that is the player's work — it is kept out of
   * `damageDealt` and printed on its own so a seat that died to the table is not
   * read as a seat the deck raced down.
   */
  podDamageTaken: number;
  eliminatedTurn: number | null;
  eliminationReason: 'life' | 'commander-damage' | null;
}

/**
 * Standing hate pieces, counted over the whole run.
 *
 * `faced` is every hate event the pod offered; `stood` is the ones the player
 * let resolve, which are the only ones that ever became a piece on the table.
 * `removed` and `swept` say how those left — by the player naming an answer, or
 * by a wrath reaching them. A piece retired with its seat is neither, and a
 * piece still standing when the run ended is neither either; both still
 * contribute the turns they stood.
 */
export interface HazardStats {
  faced: number;
  stood: number;
  removed: number;
  swept: number;
  /**
   * One entry per piece that stood: spawn turn to the turn it left, or to the
   * last turn played when it never did. Same arithmetic the store logs a
   * removal's `turnsStanding` with, so the two never disagree.
   */
  turnsStanding: number[];
}

export type ClockOutcome =
  | 'won'
  | 'eliminated-seat'
  | 'declared-interaction'
  | 'expired'
  | 'standing';

export interface ClockStats {
  faced: boolean;
  spawnedTurn: number | null;
  deadlineTurn: number | null;
  outcome: ClockOutcome | null;
  beatClock: boolean;
}

export interface KeepQuality {
  mulligans: number;
  keptHandSize: number;
  landsInKeptHand: number;
  /** Lands in the original seven before any mulligan. */
  landsInOpeningSeven: number;
}

/** One row of the event ledger — every event the run offered, and how it ended. */
export interface EventLedgerRow {
  eventId: string;
  type: EventType;
  seatId: SeatId;
  turn: number;
  variant?: string;
  /** The card the seat cited, when the event named one. */
  card?: string;
  cardEffect?: string;
  severity: Record<string, number>;
  terminal: 'responded' | 'resolved' | 'unresolved';
  outcome?: Record<string, unknown>;
  note?: string;
  /** The card the player answered with, when the answer named one. */
  answerCard?: string;
  /** Where that card went — absent when it answered from the battlefield and stayed. */
  answerTo?: string;
  /**
   * Hate rows only: the turn the player took the standing piece off the table,
   * and the card they named doing it.
   *
   * A removal is deliberately *not* an answer to the event. The prompt asked
   * "respond or it stands", the player let it stand, and the event resolved —
   * that is the terminal state, and it stays `resolved`. What happened three
   * turns later is a second fact about the same card, so it is recorded here and
   * nowhere near the answer tallies: counting it as an answer would rewrite a
   * question the player did not answer into one they did.
   */
  removedTurn?: number;
  removedWith?: string;
  /** Hate rows only: the turn a wrath swept the standing piece away. */
  sweptTurn?: number;
}

export interface Scorecard {
  version: number;
  runId: string;
  deckId: string;
  deckName: string;
  seed: string;
  bracket: number;
  pressureVersion: number | null;
  startedAt: number;
  endedAt: number | null;
  /** null when the run has no end entry (abandoned, or never persisted). */
  result: RunResult | null;
  /** Last turn reached. */
  turns: number;
  /** True when some card facts were unresolvable — board value is a lower bound. */
  partial: boolean;
  timeline: TurnRow[];
  deployment: {
    firstCommanderCastTurn: number | null;
    cumulativeMv: number[];
    avgMvPerTurn: number;
    landsByTurn: number[];
  };
  wipes: WipeRecovery[];
  commander: CommanderStats;
  answers: AnswerRate;
  /** Standing hate pieces: how many were faced, how many stood, and for how long. */
  hazards: HazardStats;
  seats: SeatOutcome[];
  clock: ClockStats;
  keep: KeepQuality;
  /** Compact ledger of every event, terminal state and turn, for the UI table. */
  events: EventLedgerRow[];
}

export interface ScoreOptions {
  /** Legacy runs without a roster: resolve card facts by display name. */
  factsByName?: (name: string) => RosterEntry | undefined;
}

const SEAT_IDS: SeatId[] = ['A', 'B', 'C'];

const ZONES: ZoneId[] = [
  'library',
  'hand',
  'battlefield',
  'graveyard',
  'exile',
  'command',
  'stack',
];

// ---------------------------------------------------------------------------
// Payload readers
// ---------------------------------------------------------------------------
// `LogEntry.payload` is `Record<string, unknown>` by design — the log is a
// forward-compatible bag, and a scorer three milestones later must survive keys
// it has never seen. Everything below narrows defensively and never throws.

type Payload = Record<string, unknown>;

function readString(payload: Payload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(payload: Payload, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isTrue(payload: Payload, key: string): boolean {
  return payload[key] === true;
}

function readStringArray(payload: Payload, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function readObject(payload: Payload, key: string): Payload | undefined {
  const value = payload[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Payload)
    : undefined;
}

function readNumberRecord(payload: Payload, key: string): Record<string, number> {
  const raw = readObject(payload, key);
  const out: Record<string, number> = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function readZone(payload: Payload, key: string): ZoneId | undefined {
  const value = readString(payload, key);
  return value !== undefined && (ZONES as string[]).includes(value)
    ? (value as ZoneId)
    : undefined;
}

function readSeat(payload: Payload, key: string): SeatId | undefined {
  const value = readString(payload, key);
  return value === 'A' || value === 'B' || value === 'C' ? value : undefined;
}

function readEventType(payload: Payload, key: string): EventType | undefined {
  const value = readString(payload, key);
  return value !== undefined && (EVENT_TYPES as string[]).includes(value)
    ? (value as EventType)
    : undefined;
}

/**
 * Front face only, the same reading the table made while the run was played —
 * otherwise a `Sorcery // Land` counts as a land drop here and as a spell there.
 */
function isLandType(typeLine: string): boolean {
  return isLandTypeLine(typeLine);
}

// ---------------------------------------------------------------------------
// The replay
// ---------------------------------------------------------------------------

/**
 * One standing piece, from the turn it landed to the turn it left. `fate` is
 * null while it is still on the table — a run that ends with it there closes the
 * span at the last turn played, because "stood to the end" is the reading, not
 * "stood forever".
 */
interface HazardSpan {
  eventId: string;
  spawnedTurn: number;
  endTurn: number | null;
  fate: 'removed' | 'swept' | 'retired' | null;
}

/** Everything one pass over the log produces. `scoreRun` does the arithmetic. */
interface Replay {
  zones: Map<string, ZoneId>;
  rows: TurnRow[];
  /** Was a commander on the battlefield at the end of each row's turn? */
  commanderUpAtEnd: boolean[];
  events: Map<string, EventLedgerRow>;
  /** Turn each event id belongs to, before clamping to the last turn played. */
  eventTurns: Map<string, number>;
  wipes: WipeRecovery[];
  /** Keyed by hazard id, in the order the pieces landed. */
  hazards: Map<string, HazardSpan>;
  commander: CommanderStats;
  seats: Map<SeatId, SeatOutcome>;
  clock: ClockStats;
  keep: KeepQuality;
  lastTurn: number;
  endPayload: Payload | null;
  startPayload: Payload | null;
  partial: boolean;
}

function replayRun(run: RunRecord, options?: ScoreOptions): Replay {
  const log = [...run.log].sort((a, b) => a.seq - b.seq);
  const roster = run.roster;
  const factsByName = options?.factsByName;

  // --- fact resolution ------------------------------------------------------
  // Names are indexed from the whole log up front: a legacy run's opening seven
  // is logged as bare iids, and the only place those cards ever get a name is
  // some later entry that moved, drew, milled or bottomed them.
  const nameByIid = new Map<string, string>();
  const tokenFacts = new Map<string, RosterEntry>();
  for (const entry of log) {
    const p = entry.payload;
    const iid = readString(p, 'iid');
    const name = readString(p, 'name');
    if (iid && name) nameByIid.set(iid, name);
    const iids = readStringArray(p, 'iids');
    const names = readStringArray(p, 'names');
    if (iids.length > 0 && names.length === iids.length) {
      iids.forEach((id, i) => nameByIid.set(id, names[i]));
    }
    const bottomIids = readStringArray(p, 'bottomIids');
    const bottomNames = readStringArray(p, 'bottomNames');
    if (bottomIids.length > 0 && bottomNames.length === bottomIids.length) {
      bottomIids.forEach((id, i) => nameByIid.set(id, bottomNames[i]));
    }
    if (entry.kind === 'token') {
      const spec = readObject(p, 'spec');
      const facts: RosterEntry = {
        scryfallId: null,
        name: (spec && readString(spec, 'name')) ?? 'Token',
        manaValue: 0,
        typeLine: (spec && readString(spec, 'typeLine')) ?? 'Creature — Token',
        isCommander: false,
      };
      for (const id of iids) tokenFacts.set(id, facts);
    }
  }

  let partial = false;
  const factCache = new Map<string, RosterEntry | null>();

  /**
   * Card facts for an iid: the token spec, then the run's roster, then the
   * caller's name lookup. A miss is remembered as null and taints the whole
   * scorecard — a board value computed over cards we could not price is a lower
   * bound, and the UI has to be able to say so.
   */
  function factsFor(iid: string): RosterEntry | null {
    const cached = factCache.get(iid);
    if (cached !== undefined) return cached;
    let facts = tokenFacts.get(iid) ?? roster?.[iid];
    if (!facts) {
      const name = nameByIid.get(iid);
      if (name && factsByName) facts = factsByName(name);
    }
    const resolved = facts ?? null;
    if (!resolved) partial = true;
    factCache.set(iid, resolved);
    return resolved;
  }

  /** What this card is worth to board value: nothing, unless it is a real nonland. */
  function boardContribution(iid: string): number {
    if (tokenFacts.has(iid)) return 0;
    const facts = factsFor(iid);
    if (!facts) return 0;
    return isLandType(facts.typeLine) ? 0 : facts.manaValue;
  }

  function isLand(iid: string): boolean {
    const facts = factsFor(iid);
    return facts ? isLandType(facts.typeLine) : false;
  }

  // --- zone reconstruction --------------------------------------------------
  const zones = new Map<string, ZoneId>();
  const commanderIids = new Set<string>();
  if (roster) {
    for (const [iid, facts] of Object.entries(roster)) {
      zones.set(iid, facts.isCommander ? 'command' : 'library');
      if (facts.isCommander) commanderIids.add(iid);
    }
  }

  let boardValue = 0;
  let playerLife: number = SCORING.startingLife;

  function setZone(iid: string, to: ZoneId): void {
    const from = zones.get(iid);
    if (from === to) return;
    if (from === 'battlefield') boardValue -= boardContribution(iid);
    zones.set(iid, to);
    if (to === 'battlefield') boardValue += boardContribution(iid);
  }

  function iidsInZone(zone: ZoneId): string[] {
    const out: string[] = [];
    for (const [iid, z] of zones) if (z === zone) out.push(iid);
    return out;
  }

  // --- accumulators ---------------------------------------------------------
  const rows: TurnRow[] = [];
  const commanderUpAtEnd: boolean[] = [];
  const events = new Map<string, EventLedgerRow>();
  const eventTurns = new Map<string, number>();
  const wipes: WipeRecovery[] = [];
  const hazards = new Map<string, HazardSpan>();
  const seats = new Map<SeatId, SeatOutcome>(SEAT_IDS.map((id) => [id, emptySeatOutcome(id)]));

  const commander: CommanderStats = {
    firstCastTurn: null,
    casts: 0,
    removals: 0,
    downtimeTurns: 0,
    totalTaxPaid: 0,
    counteredCasts: 0,
  };

  /**
   * Countered casts already scored off a *cast* entry, per commander iid — the
   * legacy log shape. The matching "returned to the command zone" entry that
   * follows is the same countered cast said twice, so it is skipped once here.
   * Empty for every run recorded since the two cast paths were reconciled.
   */
  const legacyCounteredHome = new Map<string, number>();

  const clock: ClockStats = {
    faced: false,
    spawnedTurn: null,
    deadlineTurn: null,
    outcome: null,
    beatClock: false,
  };
  /** How the last clock left the table, if it did. */
  let clockClearedBy: 'eliminated-seat' | 'declared-interaction' | null = null;
  /**
   * The ledger row a *standing* clock's answer had to invent, and the turn it
   * landed on. Kept so a legacy log that wrote the answer fields onto both the
   * clock's entry and the warning's can have the invented one taken back out —
   * one spent card must not answer two events.
   */
  let standingClockRow: { eventId: string; turn: number } | null = null;
  let clockClearedTurn: number | null = null;
  let clockExpired = false;

  const keep: KeepQuality = {
    mulligans: 0,
    keptHandSize: 0,
    landsInKeptHand: 0,
    landsInOpeningSeven: 0,
  };
  let openingSeven: string[] = [];
  let lastDealtHand: string[] = [];
  let keepRecorded = false;

  let startPayload: Payload | null = null;
  let endPayload: Payload | null = null;
  let lastTurn = 1;

  // A life change that some later entry undid never happened, for scoring
  // purposes — the store rolls its own totals back the same way.
  const undone = new Set<number>();
  for (const entry of log) {
    const of = readNumber(entry.payload, 'undoOf');
    if (of !== undefined) undone.add(of);
  }

  function commanderUp(): boolean {
    for (const iid of commanderIids) if (zones.get(iid) === 'battlefield') return true;
    return false;
  }

  function rowFor(turn: number): TurnRow {
    while (rows.length < turn) {
      rows.push({
        turn: rows.length + 1,
        mvDeployed: 0,
        landsPlayed: 0,
        cardsDrawn: 0,
        boardValueEnd: boardValue,
        playerLifeEnd: playerLife,
        damageBySeat: { A: 0, B: 0, C: 0 },
        eventIds: [],
      });
      commanderUpAtEnd.push(commanderUp());
    }
    return rows[turn - 1];
  }

  /** First sighting of an event id creates its ledger row; later ones refine it. */
  function ledgerFor(entry: LogEntry): EventLedgerRow | null {
    const p = entry.payload;
    const eventId = readString(p, 'eventId');
    if (!eventId) return null;
    const existing = events.get(eventId);
    if (existing) return existing;
    const row: EventLedgerRow = {
      eventId,
      type: readEventType(p, 'eventType') ?? 'combat',
      seatId: readSeat(p, 'seatId') ?? 'A',
      turn: readNumber(p, 'eventTurn') ?? entry.turn,
      variant: readString(p, 'variant'),
      // Every entry an event writes carries the same flattened citation, so the
      // first sighting has it — queued, intercepted, answered or resolved.
      card: readString(p, 'card'),
      cardEffect: readString(p, 'cardEffect'),
      severity: readNumberRecord(p, 'severity'),
      terminal: 'unresolved',
    };
    events.set(eventId, row);
    // The window that offers an event resolves *before* the turn counter moves,
    // so the entry's own `turn` is the previous one. `eventTurn` is the turn the
    // event is in front of, which is the turn the player has to answer it in.
    eventTurns.set(eventId, row.turn);
    return row;
  }

  function noteDamage(seatId: SeatId, turn: number, amount: number, commanderDamage: number): void {
    if (amount <= 0 && commanderDamage <= 0) return;
    const seat = seats.get(seatId);
    if (seat) {
      seat.damageDealt += amount;
      seat.commanderDamageDealt += commanderDamage;
    }
    rowFor(turn).damageBySeat[seatId] += amount;
  }

  // --- the pass -------------------------------------------------------------
  for (const entry of log) {
    const p = entry.payload;
    lastTurn = Math.max(lastTurn, entry.turn);

    switch (entry.kind) {
      case 'run': {
        if (readString(p, 'seed') !== undefined && readString(p, 'runId') !== undefined) {
          startPayload = p;
        } else if (readString(p, 'result') !== undefined) {
          endPayload = p;
          // A clock still on the table at the last entry was never answered.
          if (readObject(p, 'clock')) clock.faced = true;
        } else if (readString(p, 'reason') === 'clock-expired') {
          clockExpired = true;
          clock.faced = true;
          clock.deadlineTurn = readNumber(p, 'deadlineTurn') ?? clock.deadlineTurn;
        }
        break;
      }

      case 'draw': {
        const iids = readStringArray(p, 'iids');
        for (const iid of iids) setZone(iid, 'hand');
        const opening = isTrue(p, 'opening');
        const mulligan = isTrue(p, 'mulligan');
        if (opening) openingSeven = [...iids];
        if (opening || mulligan) lastDealtHand = [...iids];
        // Opening and post-mulligan hands are dealt, not drawn: counting them
        // would put seven "draws" on turn 1 of every run and flatten the curve.
        else rowFor(entry.turn).cardsDrawn += iids.length;
        break;
      }

      case 'mull': {
        const bottomIids = readStringArray(p, 'bottomIids');
        if (p.bottomIids !== undefined) {
          // The keep. Bottomed cards are already gone by the time this entry is
          // written, so mirror that before snapshotting the hand.
          for (const iid of bottomIids) setZone(iid, 'library');
          const hand = iidsInZone('hand');
          keep.mulligans = readNumber(p, 'mulliganCount') ?? keep.mulligans;
          keep.keptHandSize = hand.length;
          keep.landsInKeptHand = hand.filter(isLand).length;
          keepRecorded = true;
        } else {
          // A mulligan: the whole hand goes back, and the count comes off the entry.
          for (const iid of iidsInZone('hand')) setZone(iid, 'library');
          keep.mulligans = readNumber(p, 'mulliganCount') ?? keep.mulligans + 1;
        }
        break;
      }

      case 'move': {
        const to = readZone(p, 'to');
        if (!to) break;
        const single = readString(p, 'iid');
        // Mills log one entry for the whole batch, with `iids` and no `iid`.
        const moved = single ? [single] : readStringArray(p, 'iids');
        if (isTrue(p, 'isCommander') && single) commanderIids.add(single);
        for (const iid of moved) {
          const from = zones.get(iid);
          if (from === to) continue;
          if (to === 'battlefield') {
            // Deployment is measured where the card lands, not where it came
            // from, so a spell resolving off the stack tray scores exactly as
            // the same spell played straight out of hand. Lands never reach the
            // tray, so the land-drop tally is unaffected either way.
            const row = rowFor(entry.turn);
            if (isLand(iid)) row.landsPlayed += 1;
            else row.mvDeployed += boardContribution(iid);
            // A commander can reach the battlefield without a 'commander' cast
            // entry — forcing one through a counterspell is a plain move. What
            // matters for deployment is the turn it first stood on the table.
            if (commanderIids.has(iid) && commander.firstCastTurn === null) {
              commander.firstCastTurn = entry.turn;
            }
          }
          if (
            from === 'battlefield' &&
            commanderIids.has(iid) &&
            commander.firstCastTurn !== null
          ) {
            commander.removals += 1;
          }
          setZone(iid, to);
          // A token that left the battlefield ceased to exist. The entry still
          // names where it was headed, because that is what a wipe swept it to,
          // but the replay must not leave a Treasure sitting in a graveyard the
          // store has no card in. Board value is unaffected either way — a token
          // contributes nothing.
          if (isTrue(p, 'tokenGone')) zones.delete(iid);
        }
        break;
      }

      case 'commander': {
        const iid = readString(p, 'iid');
        if (iid) commanderIids.add(iid);
        const castNumber = readNumber(p, 'castNumber');
        if (castNumber !== undefined) {
          // Every cast accrues tax, including one that got countered on the
          // stack — the commander comes back more expensive either way.
          commander.casts += 1;
          commander.totalTaxPaid += readNumber(p, 'taxPaid') ?? 0;
          if (isTrue(p, 'countered')) {
            // Legacy shape. A run recorded before the two cast paths were
            // reconciled marked the *cast* countered the moment a seat spoke
            // up, and then wrote the trip home as a second countered entry. Both
            // describe one countered cast, so the second one is owed a skip.
            commander.counteredCasts += 1;
            if (iid) legacyCounteredHome.set(iid, (legacyCounteredHome.get(iid) ?? 0) + 1);
          }
        } else if (isTrue(p, 'countered')) {
          // The trip back to the command zone, written when the counter actually
          // resolved. This is the only entry a current run marks countered, and
          // it is written identically whether the commander was cast straight
          // out of the command zone or routed through the stack tray — which is
          // what makes the two paths score the same.
          const owed = iid ? (legacyCounteredHome.get(iid) ?? 0) : 0;
          if (owed > 0 && iid) legacyCounteredHome.set(iid, owed - 1);
          else commander.counteredCasts += 1;
        }
        // Only a cast that actually landed moves the card. A countered direct
        // cast logs `to: 'stack'`, and the follow-up entries (a move, or a
        // second 'commander' entry for the trip back to the command zone) carry
        // the real zone change, so applying anything else here would
        // double-count. A cast onto the tray writes no `to` at all: the 'move'
        // entry beside it is the zone change.
        if (iid && readZone(p, 'to') === 'battlefield') {
          if (commander.firstCastTurn === null) commander.firstCastTurn = entry.turn;
          const row = rowFor(entry.turn);
          if (zones.get(iid) !== 'battlefield') row.mvDeployed += boardContribution(iid);
          setZone(iid, 'battlefield');
        }
        break;
      }

      case 'token': {
        for (const iid of readStringArray(p, 'iids')) setZone(iid, 'battlefield');
        break;
      }

      case 'life': {
        if (readNumber(p, 'undoOf') !== undefined) {
          // An undo entry restores rather than adjusts; the damage it reverses is
          // already excluded via `undone`.
          if (readString(p, 'target') === 'player') {
            playerLife = readNumber(p, 'restoredLife') ?? playerLife;
          }
          break;
        }
        const target = readString(p, 'target');
        if (target === 'player') {
          playerLife = readNumber(p, 'after') ?? playerLife;
          break;
        }
        const seatId = readSeat(p, 'seatId') ?? readSeat(p, 'target');
        const delta = readNumber(p, 'delta');
        if (seatId && delta !== undefined && delta < 0 && !undone.has(entry.seq)) {
          noteDamage(seatId, entry.turn, -delta, 0);
        }
        break;
      }

      case 'damage': {
        const seatId = readSeat(p, 'seatId');
        if (!seatId) break;
        const reason = readString(p, 'reason');
        if (reason === 'life' || reason === 'commander-damage') {
          const seat = seats.get(seatId);
          if (seat && seat.eliminatedTurn === null) {
            seat.eliminatedTurn = entry.turn;
            seat.eliminationReason = reason;
          }
          break;
        }
        const amount = readNumber(p, 'amount');
        if (amount === undefined || amount <= 0 || undone.has(entry.seq)) break;
        if (isTrue(p, 'podCombat')) {
          // A seat swinging at another seat. `seatId` is the *defender* here, and
          // none of this is the player's damage: it must not reach `damageDealt`,
          // `commanderDamageDealt` or the timeline's per-turn damage row, or a
          // deck that sat still while the pod ate itself would read as a deck
          // that raced. It is the one thing the pod does to itself that the
          // scorecard records at all, so it gets its own column.
          const seat = seats.get(seatId);
          if (seat) seat.podDamageTaken += amount;
          break;
        }
        // Commander damage costs life too, and the store logs it only here —
        // so this is the whole hit, not a second helping of a 'life' entry.
        noteDamage(seatId, entry.turn, amount, amount);
        break;
      }

      case 'window': {
        const window = readObject(p, 'clock');
        if (window) {
          clock.faced = true;
          const spawnedTurn = readNumber(window, 'spawnedTurn') ?? null;
          if (spawnedTurn !== clock.spawnedTurn) {
            // A fresh clock: the previous one's fate no longer describes the table.
            clockClearedBy = null;
            clockClearedTurn = null;
          }
          clock.spawnedTurn = spawnedTurn;
          clock.deadlineTurn = readNumber(window, 'deadlineTurn') ?? null;
        }
        if (isTrue(p, 'clockExpired')) {
          clock.faced = true;
          clockExpired = true;
          clock.deadlineTurn = readNumber(p, 'deadlineTurn') ?? clock.deadlineTurn;
        }
        break;
      }

      case 'event': {
        const canceledId = readString(p, 'eventId');
        if (canceledId && isTrue(p, 'canceled')) {
          // The seat that owned this event was eliminated before the player ever
          // had to answer it, so it was not offered at all: it leaves no ledger
          // row, no tally, and no wipe to recover from.
          events.delete(canceledId);
          eventTurns.delete(canceledId);
          const at = wipes.findIndex((w) => w.eventId === canceledId);
          if (at >= 0) wipes.splice(at, 1);
          break;
        }
        const row = ledgerFor(entry);
        if (!row) break;
        if (row.type === 'clock') {
          clock.faced = true;
          if (clock.spawnedTurn === null) clock.spawnedTurn = row.turn;
          clock.deadlineTurn = row.severity.deadlineTurn ?? clock.deadlineTurn;
        }
        if (!isTrue(p, 'resolved')) break;

        row.terminal = 'resolved';
        const outcome = readObject(p, 'outcome');
        if (outcome) row.outcome = outcome;
        const note = readString(p, 'note');
        if (note) row.note = note;

        if (row.type === 'hate' && outcome && isTrue(outcome, 'standing')) {
          // The player let it through, so a piece is now on the table. The store
          // names it; a log written without the id still has the deterministic
          // one the store builds, so the span is never orphaned.
          const hazardId = readString(outcome, 'hazardId') ?? `hz-${row.eventId}`;
          if (!hazards.has(hazardId)) {
            hazards.set(hazardId, {
              eventId: row.eventId,
              spawnedTurn: entry.turn,
              endTurn: null,
              fate: null,
            });
          }
        }

        if (row.type === 'wipe' && outcome) {
          // The sweep's moves are logged *before* this entry, so the board is
          // already empty here. Add the victims back to recover the "before".
          const swept = readStringArray(outcome, 'iids');
          const lost = swept.reduce((sum, iid) => sum + boardContribution(iid), 0);
          wipes.push({
            eventId: row.eventId,
            turn: entry.turn,
            variant: normalizeSweep(readString(outcome, 'scope') ?? row.variant),
            boardValueBefore: boardValue + lost,
            boardValueAfter: boardValue,
            recoveredTurn: null,
            turnsToRecover: null,
            negated: false,
          });
        }
        break;
      }

      case 'respond': {
        if (readString(p, 'reason') === 'removed-hazard') {
          // A standing piece taken off the table, turns after the event that put
          // it there already ended. It carries an event id and a bound answer, so
          // it would otherwise fall straight through the answer path below and
          // flip a resolved hate row to `responded` — one card answering an event
          // the player had already declined to answer. It files on the row as
          // what it is, and the tallies never see it.
          const hazardId = readString(p, 'hazardId');
          const span = hazardId === undefined ? undefined : hazards.get(hazardId);
          if (span && span.endTurn === null) {
            span.endTurn = entry.turn;
            span.fate = 'removed';
          }
          const eventId = readString(p, 'eventId');
          const row = eventId === undefined ? undefined : events.get(eventId);
          if (row) {
            row.removedTurn = entry.turn;
            const named = readString(p, 'answerName');
            if (named) row.removedWith = named;
          }
          break;
        }
        if (readString(p, 'reason') === 'declared-interaction') {
          // No eventId on this one: it answers the clock itself, not a prompt.
          clock.faced = true;
          clockClearedBy = 'declared-interaction';
          clockClearedTurn = entry.turn;
          clock.deadlineTurn = readNumber(p, 'deadlineTurn') ?? clock.deadlineTurn;
          clock.spawnedTurn = readNumber(p, 'spawnedTurn') ?? clock.spawnedTurn;
          // A clock the player answered while its warning card was still up puts
          // the answer on the warning's own entry, which has an event id and is
          // scored below like any other answer. A *standing* clock has no
          // warning and no event entry anywhere in the log, so this is the only
          // place its answer can be read: the row is invented under the same id
          // the store bound the card to, `clock-<seatId>`, and the tallies see
          // one responded event with a card behind it. An answer that named no
          // card invents nothing — there is no event to file it under, and a
          // bare claim about a clock was never counted before either.
          const claimed = readString(p, 'answerName');
          const clockSeat = readSeat(p, 'seatId');
          if (claimed && clockSeat) {
            const eventId = `clock-${clockSeat}`;
            const severity: Record<string, number> = {};
            const deadline = readNumber(p, 'deadlineTurn');
            if (deadline !== undefined) severity.deadlineTurn = deadline;
            const invented: EventLedgerRow = events.get(eventId) ?? {
              eventId,
              type: 'clock',
              seatId: clockSeat,
              turn: entry.turn,
              severity,
              terminal: 'responded',
            };
            invented.terminal = 'responded';
            invented.answerCard = claimed;
            const wentTo = readZone(p, 'answerTo');
            if (wentTo) invented.answerTo = wentTo;
            const claimNote = readString(p, 'note');
            if (claimNote) invented.note = claimNote;
            if (!events.has(eventId)) {
              events.set(eventId, invented);
              eventTurns.set(eventId, invented.turn);
            }
            standingClockRow = { eventId, turn: entry.turn };
          }
          break;
        }
        const row = ledgerFor(entry);
        if (!row) break;
        row.terminal = 'responded';
        const note = readString(p, 'note');
        if (note) row.note = note;
        // Only a bound answer names a card. A rejected iid writes `bound: false`
        // and no name, so the row stays as silent as an unbound answer does.
        const answerCard = readString(p, 'answerName');
        if (answerCard) row.answerCard = answerCard;
        const answerTo = readZone(p, 'answerTo');
        if (answerTo) row.answerTo = answerTo;
        // The warning's entry follows the clock's own, in the same turn. A log
        // written before the fields were confined to one entry carries the
        // answer on both; the warning is the entry with a real event id, so it
        // keeps the answer and the invented row goes back out.
        if (
          row.type === 'clock' &&
          answerCard !== undefined &&
          standingClockRow !== null &&
          standingClockRow.turn === entry.turn
        ) {
          events.delete(standingClockRow.eventId);
          eventTurns.delete(standingClockRow.eventId);
          standingClockRow = null;
        }
        if (row.type === 'wipe') {
          wipes.push({
            eventId: row.eventId,
            turn: entry.turn,
            variant: normalizeSweep(row.variant),
            boardValueBefore: boardValue,
            boardValueAfter: boardValue,
            recoveredTurn: entry.turn,
            turnsToRecover: 0,
            negated: true,
          });
        }
        break;
      }

      case 'threat': {
        // The seating entry is the one place the profiles are written down.
        const seated = p.seats;
        if (Array.isArray(seated)) {
          for (const item of seated) {
            if (!item || typeof item !== 'object') continue;
            const bag = item as Record<string, unknown>;
            const id = readString(bag, 'id') as SeatId | undefined;
            const profile = readString(bag, 'profile');
            const outcome = id ? seats.get(id) : undefined;
            if (outcome && profile) outcome.profile = profile;
          }
        }
        // A standing piece leaving without the player: a wrath reached it, or the
        // seat holding it died. Either way the span closes, and neither is a
        // removal — the player spent nothing on it.
        const hazardId = readString(p, 'hazardId');
        if (hazardId !== undefined && isTrue(p, 'canceled')) {
          const span = hazards.get(hazardId);
          const swept = readString(p, 'reason') === 'wiped';
          if (span && span.endTurn === null) {
            span.endTurn = entry.turn;
            span.fate = swept ? 'swept' : 'retired';
          }
          const eventId = readString(p, 'eventId');
          const row = eventId === undefined ? undefined : events.get(eventId);
          if (row && swept) row.sweptTurn = entry.turn;
          break;
        }

        if (isTrue(p, 'canceled') && readString(p, 'reason') === 'elimination') {
          clockClearedBy = 'eliminated-seat';
          clockClearedTurn = entry.turn;
          clock.deadlineTurn = readNumber(p, 'deadlineTurn') ?? clock.deadlineTurn;
        }
        break;
      }

      default:
        break;
    }

    // Every entry closes out its turn's running snapshot. Entries only ever move
    // forward in `turn`, so the last write for a turn is that turn's end state.
    const row = rowFor(entry.turn);
    row.boardValueEnd = boardValue;
    row.playerLifeEnd = playerLife;
    commanderUpAtEnd[entry.turn - 1] = commanderUp();
  }

  if (!keepRecorded) {
    // A run recorded before the keep was logged (or abandoned mid-mulligan):
    // the last hand dealt is the closest thing to a kept hand.
    keep.keptHandSize = lastDealtHand.length;
    keep.landsInKeptHand = lastDealtHand.filter(isLand).length;
  }
  keep.landsInOpeningSeven = openingSeven.filter(isLand).length;

  // --- the clock's fate -----------------------------------------------------
  if (clock.faced) {
    const result = readString(endPayload ?? {}, 'result') ?? run.result;
    // Expiry is the only outcome that ends the run outright, so it wins. After
    // that, clearing the clock on the table beats simply having gone on to win:
    // it names *how* the race was answered, which is the interesting part.
    if (clockExpired) clock.outcome = 'expired';
    else if (clockClearedBy) clock.outcome = clockClearedBy;
    else if (result === 'win') clock.outcome = 'won';
    else clock.outcome = 'standing';
    const clearedInTime =
      clockClearedTurn !== null &&
      (clock.deadlineTurn === null || clockClearedTurn <= clock.deadlineTurn);
    clock.beatClock =
      clock.outcome === 'won' ||
      ((clock.outcome === 'eliminated-seat' || clock.outcome === 'declared-interaction') &&
        clearedInTime);
  }

  return {
    zones,
    rows,
    commanderUpAtEnd,
    events,
    eventTurns,
    wipes,
    hazards,
    commander,
    seats,
    clock,
    keep,
    lastTurn,
    endPayload,
    startPayload,
    partial,
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function emptyTally(): EventTally {
  return { offered: 0, responded: 0, resolved: 0, unresolved: 0, named: 0, nameable: 0 };
}

/**
 * A tax is paid in mana. It is the one answer with no card in it — the store
 * asks for none and binds none — so it is an answer that could never have named
 * one, and it sits out of the naming denominator.
 */
function isPaidTax(row: EventLedgerRow): boolean {
  return row.type === 'resource' && row.variant === 'tax';
}

/** A seat that never took a point of damage still gets a row. */
function emptySeatOutcome(seatId: SeatId): SeatOutcome {
  return {
    seatId,
    damageDealt: 0,
    commanderDamageDealt: 0,
    podDamageTaken: 0,
    eliminatedTurn: null,
    eliminationReason: null,
  };
}

/** Score one persisted run. Pure: same record in, same scorecard out, forever. */
export function scoreRun(run: RunRecord, options?: ScoreOptions): Scorecard {
  const replay = replayRun(run, options);
  const end = replay.endPayload;
  const start = replay.startPayload;

  const turns = readNumber(end ?? {}, 'turns') ?? replay.lastTurn;
  const timeline = replay.rows;

  // Events are filed under the turn they were offered for. A run that ended in
  // the window before its next turn can offer events for a turn never played;
  // those land on the last real row rather than inventing one.
  for (const [eventId, turn] of replay.eventTurns) {
    const row = timeline[Math.min(Math.max(1, turn), timeline.length) - 1];
    if (row) row.eventIds.push(eventId);
  }

  // --- wipe recovery --------------------------------------------------------
  for (const wipe of replay.wipes) {
    if (wipe.negated) continue;
    const target = wipe.boardValueBefore * SCORING.wipe.recoveryShare;
    for (const row of timeline) {
      if (row.turn <= wipe.turn) continue;
      if (row.boardValueEnd >= target) {
        wipe.recoveredTurn = row.turn;
        wipe.turnsToRecover = row.turn - wipe.turn;
        break;
      }
    }
  }

  // --- commander downtime ---------------------------------------------------
  const firstCast = replay.commander.firstCastTurn;
  if (firstCast !== null) {
    for (let turn = firstCast; turn <= turns; turn++) {
      if (!replay.commanderUpAtEnd[turn - 1]) replay.commander.downtimeTurns += 1;
    }
  }

  // --- answers --------------------------------------------------------------
  const byType = {} as Record<EventType, EventTally>;
  for (const type of EVENT_TYPES) byType[type] = emptyTally();
  const total = emptyTally();
  const events: EventLedgerRow[] = [];
  for (const row of replay.events.values()) {
    events.push(row);
    const tally = byType[row.type];
    tally.offered += 1;
    total.offered += 1;
    tally[row.terminal] += 1;
    total[row.terminal] += 1;
    if (row.terminal === 'responded' && !isPaidTax(row)) {
      tally.nameable += 1;
      total.nameable += 1;
    }
    if (row.terminal === 'responded' && row.answerCard !== undefined) {
      tally.named += 1;
      total.named += 1;
    }
  }
  const terminal = total.responded + total.resolved;

  // --- standing hate pieces -------------------------------------------------
  // A piece still on the table when the run stopped is measured to the last turn
  // played. It is not "still standing" in any sense the scorecard can act on —
  // the run is over — and leaving it out of the average would flatter exactly the
  // pieces that were never dealt with.
  const hazards: HazardStats = {
    faced: byType.hate.offered,
    stood: replay.hazards.size,
    removed: 0,
    swept: 0,
    turnsStanding: [],
  };
  for (const span of replay.hazards.values()) {
    if (span.fate === 'removed') hazards.removed += 1;
    if (span.fate === 'swept') hazards.swept += 1;
    hazards.turnsStanding.push(Math.max(0, (span.endTurn ?? turns) - span.spawnedTurn));
  }

  // --- deployment -----------------------------------------------------------
  const cumulativeMv: number[] = [];
  const landsByTurn: number[] = [];
  let running = 0;
  for (const row of timeline) {
    running += row.mvDeployed;
    cumulativeMv.push(running);
    landsByTurn.push(row.landsPlayed);
  }

  return {
    version: SCORECARD_VERSION,
    runId: run.id,
    deckId: run.deckId,
    deckName: run.deckName,
    seed: run.seed,
    bracket: run.bracket,
    pressureVersion: readNumber(start ?? {}, 'pressureVersion') ?? null,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? readNumber(end ?? {}, 'endedAt') ?? null,
    result: run.result ?? (readString(end ?? {}, 'result') as RunResult | undefined) ?? null,
    turns,
    partial: replay.partial,
    timeline,
    deployment: {
      firstCommanderCastTurn: replay.commander.firstCastTurn,
      cumulativeMv,
      avgMvPerTurn: turns > 0 ? running / turns : 0,
      landsByTurn,
    },
    wipes: replay.wipes,
    commander: replay.commander,
    answers: {
      byType,
      total,
      rate: terminal > 0 ? total.responded / terminal : null,
      namedRate: total.nameable > 0 ? total.named / total.nameable : null,
    },
    hazards,
    seats: SEAT_IDS.map((id) => replay.seats.get(id) ?? emptySeatOutcome(id)),
    clock: replay.clock,
    keep: replay.keep,
    events,
  };
}

/**
 * The zones the log says every card ended in. Exposed alongside `scoreRun` so a
 * caller (the run detail view, or the verification script) can show — or check —
 * the board the replay reconstructed, without re-deriving it.
 */
export function replayZones(run: RunRecord, options?: ScoreOptions): Record<ZoneId, string[]> {
  const { zones } = replayRun(run, options);
  const out = {} as Record<ZoneId, string[]>;
  for (const zone of ZONES) out[zone] = [];
  for (const [iid, zone] of zones) out[zone].push(iid);
  return out;
}

// ---------------------------------------------------------------------------
// Aggregation across runs
// ---------------------------------------------------------------------------

export interface DeckProfile {
  deckId: string;
  runs: number;
  wins: number;
  losses: number;
  concedes: number;
  winRate: number | null;
  avgTurns: number | null;
  avgFirstCommanderCast: number | null;
  avgMvPerTurn: number | null;
  wipesFaced: number;
  /** Over wipes that actually resolved and were rebuilt from. */
  avgTurnsToRecover: number | null;
  /** Wipes never recovered from / wipes that actually resolved. */
  unrecoveredWipeRate: number | null;
  avgCommanderDowntime: number | null;
  /** Pooled across runs, not an average of per-run rates. */
  answerRate: number | null;
  /**
   * Of the answers that could have named a card across those runs, the share
   * that did. Pooled the same way, and past the paid taxes for the same reason
   * `AnswerRate.namedRate` is. A deck answering often but naming rarely is a
   * deck whose pilot is claiming, not holding up — which is a reading about the
   * run, not about the list, so it earns no tag.
   */
  namedAnswerRate: number | null;
  clocksFaced: number;
  clocksBeaten: number;
  /** Hate pieces the pod offered across those runs, answered on the stack or not. */
  hateFaced: number;
  /** Of those, the ones the player let resolve — the pieces that actually stood. */
  hateStood: number;
  /**
   * Removed / stood, pooled across runs, null when nothing ever stood. Read
   * against what stood rather than what was faced: a piece answered on the stack
   * never needed removing, and counting it here would credit the deck twice for
   * one counterspell.
   */
  hateRemovedRate: number | null;
  mulliganRate: number | null;
  avgLandsInKeep: number | null;
  /** Short human-readable tags from the thresholds in `src/data/scorecard.ts`. */
  tags: string[];
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Roll a set of scorecards into one deck profile. Averages skip runs that have
 * nothing to say (a commander never cast contributes no cast turn) rather than
 * counting them as zero, which would quietly flatter every metric.
 */
export function aggregateProfile(cards: Scorecard[]): DeckProfile {
  const runs = cards.length;
  const wins = cards.filter((c) => c.result === 'win').length;
  const losses = cards.filter((c) => c.result === 'loss').length;
  const concedes = cards.filter((c) => c.result === 'concede').length;

  // Negated wraths are not "faced and rebuilt from" — they were answered, so
  // they say nothing about recovery. They still count as wipes faced.
  const allWipes = cards.flatMap((c) => c.wipes);
  const landedWipes = allWipes.filter((w) => !w.negated);
  const recovered = landedWipes.filter((w) => w.turnsToRecover !== null);

  const responded = cards.reduce((n, c) => n + c.answers.total.responded, 0);
  const resolved = cards.reduce((n, c) => n + c.answers.total.resolved, 0);
  const named = cards.reduce((n, c) => n + c.answers.total.named, 0);
  // Pooled the same way `named` is, and against the same denominator the
  // per-run rate uses: paid taxes are answers that could name nothing.
  const nameable = cards.reduce((n, c) => n + c.answers.total.nameable, 0);

  const clocksFaced = cards.filter((c) => c.clock.faced).length;
  const clocksBeaten = cards.filter((c) => c.clock.beatClock).length;

  // Pooled, like the answer rate: three runs that each stood one piece are three
  // pieces, not three rates averaged into a number no run ever produced. Cards
  // scored before hate pieces existed carry no `hazards` at all.
  const hateFaced = cards.reduce((n, c) => n + (c.hazards?.faced ?? 0), 0);
  const hateStood = cards.reduce((n, c) => n + (c.hazards?.stood ?? 0), 0);
  const hateRemoved = cards.reduce((n, c) => n + (c.hazards?.removed ?? 0), 0);

  const profile: DeckProfile = {
    deckId: cards[0]?.deckId ?? '',
    runs,
    wins,
    losses,
    concedes,
    winRate: runs > 0 ? wins / runs : null,
    avgTurns: mean(cards.map((c) => c.turns)),
    avgFirstCommanderCast: mean(
      cards
        .map((c) => c.deployment.firstCommanderCastTurn)
        .filter((t): t is number => t !== null),
    ),
    avgMvPerTurn: mean(cards.map((c) => c.deployment.avgMvPerTurn)),
    wipesFaced: allWipes.length,
    avgTurnsToRecover: mean(recovered.map((w) => w.turnsToRecover as number)),
    unrecoveredWipeRate:
      landedWipes.length > 0
        ? (landedWipes.length - recovered.length) / landedWipes.length
        : null,
    avgCommanderDowntime: mean(cards.map((c) => c.commander.downtimeTurns)),
    answerRate: responded + resolved > 0 ? responded / (responded + resolved) : null,
    namedAnswerRate: nameable > 0 ? named / nameable : null,
    clocksFaced,
    clocksBeaten,
    hateFaced,
    hateStood,
    hateRemovedRate: hateStood > 0 ? hateRemoved / hateStood : null,
    mulliganRate: runs > 0 ? cards.filter((c) => c.keep.mulligans > 0).length / runs : null,
    avgLandsInKeep: mean(cards.map((c) => c.keep.landsInKeptHand)),
    tags: [],
  };

  profile.tags = tagsFor(profile);
  return profile;
}

/** The reading of a profile in words. One run is a story, not a tendency. */
function tagsFor(p: DeckProfile): string[] {
  const t = SCORING.tags;
  const label = SCORING.tagLabels;
  if (p.runs < t.minRuns) return [];

  const tags: string[] = [];
  const firstCast = p.avgFirstCommanderCast;
  const mvPerTurn = p.avgMvPerTurn;

  if (
    (firstCast !== null && firstCast <= t.fastFirstCastTurn) ||
    (mvPerTurn !== null && mvPerTurn >= t.fastMvPerTurn)
  ) {
    tags.push(label.fast);
  }
  if (firstCast !== null && firstCast >= t.slowFirstCastTurn) tags.push(label.slow);

  const unrecovered = p.unrecoveredWipeRate;
  const recover = p.avgTurnsToRecover;
  if (
    (unrecovered !== null && unrecovered >= t.brittleUnrecoveredRate) ||
    (recover !== null && recover >= t.brittleTurnsToRecover)
  ) {
    tags.push(label.brittle);
  }
  if (
    p.wipesFaced >= t.resilientMinWipes &&
    recover !== null &&
    recover <= t.resilientTurnsToRecover &&
    unrecovered !== null &&
    unrecovered <= t.resilientUnrecoveredRate
  ) {
    tags.push(label.resilient);
  }

  if (p.avgCommanderDowntime !== null && p.avgCommanderDowntime >= t.commanderDowntimeTurns) {
    tags.push(label.commanderDependent);
  }
  if (p.clocksFaced >= t.clockMinFaced && p.clocksBeaten / p.clocksFaced <= t.clockBeatenShare) {
    tags.push(label.losesToClock);
  }
  if (p.answerRate !== null && p.answerRate >= t.interactiveAnswerRate) {
    tags.push(label.interactive);
  }
  if (p.mulliganRate !== null && p.mulliganRate >= t.mulliganRate) {
    tags.push(label.mulligansOften);
  }
  // A deck that keeps letting pieces land and then leaves them there. It is a
  // reading about the list — no answers for a Blood Moon is a decklist fact, not
  // a piloting one — which is what earns it a tag rather than a verdict line.
  if (
    p.hateStood >= t.hateMinStood &&
    p.hateRemovedRate !== null &&
    p.hateRemovedRate < t.hateRemovedRate
  ) {
    tags.push(label.letsHateStand);
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Same-seed A/B comparison
// ---------------------------------------------------------------------------

export interface MetricDelta {
  key: string;
  label: string;
  a: number | null;
  b: number | null;
  delta: number | null;
  /** true when higher is better for this metric */
  higherIsBetter: boolean;
}

export interface Comparison {
  sameSeed: boolean;
  sameBracket: boolean;
  a: Scorecard;
  b: Scorecard;
  metrics: MetricDelta[];
}

function resultScore(card: Scorecard): number {
  return card.result === 'win' ? 1 : 0;
}

function firstWipeRecovery(card: Scorecard): number | null {
  return card.wipes[0]?.turnsToRecover ?? null;
}

function totalDamage(card: Scorecard): number {
  return card.seats.reduce((sum, seat) => sum + seat.damageDealt, 0);
}

/**
 * Removed / stood for one run, null when nothing stood — the same reading
 * `DeckProfile.hateRemovedRate` pools. A run that faced no hate piece has no
 * opinion about hate pieces, and the comparison prints that as n/a rather than
 * as a zero the other column can beat.
 */
function hateRemovedRate(card: Scorecard): number | null {
  const hazards = card.hazards;
  if (!hazards || hazards.stood === 0) return null;
  return hazards.removed / hazards.stood;
}

function seatsEliminated(card: Scorecard): number {
  return card.seats.filter((seat) => seat.eliminatedTurn !== null).length;
}

/**
 * Two runs side by side. Meant for the same seed — same shuffle, same pressure
 * rolls, so the only variable left is how the deck was piloted (or what changed
 * in the list). `sameSeed` says whether that assumption actually holds; a
 * comparison across seeds is still computed, it just proves less.
 */
export function compareScorecards(a: Scorecard, b: Scorecard): Comparison {
  const metrics: MetricDelta[] = [
    metric('result', 'Result (win = 1)', resultScore(a), resultScore(b), true),
    metric('turns', 'Turns', a.turns, b.turns, false),
    metric(
      'firstCommanderCast',
      'First commander cast',
      a.deployment.firstCommanderCastTurn,
      b.deployment.firstCommanderCastTurn,
      false,
    ),
    metric(
      'avgMvPerTurn',
      'Mana value deployed per turn',
      a.deployment.avgMvPerTurn,
      b.deployment.avgMvPerTurn,
      true,
    ),
    metric(
      'turnsToRecover',
      'Turns to rebuild after the first wrath',
      firstWipeRecovery(a),
      firstWipeRecovery(b),
      false,
    ),
    metric(
      'commanderDowntime',
      'Turns without the commander',
      a.commander.downtimeTurns,
      b.commander.downtimeTurns,
      false,
    ),
    metric('answerRate', 'Answer rate', a.answers.rate, b.answers.rate, true),
    metric(
      'hateRemovedRate',
      'Hate pieces removed',
      hateRemovedRate(a),
      hateRemovedRate(b),
      true,
    ),
    metric('totalDamage', 'Damage dealt', totalDamage(a), totalDamage(b), true),
    metric('seatsEliminated', 'Seats eliminated', seatsEliminated(a), seatsEliminated(b), true),
    // Coarse convention: a keep with more lands is the more castable keep. It is
    // a description of the opening hand, not a verdict on it.
    metric(
      'landsInKeep',
      'Lands in the kept hand',
      a.keep.landsInKeptHand,
      b.keep.landsInKeptHand,
      true,
    ),
  ];

  return {
    sameSeed: a.seed === b.seed,
    sameBracket: a.bracket === b.bracket,
    a,
    b,
    metrics,
  };
}

function metric(
  key: string,
  label: string,
  a: number | null,
  b: number | null,
  higherIsBetter: boolean,
): MetricDelta {
  return {
    key,
    label,
    a,
    b,
    delta: a !== null && b !== null ? b - a : null,
    higherIsBetter,
  };
}
