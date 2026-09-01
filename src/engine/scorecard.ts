import { SCORING } from '../data/scorecard';
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

export const SCORECARD_VERSION = 1;

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
}

export interface AnswerRate {
  byType: Record<EventType, EventTally>;
  total: EventTally;
  /** responded / (responded + resolved), 0..1, null if nothing terminal. */
  rate: number | null;
}

export interface SeatOutcome {
  seatId: SeatId;
  damageDealt: number;
  commanderDamageDealt: number;
  eliminatedTurn: number | null;
  eliminationReason: 'life' | 'commander-damage' | null;
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
  severity: Record<string, number>;
  terminal: 'responded' | 'resolved' | 'unresolved';
  outcome?: Record<string, unknown>;
  note?: string;
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

const ZONES: ZoneId[] = ['library', 'hand', 'battlefield', 'graveyard', 'exile', 'command'];

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

function isLandType(typeLine: string): boolean {
  return /\bLand\b/i.test(typeLine);
}

// ---------------------------------------------------------------------------
// The replay
// ---------------------------------------------------------------------------

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
  const seats = new Map<SeatId, SeatOutcome>(SEAT_IDS.map((id) => [id, emptySeatOutcome(id)]));

  const commander: CommanderStats = {
    firstCastTurn: null,
    casts: 0,
    removals: 0,
    downtimeTurns: 0,
    totalTaxPaid: 0,
    counteredCasts: 0,
  };

  const clock: ClockStats = {
    faced: false,
    spawnedTurn: null,
    deadlineTurn: null,
    outcome: null,
    beatClock: false,
  };
  /** How the last clock left the table, if it did. */
  let clockClearedBy: 'eliminated-seat' | 'declared-interaction' | null = null;
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
          if (isTrue(p, 'countered')) commander.counteredCasts += 1;
        }
        // Only a cast that actually landed moves the card. A countered cast logs
        // `to: 'stack'`, and the follow-up entries (a move, or a second
        // 'commander' entry for the trip back to the command zone) carry the
        // real zone change, so applying anything else here would double-count.
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
        if (amount !== undefined && amount > 0 && !undone.has(entry.seq)) {
          // Commander damage costs life too, and the store logs it only here —
          // so this is the whole hit, not a second helping of a 'life' entry.
          noteDamage(seatId, entry.turn, amount, amount);
        }
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

        if (row.type === 'wipe' && outcome) {
          // The sweep's moves are logged *before* this entry, so the board is
          // already empty here. Add the victims back to recover the "before".
          const swept = readStringArray(outcome, 'iids');
          const lost = swept.reduce((sum, iid) => sum + boardContribution(iid), 0);
          wipes.push({
            eventId: row.eventId,
            turn: entry.turn,
            variant: readString(outcome, 'scope') ?? row.variant ?? 'creatures',
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
        if (readString(p, 'reason') === 'declared-interaction') {
          // No eventId on this one: it answers the clock itself, not a prompt.
          clock.faced = true;
          clockClearedBy = 'declared-interaction';
          clockClearedTurn = entry.turn;
          clock.deadlineTurn = readNumber(p, 'deadlineTurn') ?? clock.deadlineTurn;
          clock.spawnedTurn = readNumber(p, 'spawnedTurn') ?? clock.spawnedTurn;
          break;
        }
        const row = ledgerFor(entry);
        if (!row) break;
        row.terminal = 'responded';
        const note = readString(p, 'note');
        if (note) row.note = note;
        if (row.type === 'wipe') {
          wipes.push({
            eventId: row.eventId,
            turn: entry.turn,
            variant: row.variant ?? 'creatures',
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
  return { offered: 0, responded: 0, resolved: 0, unresolved: 0 };
}

/** A seat that never took a point of damage still gets a row. */
function emptySeatOutcome(seatId: SeatId): SeatOutcome {
  return {
    seatId,
    damageDealt: 0,
    commanderDamageDealt: 0,
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
  }
  const terminal = total.responded + total.resolved;

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
    answers: { byType, total, rate: terminal > 0 ? total.responded / terminal : null },
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
  clocksFaced: number;
  clocksBeaten: number;
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

  const clocksFaced = cards.filter((c) => c.clock.faced).length;
  const clocksBeaten = cards.filter((c) => c.clock.beatClock).length;

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
    clocksFaced,
    clocksBeaten,
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
