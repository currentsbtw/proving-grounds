/**
 * Verification harness for the per-card tally in `src/engine/cardStats.ts`.
 *
 * Same shape as `verify-scorecard.ts`, and for the same reason: there is no test
 * framework here, and the thing worth checking is the agreement between two
 * independent derivations of the same game.
 *
 *   1. the **store**, which mutates state directly and writes an append-only log
 *   2. `cardStats`, which reads only that log back and rebuilds each card's story
 *
 * So this drives the real `useGameStore` headlessly through two scripted runs of
 * one synthetic deck (the store neither imports React nor needs a DOM; its Dexie
 * write fails in Node and is caught, which is why the record is captured off a
 * subscription instead of off the database), keeps a state-based tally by card
 * name off a Zustand subscription, and then asserts the log agrees with it.
 *
 *   npm run verify:cardstats [seed]
 *
 * Three deliberate choices in the script:
 *
 *  - It answers exactly one event per run, with an instant out of hand, and
 *    resolves every other one. Resolving is the harsher path and the one
 *    `removedBySeat` is counted off — an answered wipe moves nothing — but the
 *    single answer is what puts the other spend on the table: a card leaving the
 *    hand for the graveyard because it was held up is a card that was cast, and
 *    the card the answer named. Neither reading has any other way in.
 *  - From turn `BOUNCE_TURN` it puts its biggest permanent back in hand and
 *    recasts it. No seed offers that on its own, and without it `castRate` above
 *    100% — a card cast twice on one draw — is a branch nothing ever walks.
 *  - It never calls `declareInteraction`, so a race clock can run out and end
 *    the run early. That is a legitimate outcome, so every loop checks
 *    `store().run` and stops rather than pretending the turn happened.
 *
 * What it then asserts: every per-card tally (`drawn`, `cast`, `firstCastTurns`,
 * `stuckAtEnd`, `removedBySeat`, `discardedOrSacrificed`, `answeredWith`) against
 * the oracle's, that `cast` never outruns what reached the hand, that the bounce
 * really produced a card cast more often than it was drawn, that the tokens the
 * script makes and the wipes sweep never become rows, and that the ordering
 * helpers, the rosterless-run skip and the empty history all behave.
 *
 * Failures are collected rather than thrown one at a time, so a bad run reports
 * everything wrong in a single pass. The process exits non-zero if any failed.
 */
import {
  cardsInZone,
  isLandCard,
  manaValueOf,
  mulliganBottomCount,
  useGameStore,
  type GameState,
} from '../src/state/gameStore.ts';
import {
  cardStats,
  cutCandidates,
  isCutCandidate,
  sortCardStats,
  type CardStat,
} from '../src/engine/cardStats.ts';
import type {
  CardData,
  CardInstance,
  Deck,
  RunRecord,
  RunResult,
  ZoneId,
} from '../src/domain/types.ts';

/**
 * The default seed is deliberate: its two runs offer wraths, targeted removal
 * and a resource attack the script hands a card to, so `removedBySeat` and
 * `discardedOrSacrificed` are both exercised, and each run finds an instant to
 * hold up so `answeredWith` is too. The bounce that puts a permanent back in hand
 * — the one way a card can be cast more often than it was drawn — is not left to
 * the seed: the script performs it, so that reading is checked whatever seed is
 * handed in. Any other seed still checks the store against the log.
 */
const SEED = process.argv[2] ?? 'cardstats-verify-7';
const TURNS = 10;
const BRACKET = 4;
/** The turn from which the script bounces its biggest permanent and recasts it. */
const BOUNCE_TURN = 7;

// ---------------------------------------------------------------------------
// A synthetic 99 + 1 deck
// ---------------------------------------------------------------------------
// Duplicated from `verify-scorecard.ts` on purpose: each harness owns its
// fixture, so tuning one script's deck cannot silently change another's result.

function card(scryfallId: string, name: string, manaValue: number, typeLine: string): CardData {
  return {
    scryfallId,
    name,
    manaCost: manaValue > 0 ? `{${manaValue}}` : '',
    manaValue,
    typeLine,
    oracleText: '',
    colorIdentity: ['G'],
    layout: 'normal',
  };
}

const COMMANDER = card(
  'cmd-warlord',
  'Proving Ground Warlord',
  5,
  'Legendary Creature — Human Warrior',
);

/**
 * The one card in the fixture that goes to the graveyard when it is spent. The
 * script holds it up rather than casting it — at mana value 2 it is never the
 * biggest spell in hand — so every `cast` it is credited with came in as an
 * answer, which is exactly the reading being checked.
 */
const INSTANT = card('spl-volley', 'Grounds Volley', 2, 'Instant');

const DECK_CARDS: { data: CardData; qty: number }[] = [
  { data: card('land-forest', 'Training Forest', 0, 'Basic Land — Forest'), qty: 14 },
  { data: card('land-plain', 'Training Plain', 0, 'Basic Land — Plains'), qty: 12 },
  { data: card('land-gate', 'Proving Gate', 0, 'Land'), qty: 10 },
  { data: INSTANT, qty: 6 },
  { data: card('cr-scout', 'Grounds Scout', 1, 'Creature — Human Scout'), qty: 3 },
  { data: card('cr-warden', 'Grounds Warden', 2, 'Creature — Human Soldier'), qty: 9 },
  { data: card('cr-ranger', 'Grounds Ranger', 3, 'Creature — Elf Ranger'), qty: 9 },
  { data: card('cr-sentinel', 'Grounds Sentinel', 4, 'Creature — Giant Soldier'), qty: 8 },
  { data: card('cr-behemoth', 'Grounds Behemoth', 5, 'Creature — Beast'), qty: 6 },
  { data: card('cr-colossus', 'Grounds Colossus', 6, 'Creature — Golem'), qty: 6 },
  { data: card('cr-titan', 'Grounds Titan', 7, 'Creature — Giant'), qty: 4 },
  { data: card('art-signet', 'Grounds Signet', 2, 'Artifact'), qty: 6 },
  { data: card('art-altar', 'Grounds Altar', 3, 'Artifact'), qty: 6 },
];

const CARD_DATA: Record<string, CardData> = { [COMMANDER.scryfallId]: COMMANDER };
for (const { data } of DECK_CARDS) CARD_DATA[data.scryfallId] = data;

const DECK: Deck = {
  id: 'verify-cardstats-deck',
  name: 'Card Stats Verification',
  commanderIds: [COMMANDER.scryfallId],
  cards: DECK_CARDS.map(({ data, qty }) => ({ scryfallId: data.scryfallId, qty })),
  bracket: BRACKET as Deck['bracket'],
  createdAt: 0,
  updatedAt: 0,
};

const store = () => useGameStore.getState();

// ---------------------------------------------------------------------------
// The independent, state-based oracle
// ---------------------------------------------------------------------------

/**
 * What the script observed by watching the *store*, never the log, keyed by card
 * name exactly as `cardStats` keys it.
 *
 * The zone transitions are read off a Zustand subscription; the two counts that
 * a transition cannot describe on its own are gathered at their call sites:
 *
 *  - **Commander casts.** `state.commanderCasts` is the store's own cast counter
 *    and moves in lockstep with the `castNumber` the log carries — including the
 *    cast a seat counters, which moves no card at all and so shows up in no
 *    transition.
 *  - **Removal by a seat.** A card leaving the battlefield looks the same
 *    whichever hand pushed it, so the wipe and removal resolutions are wrapped
 *    and the board is diffed across the call.
 */
interface Oracle {
  drawn: Map<string, number>;
  cast: Map<string, number>;
  firstCastTurn: Map<string, number>;
  stuckAtEnd: Set<string>;
  removedBySeat: Map<string, number>;
  pitched: Map<string, number>;
  /**
   * Cards that reached the hand from somewhere other than the library — a
   * Cyclonic Rift or an Evacuation putting the board back in hand. `drawn`
   * deliberately does not count those (it is "times the deck showed it to you"),
   * so a bounced card can honestly be cast more often than it was drawn.
   */
  bounced: Map<string, number>;
  /**
   * Cards the script held up as an answer, noted at the call site. A subscription
   * cannot tell an instant spent answering from one binned any other way — both
   * are hand → graveyard — and the reason it was spent is the whole difference.
   */
  answeredWith: Map<string, number>;
  commanderCasts: number;
}

function freshOracle(): Oracle {
  return {
    drawn: new Map(),
    cast: new Map(),
    firstCastTurn: new Map(),
    stuckAtEnd: new Set(),
    removedBySeat: new Map(),
    pitched: new Map(),
    bounced: new Map(),
    answeredWith: new Map(),
    commanderCasts: 0,
  };
}

function bump(map: Map<string, number>, name: string, by = 1): void {
  map.set(name, (map.get(name) ?? 0) + by);
}

/** Merge one run's oracle into the deck-level one. */
function mergeOracles(into: Oracle, from: Oracle): void {
  for (const [name, n] of from.drawn) bump(into.drawn, name, n);
  for (const [name, n] of from.cast) bump(into.cast, name, n);
  for (const [name, n] of from.removedBySeat) bump(into.removedBySeat, name, n);
  for (const [name, n] of from.pitched) bump(into.pitched, name, n);
  for (const [name, n] of from.bounced) bump(into.bounced, name, n);
  for (const [name, n] of from.answeredWith) bump(into.answeredWith, name, n);
  for (const name of from.stuckAtEnd) into.stuckAtEnd.add(name);
  into.commanderCasts += from.commanderCasts;
}

let oracle = freshOracle();
let capturedRun: RunRecord | null = null;
/** Every run's first-cast turns, by name — the shape `CardStat.firstCastTurns` has. */
const firstCastTurns = new Map<string, number[]>();
/** Runs that ended with the name in hand, by name. */
const stuckRuns = new Map<string, number>();

/**
 * Read the capture through a call. The subscription below assigns to it from
 * inside a closure, which the compiler's flow analysis cannot see, so a direct
 * read narrows to `null` and every use of it looks unreachable.
 */
function lastCapturedRun(): RunRecord | null {
  return capturedRun;
}

function cardNameOf(state: GameState, iid: string): string {
  const instance = state.cards[iid];
  if (!instance) return '';
  if (instance.isToken) return instance.tokenSpec?.name ?? 'Token';
  return instance.scryfallId ? (CARD_DATA[instance.scryfallId]?.name ?? '') : '';
}

function totalCommanderCasts(state: GameState): number {
  return Object.values(state.commanderCasts).reduce((a, b) => a + b, 0);
}

function noteCast(name: string, turn: number): void {
  bump(oracle.cast, name);
  const seen = oracle.firstCastTurn.get(name);
  if (seen === undefined || turn < seen) oracle.firstCastTurn.set(name, turn);
}

useGameStore.subscribe((state, prev) => {
  if (state.run) capturedRun = state.run;

  // A commander cast is counted where the store counts it, so a cast a seat
  // answers on the stack is counted here too — nothing moved, but it was cast.
  const casts = totalCommanderCasts(state);
  const before = totalCommanderCasts(prev);
  if (casts > before && state.run) {
    oracle.commanderCasts += casts - before;
    for (const instance of Object.values(state.cards)) {
      if (instance.isCommander) noteCast(cardNameOf(state, instance.iid), state.turn);
    }
  }

  if (state.cards === prev.cards) return;
  const turn = state.turn;
  for (const [iid, next] of Object.entries(state.cards)) {
    const was = prev.cards[iid];
    if (!was || was.zone === next.zone) continue;
    if (next.isToken) continue;
    const name = cardNameOf(state, iid);
    if (!name) continue;

    if (next.zone === 'hand' && was.zone !== 'library') {
      bump(oracle.bounced, name);
    } else if (was.zone === 'library' && next.zone === 'hand') {
      bump(oracle.drawn, name);
    } else if (was.zone === 'hand' && next.zone === 'library') {
      // The mulligan rules putting a hand back: it was never drawn by this run.
      bump(oracle.drawn, name, -1);
    } else if (
      was.zone === 'hand' &&
      (next.zone === 'battlefield' || next.zone === 'stack') &&
      !next.isCommander
    ) {
      noteCast(name, turn);
    }
  }
});

// ---------------------------------------------------------------------------
// The scripted game
// ---------------------------------------------------------------------------

/** Names of the player's non-token cards on the battlefield, by iid. */
function boardIids(state: GameState): Set<string> {
  const out = new Set<string>();
  for (const c of Object.values(state.cards)) {
    if (c.zone === 'battlefield' && !c.isToken) out.add(c.iid);
  }
  return out;
}

/** Whether this run has already spent its one scripted answer. */
let answeredThisRun = false;

/**
 * Resolve whatever is in front of the player, and watch the board across the
 * call so a wipe or a removal can be attributed without reading the log.
 *
 * Almost every event is resolved, because resolving is the path that actually
 * moves cards. The exception is the first wipe, removal or combat of the run
 * that finds an instant in hand: that one is answered with it, so the hand →
 * graveyard spend is on the table. `declareInteraction` stays off limits.
 */
function drainEvents(): void {
  for (let guard = 0; guard < 60; guard++) {
    const state = store();
    if (!state.run) return;
    const event = state.activeEvent;
    if (!event) return;

    // The one answer. Held to the event types whose own target is on the board
    // (or is nothing at all), so the card being held up is never the card the
    // event is aimed at — the store refuses that, and a refusal counts for
    // nothing. What the store actually did is read back afterwards rather than
    // assumed: the oracle only records a spend it can see landed.
    if (
      !answeredThisRun &&
      (event.type === 'wipe' || event.type === 'removal' || event.type === 'combat')
    ) {
      const held = cardsInZone(state, 'hand').find(
        (c) => cardNameOf(state, c.iid) === INSTANT.name,
      );
      if (held) {
        store().respondToActiveEvent({ iid: held.iid, note: 'held it up' });
        if (store().cards[held.iid]?.zone === 'graveyard') {
          answeredThisRun = true;
          bump(oracle.answeredWith, INSTANT.name);
          // An instant answering leaves for the graveyard, which the zone
          // subscription does not read as a cast. It was one, so it is counted
          // here — and only here, so a permanent answering onto the battlefield
          // (which the subscription does see) could never be counted twice.
          noteCast(INSTANT.name, state.turn);
        }
        continue;
      }
    }

    const takesCards = event.type === 'wipe' || event.type === 'removal';
    const before = takesCards ? boardIids(state) : null;
    const names = new Map<string, string>();
    if (before) for (const iid of before) names.set(iid, cardNameOf(state, iid));

    if (event.type === 'resource' && (event.variant === 'discard' || event.variant === 'sacrifice')) {
      // Hand something over, so `discardedOrSacrificed` has something to count.
      if (event.variant === 'discard') {
        const hand = cardsInZone(state, 'hand');
        if (hand.length > 0) {
          bump(oracle.pitched, cardNameOf(state, hand[0].iid));
          store().resolveActiveEvent({ discardIid: hand[0].iid });
        } else store().resolveActiveEvent();
      } else {
        const fodder = cardsInZone(state, 'battlefield').find(
          (c) => !c.isCommander && !c.isToken && !isLandCard(state, c),
        );
        if (fodder) {
          bump(oracle.pitched, cardNameOf(state, fodder.iid));
          store().resolveActiveEvent({ sacrificeIid: fodder.iid });
        } else store().resolveActiveEvent();
      }
    } else {
      store().resolveActiveEvent();
    }

    if (before) {
      const after = boardIids(store());
      for (const iid of before) {
        if (after.has(iid)) continue;
        const name = names.get(iid);
        if (name) bump(oracle.removedBySeat, name);
      }
    }
  }
  throw new Error('drainEvents did not converge — the event queue never emptied');
}

function playLand(): void {
  const state = store();
  const land = cardsInZone(state, 'hand').find((c) => isLandCard(state, c));
  if (land) store().moveCard(land.iid, 'battlefield');
}

/**
 * The highest-mana nonland card in a zone, by iid. `Array.prototype.sort` is
 * stable, so equal mana values keep the zone's own order.
 */
function biggestIn(zone: ZoneId, keep?: (c: CardInstance) => boolean): string | null {
  const state = store();
  const card = cardsInZone(state, zone)
    .filter((c) => !isLandCard(state, c) && (keep?.(c) ?? true))
    .sort((a, b) => manaValueOf(state, b) - manaValueOf(state, a))[0];
  return card?.iid ?? null;
}

/** The biggest spell in hand, so the deployment is not all one-drops. */
function biggestSpell(): string | null {
  return biggestIn('hand');
}

/**
 * Play one scripted run. Alternates the two cast paths on purpose: a spell
 * played straight onto the battlefield and a spell declared onto the stack tray
 * and then resolved have to count as one cast each, and the tray must not add a
 * second one on the way down.
 */
function playScriptedRun(seed: string, mulligans: number): RunRecord {
  oracle = freshOracle();
  capturedRun = null;
  answeredThisRun = false;

  store().startRun(DECK, CARD_DATA, seed);
  for (let i = 0; i < mulligans; i += 1) store().takeMulligan();
  const bottomCount = mulliganBottomCount(mulligans);
  const bottom = cardsInZone(store(), 'hand')
    .slice(0, bottomCount)
    .map((c) => c.iid);
  store().resolveMulligan(bottom);

  for (let turn = 1; turn <= TURNS; turn++) {
    if (!store().run) break;
    drainEvents();
    if (!store().run) break;

    // A draw engine, so the hand is never empty and "drawn" has real numbers in
    // it. Turn 1 lives off the opening hand.
    if (turn > 1) store().drawCards(3);

    playLand();

    // Straight onto the battlefield.
    const direct = biggestSpell();
    if (direct) {
      store().moveCard(direct, 'battlefield');
      drainEvents();
    }

    // And through the tray, which is one cast declared and then resolved.
    if (store().run) {
      const stacked = biggestSpell();
      if (stacked) {
        store().castToStack(stacked);
        drainEvents();
        if (store().run) store().resolveTop();
      }
    }

    // Commander: cast it the moment it is castable, and again every time the
    // pod sends it home. Both paths are exercised across the two runs.
    if (turn >= 4 && store().run) {
      const stranded = [
        ...cardsInZone(store(), 'graveyard'),
        ...cardsInZone(store(), 'exile'),
      ].find((c) => c.isCommander);
      if (stranded) store().moveCard(stranded.iid, 'command');
      const commander = cardsInZone(store(), 'command').find((c) => c.isCommander);
      if (commander) {
        if (turn % 2 === 0) store().castCommander(commander.iid);
        else {
          store().castToStack(commander.iid);
          drainEvents();
          if (store().run) store().resolveTop();
        }
        drainEvents();
      }
    }

    // Bounce and replay. From `BOUNCE_TURN` on, the biggest permanent the player
    // put down goes back to hand and is recast the same turn — the pod's
    // Evacuation, scripted. It is the only way a card can be cast more often
    // than the deck showed it, and no seed can be relied on to offer it, so the
    // script does it itself rather than reporting the path untested.
    if (turn >= BOUNCE_TURN && store().run) {
      const target = biggestIn('battlefield', (c) => !c.isCommander && !c.isToken);
      if (target) {
        store().moveCard(target, 'hand');
        // Recast this card rather than leaving it to `biggestSpell()` next turn,
        // which would happily pick a fresh draw instead and leave the replay to
        // chance. Guarded on the bounce having landed, and a seat can still
        // counter the replay — the card stays in hand then, and the next turn
        // bounces whatever else is on the board.
        if (store().cards[target]?.zone === 'hand') {
          store().moveCard(target, 'battlefield');
          drainEvents();
        }
      }
    }

    if (turn === 3 && store().run) store().millCards(3);
    if (turn === 5 && store().run) {
      store().createToken({ name: 'Soldier', power: '1', toughness: '1' }, 2);
    }
    // Damage, so a seat can be eliminated and the run has somewhere to go.
    if (turn >= 6 && store().run) store().adjustLife('A', -9);

    if (!store().run) break;
    drainEvents();
    if (turn < TURNS && store().run) store().nextTurn();
  }

  // The run ends with cards still in hand — nothing is dumped — which is what
  // `stuckAtEnd` is counted off.
  for (const c of cardsInZone(store(), 'hand')) oracle.stuckAtEnd.add(cardNameOf(store(), c.iid));

  const result: RunResult = 'concede';
  if (store().run) endRunQuietly(result);

  const finished = lastCapturedRun();
  if (!finished) throw new Error('no run was captured off the store subscription');
  const end = finished.log[finished.log.length - 1];
  const endedAt = typeof end?.payload.endedAt === 'number' ? end.payload.endedAt : Date.now();
  return { ...finished, endedAt, result: finished.result ?? result };
}

/**
 * `endRun` persists through Dexie, which has no IndexedDB to talk to in Node, so
 * the write always fails here. The store already catches it and the log entry
 * that matters is appended before the write is attempted — this only keeps the
 * expected complaint (which arrives asynchronously, after the summary) from
 * burying the output. Every other console.error still gets through.
 */
const passthroughError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('Failed to persist run')) return;
  passthroughError(...args);
};

function endRunQuietly(result: RunResult): void {
  void store().endRun(result);
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const failures: string[] = [];

function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures.push(detail ? `${label} — ${detail}` : label);
}

function checkEqual(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(label, a === b, `got ${a}, expected ${b}`);
}

function main(): void {
  const deckOracle = freshOracle();
  const records: RunRecord[] = [];

  // Two runs, two seeds, and a mulligan in the second so the "a mulliganed hand
  // was never drawn" subtraction is exercised rather than assumed.
  for (const [index, spec] of [
    { seed: `${SEED}-a`, mulligans: 0 },
    { seed: `${SEED}-b`, mulligans: 1 },
  ].entries()) {
    const record = playScriptedRun(spec.seed, spec.mulligans);
    records.push(record);
    mergeOracles(deckOracle, oracle);
    for (const [name, turn] of oracle.firstCastTurn) {
      const list = firstCastTurns.get(name) ?? [];
      list.push(turn);
      firstCastTurns.set(name, list);
    }
    for (const name of oracle.stuckAtEnd) bump(stuckRuns, name);
    check(`run ${index + 1} recorded a roster`, record.roster !== undefined);
    check(`run ${index + 1} has a log`, record.log.length > 20, `${record.log.length} entries`);
  }

  const stats = cardStats(records);
  const byName = new Map<string, CardStat>(stats.cards.map((c) => [c.name, c]));

  // --- shape ---------------------------------------------------------------
  checkEqual('both runs were scored', stats.runsScored, 2);
  checkEqual('no run was skipped', stats.runsSkipped, 0);
  checkEqual(
    'every card in the deck has a row',
    stats.cards.length,
    DECK_CARDS.length + 1,
  );
  for (const stat of stats.cards) {
    checkEqual(`${stat.name} appears in both rosters`, stat.runs, 2);
  }
  const commanderRow = byName.get(COMMANDER.name);
  check('the commander is flagged', commanderRow?.isCommander === true);
  checkEqual('the commander was never drawn', commanderRow?.drawn, 0);
  checkEqual('a card never drawn has no cast rate', commanderRow?.castRate, null);
  checkEqual(
    'lands are flagged as lands',
    stats.cards.filter((c) => c.isLand).map((c) => c.name).sort(),
    ['Proving Gate', 'Training Forest', 'Training Plain'],
  );

  // --- the store's tally against the log's ---------------------------------
  const names = [...new Set([...stats.cards.map((c) => c.name)])].sort();
  for (const name of names) {
    const stat = byName.get(name);
    if (!stat) {
      failures.push(`${name} has no row`);
      continue;
    }
    checkEqual(`${name} drawn`, stat.drawn, deckOracle.drawn.get(name) ?? 0);
    checkEqual(`${name} cast`, stat.cast, deckOracle.cast.get(name) ?? 0);
    checkEqual(
      `${name} first cast turns`,
      stat.firstCastTurns,
      [...(firstCastTurns.get(name) ?? [])].sort((a, b) => a - b),
    );
    checkEqual(`${name} stuck at end`, stat.stuckAtEnd, stuckRuns.get(name) ?? 0);
    checkEqual(
      `${name} removed by a seat`,
      stat.removedBySeat,
      deckOracle.removedBySeat.get(name) ?? 0,
    );
    checkEqual(
      `${name} pitched`,
      stat.discardedOrSacrificed,
      deckOracle.pitched.get(name) ?? 0,
    );
    checkEqual(
      `${name} answered with`,
      stat.answeredWith,
      deckOracle.answeredWith.get(name) ?? 0,
    );
    const rate = stat.drawn > 0 ? stat.cast / stat.drawn : null;
    checkEqual(`${name} cast rate`, stat.castRate, rate);
    // A card can only be cast as often as it reached the hand — from the
    // library, or bounced back to it by a Cyclonic Rift. The commander is cast
    // out of the command zone and is exempt.
    check(
      `${name} was not cast more often than it reached hand`,
      stat.isCommander || stat.cast <= stat.drawn + (deckOracle.bounced.get(name) ?? 0),
      `${stat.cast} cast, ${stat.drawn} drawn, ${deckOracle.bounced.get(name) ?? 0} bounced back`,
    );
  }

  // --- the script really did what it claims -------------------------------
  const drawnTotal = [...deckOracle.drawn.values()].reduce((a, b) => a + b, 0);
  const castTotal = [...deckOracle.cast.values()].reduce((a, b) => a + b, 0);
  check('cards were drawn', drawnTotal > 20, `${drawnTotal}`);
  check('cards were cast', castTotal > 8, `${castTotal}`);
  check('the commander was cast', deckOracle.commanderCasts >= 1, `${deckOracle.commanderCasts}`);
  checkEqual(
    'the commander cast tally matches the store',
    commanderRow?.cast,
    deckOracle.commanderCasts,
  );
  check('the run ended with cards in hand', stuckRuns.size > 0, 'the hand was empty');
  check(
    'a spell went through the stack tray',
    records.some((r) => r.log.some((e) => e.kind === 'stack' && e.payload.op === 'push')),
  );
  check(
    'the library was milled',
    records.some((r) =>
      r.log.some((e) => e.kind === 'move' && e.payload.to === 'graveyard' && Array.isArray(e.payload.iids)),
    ),
  );
  // The answer path really was walked, and the card it spent reads as cast. A
  // spend the tally could not see would come back as `cast 0` and put the deck's
  // interaction on the cut list, which is the whole point of counting it.
  const answeredTotal = [...deckOracle.answeredWith.values()].reduce((a, b) => a + b, 0);
  check('an event was answered with a card', answeredTotal >= 1, `${answeredTotal} answers`);
  const instantRow = byName.get(INSTANT.name);
  check(
    'the instant that answered counts as cast',
    (instantRow?.cast ?? 0) >= answeredTotal,
    `${instantRow?.cast} cast, ${answeredTotal} answered with`,
  );
  const removedTotal = [...deckOracle.removedBySeat.values()].reduce((a, b) => a + b, 0);
  if (removedTotal === 0) {
    console.log('note: neither seed offered a wipe or a removal, so removedBySeat is untested');
  }
  const pitchedTotal = [...deckOracle.pitched.values()].reduce((a, b) => a + b, 0);
  if (pitchedTotal === 0) {
    console.log('note: no resource attack took a card, so discardedOrSacrificed is untested');
  }
  // The bounce path. A card put back in hand and recast was cast twice on one
  // draw, so its rate climbs past 100% — the reading `castRate` exists to allow
  // and the one the `cast <= drawn + bounced` inequality above is really testing.
  const bouncedTotal = [...deckOracle.bounced.values()].reduce((a, b) => a + b, 0);
  check('a card was bounced back to hand', bouncedTotal >= 1, `${bouncedTotal} bounced`);
  const replayed = stats.cards.filter((c) => !c.isCommander && c.castRate !== null && c.castRate > 1);
  check(
    'a bounced card was cast more often than it was drawn',
    replayed.length >= 1,
    'every card was cast at most as often as it was drawn',
  );
  if (replayed.length > 0) {
    console.log(
      `note: cast more often than drawn — ${replayed
        .map((c) => `${c.name} (${c.cast} cast, ${c.drawn} drawn)`)
        .join(', ')}`,
    );
  }
  // Tokens are not roster entries and must never reach the table: the script
  // makes Soldiers on turn 5 and the wipes sweep them away with `tokenGone`,
  // which the replayer has to read without inventing a card nobody can cut.
  check(
    'no token has a row',
    !stats.cards.some((c) => c.name === 'Soldier'),
    'the token showed up as a card',
  );

  // --- determinism ---------------------------------------------------------
  checkEqual('tallying the same records twice is stable', cardStats(records), stats);
  checkEqual(
    'a card that was never in a run is never invented',
    stats.cards.filter((c) => c.runs === 0).length,
    0,
  );

  // --- legacy runs ---------------------------------------------------------
  const legacy: RunRecord = { ...records[0] };
  delete legacy.roster;
  const withLegacy = cardStats([...records, legacy]);
  checkEqual('a rosterless run is skipped', withLegacy.runsSkipped, 1);
  checkEqual('and does not change the tally', withLegacy.cards, stats.cards);
  checkEqual('an empty history is empty', cardStats([]), {
    cards: [],
    runsScored: 0,
    runsSkipped: 0,
  });

  // --- ordering ------------------------------------------------------------
  const byDrawn = sortCardStats(stats.cards, 'drawn', 'desc');
  check(
    'sorting by drawn descending is monotone',
    byDrawn.every((c, i) => i === 0 || byDrawn[i - 1].drawn >= c.drawn),
  );
  checkEqual('sorting does not mutate the source', cardStats(records).cards, stats.cards);
  const flipped = sortCardStats(stats.cards, 'drawn', 'asc');
  check(
    'flipping the direction reverses the extremes',
    flipped.length === byDrawn.length &&
      flipped[0].drawn <= byDrawn[0].drawn &&
      flipped[flipped.length - 1].drawn >= byDrawn[byDrawn.length - 1].drawn,
  );
  const rateSorted = sortCardStats(stats.cards, 'castRate', 'asc');
  const firstNull = rateSorted.findIndex((c) => c.castRate === null);
  check(
    'cards with no cast rate sort last',
    firstNull === -1 || rateSorted.slice(firstNull).every((c) => c.castRate === null),
  );

  const cuts = cutCandidates(stats.cards);
  check('no land is offered as a cut candidate', cuts.every((c) => !c.isLand));
  check('every cut candidate was seen twice', cuts.every((c) => c.drawn >= 2));
  check(
    'cut candidates run least-cast first',
    cuts.every((c, i) => i === 0 || (cuts[i - 1].castRate ?? 0) <= (c.castRate ?? 0)),
  );
  const withLands = cutCandidates(stats.cards, { includeLands: true });
  check('asking for lands includes them', withLands.length >= cuts.length);
  check(
    'the commander is never flagged as a cut',
    !stats.cards.some((c) => c.isCommander && isCutCandidate(c)),
  );

  // --- summary -------------------------------------------------------------
  const table = sortCardStats(
    stats.cards.filter((c) => !c.isLand),
    'cutCandidates',
    'asc',
  );
  console.log('\nverify:cardstats');
  console.log('─'.repeat(78));
  console.log(`seed                ${SEED} (bracket ${BRACKET}, up to ${TURNS} turns, 2 runs)`);
  console.log(
    `runs                ${stats.runsScored} scored, ${stats.runsSkipped} skipped · turns reached ${records
      .map((r) => r.log[r.log.length - 1]?.turn ?? 0)
      .join(', ')}`,
  );
  console.log(
    `totals              ${drawnTotal} drawn, ${castTotal} cast, ${removedTotal} removed by a seat, ${bouncedTotal} bounced back to hand, ${answeredTotal} held up as an answer`,
  );
  console.log('─'.repeat(78));
  console.log(
    ['card'.padEnd(24), 'MV'.padStart(3), 'drawn'.padStart(6), 'cast'.padStart(5), 'rate'.padStart(6), 'T1st'.padStart(6), 'stuck'.padStart(6), 'rem'.padStart(4), 'pitch'.padStart(6)].join(' '),
  );
  for (const stat of table) {
    console.log(
      [
        `${stat.name}${isCutCandidate(stat) ? ' *' : ''}`.padEnd(24),
        String(stat.manaValue).padStart(3),
        String(stat.drawn).padStart(6),
        String(stat.cast).padStart(5),
        (stat.castRate === null ? 'n/a' : `${Math.round(stat.castRate * 100)}%`).padStart(6),
        (stat.avgFirstCastTurn === null ? 'n/a' : stat.avgFirstCastTurn.toFixed(1)).padStart(6),
        String(stat.stuckAtEnd).padStart(6),
        String(stat.removedBySeat).padStart(4),
        String(stat.discardedOrSacrificed).padStart(6),
      ].join(' '),
    );
  }
  console.log('─'.repeat(78));
  console.log('* cut candidate (seen twice or more, cast at most half the time)');
  console.log('─'.repeat(78));

  if (failures.length > 0) {
    console.log(`${failures.length} check(s) FAILED:`);
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    throw new Error(`${failures.length} card-stat check(s) failed`);
  }
  console.log('all checks passed');
}

main();
