import { isLandTypeLine } from '../domain/typeLine';
import type { RosterEntry, RunRecord, ZoneId } from '../domain/types';

/**
 * Per-card performance across every run of a deck.
 *
 * `scorecard.ts` scores one run and `aggregateProfile` rolls those scores into a
 * deck-level tendency. Neither can answer the question a brewer actually holds a
 * decklist open to ask: *which card is not pulling its weight?* That answer is a
 * card-by-card tally, and like everything else here it is derived by replaying
 * the log rather than by reading anything the store stored.
 *
 * The same three rules the scorer works under apply:
 *
 *  - **Zones are derived.** A card's zone at entry N is whatever the entries up
 *    to N say it is. Only roster instances are tracked; tokens have no roster
 *    entry and are not cards a brewer can cut.
 *  - **Card facts come from `run.roster`.** A run without one cannot be counted
 *    at all here — unlike board value there is no name-resolution fallback worth
 *    building, because the roster is also what says *which cards the deck held*,
 *    and a card that was never drawn leaves no trace in the log. Those runs are
 *    reported as `runsSkipped` so the UI can say so out loud.
 *  - **Cards are keyed by name, not by instance.** A deck holds fourteen Forests
 *    and the brewer cuts or keeps "Forest", never instance #37. `runs` therefore
 *    counts runs in which the *name* was in the roster, and the per-instance
 *    tallies (`drawn`, `cast`, ...) are summed over every copy.
 */

export interface CardStat {
  name: string;
  manaValue: number;
  typeLine: string;
  isLand: boolean;
  isCommander: boolean;
  /** Runs of this deck whose roster held the name. */
  runs: number;
  /** Times a copy entered the hand from the library, across those runs. */
  drawn: number;
  /** Times a copy was cast, across those runs. */
  cast: number;
  /**
   * `cast / drawn`, or null when no copy was ever drawn (a commander, or a card
   * the deck never showed). It can exceed 1: a Cyclonic Rift puts the board back
   * in hand, and a card recast from there was cast twice on one draw.
   */
  castRate: number | null;
  /** The turn of the first cast, one entry per run in which it was cast at all. */
  firstCastTurns: number[];
  avgFirstCastTurn: number | null;
  /** Runs that ended with a copy still in hand. At most one per run. */
  stuckAtEnd: number;
  /** Times a copy was swept by a wipe or picked off by targeted removal. */
  removedBySeat: number;
  /** Times a copy was handed over to a resource attack (discarded or sacrificed). */
  discardedOrSacrificed: number;
  /** Times the player named this card as the answer they spent on an event. */
  answeredWith: number;
}

export interface CardStats {
  /** Ordered by name. Callers apply their own ordering with `sortCardStats`. */
  cards: CardStat[];
  runsScored: number;
  /** Runs with no roster. They cannot be counted, and the UI has to say so. */
  runsSkipped: number;
}

// ---------------------------------------------------------------------------
// Payload readers
// ---------------------------------------------------------------------------
// `LogEntry.payload` is `Record<string, unknown>` by design. These narrow
// defensively and never throw, exactly as the scorer's own readers do — they are
// duplicated rather than shared because `scorecard.ts` keeps them private and a
// second replayer must not become a reason to widen that module's surface.

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

function readStringArray(payload: Payload, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function readNumber(payload: Payload, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isTrue(payload: Payload, key: string): boolean {
  return payload[key] === true;
}

function readObject(payload: Payload, key: string): Payload | undefined {
  const value = payload[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Payload)
    : undefined;
}

function readZone(payload: Payload, key: string): ZoneId | undefined {
  const value = readString(payload, key);
  return value !== undefined && (ZONES as string[]).includes(value)
    ? (value as ZoneId)
    : undefined;
}

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

/** One card name's running totals, before the derived ratios are computed. */
interface Acc {
  name: string;
  manaValue: number;
  typeLine: string;
  isLand: boolean;
  isCommander: boolean;
  runs: number;
  drawn: number;
  cast: number;
  firstCastTurns: number[];
  stuckAtEnd: number;
  removedBySeat: number;
  discardedOrSacrificed: number;
  answeredWith: number;
}

function freshAcc(facts: RosterEntry): Acc {
  return {
    name: facts.name,
    manaValue: facts.manaValue,
    typeLine: facts.typeLine,
    isLand: isLandTypeLine(facts.typeLine),
    isCommander: facts.isCommander,
    runs: 0,
    drawn: 0,
    cast: 0,
    firstCastTurns: [],
    stuckAtEnd: 0,
    removedBySeat: 0,
    discardedOrSacrificed: 0,
    answeredWith: 0,
  };
}

/**
 * Walk one run's log and fold it into `accs`.
 *
 * `drawn` counts every entry into the hand *from the library* and then takes
 * back the hands the mulligan rules put back — the whole hand on a mulligan, the
 * bottomed cards on the keep. That leaves exactly "the kept hand, plus every
 * card drawn afterwards", which is the reading a brewer means by "how often did
 * I see it": a card mulliganed away was not a card the run drew. A card the pod
 * bounced back to hand is not counted either — the deck did not show it again,
 * a seat did — which is the one way `cast` can outrun `drawn`.
 *
 * `cast` is the player declaring a spell cast, which the log shows four ways:
 * a move from hand to the battlefield (played straight), a move from hand to the
 * stack tray (declared onto the tray, wherever it ends up), a move out of hand
 * carrying an `answered <eventId>` reason (an instant held up and spent on an
 * event, which lands in the graveyard rather than on the board and would
 * otherwise read as a card the player never cast), or a 'commander'
 * entry carrying a `castNumber`. The tray case is read off the *move* rather
 * than off the tray's own push entry on purpose: a commander cast onto the tray
 * writes both a `castNumber` entry and a push, and the move it writes comes from
 * the command zone, so reading moves counts that cast once instead of twice.
 * A spell a seat countered on its way out of hand never moves and so is not
 * counted — the log says the trip was interrupted, and the card is still in hand.
 */
function foldRun(run: RunRecord, roster: Record<string, RosterEntry>, accs: Map<string, Acc>): void {
  const log = [...run.log].sort((a, b) => a.seq - b.seq);

  // --- the deck this run held ----------------------------------------------
  const nameByIid = new Map<string, string>();
  const seenThisRun = new Set<string>();
  for (const [iid, facts] of Object.entries(roster)) {
    nameByIid.set(iid, facts.name);
    let acc = accs.get(facts.name);
    if (!acc) {
      acc = freshAcc(facts);
      accs.set(facts.name, acc);
    }
    // A name that is somebody's commander in any run is a commander here. The
    // roster's other facts are the same on every copy, so the first wins.
    if (facts.isCommander) acc.isCommander = true;
    if (!seenThisRun.has(facts.name)) {
      seenThisRun.add(facts.name);
      acc.runs += 1;
    }
  }

  function accFor(iid: string): Acc | undefined {
    const name = nameByIid.get(iid);
    return name === undefined ? undefined : accs.get(name);
  }

  // --- zone reconstruction --------------------------------------------------
  const zones = new Map<string, ZoneId>();
  for (const [iid, facts] of Object.entries(roster)) {
    zones.set(iid, facts.isCommander ? 'command' : 'library');
  }

  /** First cast turn per name, within this run only. */
  const firstCast = new Map<string, number>();

  function noteCast(iid: string, turn: number): void {
    const acc = accFor(iid);
    if (!acc) return;
    acc.cast += 1;
    const seen = firstCast.get(acc.name);
    if (seen === undefined || turn < seen) firstCast.set(acc.name, turn);
  }

  function noteDraw(iid: string): void {
    if (zones.get(iid) !== 'library') return;
    const acc = accFor(iid);
    if (acc) acc.drawn += 1;
    zones.set(iid, 'hand');
  }

  /** A card the mulligan rules put back was never drawn by this run. */
  function unDraw(iid: string): void {
    if (zones.get(iid) !== 'hand') return;
    const acc = accFor(iid);
    if (acc) acc.drawn -= 1;
    zones.set(iid, 'library');
  }

  for (const entry of log) {
    const p = entry.payload;

    switch (entry.kind) {
      case 'draw': {
        // The opening hand and every post-mulligan hand are dealt as bare iids;
        // later draws carry names too. Either way the iids are the whole story.
        for (const iid of readStringArray(p, 'iids')) noteDraw(iid);
        break;
      }

      case 'mull': {
        if (p.bottomIids !== undefined) {
          // The keep: the bottomed cards go under the library and are not part
          // of the hand this run actually played with.
          for (const iid of readStringArray(p, 'bottomIids')) unDraw(iid);
        } else {
          // A mulligan: the whole hand goes back.
          for (const [iid, zone] of zones) if (zone === 'hand') unDraw(iid);
        }
        break;
      }

      case 'move': {
        const to = readZone(p, 'to');
        if (!to) break;
        // A card spent to answer an event was cast, wherever it ended up: an
        // instant answers from hand and goes straight to the graveyard, which
        // matches none of the zones below. One condition covers both, so a
        // permanent answering by being played (hand → battlefield) is counted
        // once and not twice.
        const answered = readString(p, 'reason')?.startsWith('answered ') === true;
        const single = readString(p, 'iid');
        // Mills log one entry for the whole batch, with `iids` and no `iid`.
        const moved = single ? [single] : readStringArray(p, 'iids');
        // A token that left the battlefield ceased to exist, so it has no zone
        // to move to. `scorecard.ts` and `review.ts` read the flag the same way;
        // no roster instance ever carries it, so this only keeps the three
        // replayers reading one log by one rule.
        const tokenGone = isTrue(p, 'tokenGone');
        for (const iid of moved) {
          if (tokenGone) {
            zones.delete(iid);
            continue;
          }
          const from = zones.get(iid);
          if (from === undefined || from === to) continue;
          if (from === 'library' && to === 'hand') {
            noteDraw(iid);
            continue;
          }
          if (from === 'hand' && (to === 'battlefield' || to === 'stack' || answered)) {
            noteCast(iid, entry.turn);
          }
          zones.set(iid, to);
        }
        break;
      }

      case 'commander': {
        const iid = readString(p, 'iid');
        if (!iid) break;
        // Only the entry carrying a cast number is a cast. The others are the
        // commander changing zones, or the trip home after a counter resolved.
        if (readNumber(p, 'castNumber') !== undefined) noteCast(iid, entry.turn);
        // A cast that landed says so; a cast still on the stack, or one routed
        // through the tray, leaves the zone change to its own 'move' entry.
        const to = readZone(p, 'to');
        if (to === 'battlefield' && zones.has(iid)) zones.set(iid, to);
        break;
      }

      case 'event': {
        if (!isTrue(p, 'resolved')) break;
        const outcome = readObject(p, 'outcome');
        if (!outcome) break;
        // A wipe names everything it swept; targeted removal names the one card
        // it took. Both are the pod taking a card off the player's board.
        for (const iid of readStringArray(outcome, 'iids')) {
          const acc = accFor(iid);
          if (acc) acc.removedBySeat += 1;
        }
        const targetIid = readString(outcome, 'targetIid');
        if (targetIid) {
          const acc = accFor(targetIid);
          if (acc) acc.removedBySeat += 1;
        }
        const mode = readString(outcome, 'mode');
        const givenIid = readString(outcome, 'iid');
        if (givenIid && (mode === 'discard' || mode === 'sacrifice')) {
          const acc = accFor(givenIid);
          if (acc) acc.discardedOrSacrificed += 1;
        }
        break;
      }

      case 'respond': {
        // The card the player spent to answer the event, when they named one.
        // Optional: runs recorded before the answer was captured have no key
        // here, and zero is the honest reading of those.
        //
        // Only a *bound* answer counts. A refused iid — a spell already on the
        // tray, a card a seat is holding a counter over — is written down with
        // `bound: false` so the log says what was asked for; the card did no
        // work and must not be tallied as if it had.
        if (!isTrue(p, 'bound')) break;
        const answerIid = readString(p, 'answerIid');
        if (!answerIid) break;
        const acc = accFor(answerIid);
        if (acc) acc.answeredWith += 1;
        break;
      }

      default:
        break;
    }
  }

  for (const [name, turn] of firstCast) accs.get(name)?.firstCastTurns.push(turn);

  // Stuck in hand when the music stopped. Counted per run rather than per copy:
  // "three of the fourteen Forests were in hand" is not a finding, "the run
  // ended with a Forest in hand" is, and it reads against `runs`.
  const stranded = new Set<string>();
  for (const [iid, zone] of zones) {
    if (zone !== 'hand') continue;
    const name = nameByIid.get(iid);
    if (name !== undefined) stranded.add(name);
  }
  for (const name of stranded) {
    const acc = accs.get(name);
    if (acc) acc.stuckAtEnd += 1;
  }
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Every card of a deck, tallied across the runs handed in. Pure: the same runs
 * in, the same numbers out, forever.
 */
export function cardStats(runs: RunRecord[]): CardStats {
  const accs = new Map<string, Acc>();
  let runsScored = 0;
  let runsSkipped = 0;

  for (const run of runs) {
    if (!run.roster) {
      runsSkipped += 1;
      continue;
    }
    runsScored += 1;
    foldRun(run, run.roster, accs);
  }

  const cards: CardStat[] = [];
  for (const acc of accs.values()) {
    cards.push({
      name: acc.name,
      manaValue: acc.manaValue,
      typeLine: acc.typeLine,
      isLand: acc.isLand,
      isCommander: acc.isCommander,
      runs: acc.runs,
      drawn: acc.drawn,
      cast: acc.cast,
      castRate: acc.drawn > 0 ? acc.cast / acc.drawn : null,
      firstCastTurns: [...acc.firstCastTurns].sort((a, b) => a - b),
      avgFirstCastTurn: mean(acc.firstCastTurns),
      stuckAtEnd: acc.stuckAtEnd,
      removedBySeat: acc.removedBySeat,
      discardedOrSacrificed: acc.discardedOrSacrificed,
      answeredWith: acc.answeredWith,
    });
  }
  cards.sort((a, b) => a.name.localeCompare(b.name));

  return { cards, runsScored, runsSkipped };
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * What makes a card a cut candidate: seen often enough for the miss to be a
 * tendency rather than one awkward turn, and cast at most half the times it was
 * seen. Lands and the commander are exempt — a land in hand is a land drop
 * waiting its turn, and the commander is not a card anybody is cutting.
 */
export const CUT_CANDIDATE = {
  minDrawn: 2,
  maxCastRate: 0.5,
} as const;

export function isCutCandidate(stat: CardStat): boolean {
  return (
    !stat.isLand &&
    !stat.isCommander &&
    stat.drawn >= CUT_CANDIDATE.minDrawn &&
    stat.castRate !== null &&
    stat.castRate <= CUT_CANDIDATE.maxCastRate
  );
}

export type CardStatSortKey =
  | 'name'
  | 'drawn'
  | 'cast'
  | 'castRate'
  | 'avgFirstCastTurn'
  | 'stuckAtEnd'
  | 'removedBySeat'
  | 'discardedOrSacrificed'
  | 'answeredWith'
  /** The default: what a brewer opened this table to find. */
  | 'cutCandidates';

export type SortDirection = 'asc' | 'desc';

/**
 * A card with nothing to say on a metric sorts last whichever way the column is
 * pointed. "Never drawn" is not "worst" and it is not "best"; putting it at the
 * bottom either way keeps the top of the column the part worth reading.
 */
function compareNullable(a: number | null, b: number | null, direction: SortDirection): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === 'asc' ? a - b : b - a;
}

function compareNumber(a: number, b: number, direction: SortDirection): number {
  return direction === 'asc' ? a - b : b - a;
}

/**
 * The default ordering: cards seen at least `minDrawn` times, least often cast
 * first, ties broken by how often they were still sitting in hand when the run
 * ended. Everything below the draw floor keeps its place underneath, because a
 * card seen once says nothing yet.
 */
function compareCutCandidates(a: CardStat, b: CardStat): number {
  const aRanked = a.drawn >= CUT_CANDIDATE.minDrawn;
  const bRanked = b.drawn >= CUT_CANDIDATE.minDrawn;
  if (aRanked !== bRanked) return aRanked ? -1 : 1;
  if (aRanked) {
    const rate = compareNullable(a.castRate, b.castRate, 'asc');
    if (rate !== 0) return rate;
    if (a.stuckAtEnd !== b.stuckAtEnd) return b.stuckAtEnd - a.stuckAtEnd;
  }
  return a.name.localeCompare(b.name);
}

/** A new array, ordered. Ties always fall back to the name, so the order is total. */
export function sortCardStats(
  stats: CardStat[],
  key: CardStatSortKey,
  direction: SortDirection,
): CardStat[] {
  const out = [...stats];
  if (key === 'cutCandidates') {
    out.sort(compareCutCandidates);
    return direction === 'asc' ? out : out.reverse();
  }
  out.sort((a, b) => {
    let by = 0;
    switch (key) {
      case 'name':
        by = direction === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
        break;
      case 'castRate':
        by = compareNullable(a.castRate, b.castRate, direction);
        break;
      case 'avgFirstCastTurn':
        by = compareNullable(a.avgFirstCastTurn, b.avgFirstCastTurn, direction);
        break;
      default:
        by = compareNumber(a[key], b[key], direction);
        break;
    }
    return by !== 0 ? by : a.name.localeCompare(b.name);
  });
  return out;
}

export interface CutCandidateOptions {
  /** Lands are excluded unless asked for: a land in hand is a land drop, not a miss. */
  includeLands?: boolean;
}

/** The cards worth looking at first, in the order worth looking at them. */
export function cutCandidates(stats: CardStat[], options?: CutCandidateOptions): CardStat[] {
  const pool = options?.includeLands ? stats : stats.filter((stat) => !stat.isLand);
  return sortCardStats(
    pool.filter((stat) => stat.drawn >= CUT_CANDIDATE.minDrawn),
    'cutCandidates',
    'asc',
  );
}
