/**
 * Verification harness for the review engine.
 *
 * There is no test framework in this project, and the thing worth testing is
 * whether a *planted* mistake comes back out of the log as the finding that
 * describes it. So this script drives the real `useGameStore` headlessly (the
 * same trick `scripts/verify-scorecard.ts` uses: the store neither imports React
 * nor needs a DOM, and its Dexie write fails in Node and is caught, so the
 * record is captured off a subscription instead of off the database) through
 * three scripted runs:
 *
 *   A — mistakes on purpose. A land held with none played on T3; T5 ending with
 *       four untapped lands and a two-drop in hand; a three-drop drawn on T2 and
 *       held to T9; a commander the land count covered on T4, cast on T7.
 *   B — played cleanly. Land every turn, commander on the first castable turn,
 *       hand emptied and lands tapped, so none of A's misses may appear.
 *   C — deployed into wraths at bracket 5, to exercise the overextension note
 *       whenever the pod actually casts one.
 *   D — a seat with a queued tax event eliminated before the player answers it.
 *       The pod's schedule is the seed's business and a canceled event cannot be
 *       planted through the store, so D's log is written by hand in the store's
 *       own payload shapes. It is built twice, once with the cancel and once
 *       without, and the only difference allowed in the two reviews is whether
 *       the tax suppressed that turn's mana-left finding.
 *   E — stopped mid-turn, the way a concede or lethal damage stops one. The last
 *       turn is still owed its land drop and its mana, so nothing may name it.
 *
 * The hand is staged card by card rather than left to the shuffle: a review
 * assertion about "the three-drop drawn on turn 2" needs that card to be a known
 * card, and the store is happy to move a named instance from library to hand.
 * Every auto-drawn card is trimmed out of hand within the turn it arrives, which
 * is sound because a turn's snapshot is taken when the *next* turn's log entry
 * is written, before that turn's draw step.
 *
 *   npx tsx scripts/verify-review.ts [seed]
 *
 * Failures are collected rather than thrown one at a time, so a bad run reports
 * everything wrong in a single pass. The process exits non-zero if any failed.
 */
import { cardsInZone, isLandCard, useGameStore } from '../src/state/gameStore.ts';
import { scoreRun } from '../src/engine/scorecard.ts';
import { reviewRun, type Review, type ReviewFinding } from '../src/engine/review.ts';
import { REVIEW } from '../src/data/review.ts';
import type {
  CardData,
  CardInstance,
  Deck,
  LogEntry,
  LogKind,
  Phase,
  RosterEntry,
  RunRecord,
  RunResult,
} from '../src/domain/types.ts';

const SEED = process.argv[2] ?? 'review-verify';
const TURNS = 9;

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

/**
 * Mana value 3, not 5. The commander's cost is what "castable by turn N" is
 * measured against, and a three-drop puts that turn inside a nine-turn script
 * with room for a gap on either side of it.
 */
const COMMANDER = card('cmd-warlord', 'Proving Ground Warlord', 3, 'Legendary Creature — Human Warrior');

const LAND = card('land-forest', 'Training Forest', 0, 'Basic Land — Forest');
const SCOUT = card('cr-scout', 'Grounds Scout', 1, 'Creature — Human Scout');
const WARDEN = card('cr-warden', 'Grounds Warden', 2, 'Creature — Human Soldier');
const RANGER = card('cr-ranger', 'Grounds Ranger', 3, 'Creature — Elf Ranger');
const COLOSSUS = card('cr-colossus', 'Grounds Colossus', 6, 'Creature — Golem');
const TITAN = card('cr-titan', 'Grounds Titan', 7, 'Creature — Giant');

const DECK_CARDS: { data: CardData; qty: number }[] = [
  { data: LAND, qty: 45 },
  { data: SCOUT, qty: 14 },
  { data: WARDEN, qty: 12 },
  { data: RANGER, qty: 12 },
  { data: COLOSSUS, qty: 10 },
  { data: TITAN, qty: 6 },
];

const CARD_DATA: Record<string, CardData> = { [COMMANDER.scryfallId]: COMMANDER };
for (const { data } of DECK_CARDS) CARD_DATA[data.scryfallId] = data;

function deckFor(bracket: Deck['bracket']): Deck {
  return {
    id: 'verify-review-deck',
    name: 'Review Verification',
    commanderIds: [COMMANDER.scryfallId],
    cards: DECK_CARDS.map(({ data, qty }) => ({ scryfallId: data.scryfallId, qty })),
    bracket,
    createdAt: 0,
    updatedAt: 0,
  };
}

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

const store = () => useGameStore.getState();

let capturedRun: RunRecord | null = null;

/**
 * Read the capture through a call. The subscription assigns to it from inside a
 * closure the compiler's flow analysis cannot see, so a direct read narrows to
 * `null` and every use of it looks unreachable.
 */
function lastCapturedRun(): RunRecord | null {
  return capturedRun;
}

useGameStore.subscribe((state) => {
  if (state.run) capturedRun = state.run;
});

/**
 * `endRun` persists through Dexie, which has no IndexedDB to talk to in Node, so
 * the write always fails here. The store catches it and the log entry that
 * matters is appended before the write is attempted — this only keeps the
 * expected complaint from burying the output.
 */
const passthroughError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('Failed to persist run')) return;
  passthroughError(...args);
};

function finishRun(result: RunResult): RunRecord {
  void store().endRun(result);
  const finished = lastCapturedRun();
  if (!finished) throw new Error('no run was captured off the store subscription');
  const end = finished.log[finished.log.length - 1];
  const endedAt = typeof end?.payload.endedAt === 'number' ? end.payload.endedAt : Date.now();
  return { ...finished, endedAt, result };
}

function handCards(): CardInstance[] {
  return cardsInZone(store(), 'hand');
}

function landsInHand(): CardInstance[] {
  const state = store();
  return cardsInZone(state, 'hand').filter((c) => isLandCard(state, c));
}

function landsOnBattlefield(): CardInstance[] {
  const state = store();
  return cardsInZone(state, 'battlefield').filter((c) => isLandCard(state, c));
}

/** Move one named card out of the library and into hand. Returns its iid. */
function stage(scryfallId: string): string {
  const found = cardsInZone(store(), 'library').find((c) => c.scryfallId === scryfallId);
  if (!found) throw new Error(`library ran out of ${scryfallId}`);
  store().moveCard(found.iid, 'hand');
  return found.iid;
}

/** Bin every card in hand that is not on the keep list, so the hand is scripted. */
function keepHandTo(keep: string[]): void {
  const kept = new Set(keep);
  for (const c of handCards()) {
    if (!kept.has(c.iid)) store().moveCard(c.iid, 'graveyard');
  }
}

/**
 * Deterministic answers to whatever the pod offers. Cards on `protectedIids`
 * are never handed over, so a resource attack cannot quietly remove the card an
 * assertion is about.
 */
function drain(protectedIids: Set<string> = new Set()): void {
  for (let guard = 0; guard < 60; guard++) {
    const event = store().activeEvent;
    if (!event) {
      if (store().clock) {
        store().declareInteraction();
        continue;
      }
      return;
    }
    if (event.type === 'resource' && event.variant === 'discard') {
      const fodder = handCards().find((c) => !protectedIids.has(c.iid));
      if (fodder) store().resolveActiveEvent({ discardIid: fodder.iid });
      else store().resolveActiveEvent();
      continue;
    }
    if (event.type === 'resource' && event.variant === 'sacrifice') {
      const state = store();
      const fodder = cardsInZone(state, 'battlefield').find(
        (c) => !c.isCommander && !isLandCard(state, c),
      );
      if (fodder) store().resolveActiveEvent({ sacrificeIid: fodder.iid });
      else store().resolveActiveEvent();
      continue;
    }
    store().resolveActiveEvent();
  }
  throw new Error('drain did not converge — the event queue never emptied');
}

/**
 * Put the commander on the table. A seat holding up interaction can catch the
 * cast; the script forces it through from the command zone afterwards, which is
 * the same thing a player does when they finally get it to stick.
 */
function castCommander(protectedIids: Set<string>): void {
  const commander = cardsInZone(store(), 'command').find((c) => c.isCommander);
  if (!commander) return;
  store().castCommander(commander.iid);
  drain(protectedIids);
  const stillOff = cardsInZone(store(), 'command').find((c) => c.isCommander);
  if (stillOff) store().moveCard(stillOff.iid, 'battlefield');
}

// ---------------------------------------------------------------------------
// Run A — the planted mistakes
// ---------------------------------------------------------------------------

interface Planted {
  record: RunRecord;
  rangerIid: string;
  wardenIid: string;
}

/**
 * A land is kept in hand from turn 1 onwards. It is the discard fodder that
 * keeps a resource attack away from the staged cards, and on turn 3 it is also
 * the land that makes the missed drop a missed drop rather than a dead hand.
 */
function playPlantedRun(seed: string): Planted {
  capturedRun = null;
  store().startRun(deckFor(1), CARD_DATA, seed);
  store().resolveMulligan([]);
  keepHandTo([]);

  let heldLand = stage(LAND.scryfallId);
  let rangerIid = '';
  let wardenIid = '';

  for (let turn = 1; turn <= TURNS; turn++) {
    const protectedIids = new Set([rangerIid, wardenIid].filter(Boolean));
    drain(protectedIids);

    // Turn 3 is the planted miss: a land is in hand and none is played.
    if (turn !== 3) {
      const spare = stage(LAND.scryfallId);
      store().moveCard(spare, 'battlefield');
    }
    if (landsInHand().length === 0) heldLand = stage(LAND.scryfallId);
    else heldLand = landsInHand()[0].iid;

    if (turn === 2) rangerIid = stage(RANGER.scryfallId);
    if (turn === 5) wardenIid = stage(WARDEN.scryfallId);
    if (turn === 7) castCommander(new Set([rangerIid, wardenIid].filter(Boolean)));

    const keep = [heldLand, rangerIid];
    if (turn === 5) keep.push(wardenIid);
    keepHandTo(keep.filter(Boolean));

    drain(new Set([rangerIid, wardenIid].filter(Boolean)));
    if (turn < TURNS) store().nextTurn();
  }

  return { record: finishRun('concede'), rangerIid, wardenIid };
}

// ---------------------------------------------------------------------------
// Run B — played cleanly
// ---------------------------------------------------------------------------

function playCleanRun(seed: string): RunRecord {
  capturedRun = null;
  store().startRun(deckFor(1), CARD_DATA, seed);
  store().resolveMulligan([]);
  keepHandTo([]);

  for (let turn = 1; turn <= TURNS; turn++) {
    drain();

    const land = stage(LAND.scryfallId);
    store().moveCard(land, 'battlefield');

    if (landsOnBattlefield().length >= COMMANDER.manaValue) castCommander(new Set());

    // Everything held gets spent or pitched, so nothing is ever stuck and no
    // nonland is in hand while lands are open.
    for (const c of handCards()) {
      store().moveCard(c.iid, 'battlefield');
      drain();
    }
    keepHandTo([]);

    // Tapping out is how a turn that used its mana is recorded.
    for (const c of landsOnBattlefield()) {
      if (!c.tapped) store().toggleTapped(c.iid);
    }

    drain();
    if (turn < TURNS) store().nextTurn();
  }

  return finishRun('win');
}

// ---------------------------------------------------------------------------
// Run C — deploy into whatever the pod casts
// ---------------------------------------------------------------------------

/**
 * Bracket 5, a fat permanent every turn and three cards permanently in hand, so
 * that any wrath the pod does cast lands on a turn the overextension note is
 * entitled to describe. Whether a wrath arrives at all is the seed's business,
 * so the assertion built on this run is an implication, not a demand.
 */
function playOverextendedRun(seed: string): RunRecord {
  capturedRun = null;
  store().startRun(deckFor(5), CARD_DATA, seed);
  store().resolveMulligan([]);
  keepHandTo([]);

  const ballast: string[] = [];

  for (let turn = 1; turn <= TURNS; turn++) {
    drain(new Set(ballast));

    const land = stage(LAND.scryfallId);
    store().moveCard(land, 'battlefield');

    if (turn >= 2) {
      const big = cardsInZone(store(), 'library').find(
        (c) => c.scryfallId === COLOSSUS.scryfallId || c.scryfallId === TITAN.scryfallId,
      );
      if (big) {
        store().moveCard(big.iid, 'hand');
        store().moveCard(big.iid, 'battlefield');
        drain(new Set(ballast));
      }
    }

    // Three cards held all game: the note needs two nonlands in hand and the
    // pod must not be able to strip them down below that.
    while (ballast.length < 3) ballast.push(stage(SCOUT.scryfallId));
    keepHandTo(ballast);

    drain(new Set(ballast));
    if (turn < TURNS) store().nextTurn();
  }

  return finishRun('loss');
}

// ---------------------------------------------------------------------------
// Run D — a queued tax that died with its seat
// ---------------------------------------------------------------------------

function rosterEntry(data: CardData): RosterEntry {
  return {
    scryfallId: data.scryfallId,
    name: data.name,
    manaValue: data.manaValue,
    typeLine: data.typeLine,
    isCommander: false,
  };
}

const TAX_LANDS = ['tax-l1', 'tax-l2', 'tax-l3', 'tax-l4'];
const TAX_SPELL = 'tax-s1';
/** The turn the seat holds, and the last turn the run finishes. */
const HELD_TURN = TAX_LANDS.length;

const TAX_ROSTER: Record<string, RosterEntry> = {
  ...Object.fromEntries(TAX_LANDS.map((iid) => [iid, rosterEntry(LAND)])),
  [TAX_SPELL]: rosterEntry(WARDEN),
};

/** The event as the store writes it, queued and then retired with its seat. */
const TAX_EVENT = {
  eventId: 'evt-tax-c',
  eventType: 'resource',
  seatId: 'C',
  eventTurn: 4,
  severity: { amount: 2 },
  variant: 'tax',
  state: 'queued',
};

/**
 * Four turns of land drops, a two-drop drawn on T4, and one seat holding T4
 * hostage: either a queued tax event or a counter armed by the window before the
 * turn. Nothing is tapped, so T4 ends with four lands open and a two-drop in
 * hand — mana left on the table, unless the review still believes the hold.
 *
 * `canceled` eliminates the seat before the player ever answers. Both holds are
 * built with it false as well, where the hold stands and the finding must not
 * appear: that is what makes each pair an assertion about the elimination rather
 * than about the fixture.
 */
function playHeldTurnRun(seed: string, hold: 'tax' | 'counter', canceled: boolean): RunRecord {
  const id = `verify-review-${hold}-${canceled ? 'canceled' : 'standing'}`;
  const log: LogEntry[] = [];
  let turn = 1;
  let phase: Phase = 'main1';

  function add(kind: LogKind, message: string, payload: Record<string, unknown>): void {
    log.push({ seq: log.length + 1, turn, phase, kind, message, payload, at: 0 });
  }

  function playLand(iid: string): void {
    add('move', `${LAND.name} → battlefield`, {
      iid,
      name: LAND.name,
      from: 'hand',
      to: 'battlefield',
    });
  }

  add('run', `Run started: Held Turn (seed ${seed})`, {
    runId: id,
    deckId: 'verify-review-deck',
    deckName: 'Held Turn',
    seed,
    bracket: 1,
    librarySize: TAX_LANDS.length + 1,
  });
  add('draw', `Drew ${TAX_LANDS.length}`, {
    iids: [...TAX_LANDS],
    names: TAX_LANDS.map(() => LAND.name),
    count: TAX_LANDS.length,
  });

  for (let i = 0; i < TAX_LANDS.length; i++) {
    if (i > 0) {
      const upcoming = i + 1;
      // The window runs before the turn entry and while the turn counter still
      // reads the turn that is ending, exactly as `beginNextTurn` writes it.
      if (hold === 'counter' && upcoming === HELD_TURN) {
        add('window', 'Seat C holds up interaction.', {
          window: 1,
          windowBeforeTurn: upcoming,
          counterArmed: { seatId: 'C', threshold: 2 },
          eventTypes: [],
        });
      }
      turn = upcoming;
      add('turn', `Turn ${turn}`, { turn, previousTurn: turn - 1 });
    }
    playLand(TAX_LANDS[i]);
  }

  // T4: the two-drop arrives, and seat C's hold is in front of it.
  add('draw', `Drew ${WARDEN.name}`, { iids: [TAX_SPELL], names: [WARDEN.name], count: 1 });
  if (hold === 'tax') add('event', `Seat C taxes you on turn ${turn}.`, { ...TAX_EVENT, queued: true });

  if (canceled) {
    add('threat', 'Seat C is out.', { seatId: 'C', reason: 'life', life: 0, threatAtDeath: 4 });
    if (hold === 'tax') {
      add('event', 'Seat C is out. Its pending resource is off the table.', {
        ...TAX_EVENT,
        canceled: true,
        reason: 'seat-eliminated',
      });
    } else {
      add('threat', 'Seat C is out. Nothing is held up any more.', {
        seatId: 'C',
        canceled: true,
        reason: 'seat-eliminated',
        threshold: 2,
      });
    }
  }

  turn = HELD_TURN + 1;
  add('turn', `Turn ${turn}`, { turn, previousTurn: HELD_TURN });
  add('run', 'Run ended: concede', { result: 'concede', endedAt: 0, turns: turn });

  return {
    id,
    deckId: 'verify-review-deck',
    deckName: 'Held Turn',
    seed,
    bracket: 1,
    startedAt: 0,
    endedAt: 0,
    result: 'concede',
    roster: TAX_ROSTER,
    log,
  };
}

// ---------------------------------------------------------------------------
// Run E — stopped mid-turn
// ---------------------------------------------------------------------------

/**
 * Land drops through T7, then a land and a one-drop held in hand while the last
 * two turns play nothing. Both turns look identical from the log: a land held
 * with none played, and every land open with a castable spell in hand. Only the
 * one the run finished may be named.
 */
function playUnfinishedRun(seed: string): RunRecord {
  capturedRun = null;
  store().startRun(deckFor(1), CARD_DATA, seed);
  store().resolveMulligan([]);
  keepHandTo([]);

  const lastPlayedTurn = TURNS - 2;
  let landIid = '';
  let scoutIid = '';

  for (let turn = 1; turn <= TURNS; turn++) {
    const held = new Set([landIid, scoutIid].filter(Boolean));
    drain(held);

    if (turn <= lastPlayedTurn) {
      const spare = stage(LAND.scryfallId);
      store().moveCard(spare, 'battlefield');
    }

    // From the turn before the drops stop, a land and a one-drop stay in hand.
    if (turn >= lastPlayedTurn) {
      if (!landIid || !handCards().some((c) => c.iid === landIid)) landIid = stage(LAND.scryfallId);
      if (!scoutIid || !handCards().some((c) => c.iid === scoutIid)) {
        scoutIid = stage(SCOUT.scryfallId);
      }
    }
    keepHandTo([landIid, scoutIid].filter(Boolean));

    drain(new Set([landIid, scoutIid].filter(Boolean)));
    if (turn < TURNS) store().nextTurn();
  }

  // No `nextTurn` and no end step: the run stops in the middle of TURNS.
  return finishRun('concede');
}

// ---------------------------------------------------------------------------
// Run F — a hate piece, and the three ways it can leave
// ---------------------------------------------------------------------------

const HATE_LANDS = ['hate-l1', 'hate-l2', 'hate-l3', 'hate-l4', 'hate-l5', 'hate-l6', 'hate-l7', 'hate-l8'];
const HATE_ROSTER: Record<string, RosterEntry> = Object.fromEntries(
  HATE_LANDS.map((iid) => [iid, rosterEntry(LAND)]),
);
const HATE_TURNS = HATE_LANDS.length;
/** The turn the piece lands, and the turn it leaves when it leaves at all. */
const HATE_TURN = 2;
const HATE_END_TURN = 7;
const HATE_CARD = 'Blood Moon';
const HATE_EVENT_ID = 'evt-hate-b';
const HATE_ID = `hz-${HATE_EVENT_ID}`;

type HateFate = 'stands' | 'removed' | 'removed-late' | 'swept';

/**
 * Eight turns of land drops with an empty hand — nothing else in the run is
 * worth a miss — and one hate piece on T2 that leaves four different ways:
 * never (it is still there when the run ends), to the player's own answer the
 * next turn, to the player's answer five turns later, or to a wrath on T7.
 *
 * It is written by hand for the same reason run D is: whether a seed offers a
 * hate piece at all is the pod's business, and no scripted run can make one seat
 * cast a piece and then meet all four fates. The payload shapes are the store's
 * own — `resolveActiveEvent`'s standing outcome, `removeHazard`'s respond entry,
 * and the 'threat' entry a sweep writes.
 */
function playHatePieceRun(seed: string, fate: HateFate): RunRecord {
  const id = `verify-review-hate-${fate}`;
  const log: LogEntry[] = [];
  let turn = 1;

  function add(kind: LogKind, message: string, payload: Record<string, unknown>, phase: Phase = 'main1'): void {
    log.push({ seq: log.length + 1, turn, phase, kind, message, payload, at: 0 });
  }

  add('run', `Run started: Hate Piece (seed ${seed})`, {
    runId: id,
    deckId: 'verify-review-deck',
    deckName: 'Hate Piece',
    seed,
    bracket: 3,
    librarySize: HATE_LANDS.length,
  });
  add('draw', `Drew ${HATE_LANDS.length}`, {
    iids: [...HATE_LANDS],
    names: HATE_LANDS.map(() => LAND.name),
    count: HATE_LANDS.length,
  });

  for (let i = 0; i < HATE_TURNS; i++) {
    if (i > 0) {
      turn = i + 1;
      add('turn', `Turn ${turn}`, { turn, previousTurn: turn - 1 });
    }
    add('move', `${LAND.name} → battlefield`, {
      iid: HATE_LANDS[i],
      name: LAND.name,
      from: 'hand',
      to: 'battlefield',
    });

    if (turn === HATE_TURN) {
      add('event', `Seat B casts ${HATE_CARD}. (${HATE_CARD} stands)`, {
        eventId: HATE_EVENT_ID,
        eventType: 'hate',
        seatId: 'B',
        eventTurn: HATE_TURN,
        card: HATE_CARD,
        cardEffect: 'Nonbasic lands are Mountains.',
        severity: {},
        resolved: true,
        outcome: { standing: true, hazardId: HATE_ID },
      });
    }

    const removalTurn = fate === 'removed' ? HATE_TURN + 1 : HATE_END_TURN;
    if ((fate === 'removed' || fate === 'removed-late') && turn === removalTurn) {
      add('respond', `Removed ${HATE_CARD} (Seat B) with Krosan Grip`, {
        reason: 'removed-hazard',
        hazardId: HATE_ID,
        eventId: HATE_EVENT_ID,
        seatId: 'B',
        cardName: HATE_CARD,
        spawnedTurn: HATE_TURN,
        turnsStanding: removalTurn - HATE_TURN,
        answerIid: 'hate-answer',
        answerName: 'Krosan Grip',
        answerZone: 'hand',
        answerTo: 'graveyard',
        answerMv: 3,
        bound: true,
      });
    }
    if (fate === 'swept' && turn === HATE_END_TURN) {
      add('threat', `${HATE_CARD} (Seat B) swept by Farewell`, {
        hazardId: HATE_ID,
        eventId: HATE_EVENT_ID,
        seatId: 'B',
        cardName: HATE_CARD,
        canceled: true,
        reason: 'wiped',
        byEventId: 'evt-wipe-1',
      });
    }
  }

  add('run', 'Run ended: concede', { result: 'concede', endedAt: 0, turns: turn }, 'end');

  return {
    id,
    deckId: 'verify-review-deck',
    deckName: 'Hate Piece',
    seed,
    bracket: 3,
    startedAt: 0,
    endedAt: 0,
    result: 'concede',
    roster: HATE_ROSTER,
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

function review(record: RunRecord): Review {
  return reviewRun(record, scoreRun(record));
}

function find(result: Review, code: string): ReviewFinding | undefined {
  return result.findings.find((f) => f.code === code);
}

function describe(result: Review): string[] {
  return result.findings.map(
    (f) =>
      `  ${f.kind.toUpperCase().padEnd(5)} ${(f.turns.length === 0 ? '' : `T${f.turns.join(',')}`).padEnd(8)} ${f.title}` +
      `\n        ${f.detail}\n        evidence seq ${f.evidence.join(', ') || '(none)'}`,
  );
}

/** Every finding must be able to point at the log entries it was derived from. */
function checkEvidence(label: string, result: Review, record: RunRecord): void {
  const seqs = new Set(record.log.map((entry) => entry.seq));
  for (const finding of result.findings) {
    check(
      `${label}: ${finding.code} carries evidence`,
      finding.evidence.length > 0 || finding.code === 'clock-beaten',
      'no seq numbers',
    );
    check(
      `${label}: ${finding.code} evidence points at real entries`,
      finding.evidence.every((seq) => seqs.has(seq)),
      `${finding.evidence.filter((seq) => !seqs.has(seq)).join(', ')} not in the log`,
    );
  }
}

function main(): void {
  const summary: string[] = [];

  // --- run A: the planted mistakes -----------------------------------------
  const planted = playPlantedRun(`${SEED}-a`);
  const cardA = scoreRun(planted.record);
  const a = review(planted.record);

  summary.push(`run A (bracket 1, ${TURNS} turns, ${planted.record.log.length} log entries)`);
  summary.push(...describe(a));

  const missed = find(a, 'land-drop');
  check('A: the missed land drop is reported', missed !== undefined, 'no land-drop finding');
  checkEqual('A: the missed land drop is T3', missed?.turns, [3]);
  checkEqual('A: the missed land drop is a miss', missed?.kind, 'miss');

  const manaLeft = find(a, 'mana-left');
  check('A: mana left on the table is reported', manaLeft !== undefined, 'no mana-left finding');
  check(
    'A: mana left on the table names T5',
    manaLeft?.turns.includes(5) ?? false,
    `turns ${manaLeft?.turns.join(', ') ?? 'none'}`,
  );
  check(
    'A: mana left on the table says colours are not checked',
    manaLeft?.detail.includes('colours not checked') ?? false,
    manaLeft?.detail ?? '',
  );

  const stuck = find(a, 'stuck-hand');
  check('A: the card stuck in hand is reported', stuck !== undefined, 'no stuck-hand finding');
  checkEqual('A: the stuck card was held T2 to T9', stuck?.turns, [2, TURNS]);
  check(
    'A: the stuck card is named',
    stuck?.title.includes(RANGER.name) ?? false,
    stuck?.title ?? '',
  );

  const late = find(a, 'commander-late');
  check('A: the late commander is reported', late !== undefined, 'no commander-late finding');
  checkEqual('A: castable T4, cast T7', late?.turns, [4, 7]);
  checkEqual('A: the commander actually landed on T7', cardA.deployment.firstCommanderCastTurn, 7);

  check(
    'A: no good is claimed for the land drops',
    find(a, 'land-drops-hit') === undefined,
    'land-drops-hit was emitted for a run that missed T3',
  );
  check(
    'A: no good is claimed for commander timing',
    find(a, 'commander-on-time') === undefined,
    'commander-on-time was emitted for a three-turn gap',
  );

  checkEqual('A: the footer is the honest-limits line', a.footer, REVIEW.footer);
  check(
    'A: the list is capped',
    a.findings.length <= REVIEW.maxFindings,
    `${a.findings.length} findings`,
  );
  checkEvidence('A', a, planted.record);

  // --- determinism ---------------------------------------------------------
  checkEqual('reviewing the same run twice is identical', review(planted.record), a);
  checkEqual(
    'reviewing the same record from a second scorecard is identical',
    reviewRun(planted.record, scoreRun(planted.record)),
    a,
  );

  // --- run B: played cleanly -----------------------------------------------
  const cleanRecord = playCleanRun(`${SEED}-b`);
  const cardB = scoreRun(cleanRecord);
  const b = review(cleanRecord);

  summary.push('');
  summary.push(`run B (bracket 1, ${TURNS} turns, ${cleanRecord.log.length} log entries)`);
  summary.push(...describe(b));

  for (const code of ['land-drop', 'mana-left', 'stuck-hand', 'commander-late']) {
    const found = b.findings.find((f) => f.code === code && f.kind === 'miss');
    check(`B: no ${code} miss`, found === undefined, found ? `${found.title} — ${found.detail}` : '');
  }
  check(
    'B: the land drops are credited',
    find(b, 'land-drops-hit') !== undefined,
    'no land-drops-hit good',
  );
  check(
    'B: the commander is credited as on time',
    find(b, 'commander-on-time') !== undefined,
    `first cast T${cardB.deployment.firstCommanderCastTurn}`,
  );
  check(
    'B: at most three goods',
    b.findings.filter((f) => f.kind === 'good').length <= REVIEW.maxGoods,
    `${b.findings.filter((f) => f.kind === 'good').length} goods`,
  );
  checkEvidence('B', b, cleanRecord);

  // --- run C: the overextension note ---------------------------------------
  const heavyRecord = playOverextendedRun(`${SEED}-c`);
  const cardC = scoreRun(heavyRecord);
  const c = review(heavyRecord);
  const landedWipes = cardC.wipes.filter((w) => !w.negated && w.turn >= 2);
  const qualifying = landedWipes.filter(
    (w) => (cardC.timeline[w.turn - 2]?.mvDeployed ?? 0) >= REVIEW.overextend.minMvDeployed,
  );

  summary.push('');
  summary.push(
    `run C (bracket 5, ${TURNS} turns, ${cardC.wipes.length} wipes, ${qualifying.length} of them into a deployed turn)`,
  );
  summary.push(...describe(c));

  const note = find(c, 'overextended');
  if (qualifying.length > 0) {
    check('C: the overextension note is reported', note !== undefined, 'no overextended finding');
    checkEqual('C: the note is a note, not a miss', note?.kind, 'note');
    check(
      'C: the note spans the deploy turn and the wrath turn',
      note !== undefined && qualifying.some((w) => note.turns[0] === w.turn - 1 && note.turns[1] === w.turn),
      `note turns ${note?.turns.join(', ') ?? 'none'} vs wraths T${qualifying.map((w) => w.turn).join(', T')}`,
    );
  } else {
    summary.push('  (no wrath landed after a deployed turn on this seed; the note is untested here)');
  }
  checkEvidence('C', c, heavyRecord);

  // --- run D: a hold that died with its seat -------------------------------
  for (const hold of ['tax', 'counter'] as const) {
    const canceledRecord = playHeldTurnRun(`${SEED}-d`, hold, true);
    const standingRecord = playHeldTurnRun(`${SEED}-d`, hold, false);
    const d = review(canceledRecord);
    const dStanding = review(standingRecord);

    summary.push('');
    summary.push(
      `run D (hand-written log, seat C's ${hold} on T${HELD_TURN} canceled by its elimination)`,
    );
    summary.push(...describe(d));

    const dMana = find(d, 'mana-left');
    check(
      `D/${hold}: mana left is still reported for the turn the dead seat had held`,
      dMana !== undefined,
      'the canceled hold suppressed the finding',
    );
    checkEqual(`D/${hold}: it names T${HELD_TURN} and nothing else`, dMana?.turns, [HELD_TURN]);
    check(
      `D/${hold}: the same run with the hold standing suppresses it`,
      find(dStanding, 'mana-left') === undefined,
      `mana-left named T${find(dStanding, 'mana-left')?.turns.join(', T') ?? '?'} with the hold live`,
    );
    checkEvidence(`D/${hold}`, d, canceledRecord);
  }

  // --- run E: stopped mid-turn ---------------------------------------------
  const unfinishedRecord = playUnfinishedRun(`${SEED}-e`);
  const e = review(unfinishedRecord);
  const endEntry = [...unfinishedRecord.log]
    .reverse()
    .find((entry) => entry.kind === 'run' && typeof entry.payload.result === 'string');

  summary.push('');
  summary.push(
    `run E (bracket 1, conceded in phase ${endEntry?.phase ?? '?'} of T${TURNS}, ${unfinishedRecord.log.length} log entries)`,
  );
  summary.push(...describe(e));

  check(
    'E: the run really did stop mid-turn',
    endEntry !== undefined && endEntry.phase !== 'end',
    `end phase ${endEntry?.phase ?? '(no end entry)'}`,
  );
  check(
    'E: the last finished turn is still graded',
    find(e, 'land-drop')?.turns.includes(TURNS - 1) ?? false,
    `land-drop turns ${find(e, 'land-drop')?.turns.join(', ') ?? 'none'}`,
  );
  for (const code of ['land-drop', 'mana-left']) {
    const found = e.findings.find((f) => f.code === code);
    check(
      `E: no ${code} finding names the unfinished T${TURNS}`,
      !(found?.turns.includes(TURNS) ?? false),
      `${found?.title ?? ''} — turns ${found?.turns.join(', ') ?? 'none'}`,
    );
  }
  checkEvidence('E', e, unfinishedRecord);

  // --- run F: the hate piece -----------------------------------------------
  const standing = playHatePieceRun(`${SEED}-f`, 'stands');
  const f = review(standing);
  const standingCard = scoreRun(standing);

  summary.push('');
  summary.push(
    `run F (hand-written log, ${HATE_CARD} standing from T${HATE_TURN} to the end of T${HATE_TURNS})`,
  );
  summary.push(...describe(f));

  const stood = find(f, 'hate-stood');
  check('F: the standing piece is reported', stood !== undefined, 'no hate-stood finding');
  checkEqual('F: it is a miss', stood?.kind, 'miss');
  checkEqual(
    'F: it says how long the piece stood',
    stood?.title,
    `${HATE_CARD} stood ${HATE_TURNS - HATE_TURN} turns`,
  );
  check(
    'F: the detail names the turn it landed and says nothing answered it',
    (stood?.detail.includes(`T${HATE_TURN}`) ?? false) && (stood?.detail.includes('No answer') ?? false),
    stood?.detail ?? '',
  );
  checkEqual('F: the scorecard agrees the piece stood', standingCard.hazards.stood, 1);
  checkEqual('F: and that nothing removed it', standingCard.hazards.removed, 0);
  checkEqual(
    'F: a piece still there at the end is measured to the last turn',
    standingCard.hazards.turnsStanding,
    [HATE_TURNS - HATE_TURN],
  );
  check(
    'F: no good is claimed for a piece nobody removed',
    find(f, 'hate-removed-fast') === undefined,
    'hate-removed-fast on a run that removed nothing',
  );
  checkEvidence('F', f, standing);

  const removed = playHatePieceRun(`${SEED}-f`, 'removed');
  const fRemoved = review(removed);
  const removedCard = scoreRun(removed);

  summary.push('');
  summary.push(`run F' (the same piece, removed on T${HATE_TURN + 1})`);
  summary.push(...describe(fRemoved));

  const quick = find(fRemoved, 'hate-removed-fast');
  check('F′: the quick removal is credited', quick !== undefined, 'no hate-removed-fast finding');
  checkEqual('F′: it is a good', quick?.kind, 'good');
  checkEqual(
    'F′: it names the piece',
    quick?.title,
    `Removed ${HATE_CARD} the turn after it landed`,
  );
  check(
    'F′: the detail names the card the player spent',
    quick?.detail.includes('Krosan Grip') ?? false,
    quick?.detail ?? '',
  );
  check(
    'F′: nothing is flagged for a piece that stood one turn',
    find(fRemoved, 'hate-stood') === undefined,
    'hate-stood on a piece removed the next turn',
  );
  checkEqual('F′: the scorecard counts the removal', removedCard.hazards.removed, 1);
  // The event still resolved: the player let the piece land and answered it
  // later, which is not an answer to the prompt the event made.
  checkEqual(
    'F′: the removal is not counted as an answer',
    removedCard.answers.byType.hate.responded,
    0,
  );
  checkEqual(
    'F′: the hate row keeps its resolved terminal',
    removedCard.events.find((e) => e.eventId === HATE_EVENT_ID)?.terminal,
    'resolved',
  );
  checkEvidence("F'", fRemoved, removed);

  // Removed, but five turns after it landed: the piece still sat there, so the
  // miss stands and the good is not earned.
  const lateRemoval = review(playHatePieceRun(`${SEED}-f`, 'removed-late'));
  check(
    'F″: a late removal earns no good',
    find(lateRemoval, 'hate-removed-fast') === undefined,
    'hate-removed-fast for a removal five turns on',
  );
  check(
    'F″: and the piece is still not flagged as unanswered',
    find(lateRemoval, 'hate-stood') === undefined,
    'hate-stood on a piece the player did remove',
  );

  // Swept by a wrath: the piece stood five turns and the player never dealt
  // with it, so it reads as a miss and says what took it.
  const sweptRecord = playHatePieceRun(`${SEED}-f`, 'swept');
  const swept = review(sweptRecord);
  const sweptStood = find(swept, 'hate-stood');
  check('F‴: a swept piece is still a miss', sweptStood !== undefined, 'no hate-stood finding');
  check(
    'F‴: and the detail says a wrath took it',
    sweptStood?.detail.includes('wrath') ?? false,
    sweptStood?.detail ?? '',
  );
  checkEqual('F‴: the scorecard counts the sweep', scoreRun(sweptRecord).hazards.swept, 1);

  // --- output --------------------------------------------------------------
  console.log('\nverify:review');
  console.log('─'.repeat(72));
  console.log(`seed base           ${SEED}`);
  console.log(`review version      ${a.version}`);
  console.log('─'.repeat(72));
  for (const line of summary) console.log(line);
  console.log('─'.repeat(72));

  if (failures.length > 0) {
    console.log(`${failures.length} check(s) FAILED:`);
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    throw new Error(`${failures.length} review check(s) failed`);
  }
  console.log('all checks passed');
}

main();
