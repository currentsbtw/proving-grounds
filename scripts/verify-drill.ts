/**
 * Verification harness for the hand drill and the shot clock.
 *
 * The drill's whole claim is that it deals what a run would: hand 1 is the
 * opening seven of a run on that seed, hand 2 is what one mulligan gives, and so
 * on. That claim is only worth anything if it is checked against the real store,
 * so this drives `useGameStore` headlessly — the same trick
 * `scripts/verify-review.ts` uses, since the store neither imports React nor
 * needs a DOM — and compares the store's hand, card for card, with the pure
 * `dealHands`.
 *
 * It is deliberately a comparison and not a re-implementation: the fragile part
 * is the rng draws `startRun` spends seating the pod between the shuffle and the
 * opening hand, and a drill that forgot them would still agree on hand 1. So
 * check A pins hand 1 and check B pins hands 2 and 3, which is where a missed
 * draw shows up.
 *
 *   A — three seeds, opening hand from `startRun` against `dealHands(hands: 1)`.
 *   B — the same seeds, `dealHands(hands: 3)` against the store after one and
 *       then two `takeMulligan()` calls.
 *   C — `handStats` on a hand built by hand: three lands and four spells.
 *   D — a run started with a 60 second shot clock: the figure on the 'run'
 *       entry, and a numeric `previousTurnSeconds` on every 'turn' entry.
 *   E — the `over-clock` finding, over two hand-written logs whose 'turn'
 *       entries differ only in whether they carry `overtime`. Timing is wall
 *       clock, so a run that reliably takes minutes per turn cannot be played
 *       through the store inside a verification script; the log is written in
 *       the store's own payload shapes instead, exactly as verify-review writes
 *       its canceled-event and race-clock fixtures.
 *
 *   npx tsx scripts/verify-drill.ts [seed]
 *
 * Failures are collected rather than thrown one at a time, so a bad run reports
 * everything wrong in a single pass. The process exits non-zero if any failed.
 */
import { cardsInZone, STARTING_HAND_SIZE, useGameStore } from '../src/state/gameStore.ts';
import { dealHands, handStats } from '../src/engine/drill.ts';
import { scoreRun } from '../src/engine/scorecard.ts';
import { reviewRun, type Review, type ReviewFinding } from '../src/engine/review.ts';
import { REVIEW } from '../src/data/review.ts';
import type {
  CardData,
  Deck,
  LogEntry,
  LogKind,
  Phase,
  RosterEntry,
  RunRecord,
} from '../src/domain/types.ts';

const SEED = process.argv[2] ?? 'drill-verify';
const SEEDS = [`${SEED}-1`, `${SEED}-2`, `${SEED}-3`];

// ---------------------------------------------------------------------------
// A synthetic 99 + 1 deck
// ---------------------------------------------------------------------------

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

const COMMANDER = card('cmd-drillmaster', 'Grounds Drillmaster', 3, 'Legendary Creature — Human');
const LAND = card('land-forest', 'Training Forest', 0, 'Basic Land — Forest');
const SCOUT = card('cr-scout', 'Grounds Scout', 1, 'Creature — Human Scout');
const WARDEN = card('cr-warden', 'Grounds Warden', 2, 'Creature — Human Soldier');
const RANGER = card('cr-ranger', 'Grounds Ranger', 3, 'Creature — Elf Ranger');
const COLOSSUS = card('cr-colossus', 'Grounds Colossus', 6, 'Creature — Golem');

const DECK_CARDS: { data: CardData; qty: number }[] = [
  { data: LAND, qty: 38 },
  { data: SCOUT, qty: 16 },
  { data: WARDEN, qty: 16 },
  { data: RANGER, qty: 16 },
  { data: COLOSSUS, qty: 13 },
];

const CARD_DATA: Record<string, CardData> = { [COMMANDER.scryfallId]: COMMANDER };
for (const { data } of DECK_CARDS) CARD_DATA[data.scryfallId] = data;

const DECK: Deck = {
  id: 'verify-drill-deck',
  name: 'Drill Verification',
  commanderIds: [COMMANDER.scryfallId],
  cards: DECK_CARDS.map(({ data, qty }) => ({ scryfallId: data.scryfallId, qty })),
  bracket: 2,
  createdAt: 0,
  updatedAt: 0,
};

/** The library `startRun` builds: every card expanded by quantity, in deck order. */
const CARD_IDS: string[] = DECK.cards.flatMap((ref) => Array<string>(ref.qty).fill(ref.scryfallId));

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

const store = () => useGameStore.getState();

/** The live hand as scryfall ids, in the order the cards were drawn. */
function handIds(): string[] {
  const state = store();
  return cardsInZone(state, 'hand').map((c) => c.scryfallId ?? '?');
}

/**
 * Answer whatever the pod offers, so a turn can be advanced. The drill checks
 * care about turn entries and not about what the seats did, so every event is
 * simply resolved.
 */
function drain(): void {
  for (let guard = 0; guard < 60; guard++) {
    if (store().activeEvent) {
      store().resolveActiveEvent();
      continue;
    }
    if (store().clock) {
      store().declareInteraction();
      continue;
    }
    return;
  }
  throw new Error('drain did not converge — the event queue never emptied');
}

// ---------------------------------------------------------------------------
// Hand-written logs for the over-clock finding
// ---------------------------------------------------------------------------

const CLOCK_TURNS = 9;
const CLOCK_LIMIT = 90;
/** Turns that ran long, and how long they took. T7 is the worst, at 2:18. */
const OVERTIME: Record<number, number> = { 4: 121, 7: 138 };
const CLOCK_LANDS = Array.from({ length: CLOCK_TURNS }, (_, i) => `clk-l${i + 1}`);
const CLOCK_ROSTER: Record<string, RosterEntry> = Object.fromEntries(
  CLOCK_LANDS.map((iid) => [
    iid,
    {
      scryfallId: LAND.scryfallId,
      name: LAND.name,
      manaValue: LAND.manaValue,
      typeLine: LAND.typeLine,
      isCommander: false,
    },
  ]),
);

/**
 * A nine-turn run under a 90 second clock. `timed` decides whether the turns
 * that ran long say so; everything else about the two logs is identical, so the
 * only thing the two reviews can disagree about is the finding.
 */
function playClockRun(seed: string, timed: boolean): RunRecord {
  const id = `verify-drill-clock-${timed ? 'over' : 'inside'}`;
  const log: LogEntry[] = [];
  let turn = 1;

  function add(
    kind: LogKind,
    message: string,
    payload: Record<string, unknown>,
    phase: Phase = 'main1',
  ): void {
    log.push({ seq: log.length + 1, turn, phase, kind, message, payload, at: 0 });
  }

  add('run', `Run started: Shot Clock (seed ${seed})`, {
    runId: id,
    deckId: DECK.id,
    deckName: 'Shot Clock',
    seed,
    bracket: 2,
    librarySize: CLOCK_LANDS.length,
    shotClockSeconds: CLOCK_LIMIT,
  });
  add('draw', `Opening hand: ${CLOCK_LANDS.length} cards`, {
    iids: [...CLOCK_LANDS],
    names: CLOCK_LANDS.map(() => LAND.name),
    count: CLOCK_LANDS.length,
    opening: true,
  });

  for (let i = 0; i < CLOCK_TURNS; i++) {
    if (i > 0) {
      turn = i + 1;
      const previous = turn - 1;
      const long = OVERTIME[previous];
      add('turn', `Turn ${turn} begins`, {
        turn,
        previousTurn: previous,
        // Everything inside the clock takes a plain 40 seconds; the two long
        // turns take what `OVERTIME` says, and only those carry the flag.
        previousTurnSeconds: long ?? 40,
        overtime: timed && long !== undefined ? true : undefined,
      });
    }
    // A land every turn, so nothing else in the review has anything to say.
    add('move', `${LAND.name}: hand → battlefield`, {
      iid: CLOCK_LANDS[i],
      name: LAND.name,
      from: 'hand',
      to: 'battlefield',
    });
  }

  add('run', 'Run ended: concede', { result: 'concede', endedAt: 0, turns: turn }, 'end');

  return {
    id,
    deckId: DECK.id,
    deckName: 'Shot Clock',
    seed,
    bracket: 2,
    startedAt: 0,
    endedAt: 0,
    result: 'concede',
    roster: CLOCK_ROSTER,
    log,
  };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const failures: string[] = [];
/** Every assertion attempted, so the run reports what it actually covered. */
let checked = 0;

function check(label: string, condition: boolean, detail = ''): void {
  checked += 1;
  if (!condition) failures.push(detail ? `${label} — ${detail}` : label);
}

function checkEqual(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(label, a === b, `got ${a}, expected ${b}`);
}

function review(record: RunRecord): Review {
  return reviewRun(record, scoreRun(record));
}

function findAll(result: Review, code: string): ReviewFinding[] {
  return result.findings.filter((f) => f.code === code);
}

function readNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------

function main(): void {
  const summary: string[] = [];

  // --- A and B: the drill deals what a run deals ----------------------------
  check(
    'drill hand size matches the store',
    dealHands({ cardIds: CARD_IDS, seed: SEEDS[0], hands: 1 })[0].length === STARTING_HAND_SIZE,
    `dealt ${dealHands({ cardIds: CARD_IDS, seed: SEEDS[0], hands: 1 })[0].length}`,
  );

  for (const seed of SEEDS) {
    const dealt = dealHands({ cardIds: CARD_IDS, seed, hands: 3 });

    store().startRun(DECK, CARD_DATA, seed);
    const opening = handIds();
    checkEqual(`${seed}: opening hand matches dealHands hand 1`, opening, dealt[0]);
    checkEqual(
      `${seed}: dealHands(hands: 1) is the same hand as dealHands(hands: 3)[0]`,
      dealHands({ cardIds: CARD_IDS, seed, hands: 1 })[0],
      dealt[0],
    );

    store().takeMulligan();
    checkEqual(`${seed}: hand after one mulligan matches dealHands hand 2`, handIds(), dealt[1]);

    store().takeMulligan();
    checkEqual(`${seed}: hand after two mulligans matches dealHands hand 3`, handIds(), dealt[2]);

    summary.push(
      `${seed}  h1 ${dealt[0].join(' ')}\n${' '.repeat(seed.length)}  h2 ${dealt[1].join(' ')}` +
        `\n${' '.repeat(seed.length)}  h3 ${dealt[2].join(' ')}`,
    );
  }

  // --- C: the counting line -------------------------------------------------
  const stats = handStats([
    LAND,
    LAND,
    LAND,
    SCOUT, // 1
    WARDEN, // 2
    RANGER, // 3
    card('cr-five', 'Grounds Sentinel', 5, 'Creature — Golem'),
  ]);
  checkEqual('handStats lands', stats.lands, 3);
  checkEqual('handStats cheapest', stats.cheapest, 1);
  checkEqual('handStats spellsAtOrBelow', stats.spellsAtOrBelow, { 2: 2, 3: 3 });
  checkEqual('handStats avgMv', stats.avgMv, 2.75);
  summary.push(
    `handStats  ${stats.lands} lands · cheapest MV ${stats.cheapest} · ` +
      `${stats.spellsAtOrBelow[3]} spells at MV<=3 · avg MV ${stats.avgMv}`,
  );

  // --- D: the shot clock reaches the log ------------------------------------
  store().startRun(DECK, CARD_DATA, `${SEED}-clock`, { shotClockSeconds: 60 });
  store().resolveMulligan([]);
  for (let turn = 1; turn < 5; turn++) {
    drain();
    store().nextTurn();
  }
  const timed = store().run;
  if (!timed) throw new Error('the timed run vanished off the store');

  const startEntry = timed.log.find(
    (entry) => entry.kind === 'run' && entry.payload.result === undefined,
  );
  checkEqual('run entry carries the shot clock', startEntry?.payload.shotClockSeconds, 60);
  checkEqual('store holds the shot clock', store().shotClockSeconds, 60);

  const turnEntries = timed.log.filter((entry) => entry.kind === 'turn');
  check('the timed run advanced turns', turnEntries.length === 4, `${turnEntries.length} turns`);
  check(
    'every turn entry carries a numeric previousTurnSeconds',
    turnEntries.every((entry) => readNumber(entry.payload, 'previousTurnSeconds') !== undefined),
    turnEntries
      .map((entry) => `T${entry.payload.previousTurn}=${String(entry.payload.previousTurnSeconds)}`)
      .join(', '),
  );
  summary.push(
    `shot clock  60 s on the run entry, ${turnEntries.length} turn entries timed ` +
      `(${turnEntries.map((e) => `${String(e.payload.previousTurnSeconds)}s`).join(', ')})`,
  );

  // A run started with no options must not learn about a clock from the last one.
  store().startRun(DECK, CARD_DATA, `${SEED}-noclock`);
  checkEqual('a plain run has no shot clock', store().shotClockSeconds, null);

  // --- E: the over-clock finding --------------------------------------------
  const over = review(playClockRun(`${SEED}-over`, true));
  const inside = review(playClockRun(`${SEED}-inside`, false));
  const found = findAll(over, 'over-clock');

  checkEqual('one over-clock finding', found.length, 1);
  checkEqual('over-clock is a note', found[0]?.kind, 'note');
  checkEqual('over-clock names T4 and T7', found[0]?.turns, [4, 7]);
  checkEqual('over-clock title', found[0]?.title, 'Over the shot clock on T4, T7');
  checkEqual('over-clock detail', found[0]?.detail, 'Worst T7 at 2:18 against 1:30.');
  check(
    'over-clock points at real log entries',
    (found[0]?.evidence.length ?? 0) > 0,
    'no seq numbers',
  );
  checkEqual('no over-clock without overtime turns', findAll(inside, 'over-clock').length, 0);
  checkEqual('review version', over.version, REVIEW.version);
  summary.push(
    `over-clock  ${found[0]?.title ?? '(missing)'}\n            ${found[0]?.detail ?? ''}`,
  );

  console.log('\nverify:drill');
  console.log('─'.repeat(72));
  console.log(`seed base           ${SEED}`);
  console.log(`review version      ${over.version}`);
  console.log('─'.repeat(72));
  for (const line of summary) console.log(line);
  console.log('─'.repeat(72));

  if (failures.length > 0) {
    console.log(`${failures.length} of ${checked} check(s) FAILED:`);
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    throw new Error(`${failures.length} drill check(s) failed`);
  }
  console.log(`all ${checked} checks passed`);
}

main();
