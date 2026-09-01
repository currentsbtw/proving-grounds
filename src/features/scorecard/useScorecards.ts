import { useLiveQuery } from 'dexie-react-hooks';
import { db, getCachedCardsByName, listRuns } from '../../db/db';
import { scoreRun } from '../../engine/scorecard';
import type { Scorecard } from '../../engine/scorecard';
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
  const key = run.roster ? run.id : `${run.id}::${facts?.size ?? 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const card = scoreRun(run, facts ? { factsByName: (name) => facts.get(name) } : undefined);
  cache.set(key, card);
  return card;
}

export interface ScoredRun {
  run: RunRecord;
  card: Scorecard;
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
    return { runId, scored: { run, card: scoreCached(run, facts) } };
  }, [runId]);
}

export interface DeckScorecards {
  runs: RunRecord[];
  cards: Scorecard[];
}

/** Every run of a deck, newest first, with its scorecard. `undefined` while loading. */
export function useDeckScorecards(deckId: string | null): DeckScorecards | undefined {
  return useLiveQuery(async () => {
    if (!deckId) return { runs: [], cards: [] };
    const runs = await listRuns(deckId);
    const facts = await factsForLegacy(runs);
    return { runs, cards: runs.map((run) => scoreCached(run, facts)) };
  }, [deckId]);
}
