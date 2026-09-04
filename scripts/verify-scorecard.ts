/**
 * Verification harness for the M2 scoring engine.
 *
 * There is no test framework in this project, and the thing most worth testing
 * is not a function in isolation — it is the agreement between two independent
 * derivations of the same game:
 *
 *   1. the **store**, which mutates state directly and writes an append-only log
 *   2. the **scorer**, which reads only that log back and reconstructs the game
 *
 * So this script drives the real `useGameStore` headlessly through a scripted
 * run (the store neither imports React nor needs a DOM; its Dexie write fails in
 * Node and is caught, which is why the record is captured off a subscription
 * instead of off the database), keeps its own state-based tally of what
 * happened, and then asserts that scoring the log agrees with it.
 *
 *   npm run verify:scorecard [seed]
 *
 * Failures are collected rather than thrown one at a time, so a bad run reports
 * everything that is wrong in a single pass. The process exits non-zero if any
 * check failed. The default seed is deliberate: it is one whose pressure rolls
 * put two wraths on the table with one of them rebuilt from (the wipe-recovery
 * checks), offer a resource attack, and leave the run alive for all twelve
 * scripted turns. Passing a different seed still exercises everything else, but
 * those checks may legitimately fail on one where the pod behaved differently.
 * It was re-picked when seat archetype profiles landed (pressure version 4),
 * which redrew every seed's stream, and again for standing hate pieces and pod
 * combat (version 7), which added two draw sites per window and so redrew them
 * once more — on the previous default the run now settles on turn 10 and no
 * resource attack is ever offered. The current one also has the pod cast two
 * hate pieces the script lets stand and hit itself for seventeen, so the
 * standing-piece and pod-damage readings are checked against a real store as
 * well as against the hand-written fixture below.
 */
import {
  cardsInZone,
  isLandCard,
  manaValueOf,
  mulliganBottomCount,
  useGameStore,
  type GameState,
} from '../src/state/gameStore.ts';
import { SCORING } from '../src/data/scorecard.ts';
import {
  aggregateProfile,
  compareScorecards,
  replayZones,
  scoreRun,
  type Scorecard,
} from '../src/engine/scorecard.ts';
import type {
  CardData,
  Deck,
  LogEntry,
  RosterEntry,
  RunRecord,
  RunResult,
  SeatId,
  ZoneId,
} from '../src/domain/types.ts';

const SEED = process.argv[2] ?? 'scorecard-verify-v7-2';
const MULLIGAN_SEED = `${SEED}-mull`;
const TURNS = 12;
const BRACKET = 4;

// ---------------------------------------------------------------------------
// A synthetic 99 + 1 deck
// ---------------------------------------------------------------------------

function card(
  scryfallId: string,
  name: string,
  manaValue: number,
  typeLine: string,
): CardData {
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

const COMMANDER = card('cmd-warlord', 'Proving Ground Warlord', 5, 'Legendary Creature — Human Warrior');

const DECK_CARDS: { data: CardData; qty: number }[] = [
  { data: card('land-forest', 'Training Forest', 0, 'Basic Land — Forest'), qty: 14 },
  { data: card('land-plain', 'Training Plain', 0, 'Basic Land — Plains'), qty: 12 },
  { data: card('land-gate', 'Proving Gate', 0, 'Land'), qty: 10 },
  { data: card('cr-scout', 'Grounds Scout', 1, 'Creature — Human Scout'), qty: 9 },
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

const CARD_DATA_BY_NAME = new Map<string, CardData>(
  Object.values(CARD_DATA).map((data) => [data.name, data]),
);

/** The legacy fallback the UI will supply: card facts resolved by display name. */
function factsByName(name: string): RosterEntry | undefined {
  const data = CARD_DATA_BY_NAME.get(name);
  if (!data) return undefined;
  return {
    scryfallId: data.scryfallId,
    name: data.name,
    manaValue: data.manaValue,
    typeLine: data.typeLine,
    isCommander: data.scryfallId === COMMANDER.scryfallId,
  };
}

const DECK: Deck = {
  id: 'verify-deck',
  name: 'Scorecard Verification',
  commanderIds: [COMMANDER.scryfallId],
  cards: DECK_CARDS.map(({ data, qty }) => ({ scryfallId: data.scryfallId, qty })),
  bracket: BRACKET as Deck['bracket'],
  createdAt: 0,
  updatedAt: 0,
};

const DECK_SIZE = DECK_CARDS.reduce((n, c) => n + c.qty, 0);

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

const store = () => useGameStore.getState();
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

/** Σ MV of the player's nonland, non-token permanents — the scorer's board value. */
function boardValue(state: GameState): number {
  let total = 0;
  for (const c of Object.values(state.cards)) {
    if (c.zone !== 'battlefield' || c.isToken) continue;
    if (!isLandCard(state, c)) total += manaValueOf(state, c);
  }
  return total;
}

function zoneSets(state: GameState): Record<ZoneId, string[]> {
  const out = {} as Record<ZoneId, string[]>;
  for (const zone of ZONES) out[zone] = [];
  for (const c of Object.values(state.cards)) out[c.zone].push(c.iid);
  return out;
}

function commanderOnBattlefield(state: GameState): boolean {
  return Object.values(state.cards).some((c) => c.isCommander && c.zone === 'battlefield');
}

// ---------------------------------------------------------------------------
// The independent, state-based oracle
// ---------------------------------------------------------------------------

/**
 * Everything the script observed by watching the *store*, never the log. Zone
 * transitions are read off a Zustand subscription, so this tally is derived the
 * opposite way round from the scorer and the two can be held against each other.
 */
interface Oracle {
  mvByTurn: number[];
  landsByTurn: number[];
  drawsByTurn: number[];
  boardValueEnd: number[];
  commanderUpEnd: boolean[];
  damageBySeat: Record<SeatId, number>;
  commanderDamageBySeat: Record<SeatId, number>;
  commanderCasts: number;
  firstCastTurn: number | null;
  commanderRemovals: number;
  countDraws: boolean;
}

function freshOracle(): Oracle {
  return {
    mvByTurn: new Array<number>(TURNS + 2).fill(0),
    landsByTurn: new Array<number>(TURNS + 2).fill(0),
    drawsByTurn: new Array<number>(TURNS + 2).fill(0),
    boardValueEnd: new Array<number>(TURNS + 2).fill(0),
    commanderUpEnd: new Array<boolean>(TURNS + 2).fill(false),
    damageBySeat: { A: 0, B: 0, C: 0 },
    commanderDamageBySeat: { A: 0, B: 0, C: 0 },
    commanderCasts: 0,
    firstCastTurn: null,
    commanderRemovals: 0,
    countDraws: false,
  };
}

let oracle = freshOracle();
let capturedRun: RunRecord | null = null;

/**
 * Read the capture through a call. The subscription above assigns to it from
 * inside a closure, which the compiler's flow analysis cannot see, so a direct
 * read narrows to `null` and every use of it looks unreachable.
 */
function lastCapturedRun(): RunRecord | null {
  return capturedRun;
}

useGameStore.subscribe((state, prev) => {
  if (state.run) capturedRun = state.run;
  if (state.cards === prev.cards) return;
  const turn = state.turn;
  for (const [iid, next] of Object.entries(state.cards)) {
    const before = prev.cards[iid];
    if (before && before.zone === next.zone) continue;
    if (next.zone === 'battlefield') {
      if (next.isToken) continue;
      if (isLandCard(state, next)) oracle.landsByTurn[turn] += 1;
      else oracle.mvByTurn[turn] += manaValueOf(state, next);
      if (next.isCommander && oracle.firstCastTurn === null) oracle.firstCastTurn = turn;
    } else if (next.zone === 'hand' && before?.zone === 'library' && oracle.countDraws) {
      oracle.drawsByTurn[turn] += 1;
    }
    if (before?.zone === 'battlefield' && next.isCommander && oracle.firstCastTurn !== null) {
      oracle.commanderRemovals += 1;
    }
  }
});

// ---------------------------------------------------------------------------
// The scripted game
// ---------------------------------------------------------------------------

/** The table's standing answers, and what they have already been spent on. */
interface Policy {
  wipesSeen: number;
  removalsAnswered: number;
  /** The variant of the resource attack that was answered empty-handed, if any. */
  whiffedOn: string | null;
}

function freshPolicy(): Policy {
  return { wipesSeen: 0, removalsAnswered: 0, whiffedOn: null };
}

/** Deterministic answers to whatever the pod offers. Never consults the log. */
function drainEvents(policy: Policy): void {
  for (let guard = 0; guard < 50; guard++) {
    const event = store().activeEvent;
    if (!event) return;

    if (event.type === 'wipe') {
      policy.wipesSeen += 1;
      // Answer the second wrath and eat the rest: the scorecard needs both a
      // negated wipe and one it can measure a rebuild from.
      if (policy.wipesSeen === 2) store().respondToActiveEvent({ note: 'held a counterspell' });
      else store().resolveActiveEvent();
      continue;
    }

    if (event.type === 'removal') {
      if (policy.removalsAnswered === 0) {
        policy.removalsAnswered += 1;
        store().respondToActiveEvent({ note: 'protection' });
      } else {
        store().resolveActiveEvent();
      }
      continue;
    }

    if (event.type === 'resource') {
      const state = store();
      const variant = event.variant;
      if (variant !== 'discard' && variant !== 'sacrifice') {
        // The tax variant has nothing to hand over — acknowledging it is all there is.
        store().resolveActiveEvent();
      } else if (policy.whiffedOn === null) {
        // Answer the first strip empty-handed. The table is an honor system, so
        // "I had nothing to give" is a resolution the store has to describe, and
        // this is the only way to reach that branch.
        policy.whiffedOn = variant;
        store().resolveActiveEvent();
      } else if (variant === 'discard') {
        const hand = cardsInZone(state, 'hand');
        if (hand.length > 0) store().resolveActiveEvent({ discardIid: hand[0].iid });
        else store().resolveActiveEvent();
      } else {
        const fodder = cardsInZone(state, 'battlefield').find(
          (c) => !c.isCommander && !isLandCard(state, c),
        );
        if (fodder) store().resolveActiveEvent({ sacrificeIid: fodder.iid });
        else store().resolveActiveEvent();
      }
      continue;
    }

    store().resolveActiveEvent();
  }
  throw new Error('drainEvents did not converge — the event queue never emptied');
}

/** Never lose to the race: answering it also exercises the declared-interaction path. */
function answerClock(policy: Policy): void {
  if (!store().clock) return;
  store().declareInteraction();
  drainEvents(policy);
}

function playLand(): void {
  const state = store();
  const land = cardsInZone(state, 'hand').find((c) => isLandCard(state, c));
  if (land) store().moveCard(land.iid, 'battlefield');
}

function playSpells(policy: Policy, count: number): void {
  for (let i = 0; i < count; i++) {
    const state = store();
    const spells = cardsInZone(state, 'hand')
      .filter((c) => !isLandCard(state, c))
      .sort((a, b) => manaValueOf(state, b) - manaValueOf(state, a));
    if (spells.length === 0) return;
    store().moveCard(spells[0].iid, 'battlefield');
    // A spell can be met by a counter on the way down; settle that before the next.
    drainEvents(policy);
  }
}

interface RunOutcome {
  record: RunRecord;
  oracle: Oracle;
  policy: Policy;
  zonesAtEnd: Record<ZoneId, string[]>;
  result: RunResult;
}

/** Play the full scripted game and return the record `saveRun` would have stored. */
function playScriptedRun(seed: string): RunOutcome {
  oracle = freshOracle();
  capturedRun = null;
  const policy = freshPolicy();

  store().startRun(DECK, CARD_DATA, seed);
  store().resolveMulligan([]);
  oracle.countDraws = true;

  for (let turn = 1; turn <= TURNS; turn++) {
    if (!store().run) throw new Error(`run ended early at turn ${turn}`);
    drainEvents(policy);
    answerClock(policy);

    // A draw engine, so the hand is never the reason a rebuild stalls: what the
    // wipe-recovery metric should measure is redeployment, not topdecking.
    if (turn > 1) store().drawCards(4);

    playLand();
    playSpells(policy, 3);

    // Commander: cast it the moment it is castable, and again every time the
    // pod sends it home — that is what exercises tax, downtime and re-casts.
    if (turn >= 4) {
      // A commander the pod binned goes back to the command zone, the way a real
      // player would put it there — that is what makes tax and re-casts happen.
      const stranded = [...cardsInZone(store(), 'graveyard'), ...cardsInZone(store(), 'exile')].find(
        (c) => c.isCommander,
      );
      if (stranded) store().moveCard(stranded.iid, 'command');

      const commander = cardsInZone(store(), 'command').find((c) => c.isCommander);
      if (commander) {
        oracle.commanderCasts += 1;
        store().castCommander(commander.iid);
        drainEvents(policy);
      }
    }

    if (turn === 3) store().millCards(2);
    if (turn === 5) store().createToken({ name: 'Soldier', power: '1', toughness: '1' }, 2);

    if (turn >= 6 && turn <= 10) {
      store().adjustLife('A', -8);
      oracle.damageBySeat.A += 8;
    }
    if (turn >= 7) {
      store().dealCommanderDamage('B', 4);
      oracle.damageBySeat.B += 4;
      oracle.commanderDamageBySeat.B += 4;
    }
    if (turn === 8) {
      // Dealt, then taken back: an undone hit must not reach the scorecard.
      store().adjustLife('C', -5);
      store().undoLastLifeChange();
    }

    drainEvents(policy);
    answerClock(policy);

    oracle.boardValueEnd[turn] = boardValue(store());
    oracle.commanderUpEnd[turn] = commanderOnBattlefield(store());

    if (turn < TURNS) store().nextTurn();
  }

  // Table cleanup: every card the scorer prices must have been named in the log
  // at least once, or a legacy run (no roster, names only) could not match a
  // rostered one. Cards still in hand at the end have only ever been logged as
  // bare iids, so put them in the graveyard, which logs them with their names.
  for (const c of cardsInZone(store(), 'hand')) store().moveCard(c.iid, 'graveyard');

  const zonesAtEnd = zoneSets(store());
  const result: RunResult = 'win';
  endRunQuietly(result);

  const finished = lastCapturedRun();
  if (!finished) throw new Error('no run was captured off the store subscription');
  const end = finished.log[finished.log.length - 1];
  const endedAt = typeof end?.payload.endedAt === 'number' ? end.payload.endedAt : Date.now();
  return { record: { ...finished, endedAt, result }, oracle, policy, zonesAtEnd, result };
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

/**
 * A short run that only exists to exercise the mulligan path. `mulligans` is
 * how many are taken; the number bottomed follows the Commander rule (the first
 * mulligan is free), so this mirrors what the UI allows.
 */
function playMulliganRun(seed: string, mulligans = 1): { record: RunRecord; hand: string[] } {
  capturedRun = null;
  oracle = freshOracle();
  store().startRun(DECK, CARD_DATA, seed);
  for (let i = 0; i < mulligans; i += 1) store().takeMulligan();
  const bottomCount = mulliganBottomCount(mulligans);
  const bottom = cardsInZone(store(), 'hand')
    .slice(0, bottomCount)
    .map((c) => c.iid);
  store().resolveMulligan(bottom);
  const hand = cardsInZone(store(), 'hand').map((c) => c.iid);
  endRunQuietly('concede');
  const finished = lastCapturedRun();
  if (!finished) throw new Error('no mulligan run captured');
  const end = finished.log[finished.log.length - 1];
  const endedAt = typeof end?.payload.endedAt === 'number' ? end.payload.endedAt : Date.now();
  return { record: { ...finished, endedAt, result: 'concede' }, hand };
}

// ---------------------------------------------------------------------------
// The stack tray, scored against the direct cast
// ---------------------------------------------------------------------------

const PARITY_TURNS = 8;

/**
 * The same game twice: once played straight onto the battlefield, once routed
 * through the manual stack tray. The tray is bookkeeping of declared order, so
 * it must leave no fingerprint on the numbers — the same cards deployed on the
 * same turns, the same commander casts, the same tax, the same downtime.
 *
 * Neither variant consumes rng, and the tray resolves inside the same turn it
 * was cast in, so both executions present the engine an identical board at every
 * window and therefore roll identical windows. The one thing that would split
 * them is a seat holding up interaction — an intercepted spell waits in hand,
 * where a stacked one waits on the tray — so a seed that arms one is discarded
 * and the search moves on.
 */
function playParityRun(seed: string, viaStack: boolean): RunRecord {
  capturedRun = null;
  oracle = freshOracle();
  const policy = freshPolicy();

  store().startRun(DECK, CARD_DATA, seed);
  store().resolveMulligan([]);

  function cast(iid: string, commander: boolean): void {
    if (viaStack) {
      store().castToStack(iid);
      store().resolveTop();
    } else if (commander) {
      store().castCommander(iid);
    } else {
      store().moveCard(iid, 'battlefield');
    }
    drainEvents(policy);
  }

  for (let turn = 1; turn <= PARITY_TURNS; turn++) {
    if (!store().run) throw new Error(`parity run ended early at turn ${turn}`);
    drainEvents(policy);
    answerClock(policy);
    if (turn > 1) store().drawCards(3);
    playLand();

    for (let i = 0; i < 2; i++) {
      const state = store();
      const spell = cardsInZone(state, 'hand')
        .filter((c) => !isLandCard(state, c))
        .sort((a, b) => manaValueOf(state, b) - manaValueOf(state, a))[0];
      if (!spell) break;
      cast(spell.iid, false);
    }

    if (turn >= 4) {
      // A commander the pod binned goes back to the command zone, exactly as the
      // main script does it, so tax and re-casts happen in both variants alike.
      const stranded = [
        ...cardsInZone(store(), 'graveyard'),
        ...cardsInZone(store(), 'exile'),
      ].find((c) => c.isCommander);
      if (stranded) store().moveCard(stranded.iid, 'command');
      const commander = cardsInZone(store(), 'command').find((c) => c.isCommander);
      if (commander) cast(commander.iid, true);
    }

    drainEvents(policy);
    answerClock(policy);
    if (turn < PARITY_TURNS) store().nextTurn();
  }

  endRunQuietly('concede');
  const finished = lastCapturedRun();
  if (!finished) throw new Error('no parity run captured off the store');
  const end = finished.log[finished.log.length - 1];
  const endedAt = typeof end?.payload.endedAt === 'number' ? end.payload.endedAt : Date.now();
  return { ...finished, endedAt, result: 'concede' };
}

/** Whether a seat held up interaction anywhere in this run. */
function sawCounter(record: RunRecord): boolean {
  return record.log.some((entry) => entry.payload.eventType === 'counter');
}

/** A seed whose parity script neither variant gets countered in, or null. */
function findParitySeed(): { seed: string; direct: RunRecord; stacked: RunRecord } | null {
  for (let i = 0; i < 40; i++) {
    const seed = `${SEED}-parity-${i}`;
    const direct = playParityRun(seed, false);
    if (sawCounter(direct)) continue;
    const stacked = playParityRun(seed, true);
    if (sawCounter(stacked)) continue;
    return { seed, direct, stacked };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The two cast paths under a counter
// ---------------------------------------------------------------------------

/** What the player did about the counter the seat put up. */
type Disposition = 'answered' | 'letThrough';

/**
 * A seed whose pod is holding up interaction at or under the commander's mana
 * value, played straight to the turn it happens on. Nothing is cast during the
 * search, so both variants of the fixture below reach this point identically.
 */
function armSeatForCommander(): { seed: string; threshold: number } | null {
  for (let i = 0; i < 40; i++) {
    const seed = `${SEED}-counter-${i}`;
    capturedRun = null;
    oracle = freshOracle();
    store().startRun(DECK, CARD_DATA, seed);
    store().resolveMulligan([]);
    for (let turn = 1; turn <= 12; turn++) {
      store().nextTurn();
      if (!store().run) break;
      if (store().clock) store().declareInteraction();
      const armed = store().counterArmed;
      if (armed && armed.threshold <= COMMANDER.manaValue) return { seed, threshold: armed.threshold };
    }
  }
  return null;
}

/**
 * The same decision twice: a commander met by a counterspell, cast straight out
 * of the command zone once and routed through the stack tray once, with the
 * player answering the counter (or letting it through) identically both times.
 *
 * The two paths used to disagree about what that decision was worth. The direct
 * cast marked itself countered the instant a seat spoke up, so answering the
 * counter still scored a countered cast; the tray, which cannot know at cast
 * time, scored none. Only the entry written when the counter actually resolves
 * is entitled to say so, and this is the fixture that holds both paths to it.
 *
 * The run is cut short the moment the counter is settled: nothing after it is
 * part of the comparison, and stopping there is what keeps the two executions
 * from diverging on a later window.
 */
function playCounterRun(seed: string, viaStack: boolean, disposition: Disposition): RunRecord {
  capturedRun = null;
  oracle = freshOracle();
  store().startRun(DECK, CARD_DATA, seed);
  store().resolveMulligan([]);
  for (let turn = 1; turn <= 12; turn++) {
    store().nextTurn();
    if (!store().run) throw new Error(`counter run ${seed} ended during the run-up`);
    if (store().clock) store().declareInteraction();
    if (store().counterArmed) break;
  }

  const commander = cardsInZone(store(), 'command').find((c) => c.isCommander);
  if (!commander) throw new Error('the counter run has no commander in the command zone');

  if (viaStack) store().castToStack(commander.iid);
  else store().castCommander(commander.iid);

  const raised = store().activeEvent;
  if (raised?.type !== 'counter') throw new Error('the seat did not answer the commander');

  if (disposition === 'answered') {
    store().respondToActiveEvent({ note: 'held protection' });
    // The direct path's spell finishes its interrupted trip on the spot; the
    // tray's waits its turn, which is the player saying "and now it resolves".
    if (viaStack) store().resolveTop();
  } else {
    store().resolveActiveEvent();
  }

  endRunQuietly('concede');
  const finished = lastCapturedRun();
  if (!finished) throw new Error('no counter run captured off the store');
  const end = finished.log[finished.log.length - 1];
  const endedAt = typeof end?.payload.endedAt === 'number' ? end.payload.endedAt : Date.now();
  return { ...finished, endedAt, result: 'concede' };
}

/**
 * A run in the shape the store wrote before the two cast paths were reconciled:
 * the cast entry claims `countered` alongside its `castNumber`, and the trip
 * home claims it again. That is one countered cast said twice, and a scorer that
 * counts the new shape must not read the old one as two.
 */
function legacyCounteredRun(): RunRecord {
  const iid = 'legacy-cmd-instance';
  const roster: Record<string, RosterEntry> = {
    [iid]: {
      scryfallId: COMMANDER.scryfallId,
      name: COMMANDER.name,
      manaValue: COMMANDER.manaValue,
      typeLine: COMMANDER.typeLine,
      isCommander: true,
    },
  };
  const entry = (
    seq: number,
    kind: LogEntry['kind'],
    message: string,
    payload: Record<string, unknown>,
  ): LogEntry => ({ seq, turn: 4, phase: 'main1', kind, message, payload, at: 0 });

  return {
    id: 'legacy-countered-run',
    deckId: DECK.id,
    deckName: DECK.name,
    seed: 'legacy-countered',
    bracket: BRACKET,
    startedAt: 0,
    endedAt: 0,
    result: 'concede',
    roster,
    log: [
      entry(1, 'run', 'Run started', { bracket: BRACKET }),
      entry(2, 'commander', 'Cast (cast #1, tax +0). Met by a counter', {
        iid,
        name: COMMANDER.name,
        scryfallId: COMMANDER.scryfallId,
        castNumber: 1,
        taxPaid: 0,
        from: 'command',
        to: 'stack',
        countered: true,
      }),
      entry(3, 'commander', 'Countered. Returned to the command zone', {
        iid,
        name: COMMANDER.name,
        scryfallId: COMMANDER.scryfallId,
        countered: true,
        from: 'command',
        to: 'command',
        nextTax: 2,
      }),
      entry(4, 'run', 'Run ended: concede', { result: 'concede' }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Standing hate pieces and pod combat, written by hand
// ---------------------------------------------------------------------------

/**
 * A hand-written log in the store's own payload shapes.
 *
 * Whether a seed offers a hate piece — let alone one the script can leave
 * standing for four turns, sweep with a wrath, and retire with the seat that
 * cast it — is the pod's business, and none of the four fates a piece can meet
 * can be forced through the store in one scripted run. So this fixture states
 * them, the way `verify-review.ts`'s run D states a canceled event: five hate
 * events, one answered on the stack and four that stood, plus two seats hitting
 * each other while the player untapped.
 *
 * What it is really asserting is the reading of two log shapes the scorer cannot
 * get wrong quietly:
 *
 *  - a `removed-hazard` respond is *not* an answer to the event. The event
 *    resolved — the piece stood — and the removal three turns later is a second
 *    fact about the same card.
 *  - a `podCombat` damage entry is the pod hitting itself, not the player
 *    dealing damage.
 */
const HAZARD_RUN_TURNS = 9;

interface HatePiece {
  eventId: string;
  hazardId: string;
  seatId: SeatId;
  card: string;
  spawnedTurn: number;
}

function hazardRun(): RunRecord {
  const log: LogEntry[] = [];
  let turn = 1;

  function add(
    at: number,
    kind: LogEntry['kind'],
    message: string,
    payload: Record<string, unknown>,
  ): void {
    turn = at;
    log.push({ seq: log.length + 1, turn, phase: 'main1', kind, message, payload, at: 0 });
  }

  /** The event entry a hate piece writes when the player lets it resolve. */
  function stands(piece: HatePiece): void {
    add(piece.spawnedTurn, 'event', `Seat ${piece.seatId} casts ${piece.card}. (${piece.card} stands)`, {
      eventId: piece.eventId,
      eventType: 'hate',
      seatId: piece.seatId,
      eventTurn: piece.spawnedTurn,
      card: piece.card,
      cardEffect: 'Nonbasic lands are Mountains.',
      severity: {},
      resolved: true,
      outcome: { standing: true, hazardId: piece.hazardId },
    });
  }

  const moon: HatePiece = {
    eventId: 'evt-hate-a',
    hazardId: 'hz-evt-hate-a',
    seatId: 'A',
    card: 'Blood Moon',
    spawnedTurn: 2,
  };
  const peace: HatePiece = {
    eventId: 'evt-hate-b',
    hazardId: 'hz-evt-hate-b',
    seatId: 'B',
    card: 'Rest in Peace',
    spawnedTurn: 3,
  };
  const orb: HatePiece = {
    eventId: 'evt-hate-c2',
    hazardId: 'hz-evt-hate-c2',
    seatId: 'C',
    card: 'Torpor Orb',
    spawnedTurn: 7,
  };
  const thalia: HatePiece = {
    eventId: 'evt-hate-b2',
    hazardId: 'hz-evt-hate-b2',
    seatId: 'B',
    card: 'Thalia, Guardian of Thraben',
    spawnedTurn: 8,
  };

  add(1, 'run', 'Run started', {
    runId: 'hazard-run',
    deckId: DECK.id,
    deckName: DECK.name,
    seed: 'hazard-fixture',
    bracket: BRACKET,
    pressureVersion: 7,
  });

  stands(moon);
  stands(peace);

  // Answered on the stack: a hate event that never became a piece. It is the
  // one hate row entitled to a place in the answer tallies.
  add(4, 'event', 'Seat C casts Stony Silence. Respond or it stands.', {
    eventId: 'evt-hate-c',
    eventType: 'hate',
    seatId: 'C',
    eventTurn: 4,
    card: 'Stony Silence',
    severity: {},
    queued: true,
  });
  add(4, 'respond', 'Answered with Swan Song', {
    eventId: 'evt-hate-c',
    eventType: 'hate',
    seatId: 'C',
    eventTurn: 4,
    card: 'Stony Silence',
    severity: {},
    answerIid: 'ans-swan',
    answerName: 'Swan Song',
    answerZone: 'hand',
    answerTo: 'graveyard',
    answerMv: 2,
    bound: true,
  });

  add(5, 'respond', `Removed ${moon.card} (Seat A) with Krosan Grip`, {
    reason: 'removed-hazard',
    hazardId: moon.hazardId,
    eventId: moon.eventId,
    seatId: moon.seatId,
    cardName: moon.card,
    spawnedTurn: moon.spawnedTurn,
    turnsStanding: 3,
    answerIid: 'ans-grip',
    answerName: 'Krosan Grip',
    answerZone: 'hand',
    answerTo: 'graveyard',
    answerMv: 3,
    bound: true,
  });

  // The pod hitting itself, and the player hitting seat A, in the same turn.
  add(6, 'damage', 'Seat B attacks Seat A for 7', {
    seatId: 'A',
    attackerId: 'B',
    amount: 7,
    podCombat: true,
    before: 40,
    after: 33,
    threatBefore: 5,
    threatAfter: 4,
  });
  add(6, 'life', 'Seat A: -6', { target: 'seat', seatId: 'A', delta: -6, before: 33, after: 27 });

  add(7, 'threat', `${peace.card} (Seat B) swept by Farewell`, {
    hazardId: peace.hazardId,
    eventId: peace.eventId,
    seatId: peace.seatId,
    cardName: peace.card,
    canceled: true,
    reason: 'wiped',
    byEventId: 'evt-wipe-1',
  });
  stands(orb);

  stands(thalia);
  add(8, 'damage', 'Seat C attacks Seat A for 5', {
    seatId: 'A',
    attackerId: 'C',
    amount: 5,
    podCombat: true,
    before: 27,
    after: 22,
    threatBefore: 4,
    threatAfter: 3,
  });

  add(9, 'damage', 'Seat B is out', { seatId: 'B', reason: 'life' });
  add(9, 'threat', `${thalia.card} (Seat B) leaves with the seat`, {
    hazardId: thalia.hazardId,
    eventId: thalia.eventId,
    seatId: thalia.seatId,
    cardName: thalia.card,
    canceled: true,
    reason: 'seat-eliminated',
  });
  add(HAZARD_RUN_TURNS, 'run', 'Run ended: loss', {
    result: 'loss',
    endedAt: 0,
    turns: HAZARD_RUN_TURNS,
  });

  return {
    id: 'hazard-run',
    deckId: DECK.id,
    deckName: DECK.name,
    seed: 'hazard-fixture',
    bracket: BRACKET,
    startedAt: 0,
    endedAt: 0,
    result: 'loss',
    roster: {},
    log,
  };
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

function sorted(list: string[]): string[] {
  return [...list].sort();
}

/**
 * Strip everything about a run that cannot be reproduced from a seed, so two
 * executions of the same script can be compared byte for byte:
 *
 *  - the run's nanoid and its two wall-clock stamps
 *  - card instance ids, which are nanoids too. They reach the scorecard through
 *    the event outcomes the store records verbatim (what a wrath swept, what a
 *    counter caught) and through the id of a counter event, which names the
 *    spell it answered. Rewriting them to their position in the run's roster is
 *    stable across executions because `startRun` builds instances in deck order.
 *
 * Everything else in a scorecard is a function of the seed alone.
 */
function normalize(card: Scorecard, record: RunRecord): string {
  const clone = JSON.parse(JSON.stringify(card)) as Scorecard;
  clone.runId = '<runId>';
  clone.startedAt = 0;
  clone.endedAt = 0;

  const aliases = new Map<string, string>();
  for (const iid of Object.keys(record.roster ?? {})) aliases.set(iid, `#${aliases.size}`);
  for (const entry of record.log) {
    if (entry.kind !== 'token') continue;
    const iids = entry.payload.iids;
    if (!Array.isArray(iids)) continue;
    for (const iid of iids) {
      if (typeof iid === 'string' && !aliases.has(iid)) aliases.set(iid, `#${aliases.size}`);
    }
  }

  let json = JSON.stringify(clone);
  for (const [iid, alias] of aliases) json = json.split(iid).join(alias);
  return json;
}

function main(): void {
  const first = playScriptedRun(SEED);
  const scorecard = scoreRun(first.record);
  const summary: string[] = [];

  // --- determinism ---------------------------------------------------------
  checkEqual('scoring the same record twice is stable', scoreRun(first.record), scorecard);
  const second = playScriptedRun(SEED);
  const replayed = scoreRun(second.record);
  check(
    'replaying the whole script on the same seed scores identically',
    normalize(replayed, second.record) === normalize(scorecard, first.record),
    firstDifference(
      JSON.parse(normalize(replayed, second.record)),
      JSON.parse(normalize(scorecard, first.record)),
    ),
  );

  // --- zone reconstruction -------------------------------------------------
  const derived = replayZones(first.record);
  for (const zone of ZONES) {
    checkEqual(`derived ${zone} matches the store`, sorted(derived[zone]), sorted(first.zonesAtEnd[zone]));
  }
  // The total is not a constant: the two Soldier tokens made on turn 5 cease to
  // exist the moment the pod wraths after it, which is an ordinary thing for a
  // seed to do. What has to hold whatever the pod did is that every *real* card
  // is somewhere and is there exactly once — the roster is the list of them, and
  // tokens are counted rather than required.
  const rosterIids = new Set(Object.keys(first.record.roster ?? {}));
  const allIids = ZONES.flatMap((zone) => derived[zone]);
  const cardIids = allIids.filter((iid) => rosterIids.has(iid));
  const tokensLeft = allIids.length - cardIids.length;
  check(
    'the roster holds every card the deck started with',
    rosterIids.size === DECK_SIZE + 1,
    `${rosterIids.size} rostered, expected ${DECK_SIZE + 1}`,
  );
  check(
    'every deck card is accounted for exactly once',
    cardIids.length === rosterIids.size && new Set(cardIids).size === cardIids.length,
    `${cardIids.length} placed (${new Set(cardIids).size} distinct) of ${rosterIids.size}, plus ${tokensLeft} token(s) still on the table`,
  );

  // --- timeline ------------------------------------------------------------
  const o = first.oracle;
  const scriptedMv = o.mvByTurn.reduce((a, b) => a + b, 0);
  const timelineMv = scorecard.timeline.reduce((n, r) => n + r.mvDeployed, 0);
  check('Σ mvDeployed matches the script', timelineMv === scriptedMv, `${timelineMv} vs ${scriptedMv}`);
  for (const row of scorecard.timeline) {
    checkEqual(`turn ${row.turn} landsPlayed`, row.landsPlayed, o.landsByTurn[row.turn]);
    checkEqual(`turn ${row.turn} mvDeployed`, row.mvDeployed, o.mvByTurn[row.turn]);
    checkEqual(`turn ${row.turn} cardsDrawn`, row.cardsDrawn, o.drawsByTurn[row.turn]);
    checkEqual(`turn ${row.turn} boardValueEnd`, row.boardValueEnd, o.boardValueEnd[row.turn]);
  }
  checkEqual('timeline covers every turn', scorecard.timeline.length, TURNS);
  checkEqual('turns reached', scorecard.turns, TURNS);
  check('nothing went unpriced', !scorecard.partial);

  // --- damage and seats ----------------------------------------------------
  for (const seatId of SEAT_IDS) {
    const seat = scorecard.seats.find((s) => s.seatId === seatId);
    checkEqual(`seat ${seatId} damage`, seat?.damageDealt, o.damageBySeat[seatId]);
    checkEqual(
      `seat ${seatId} commander damage`,
      seat?.commanderDamageDealt,
      o.commanderDamageBySeat[seatId],
    );
  }
  check(
    'the undone hit on seat C never lands',
    scorecard.seats.find((s) => s.seatId === 'C')?.damageDealt === 0,
  );
  const eliminated = scorecard.seats.filter((s) => s.eliminatedTurn !== null);
  check('at least one seat was eliminated', eliminated.length >= 1, `${eliminated.length}`);

  // --- resource attacks answered empty-handed ------------------------------
  const whiffed = first.policy.whiffedOn;
  check('a resource attack was offered', whiffed !== null, 'none in this run');
  if (whiffed) {
    const row = scorecard.events.find(
      (e) => e.type === 'resource' && e.outcome?.noTarget === true,
    );
    check('an empty-handed resource resolution is recorded as a no-op', row !== undefined);
    checkEqual('the no-op names the variant', row?.outcome?.mode, whiffed);
    const said = first.record.log.some(
      (entry) =>
        entry.kind === 'event' && entry.message.includes(`nothing to ${whiffed}`),
    );
    check('the log says what could not be given', said);
  }

  // --- events --------------------------------------------------------------
  const logEventIds = new Set<string>();
  for (const entry of first.record.log) {
    const id = entry.payload.eventId;
    if (typeof id === 'string') logEventIds.add(id);
  }
  const ledgerIds = scorecard.events.map((e) => e.eventId);
  check(
    'every logged event id appears exactly once in the ledger',
    ledgerIds.length === new Set(ledgerIds).size && ledgerIds.length === logEventIds.size,
    `${ledgerIds.length} ledger rows vs ${logEventIds.size} log ids`,
  );
  check(
    'no ledger row is invented',
    ledgerIds.every((id) => logEventIds.has(id)),
  );
  const total = scorecard.answers.total;
  check(
    'offered = responded + resolved + unresolved',
    total.offered === total.responded + total.resolved + total.unresolved,
    JSON.stringify(total),
  );
  checkEqual('ledger size matches the tally', ledgerIds.length, total.offered);
  const byTypeOffered = Object.values(scorecard.answers.byType).reduce((n, t) => n + t.offered, 0);
  checkEqual('byType sums to the total', byTypeOffered, total.offered);
  check('some events were answered', total.responded >= 1, `${total.responded}`);

  // --- wipes ---------------------------------------------------------------
  const recovered = scorecard.wipes.filter((w) => !w.negated && w.recoveredTurn !== null);
  const negated = scorecard.wipes.filter((w) => w.negated);
  check(
    'at least one wipe was measured and recovered from',
    recovered.length >= 1,
    `${scorecard.wipes.length} wipes, ${recovered.length} recovered`,
  );
  check('at least one wipe was negated', negated.length >= 1, `${negated.length} negated`);
  for (const wipe of recovered) {
    check(
      `wipe ${wipe.eventId} recovery is after the wipe`,
      (wipe.recoveredTurn ?? 0) > wipe.turn && wipe.turnsToRecover !== null,
    );
    check(
      `wipe ${wipe.eventId} took a real board`,
      wipe.boardValueBefore >= wipe.boardValueAfter,
    );
  }

  // --- commander -----------------------------------------------------------
  checkEqual('commander casts', scorecard.commander.casts, o.commanderCasts);
  checkEqual('first commander cast turn', scorecard.commander.firstCastTurn, o.firstCastTurn);
  checkEqual('commander removals', scorecard.commander.removals, o.commanderRemovals);
  const firstCast = o.firstCastTurn;
  let expectedDowntime = 0;
  if (firstCast !== null) {
    for (let t = firstCast; t <= TURNS; t++) if (!o.commanderUpEnd[t]) expectedDowntime += 1;
  }
  checkEqual('commander downtime', scorecard.commander.downtimeTurns, expectedDowntime);

  // --- profile and comparison ---------------------------------------------
  const profile = aggregateProfile([scorecard, scorecard]);
  checkEqual('profile run count', profile.runs, 2);
  checkEqual('profile win rate', profile.winRate, 1);
  checkEqual('profile deck id', profile.deckId, DECK.id);
  check('a single run gets no tags', aggregateProfile([scorecard]).tags.length === 0);

  const comparison = compareScorecards(scorecard, scorecard);
  check('same seed', comparison.sameSeed);
  check('same bracket', comparison.sameBracket);
  check(
    'every self-comparison delta is zero',
    comparison.metrics.every((m) => m.delta === 0 || m.delta === null),
    JSON.stringify(comparison.metrics.filter((m) => m.delta !== 0 && m.delta !== null)),
  );

  // --- legacy runs ---------------------------------------------------------
  const legacy: RunRecord = { ...first.record };
  delete legacy.roster;
  const blind = scoreRun(legacy);
  check('a rosterless run scores partial', blind.partial);
  const byName = scoreRun(legacy, { factsByName });
  check(
    'name-resolved legacy scoring matches the rostered scoring',
    JSON.stringify(byName) === JSON.stringify(scorecard),
    firstDifference(byName, scorecard),
  );

  // --- the stack tray scores as the direct cast ----------------------------
  let parityLine: string | null = null;
  const parity = findParitySeed();
  check('a parity seed was found', parity !== null, 'no uncountered seed in 40 tries');
  if (parity) {
    const direct = scoreRun(parity.direct);
    const stacked = scoreRun(parity.stacked);
    checkEqual('casting via the stack deploys the same MV per turn', stacked.deployment, direct.deployment);
    checkEqual('casting via the stack scores the same commander line', stacked.commander, direct.commander);
    checkEqual(
      'casting via the stack scores the same turn timeline',
      stacked.timeline,
      direct.timeline,
    );
    check(
      'the stacked variant really went through the tray',
      parity.stacked.log.some((entry) => entry.kind === 'stack' && entry.payload.op === 'push'),
    );
    check(
      'the direct variant never touched the tray',
      !parity.direct.log.some((entry) => entry.kind === 'stack'),
    );
    check(
      'nothing was left on the stack at the end',
      replayZones(parity.stacked).stack.length === 0,
      `${replayZones(parity.stacked).stack.length} left`,
    );
    parityLine = `stack parity        seed ${parity.seed}: ${direct.commander.casts} commander casts, tax ${direct.commander.totalTaxPaid}, ${direct.commander.downtimeTurns} turns down — identical via the tray`;
  }

  // --- and it scores the same under a counter, either way it is settled -----
  let counterLine: string | null = null;
  const armed = armSeatForCommander();
  check('a counter-armed seed was found', armed !== null, 'no armed seed in 40 tries');
  if (armed) {
    const dispositions: Disposition[] = ['answered', 'letThrough'];
    const scored: Record<string, number> = {};
    for (const disposition of dispositions) {
      const direct = scoreRun(playCounterRun(armed.seed, false, disposition));
      const stacked = scoreRun(playCounterRun(armed.seed, true, disposition));
      checkEqual(
        `a commander countered and ${disposition} scores the same via the tray`,
        stacked.commander,
        direct.commander,
      );
      checkEqual(
        `a commander countered and ${disposition} deploys the same via the tray`,
        stacked.deployment,
        direct.deployment,
      );
      check(
        `both paths agree on countered casts when ${disposition}`,
        stacked.commander.counteredCasts === direct.commander.counteredCasts,
        `tray ${stacked.commander.counteredCasts}, direct ${direct.commander.counteredCasts}`,
      );
      scored[disposition] = direct.commander.counteredCasts;
    }
    // Answering the counter is not being countered. Letting it resolve is.
    checkEqual('answering the counter scores no countered cast', scored.answered, 0);
    checkEqual('letting the counter resolve scores one', scored.letThrough, 1);
    counterLine = `counter parity      seed ${armed.seed} (armed at ${armed.threshold}): answered ${scored.answered} countered, let through ${scored.letThrough} — identical on both paths`;
  }

  // --- a run recorded in the old shape still scores one countered cast ------
  const legacyCountered = scoreRun(legacyCounteredRun());
  checkEqual(
    'a legacy cast+return pair counts one countered cast, not two',
    legacyCountered.commander.counteredCasts,
    1,
  );
  checkEqual('the legacy run still counts its one cast', legacyCountered.commander.casts, 1);

  // --- standing hate pieces and pod combat ---------------------------------
  const hazardCard = scoreRun(hazardRun());
  checkEqual('hate pieces faced', hazardCard.hazards.faced, 5);
  checkEqual('hate pieces that stood', hazardCard.hazards.stood, 4);
  checkEqual('hate pieces removed by the player', hazardCard.hazards.removed, 1);
  checkEqual('hate pieces swept', hazardCard.hazards.swept, 1);
  // Blood Moon T2→T5, Rest in Peace T3→T7, Torpor Orb T7→run end T9, Thalia
  // T8→the seat's death on T9. A piece still standing is measured to the last
  // turn played; a piece retired with its seat is measured to the retirement.
  checkEqual('turns each piece stood', hazardCard.hazards.turnsStanding, [3, 4, 2, 1]);

  const moonRow = hazardCard.events.find((e) => e.eventId === 'evt-hate-a');
  checkEqual('a removed piece keeps its resolved terminal', moonRow?.terminal, 'resolved');
  checkEqual('the removal turn is on the row', moonRow?.removedTurn, 5);
  checkEqual('the card that removed it is on the row', moonRow?.removedWith, 'Krosan Grip');
  check(
    'a removal never becomes the answer to the event',
    moonRow?.answerCard === undefined,
    `answerCard ${moonRow?.answerCard}`,
  );
  const peaceRow = hazardCard.events.find((e) => e.eventId === 'evt-hate-b');
  checkEqual('a swept piece records the turn the wrath reached it', peaceRow?.sweptTurn, 7);
  const negatedRow = hazardCard.events.find((e) => e.eventId === 'evt-hate-c');
  checkEqual('a hate piece answered on the stack is responded', negatedRow?.terminal, 'responded');
  checkEqual('and it names the card that answered it', negatedRow?.answerCard, 'Swan Song');
  // Four pieces stood and one was answered: exactly one answer, because a
  // removal is not a response to the prompt the event made.
  checkEqual('the hate tally counts one answer and four resolutions', hazardCard.answers.byType.hate, {
    offered: 5,
    responded: 1,
    resolved: 4,
    unresolved: 0,
    named: 1,
    nameable: 1,
  });

  const hazardSeatA = hazardCard.seats.find((s) => s.seatId === 'A');
  checkEqual('pod damage lands on the defending seat', hazardSeatA?.podDamageTaken, 12);
  checkEqual('pod damage stays out of the seat damage the player dealt', hazardSeatA?.damageDealt, 6);
  checkEqual('and out of commander damage', hazardSeatA?.commanderDamageDealt, 0);
  checkEqual(
    'pod damage stays out of the turn timeline too',
    hazardCard.timeline[5]?.damageBySeat.A,
    6,
  );
  checkEqual(
    'total damage dealt is the player\'s alone',
    hazardCard.seats.reduce((sum, seat) => sum + seat.damageDealt, 0),
    6,
  );
  const hazardSeatB = hazardCard.seats.find((s) => s.seatId === 'B');
  checkEqual('the seat that died still records it', hazardSeatB?.eliminatedTurn, 9);

  const hazardProfile = aggregateProfile([hazardCard, hazardCard]);
  checkEqual('the profile pools hate faced', hazardProfile.hateFaced, 10);
  checkEqual('the profile pools hate stood', hazardProfile.hateStood, 8);
  checkEqual('the profile reads removed against stood', hazardProfile.hateRemovedRate, 0.25);
  check(
    'a deck that leaves pieces standing is tagged for it',
    hazardProfile.tags.includes(SCORING.tagLabels.letsHateStand),
    hazardProfile.tags.join(', ') || '(no tags)',
  );
  check(
    'the comparison carries the hate removed rate',
    compareScorecards(hazardCard, scorecard).metrics.some((m) => m.key === 'hateRemovedRate'),
  );

  // The same reading off the real store, whatever the seed did. It is 0 today
  // because the store's pod-combat entries have not landed; the moment they do,
  // this is the check that says the scorer and the store agree about them.
  const podByLog: Record<SeatId, number> = { A: 0, B: 0, C: 0 };
  for (const entry of first.record.log) {
    if (entry.kind !== 'damage' || entry.payload.podCombat !== true) continue;
    const seatId = entry.payload.seatId;
    const amount = entry.payload.amount;
    if ((seatId === 'A' || seatId === 'B' || seatId === 'C') && typeof amount === 'number') {
      podByLog[seatId] += amount;
    }
  }
  for (const seatId of SEAT_IDS) {
    checkEqual(
      `seat ${seatId} pod damage in the scripted run matches the log`,
      scorecard.seats.find((s) => s.seatId === seatId)?.podDamageTaken,
      podByLog[seatId],
    );
  }
  checkEqual(
    'the scripted run scores every hate event the log offered',
    scorecard.hazards.faced,
    scorecard.events.filter((e) => e.type === 'hate').length,
  );
  // A piece stands only where the store said it resolved onto the table, so the
  // count is readable straight off the log without the scorer's help.
  const stoodByLog = first.record.log.filter((entry) => {
    if (entry.kind !== 'event' || entry.payload.resolved !== true) return false;
    const outcome = entry.payload.outcome;
    return (
      outcome !== null &&
      typeof outcome === 'object' &&
      (outcome as Record<string, unknown>).standing === true
    );
  }).length;
  checkEqual('the scripted run scores every piece that stood', scorecard.hazards.stood, stoodByLog);
  check(
    'the scripted run actually put a piece on the table',
    scorecard.hazards.stood >= 1,
    `${scorecard.hazards.faced} faced, ${scorecard.hazards.stood} stood — pick another seed`,
  );
  check(
    'the pod actually hit itself on this seed',
    SEAT_IDS.some((id) => podByLog[id] > 0),
    'no pod combat in this run — pick another seed',
  );

  // --- mulligans -----------------------------------------------------------
  // The first mulligan is free in Commander (CR 103.5c): it keeps seven. The
  // second bottoms one.
  const mull = playMulliganRun(MULLIGAN_SEED);
  const mullCard = scoreRun(mull.record);
  checkEqual('mulligan count', mullCard.keep.mulligans, 1);
  checkEqual('kept hand size after the free mulligan', mullCard.keep.keptHandSize, 7);
  checkEqual(
    'derived hand after a mulligan matches the store',
    sorted(replayZones(mull.record).hand),
    sorted(mull.hand),
  );
  check(
    'lands in the opening seven were counted',
    mullCard.keep.landsInOpeningSeven >= 0 && mullCard.keep.landsInOpeningSeven <= 7,
  );

  const mull2 = playMulliganRun(`${MULLIGAN_SEED}-2`, 2);
  const mull2Card = scoreRun(mull2.record);
  checkEqual('mulligan count after two', mull2Card.keep.mulligans, 2);
  checkEqual('kept hand size after two mulligans', mull2Card.keep.keptHandSize, 6);
  checkEqual(
    'derived hand after two mulligans matches the store',
    sorted(replayZones(mull2.record).hand),
    sorted(mull2.hand),
  );

  // --- summary -------------------------------------------------------------
  summary.push(`seed                ${SEED} (bracket ${BRACKET}, ${TURNS} turns)`);
  summary.push(`log entries         ${first.record.log.length}`);
  summary.push(`result              ${scorecard.result} on turn ${scorecard.turns}`);
  summary.push(
    `deployment          ${scorecard.deployment.avgMvPerTurn.toFixed(2)} MV/turn, commander first cast T${scorecard.deployment.firstCommanderCastTurn}`,
  );
  summary.push(
    `commander           ${scorecard.commander.casts} casts (${scorecard.commander.counteredCasts} countered), tax ${scorecard.commander.totalTaxPaid}, ${scorecard.commander.removals} removals, ${scorecard.commander.downtimeTurns} turns down`,
  );
  summary.push(
    `events              ${total.offered} offered · ${total.responded} answered · ${total.resolved} resolved · ${total.unresolved} unresolved · rate ${scorecard.answers.rate?.toFixed(2) ?? 'n/a'}`,
  );
  summary.push(
    `wipes               ${scorecard.wipes.length} (${negated.length} negated, ${recovered.length} rebuilt) ${scorecard.wipes
      .map((w) => `T${w.turn} ${w.boardValueBefore}→${w.boardValueAfter}${w.negated ? ' negated' : ` recovered ${w.recoveredTurn ?? 'never'}`}`)
      .join('; ')}`,
  );
  summary.push(
    `seats               ${scorecard.seats
      .map((s) => `${s.seatId} ${s.damageDealt} dmg${s.eliminatedTurn ? ` (out T${s.eliminatedTurn} by ${s.eliminationReason})` : ''}`)
      .join(', ')}`,
  );
  summary.push(
    `clock               faced ${scorecard.clock.faced}, outcome ${scorecard.clock.outcome ?? 'none'}, beaten ${scorecard.clock.beatClock}`,
  );
  summary.push(
    `keep                ${scorecard.keep.keptHandSize} cards, ${scorecard.keep.landsInKeptHand} lands, ${scorecard.keep.mulligans} mulligans`,
  );
  summary.push(
    `hate pieces         run: ${scorecard.hazards.faced} faced, ${scorecard.hazards.stood} stood · fixture: ${hazardCard.hazards.faced} faced, ${hazardCard.hazards.stood} stood, ${hazardCard.hazards.removed} removed, ${hazardCard.hazards.swept} swept, standing ${hazardCard.hazards.turnsStanding.join('/')}`,
  );
  summary.push(
    `pod combat          run: ${SEAT_IDS.map((id) => `${id} ${podByLog[id]}`).join(', ')} · fixture: A ${hazardSeatA?.podDamageTaken ?? 0} taken with ${hazardSeatA?.damageDealt ?? 0} dealt by the player`,
  );
  summary.push(`profile tags        ${profile.tags.join(', ') || '(none)'}`);
  if (parityLine) summary.push(parityLine);
  if (counterLine) summary.push(counterLine);

  console.log('\nverify:scorecard');
  console.log('─'.repeat(72));
  for (const line of summary) console.log(line);
  console.log('─'.repeat(72));

  if (failures.length > 0) {
    console.log(`${failures.length} check(s) FAILED:`);
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    throw new Error(`${failures.length} scorecard check(s) failed`);
  }
  console.log('all checks passed');
}

/** Where two scorecards first disagree — a diff is more useful than "not equal". */
function firstDifference(a: unknown, b: unknown, path = ''): string {
  if (JSON.stringify(a) === JSON.stringify(b)) return '';
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const left = (a as Record<string, unknown>)[key];
    const right = (b as Record<string, unknown>)[key];
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    return firstDifference(left, right, path ? `${path}.${key}` : key);
  }
  return path;
}

main();
