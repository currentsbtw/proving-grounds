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
 * put two wraths on the table, which is what the wipe-recovery checks need.
 * Passing a different seed still exercises everything else, but those two checks
 * may legitimately fail.
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
  aggregateProfile,
  compareScorecards,
  replayZones,
  scoreRun,
  type Scorecard,
} from '../src/engine/scorecard.ts';
import type {
  CardData,
  Deck,
  RosterEntry,
  RunRecord,
  RunResult,
  SeatId,
  ZoneId,
} from '../src/domain/types.ts';

const SEED = process.argv[2] ?? 'scorecard-verify-12';
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
const ZONES: ZoneId[] = ['library', 'hand', 'battlefield', 'graveyard', 'exile', 'command'];

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
      if (policy.wipesSeen === 2) store().respondToActiveEvent('held a counterspell');
      else store().resolveActiveEvent();
      continue;
    }

    if (event.type === 'removal') {
      if (policy.removalsAnswered === 0) {
        policy.removalsAnswered += 1;
        store().respondToActiveEvent('protection');
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
  check(
    'every instance is accounted for',
    ZONES.reduce((n, z) => n + derived[z].length, 0) === DECK_SIZE + 1 + 2,
    `${ZONES.reduce((n, z) => n + derived[z].length, 0)} instances`,
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
  summary.push(`profile tags        ${profile.tags.join(', ') || '(none)'}`);

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
