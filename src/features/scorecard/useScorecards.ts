import { useLiveQuery } from 'dexie-react-hooks';
import { db, getCachedCardsByName, listRuns } from '../../db/db';
import { cardStats } from '../../engine/cardStats';
import type { CardStats } from '../../engine/cardStats';
import { scoreRun } from '../../engine/scorecard';
import type { Scorecard } from '../../engine/scorecard';
import { reviewRun } from '../../engine/review';
import type { Review } from '../../engine/review';
import { REVIEW } from '../../data/review';
import type { CardData, RosterEntry, RunRecord } from '../../domain/types';

/**
 * Scoring is a full replay of a run's log, and `listRuns` hands back every log
 * in the deck — so the deck profile would re-score the whole history on every
 * keystroke without a cache. A persisted run is immutable (nothing writes to
 * `runs` after `endRun`), which makes the run id a sound cache key.
 *
 * The one wrinkle is legacy runs. Those have no `roster`, so their card facts
 * are resolved by name out of the Scryfall cache — an async lookup that may not
 * have landed on the first render. Their cache key therefore carries how many
 * names were resolved, so a card scored with nothing resolved is superseded once
 * the lookup arrives rather than being cached forever as `partial`.
 */
const cache = new Map<string, Scorecard>();

/**
 * The review is a second replay of the same log and is cached the same way, on
 * the same key plus the tuning version — a review produced under one set of
 * thresholds is not the review the current build would produce. It is built
 * here rather than in the panel so it reads the card facts the scorer read: a
 * legacy run's facts arrive by name lookup, and a review that skipped them
 * would flag nothing at all.
 */
const reviews = new Map<string, Review>();

/**
 * Card stats are a third replay, over the whole deck's history at once rather
 * than one run at a time — so the key is the set of runs, not a run. Runs are
 * immutable after `endRun`, so the sorted ids joined are that set: a new run of
 * the deck (or a deleted one) changes the key and nothing else does. The order
 * they arrive in does not, which is why the ids are sorted: `cardStats` folds
 * every run into the same tallies and sorts the result by name.
 *
 * One slot rather than a map, because `cardStats` exposes no per-run fold: a new
 * run replays the whole history whatever we keep, so every superseded set is a
 * dead entry that will never be read again. A map of them would grow by one per
 * run played. The cost is a caller alternating between two decks, who pays one
 * replay per switch — the panel shows one deck at a time.
 *
 * Legacy runs need no fact lookup here. `cardStats` counts only runs that carry
 * a roster and reports the rest as `runsSkipped`, so nothing about this key
 * depends on what the Scryfall cache has resolved yet.
 */
let cardStatsSlot: { key: string; value: CardStats } | null = null;

const NO_CARD_STATS: CardStats = { cards: [], runsScored: 0, runsSkipped: 0 };

function cardStatsCached(runs: RunRecord[]): CardStats {
  const key = runs
    .map((run) => run.id)
    .sort()
    .join('|');
  if (cardStatsSlot?.key === key) return cardStatsSlot.value;
  const value = cardStats(runs);
  cardStatsSlot = { key, value };
  return value;
}

/** Immutable per run, and per how many names resolved while the run is legacy. */
function cacheKey(run: RunRecord, facts: Map<string, RosterEntry> | undefined): string {
  return run.roster ? run.id : `${run.id}::${facts?.size ?? 0}`;
}

/** Names the scorer could use to identify a card, harvested from the whole log. */
function namesInLog(run: RunRecord): string[] {
  const names = new Set<string>();
  for (const entry of run.log) {
    const single = entry.payload.name;
    if (typeof single === 'string') names.add(single);
    for (const key of ['names', 'bottomNames']) {
      const list = entry.payload[key];
      if (!Array.isArray(list)) continue;
      for (const value of list) if (typeof value === 'string') names.add(value);
    }
  }
  return [...names];
}

function toRosterEntry(card: CardData): RosterEntry {
  return {
    scryfallId: card.scryfallId,
    name: card.name,
    manaValue: card.manaValue,
    typeLine: card.typeLine,
    // The cache cannot say which printing was somebody's commander; the log's
    // own `isCommander` flags cover that for the metrics that care.
    isCommander: false,
  };
}

/** Best-effort card facts for every legacy run in `runs`, or undefined if none need them. */
async function factsForLegacy(runs: RunRecord[]): Promise<Map<string, RosterEntry> | undefined> {
  const legacy = runs.filter((run) => !run.roster);
  if (legacy.length === 0) return undefined;
  const names = [...new Set(legacy.flatMap(namesInLog))];
  const cards = await getCachedCardsByName(names);
  return new Map(cards.map((card) => [card.name, toRosterEntry(card)]));
}

function scoreCached(run: RunRecord, facts: Map<string, RosterEntry> | undefined): Scorecard {
  const key = cacheKey(run, facts);
  const hit = cache.get(key);
  if (hit) return hit;
  const card = scoreRun(run, facts ? { factsByName: (name) => facts.get(name) } : undefined);
  cache.set(key, card);
  return card;
}

function reviewCached(
  run: RunRecord,
  card: Scorecard,
  facts: Map<string, RosterEntry> | undefined,
): Review {
  const key = `${cacheKey(run, facts)}::r${REVIEW.version}`;
  const hit = reviews.get(key);
  if (hit) return hit;
  const review = reviewRun(run, card, facts ? { factsByName: (name) => facts.get(name) } : undefined);
  reviews.set(key, review);
  return review;
}

export interface ScoredRun {
  run: RunRecord;
  card: Scorecard;
  review: Review;
}

function scoredRun(run: RunRecord, facts: Map<string, RosterEntry> | undefined): ScoredRun {
  const card = scoreCached(run, facts);
  return { run, card, review: reviewCached(run, card, facts) };
}

/**
 * A scorecard lookup, stamped with the run id it answers for. `useLiveQuery`
 * keeps handing back the previous subscription's value while a new one loads,
 * so without the stamp a caller switching from "no run" to a run would briefly
 * see `null` and mistake it for a deleted run.
 */
export interface ScoredLookup {
  runId: string | null;
  /** `null` when the run is no longer in the database. */
  scored: ScoredRun | null;
}

/**
 * One run's scorecard. `undefined` while loading — callers must also treat a
 * result whose `runId` differs from the one they asked for as still loading.
 */
export function useScorecard(runId: string | null): ScoredLookup | undefined {
  return useLiveQuery(async (): Promise<ScoredLookup> => {
    if (!runId) return { runId, scored: null };
    const run = await db.runs.get(runId);
    if (!run) return { runId, scored: null };
    const facts = await factsForLegacy([run]);
    return { runId, scored: scoredRun(run, facts) };
  }, [runId]);
}

export interface DeckScorecards {
  runs: RunRecord[];
  cards: Scorecard[];
  /**
   * One review per run, in the same order as `cards` — newest first, which is
   * the order `reviewPatterns` quotes its sample line from. They come through
   * the same cache the run detail view reads, so a deck's history is replayed
   * once for its reviews however many surfaces ask for them.
   */
  reviews: Review[];
  /** Per-card tallies across those same runs. */
  cardStats: CardStats;
}

/**
 * Every run of a deck, newest first, with its scorecard, its review and the
 * deck's per-card tallies. `undefined` while loading.
 *
 * The readings come off one subscription on purpose: they are all derived
 * from the same `listRuns(deckId)`, and a second live query for the card table
 * would clone every log of the deck out of IndexedDB a second time on open and
 * again on every write to `runs`.
 *
 * Same stale-value caveat as `useScorecard`: `useLiveQuery` hands back the
 * previous subscription's value until the new one lands, so a caller that can
 * switch decks in place would show the old deck's runs for a frame. The
 * scorecard panel is remounted per run, which resets it — a caller that is not
 * should carry its own stamp the way `ScoredLookup` does.
 */
export function useDeckScorecards(deckId: string | null): DeckScorecards | undefined {
  return useLiveQuery(async (): Promise<DeckScorecards> => {
    if (!deckId) return { runs: [], cards: [], reviews: [], cardStats: NO_CARD_STATS };
    const runs = await listRuns(deckId);
    const facts = await factsForLegacy(runs);
    const cards = runs.map((run) => scoreCached(run, facts));
    return {
      runs,
      cards,
      reviews: runs.map((run, i) => reviewCached(run, cards[i], facts)),
      cardStats: cardStatsCached(runs),
    };
  }, [deckId]);
}
