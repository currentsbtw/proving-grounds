import { REVIEW } from '../data/review';
import { formatDuration } from '../domain/duration';
import { isLandTypeLine } from '../domain/typeLine';
import type { EventLedgerRow, Scorecard } from './scorecard';
import type { LogEntry, RosterEntry, RunRecord, SeatId, ZoneId } from '../domain/types';

/**
 * The review engine: what the run did right and wrong, read off the log by
 * arithmetic. Pure, like `engine/scorecard.ts` — a `RunRecord` and its
 * `Scorecard` in, a fixed list of findings out, forever.
 *
 * A rules engine is a hard non-goal (PRODUCT.md), and that is the whole shape of
 * this file. Every finding here is a count of mana, cards or turns:
 *
 *  - **Never legality.** "Four untapped lands and a two-drop in hand" is a fact
 *    about counts. Whether that two-drop was castable is a colour question, a
 *    timing question and a rules question, none of which the log can answer.
 *    Findings say so in their own copy, and the review carries a footer saying
 *    it once more.
 *  - **Never blame.** The wording stops at what happened. "Could have" is the
 *    strongest form used.
 *  - **Evidence or silence.** Every finding carries the `seq` numbers of the log
 *    entries it was derived from, so the UI can show the player the entries
 *    rather than asking them to trust a sentence.
 *
 * The replay is a second, narrower pass over the same log the scorer walks. It
 * is not shared with `scoreRun`: the scorer tracks board value and never needs
 * to know what sat in hand or which lands were untapped, and this needs both.
 * What is *not* re-derived is anything the scorecard already computed — wipes,
 * per-turn deployment, per-seat damage and the commander's first cast turn come
 * off the card. The pod findings follow the same split: the arithmetic is the
 * card's `timeline[].damageBySeat` and its event ledger, and the log is read
 * only for what the card does not carry — which seat held the clock, what threat
 * each seat was showing, and the `seq` numbers to point at.
 */

export type FindingKind = 'miss' | 'good' | 'note';

export type FindingCode =
  | 'land-drop'
  | 'mana-left'
  | 'stuck-hand'
  | 'commander-late'
  | 'overextended'
  | 'hate-stood'
  | 'wrong-seat'
  | 'clock-ignored'
  | 'fed-counters'
  | 'seat-unchecked'
  | 'over-clock'
  | 'land-drops-hit'
  | 'commander-on-time'
  | 'fast-rebuild'
  | 'answered-under-pressure'
  | 'clock-beaten'
  | 'clock-answered-with-damage'
  | 'hate-removed-fast';

export interface ReviewFinding {
  /** Stable within one review, so the UI can key rows without an index. */
  id: string;
  code: FindingCode;
  kind: FindingKind;
  /** Every turn the finding is about, ascending. Empty when it spans the run. */
  turns: number[];
  title: string;
  detail: string;
  /** `seq` of every log entry this was derived from, ascending and unique. */
  evidence: number[];
  /** Ranking weight, comparable only against other findings of the same kind. */
  impact: number;
}

export interface Review {
  version: number;
  runId: string;
  findings: ReviewFinding[];
  /** The honest-limits line. Printed under the list, not as a finding. */
  footer: string;
}

export interface ReviewOptions {
  /** Legacy runs without a roster: resolve card facts by display name. */
  factsByName?: (name: string) => RosterEntry | undefined;
}

// ---------------------------------------------------------------------------
// Payload readers
// ---------------------------------------------------------------------------
// `LogEntry.payload` is a forward-compatible bag. Everything below narrows
// defensively and never throws, exactly as the scorer's readers do.

type Payload = Record<string, unknown>;

const ZONES: ZoneId[] = [
  'library',
  'hand',
  'battlefield',
  'graveyard',
  'exile',
  'command',
  'stack',
];

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

function readZone(payload: Payload, key: string): ZoneId | undefined {
  const value = readString(payload, key);
  return value !== undefined && (ZONES as string[]).includes(value) ? (value as ZoneId) : undefined;
}

function hasObject(payload: Payload, key: string): boolean {
  const value = payload[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readObject(payload: Payload, key: string): Payload | undefined {
  return hasObject(payload, key) ? (payload[key] as Payload) : undefined;
}

/**
 * Front face only, so the replay classifies a card exactly as the table did
 * while it was being played — a `Sorcery // Land` is a spell in both readings.
 */
function isLandType(typeLine: string): boolean {
  return isLandTypeLine(typeLine);
}

// ---------------------------------------------------------------------------
// The replay
// ---------------------------------------------------------------------------

/** What the table looked like as one turn ended. */
interface TurnSnapshot {
  turn: number;
  /** `seq` of the entry that closed the turn — the evidence for the snapshot. */
  seq: number;
  handIids: string[];
  /** Lands on the battlefield. */
  lands: number;
  /** Of those, how many were untapped. */
  untappedLands: number;
}

/**
 * One hate piece's life on the table, gathered as the log goes past. The
 * scorecard counts the same spans; this keeps the card's name and the `seq` of
 * every entry involved, which is what a finding has to be able to point at.
 */
interface HazardSpan {
  hazardId: string;
  seatId: string;
  card: string;
  spawnedTurn: number;
  /** Turn it left the table, or null while it is still standing. */
  endTurn: number | null;
  /** How it left. `null` while it stands; 'retired' is a seat dying with it. */
  fate: 'removed' | 'swept' | 'retired' | null;
  /** The card the player named removing it, when they named one. */
  removedWith: string | null;
  seqs: number[];
}

/**
 * One opponent window, as the log wrote it down. The pod's own numbers live
 * nowhere else: the scorecard keeps what the seats *did*, and this keeps what
 * they were showing while they did it.
 */
interface WindowRow {
  /** The player turn the window sat immediately before. */
  turn: number;
  seq: number;
  /** Threat per seat as the window closed. Empty on a log that wrote none. */
  threatBySeat: Map<string, number>;
}

/** A turn the player spent longer over than the shot clock allowed. */
interface OvertimeTurn {
  /** The turn that ran long — the one the timing was recorded against. */
  turn: number;
  /** Wall-clock seconds it took, as the store rounded them. */
  seconds: number;
  seq: number;
}

interface Replay {
  /** Indexed by turn, 1-based; index 0 is unused. Sparse only before turn 1. */
  snapshots: (TurnSnapshot | undefined)[];
  lastTurn: number;
  /**
   * Whether `lastTurn` ran to the end of the turn. A run can stop in the middle
   * of one — a concede, lethal damage in combat, the auto-end at life 0 — and
   * the land drop and the mana are still that turn's to spend, so nothing about
   * it can be graded.
   */
  lastTurnFinished: boolean;
  /** Per turn: `seq` of every land that entered the battlefield from hand. */
  landDropSeqs: Map<number, number[]>;
  /** Per turn: `seq` of every nonland that entered the battlefield. */
  deploySeqs: Map<number, number[]>;
  /** `seq` of the entry that last put each iid into hand. */
  handEntrySeq: Map<string, number>;
  /** Turns a counter was armed or a resource tax was in front of the player. */
  taxedTurns: Set<number>;
  /** Per turn: `seq` of every event the player answered on the table. */
  respondSeqs: Map<number, number[]>;
  /** Turn a resolved (not negated) wipe landed on, to its event entry `seq`. */
  wipeSeqs: Map<number, number>;
  /** Every hate piece that stood, in the order the pieces landed. */
  hazards: HazardSpan[];
  /** Every opponent window, in the order they resolved. */
  windows: WindowRow[];
  /** Per turn: the `seq` of the window that ran immediately before it. */
  windowSeqByTurn: Map<number, number>;
  /** Per turn: the seat holding the race clock through it, when one held it. */
  clockOwnerByTurn: Map<number, string>;
  /**
   * Per turn, then per seat: `seq` of every entry that took life off that seat.
   * Evidence only. Bucketed by seat rather than kept as one list per turn
   * because the clock findings are each about one seat: "nothing was sent at it"
   * pointing at the hits on the other two seats is not evidence of anything.
   */
  damageSeqsBySeat: Map<number, Map<SeatId, number[]>>;
  /** Per event id: `seq` of every entry that event wrote. */
  eventSeqs: Map<string, number[]>;
  /** Turns the player declared held interaction against a clock, to their `seq`. */
  interactionSeqs: Map<number, number>;
  /** `seq` of the first entry that put a commander on the battlefield. */
  firstCommanderSeq: number | null;
  /** Printed mana value of the cheapest commander in the roster. */
  commanderMv: number | null;
  /** The shot clock the run was started under, in seconds, or null for none. */
  shotClockSeconds: number | null;
  /** Turns the 'turn' entries flagged as over that clock, in the order they ran. */
  overtimeTurns: OvertimeTurn[];
  factsFor: (iid: string) => RosterEntry | null;
}

function replayForReview(run: RunRecord, options?: ReviewOptions): Replay {
  // `appendLog` stamps `seq` from the log's own length, so the log is already in
  // seq order and a sorted copy of it would only be the same array again.
  const log = run.log;
  const roster = run.roster;
  const factsByName = options?.factsByName;

  // Names are indexed up front for the same reason the scorer does it: a legacy
  // run's opening hand is logged as bare iids, and the only place those cards
  // are ever named is some later entry that moved or drew them.
  const nameByIid = new Map<string, string>();
  const tokenIids = new Set<string>();
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
    if (entry.kind === 'token') for (const id of iids) tokenIids.add(id);
  }

  const factCache = new Map<string, RosterEntry | null>();

  /**
   * Card facts for an iid. A token has none worth reviewing (mana value 0, and
   * it was never in hand), and a card nothing can price is simply left out of
   * every count — a review that guessed would be worse than a shorter one.
   */
  function factsFor(iid: string): RosterEntry | null {
    if (tokenIids.has(iid)) return null;
    const cached = factCache.get(iid);
    if (cached !== undefined) return cached;
    let facts = roster?.[iid];
    if (!facts) {
      const name = nameByIid.get(iid);
      if (name && factsByName) facts = factsByName(name);
    }
    const resolved = facts ?? null;
    factCache.set(iid, resolved);
    return resolved;
  }

  function isLand(iid: string): boolean {
    const facts = factsFor(iid);
    return facts !== null && isLandType(facts.typeLine);
  }

  let commanderMv: number | null = null;
  if (roster) {
    for (const facts of Object.values(roster)) {
      if (!facts.isCommander) continue;
      // Partners: the cheaper half is the one the land count reaches first.
      commanderMv = commanderMv === null ? facts.manaValue : Math.min(commanderMv, facts.manaValue);
    }
  }

  const zones = new Map<string, ZoneId>();
  if (roster) {
    for (const [iid, facts] of Object.entries(roster)) {
      zones.set(iid, facts.isCommander ? 'command' : 'library');
    }
  }
  const tapped = new Set<string>();

  const snapshots: (TurnSnapshot | undefined)[] = [];
  const landDropSeqs = new Map<number, number[]>();
  const deploySeqs = new Map<number, number[]>();
  const handEntrySeq = new Map<string, number>();
  // Two sources of tax, kept apart because either can be taken back by a seat
  // dying. Events are held by id, not as a bare turn, because an event is logged
  // more than once — queued, activated, resolved — and the entry that cancels it
  // has to be able to undo what the earlier ones added, exactly as the scorer
  // drops a canceled event from its ledger.
  const taxTurnByEvent = new Map<string, number>();
  const windowTaxedTurns = new Set<number>();
  let armedWindowTurn: number | null = null;
  const respondSeqs = new Map<number, number[]>();
  const wipeSeqs = new Map<number, number>();
  const hazardById = new Map<string, HazardSpan>();
  const windows: WindowRow[] = [];
  const windowSeqByTurn = new Map<number, number>();
  const clockOwnerByTurn = new Map<number, string>();
  const damageSeqsBySeat = new Map<number, Map<SeatId, number[]>>();
  const eventSeqs = new Map<string, number[]>();
  const interactionSeqs = new Map<number, number>();
  let shotClockSeconds: number | null = null;
  const overtimeTurns: OvertimeTurn[] = [];
  // A life change some later entry took back never happened, exactly as the
  // scorer reads it — so it is not evidence of damage either.
  const undone = new Set<number>();
  for (const entry of log) {
    const of = readNumber(entry.payload, 'undoOf');
    if (of !== undefined) undone.add(of);
  }
  let firstCommanderSeq: number | null = null;
  let lastTurn = 1;
  let lastSeq = 0;
  /** Turns closed out by a following `turn` entry, so their snapshot is complete. */
  const closedTurns = new Set<number>();
  /** Phase the run's own end entry was written in, `null` for a record with none. */
  let endPhase: string | null = null;

  /** Append a `seq` to a bucket, keyed by turn or by event id. */
  function push<K>(map: Map<K, number[]>, key: K, seq: number): void {
    const list = map.get(key);
    if (list) list.push(seq);
    else map.set(key, [seq]);
  }

  /** The same, one level deeper: a hit on one seat, on one turn. */
  function pushDamage(turn: number, seatId: SeatId, seq: number): void {
    let bySeat = damageSeqsBySeat.get(turn);
    if (!bySeat) {
      bySeat = new Map();
      damageSeqsBySeat.set(turn, bySeat);
    }
    push(bySeat, seatId, seq);
  }

  function takeSnapshot(turn: number, seq: number): void {
    if (turn < 1) return;
    const handIids: string[] = [];
    let lands = 0;
    let untappedLands = 0;
    for (const [iid, zone] of zones) {
      if (zone === 'hand') handIids.push(iid);
      else if (zone === 'battlefield' && isLand(iid)) {
        lands += 1;
        if (!tapped.has(iid)) untappedLands += 1;
      }
    }
    snapshots[turn] = { turn, seq, handIids, lands, untappedLands };
  }

  function enter(iid: string, to: ZoneId, entry: LogEntry, from: ZoneId | undefined): void {
    const prev = zones.get(iid);
    if (prev === to) return;
    if (to === 'battlefield') {
      // The store logs `tapped: true` only when a permanent arrives tapped; a
      // card leaving the battlefield is untapped by the store on the way out.
      if (isTrue(entry.payload, 'tapped')) tapped.add(iid);
      else tapped.delete(iid);
      if (isLand(iid)) {
        // Only a land coming out of hand is a land drop. Returning one from the
        // graveyard is not the drop the turn was owed.
        if ((from ?? prev) === 'hand') push(landDropSeqs, entry.turn, entry.seq);
      } else if (factsFor(iid)) {
        push(deploySeqs, entry.turn, entry.seq);
      }
    } else {
      tapped.delete(iid);
      if (to === 'hand') handEntrySeq.set(iid, entry.seq);
    }
    zones.set(iid, to);
  }

  for (const entry of log) {
    const p = entry.payload;
    lastTurn = Math.max(lastTurn, entry.turn);
    lastSeq = Math.max(lastSeq, entry.seq);

    switch (entry.kind) {
      case 'draw': {
        for (const iid of readStringArray(p, 'iids')) enter(iid, 'hand', entry, 'library');
        break;
      }

      case 'mull': {
        if (p.bottomIids !== undefined) {
          for (const iid of readStringArray(p, 'bottomIids')) enter(iid, 'library', entry, 'hand');
        } else {
          for (const [iid, zone] of [...zones]) {
            if (zone === 'hand') enter(iid, 'library', entry, 'hand');
          }
        }
        break;
      }

      case 'move': {
        const to = readZone(p, 'to');
        if (!to) break;
        const from = readZone(p, 'from');
        const single = readString(p, 'iid');
        // Mills log one entry for the whole batch, with `iids` and no `iid`.
        const moved = single ? [single] : readStringArray(p, 'iids');
        for (const iid of moved) {
          if (to === 'battlefield' && isTrue(p, 'isCommander') && firstCommanderSeq === null) {
            firstCommanderSeq = entry.seq;
          }
          enter(iid, to, entry, from);
          // A token that left the battlefield ceased to exist. The entry says
          // where it was headed because that is what swept it, but nothing is
          // there afterwards — a bounced Treasure is not a card in hand.
          if (isTrue(p, 'tokenGone')) zones.delete(iid);
        }
        break;
      }

      case 'commander': {
        const iid = readString(p, 'iid');
        // A countered direct cast logs `to: 'stack'` and a cast onto the stack
        // tray logs no `to` at all; only a cast that landed moves the card.
        if (iid && readZone(p, 'to') === 'battlefield') {
          if (firstCommanderSeq === null) firstCommanderSeq = entry.seq;
          enter(iid, 'battlefield', entry, readZone(p, 'from'));
        }
        break;
      }

      case 'token': {
        for (const iid of readStringArray(p, 'iids')) {
          tokenIids.add(iid);
          zones.set(iid, 'battlefield');
        }
        break;
      }

      case 'tap': {
        const iid = readString(p, 'iid');
        if (iid) {
          if (isTrue(p, 'tapped')) tapped.add(iid);
          else tapped.delete(iid);
        } else {
          // The untap step and "Untapped all" are logged as a count with no iid;
          // both untap every permanent on the battlefield.
          tapped.clear();
        }
        break;
      }

      case 'turn': {
        // The entry stamps the turn about to begin, and it is written before the
        // untap step, so this closes out the turn that just ended.
        const previous = readNumber(p, 'previousTurn') ?? entry.turn - 1;
        takeSnapshot(previous, entry.seq);
        if (previous >= 1) closedTurns.add(previous);
        // Timing rides on the same entry, and for the same reason: the turn is
        // only over once the next one begins. The store writes `overtime` only
        // when a clock was on and the turn beat it, so no comparison is redone
        // here — the reading is the one the player watched on the bar.
        if (previous >= 1 && isTrue(p, 'overtime')) {
          overtimeTurns.push({
            turn: previous,
            seconds: readNumber(p, 'previousTurnSeconds') ?? 0,
            seq: entry.seq,
          });
        }
        break;
      }

      case 'window': {
        const beforeTurn = readNumber(p, 'windowBeforeTurn') ?? entry.turn + 1;
        // A seat holding up interaction taxes the turn that is about to begin.
        if (hasObject(p, 'counterArmed')) {
          windowTaxedTurns.add(beforeTurn);
          armedWindowTurn = beforeTurn;
        } else {
          // The window reported nothing held up, so there is no live arm left to
          // take back if a seat dies later.
          armedWindowTurn = null;
        }
        // What the seats were showing going into that turn, and who was holding
        // the race clock over it. Both are written only here.
        const threatBySeat = new Map<string, number>();
        const seated = p.seats;
        if (Array.isArray(seated)) {
          for (const item of seated) {
            if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
            const bag = item as Payload;
            const id = readString(bag, 'id');
            const threat = readNumber(bag, 'threat');
            if (id !== undefined && threat !== undefined) threatBySeat.set(id, threat);
          }
        }
        windows.push({ turn: beforeTurn, seq: entry.seq, threatBySeat });
        windowSeqByTurn.set(beforeTurn, entry.seq);
        const clockPayload = readObject(p, 'clock');
        const clockSeat = clockPayload && readString(clockPayload, 'seatId');
        if (clockSeat) clockOwnerByTurn.set(beforeTurn, clockSeat);
        break;
      }

      case 'life': {
        // Evidence for the damage the scorecard already tallied: the entries the
        // player's own hits were logged as, per turn.
        if (readNumber(p, 'undoOf') !== undefined || undone.has(entry.seq)) break;
        // A hit the seat cannot be named for is dropped rather than filed under
        // the turn at large: unattributed, it could only ever be cited as damage
        // at some seat or other, which is the reading this bucketing exists to
        // stop. The scorer reads the same two keys the same way.
        const seatId = readString(p, 'seatId') ?? readString(p, 'target');
        const delta = readNumber(p, 'delta');
        if (isSeatId(seatId) && delta !== undefined && delta < 0) {
          pushDamage(entry.turn, seatId, entry.seq);
        }
        break;
      }

      case 'damage': {
        // A seat swinging at another seat is not the player's damage, and the
        // scorecard keeps it out of `damageBySeat`; it is not evidence here.
        if (isTrue(p, 'podCombat') || undone.has(entry.seq)) break;
        const reason = readString(p, 'reason');
        if (reason === 'life' || reason === 'commander-damage') break;
        const hitSeat = readString(p, 'seatId');
        if (isSeatId(hitSeat) && (readNumber(p, 'amount') ?? 0) > 0) {
          pushDamage(entry.turn, hitSeat, entry.seq);
        }
        break;
      }

      case 'event': {
        const eventId = readString(p, 'eventId');
        // An event is logged more than once — queued, intercepted, resolved — so
        // its evidence is every entry it wrote, not the first one.
        if (eventId) push(eventSeqs, eventId, entry.seq);
        // A canceled event belonged to a seat that was eliminated before the
        // player was ever asked to answer it. `engine/scorecard.ts` drops it from
        // the ledger for that reason, and a turn cannot be taxed by it either.
        if (isTrue(p, 'canceled')) {
          if (eventId) taxTurnByEvent.delete(eventId);
          break;
        }
        const type = readString(p, 'eventType');
        const turn = readNumber(p, 'eventTurn') ?? entry.turn;
        if (type === 'counter' || (type === 'resource' && readString(p, 'variant') === 'tax')) {
          taxTurnByEvent.set(eventId ?? `seq:${entry.seq}`, turn);
        }
        if (type === 'wipe' && isTrue(p, 'resolved') && !wipeSeqs.has(entry.turn)) {
          wipeSeqs.set(entry.turn, entry.seq);
        }
        // A hate piece the player let through is now standing. Only a resolution
        // that says `standing` makes a piece: the same event answered on the
        // stack resolves nothing onto the table.
        const outcome = readObject(p, 'outcome');
        if (type === 'hate' && isTrue(p, 'resolved') && outcome && isTrue(outcome, 'standing')) {
          const hazardId = readString(outcome, 'hazardId') ?? `hz-${eventId ?? entry.seq}`;
          if (!hazardById.has(hazardId)) {
            hazardById.set(hazardId, {
              hazardId,
              seatId: readString(p, 'seatId') ?? '?',
              card: readString(p, 'card') ?? 'the piece',
              spawnedTurn: entry.turn,
              endTurn: null,
              fate: null,
              removedWith: null,
              seqs: [entry.seq],
            });
          }
        }
        break;
      }

      case 'threat': {
        // A standing piece leaving without the player: swept by a wrath, or
        // retired with the seat that cast it. This entry shares its `canceled` /
        // `seat-eliminated` wording with the dropped-counter entry below, and a
        // hazard id is the only thing that tells them apart — without the guard,
        // a seat dying with a hate piece on the table would hand back a tax the
        // window really did charge.
        const hazardId = readString(p, 'hazardId');
        if (hazardId !== undefined && isTrue(p, 'canceled')) {
          const span = hazardById.get(hazardId);
          if (span && span.endTurn === null) {
            span.endTurn = entry.turn;
            span.fate = readString(p, 'reason') === 'wiped' ? 'swept' : 'retired';
            span.seqs.push(entry.seq);
          }
          break;
        }

        // The seat holding up interaction is out, and the store logs the counter
        // it dropped here rather than in another window entry. The window that
        // armed it taxed a turn nothing was ever held over, so take that back.
        if (
          isTrue(p, 'canceled') &&
          readString(p, 'reason') === 'seat-eliminated' &&
          armedWindowTurn !== null
        ) {
          windowTaxedTurns.delete(armedWindowTurn);
          armedWindowTurn = null;
        }
        break;
      }

      case 'run': {
        // The end entry carries the phase the run stopped in; a run that reached
        // 'end' played its last turn out.
        if (readString(p, 'result') !== undefined) endPhase = entry.phase;
        // The start entry carries the shot clock the run was played under. A
        // record written before the clock existed has none, and the finding
        // below has nothing to say about it.
        else shotClockSeconds = readNumber(p, 'shotClockSeconds') ?? null;
        break;
      }

      case 'respond': {
        // Removing a standing piece is not an answer given on the table: the
        // event it belongs to ended turns ago, and `answered-under-pressure`
        // reads `respondSeqs` as "interaction spent while a question was live".
        // It closes the piece's span instead.
        const hazardId = readString(p, 'hazardId');
        if (readString(p, 'reason') === 'removed-hazard' && hazardId !== undefined) {
          const span = hazardById.get(hazardId);
          if (span && span.endTurn === null) {
            span.endTurn = entry.turn;
            span.fate = 'removed';
            span.removedWith = isTrue(p, 'bound') ? (readString(p, 'answerName') ?? null) : null;
            span.seqs.push(entry.seq);
          }
          break;
        }
        // The one answer aimed at the clock itself rather than at a prompt. It
        // is still interaction spent on the table, so it stays in `respondSeqs`;
        // it is kept apart as well because "nothing was sent at the clock" has
        // to mean nothing at all, declarations included.
        if (readString(p, 'reason') === 'declared-interaction' && !interactionSeqs.has(entry.turn)) {
          interactionSeqs.set(entry.turn, entry.seq);
        }
        push(respondSeqs, entry.turn, entry.seq);
        break;
      }

      default:
        break;
    }
  }

  // The run ends without a following 'turn' entry, so the last turn has to be
  // closed out by hand or it is never snapshotted. The snapshot is taken either
  // way — a partial turn still says what sat in hand — but it only describes a
  // *finished* turn when the run stopped in the end step.
  takeSnapshot(lastTurn, lastSeq);

  return {
    snapshots,
    lastTurn,
    lastTurnFinished: closedTurns.has(lastTurn) || endPhase === 'end',
    landDropSeqs,
    deploySeqs,
    handEntrySeq,
    taxedTurns: new Set([...taxTurnByEvent.values(), ...windowTaxedTurns]),
    respondSeqs,
    wipeSeqs,
    hazards: [...hazardById.values()],
    windows,
    windowSeqByTurn,
    clockOwnerByTurn,
    damageSeqsBySeat,
    eventSeqs,
    interactionSeqs,
    firstCommanderSeq,
    commanderMv,
    shotClockSeconds,
    overtimeTurns,
    factsFor,
  };
}

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------

function turnList(turns: number[]): string {
  return turns.map((t) => `T${t}`).join(', ');
}

/** "T3, T5, T7" up to the cap, then "T3, T5, T7 and 2 more". */
function turnListCapped(turns: number[]): string {
  if (turns.length <= REVIEW.maxTurnsNamed) return turnList(turns);
  const head = turns.slice(0, REVIEW.maxTurnsNamed);
  return `${turnList(head)} and ${turns.length - head.length} more`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

const SEAT_IDS: SeatId[] = ['A', 'B', 'C'];

function isSeatId(value: string | undefined): value is SeatId {
  return value === 'A' || value === 'B' || value === 'C';
}

/** "Seat C", "Seat B and Seat C". */
function seatList(ids: SeatId[]): string {
  if (ids.length === 0) return 'no other seat';
  if (ids.length === 1) return `Seat ${ids[0]}`;
  const head = ids.slice(0, -1).map((id) => `Seat ${id}`);
  return `${head.join(', ')} and Seat ${ids[ids.length - 1]}`;
}

/** The spell a counter event took, when the ledger row says which. */
function counteredName(row: EventLedgerRow): string | null {
  const value = row.outcome?.counteredName;
  return typeof value === 'string' ? value : null;
}

// ---------------------------------------------------------------------------
// The findings
// ---------------------------------------------------------------------------

interface Draft {
  code: FindingCode;
  kind: FindingKind;
  turns: number[];
  title: string;
  detail: string;
  evidence: number[];
  impact: number;
  /** Distinguishes two drafts of the same code (one per stuck card, say). */
  suffix?: string;
}

/**
 * Review one scored run. Pure: the same record and card in, the same findings
 * out, in the same order.
 */
export function reviewRun(run: RunRecord, card: Scorecard, options?: ReviewOptions): Review {
  const replay = replayForReview(run, options);
  const lastTurn = Math.max(card.turns, replay.lastTurn);
  /**
   * The last turn a finding may name. A run that stopped mid-turn still owed
   * that turn its land drop and its mana, so land drops, mana left and the
   * every-drop-hit good stop one turn short of it. Stuck-in-hand still counts
   * the partial turn: a card held into it was held, however the turn ended.
   */
  const gradedThrough = replay.lastTurnFinished ? lastTurn : lastTurn - 1;
  const drafts: Draft[] = [];

  const snapshotAt = (turn: number): TurnSnapshot | undefined => replay.snapshots[turn];

  /** Nonlands in hand at the end of a turn, cheapest first, ties by name. */
  function nonlandsInHand(snap: TurnSnapshot): { iid: string; mv: number; name: string }[] {
    const out: { iid: string; mv: number; name: string }[] = [];
    for (const iid of snap.handIids) {
      const facts = replay.factsFor(iid);
      if (!facts || isLandType(facts.typeLine)) continue;
      out.push({ iid, mv: facts.manaValue, name: facts.name });
    }
    return out.sort((a, b) => a.mv - b.mv || a.name.localeCompare(b.name) || a.iid.localeCompare(b.iid));
  }

  function landsInHand(snap: TurnSnapshot): string[] {
    return snap.handIids.filter((iid) => {
      const facts = replay.factsFor(iid);
      return facts !== null && isLandType(facts.typeLine);
    });
  }

  // --- missed land drops ----------------------------------------------------
  const missedDropTurns: number[] = [];
  const missedDropSeqs: number[] = [];
  for (let turn = 1; turn <= gradedThrough; turn++) {
    const drops = replay.landDropSeqs.get(turn);
    if (drops && drops.length > 0) {
      continue;
    }
    const snap = snapshotAt(turn);
    if (!snap || landsInHand(snap).length === 0) continue;
    missedDropTurns.push(turn);
    missedDropSeqs.push(snap.seq);
  }
  if (missedDropTurns.length > 0) {
    const n = missedDropTurns.length;
    drafts.push({
      code: 'land-drop',
      kind: 'miss',
      turns: missedDropTurns,
      title: n === 1 ? `Missed the land drop on T${missedDropTurns[0]}` : `Missed ${n} land drops`,
      detail:
        n === 1
          ? `A land sat in hand at the end of T${missedDropTurns[0]} with none played.`
          : `${turnListCapped(missedDropTurns)}. A land sat in hand at the end of each with none played.`,
      evidence: missedDropSeqs,
      impact: n * 2,
    });
  }

  // --- mana left on the table -----------------------------------------------
  interface Slack {
    turn: number;
    untapped: number;
    mv: number;
    name: string;
    seq: number;
  }
  const slacks: Slack[] = [];
  for (let turn = Math.max(REVIEW.manaLeft.fromTurn, 1); turn <= gradedThrough; turn++) {
    // A counter held up or a tax in front of the player is a reason to hold
    // mana. Naming those turns would be scoring a decision the log cannot see.
    if (replay.taxedTurns.has(turn)) continue;
    const snap = snapshotAt(turn);
    if (!snap || snap.untappedLands < REVIEW.manaLeft.minUntapped) continue;
    const cheapest = nonlandsInHand(snap)[0];
    if (!cheapest || cheapest.mv > snap.untappedLands) continue;
    slacks.push({
      turn,
      untapped: snap.untappedLands,
      mv: cheapest.mv,
      name: cheapest.name,
      seq: snap.seq,
    });
  }
  if (slacks.length > 0) {
    const worst = slacks.reduce((a, b) =>
      b.untapped - b.mv > a.untapped - a.mv || (b.untapped - b.mv === a.untapped - a.mv && b.turn < a.turn)
        ? b
        : a,
    );
    const others = slacks.filter((s) => s.turn !== worst.turn).map((s) => s.turn);
    const n = slacks.length;
    drafts.push({
      code: 'mana-left',
      kind: 'miss',
      turns: slacks.map((s) => s.turn),
      title:
        n === 1
          ? `Mana left on the table on T${worst.turn}`
          : `Mana left on the table across ${n} turns`,
      detail:
        `T${worst.turn} ended with ${worst.untapped} untapped ${plural(worst.untapped, 'land', 'lands')} and ` +
        `${worst.name} (MV ${worst.mv}) in hand.` +
        (others.length > 0 ? ` Also ${turnListCapped(others)}.` : '') +
        ` ${REVIEW.manaCaveat}`,
      evidence: slacks.map((s) => s.seq),
      impact: slacks.reduce((sum, s) => sum + (s.untapped - s.mv) + 1, 0),
    });
  }

  // --- stuck in hand --------------------------------------------------------
  // A card is "stuck" across one unbroken run of end-of-turn snapshots. Held,
  // played, drawn again and held is two spans, and neither inherits the other's
  // length.
  interface Span {
    iid: string;
    start: number;
    end: number;
    castable: number;
    mv: number;
    name: string;
    seqs: number[];
  }
  const open = new Map<string, Span>();
  const spans: Span[] = [];
  for (let turn = 1; turn <= lastTurn; turn++) {
    const snap = snapshotAt(turn);
    const held = new Set(snap ? nonlandsInHand(snap).map((c) => c.iid) : []);
    for (const [iid, span] of [...open]) {
      if (held.has(iid)) continue;
      spans.push(span);
      open.delete(iid);
    }
    if (!snap) continue;
    for (const entry of nonlandsInHand(snap)) {
      let span = open.get(entry.iid);
      if (!span) {
        const entrySeq = replay.handEntrySeq.get(entry.iid);
        span = {
          iid: entry.iid,
          start: turn,
          end: turn,
          castable: 0,
          mv: entry.mv,
          name: entry.name,
          seqs: entrySeq === undefined ? [] : [entrySeq],
        };
        open.set(entry.iid, span);
      }
      span.end = turn;
      span.seqs.push(snap.seq);
      if (entry.mv <= snap.lands) span.castable += 1;
    }
  }
  for (const span of open.values()) spans.push(span);

  const held = spans
    .filter(
      (s) =>
        s.end - s.start + 1 >= REVIEW.stuckInHand.minTurnsHeld &&
        s.castable >= REVIEW.stuckInHand.minCastableTurns,
    )
    .sort(
      (a, b) =>
        b.end - b.start - (a.end - a.start) ||
        a.start - b.start ||
        a.name.localeCompare(b.name) ||
        a.iid.localeCompare(b.iid),
    );

  // Two copies of the same card held all game is one thing worth saying, not two
  // identical rows. The longest span carries the finding and the rest are a count.
  const byName = new Map<string, Span[]>();
  for (const span of held) {
    const list = byName.get(span.name);
    if (list) list.push(span);
    else byName.set(span.name, [span]);
  }

  for (const [name, copies] of [...byName].slice(0, REVIEW.maxStuckCards)) {
    const span = copies[0];
    const turnsHeld = span.end - span.start + 1;
    const label = copies.length === 1 ? name : `${copies.length} copies of ${name}`;
    drafts.push({
      code: 'stuck-hand',
      kind: 'miss',
      turns: [span.start, span.end],
      title: `${label} sat in hand ${turnsHeld} turns`,
      detail:
        `MV ${span.mv}, held T${span.start} to T${span.end}. The land count covered it on ` +
        `${span.castable} of ${plural(turnsHeld, 'that turn', 'those turns')}. ${REVIEW.manaCaveat}`,
      evidence: copies.flatMap((c) => c.seqs),
      impact: turnsHeld + (copies.length - 1),
      suffix: name,
    });
  }

  // --- commander timing -----------------------------------------------------
  const commanderMv = replay.commanderMv;
  let castableTurn: number | null = null;
  if (commanderMv !== null) {
    for (let turn = 1; turn <= lastTurn; turn++) {
      const snap = snapshotAt(turn);
      // Tax is 0 for a first cast, so the printed mana value is the whole cost.
      if (snap && commanderMv <= snap.lands) {
        castableTurn = turn;
        break;
      }
    }
  }
  const castTurn = card.deployment.firstCommanderCastTurn;
  if (castableTurn !== null && commanderMv !== null) {
    const castableSnap = snapshotAt(castableTurn);
    const evidence = [
      ...(castableSnap ? [castableSnap.seq] : []),
      ...(replay.firstCommanderSeq === null ? [] : [replay.firstCommanderSeq]),
    ];
    const gap = (castTurn ?? lastTurn + 1) - castableTurn;
    if (gap >= REVIEW.commander.lateByTurns) {
      drafts.push({
        code: 'commander-late',
        kind: 'miss',
        turns: castTurn === null ? [castableTurn] : [castableTurn, castTurn],
        title:
          castTurn === null
            ? `Commander never cast, castable from T${castableTurn}`
            : `Commander landed T${castTurn}, castable T${castableTurn}`,
        detail:
          `MV ${commanderMv} against ${castableSnap?.lands ?? commanderMv} lands at the end of T${castableTurn}. ` +
          `Tax is 0 for the first cast. ${REVIEW.manaCaveat}`,
        evidence,
        impact: gap * 2,
      });
    } else if (castTurn === castableTurn) {
      drafts.push({
        code: 'commander-on-time',
        kind: 'good',
        turns: [castTurn],
        title: `Commander cast on the first castable turn`,
        detail: `MV ${commanderMv} on T${castTurn}, the turn the land count reached it.`,
        evidence,
        impact: 3,
      });
    }
  }

  // --- overextended into a wrath --------------------------------------------
  for (const wipe of card.wipes) {
    if (wipe.negated) continue;
    const before = wipe.turn - 1;
    if (before < 1) continue;
    const row = card.timeline[before - 1];
    const snap = snapshotAt(before);
    if (!row || !snap) continue;
    const heldNonlands = nonlandsInHand(snap).length;
    if (
      row.mvDeployed < REVIEW.overextend.minMvDeployed ||
      heldNonlands < REVIEW.overextend.minCardsInHand
    ) {
      continue;
    }
    const wipeSeq = replay.wipeSeqs.get(wipe.turn);
    drafts.push({
      code: 'overextended',
      kind: 'note',
      turns: [before, wipe.turn],
      title: `${row.mvDeployed} MV deployed into the wrath on T${wipe.turn}`,
      detail:
        `T${before} put ${row.mvDeployed} MV on the table with ${heldNonlands} ${plural(heldNonlands, 'nonland', 'nonlands')} ` +
        `still in hand. A table observation, not a rule.`,
      evidence: [
        ...(replay.deploySeqs.get(before) ?? []),
        snap.seq,
        ...(wipeSeq === undefined ? [] : [wipeSeq]),
      ],
      impact: row.mvDeployed,
      suffix: wipe.eventId,
    });
  }

  // --- hate pieces left standing --------------------------------------------
  // A counting finding like every other one here: how long the piece was on the
  // table, and that nothing was ever named against it. It does not say the piece
  // *could* have been removed — that is a colour and a legality question — and a
  // piece a wrath happened to catch still counts, because the player did not
  // deal with it, the pod did.
  for (const span of replay.hazards) {
    const endTurn = span.endTurn ?? lastTurn;
    const stood = Math.max(0, endTurn - span.spawnedTurn);
    if (span.fate === 'removed') continue;
    if (stood < REVIEW.hazard.minTurnsStanding) continue;
    const ending =
      span.fate === 'swept'
        ? `a wrath took it on T${endTurn}`
        : span.fate === 'retired'
          ? `it left with Seat ${span.seatId} on T${endTurn}`
          : `it was still there on T${endTurn}`;
    drafts.push({
      code: 'hate-stood',
      kind: 'miss',
      turns: [span.spawnedTurn, endTurn],
      title: `${span.card} stood ${stood} ${plural(stood, 'turn', 'turns')}`,
      detail: `Seat ${span.seatId} landed it on T${span.spawnedTurn} and ${ending}. No answer was ever named for it.`,
      evidence: span.seqs,
      impact: stood,
      suffix: span.hazardId,
    });
  }

  // --- the race clock, and where the damage went ----------------------------
  // The miss and the good come out of one span because they are one reading:
  // over the turns the clock was live, how much of what the deck dealt reached
  // the seat that was about to win. Damage is the card's, per turn and per seat;
  // the log supplies only the owner and the seqs. Nothing here claims the owner
  // was reachable — evasion, blockers and colours are not counted.
  const clockSpan = (() => {
    const c = card.clock;
    if (!c.faced || c.spawnedTurn === null) return null;
    const from = c.spawnedTurn;
    // The span ends where the clock did, not where its deadline said it would.
    // A clock cleared on T5 with a deadline of T7 was gone for T6 and T7, and
    // damage sent then was not damage sent under it.
    //
    // The clearing turn itself is *inside* the span: the clock stood for the
    // part of that turn before the elimination or the declaration, and the log
    // does not order a turn's hits finely enough to split it. So the choice is
    // the generous one, and it is the same choice everywhere — the miss, the
    // good and the ignored reading all run to the same `to`.
    //
    // `clearedTurn` arrived in scorecard version 5; the type guard is what keeps
    // an older card from turning the whole span into NaN.
    const cleared = typeof c.clearedTurn === 'number' ? c.clearedTurn : null;
    const to = Math.min(c.deadlineTurn ?? lastTurn, lastTurn, cleared ?? Infinity);
    if (to < from) return null;

    let owner: SeatId | null = null;
    for (let turn = from; turn <= to && owner === null; turn++) {
      const seat = replay.clockOwnerByTurn.get(turn);
      if (isSeatId(seat)) owner = seat;
    }
    // Only the window entries say whose clock it was. A log without them (an
    // older run, an imported one) leaves the span unreadable, and a finding
    // about "the wrong seat" that cannot name the right one is not a finding.
    if (owner === null) return null;

    const damage: Record<SeatId, number> = { A: 0, B: 0, C: 0 };
    // Three buckets rather than one, because the three findings below are about
    // three different things and each may only point at its own.
    const windowSeqs: number[] = [];
    const ownerDamageSeqs: number[] = [];
    const offDamageSeqs: number[] = [];
    let interactionSeq: number | null = null;
    for (let turn = from; turn <= to; turn++) {
      const row = card.timeline[turn - 1];
      if (row) for (const id of SEAT_IDS) damage[id] += row.damageBySeat[id] ?? 0;
      const windowSeq = replay.windowSeqByTurn.get(turn);
      if (windowSeq !== undefined) windowSeqs.push(windowSeq);
      for (const [id, seqs] of replay.damageSeqsBySeat.get(turn) ?? []) {
        if (id === owner) ownerDamageSeqs.push(...seqs);
        else offDamageSeqs.push(...seqs);
      }
      const declared = replay.interactionSeqs.get(turn);
      if (declared !== undefined && interactionSeq === null) interactionSeq = declared;
    }
    const off = SEAT_IDS.filter((id) => id !== owner);
    return {
      from,
      to,
      owner,
      damage,
      ownerDamage: damage[owner],
      offDamage: off.reduce((sum, id) => sum + damage[id], 0),
      offSeats: off.filter((id) => damage[id] > 0),
      interactionSeq,
      windowSeqs,
      ownerDamageSeqs,
      offDamageSeqs,
    };
  })();

  if (clockSpan) {
    const { from, to, owner, ownerDamage, offDamage, offSeats } = clockSpan;
    const { windowSeqs, ownerDamageSeqs, offDamageSeqs } = clockSpan;
    const outcome = card.clock.outcome;

    if (outcome === 'expired' && ownerDamage === 0 && clockSpan.interactionSeq === null) {
      drafts.push({
        code: 'clock-ignored',
        kind: 'miss',
        turns: [from, to],
        title: 'Let the clock run out untouched',
        detail:
          `Seat ${owner} spawned the clock on T${from} with a deadline of T${to}. ` +
          `Nothing was sent at it in that span and no interaction was declared.`,
        // The windows the clock ran through, and the owner's own damage — of
        // which the gate above guarantees there is none. It is cited anyway
        // because the citation is defined by the seat the finding is about, not
        // by the gate that happens to keep it empty.
        evidence: [...windowSeqs, ...ownerDamageSeqs],
        impact: 12,
      });
    } else if (
      // A run that was won answered the race, whatever the damage split looked
      // like on the way, and so did one where the owner left the table — by the
      // player's damage or by the interaction they held up for it. Only a clock
      // still standing or already run out can have been raced at the wrong seat.
      // `clock-ignored` wins over this one outright: a clock that ran out is the
      // whole story of the run, not a split of the damage.
      card.result !== 'win' &&
      outcome !== 'won' &&
      outcome !== 'eliminated-seat' &&
      outcome !== 'declared-interaction' &&
      offDamage >= REVIEW.clock.wrongSeatMinDamage
    ) {
      drafts.push({
        code: 'wrong-seat',
        kind: 'miss',
        turns: [from, to],
        title: 'Hit the wrong seat under the clock',
        detail:
          `Seat ${owner} held the clock from T${from}; ${offDamage} damage went to ` +
          `${seatList(offSeats)} in that span, ${ownerDamage} to Seat ${owner}.`,
        evidence: [...offDamageSeqs, ...windowSeqs],
        impact: 9,
      });
    }

    const dealt = ownerDamage + offDamage;
    if (
      outcome === 'eliminated-seat' ||
      (outcome === 'won' && ownerDamage > 0 && ownerDamage * 2 >= dealt)
    ) {
      const seat = card.seats.find((s) => s.seatId === owner);
      const killedTurn = seat?.eliminatedTurn ?? null;
      drafts.push({
        code: 'clock-answered-with-damage',
        kind: 'good',
        turns: [from, to],
        title: `Turned on the clock's owner`,
        detail:
          killedTurn !== null
            ? `Seat ${owner} held the clock from T${from} and was gone by T${killedTurn}.`
            : dealt > 0
              ? `Seat ${owner} held the clock from T${from} and took ${ownerDamage} of the ${dealt} damage dealt in that span.`
              : // A seat the log says was eliminated without recording the hits.
                `Seat ${owner} held the clock from T${from} and did not survive it.`,
        evidence: [...ownerDamageSeqs, ...windowSeqs],
        impact: 6,
      });
    }
  }

  // --- cast into open counters ----------------------------------------------
  // What the seat was showing and what it took, both off the ledger. The log
  // records the counter and the spell, never the hand it was cast out of, so
  // the finding stops at the count and says so.
  const countered = card.events
    .filter((row) => row.type === 'counter' && row.terminal === 'resolved')
    .sort((a, b) => a.turn - b.turn || a.eventId.localeCompare(b.eventId));
  if (countered.length >= REVIEW.counters.minCountered) {
    const counteredTurns = countered.map((row) => row.turn);
    const seats = [...new Set(countered.map((row) => row.seatId))].sort();
    const thresholds = [...new Set(countered.map((row) => row.severity.threshold ?? 0))].sort(
      (a, b) => a - b,
    );
    const names = [...new Set(countered.map(counteredName).filter((n): n is string => n !== null))];
    const shown =
      thresholds.length === 1
        ? `${thresholds[0]}+`
        : `${thresholds[0]}+ to ${thresholds[thresholds.length - 1]}+`;
    drafts.push({
      code: 'fed-counters',
      kind: 'miss',
      turns: counteredTurns,
      title: `Cast into open counters ${countered.length} times`,
      detail:
        `${turnListCapped(counteredTurns)}${names.length > 0 ? ` — ${names.join(', ')}` : ''}. ` +
        `${seats.length === 1 ? `Seat ${seats[0]} was` : 'The seats were'} showing ${shown} mana up ` +
        `${countered.length === 2 ? 'both times' : 'each time'}. ` +
        `The log does not know what else was castable.`,
      evidence: countered.flatMap((row) => replay.eventSeqs.get(row.eventId) ?? []),
      impact: countered.length * 3,
    });
  }

  // --- a seat nobody touched ------------------------------------------------
  // A note, not a miss. A seat left alone may have been the right read — the
  // clock was elsewhere, or its board was the one the deck could not answer —
  // and the log knows only that it was showing a big number and took nothing.
  for (const seatId of SEAT_IDS) {
    const spans: WindowRow[][] = [];
    let current: WindowRow[] = [];
    for (const window of replay.windows) {
      const threat = window.threatBySeat.get(seatId);
      const damage = card.timeline[window.turn - 1]?.damageBySeat[seatId] ?? 0;
      if (threat !== undefined && threat >= REVIEW.threat.uncheckedMin && damage === 0) {
        current.push(window);
        continue;
      }
      if (current.length > 0) spans.push(current);
      current = [];
    }
    if (current.length > 0) spans.push(current);

    const longest = spans
      .filter((span) => span.length >= REVIEW.threat.uncheckedWindows)
      .sort((a, b) => b.length - a.length || a[0].turn - b[0].turn)[0];
    if (!longest) continue;
    const from = longest[0].turn;
    const to = longest[longest.length - 1].turn;
    drafts.push({
      code: 'seat-unchecked',
      kind: 'note',
      turns: [from, to],
      title: `Seat ${seatId} ran away with it`,
      detail:
        `Threat ${REVIEW.threat.uncheckedMin}+ for ${longest.length} windows from T${from} ` +
        `with nothing sent its way.`,
      evidence: longest.map((window) => window.seq),
      impact: longest.length * 2,
      suffix: seatId,
    });
  }

  // --- turns that ran long --------------------------------------------------
  // A note, and never a miss. The shot clock is a drill the player asked for,
  // and a turn that beat it is a fact about the clock rather than a mistake at
  // the table: the log knows how long the turn took and nothing whatever about
  // why. So this names the turns, quotes the worst one against the limit, and
  // stops. The clock never touched the rng, so nothing about the run itself
  // reads differently for having been timed.
  if (
    replay.shotClockSeconds !== null &&
    replay.overtimeTurns.length >= REVIEW.shotClock.minOvertimeTurns
  ) {
    const limit = replay.shotClockSeconds;
    const over = replay.overtimeTurns;
    const worst = over.reduce((a, b) => (b.seconds > a.seconds ? b : a));
    const turns = over.map((t) => t.turn);
    drafts.push({
      code: 'over-clock',
      kind: 'note',
      turns,
      title: `Over the shot clock on ${turnListCapped(turns)}`,
      detail: `Worst T${worst.turn} at ${formatDuration(worst.seconds)} against ${formatDuration(limit)}.`,
      evidence: over.map((t) => t.seq),
      impact: over.length,
    });
  }

  // --- the goods ------------------------------------------------------------
  const through = Math.min(REVIEW.landDrop.goodThroughTurn, gradedThrough);
  let allHit = through >= 1;
  const dropSeqs: number[] = [];
  for (let turn = 1; turn <= through; turn++) {
    const drops = replay.landDropSeqs.get(turn);
    if (!drops || drops.length === 0) {
      allHit = false;
      break;
    }
    dropSeqs.push(drops[0]);
  }
  if (allHit) {
    drafts.push({
      code: 'land-drops-hit',
      kind: 'good',
      turns: [1, through],
      title: `Every land drop hit through T${through}`,
      detail: `A land entered from hand on each of T1 to T${through}.`,
      evidence: dropSeqs,
      impact: 2,
    });
  }

  const fast = card.wipes.find((w) => !w.negated && w.turnsToRecover === 1);
  if (fast) {
    const wipeSeq = replay.wipeSeqs.get(fast.turn);
    drafts.push({
      code: 'fast-rebuild',
      kind: 'good',
      turns: [fast.turn, fast.turn + 1],
      title: `Rebuilt in one turn after the wrath on T${fast.turn}`,
      detail: `The wrath took the board from ${fast.boardValueBefore} MV to ${fast.boardValueAfter}, and T${fast.turn + 1} put most of it back.`,
      evidence: wipeSeq === undefined ? [] : [wipeSeq],
      impact: 4,
    });
  }

  // An answer given while a clock was ticking or a wrath was on the table is the
  // one worth naming: the interaction was spent where it mattered.
  const clock = card.clock;
  for (const [turn, seqs] of [...replay.respondSeqs].sort((a, b) => a[0] - b[0])) {
    const underClock =
      clock.faced &&
      clock.spawnedTurn !== null &&
      turn >= clock.spawnedTurn &&
      (clock.deadlineTurn === null || turn <= clock.deadlineTurn);
    const underWipe = card.wipes.some((w) => w.turn === turn);
    if (!underClock && !underWipe) continue;
    drafts.push({
      code: 'answered-under-pressure',
      kind: 'good',
      turns: [turn],
      title: `Answered on the table on T${turn}`,
      detail: underWipe
        ? `A wrath was in front of you that turn and it was answered, not eaten.`
        : `The race clock was running on T${turn} and an event was answered on the table.`,
      evidence: seqs,
      impact: 3,
      suffix: String(turn),
    });
    break;
  }

  // The other half of the piece: one that did not get to sit there. Removing it
  // inside a turn of it landing is the interaction spent where it mattered, and
  // it is the only hate reading worth crediting — a piece removed on turn nine
  // was still a piece the table played around for eight turns.
  for (const span of replay.hazards) {
    if (span.fate !== 'removed' || span.endTurn === null) continue;
    const stood = Math.max(0, span.endTurn - span.spawnedTurn);
    if (stood > REVIEW.hazard.quickRemovalTurns) continue;
    drafts.push({
      code: 'hate-removed-fast',
      kind: 'good',
      turns: [span.spawnedTurn, span.endTurn],
      title: `Removed ${span.card} ${stood === 0 ? 'the turn it landed' : 'the turn after it landed'}`,
      detail:
        `Seat ${span.seatId} landed it on T${span.spawnedTurn} and it was gone by T${span.endTurn}` +
        `${span.removedWith === null ? '' : `, to ${span.removedWith}`}.`,
      evidence: span.seqs,
      impact: 4,
      suffix: span.hazardId,
    });
  }

  if (clock.faced && clock.beatClock) {
    drafts.push({
      code: 'clock-beaten',
      kind: 'good',
      turns: clock.spawnedTurn === null ? [] : [clock.spawnedTurn],
      title: `Beat the race clock`,
      detail: `Spawned T${clock.spawnedTurn ?? '?'}, deadline T${clock.deadlineTurn ?? '?'}.`,
      evidence: [],
      impact: 5,
    });
  }

  // --- rank and cap ---------------------------------------------------------
  // Misses first, then the table observations, then what went right. Within a
  // kind, by impact; ties break on code and suffix so the order is total and the
  // same review twice is byte-identical.
  function take(kind: FindingKind, limit: number): Draft[] {
    return drafts
      .filter((d) => d.kind === kind)
      .sort(
        (a, b) =>
          b.impact - a.impact ||
          a.code.localeCompare(b.code) ||
          (a.suffix ?? '').localeCompare(b.suffix ?? ''),
      )
      .slice(0, limit);
  }

  const ordered = [
    ...take('miss', REVIEW.maxMisses),
    ...take('note', REVIEW.maxNotes),
    ...take('good', REVIEW.maxGoods),
  ].slice(0, REVIEW.maxFindings);

  return {
    version: REVIEW.version,
    runId: run.id,
    findings: ordered.map((d) => ({
      id: d.suffix ? `${d.code}:${d.suffix}` : d.code,
      code: d.code,
      kind: d.kind,
      turns: uniqueSorted(d.turns),
      title: d.title,
      detail: d.detail,
      evidence: uniqueSorted(d.evidence),
      impact: d.impact,
    })),
    footer: REVIEW.footer,
  };
}

// ---------------------------------------------------------------------------
// Patterns across runs
// ---------------------------------------------------------------------------

/**
 * A finding code that keeps coming back. One run's review says what happened;
 * this says what keeps happening, which is the only reading a deck profile can
 * act on — a missed land drop is a game, four of them in six games is a curve.
 *
 * Deliberately not weighted by impact. A pattern is a count of runs, and
 * comparing "how bad" across runs would need a scale the review does not have.
 */
export interface ReviewPattern {
  code: FindingCode;
  kind: FindingKind;
  /** The generic phrase for the code, not any one run's title. */
  title: string;
  /** Reviews the code appeared in. */
  runs: number;
  /** Reviews looked at. */
  of: number;
  /** The most recent run's line for it, so the pattern still points at a game. */
  sampleDetail: string;
}

/**
 * The generic form of each finding, in the present tense of a deck rather than
 * the past tense of a run. Every code has one, so a new code cannot quietly
 * appear in a profile as an empty string.
 */
const PATTERN_TITLE: Record<FindingCode, string> = {
  'land-drop': 'Misses land drops',
  'mana-left': 'Leaves mana up',
  'stuck-hand': 'Sits on cards in hand',
  'commander-late': 'Commander lands late',
  overextended: 'Deploys into wraths',
  'hate-stood': 'Leaves hate pieces standing',
  'wrong-seat': 'Hits the wrong seat under the clock',
  'clock-ignored': 'Lets the clock run out',
  'fed-counters': 'Casts into open counters',
  'seat-unchecked': 'Leaves a seat unchecked',
  'over-clock': 'Runs over the shot clock',
  'land-drops-hit': 'Hits its land drops',
  'commander-on-time': 'Commander lands on time',
  'fast-rebuild': 'Rebuilds after a wrath',
  'answered-under-pressure': 'Answers under pressure',
  'clock-beaten': 'Beats the race clock',
  'clock-answered-with-damage': "Turns on the clock's owner",
  'hate-removed-fast': 'Removes hate pieces fast',
};

/** Misses first: what keeps going wrong is the reading a brewer acts on. */
const KIND_RANK: Record<FindingKind, number> = { miss: 0, note: 1, good: 2 };

/**
 * Roll a deck's reviews into the codes that recur. Pure, and cheap: it reads the
 * finished reviews, never the logs.
 *
 * `reviews` is expected newest first, the order `useDeckScorecards` hands its
 * runs over in, because `sampleDetail` is the first occurrence found — the most
 * recent run that produced the finding. A caller passing them oldest first gets
 * the same patterns with the oldest line quoted.
 *
 * A review votes once per code however many findings of it it carries: two
 * cards stuck in hand in one game is one game with a hand problem.
 */
export function reviewPatterns(reviews: Review[]): ReviewPattern[] {
  const of = reviews.length;
  if (of < REVIEW.patterns.minRuns) return [];

  const seen = new Map<FindingCode, { kind: FindingKind; runs: number; sampleDetail: string }>();
  for (const review of reviews) {
    const counted = new Set<FindingCode>();
    for (const finding of review.findings) {
      if (counted.has(finding.code)) continue;
      counted.add(finding.code);
      const entry = seen.get(finding.code);
      if (entry) entry.runs += 1;
      else seen.set(finding.code, { kind: finding.kind, runs: 1, sampleDetail: finding.detail });
    }
  }

  return [...seen]
    .filter(
      ([, entry]) =>
        entry.runs >= REVIEW.patterns.minRuns && entry.runs / of >= REVIEW.patterns.minShare,
    )
    .map(([code, entry]) => ({
      code,
      kind: entry.kind,
      title: PATTERN_TITLE[code],
      runs: entry.runs,
      of,
      sampleDetail: entry.sampleDetail,
    }))
    .sort(
      (a, b) =>
        KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.runs - a.runs || a.code.localeCompare(b.code),
    );
}
