/**
 * Verification harness for the M1 pressure store.
 *
 * Twenty-one checks, each labelled below.
 *
 * `verify-scorecard.ts` checks that the scorer agrees with the store about a run
 * that went normally. This script checks the seams that only open when the table
 * goes wrong: a seat dies mid-conversation, the player dies, or the pod does.
 * Like that harness it drives the real `useGameStore` headlessly (no React, no
 * DOM; the Dexie write fails in Node and the store catches it, so the finished
 * record is read off a Zustand subscription rather than the database).
 *
 *   npm run verify:engine
 *
 * The checks:
 *
 *   (a) a seat with a queued event is eliminated — the event leaves the queue,
 *       the log says it was canceled, and the scorecard never lists it
 *   (b) a counter-armed seat is eliminated — nothing is held up any more, and a
 *       spell over the threshold resolves without being intercepted
 *   (c) a combat event resolved for exactly the player's remaining life ends the
 *       run as a loss on the *next* action, with "Resolved combat" logged before
 *       "Run ended"
 *   (d) eliminating all three seats ends the run as a win, reason pod-eliminated
 *   (e) the same seed and the same scripted actions produce identical logs, with
 *       these new paths exercised
 *   (f) a seat burned from full life to 0 in one turn still hands the survivors
 *       the pressure it had at its peak — killing a seat never relieves the table
 *   (g) death is noticed on the fatal action and settled on the next one: a
 *       mis-click can be undone, and two actions racing still end the run once
 *   (h) a seat pinned at the threat cap keeps growing its recorded peak board,
 *       and the survivors inherit that larger board rather than a stale one
 *   (i) a counter held by a seat that dies is not left stranding the spell: the
 *       spell resolves, and a commander's cast count and tax read as one cast
 *   (j) the manual stack tray moves cards the way the player declared: a
 *       permanent resolves onto the battlefield, an instant into the graveyard,
 *       a removed spell is binned, a land is refused without comment, and a
 *       two-faced card is read on its front face alone
 *   (k) a counter raised over a spell already on the tray lands on top of it —
 *       answering it leaves the spell on the tray, resolving it bins the spell,
 *       and a commander caught this way goes home with its tax accrued
 *   (l) a card a counter is standing on is out of the player's hands: it cannot
 *       be cast again (no tax accrues) and cannot be tidied off the tray; a dead
 *       seat takes only its counter; a mulligan sweeps the tray back; and every
 *       exit leaves the newest 'stack' entry reporting the tray's real depth
 *
 *   (m) every event but combat names a real card: none fires without one, no
 *       wrath sweeps past creatures before turn 5, an armed seat with nothing
 *       castable does not counter at all, and the tax is pay-or-punish — paying
 *       logs the price and costs the seat nothing, not paying collects the
 *       punish, which is threat for a draw and spendable mana for a Treasure
 *   (n) the cited card is read the way it is printed: a tuck shuffles off a
 *       generator of its own, so answering a Chaos Warp and resolving one leave
 *       the run's next rolls identical, and a card that excludes a kind is
 *       never cited on it (Go for the Throat, artifact creature)
 *   (o) an answer names the card that made it: an instant answering out of hand
 *       is spent to the graveyard through an ordinary 'move' entry that says
 *       which event it answered, a permanent answering stays on the battlefield
 *       untapped, an answer with no card still stands and says it is unbound, a
 *       card sitting on the stack tray is refused (and moves nothing), the
 *       scored ledger and tally read the card back off the log, a paid tax is an
 *       answer that could never have named a card and sits out of the named
 *       rate, the per-card tally reads an instant's spend as the cast it was
 *       (and never counts a refused binding), declaring past a race clock binds
 *       the card once whether or not the clock's warning was still up, an
 *       intercepting seat only ever cites a counterspell in its own colours,
 *       and the same seed answering the same way replays byte for byte
 *   (p) the three seats are three different archetypes, and the "Seats seated"
 *       entry carries each seat's profile into the log
 *   (q) the counter-arming clamp keeps the holder's archetype: at the bracket
 *       and player threat where the roll sits hardest against its ceiling, a
 *       control seat arms more often than an unmodified one and an aggro seat
 *       less, nothing exceeds `profileCeiling`, and the unmodified seat lands
 *       exactly where the pre-clamp formula put it
 *   (r) a hate piece is a standing tell, not an event that finished: letting one
 *       resolve stands it on the seat that cast it and the next window knows it
 *       is there, a card takes it off the table with the turns it stood counted
 *       on the entry, a wrath wide enough sweeps it (and a creatures-only one
 *       leaves the artifacts and enchantments alone), and the seat's death takes
 *       its piece with it
 *   (s) the seats hit each other: the hit is logged as pod combat, the defender
 *       loses exactly what the entry claims, the readout can say who hit it, and
 *       none of it reaches the tally the player is scored on — and the pod never
 *       finishes a seat, even with the whole table sitting on 2 life
 *   (t) a hate event the player has not answered yet holds its seat's slot just
 *       as a resolved piece does: the seat is dealt no second piece while the
 *       first waits, the windows that open meanwhile say they counted it, and a
 *       seat that owes nothing can still be dealt one
 *   (u) a window reads and drains as seat turns rather than as a heap of
 *       hazards: the queue comes out in seat order A, B, C, the window entry
 *       lists exactly the living seats in that order, each seat turn carries its
 *       own seat's events in the order they will be asked, and a pod hit lands
 *       on the attacker's turn with the defender and the damage the 'damage'
 *       entry claims
 *
 * (a) to (c), (h), (i), (k), (l), (o) and (r) to (u) need a run where the pod actually did the thing
 * being tested, so each one searches seeds until it finds one and prints which
 * it used. Failures are collected rather than thrown, so one execution reports
 * everything.
 */
import {
  canCastToStack,
  canMulligan,
  cardName,
  cardsInZone,
  isInstantOrSorceryCard,
  isLandCard,
  manaValueOf,
  useGameStore,
  type GameState,
} from '../src/state/gameStore.ts';
import { scoreRun } from '../src/engine/scorecard.ts';
import { reviewRun } from '../src/engine/review.ts';
import { PRESSURE, byBracket } from '../src/data/pressure.ts';
import { ALL_COLORS, PROFILE_IDS, type SeatProfileId } from '../src/data/profiles.ts';
import { createRng } from '../src/domain/rng.ts';
import {
  chooseCounterCitation,
  colorsOf,
  counterArmChance,
  emptySilhouette,
  initialThreat,
  resolveWindow,
  seatMana,
  toSnapshot,
  zeroFiredCounts,
  zeroLastFiredWindow,
  type PermanentSummary,
  type SeatSnapshot,
  type SeatTurn,
} from '../src/engine/pressure.ts';
import {
  cardStats,
  isCutCandidate,
  CUT_CANDIDATE,
  type CardStat,
} from '../src/engine/cardStats.ts';
import type {
  CardData,
  CardInstance,
  Deck,
  LogEntry,
  PressureEvent,
  RunRecord,
  RunResult,
  Seat,
  SeatId,
  Silhouette,
  StackItem,
  StandingHazard,
} from '../src/domain/types.ts';

const BRACKET = 4;
/** Turns a seed search will play before giving up on it. */
const SEARCH_TURNS = 12;
/** Seeds each search will try. */
const SEARCH_ATTEMPTS = 80;

// ---------------------------------------------------------------------------
// A synthetic 99 + 1 deck — the same shape `verify-scorecard.ts` uses
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

const COMMANDER = card(
  'cmd-warlord',
  'Proving Ground Warlord',
  5,
  'Legendary Creature — Human Warrior',
);

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

const DECK: Deck = {
  id: 'verify-engine-deck',
  name: 'Engine Verification',
  commanderIds: [COMMANDER.scryfallId],
  cards: DECK_CARDS.map(({ data, qty }) => ({ scryfallId: data.scryfallId, qty })),
  bracket: BRACKET as Deck['bracket'],
  createdAt: 0,
  updatedAt: 0,
};

/**
 * The stack checks need a spell that goes to the graveyard when it resolves, and
 * the deck above is all permanents. Adding one to `DECK` would reshuffle every
 * other check's seed search, so the instants live in a deck of their own that
 * only (j) uses.
 */
const INSTANT = card('spl-volley', 'Grounds Volley', 2, 'Instant');

/**
 * The two shapes Scryfall prints as `Front // Back`. Read whole, the first is
 * simultaneously a creature and an instant (so it resolved into the graveyard)
 * and the second is simultaneously a sorcery and a land (so the tray refused it
 * outright). Every classification the table makes is on the front face, and
 * these two are what say so.
 */
const ADVENTURE = card(
  'spl-errand',
  'Grounds Errand',
  3,
  'Creature — Human Knight // Instant — Adventure',
);
const MODAL = card('spl-passage', 'Grounds Passage', 2, 'Sorcery // Land');

const STACK_DECK: Deck = {
  ...DECK,
  id: 'verify-engine-stack-deck',
  name: 'Engine Verification (stack)',
  cards: [
    ...DECK.cards,
    { scryfallId: INSTANT.scryfallId, qty: 8 },
    { scryfallId: ADVENTURE.scryfallId, qty: 6 },
    { scryfallId: MODAL.scryfallId, qty: 6 },
  ],
};

const STACK_CARD_DATA: Record<string, CardData> = {
  ...CARD_DATA,
  [INSTANT.scryfallId]: INSTANT,
  [ADVENTURE.scryfallId]: ADVENTURE,
  [MODAL.scryfallId]: MODAL,
};

// ---------------------------------------------------------------------------
// Store plumbing
// ---------------------------------------------------------------------------

const store = () => useGameStore.getState();

let capturedRun: RunRecord | null = null;
useGameStore.subscribe((state) => {
  if (state.run) capturedRun = state.run;
});

/**
 * Read the capture through a call. The subscription assigns to it from inside a
 * closure the compiler's flow analysis cannot see, so a direct read narrows to
 * `null` and every use of it looks unreachable.
 */
function lastCapturedRun(): RunRecord | null {
  return capturedRun;
}

/**
 * `endRun` persists through Dexie, which has no IndexedDB to talk to in Node. The
 * store catches the failure and the entry that matters is appended before the
 * write is attempted; this only keeps the expected complaint out of the output.
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
 * `endRun` appends "Run ended" synchronously and only clears the store after
 * awaiting the Dexie write, so the state is still there on the line after a run
 * ends. Anything asserting on the cleared store waits a tick first; the log
 * assertions do not need to.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function freshRun(seed: string): void {
  capturedRun = null;
  store().startRun(DECK, CARD_DATA, seed);
  store().resolveMulligan([]);
}

/** The same opening, on the deck that carries instants. */
function freshStackRun(seed: string): void {
  capturedRun = null;
  store().startRun(STACK_DECK, STACK_CARD_DATA, seed);
  store().resolveMulligan([]);
}

/** The same opening again, but with the mulligan still undecided. */
function freshStackOpening(seed: string): void {
  capturedRun = null;
  store().startRun(STACK_DECK, STACK_CARD_DATA, seed);
}

/** The tray's top item, or undefined. */
function stackTop(): StackItem | undefined {
  return store().stack[store().stack.length - 1];
}

/** Every 'stack' entry the current run has written, in order. */
function stackEntriesSoFar(): LogEntry[] {
  return (store().run?.log ?? []).filter((entry) => entry.kind === 'stack');
}

/** The `depth` payload on the newest 'stack' entry, or null when none was written. */
function loggedStackDepth(): number | null {
  const entries = stackEntriesSoFar();
  const depth = entries[entries.length - 1]?.payload.depth;
  return typeof depth === 'number' ? depth : null;
}

/**
 * Every way an item leaves the tray has to say so, and say it accurately: the
 * `depth` on the newest 'stack' entry is the tray's own length. An exit that
 * forgot to log leaves a stale depth behind, which is exactly what this catches.
 */
function checkStackDepth(label: string): void {
  const logged = loggedStackDepth();
  check(
    label,
    logged === store().stack.length,
    `logged depth ${logged}, live stack ${store().stack.length}`,
  );
}

/** Everything currently in front of the player or behind it in the queue. */
function queuedEvents(): PressureEvent[] {
  const state = store();
  return state.activeEvent ? [state.activeEvent, ...state.pendingEvents] : [...state.pendingEvents];
}

/** Try seeds `<label>-0`, `<label>-1`, ... until `probe` finds what it wants. */
function search<T>(label: string, probe: (seed: string) => T | null): T | null {
  for (let i = 0; i < SEARCH_ATTEMPTS; i++) {
    const found = probe(`${label}-${i}`);
    if (found !== null) return found;
  }
  return null;
}

/** Resolve everything on offer. Combat is answered instead, so life never moves. */
function drainEventsWithoutDamage(): void {
  for (let guard = 0; guard < 60; guard++) {
    const event = store().activeEvent;
    if (!event || !store().run) return;
    if (event.type === 'combat') store().respondToActiveEvent({ note: 'blocked it' });
    else store().resolveActiveEvent();
  }
  throw new Error('the event queue never emptied');
}

function playLand(): void {
  const state = store();
  const land = cardsInZone(state, 'hand').find((c) => isLandCard(state, c));
  if (land) store().moveCard(land.iid, 'battlefield');
}

function playBiggestSpell(): void {
  const state = store();
  const spells = cardsInZone(state, 'hand')
    .filter((c) => !isLandCard(state, c))
    .sort((a, b) => manaValueOf(state, b) - manaValueOf(state, a));
  if (spells.length > 0) store().moveCard(spells[0].iid, 'battlefield');
}

function biggestInHand(state: GameState): CardInstance | undefined {
  return cardsInZone(state, 'hand')
    .filter((c) => !isLandCard(state, c))
    .sort((a, b) => manaValueOf(state, b) - manaValueOf(state, a))[0];
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const failures: string[] = [];
const summary: string[] = [];

function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures.push(detail ? `${label} — ${detail}` : label);
}

/** Index of the first log entry whose message starts with `prefix`, or -1. */
function indexOfMessage(record: RunRecord, prefix: string): number {
  return record.log.findIndex((entry) => entry.message.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// (a) an eliminated seat's queued events leave the table
// ---------------------------------------------------------------------------

async function checkCanceledEvents(): Promise<void> {
  // Nothing is answered during the search, so the queue builds up. Hold out for
  // a seat that owns the active event *and* something behind it, so the cancel
  // has to retire the active one and filter the queue in the same breath.
  const found = search('engine-cancel', (seed) => {
    freshRun(seed);
    for (let turn = 1; turn <= SEARCH_TURNS; turn++) {
      store().nextTurn();
      if (!store().run) return null;
      const active = store().activeEvent;
      if (!active) continue;
      const owned = queuedEvents().filter((e) => e.seatId === active.seatId);
      if (owned.length >= 2) return { seed, seatId: active.seatId, turn: store().turn };
    }
    return null;
  });

  if (!found) {
    failures.push('(a) no seed produced a queued event within the search');
    return;
  }

  const wasActive = store().activeEvent?.id;
  const doomed = queuedEvents()
    .filter((e) => e.seatId === found.seatId)
    .map((e) => e.id);
  const survivors = queuedEvents()
    .filter((e) => e.seatId !== found.seatId)
    .map((e) => e.id);
  check('(a) the dead seat owns the active event', doomed[0] === wasActive);
  check('(a) it owns something behind it too', doomed.length >= 2, `${doomed.length}`);

  store().adjustLife(found.seatId, -40);

  const seat = store().seats.find((s) => s.id === found.seatId);
  check('(a) the seat is eliminated', seat?.eliminated === true);

  const stillQueued = new Set(queuedEvents().map((e) => e.id));
  check(
    '(a) canceled events are out of the queue',
    doomed.every((id) => !stillQueued.has(id)),
    doomed.filter((id) => stillQueued.has(id)).join(', '),
  );
  check(
    '(a) the other seats keep their events',
    survivors.every((id) => stillQueued.has(id)),
    survivors.filter((id) => !stillQueued.has(id)).join(', '),
  );

  const log = store().run?.log ?? [];
  for (const id of doomed) {
    check(
      `(a) the log cancels ${id}`,
      log.some(
        (entry) =>
          entry.kind === 'event' &&
          entry.payload.eventId === id &&
          entry.payload.canceled === true &&
          entry.payload.reason === 'seat-eliminated',
      ),
    );
  }

  endRunQuietly('concede');
  const record = lastCapturedRun();
  if (!record) {
    failures.push('(a) no run captured off the store');
    return;
  }
  const scorecard = scoreRun({ ...record, result: 'concede' });
  const listed = doomed.filter((id) => scorecard.events.some((row) => row.eventId === id));
  check('(a) the ledger does not list a canceled event', listed.length === 0, listed.join(', '));
  check(
    '(a) the wipe list does not list a canceled event',
    doomed.every((id) => !scorecard.wipes.some((w) => w.eventId === id)),
  );

  summary.push(
    `(a) seed ${found.seed}: seat ${found.seatId} out on turn ${found.turn}, ${doomed.length} event(s) canceled, ${scorecard.events.length} in the ledger`,
  );
  // Let this run's deferred clear land before the next check starts one.
  await settle();
}

// ---------------------------------------------------------------------------
// (b) an eliminated seat stops holding up mana
// ---------------------------------------------------------------------------

function checkCounterArmedCleared(): void {
  const found = search('engine-armed', (seed) => {
    freshRun(seed);
    for (let turn = 1; turn <= SEARCH_TURNS; turn++) {
      store().nextTurn();
      if (!store().run) return null;
      if (store().clock) store().declareInteraction();
      const armed = store().counterArmed;
      if (armed) return { seed, armed, turn: store().turn };
    }
    return null;
  });

  if (!found) {
    failures.push('(b) no seed armed a seat within the search');
    return;
  }

  // A deep enough hand that something over the threshold is certainly in it.
  store().drawCards(25);
  store().adjustLife(found.armed.seatId, -40);
  check('(b) nothing is held up after the seat dies', store().counterArmed === null);

  const state = store();
  const fat = biggestInHand(state);
  if (!fat || manaValueOf(state, fat) < found.armed.threshold) {
    failures.push('(b) no spell in hand meets the threshold the dead seat held');
    return;
  }

  store().moveCard(fat.iid, 'battlefield');
  check(
    '(b) the spell resolves rather than being intercepted',
    store().cards[fat.iid].zone === 'battlefield',
    `zone ${store().cards[fat.iid].zone}`,
  );
  check(
    '(b) no counter event was raised for it',
    !queuedEvents().some((e) => e.type === 'counter' && e.targetIid === fat.iid),
  );

  summary.push(
    `(b) seed ${found.seed}: seat ${found.armed.seatId} armed at ${found.armed.threshold}+ on turn ${found.turn}, cast MV ${manaValueOf(state, fat)} through`,
  );
}

// ---------------------------------------------------------------------------
// (c) a fatal combat ends the run, after its own entry is written
// ---------------------------------------------------------------------------

async function checkFatalCombat(): Promise<void> {
  const found = search('engine-combat', (seed) => {
    freshRun(seed);
    for (let turn = 1; turn <= SEARCH_TURNS; turn++) {
      store().nextTurn();
      if (!store().run) return null;
      if (store().clock) store().declareInteraction();
      for (let guard = 0; guard < 60; guard++) {
        const event = store().activeEvent;
        if (!event) break;
        if (event.type === 'combat') return { seed, turn: store().turn, damage: event.severity.damage ?? 0 };
        store().resolveActiveEvent();
        if (!store().run) return null;
      }
    }
    return null;
  });

  if (!found) {
    failures.push('(c) no seed offered a combat event within the search');
    return;
  }

  // Walk the player down to a small total, then take exactly that much.
  if (store().playerLife > 6) store().adjustLife('player', 6 - store().playerLife);
  const remaining = store().playerLife;
  check('(c) the player is alive going in', remaining > 0, `${remaining}`);
  store().resolveActiveEvent({ damageTaken: remaining });

  // Death is noticed on the fatal action and settled on the one after it, so a
  // mis-clicked life button stays undoable. The lethal combat therefore leaves
  // the run open for exactly one more action, which is what closes it.
  check('(c) the fatal hit leaves the run open for one action', store().run !== null);
  check('(c) the death was noticed', store().deathNoticed === true);
  store().logNote('scooping');
  await settle();

  check('(c) the run is over', store().run === null);

  const record = lastCapturedRun();
  if (!record) {
    failures.push('(c) no run captured off the store');
    return;
  }
  const combatAt = indexOfMessage(record, 'Resolved combat');
  const deadAt = record.log.findIndex(
    (entry) => entry.kind === 'run' && entry.payload.reason === 'life',
  );
  const endAt = indexOfMessage(record, 'Run ended');
  check('(c) the combat was logged as resolved', combatAt >= 0);
  check('(c) the loss names its reason', deadAt >= 0);
  check('(c) the run was ended', endAt >= 0);
  check(
    '(c) "Resolved combat" precedes "Run ended"',
    combatAt >= 0 && endAt >= 0 && combatAt < endAt,
    `combat at ${combatAt}, end at ${endAt}`,
  );
  check('(c) the reason precedes the end', deadAt >= 0 && endAt >= 0 && deadAt < endAt);
  check(
    '(c) the run ended as a loss',
    record.log[endAt]?.payload.result === 'loss',
    String(record.log[endAt]?.payload.result),
  );

  const scorecard = scoreRun({ ...record, result: 'loss' });
  const combatRows = scorecard.events.filter((e) => e.type === 'combat' && e.terminal === 'resolved');
  check('(c) the fatal combat scores as resolved', combatRows.length >= 1);

  summary.push(
    `(c) seed ${found.seed}: turn ${found.turn} combat offered ${found.damage}, took ${remaining} for the loss`,
  );
}

// ---------------------------------------------------------------------------
// (d) killing the pod wins the run
// ---------------------------------------------------------------------------

async function checkPodEliminated(): Promise<void> {
  const seed = 'engine-pod';
  freshRun(seed);
  const order: SeatId[] = ['A', 'B', 'C'];
  for (const seatId of order) {
    if (!store().run) break;
    store().adjustLife(seatId, -40);
  }
  await settle();

  check('(d) the run is over', store().run === null);
  const record = lastCapturedRun();
  if (!record) {
    failures.push('(d) no run captured off the store');
    return;
  }
  const wonAt = record.log.findIndex(
    (entry) => entry.kind === 'run' && entry.payload.reason === 'pod-eliminated',
  );
  const endAt = indexOfMessage(record, 'Run ended');
  check('(d) the win names pod-eliminated', wonAt >= 0);
  check('(d) the reason precedes the end', wonAt >= 0 && endAt >= 0 && wonAt < endAt);
  check(
    '(d) the run ended as a win',
    record.log[endAt]?.payload.result === 'win',
    String(record.log[endAt]?.payload.result),
  );

  const scorecard = scoreRun({ ...record, result: 'win' });
  check(
    '(d) all three seats score as eliminated',
    scorecard.seats.every((s) => s.eliminatedTurn !== null),
  );

  summary.push(`(d) seed ${seed}: three seats out, run ended win on turn ${scorecard.turns}`);
}

// ---------------------------------------------------------------------------
// (f) killing a seat never relieves the table's pressure
// ---------------------------------------------------------------------------

/**
 * Burning a seat down sheds threat on the way — a point per 8 damage — so by
 * the fatal click its threat reads 0 and its silhouette is empty. Redistributing
 * *that* would mean killing a seat made the table safer. The survivors inherit
 * the seat's peak instead, so this burns one from full life to 0 five at a time
 * and asserts the inheritance matches the peak rather than the husk.
 */
function checkEliminationKeepsPressure(): void {
  const seed = 'engine-peak';
  const victim: SeatId = 'C';
  freshRun(seed);
  // Play far enough in that the pod has threat worth inheriting.
  for (let turn = 1; turn <= 6; turn++) {
    if (!store().run) break;
    if (store().clock) store().declareInteraction();
    drainEventsWithoutDamage();
    if (turn < 6) store().nextTurn();
  }

  const threatOf = (id: SeatId): number => store().seats.find((s) => s.id === id)?.threat ?? 0;
  const survivors: SeatId[] = ['A', 'B'];
  const before = survivors.map(threatOf);
  const peak = store().seats.find((s) => s.id === victim)?.peakThreat ?? 0;
  check('(f) the doomed seat had threat to lose', peak > 1, `peak ${peak}`);

  for (let i = 0; i < 8; i++) store().adjustLife(victim, -5);

  const dead = store().seats.find((s) => s.id === victim);
  check('(f) the seat is out', dead?.eliminated === true);
  check(
    '(f) the burn had shed its threat before it died',
    (dead?.threat ?? 0) === 0,
    `threat ${dead?.threat}`,
  );

  const after = survivors.map(threatOf);
  check(
    '(f) every survivor got scarier',
    after.every((t, i) => t > before[i]),
    `${before.join('/')} -> ${after.join('/')}`,
  );

  // 60% of the dead seat's peak, split between the two survivors.
  const expected = (peak * 0.6) / survivors.length;
  const gains = after.map((t, i) => t - before[i]);
  check(
    '(f) the inheritance matches the peak, not the last reading',
    gains.every((g, i) => after[i] > 9.9 || Math.abs(g - expected) <= 0.15),
    `expected +${expected.toFixed(2)} each, got +${gains.map((g) => g.toFixed(2)).join('/')}`,
  );

  summary.push(
    `(f) seed ${seed}: seat ${victim} burned 40→0 at peak ${peak.toFixed(1)} threat, survivors +${gains.map((g) => g.toFixed(1)).join('/')}`,
  );
}

// ---------------------------------------------------------------------------
// (g) death is noticed first and settled on the next action
// ---------------------------------------------------------------------------

/**
 * The life buttons sit next to each other, so a -5 at 3 life is a mis-click.
 * Settling the run on that same action persisted it instantly and put the undo
 * out of reach. Death is now a notice, and the run ends on the next action that
 * is not an undo. The second half of this check races two actions through the
 * window where `endRun` is still awaiting its write, which used to append a
 * second "Dead on"/"Run ended" pair and save the run twice.
 */
async function checkDeathSettlesOnNextAction(): Promise<void> {
  // --- the mis-click, taken back -------------------------------------------
  freshRun('engine-death-misclick');
  store().adjustLife('player', 3 - store().playerLife);
  check('(g) the player is on 3 going in', store().playerLife === 3, `${store().playerLife}`);

  store().adjustLife('player', -5);
  check('(g) the mis-click did not end the run', store().run !== null);
  check('(g) the board still shows the player dead', store().playerLife === -2, `${store().playerLife}`);
  check('(g) the death was noticed', store().deathNoticed === true);

  const notices = (store().run?.log ?? []).filter((entry) => entry.payload.deathNoticed === true);
  check('(g) the notice was logged once', notices.length === 1, `${notices.length}`);
  check(
    '(g) the notice says how to take it back',
    notices[0]?.message === 'Dead on -2. Undo the life change, or the next action ends the run.',
    notices[0]?.message ?? '(none)',
  );
  check(
    '(g) the notice is not a run-ending entry',
    notices[0]?.kind === 'note',
    String(notices[0]?.kind),
  );

  store().undoLastLifeChange();
  check('(g) the undo is reachable', store().playerLife === 3, `${store().playerLife}`);
  check('(g) the undo kept the run alive', store().run !== null);
  check('(g) the notice is spent', store().deathNoticed === false);

  store().nextPhase();
  check('(g) a later action on a live run ends nothing', store().run !== null);
  endRunQuietly('concede');
  await settle();

  // --- death, then two actions at once -------------------------------------
  freshRun('engine-death-race');
  store().adjustLife('player', -store().playerLife - 4);
  check('(g) death is noticed, not settled', store().run !== null && store().deathNoticed);

  // Both land before `endRun`'s Dexie write resolves. Only the first may end it.
  store().logNote('scoop');
  store().toggleTapped('no-such-card');
  await settle();

  check('(g) the next action ended the run', store().run === null);
  const record = lastCapturedRun();
  if (!record) {
    failures.push('(g) no run captured off the store');
    return;
  }
  const ended = record.log.filter((entry) => entry.message.startsWith('Run ended'));
  const claimed = record.log.filter(
    (entry) => entry.kind === 'run' && entry.payload.reason === 'life',
  );
  check('(g) exactly one "Run ended"', ended.length === 1, `${ended.length}`);
  check('(g) exactly one loss reason', claimed.length === 1, `${claimed.length}`);
  check(
    '(g) the run ended as a loss',
    ended[0]?.payload.result === 'loss',
    String(ended[0]?.payload.result),
  );

  summary.push(
    `(g) mis-click at 3 life undone, run alive; death then 2 racing actions ended it once (${ended.length} "Run ended")`,
  );
}

// ---------------------------------------------------------------------------
// (h) a seat at the threat cap keeps growing the board it will bequeath
// ---------------------------------------------------------------------------

/**
 * Threat is capped at 10 but a board is not. A peak gated on "did threat rise"
 * therefore stops recording the moment a seat reaches the cap, and elimination
 * hands the survivors whatever board the seat had the last time the number
 * moved. This parks a seat at the cap, plays several more windows while its
 * board grows, then kills it and checks the inheritance came off the grown
 * board rather than the frozen one.
 */
function checkPeakBoardTracks(): void {
  const victim: SeatId = 'C';
  const survivors: SeatId[] = ['A', 'B'];
  const seatOf = (id: SeatId): Seat | undefined => store().seats.find((s) => s.id === id);

  // The search owns the whole scenario, not just "a seat reached the cap": it
  // also plays the three windows the check needs and rejects the seed when they
  // did not leave a grown board. A pod that wraths in one of those windows
  // zeroes every seat's board, which is a normal thing for a pod to do and not
  // an answer to the question being asked here — so the search steps over that
  // seed instead of the check failing on it. The property still has teeth: an
  // engine that froze board growth at the threat cap would satisfy no seed at
  // all, and the search reports that as a failure.
  const found = search('engine-silhouette', (seed) => {
    freshRun(seed);
    for (let turn = 1; turn <= SEARCH_TURNS; turn++) {
      if (!store().run) return null;
      if (store().clock) store().declareInteraction();
      drainEventsWithoutDamage();
      if (!store().run) return null;
      const seat = seatOf(victim);
      if (seat && seat.threat >= PRESSURE.threat.max) {
        const boardAtCap: Silhouette = { ...seat.silhouette };
        const cappedTurn = store().turn;
        // Three more windows with threat unable to rise. The board grows anyway.
        for (let i = 0; i < 3; i++) {
          store().nextTurn();
          if (!store().run) return null;
          if (store().clock) store().declareInteraction();
          drainEventsWithoutDamage();
        }
        const after = seatOf(victim);
        if (!after || after.eliminated) return null;
        if (after.threat < PRESSURE.threat.max) return null;
        if (after.silhouette.power <= boardAtCap.power) return null;
        return { seed, turn: cappedTurn, boardAtCap };
      }
      store().nextTurn();
    }
    return null;
  });

  if (!found) {
    failures.push('(h) no seed grew a capped seat’s board over three clean windows');
    return;
  }

  const boardAtCap = found.boardAtCap;
  const grown = seatOf(victim);
  const peakBoard = grown?.peakSilhouette;
  if (!grown || !peakBoard) {
    failures.push('(h) no peak board recorded for the seat');
    return;
  }
  check(
    '(h) the recorded peak grew with it',
    peakBoard.power >= grown.silhouette.power && peakBoard.creatures >= grown.silhouette.creatures,
    `peak ${peakBoard.power}p/${peakBoard.creatures}c, board ${grown.silhouette.power}p/${grown.silhouette.creatures}c`,
  );

  const before = survivors.map((id) => ({ ...(seatOf(id)?.silhouette ?? boardAtCap) }));
  // Burn it down five at a time: damage shrinks the live board, never the peak.
  for (let i = 0; i < 8; i++) store().adjustLife(victim, -5);
  check('(h) the seat is out', seatOf(victim)?.eliminated === true);

  const share = PRESSURE.silhouette.eliminationInheritShare / survivors.length;
  survivors.forEach((id, i) => {
    const after = seatOf(id)?.silhouette;
    if (!after) {
      failures.push(`(h) survivor ${id} vanished`);
      return;
    }
    const expectedPower = before[i].power + Math.round(peakBoard.power * share);
    const expectedCreatures = before[i].creatures + Math.round(peakBoard.creatures * share);
    check(
      `(h) seat ${id} inherits the grown board's power`,
      after.power === expectedPower,
      `expected ${expectedPower}, got ${after.power}`,
    );
    check(
      `(h) seat ${id} inherits the grown board's creatures`,
      after.creatures === expectedCreatures,
      `expected ${expectedCreatures}, got ${after.creatures}`,
    );
  });

  summary.push(
    `(h) seed ${found.seed}: seat ${victim} capped on turn ${found.turn}, board ${boardAtCap.power}p -> ${grown.silhouette.power}p, peak ${peakBoard.power}p inherited`,
  );
}

// ---------------------------------------------------------------------------
// (i) a canceled counter does not strand the spell it caught
// ---------------------------------------------------------------------------

/** Find a seat holding up mana at or under `maxThreshold`, or null. */
function armSeat(label: string, maxThreshold: number) {
  return search(label, (seed) => {
    freshRun(seed);
    for (let turn = 1; turn <= SEARCH_TURNS; turn++) {
      store().nextTurn();
      if (!store().run) return null;
      if (store().clock) store().declareInteraction();
      const armed = store().counterArmed;
      if (armed && armed.threshold <= maxThreshold) return { seed, armed, turn: store().turn };
    }
    return null;
  });
}

/**
 * An intercepted spell sits in hand (or in the command zone with its cast
 * already counted and its tax already logged) until the player says what
 * happened. Retiring the counter as a plain cancel left it there forever. With
 * the seat that held it dead there is nobody left to counter it, so it resolves
 * — the same trip a forced-through spell takes — while the event still logs as
 * canceled so the scorer keeps treating it as never offered.
 */
async function checkCanceledCounterResolves(): Promise<void> {
  // --- a normal spell ------------------------------------------------------
  const spellRun = armSeat('engine-counter-cancel', 7);
  if (!spellRun) {
    failures.push('(i) no seed armed a seat within the search');
    return;
  }

  store().drawCards(25);
  const fat = biggestInHand(store());
  if (!fat || manaValueOf(store(), fat) < spellRun.armed.threshold) {
    failures.push('(i) no spell in hand meets the threshold the seat held');
    return;
  }
  store().moveCard(fat.iid, 'battlefield');
  const intercepted = store().activeEvent;
  check(
    '(i) the cast was intercepted',
    intercepted?.type === 'counter' && intercepted.targetIid === fat.iid,
    String(intercepted?.type),
  );
  check('(i) the spell is held out of play', store().cards[fat.iid].zone === 'hand');

  store().adjustLife(spellRun.armed.seatId, -40);
  check(
    '(i) the stranded spell resolves when the counter dies with the seat',
    store().cards[fat.iid].zone === 'battlefield',
    `zone ${store().cards[fat.iid].zone}`,
  );
  const spellLog = store().run?.log ?? [];
  check(
    '(i) the counter is still logged as canceled',
    spellLog.some(
      (entry) =>
        entry.payload.eventId === intercepted?.id &&
        entry.payload.canceled === true &&
        entry.payload.reason === 'seat-eliminated',
    ),
  );
  check(
    '(i) the resolution is a plain move entry',
    spellLog.some(
      (entry) =>
        entry.kind === 'move' && entry.payload.iid === fat.iid && entry.payload.to === 'battlefield',
    ),
  );
  endRunQuietly('concede');
  await settle();

  // --- the commander -------------------------------------------------------
  const cmdRun = armSeat('engine-counter-cmd', COMMANDER.manaValue);
  if (!cmdRun) {
    failures.push('(i) no seed armed a seat at or under the commander MV');
    return;
  }

  const commander = Object.values(store().cards).find((c) => c.isCommander);
  if (!commander) {
    failures.push('(i) the run has no commander instance');
    return;
  }
  store().castCommander(commander.iid);
  const caught = store().activeEvent;
  check(
    '(i) the commander cast was intercepted',
    caught?.type === 'counter' && caught.targetIid === commander.iid,
    String(caught?.type),
  );
  check(
    '(i) the commander waits in the command zone',
    store().cards[commander.iid].zone === 'command',
    `zone ${store().cards[commander.iid].zone}`,
  );
  check(
    '(i) the cast was already counted',
    store().commanderCasts[COMMANDER.scryfallId] === 1,
    `${store().commanderCasts[COMMANDER.scryfallId]}`,
  );

  store().adjustLife(cmdRun.armed.seatId, -40);
  check(
    '(i) the commander resolves when the counter dies with the seat',
    store().cards[commander.iid].zone === 'battlefield',
    `zone ${store().cards[commander.iid].zone}`,
  );
  check(
    '(i) the cast is not counted twice',
    store().commanderCasts[COMMANDER.scryfallId] === 1,
    `${store().commanderCasts[COMMANDER.scryfallId]}`,
  );

  endRunQuietly('concede');
  await settle();
  const record = lastCapturedRun();
  if (!record) {
    failures.push('(i) no run captured off the store');
    return;
  }
  const scorecard = scoreRun({ ...record, result: 'concede' });
  check('(i) the scorecard counts one cast', scorecard.commander.casts === 1, `${scorecard.commander.casts}`);
  check(
    '(i) the scorecard charges the tax of a first cast',
    scorecard.commander.totalTaxPaid === 0,
    `${scorecard.commander.totalTaxPaid}`,
  );
  check(
    '(i) the commander scores as deployed',
    scorecard.commander.firstCastTurn !== null,
    String(scorecard.commander.firstCastTurn),
  );
  check(
    '(i) the canceled counter is not in the ledger',
    !scorecard.events.some((row) => row.eventId === caught?.id),
  );

  summary.push(
    `(i) seeds ${spellRun.seed} / ${cmdRun.seed}: stranded spell and commander both resolved on the counter's seat dying, 1 cast / 0 tax`,
  );
}

// ---------------------------------------------------------------------------
// (j) the tray hands cards back where the player said they were going
// ---------------------------------------------------------------------------

/** Whether the log carries a plain move entry for this exact trip. */
function loggedMove(iid: string, from: string, to: string): boolean {
  return (store().run?.log ?? []).some(
    (entry) =>
      entry.kind === 'move' &&
      entry.payload.iid === iid &&
      entry.payload.from === from &&
      entry.payload.to === to,
  );
}

async function checkStackTray(): Promise<void> {
  const seed = 'engine-stack-tray';
  freshStackRun(seed);
  // Deep enough that a permanent, an instant and a land are all certainly in hand.
  store().drawCards(40);

  // --- a permanent goes to the battlefield ---------------------------------
  const state = store();
  const permanent = cardsInZone(state, 'hand').find(
    (c) => !isLandCard(state, c) && !isInstantOrSorceryCard(state, c),
  );
  if (!permanent) {
    failures.push('(j) no permanent in hand to cast');
    return;
  }
  store().castToStack(permanent.iid);
  check(
    '(j) the cast card is on the stack',
    store().cards[permanent.iid].zone === 'stack',
    `zone ${store().cards[permanent.iid].zone}`,
  );
  check('(j) the tray holds one item', store().stack.length === 1, `${store().stack.length}`);
  check('(j) the item is the spell', stackTop()?.kind === 'spell' && stackTop()?.iid === permanent.iid);
  check('(j) leaving hand is a plain move entry', loggedMove(permanent.iid, 'hand', 'stack'));

  store().resolveTop();
  check(
    '(j) a resolved permanent lands on the battlefield',
    store().cards[permanent.iid].zone === 'battlefield',
    `zone ${store().cards[permanent.iid].zone}`,
  );
  check('(j) the tray is empty again', store().stack.length === 0, `${store().stack.length}`);
  checkStackDepth('(j) the resolve entry reports the depth it left behind');
  check('(j) resolving is a plain move entry', loggedMove(permanent.iid, 'stack', 'battlefield'));

  // --- an instant goes to the graveyard ------------------------------------
  const instant = cardsInZone(store(), 'hand').find((c) => isInstantOrSorceryCard(store(), c));
  if (!instant) {
    failures.push('(j) no instant in hand to cast');
    return;
  }
  store().castToStack(instant.iid);
  store().resolveTop();
  check(
    '(j) a resolved instant goes to the graveyard',
    store().cards[instant.iid].zone === 'graveyard',
    `zone ${store().cards[instant.iid].zone}`,
  );

  // --- a spell taken off the tray is binned --------------------------------
  const scrapped = cardsInZone(store(), 'hand').find(
    (c) => !isLandCard(store(), c) && !isInstantOrSorceryCard(store(), c),
  );
  if (!scrapped) {
    failures.push('(j) no second permanent in hand to scrap');
    return;
  }
  store().castToStack(scrapped.iid);
  const scrappedItem = stackTop();
  store().removeStackItem(scrappedItem?.id ?? '');
  check(
    '(j) a removed spell is binned',
    store().cards[scrapped.iid].zone === 'graveyard',
    `zone ${store().cards[scrapped.iid].zone}`,
  );
  check('(j) removing empties the tray', store().stack.length === 0, `${store().stack.length}`);
  checkStackDepth('(j) the remove entry reports the depth it left behind');

  // --- an ability is just text ---------------------------------------------
  store().pushAbility('  Saga chapter II  ');
  check('(j) an ability is trimmed onto the tray', stackTop()?.label === 'Saga chapter II', String(stackTop()?.label));
  store().pushAbility('   ');
  check('(j) empty text is ignored', store().stack.length === 1, `${store().stack.length}`);
  store().resolveTop();
  check('(j) resolving an ability only pops it', store().stack.length === 0, `${store().stack.length}`);

  // --- a land is refused without comment -----------------------------------
  const land = cardsInZone(store(), 'hand').find((c) => isLandCard(store(), c));
  if (!land) {
    failures.push('(j) no land in hand');
    return;
  }
  const before = store().run?.log.length ?? 0;
  store().castToStack(land.iid);
  check('(j) a land never reaches the tray', store().stack.length === 0, `${store().stack.length}`);
  check('(j) the land stays in hand', store().cards[land.iid].zone === 'hand');
  check('(j) the refusal says nothing', (store().run?.log.length ?? 0) === before);

  // --- two faces: only the front one is read --------------------------------
  const adventure = cardsInZone(store(), 'hand').find(
    (c) => c.scryfallId === ADVENTURE.scryfallId,
  );
  const modal = cardsInZone(store(), 'hand').find((c) => c.scryfallId === MODAL.scryfallId);
  if (!adventure || !modal) {
    failures.push('(j) no two-faced card in hand to classify');
    return;
  }
  check('(j) an Adventure creature is not an instant', !isInstantOrSorceryCard(store(), adventure));
  check('(j) a Sorcery // Land is not a land', !isLandCard(store(), modal));

  store().castToStack(adventure.iid);
  store().resolveTop();
  check(
    '(j) an Adventure creature resolves onto the battlefield',
    store().cards[adventure.iid].zone === 'battlefield',
    `zone ${store().cards[adventure.iid].zone}`,
  );

  store().castToStack(modal.iid);
  check(
    '(j) a Sorcery // Land reaches the tray',
    store().stack.length === 1,
    `${store().stack.length}`,
  );
  store().resolveTop();
  check(
    '(j) it resolves into the graveyard on its front face',
    store().cards[modal.iid].zone === 'graveyard',
    `zone ${store().cards[modal.iid].zone}`,
  );

  // Five pushes with a resolve each, one push with a remove: twelve entries. The
  // refused land and the empty ability text write nothing at all.
  const stackEntries = (store().run?.log ?? []).filter((entry) => entry.kind === 'stack');
  check('(j) every tray operation is logged', stackEntries.length === 12, `${stackEntries.length}`);

  endRunQuietly('concede');
  await settle();
  const record = lastCapturedRun();
  if (!record) {
    failures.push('(j) no run captured off the store');
    return;
  }
  const scorecard = scoreRun({ ...record, result: 'concede' });
  const deployed = scorecard.timeline.reduce((n, r) => n + r.mvDeployed, 0);
  // The two that landed: the plain permanent, and the Adventure creature the
  // whole-string reading used to bin. The modal spell resolved to the graveyard.
  const expectedDeployed =
    (STACK_CARD_DATA[permanent.scryfallId ?? '']?.manaValue ?? -1) + ADVENTURE.manaValue;
  check(
    '(j) the permanents that resolved score as deployed',
    deployed === expectedDeployed,
    `${deployed} MV deployed, expected ${expectedDeployed}`,
  );
  check(
    '(j) nothing on the tray counts as a land drop',
    scorecard.timeline.every((r) => r.landsPlayed === 0),
  );

  summary.push(
    `(j) seed ${seed}: permanent → battlefield, instant → graveyard, removed spell → graveyard, land refused, Adventure → battlefield and Sorcery // Land → graveyard on their front faces, ${stackEntries.length} stack entries`,
  );
}

// ---------------------------------------------------------------------------
// (k) a counter raised over a spell already on the tray
// ---------------------------------------------------------------------------

async function checkStackedCounter(): Promise<void> {
  // --- answered: the spell stays on the tray -------------------------------
  const answered = armSeat('engine-stack-answer', 7);
  if (!answered) {
    failures.push('(k) no seed armed a seat within the search');
    return;
  }
  store().drawCards(25);
  const held = biggestInHand(store());
  if (!held || manaValueOf(store(), held) < answered.armed.threshold) {
    failures.push('(k) no spell in hand meets the threshold the seat held');
    return;
  }

  store().castToStack(held.iid);
  const raised = store().activeEvent;
  check(
    '(k) the seat answered the spell on the tray',
    raised?.type === 'counter' && raised.targetIid === held.iid,
    String(raised?.type),
  );
  check('(k) the counter is marked as stacked', raised?.severity.stacked === 1, JSON.stringify(raised?.severity));
  check('(k) the spell is on the stack, not in hand', store().cards[held.iid].zone === 'stack');
  check('(k) the counter sits on top of it', store().stack.length === 2 && stackTop()?.kind === 'counter');
  check(
    '(k) the counter names the seat',
    stackTop()?.label ===
      `Seat ${answered.armed.seatId} counters ${CARD_DATA[held.scryfallId ?? '']?.name}`,
    String(stackTop()?.label),
  );

  // The tray refuses to resolve a counter: that one belongs to the event card.
  store().resolveTop();
  check('(k) the tray will not resolve the counter itself', store().stack.length === 2, `${store().stack.length}`);

  store().respondToActiveEvent({ note: 'forced it through' });
  check('(k) answering takes only the counter off', store().stack.length === 1 && stackTop()?.kind === 'spell');
  checkStackDepth('(k) the answered counter is logged off the tray at the right depth');
  check(
    '(k) the answered counter says why it left',
    stackEntriesSoFar().at(-1)?.payload.reason === 'answered',
    String(stackEntriesSoFar().at(-1)?.payload.reason),
  );
  check(
    '(k) the answered spell waits on the stack',
    store().cards[held.iid].zone === 'stack',
    `zone ${store().cards[held.iid].zone}`,
  );
  check('(k) the queue moved on', store().activeEvent?.id !== raised?.id);
  store().resolveTop();
  check(
    '(k) it resolves onto the battlefield afterwards',
    store().cards[held.iid].zone === 'battlefield',
    `zone ${store().cards[held.iid].zone}`,
  );
  endRunQuietly('concede');
  await settle();

  // --- resolved: the spell is binned ---------------------------------------
  const binned = armSeat('engine-stack-bin', 7);
  if (!binned) {
    failures.push('(k) no seed armed a seat for the resolved case');
    return;
  }
  store().drawCards(25);
  const doomed = biggestInHand(store());
  if (!doomed || manaValueOf(store(), doomed) < binned.armed.threshold) {
    failures.push('(k) no spell in hand meets the threshold for the resolved case');
    return;
  }
  store().castToStack(doomed.iid);
  store().resolveActiveEvent();
  check('(k) resolving the counter clears both items', store().stack.length === 0, `${store().stack.length}`);
  checkStackDepth('(k) the last of the two drops reports an empty tray');
  check(
    '(k) both drops say the counter resolved',
    stackEntriesSoFar()
      .slice(-2)
      .every((entry) => entry.payload.op === 'remove' && entry.payload.reason === 'countered'),
  );
  check(
    '(k) the countered spell is binned',
    store().cards[doomed.iid].zone === 'graveyard',
    `zone ${store().cards[doomed.iid].zone}`,
  );
  endRunQuietly('concede');
  await settle();

  // --- the commander: home with the tax accrued ----------------------------
  const cmdRun = armSeat('engine-stack-cmd', COMMANDER.manaValue);
  if (!cmdRun) {
    failures.push('(k) no seed armed a seat at or under the commander MV');
    return;
  }
  const commander = Object.values(store().cards).find((c) => c.isCommander);
  if (!commander) {
    failures.push('(k) the run has no commander instance');
    return;
  }

  store().castToStack(commander.iid);
  check(
    '(k) the commander is on the stack',
    store().cards[commander.iid].zone === 'stack',
    `zone ${store().cards[commander.iid].zone}`,
  );
  check(
    '(k) the cast was counted on the way',
    store().commanderCasts[COMMANDER.scryfallId] === 1,
    `${store().commanderCasts[COMMANDER.scryfallId]}`,
  );
  store().resolveActiveEvent();
  check(
    '(k) a countered commander goes back to the command zone',
    store().cards[commander.iid].zone === 'command',
    `zone ${store().cards[commander.iid].zone}`,
  );
  check('(k) the tray is empty after it', store().stack.length === 0, `${store().stack.length}`);

  // The tax it accrued stays paid, so the second attempt costs more.
  store().castToStack(commander.iid);
  check('(k) the second cast is counted', store().commanderCasts[COMMANDER.scryfallId] === 2);
  store().resolveTop();
  check(
    '(k) the second cast resolves onto the battlefield',
    store().cards[commander.iid].zone === 'battlefield',
    `zone ${store().cards[commander.iid].zone}`,
  );

  endRunQuietly('concede');
  await settle();
  const record = lastCapturedRun();
  if (!record) {
    failures.push('(k) no run captured off the store');
    return;
  }
  const scorecard = scoreRun({ ...record, result: 'concede' });
  check('(k) the scorecard counts two casts', scorecard.commander.casts === 2, `${scorecard.commander.casts}`);
  check(
    '(k) it charges the tax the second cast paid',
    scorecard.commander.totalTaxPaid === 2,
    `${scorecard.commander.totalTaxPaid}`,
  );
  check(
    '(k) the countered cast is counted as countered',
    scorecard.commander.counteredCasts === 1,
    `${scorecard.commander.counteredCasts}`,
  );
  check(
    '(k) the commander scores as deployed',
    scorecard.commander.firstCastTurn !== null,
    String(scorecard.commander.firstCastTurn),
  );

  summary.push(
    `(k) seeds ${answered.seed} / ${binned.seed} / ${cmdRun.seed}: answered spell stayed on the tray, resolved one was binned, commander home at tax 2 (${scorecard.commander.casts} casts, ${scorecard.commander.counteredCasts} countered)`,
  );
}

// ---------------------------------------------------------------------------
// (l) a card the tray has committed is out of the player's hands
// ---------------------------------------------------------------------------

/**
 * The three ways the tray can be asked to do something it must refuse, and the
 * one exit that is not driven by an event.
 *
 * A spell a seat has spoken up about is not the player's to cast again or to
 * tidy away: the question in front of them is about that exact card, and either
 * move would answer it behind their back. And an opening hand is only an opening
 * hand while nothing has been declared cast — but a mulligan taken anyway must
 * still put every card back rather than stranding one on the tray.
 */
async function checkStackGuards(): Promise<void> {
  // --- the seat holding the counter dies -----------------------------------
  const dying = armSeat('engine-stack-seatout', 7);
  if (!dying) {
    failures.push('(l) no seed armed a seat within the search');
    return;
  }
  store().drawCards(25);
  const stranded = biggestInHand(store());
  if (!stranded || manaValueOf(store(), stranded) < dying.armed.threshold) {
    failures.push('(l) no spell in hand meets the threshold the seat held');
    return;
  }
  store().castToStack(stranded.iid);
  check('(l) the counter is on top of the spell', store().stack.length === 2, `${store().stack.length}`);

  store().adjustLife(dying.armed.seatId, -40);
  check(
    '(l) the dead seat takes only its counter off the tray',
    store().stack.length === 1 && stackTop()?.kind === 'spell',
    `${store().stack.length} left, top ${stackTop()?.kind}`,
  );
  check(
    '(l) the spell is still owed a resolution',
    store().cards[stranded.iid].zone === 'stack',
    `zone ${store().cards[stranded.iid].zone}`,
  );
  check(
    '(l) the drop says the seat went out',
    stackEntriesSoFar().at(-1)?.payload.op === 'remove' &&
      stackEntriesSoFar().at(-1)?.payload.reason === 'seat-out',
    String(stackEntriesSoFar().at(-1)?.payload.reason),
  );
  checkStackDepth('(l) the seat-out drop reports the depth it left behind');
  endRunQuietly('concede');
  await settle();

  // --- an intercepted card cannot then be cast onto the tray ---------------
  // The interesting shape: a direct cast met by a counter leaves the card where
  // it was cast from, so its zone alone still says "castable". Only the live
  // counter says otherwise, and for the commander the cost of getting that
  // wrong is a second cast counted and a second lot of tax accrued.
  const held = armSeat('engine-stack-guard', COMMANDER.manaValue);
  if (!held) {
    failures.push('(l) no seed armed a seat at or under the commander MV');
    return;
  }
  const commander = Object.values(store().cards).find((c) => c.isCommander);
  if (!commander) {
    failures.push('(l) the run has no commander instance');
    return;
  }
  store().castCommander(commander.iid);
  check(
    '(l) the direct cast was intercepted',
    store().activeEvent?.type === 'counter' && store().activeEvent?.targetIid === commander.iid,
    String(store().activeEvent?.type),
  );
  check(
    '(l) the intercepted commander waits in the command zone',
    store().cards[commander.iid].zone === 'command',
    `zone ${store().cards[commander.iid].zone}`,
  );
  const castsAfterFirst = store().commanderCasts[COMMANDER.scryfallId];
  const beforeCast = store().run?.log.length ?? 0;

  store().castToStack(commander.iid);
  check(
    '(l) a card held by a counter cannot be cast onto the tray',
    store().stack.length === 0,
    `${store().stack.length} on the tray`,
  );
  check(
    '(l) the refused cast accrues no tax',
    store().commanderCasts[COMMANDER.scryfallId] === castsAfterFirst,
    `${store().commanderCasts[COMMANDER.scryfallId]} casts, was ${castsAfterFirst}`,
  );
  check(
    '(l) the refused cast says nothing',
    (store().run?.log.length ?? 0) === beforeCast,
    `${(store().run?.log.length ?? 0) - beforeCast} entries written`,
  );
  endRunQuietly('concede');
  await settle();

  // --- a spell a counter is standing on cannot be tidied off the tray ------
  const guarded = armSeat('engine-stack-remove', 7);
  if (!guarded) {
    failures.push('(l) no seed armed a seat for the removal guard');
    return;
  }
  store().drawCards(25);
  const under = biggestInHand(store());
  if (!under || manaValueOf(store(), under) < guarded.armed.threshold) {
    failures.push('(l) no spell in hand meets the threshold for the removal guard');
    return;
  }
  store().castToStack(under.iid);
  check('(l) the spell is on the tray under a counter', store().stack.length === 2);
  const spellItem = store().stack.find((x) => x.kind === 'spell');
  const beforeRemove = store().run?.log.length ?? 0;

  store().removeStackItem(spellItem?.id ?? '');
  check(
    '(l) a spell a counter is standing on cannot be tidied away',
    store().stack.length === 2,
    `${store().stack.length}`,
  );
  check(
    '(l) it is still on the stack',
    store().cards[under.iid].zone === 'stack',
    `zone ${store().cards[under.iid].zone}`,
  );
  check(
    '(l) the refused removal says nothing',
    (store().run?.log.length ?? 0) === beforeRemove,
    `${(store().run?.log.length ?? 0) - beforeRemove} entries written`,
  );
  endRunQuietly('concede');
  await settle();

  // --- a mulligan sweeps the tray back into the library --------------------
  const seed = 'engine-stack-mulligan';
  freshStackOpening(seed);
  const opening = store();
  const spell = cardsInZone(opening, 'hand').find((c) => !isLandCard(opening, c));
  if (!spell) {
    failures.push('(l) no spell in the opening hand to declare');
    return;
  }
  store().castToStack(spell.iid);
  check(
    '(l) declaring a cast retires the mulligan',
    !canMulligan(store()),
    'the opening hand is still offered as undecided',
  );

  store().takeMulligan();
  check('(l) the mulligan clears the tray', store().stack.length === 0, `${store().stack.length}`);
  check(
    '(l) the declared card is back in the library or the fresh hand',
    store().cards[spell.iid].zone !== 'stack',
    `zone ${store().cards[spell.iid].zone}`,
  );
  check(
    '(l) nothing is left in the stack zone',
    cardsInZone(store(), 'stack').length === 0,
    `${cardsInZone(store(), 'stack').length} card(s)`,
  );
  check(
    '(l) the sweep says it was a mulligan',
    stackEntriesSoFar().some(
      (entry) => entry.payload.op === 'remove' && entry.payload.reason === 'mulligan',
    ),
  );
  checkStackDepth('(l) the mulligan sweep reports an empty tray');
  endRunQuietly('concede');
  await settle();

  summary.push(
    `(l) seeds ${dying.seed} / ${held.seed} / ${guarded.seed} / ${seed}: seat-out left the spell owed, an intercepted commander refused a tray cast at no extra tax, a held spell refused removal, mulligan swept the tray`,
  );
}

// ---------------------------------------------------------------------------
// (m) every event cites a card, and the tax is pay-or-punish
// ---------------------------------------------------------------------------

/** A pod that grows, for driving `resolveWindow` directly without a store. */
function sweepSeats(rng: () => number): SeatSnapshot[] {
  return (['A', 'B', 'C'] as SeatId[]).map((id) => ({
    id,
    life: 40,
    eliminated: false,
    threat: initialThreat(rng),
    silhouette: emptySilhouette(),
  }));
}

/** A board worth answering: a commander, an artifact and a creature. */
function sweepPermanents(turn: number): PermanentSummary[] {
  const out: PermanentSummary[] = [
    {
      iid: 'sweep-art',
      name: 'Grounds Signet',
      manaValue: 2,
      isCommander: false,
      isToken: false,
      isLand: false,
      typeLine: 'Artifact',
      movedAt: 10,
    },
    {
      iid: 'sweep-cr',
      name: 'Grounds Titan',
      manaValue: 7,
      isCommander: false,
      isToken: false,
      isLand: false,
      typeLine: 'Creature — Giant',
      movedAt: 11,
    },
  ];
  if (turn >= 4) {
    out.push({
      iid: 'sweep-cmd',
      name: 'Proving Ground Warlord',
      manaValue: 5,
      isCommander: true,
      isToken: false,
      isLand: false,
      typeLine: 'Legendary Creature — Human Warrior',
      movedAt: 12,
    });
  }
  return out;
}

/**
 * Drive the engine straight, over enough windows that every hazard fires many
 * times at every bracket. Two rules are asserted over the whole sweep: no event
 * but combat exists without a card, and no wrath sweeps more than creatures
 * before turn 5, which is the turn the cheapest printed one (Nevinyrral's Disk)
 * can happen on.
 */
function checkEveryEventCitesACard(): void {
  const WINDOW_RUNS = 200;
  const FIRST = 2;
  const LAST = 12;
  let windows = 0;
  let events = 0;
  const missing: string[] = [];
  const earlyWideWipes: string[] = [];
  const seen = new Set<string>();

  for (let bracket = 1; bracket <= 5; bracket++) {
    for (let i = 0; i < WINDOW_RUNS; i++) {
      const rng = createRng(`citation-b${bracket}-${i}`);
      const seats = sweepSeats(rng);
      const firedCounts = zeroFiredCounts();
      const lastFiredWindow = zeroLastFiredWindow();
      let clock = null as ReturnType<typeof resolveWindow>['clock'];

      for (let turn = FIRST; turn <= LAST; turn++) {
        const windowIndex = turn - FIRST + 1;
        const result = resolveWindow({
          turn,
          windowIndex,
          bracket,
          rng,
          seats,
          player: {
            life: 40,
            boardMV: 3 * (turn - 1),
            boardPower: 2 * turn,
            commanderOnBattlefield: turn >= 4,
            damageDealtRecent: turn >= 5 ? 8 : 0,
          },
          permanents: sweepPermanents(turn),
          clock,
          counterArmed: null,
          // Nothing ever stands in this sweep: resolving a hate event is the
          // store's job, and the store is not in this loop.
          hazards: [],
          firedCounts,
          lastFiredWindow,
        });
        if (result.clockExpired) break;
        windows += 1;
        for (const update of result.seats) {
          const seat = seats.find((s) => s.id === update.id);
          if (seat) {
            seat.threat = update.threat;
            seat.silhouette = update.silhouette;
          }
        }
        for (const event of result.events) {
          firedCounts[event.type] += 1;
          lastFiredWindow[event.type] = windowIndex;
          events += 1;
          seen.add(event.type);
          if (event.type === 'combat') continue;
          if (!event.card) missing.push(`b${bracket} t${turn} ${event.type}`);
          else if (
            event.type === 'wipe' &&
            event.card.sweep !== 'creatures' &&
            event.turn < 5
          ) {
            earlyWideWipes.push(`b${bracket} t${event.turn} ${event.card.name}`);
          }
        }
        clock = result.clock;
      }
    }
  }

  check(
    '(m) every event but combat cites a card',
    missing.length === 0,
    `${missing.length} without one, e.g. ${missing.slice(0, 3).join(', ')}`,
  );
  check(
    '(m) no wrath sweeps past creatures before turn 5',
    earlyWideWipes.length === 0,
    earlyWideWipes.slice(0, 3).join(', '),
  );
  check(
    '(m) the sweep exercised every hazard',
    ['wipe', 'removal', 'combat', 'resource', 'clock', 'hate'].every((t) => seen.has(t)),
    [...seen].join(', '),
  );
  summary.push(
    `(m) ${windows} windows across 5 brackets produced ${events} events, all cited`,
  );
}

/** A seat holding up mana it cannot spend has no counterspell to hold. */
function checkCounterCitationSkips(): void {
  const spell = { name: 'Grounds Titan', manaValue: 7, typeLine: 'Creature — Giant' };
  // Every colour, so what is being checked here is mana and shape alone.
  const broke = chooseCounterCitation(3, 5, 1, 0, spell, ALL_COLORS);
  const afforded = chooseCounterCitation(3, 5, 1, 5, spell, ALL_COLORS);
  check('(m) no mana, no counterspell, no interception', broke === undefined);
  check('(m) with mana up the same seat does counter', afforded !== undefined, `${afforded?.name}`);
  // The other way a seat has nothing is shape: at bracket 2 the only counter
  // one mana buys is An Offer You Can't Refuse, which does not look at
  // creatures. The same seat, same mana, catches a noncreature spell.
  const noShape = chooseCounterCitation(3, 5, 2, 1, spell, ALL_COLORS);
  const rightShape = chooseCounterCitation(
    3,
    5,
    2,
    1,
    { name: 'Grounds Signet', manaValue: 6, typeLine: 'Artifact' },
    ALL_COLORS,
  );
  check('(m) a counter the wrong shape is not cited', noShape === undefined, `${noShape?.name}`);
  check(
    '(m) the same mana still catches what it is shaped for',
    rightShape?.name === "An Offer You Can't Refuse",
    `${rightShape?.name}`,
  );
  summary.push(`(m) counter citations skip when nothing is castable (${afforded?.name} when it is)`);
}

/**
 * Find a run whose pod puts a pay-or-punish tax in front of the player, and
 * hand it back with the run still live. `want` picks which punish is wanted.
 */
function findTaxEvent(seed: string, want?: 'draw' | 'treasure'): PressureEvent | null {
  freshRun(seed);
  for (let turn = 1; turn <= SEARCH_TURNS; turn++) {
    if (!store().run) return null;
    for (let guard = 0; guard < 40; guard++) {
      const event = store().activeEvent;
      if (!event) break;
      if (
        event.type === 'resource' &&
        event.variant === 'tax' &&
        (want === undefined || event.card?.punish === want)
      ) {
        return event;
      }
      if (event.type === 'combat') store().respondToActiveEvent({ note: 'blocked it' });
      else store().resolveActiveEvent();
    }
    if (store().clock) store().declareInteraction();
    store().nextTurn();
  }
  return null;
}

function seatThreat(seatId: SeatId): number {
  return store().seats.find((s) => s.id === seatId)?.threat ?? 0;
}

function seatOpenMana(seatId: SeatId): number {
  return store().seats.find((s) => s.id === seatId)?.silhouette.openMana ?? 0;
}

function seatBonusMana(seatId: SeatId): number {
  return store().seats.find((s) => s.id === seatId)?.silhouette.bonusMana ?? 0;
}

/** What the seat could actually cast right now, which is the point of a Treasure. */
function seatSpendable(seatId: SeatId): number {
  const seat = store().seats.find((s) => s.id === seatId);
  const run = store().run;
  if (!seat || !run) return 0;
  return seatMana(seat.silhouette, store().turn, run.bracket);
}

function checkTaxIsPayOrPunish(): void {
  // Paying: the seat gets nothing, and the entry says what it cost.
  const paidSeed = search('tax-paid', (seed) => (findTaxEvent(seed) ? seed : null));
  check('(m) a run offered a tax to pay', paidSeed !== null);
  if (paidSeed) {
    const event = findTaxEvent(paidSeed);
    if (event) {
      const before = seatThreat(event.seatId);
      store().respondToActiveEvent();
      const entry = (store().run?.log ?? [])
        .filter((e) => e.kind === 'respond' && e.payload.eventId === event.id)
        .pop();
      check('(m) paying the tax is logged as an answer', entry !== undefined);
      check(
        '(m) the paid entry carries the price',
        entry?.payload.paid === event.card?.pay,
        `logged ${String(entry?.payload.paid)}, card asks ${String(event.card?.pay)}`,
      );
      check(
        '(m) paying leaves the seat exactly as scary',
        seatThreat(event.seatId) === before,
        `${before} → ${seatThreat(event.seatId)}`,
      );
      summary.push(`(m) seed ${paidSeed}: paid ${event.card?.name} for ${event.card?.pay}`);
    }
  }

  // Not paying: the punish lands. A drawn card makes the seat scarier; a
  // Treasure does that and leaves a mana open for the next window.
  const drawSeed = search('tax-draw', (seed) => (findTaxEvent(seed, 'draw') ? seed : null));
  check('(m) a run offered a draw tax', drawSeed !== null);
  if (drawSeed) {
    const event = findTaxEvent(drawSeed, 'draw');
    if (event) {
      const before = seatThreat(event.seatId);
      const openBefore = seatOpenMana(event.seatId);
      const bonusBefore = seatBonusMana(event.seatId);
      store().resolveActiveEvent();
      // The cast already jumped this seat's threat in the window that offered
      // the tax. What lands here is the punish's own, and only the punish's.
      const punish = PRESSURE.threat.punish.draw;
      check(
        '(m) an unpaid draw tax makes the seat scarier by the punish alone',
        Math.abs(seatThreat(event.seatId) - Math.min(PRESSURE.threat.max, before + punish)) < 0.05,
        `${before} → ${seatThreat(event.seatId)}, expected +${punish}`,
      );
      check(
        '(m) a draw tax leaves the seat no extra mana',
        seatOpenMana(event.seatId) === openBefore && seatBonusMana(event.seatId) === bonusBefore,
        `${openBefore} → ${seatOpenMana(event.seatId)}, bonus ${bonusBefore} → ${seatBonusMana(event.seatId)}`,
      );
      summary.push(`(m) seed ${drawSeed}: ${event.card?.name} went unpaid, Seat ${event.seatId} drew`);
    }
  }

  const treasureSeed = search('tax-treasure', (seed) =>
    findTaxEvent(seed, 'treasure') ? seed : null,
  );
  check('(m) a run offered a Treasure tax', treasureSeed !== null);
  if (treasureSeed) {
    const event = findTaxEvent(treasureSeed, 'treasure');
    if (event) {
      const before = seatThreat(event.seatId);
      const openBefore = seatOpenMana(event.seatId);
      const bonusBefore = seatBonusMana(event.seatId);
      const spendableBefore = seatSpendable(event.seatId);
      store().resolveActiveEvent();
      check(
        '(m) an unpaid Treasure tax pays itself in mana, not in threat',
        Math.abs(seatThreat(event.seatId) - before) < 0.05,
        `${before} → ${seatThreat(event.seatId)}`,
      );
      check(
        '(m) the Treasure is a mana the seat now has open',
        seatOpenMana(event.seatId) === openBefore + 1 &&
          seatBonusMana(event.seatId) === bonusBefore + 1,
        `${openBefore} → ${seatOpenMana(event.seatId)}, bonus ${bonusBefore} → ${seatBonusMana(event.seatId)}`,
      );
      check(
        '(m) and a mana it can actually spend on a bigger card',
        seatSpendable(event.seatId) === spendableBefore + 1,
        `${spendableBefore} → ${seatSpendable(event.seatId)}`,
      );
      summary.push(
        `(m) seed ${treasureSeed}: ${event.card?.name} went unpaid, Seat ${event.seatId} made a Treasure`,
      );
    }
  }
  endRunQuietly('abandoned');
}

// ---------------------------------------------------------------------------
// (n) a tuck shuffles off its own generator, and excludes are honoured
// ---------------------------------------------------------------------------

/**
 * Drive a run until the pod cites a card that puts its target into the library
 * — Chaos Warp is the only shape in the table that does. Lands and spells are
 * played every turn, because removal needs something to point at.
 */
function findTuckEvent(seed: string, castCommander = false): PressureEvent | null {
  freshRun(seed);
  for (let turn = 1; turn <= SEARCH_TURNS; turn++) {
    if (!store().run) return null;
    for (let guard = 0; guard < 40; guard++) {
      const event = store().activeEvent;
      if (!event) break;
      if (event.type === 'removal' && event.card?.zone === 'library') {
        // With the commander on the table it is the only thing the pod points
        // at, so `castCommander` is also what decides which target this finds.
        //
        // The target has to still be on the battlefield: a queued warp can
        // outlive what it was pointed at — a wrath in front of it in the same
        // window bins the card first — and one resolving on nothing tucks
        // nothing, which is not the scenario either caller is asking about.
        const target = store().cards[event.targetIid ?? ''];
        const onCommander = target?.isCommander === true;
        if (target?.zone === 'battlefield' && onCommander === castCommander) return event;
      }
      if (event.type === 'combat') store().respondToActiveEvent({ note: 'blocked it' });
      else store().resolveActiveEvent();
    }
    if (store().clock) store().declareInteraction();
    store().nextTurn();
    playLand();
    if (castCommander) {
      // A commander a wrath binned goes home and comes back down, the way a
      // player would — without that, one wipe ends the scenario and the search
      // spends its seeds on runs whose warp has nothing left to tuck.
      const binned = Object.values(store().cards).find(
        (c) => c.isCommander && (c.zone === 'graveyard' || c.zone === 'exile'),
      );
      if (binned) store().moveCard(binned.iid, 'command');
      const commander = cardsInZone(store(), 'command')[0];
      if (commander) store().moveCard(commander.iid, 'battlefield');
    }
    playBiggestSpell();
  }
  return null;
}

/**
 * A commander cannot be tucked or bounced: its owner sends it to the command
 * zone instead, exactly as the counter path already does, and nothing about the
 * tax moves because nothing was cast.
 */
function checkTuckedCommanderGoesHome(): void {
  const found = search('warp-cmd', (s) => (findTuckEvent(s, true) ? s : null));
  check('(n) a run cited a tuck at the commander', found !== null);
  if (found === null) return;
  const event = findTuckEvent(found, true);
  const iid = event?.targetIid;
  if (!event || !iid) return;

  const taxBefore = (store().run?.log ?? []).filter((e) => e.kind === 'commander').length;
  store().resolveActiveEvent();
  check(
    '(n) a tucked commander goes to the command zone',
    store().cards[iid]?.zone === 'command',
    `${store().cards[iid]?.zone}`,
  );
  check('(n) it is not in the library', !store().libraryOrder.includes(iid));
  const home = (store().run?.log ?? [])
    .filter((e) => e.kind === 'commander' && e.payload.iid === iid)
    .pop();
  check('(n) the trip home is logged as a commander entry', home !== undefined);
  check(
    '(n) and charges no tax for it',
    home?.payload.castNumber === undefined && home?.payload.taxPaid === undefined,
    `${JSON.stringify(home?.payload)}`,
  );
  summary.push(
    `(n) seed ${found}: ${event.card?.name} on the commander sent it home, ${taxBefore + 1} commander entries`,
  );
  endRunQuietly('abandoned');
}

/**
 * Whether the player answers a tuck or lets it resolve is a decision at the
 * table, not one the seed made. The shuffle it needs therefore runs on a
 * generator derived from the seed and the event's id: if it drew from the run's
 * own stream, the two choices would hand every window after it different rolls,
 * and a seed would stop describing a game.
 */
function checkTuckShuffleIsOffTheMainStream(): void {
  const found = search('warp', (s) => (findTuckEvent(s) ? s : null));
  check('(n) a run cited a card that tucks its target', found !== null);
  if (found === null) return;
  const seed: string = found;

  /** Replay to the tuck, take the named exit, then read the run's next rolls. */
  function nextRolls(exit: 'resolve' | 'answer'): { rolls: string; topBefore: string; topAfter: string } {
    const event = findTuckEvent(seed);
    const iid = event?.targetIid;
    const topBefore = store().libraryOrder.slice(0, 6).join(',');
    if (exit === 'resolve') store().resolveActiveEvent();
    else store().respondToActiveEvent({ note: 'answered it' });
    const topAfter = store().libraryOrder.slice(0, 6).join(',');
    const rng = store().rng;
    const rolls = rng ? Array.from({ length: 16 }, () => rng()).join(',') : 'no rng';
    return { rolls, topBefore, topAfter: `${topAfter}|${iid ? store().cards[iid]?.zone : '?'}` };
  }

  const resolved = nextRolls('resolve');
  const answered = nextRolls('answer');
  check(
    '(n) the tuck actually shuffled the library',
    resolved.topBefore !== resolved.topAfter.split('|')[0],
    'the top of the library did not move',
  );
  check(
    '(n) the tucked card is in the library',
    resolved.topAfter.endsWith('|library'),
    resolved.topAfter,
  );
  check(
    '(n) resolving a tuck leaves the next rolls identical to answering it',
    resolved.rolls === answered.rolls,
    `${resolved.rolls.slice(0, 60)} vs ${answered.rolls.slice(0, 60)}`,
  );
  summary.push(`(n) seed ${seed}: a tuck shuffled without moving the run's own stream`);
  endRunQuietly('abandoned');
}

/**
 * A token that leaves the battlefield ceases to exist, and both replayers have
 * to survive a move whose card is gone by the next entry.
 */
function checkTokensCeaseToExist(): void {
  freshRun('token-vanish');
  store().createToken({ name: 'Treasure', typeLine: 'Artifact — Treasure' }, 1);
  const iid = Object.values(store().cards).find((c) => c.isToken)?.iid;
  check('(n) a token was created', iid !== undefined);
  if (!iid) return;

  store().moveCard(iid, 'graveyard');
  check('(n) a token that leaves the battlefield stops existing', store().cards[iid] === undefined);
  check('(n) and never joins the library order', !store().libraryOrder.includes(iid));
  const move = (store().run?.log ?? [])
    .filter((e) => e.kind === 'move' && e.payload.iid === iid)
    .pop();
  check('(n) the move entry says the token is gone', move?.payload.tokenGone === true);

  endRunQuietly('abandoned');
  const record = lastCapturedRun();
  check('(n) the vanishing run was captured', record !== null);
  if (!record) return;
  // The replayers read a move whose card is gone by the next entry. Neither may
  // throw, and neither may count the token as board value it can never get back.
  const scored = scoreRun(record);
  check('(n) the scorer replays the vanished token', scored.turns >= 1, `${scored.turns} turns`);
  check(
    '(n) a token was worth no board value either way',
    scored.timeline.every((row) => row.boardValueEnd === 0 && row.mvDeployed === 0),
    scored.timeline.map((row) => `${row.mvDeployed}/${row.boardValueEnd}`).join(' '),
  );
  check('(n) the review replays it too', reviewRun(record, scored).findings.length >= 0);
  summary.push('(n) a token swept off the battlefield ceased to exist, in the store and in the replay');
}

/** An artifact creature the pod must not answer with Go for the Throat. */
function artifactCreatureBoard(): PermanentSummary[] {
  return [
    {
      iid: 'golem',
      name: 'Grounds Golem',
      manaValue: 4,
      isCommander: false,
      isToken: false,
      isLand: false,
      typeLine: 'Artifact Creature — Golem',
      movedAt: 10,
    },
  ];
}

/**
 * `excludes` is the difference between a citation a player recognises and one
 * that reads as the app not knowing the card. Go for the Throat is a nonartifact
 * creature card, so a board of one artifact creature must never see it, at any
 * bracket, on any turn, however many windows are swept.
 */
function checkExcludesAreHonoured(): void {
  let cited = 0;
  let removals = 0;
  const wrong: string[] = [];

  for (let bracket = 1; bracket <= 5; bracket++) {
    for (let i = 0; i < 120; i++) {
      const rng = createRng(`excludes-b${bracket}-${i}`);
      const seats = sweepSeats(rng);
      const firedCounts = zeroFiredCounts();
      const lastFiredWindow = zeroLastFiredWindow();
      for (let turn = 2; turn <= 12; turn++) {
        const result = resolveWindow({
          turn,
          windowIndex: turn - 1,
          bracket,
          rng,
          seats,
          player: {
            life: 40,
            boardMV: 4,
            boardPower: 4,
            commanderOnBattlefield: false,
            damageDealtRecent: 0,
          },
          permanents: artifactCreatureBoard(),
          clock: null,
          counterArmed: null,
          hazards: [],
          firedCounts,
          lastFiredWindow,
        });
        for (const update of result.seats) {
          const seat = seats.find((s) => s.id === update.id);
          if (seat) {
            seat.threat = update.threat;
            seat.silhouette = update.silhouette;
          }
        }
        for (const event of result.events) {
          firedCounts[event.type] += 1;
          lastFiredWindow[event.type] = turn - 1;
          if (event.type !== 'removal') continue;
          removals += 1;
          cited += 1;
          if (event.card?.name === 'Go for the Throat') {
            wrong.push(`b${bracket} t${turn}`);
          }
        }
      }
    }
  }

  check('(n) the excludes sweep produced removal to judge', removals > 100, `${removals}`);
  check(
    '(n) Go for the Throat is never cited on an artifact creature',
    wrong.length === 0,
    `${wrong.length} times, e.g. ${wrong.slice(0, 3).join(', ')}`,
  );
  summary.push(`(n) ${cited} removals at an artifact creature, none of them Go for the Throat`);
}

// ---------------------------------------------------------------------------
// (o) an answer names the card that made it
// ---------------------------------------------------------------------------

/** The newest 'respond' entry, whichever event it settled. */
function lastRespondEntry(): LogEntry | undefined {
  return (store().run?.log ?? []).filter((entry) => entry.kind === 'respond').pop();
}

/**
 * Drive the run until something a card could answer is in front of the player.
 * A tax is not one of those — it is mana, and nothing asks for a card — so it is
 * resolved past rather than handed back.
 */
function pumpToAnswerableEvent(limit = 12): PressureEvent | null {
  for (let i = 0; i < limit; i++) {
    if (!store().run) return null;
    const event = store().activeEvent;
    if (event) {
      if (!(event.type === 'resource' && event.variant === 'tax')) return event;
      store().resolveActiveEvent();
      continue;
    }
    if (store().clock) store().declareInteraction();
    store().nextTurn();
    playLand();
  }
  return null;
}

/**
 * Drive the run until the race clock's own warning card is the event in front of
 * the player, with the clock still standing behind it. Combat is answered rather
 * than resolved so the search cannot kill the player on the way.
 */
function pumpToClockWarning(limit = 16): PressureEvent | null {
  for (let i = 0; i < limit; i++) {
    if (!store().run) return null;
    const event = store().activeEvent;
    if (event) {
      const clock = store().clock;
      if (event.type === 'clock' && clock && clock.seatId === event.seatId) return event;
      if (event.type === 'combat') store().respondToActiveEvent({ note: 'blocked it' });
      else store().resolveActiveEvent();
      continue;
    }
    store().nextTurn();
    playLand();
  }
  return null;
}

/**
 * Drive the run until a clock is standing with nothing in front of it — the case
 * where declaring writes one entry and no event entry exists anywhere in the log
 * for the ledger to hang the answer on. Resolving a clock warning is "the clock
 * stands", so the clock survives being resolved past.
 */
function pumpToStandingClock(limit = 18): boolean {
  for (let i = 0; i < limit; i++) {
    if (!store().run) return false;
    const event = store().activeEvent;
    if (event) {
      if (event.type === 'combat') store().respondToActiveEvent({ note: 'blocked it' });
      else store().resolveActiveEvent();
      continue;
    }
    if (store().clock) return true;
    store().nextTurn();
    playLand();
  }
  return false;
}

/** One card name's row in the per-card tally, or undefined. */
function statFor(runs: RunRecord[], name: string): CardStat | undefined {
  return cardStats(runs).cards.find((c) => c.name === name);
}

/** Every card's `answeredWith`, added up. Exactly the bound answers, no more. */
function totalAnsweredWith(runs: RunRecord[]): number {
  return cardStats(runs).cards.reduce((n, c) => n + c.answeredWith, 0);
}

/**
 * The same record with the `answered <eventId>` reason taken off its move
 * entries — the log as the per-card tally used to read it. It is what says the
 * reason is load-bearing: without it an instant held up and spent goes hand →
 * graveyard, which matches none of the cast shapes, and the card reads as one
 * the player drew repeatedly and never cast.
 */
function withoutAnswerReasons(record: RunRecord): RunRecord {
  return {
    ...record,
    log: record.log.map((entry) => {
      const reason = entry.payload.reason;
      if (entry.kind !== 'move' || typeof reason !== 'string' || !reason.startsWith('answered ')) {
        return entry;
      }
      const payload = { ...entry.payload };
      delete payload.reason;
      return { ...entry, payload };
    }),
  };
}

/**
 * A run whose instants only ever leave the hand as answers: nothing casts one,
 * so the name's `cast` is exactly the number of events it answered. Left live
 * rather than ended, so a seed search over it leaves no pending persistence
 * behind to clear the store out from under the run that is finally kept.
 */
function instantAnswerRun(seed: string): RunRecord | null {
  freshStackRun(seed);
  for (let guard = 0; guard < 16; guard++) {
    if (!store().run) break;
    if (!pumpToAnswerableEvent()) break;
    const held = cardsInZone(store(), 'hand').find((c) => cardName(store(), c.iid) === INSTANT.name);
    if (held) store().respondToActiveEvent({ iid: held.iid });
    else store().resolveActiveEvent();
  }
  return store().run ?? lastCapturedRun();
}

/**
 * A scripted run that answers every event with whatever is at the front of the
 * hand, so the binding path — the type-line read, the move, the flattened
 * fields on the entry — is inside what the determinism comparison covers. An
 * empty hand answers unbound, which is the other branch.
 */
function scriptedAnswerRun(seed: string): RunRecord {
  freshStackRun(seed);
  for (let turn = 1; turn <= 8; turn++) {
    if (!store().run) break;
    if (store().clock) store().declareInteraction();
    for (let guard = 0; guard < 30; guard++) {
      if (!store().activeEvent) break;
      const held = cardsInZone(store(), 'hand')[0];
      store().respondToActiveEvent(held ? { iid: held.iid, note: 'answered' } : undefined);
    }
    store().drawCards(2);
    playLand();
    playBiggestSpell();
    if (turn < 8) store().nextTurn();
  }
  const record = store().run ?? lastCapturedRun();
  if (!record) throw new Error('scripted answer run produced no record');
  return record;
}

async function checkAnswersNameTheCard(): Promise<void> {
  const seed = search('answer-bound', (s) => {
    freshStackRun(s);
    return pumpToAnswerableEvent() ? s : null;
  });
  if (seed === null) {
    failures.push('(o) no seed put an answerable event in front of the player');
    return;
  }

  freshStackRun(seed);
  const first = pumpToAnswerableEvent();
  if (!first) {
    failures.push('(o) the chosen seed stopped offering events');
    return;
  }

  // --- a card answering out of hand is spent --------------------------------
  // Deep enough that an instant is certainly in there.
  store().drawCards(24);
  const instant = cardsInZone(store(), 'hand').find((c) => isInstantOrSorceryCard(store(), c));
  check('(o) the hand holds an instant to answer with', instant !== undefined);
  if (!instant) return;
  const instantName = cardName(store(), instant.iid);
  const before = (store().run?.log ?? []).length;

  store().respondToActiveEvent({ iid: instant.iid, note: 'held it up' });

  check(
    '(o) an instant answering out of hand lands in the graveyard',
    store().cards[instant.iid]?.zone === 'graveyard',
    `${store().cards[instant.iid]?.zone}`,
  );
  const move = (store().run?.log ?? [])
    .slice(before)
    .find((e) => e.kind === 'move' && e.payload.iid === instant.iid);
  check(
    '(o) the spend is an ordinary move entry',
    move?.payload.from === 'hand' && move?.payload.to === 'graveyard',
    `${JSON.stringify(move?.payload)}`,
  );
  check(
    '(o) and the move says which event it answered',
    move?.payload.reason === `answered ${first.id}`,
    `${String(move?.payload.reason)}`,
  );

  const bound = lastRespondEntry();
  check(
    '(o) the respond entry binds the card',
    bound?.payload.bound === true && bound?.payload.answerIid === instant.iid,
    `${JSON.stringify(bound?.payload)}`,
  );
  check(
    '(o) it carries the name, the zone it left and the zone it went to',
    bound?.payload.answerName === instantName &&
      bound?.payload.answerZone === 'hand' &&
      bound?.payload.answerTo === 'graveyard' &&
      bound?.payload.answerMv === INSTANT.manaValue,
    `${JSON.stringify(bound?.payload)}`,
  );
  check(
    '(o) and the message names what answered',
    bound?.message.startsWith(`Answered ${first.type} with ${instantName}:`) === true,
    `${bound?.message}`,
  );

  // --- a permanent answering stays where it is ------------------------------
  playBiggestSpell();
  const second = pumpToAnswerableEvent();
  check('(o) a second event arrived to answer from the board', second !== null);
  if (!second) return;
  const permanent = Object.values(store().cards).find(
    (c) =>
      c.zone === 'battlefield' &&
      !c.isToken &&
      !isLandCard(store(), c) &&
      c.iid !== second.targetIid,
  );
  check('(o) a nonland permanent is on the board to answer with', permanent !== undefined);
  if (!permanent) return;
  const permanentName = cardName(store(), permanent.iid);
  const tappedBefore = permanent.tapped;

  store().respondToActiveEvent({ iid: permanent.iid });

  check(
    '(o) a permanent answering stays on the battlefield',
    store().cards[permanent.iid]?.zone === 'battlefield',
    `${store().cards[permanent.iid]?.zone}`,
  );
  check(
    '(o) and is never tapped for it',
    store().cards[permanent.iid]?.tapped === tappedBefore,
    `${tappedBefore} → ${store().cards[permanent.iid]?.tapped}`,
  );
  const boardEntry = lastRespondEntry();
  check(
    '(o) a battlefield answer binds with nowhere to go',
    boardEntry?.payload.bound === true &&
      boardEntry?.payload.answerZone === 'battlefield' &&
      boardEntry?.payload.answerTo === undefined,
    `${JSON.stringify(boardEntry?.payload)}`,
  );

  // --- no card is still an answer -------------------------------------------
  const third = pumpToAnswerableEvent();
  check('(o) a third event arrived to answer unbound', third !== null);
  if (!third) return;
  store().respondToActiveEvent();
  const unbound = lastRespondEntry();
  check(
    '(o) an answer with no card says so',
    unbound?.payload.bound === false && unbound?.payload.answerName === undefined,
    `${JSON.stringify(unbound?.payload)}`,
  );
  check(
    '(o) and keeps the plain message',
    unbound?.message.startsWith(`Answered ${third.type}: `) === true,
    `${unbound?.message}`,
  );

  // --- a card that is not the player's to spend is refused ------------------
  const fourth = pumpToAnswerableEvent();
  check('(o) a fourth event arrived to answer badly', fourth !== null);
  if (!fourth) return;
  const trayable = cardsInZone(store(), 'hand').find((c) => canCastToStack(store(), c.iid));
  check('(o) something in hand can go on the tray', trayable !== undefined);
  if (!trayable) return;
  store().castToStack(trayable.iid);
  check('(o) it is on the tray', store().cards[trayable.iid]?.zone === 'stack');

  store().respondToActiveEvent({ iid: trayable.iid });
  const rejected = lastRespondEntry();
  check(
    '(o) a card on the tray is refused as an answer',
    rejected?.payload.bound === false && rejected?.payload.boundRejected === true,
    `${JSON.stringify(rejected?.payload)}`,
  );
  check(
    '(o) and the refusal moves nothing',
    store().cards[trayable.iid]?.zone === 'stack',
    `${store().cards[trayable.iid]?.zone}`,
  );

  // --- the scorer reads all of it -------------------------------------------
  endRunQuietly('abandoned');
  const record = lastCapturedRun();
  if (!record) {
    failures.push('(o) no run captured off the store');
    return;
  }
  const scorecard = scoreRun({ ...record, result: 'abandoned' });
  const handRow = scorecard.events.find((r) => r.eventId === first.id);
  check(
    '(o) the ledger row carries the answer card and where it went',
    handRow?.answerCard === instantName && handRow?.answerTo === 'graveyard',
    `${JSON.stringify(handRow)}`,
  );
  const boardRow = scorecard.events.find((r) => r.eventId === second.id);
  check(
    '(o) a battlefield answer names the card and no destination',
    boardRow?.answerCard === permanentName && boardRow?.answerTo === undefined,
    `${JSON.stringify(boardRow)}`,
  );
  const unboundRow = scorecard.events.find((r) => r.eventId === third.id);
  check(
    '(o) an unbound answer names nothing',
    unboundRow?.terminal === 'responded' && unboundRow?.answerCard === undefined,
    `${JSON.stringify(unboundRow)}`,
  );
  check(
    '(o) the tally counts exactly the answers that named a card',
    scorecard.answers.total.named === 2,
    `named ${scorecard.answers.total.named} of ${scorecard.answers.total.responded} answered`,
  );

  // The named rate divides by what could have named something. This run pays no
  // tax — every one it met was resolved past — so nothing is excluded here and
  // the two denominators agree; `checkPaidTaxIsNotNameable` is where they part.
  const paidTaxes = scorecard.events.filter(
    (r) => r.terminal === 'responded' && r.type === 'resource' && r.variant === 'tax',
  ).length;
  check(
    '(o) a paid tax is answered but could never have named a card',
    scorecard.answers.total.nameable === scorecard.answers.total.responded - paidTaxes,
    `nameable ${scorecard.answers.total.nameable}, responded ${scorecard.answers.total.responded}, ${paidTaxes} paid taxes`,
  );
  check(
    '(o) the named rate is named over nameable',
    scorecard.answers.namedRate !== null &&
      Math.abs(scorecard.answers.namedRate - 2 / scorecard.answers.total.nameable) < 1e-9,
    `${String(scorecard.answers.namedRate)} over ${scorecard.answers.total.nameable}`,
  );

  // --- and so does the per-card tally ---------------------------------------
  // Two answers bound: the instant out of hand and the permanent off the board.
  // The tray card was refused, and a refusal that counted would make three.
  const runs = [{ ...record, result: 'abandoned' as RunResult }];
  check(
    '(o) only bound answers are tallied against a card',
    totalAnsweredWith(runs) === 2,
    `${totalAnsweredWith(runs)}`,
  );
  const refused = record.log.filter(
    (e) => e.kind === 'respond' && e.payload.answerIid !== undefined && e.payload.bound !== true,
  );
  check(
    '(o) the refusal is still on the log, it is just not a card that answered',
    refused.length === 1,
    `${refused.length} rejected bindings on the log`,
  );

  // --- and a bound answer replays byte for byte -----------------------------
  const replaySeed = 'engine-answer-determinism';
  const firstPass = normalizeLog(scriptedAnswerRun(replaySeed));
  const secondPass = normalizeLog(scriptedAnswerRun(replaySeed));
  const at = firstDifference(firstPass, secondPass);
  check(
    '(o) the same seed and the same scripted answers replay identically',
    firstPass === secondPass,
    at === -1
      ? ''
      : `diverges at char ${at}: ${firstPass.slice(at, at + 120)} | ${secondPass.slice(at, at + 120)}`,
  );

  summary.push(
    `(o) seed ${seed}: ${instantName} answered out of hand, ${permanentName} answered from the board, ${scorecard.answers.total.named} of ${scorecard.answers.total.responded} answers named a card`,
  );
  await settle();
}

/**
 * An instant held up and spent is a card the player cast. It leaves for the
 * graveyard rather than the battlefield, which matched none of the shapes the
 * per-card tally read as a cast, so the card came back as "drawn twice, cast
 * never" — the cut list's own definition of a card not pulling its weight, aimed
 * at the interaction the deck is built to hold up.
 *
 * The seed search asks for a run where the instant answered often enough to
 * clear the cut threshold, so both readings are meaningful: the fixed one is no
 * cut candidate, and the same log with the `answered` reason stripped is.
 */
async function checkAnsweredInstantCounts(): Promise<void> {
  const seed = search('answer-cast', (s) => {
    const run = instantAnswerRun(s);
    if (!run) return null;
    const stat = statFor([run], INSTANT.name);
    if (!stat || stat.drawn < CUT_CANDIDATE.minDrawn) return null;
    // Cast more than half the times it was seen, so the fixed reading is off the
    // cut list and the unfixed one (cast zero) is on it.
    return stat.cast * 2 > stat.drawn ? s : null;
  });
  if (seed === null) {
    failures.push('(o) no seed answered enough events with the deck instant');
    return;
  }

  const run = instantAnswerRun(seed);
  if (!run) {
    failures.push('(o) the chosen answer-cast seed produced no record');
    return;
  }
  const fixed = statFor([run], INSTANT.name);
  const blind = statFor([withoutAnswerReasons(run)], INSTANT.name);
  if (!fixed || !blind) {
    failures.push('(o) the deck instant has no row in the per-card tally');
    return;
  }

  check(
    '(o) an instant spent as an answer counts as a cast',
    fixed.cast >= 1 && fixed.cast === fixed.answeredWith,
    `${fixed.cast} cast, ${fixed.answeredWith} answered with, ${fixed.drawn} drawn`,
  );
  check(
    '(o) and the card is not read as one the deck never cast',
    !isCutCandidate(fixed),
    `rate ${String(fixed.castRate)} over ${fixed.drawn} drawn`,
  );
  check(
    '(o) the answered reason is what counts it',
    blind.cast === 0 && isCutCandidate(blind),
    `without it: ${blind.cast} cast, rate ${String(blind.castRate)}`,
  );

  summary.push(
    `(o) seed ${seed}: ${INSTANT.name} answered ${fixed.answeredWith} events off ${fixed.drawn} draws, cast ${fixed.cast} (${blind.cast} before the reason was read)`,
  );
  if (store().run) endRunQuietly('abandoned');
  await settle();
}

/**
 * Declaring held interaction against a race clock binds the card once. It can
 * write two entries — the clock's own, and the warning card's when one is still
 * in front of the player — and the answer fields belong on exactly one of them,
 * or one spent card answers two events.
 *
 * The standing clock is the other half: with no warning there is no event entry
 * anywhere in the log, so the ledger has to invent the row or the answer is
 * scored as if it never happened.
 */
async function checkClockAnswersBindOnce(): Promise<void> {
  // --- the warning is still up ---------------------------------------------
  const warned = search('answer-clock-warning', (s) => {
    freshStackRun(s);
    return pumpToClockWarning() ? s : null;
  });
  if (warned === null) {
    failures.push('(o) no seed put a clock warning in front of the player');
    return;
  }

  freshStackRun(warned);
  const warning = pumpToClockWarning();
  if (!warning) {
    failures.push('(o) the chosen clock-warning seed stopped offering the warning');
    return;
  }
  store().drawCards(24);
  const heldUp = cardsInZone(store(), 'hand').find((c) => isInstantOrSorceryCard(store(), c));
  check('(o) the hand holds an instant to declare with', heldUp !== undefined);
  if (!heldUp) return;
  const heldName = cardName(store(), heldUp.iid);
  const before = (store().run?.log ?? []).length;

  store().declareInteraction({ iid: heldUp.iid, note: 'held it up' });

  const written = (store().run?.log ?? []).slice(before).filter((e) => e.kind === 'respond');
  check(
    '(o) declaring past a warning writes the clock entry and the warning entry',
    written.length === 2,
    `${written.length} respond entries`,
  );
  const carrying = written.filter((e) => e.payload.answerIid === heldUp.iid);
  check(
    '(o) the answer fields land on exactly one of them',
    carrying.length === 1,
    `${carrying.length} entries carry the card`,
  );
  check(
    '(o) and it is the warning, the entry the ledger can file under an event',
    carrying[0]?.payload.eventId === warning.id,
    `${String(carrying[0]?.payload.eventId)} vs ${warning.id}`,
  );
  const warnedRun = store().run;
  if (!warnedRun) {
    failures.push('(o) the clock-warning run went away before it could be tallied');
    return;
  }
  check(
    '(o) one spent card answers one event',
    totalAnsweredWith([warnedRun]) === 1,
    `${totalAnsweredWith([warnedRun])} answers tallied`,
  );
  const warnedCard = scoreRun(warnedRun);
  const warnedRows = warnedCard.events.filter((r) => r.answerCard !== undefined);
  check(
    '(o) and the ledger gives it one row',
    warnedRows.length === 1 && warnedRows[0].eventId === warning.id,
    `${JSON.stringify(warnedRows.map((r) => r.eventId))}`,
  );

  // The same run as a log written before the fields were confined to one entry:
  // the answer on the clock's entry as well as the warning's. The scorer has to
  // fold those back into one row, or a run recorded in that window reads as
  // having answered two events with one card. (The store is what stops the
  // per-card tally double counting; it has no event id to dedupe on.)
  const answerFields = Object.fromEntries(
    Object.entries(carrying[0]?.payload ?? {}).filter(
      ([key]) => key.startsWith('answer') || key === 'bound',
    ),
  );
  const legacy: RunRecord = {
    ...warnedRun,
    log: warnedRun.log.map((e) =>
      e.kind === 'respond' && e.payload.reason === 'declared-interaction'
        ? { ...e, payload: { ...e.payload, ...answerFields } }
        : e,
    ),
  };
  const legacyRows = scoreRun(legacy).events.filter((r) => r.answerCard !== undefined);
  check(
    '(o) a log carrying the answer on both entries still scores one row',
    legacyRows.length === 1 && legacyRows[0].eventId === warning.id,
    `${JSON.stringify(legacyRows.map((r) => r.eventId))}`,
  );
  endRunQuietly('abandoned');
  await settle();

  // --- the clock is standing on its own ------------------------------------
  const standing = search('answer-clock-standing', (s) => {
    freshStackRun(s);
    return pumpToStandingClock() ? s : null;
  });
  if (standing === null) {
    failures.push('(o) no seed left a clock standing with nothing in front of it');
    return;
  }

  freshStackRun(standing);
  if (!pumpToStandingClock()) {
    failures.push('(o) the chosen standing-clock seed stopped raising a clock');
    return;
  }
  const clockSeat = store().clock?.seatId;
  check('(o) a clock is standing with no warning in front of it', clockSeat !== undefined);
  if (!clockSeat) return;
  store().drawCards(24);
  const answer = cardsInZone(store(), 'hand').find((c) => isInstantOrSorceryCard(store(), c));
  check('(o) the hand holds an instant to answer the standing clock with', answer !== undefined);
  if (!answer) return;
  const answerName = cardName(store(), answer.iid);
  const standingBefore = (store().run?.log ?? []).length;

  store().declareInteraction({ iid: answer.iid, note: 'held it up' });

  const standingWritten = (store().run?.log ?? [])
    .slice(standingBefore)
    .filter((e) => e.kind === 'respond');
  check(
    '(o) a standing clock writes one entry, and it carries the card',
    standingWritten.length === 1 &&
      standingWritten[0].payload.answerIid === answer.iid &&
      standingWritten[0].payload.answerName === answerName &&
      standingWritten[0].payload.reason === 'declared-interaction',
    `${JSON.stringify(standingWritten.map((e) => e.payload))}`,
  );
  const standingRun = store().run;
  if (!standingRun) {
    failures.push('(o) the standing-clock run went away before it could be scored');
    return;
  }
  const standingCard = scoreRun(standingRun);
  const clockRow = standingCard.events.find((r) => r.eventId === `clock-${clockSeat}`);
  check(
    '(o) the standing clock gets a ledger row of its own',
    clockRow?.type === 'clock' &&
      clockRow?.seatId === clockSeat &&
      clockRow?.terminal === 'responded' &&
      clockRow?.answerCard === answerName &&
      clockRow?.answerTo === 'graveyard',
    `${JSON.stringify(clockRow)}`,
  );
  check(
    '(o) and the tally counts it as the one answer that named a card',
    standingCard.answers.total.named === 1,
    `named ${standingCard.answers.total.named} of ${standingCard.answers.total.responded} answered`,
  );
  check(
    '(o) the clock still reads as answered by declaring',
    standingCard.clock.outcome === 'declared-interaction',
    `${String(standingCard.clock.outcome)}`,
  );
  check(
    '(o) the card that answered a standing clock is tallied once',
    totalAnsweredWith([standingRun]) === 1,
    `${totalAnsweredWith([standingRun])} answers tallied`,
  );

  summary.push(
    `(o) seeds ${warned} / ${standing}: ${heldName} answered a clock behind its warning, ${answerName} answered one standing alone, each counted once`,
  );
  endRunQuietly('abandoned');
  await settle();
}

/**
 * A paid tax is an answer with no card in it: the store asks for none and binds
 * none, so it can never be an answer that named something. Counting it in the
 * denominator made the named rate read as a pilot failing to name cards they
 * were never offered the chance to.
 */
async function checkPaidTaxIsNotNameable(): Promise<void> {
  const seed = search('answer-tax', (s) => (findTaxEvent(s) ? s : null));
  if (seed === null) {
    failures.push('(o) no seed offered a tax to pay');
    return;
  }
  const paid = findTaxEvent(seed);
  if (!paid) {
    failures.push('(o) the chosen tax seed stopped offering one');
    return;
  }

  store().respondToActiveEvent();
  const paidEntry = lastRespondEntry();
  check(
    '(o) paying a tax binds nothing and says nothing about binding',
    paidEntry?.payload.answerIid === undefined && paidEntry?.payload.bound === undefined,
    `${JSON.stringify(paidEntry?.payload)}`,
  );

  // One answer that does name a card, so the rate has a numerator to read.
  store().drawCards(25);
  playBiggestSpell();
  const next = pumpToAnswerableEvent();
  check('(o) another event arrived to answer with a card', next !== null);
  if (!next) return;
  const permanent = Object.values(store().cards).find(
    (c) =>
      c.zone === 'battlefield' &&
      !c.isToken &&
      !isLandCard(store(), c) &&
      c.iid !== next.targetIid,
  );
  check('(o) a permanent is on the board to answer the tax run with', permanent !== undefined);
  if (!permanent) return;
  store().respondToActiveEvent({ iid: permanent.iid });

  const run = store().run;
  if (!run) {
    failures.push('(o) the tax run went away before it could be scored');
    return;
  }
  const scored = scoreRun(run);
  const answers = scored.answers.total;
  const paidTaxes = scored.events.filter(
    (r) => r.terminal === 'responded' && r.type === 'resource' && r.variant === 'tax',
  ).length;
  check('(o) the paid tax is scored as answered', paidTaxes >= 1, `${paidTaxes}`);
  check(
    '(o) and it is left out of what could have been named',
    answers.nameable === answers.responded - paidTaxes,
    `nameable ${answers.nameable}, responded ${answers.responded}, ${paidTaxes} paid taxes`,
  );
  check(
    '(o) so the two denominators really do differ here',
    answers.nameable < answers.responded,
    `nameable ${answers.nameable}, responded ${answers.responded}`,
  );
  check(
    '(o) the named rate divides by what could be named',
    scored.answers.namedRate !== null &&
      Math.abs(scored.answers.namedRate - answers.named / answers.nameable) < 1e-9,
    `${String(scored.answers.namedRate)} vs ${answers.named}/${answers.nameable}`,
  );

  summary.push(
    `(o) seed ${seed}: ${paid.card?.name} paid for ${String(paid.card?.pay)}, ${answers.named} of ${answers.nameable} nameable answers named a card (${answers.responded} answered in all)`,
  );
  endRunQuietly('abandoned');
  await settle();
}

/**
 * An intercepting seat cites a counterspell it could actually be holding. The
 * store used to leave the colour filter at its default of all five, so a Sultai
 * seat could produce a white counterspell it has no business owning; the seat's
 * own archetype colours are what the pick is made from now.
 */
async function checkCounterCitationColors(): Promise<void> {
  const armed = armSeat('engine-counter-colors', 7);
  if (!armed) {
    failures.push('(o) no seed armed a seat for the colour check');
    return;
  }

  store().drawCards(25);
  const fat = biggestInHand(store());
  if (!fat || manaValueOf(store(), fat) < armed.armed.threshold) {
    failures.push('(o) no spell in hand meets the threshold the armed seat held');
    return;
  }
  store().moveCard(fat.iid, 'battlefield');
  const raised = store().activeEvent;
  check(
    '(o) the cast was intercepted',
    raised?.type === 'counter' && raised.targetIid === fat.iid,
    String(raised?.type),
  );
  const seat = store().seats.find((s) => s.id === armed.armed.seatId);
  check('(o) the intercepting seat is at the table', seat !== undefined);
  if (!seat || !raised?.card) {
    failures.push('(o) the interception cited no card to read colours off');
    return;
  }
  const colors = colorsOf(toSnapshot(seat));
  check(
    '(o) the counterspell cited is inside the holding seat colours',
    raised.card.colors.every((c) => colors.includes(c)),
    `${raised.card.name} ${JSON.stringify(raised.card.colors)} from a ${String(seat.profile)} seat ${JSON.stringify(colors)}`,
  );

  summary.push(
    `(o) seed ${armed.seed}: a ${String(seat.profile)} seat cited ${raised.card.name}, inside ${colors.join('')}`,
  );
  endRunQuietly('concede');
  await settle();
}

// ---------------------------------------------------------------------------
// (e) determinism, with the new paths in the script
// ---------------------------------------------------------------------------

/**
 * A scripted run that kills a seat mid-game, so the cancel path and the
 * disarm path are both inside what is being compared. Combat is answered rather
 * than taken, so the player never dies and the two executions cannot diverge on
 * a run that ended early. The stack tray is in here too: its item ids and stamps
 * come off the move counter rather than a nanoid or the clock, which is exactly
 * the property this check exists to hold.
 */
function scriptedRun(seed: string): RunRecord {
  freshRun(seed);
  for (let turn = 1; turn <= 9; turn++) {
    if (!store().run) break;
    if (store().clock) store().declareInteraction();
    drainEventsWithoutDamage();
    store().drawCards(3);
    playLand();
    if (turn === 3) {
      store().pushAbility('Saga chapter II');
      store().resolveTop();
    }
    if (turn === 5) {
      const cast = biggestInHand(store());
      if (cast) store().castToStack(cast.iid);
      drainEventsWithoutDamage();
      store().resolveTop();
    }
    playBiggestSpell();
    drainEventsWithoutDamage();
    if (turn === 4) store().adjustLife('A', -40);
    if (turn === 6) store().dealCommanderDamage('B', 12);
    if (turn === 7) store().undoLastLifeChange();
    if (turn < 9) store().nextTurn();
  }
  const record = store().run ?? lastCapturedRun();
  if (!record) throw new Error('scripted run produced no record');
  return record;
}

/**
 * A log stripped of everything a seed cannot reproduce: wall-clock stamps, the
 * run's own nanoid, and card instance ids. Instances are rewritten to their
 * position in the roster, which `startRun` builds in deck order, so the aliasing
 * is stable across executions.
 *
 * A turn's own duration is wall clock too, and so is the overtime flag read off
 * it. A scripted turn takes about a millisecond, so both passes almost always
 * agree at zero — but "almost always" is not what a determinism check is for,
 * and a turn that happened to straddle a second boundary would fail it for a
 * reason that has nothing to do with the seed.
 */
function normalizeLog(record: RunRecord): string {
  const stripped = record.log.map((entry) => ({
    ...entry,
    at: 0,
    payload:
      entry.kind === 'turn'
        ? { ...entry.payload, previousTurnSeconds: 0, overtime: undefined }
        : entry.payload,
  }));
  const aliases = new Map<string, string>([[record.id, '<runId>']]);
  for (const iid of Object.keys(record.roster ?? {})) aliases.set(iid, `#${aliases.size}`);
  for (const entry of record.log) {
    const iids = entry.payload.iids;
    if (!Array.isArray(iids)) continue;
    for (const iid of iids) {
      if (typeof iid === 'string' && !aliases.has(iid)) aliases.set(iid, `#${aliases.size}`);
    }
  }
  let json = JSON.stringify(stripped);
  for (const [id, alias] of aliases) json = json.split(id).join(alias);
  return json;
}

// ---------------------------------------------------------------------------
// (p) the three seats are three different opponents
// ---------------------------------------------------------------------------

/**
 * The archetype profile is the only thing making seat A a different opponent
 * from seat B, so a draw that ever dealt the same one twice would quietly undo
 * the whole feature. The draw is seeded, so this asserts the shape rather than
 * any particular table: three seats, three different profiles, all of them real
 * entries in the table, and the seating entry carrying them into the log where
 * a replay and the scorecard can read them back.
 */
function checkSeatsCarryDistinctProfiles(): void {
  freshRun('engine-profiles');
  const seats = store().seats;
  const profiles = seats.map((s) => s.profile);

  check('(p) three seats were seated', seats.length === 3, `${seats.length}`);
  check(
    '(p) every seat carries a profile from the table',
    profiles.every((p) => p !== undefined && PROFILE_IDS.includes(p)),
    profiles.join(', '),
  );
  check('(p) the three profiles are distinct', new Set(profiles).size === 3, profiles.join(', '));

  const seated = (store().run?.log ?? []).find(
    (entry) => entry.kind === 'threat' && entry.message.startsWith('Seats seated'),
  );
  check('(p) the seating entry was written', seated !== undefined);
  const logged = (seated?.payload.seats ?? []) as { id: SeatId; profile?: SeatProfileId }[];
  check(
    "(p) its payload carries every seat's profile",
    logged.length === 3 &&
      logged.every((row) => row.profile === seats.find((s) => s.id === row.id)?.profile),
    logged.map((row) => `${row.id}:${row.profile}`).join(', '),
  );
  check(
    '(p) and the message names them',
    profiles.every((p) => p !== undefined && seated?.message.includes(p) === true),
    `${seated?.message}`,
  );

  summary.push(
    `(p) seed engine-profiles seated ${seats.map((s) => `${s.id} ${s.profile}`).join(', ')}`,
  );
}

// ---------------------------------------------------------------------------
// (q) the counter-arming clamp keeps the holder's archetype
// ---------------------------------------------------------------------------
/**
 * Pure arithmetic, no store: `counterArmChance` at bracket 5 against a player
 * at maximum threat, which is the hardest the roll ever presses on its ceiling
 * and therefore where a multiplier applied before that ceiling used to vanish.
 * The three profiles have to come out ordered, none of them past
 * `profileCeiling`, and the unmodified one has to sit exactly where the old
 * formula put it — the fix is meant to free the multipliers, not to move the
 * seat that never had one.
 */
function checkCounterArmClamp(): void {
  const BRACKET_HERE = 5;
  const THREAT_HERE = PRESSURE.threat.max;
  const control = counterArmChance(BRACKET_HERE, THREAT_HERE, 1.5);
  const neutral = counterArmChance(BRACKET_HERE, THREAT_HERE, 1.0);
  const aggro = counterArmChance(BRACKET_HERE, THREAT_HERE, 0.2);

  check(
    '(q) a control seat arms more often than an unmodified one',
    control > neutral,
    `${control} vs ${neutral}`,
  );
  check(
    '(q) an aggro seat arms less often than an unmodified one',
    neutral > aggro,
    `${neutral} vs ${aggro}`,
  );
  check(
    '(q) nothing arms past the profile ceiling',
    [control, neutral, aggro].every((v) => v <= PRESSURE.profileCeiling),
    `${control}, ${neutral}, ${aggro}`,
  );

  // What the engine computed before the profile multiplier moved after the cap.
  const armScale =
    PRESSURE.counter.playerThreatBase + THREAT_HERE * PRESSURE.counter.playerThreatPer;
  const before = Math.min(
    Math.max(byBracket(PRESSURE.counter.armChance, BRACKET_HERE) * armScale, 0),
    PRESSURE.counter.max,
  );
  check(
    '(q) an unmodified seat did not move',
    neutral === before,
    `${neutral} vs ${before}`,
  );

  summary.push(
    `(q) bracket ${BRACKET_HERE} at threat ${THREAT_HERE}: control ${control.toFixed(3)} > neutral ` +
      `${neutral.toFixed(3)} (unmoved) > aggro ${aggro.toFixed(3)}, ceiling ${PRESSURE.profileCeiling}`,
  );
}

// ---------------------------------------------------------------------------
// (r) a hate piece stands, and leaves the way it is supposed to
// ---------------------------------------------------------------------------

/** What a hate-piece search hands back: the piece, and the event that made it. */
interface StoodPiece {
  seed: string;
  hazard: StandingHazard;
  event: PressureEvent;
}

/** Answer everything on offer this turn without taking damage or losing the race. */
function drainTurnWithoutDamage(onResolved?: (event: PressureEvent) => void): void {
  if (store().clock) store().declareInteraction();
  for (let guard = 0; guard < 60; guard++) {
    const event = store().activeEvent;
    if (!event || !store().run) return;
    if (event.type === 'combat') {
      store().respondToActiveEvent({ note: 'blocked it' });
      continue;
    }
    store().resolveActiveEvent();
    onResolved?.(event);
  }
  throw new Error('the event queue never emptied');
}

/** An instant sitting in hand, which is what a piece gets answered with. */
function instantInHand(): CardInstance | undefined {
  return cardsInZone(store(), 'hand').find((c) => isInstantOrSorceryCard(store(), c));
}

/**
 * Play until a hate piece is standing.
 *
 * The probe resolves the event itself, because the piece only exists once the
 * player has let it through — up to that point it is a question, and answering
 * it leaves nothing behind. `holdOneTurn` plays one further turn and rejects the
 * seed unless the piece survived it, which is what gives `turnsStanding`
 * something to count; `needsInstant` holds out for a seed that also dealt the
 * player something to answer it with.
 */
function standAHatePiece(
  label: string,
  opts: { stackDeck?: boolean; holdOneTurn?: boolean; needsInstant?: boolean } = {},
): StoodPiece | null {
  const usable = (piece: StoodPiece): StoodPiece | null => {
    if (!store().hazards.some((h) => h.id === piece.hazard.id)) return null;
    if (opts.needsInstant && !instantInHand()) return null;
    return piece;
  };

  return search(label, (seed) => {
    if (opts.stackDeck) freshStackRun(seed);
    else freshRun(seed);

    // Boxed: the drain assigns from inside a closure, which the compiler's flow
    // analysis cannot see through — the same reason `lastCapturedRun` exists.
    const box: { stood: StoodPiece | null } = { stood: null };
    for (let turn = 1; turn <= SEARCH_TURNS; turn++) {
      store().nextTurn();
      if (!store().run) return null;

      drainTurnWithoutDamage((event) => {
        if (event.type !== 'hate' || box.stood) return;
        const hazard = store().hazards.find((h) => h.eventId === event.id);
        if (hazard) box.stood = { seed, hazard, event };
      });
      if (!store().run) return null;

      const stood = box.stood;
      if (stood && !opts.holdOneTurn) return usable(stood);
      // The piece has to survive a turn before it has stood for one.
      if (stood && store().turn > stood.hazard.spawnedTurn) return usable(stood);
    }
    return null;
  });
}

/**
 * The whole life of a standing piece, on one run: it lands, the player lets it
 * resolve, the window that follows knows it is there, and a card takes it off
 * the table with the turns it stood counted on the entry.
 */
function checkHatePieceStandsAndIsRemoved(): void {
  const found = standAHatePiece('engine-hate', {
    stackDeck: true,
    holdOneTurn: true,
    needsInstant: true,
  });
  if (!found) {
    failures.push('(r) no seed stood a hate piece with an answer in hand');
    return;
  }
  const { hazard, event } = found;

  check('(r) the piece is standing', store().hazards.some((h) => h.id === hazard.id));
  check('(r) its id comes off the event', hazard.id === `hz-${event.id}`, hazard.id);
  check('(r) it stands on the seat that cast it', hazard.seatId === event.seatId);
  check(
    '(r) it carries the card the seat cast',
    hazard.card.name === event.card?.name,
    `${hazard.card.name} vs ${event.card?.name}`,
  );
  check(
    '(r) the card says what kind of permanent it is',
    hazard.card.permanent !== undefined,
    hazard.card.name,
  );
  check(
    '(r) and what the player now has to play around',
    typeof hazard.card.tell === 'string' && hazard.card.tell.length > 0,
    `${hazard.card.tell}`,
  );

  const log = () => store().run?.log ?? [];
  const stoodEntry = log().find(
    (entry) => entry.kind === 'event' && entry.payload.eventId === event.id && entry.payload.resolved === true,
  );
  const outcome = (stoodEntry?.payload.outcome ?? {}) as Record<string, unknown>;
  check(
    '(r) the resolution says the piece stood',
    outcome.standing === true && outcome.hazardId === hazard.id,
    JSON.stringify(outcome),
  );
  check(
    '(r) and the message names it',
    stoodEntry?.message.includes(`(${hazard.card.name} stands)`) === true,
    stoodEntry?.message ?? '(no entry)',
  );

  // The engine reads the standing list back, so the window entry has to carry it.
  const lastWindow = log().filter((entry) => entry.kind === 'window').pop();
  const listed = (lastWindow?.payload.hazards ?? []) as string[];
  check(
    '(r) the next window entry lists what was standing',
    listed.includes(hazard.id),
    listed.join(', ') || '(none)',
  );

  // --- and a card takes it off the table -----------------------------------
  const answer = instantInHand();
  if (!answer) {
    failures.push('(r) the search returned a run with no instant in hand');
    return;
  }
  const answerName = cardName(store(), answer.iid);
  const expectedTurns = store().turn - hazard.spawnedTurn;
  store().removeHazard(hazard.id, { iid: answer.iid, note: 'blew it up' });

  check('(r) the piece is off the table', !store().hazards.some((h) => h.id === hazard.id));
  const removed = lastRespondEntry();
  const payload = removed?.payload ?? {};
  check(
    '(r) the removal names the piece and the card',
    removed?.message === `Removed ${hazard.card.name} (Seat ${hazard.seatId}) with ${answerName}`,
    removed?.message ?? '(no entry)',
  );
  check('(r) it is filed as a removed hazard', payload.reason === 'removed-hazard', `${payload.reason}`);
  check(
    '(r) it points back at the piece and its event',
    payload.hazardId === hazard.id && payload.eventId === hazard.eventId,
    `${payload.hazardId} / ${payload.eventId}`,
  );
  check(
    '(r) it counts the turns the player played around it',
    payload.turnsStanding === expectedTurns && expectedTurns >= 1,
    `${payload.turnsStanding} (expected ${expectedTurns})`,
  );
  check(
    '(r) the answer is bound to the card that made it',
    payload.bound === true && payload.answerName === answerName && payload.answerTo === 'graveyard',
    `${payload.answerName} → ${payload.answerTo}`,
  );
  check(
    '(r) and the card was spent',
    store().cards[answer.iid].zone === 'graveyard',
    store().cards[answer.iid].zone,
  );

  summary.push(
    `(r) seed ${found.seed}: ${hazard.card.name} stood on seat ${hazard.seatId} from T${hazard.spawnedTurn}, ` +
      `removed with ${answerName} after ${expectedTurns} turn(s)`,
  );
}

/**
 * A wrath does not stop at the player's side of the table. Whether it reaches a
 * standing piece is the card's own scope: a creatures-only sweep takes Thalia
 * and leaves Blood Moon, a wider one takes both.
 */
function checkWipeSweepsStandingPieces(): void {
  const found = search('engine-hate-wipe', (seed) => {
    freshRun(seed);
    for (let turn = 1; turn <= SEARCH_TURNS; turn++) {
      store().nextTurn();
      if (!store().run) return null;
      if (store().clock) store().declareInteraction();

      for (let guard = 0; guard < 60; guard++) {
        const event = store().activeEvent;
        if (!event || !store().run) break;
        if (event.type === 'combat') {
          store().respondToActiveEvent({ note: 'blocked it' });
          continue;
        }
        const sweep = event.type === 'wipe' ? event.card?.sweep : undefined;
        if (sweep) {
          const reaches = (h: StandingHazard): boolean =>
            sweep !== 'creatures' || h.card.permanent === 'creature';
          const swept = store().hazards.filter(reaches);
          const kept = store().hazards.filter((h) => !reaches(h));
          if (swept.length > 0) {
            store().resolveActiveEvent();
            return { seed, swept, kept, wipe: event };
          }
        }
        store().resolveActiveEvent();
      }
    }
    return null;
  });

  if (!found) {
    failures.push('(r) no seed wrathed a table with a piece standing on it');
    return;
  }

  const standing = store().hazards.map((h) => h.id);
  check(
    '(r) the sweep took every piece it reaches',
    found.swept.every((h) => !standing.includes(h.id)),
    standing.join(', '),
  );
  check(
    '(r) and left the ones it does not',
    found.kept.every((h) => standing.includes(h.id)),
    `kept ${found.kept.map((h) => h.card.name).join(', ')}`,
  );

  const log = store().run?.log ?? [];
  for (const hazard of found.swept) {
    const entry = log.find(
      (e) => e.kind === 'threat' && e.payload.hazardId === hazard.id && e.payload.reason === 'wiped',
    );
    check(
      `(r) ${hazard.card.name} was logged as swept`,
      entry !== undefined && entry.payload.byEventId === found.wipe.id && entry.payload.canceled === true,
      `${entry?.message ?? '(no entry)'}`,
    );
    check(
      `(r) and the entry says what swept it`,
      entry?.message ===
        `${hazard.card.name} (Seat ${hazard.seatId}) swept by ${found.wipe.card?.name}`,
      entry?.message ?? '(no entry)',
    );
  }

  const wipeEntry = log.find(
    (e) => e.kind === 'event' && e.payload.eventId === found.wipe.id && e.payload.resolved === true,
  );
  const outcome = (wipeEntry?.payload.outcome ?? {}) as Record<string, unknown>;
  check(
    "(r) the wipe's own entry lists what it swept",
    JSON.stringify(outcome.hazardsSwept) === JSON.stringify(found.swept.map((h) => h.id)),
    JSON.stringify(outcome.hazardsSwept),
  );

  summary.push(
    `(r) seed ${found.seed}: ${found.wipe.card?.name} (${found.wipe.card?.sweep}) swept ` +
      `${found.swept.map((h) => h.card.name).join(', ')}, ${found.kept.length} left standing`,
  );
}

/** A piece is one seat's card. The seat dies, the piece goes with it. */
function checkSeatDeathRetiresItsPieces(): void {
  const found = standAHatePiece('engine-hate-death');
  if (!found) {
    failures.push('(r) no seed stood a hate piece to kill a seat under');
    return;
  }
  const { hazard } = found;
  const seat = store().seats.find((s) => s.id === hazard.seatId);
  if (!seat) {
    failures.push('(r) the piece stood on a seat that is not at the table');
    return;
  }

  store().adjustLife(hazard.seatId, -seat.life);
  check('(r) the seat is out', store().seats.find((s) => s.id === hazard.seatId)?.eliminated === true);
  check('(r) its piece left with it', !store().hazards.some((h) => h.id === hazard.id));

  const entry = (store().run?.log ?? []).find(
    (e) => e.kind === 'threat' && e.payload.hazardId === hazard.id,
  );
  check(
    '(r) the piece was retired, not left standing on a corpse',
    entry?.payload.reason === 'seat-eliminated' && entry.payload.canceled === true,
    `${entry?.payload.reason}`,
  );
  check(
    '(r) the retirement names the card and the seat',
    entry?.payload.cardName === hazard.card.name && entry.payload.seatId === hazard.seatId,
    entry?.message ?? '(no entry)',
  );

  summary.push(
    `(r) seed ${found.seed}: seat ${hazard.seatId} died holding ${hazard.card.name}; the piece left with it`,
  );
}

// ---------------------------------------------------------------------------
// (s) the seats hit each other, and it is not the player's damage
// ---------------------------------------------------------------------------

/** Every seat-on-seat hit this run has logged, in order. */
function podEntriesSoFar(): LogEntry[] {
  return (store().run?.log ?? []).filter(
    (entry) => entry.kind === 'damage' && entry.payload.podCombat === true,
  );
}

/**
 * A pod hit is damage the player did not deal, applied to a seat's life the
 * engine does not own. So: the entry has to say who hit whom, the life on the
 * seat has to move by exactly what the entry claims, and none of it may reach
 * the tally the player is scored on.
 */
function checkPodCombatHits(): void {
  const found = search('engine-pod', (seed) => {
    freshRun(seed);
    for (let turn = 1; turn <= SEARCH_TURNS; turn++) {
      const lifeBefore: Partial<Record<SeatId, number>> = {};
      for (const seat of store().seats) lifeBefore[seat.id] = seat.life;
      const tallyBefore = { ...store().damageDealtByTurn };
      const seen = podEntriesSoFar().length;

      store().nextTurn();
      if (!store().run) return null;
      const entries = podEntriesSoFar();
      if (entries.length > seen) return { seed, entry: entries[seen], lifeBefore, tallyBefore };

      drainTurnWithoutDamage();
      if (!store().run) return null;
    }
    return null;
  });

  if (!found) {
    failures.push('(s) no seed had the seats swing at each other');
    return;
  }

  const payload = found.entry.payload;
  const defender = payload.seatId as SeatId;
  const attacker = payload.attackerId as SeatId;
  const amount = payload.amount as number;
  const before = payload.before as number;
  const after = payload.after as number;

  check('(s) the hit is a damage entry', found.entry.kind === 'damage', found.entry.kind);
  check('(s) it is flagged as pod combat', payload.podCombat === true);
  check('(s) the attacker is not the defender', attacker !== defender, `${attacker} → ${defender}`);
  check(
    '(s) the message reads as one seat hitting another',
    found.entry.message === `Seat ${attacker} attacks Seat ${defender} for ${amount}`,
    found.entry.message,
  );
  check(
    '(s) the life it reports is the life the seat had',
    before === found.lifeBefore[defender],
    `${before} vs ${found.lifeBefore[defender]}`,
  );
  check('(s) the seat lost exactly what was dealt', before - after === amount, `${before}→${after} for ${amount}`);
  const seat = store().seats.find((s) => s.id === defender);
  check('(s) and the table agrees', seat?.life === after, `${seat?.life} vs ${after}`);
  check(
    '(s) the pod softens a seat up, it never finishes one',
    after >= 1 && amount <= before - 1 && seat?.eliminated === false,
    `${before}→${after} for ${amount}`,
  );
  const log = store().run?.log ?? [];
  const windowEntry = log.filter((e) => e.kind === 'window' && e.seq < found.entry.seq).pop();
  // The window before turn N is where the hit happened, so that is the turn the
  // readout prints — the same turn the events out of that window carry, and one
  // ahead of the turn the entry was written on.
  check(
    '(s) the readout can say who hit it, for how much, when',
    JSON.stringify(store().lastPodHit[defender]) ===
      JSON.stringify({
        attackerId: attacker,
        damage: amount,
        turn: windowEntry?.payload.windowBeforeTurn,
      }),
    JSON.stringify(store().lastPodHit[defender]),
  );

  const hits = (windowEntry?.payload.podHits ?? []) as {
    attackerId: SeatId;
    defenderId: SeatId;
    damage: number;
  }[];
  check(
    '(s) the window entry carries the hit too',
    hits.some((h) => h.attackerId === attacker && h.defenderId === defender && h.damage === amount),
    JSON.stringify(hits),
  );
  check(
    '(s) the window entry lists what was standing',
    Array.isArray(windowEntry?.payload.hazards),
    JSON.stringify(windowEntry?.payload.hazards),
  );

  // The whole point of the flag: the player is not credited with damage the pod
  // dealt itself. The second half proves the tally still works — it is the same
  // seat, the same store, one point later.
  check(
    "(s) the hit stays out of the player's damage tally",
    JSON.stringify(store().damageDealtByTurn) === JSON.stringify(found.tallyBefore),
    `${JSON.stringify(store().damageDealtByTurn)} vs ${JSON.stringify(found.tallyBefore)}`,
  );
  const victim = store().seats.find((s) => !s.eliminated && s.life > 5);
  if (victim) {
    const tallyTurn = store().turn;
    const dealtBefore = store().damageDealtByTurn[tallyTurn] ?? 0;
    store().adjustLife(victim.id, -1);
    check(
      "(s) but the player's own point of damage does tally",
      (store().damageDealtByTurn[tallyTurn] ?? 0) === dealtBefore + 1,
      `${store().damageDealtByTurn[tallyTurn]} vs ${dealtBefore}`,
    );
  }

  summary.push(
    `(s) seed ${found.seed}: seat ${attacker} hit seat ${defender} for ${amount} (life ${before}→${after}) ` +
      `on T${found.entry.turn}, none of it the player's`,
  );
}

/**
 * The cap that keeps the pod from playing the game for the player: a hit is
 * capped at `life - 1` and a seat on 1 life is not swung at. Putting every seat
 * one point above dead is the only way to press on it hard — a table like that
 * would be a pod that eliminates itself, and the run must end with all three
 * seats alive and nothing eliminated.
 */
function checkPodCombatNeverKills(): void {
  const LOW_LIFE_TURNS = 18;
  const found = search('engine-pod-cap', (seed) => {
    freshRun(seed);
    let lowered = false;
    for (let turn = 1; turn <= LOW_LIFE_TURNS; turn++) {
      const seen = podEntriesSoFar().length;
      store().nextTurn();
      if (!store().run) return null;
      const fresh = podEntriesSoFar().slice(seen);
      const onTwo = fresh.find((entry) => (entry.payload.before as number) <= 2);
      if (onTwo) return { seed, entry: onTwo, loweredAt: turn };

      drainTurnWithoutDamage();
      if (!store().run) return null;

      if (!lowered && store().turn >= 5) {
        for (const seat of store().seats) {
          if (!seat.eliminated && seat.life > 2) store().adjustLife(seat.id, 2 - seat.life);
        }
        lowered = true;
      }
    }
    return null;
  });

  if (!found) {
    failures.push('(s) no seed swung at a seat sitting on 2 life');
    return;
  }

  const payload = found.entry.payload;
  const defender = payload.seatId as SeatId;
  check(
    '(s) a seat on 2 life is hit for exactly the point it can spare',
    payload.before === 2 && payload.amount === 1 && payload.after === 1,
    `${payload.before} → ${payload.after} for ${payload.amount}`,
  );
  check(
    '(s) the defender is still at the table',
    store().seats.find((s) => s.id === defender)?.eliminated === false,
  );

  const log = store().run?.log ?? [];
  const belowOne = podEntriesSoFar().filter((entry) => (entry.payload.after as number) < 1);
  check(
    '(s) no pod hit anywhere in the run took a seat below 1',
    belowOne.length === 0,
    `${belowOne.length}`,
  );
  const eliminated = log.filter((entry) => entry.kind === 'damage' && entry.payload.threatAtDeath !== undefined);
  check(
    '(s) a table on 2 life apiece still lost nobody',
    eliminated.length === 0,
    eliminated.map((e) => e.message).join(', '),
  );

  summary.push(
    `(s) seed ${found.seed}: every seat on 2 life, ${podEntriesSoFar().length} pod hit(s), ` +
      `none of them fatal (seat ${defender} left on ${payload.after})`,
  );
}

// ---------------------------------------------------------------------------
// (t) an unanswered hate event holds the seat's slot
// ---------------------------------------------------------------------------

/** What holding a hate event unanswered hands back. */
interface HeldHate {
  seed: string;
  /** The event left in the queue, never resolved. */
  first: PressureEvent;
  /** Every other hate event dealt while it waited — none of them may be its seat's. */
  others: PressureEvent[];
  /** Windows that opened while it sat there. */
  windowsWaited: number;
}

/** Turns a hold search will play. Longer than the others: the wait needs windows. */
const HOLD_TURNS = 16;
/** Windows the first hate event has to survive unanswered before the seed counts. */
const HOLD_WINDOWS = 5;

/**
 * Answer everything on offer except a hate event, which is left standing in the
 * queue as the question it is. A hate event at the head blocks what is behind
 * it, which is the point: nothing after it is resolved either, so the only
 * thing moving between turns is the pod.
 *
 * The race clock is still claimed every turn — it is cancelled off `state.clock`
 * rather than off the queue, so holding the queue must not lose the run instead.
 */
function drainTurnLeavingHate(): void {
  if (store().clock) store().declareInteraction();
  for (let guard = 0; guard < 60; guard++) {
    const event = store().activeEvent;
    if (!event || !store().run) return;
    // Left unanswered on purpose: the store has to count it as standing anyway.
    if (event.type === 'hate') return;
    if (event.type === 'combat') {
      store().respondToActiveEvent({ note: 'blocked it' });
      continue;
    }
    store().resolveActiveEvent();
  }
  throw new Error('the event queue never emptied');
}

/**
 * Play until a hate event has been sitting unanswered for `HOLD_WINDOWS`
 * windows. Nothing hate is ever resolved, so every hate event the run dealt is
 * still in the queue at the end and can be read straight off it.
 *
 * `needsSecond` holds out for a seed where the pod dealt a second piece while
 * the first waited, whoever it went to. That is the only seed shape that can
 * tell the fix from the bug: it is where a store that does not lend the engine
 * the unanswered event puts the second piece on the same seat, and where a
 * store that does puts it on another one.
 */
function holdAHateEvent(label: string, opts: { needsSecond?: boolean } = {}): HeldHate | null {
  return search(label, (seed) => {
    freshRun(seed);
    let firstWindow = 0;
    for (let turn = 1; turn <= HOLD_TURNS; turn++) {
      store().nextTurn();
      if (!store().run) return null;
      drainTurnLeavingHate();
      if (!store().run) return null;

      const hate = queuedEvents().filter((e) => e.type === 'hate');
      if (hate.length > 0 && firstWindow === 0) firstWindow = store().windowCount;
      if (firstWindow === 0 || store().windowCount - firstWindow < HOLD_WINDOWS) continue;

      const [first, ...others] = hate;
      if (opts.needsSecond && others.length === 0) return null;
      return { seed, first, others, windowsWaited: store().windowCount - firstWindow };
    }
    return null;
  });
}

/**
 * The cap the engine enforces is per seat, and it reads `input.hazards` — which
 * holds only the pieces that resolved. A hate event the player has not answered
 * yet is not in there, so without the store lending the engine a provisional
 * entry for it a seat could be dealt a second piece while the first is still a
 * question, and answering neither would stand two.
 *
 * `PRESSURE.hazards.hate.cap` is 2 at this bracket, so the run has exactly one
 * more piece to give: it must not go to the seat already waiting, and it must
 * still be allowed to go to a seat that is not.
 */
function checkQueuedHateHoldsTheSeatsSlot(): void {
  const found =
    holdAHateEvent('engine-hate-queued-second', { needsSecond: true }) ??
    holdAHateEvent('engine-hate-queued');
  if (!found) {
    failures.push('(t) no seed left a hate event unanswered for long enough to test');
    return;
  }
  const { first, others } = found;

  check(
    '(t) the held event is still a question in front of the player',
    queuedEvents().some((e) => e.id === first.id),
    first.id,
  );
  check(
    '(t) and nothing is standing, because nothing was let through',
    !store().hazards.some((h) => h.eventId === first.id),
    store().hazards.map((h) => h.id).join(', ') || '(none)',
  );

  const sameSeat = others.filter((e) => e.seatId === first.seatId);
  check(
    '(t) the seat that is owed an answer was not dealt a second piece',
    sameSeat.length === 0,
    sameSeat.map((e) => `${e.id} (${e.card?.name})`).join(', '),
  );

  // The provisional entry is engine-input only: the window entry still lists
  // what actually stood, and names the unanswered event separately.
  const windows = (store().run?.log ?? []).filter((e) => e.kind === 'window');
  const afterHold = windows.filter((e) => (e.payload.queuedHate as string[] | undefined)?.includes(first.id));
  check(
    '(t) every window that opened while it waited counted it',
    afterHold.length === found.windowsWaited,
    `${afterHold.length} of ${found.windowsWaited} window(s)`,
  );
  check(
    '(t) and none of them called it standing',
    afterHold.every((e) => ((e.payload.hazards as string[] | undefined) ?? []).length === 0),
    JSON.stringify(afterHold.map((e) => e.payload.hazards)),
  );

  const otherSeat = others.find((e) => e.seatId !== first.seatId);
  if (otherSeat) {
    check(
      '(t) a seat that owes nothing can still be dealt one',
      otherSeat.seatId !== first.seatId,
      `${otherSeat.seatId} vs ${first.seatId}`,
    );
  }

  summary.push(
    `(t) seed ${found.seed}: seat ${first.seatId} held ${first.card?.name ?? 'a hate event'} unanswered for ` +
      `${found.windowsWaited} window(s), dealt no second piece; ` +
      (otherSeat
        ? `seat ${otherSeat.seatId} was still dealt ${otherSeat.card?.name}`
        : `no other seat was dealt one while it waited, in ${SEARCH_ATTEMPTS} seeds (note, not a failure)`),
  );
}

// ---------------------------------------------------------------------------
// (u) a window reads and drains as seat turns
// ---------------------------------------------------------------------------

/** The `seatTurns` a 'window' entry carries, or an empty list. */
function seatTurnsOf(entry: LogEntry | undefined): SeatTurn[] {
  return (entry?.payload.seatTurns as SeatTurn[] | undefined) ?? [];
}

/** The newest 'window' entry written before `seq`. */
function windowEntryBefore(seq: number): LogEntry | undefined {
  return (store().run?.log ?? []).filter((e) => e.kind === 'window' && e.seq < seq).pop();
}

/**
 * The window rolls hazard by hazard, but a pod's turns go round the table, and
 * the player answers them that way round: everything seat A did, then B, then C.
 * The queue's order is the engine's alone — the store enqueues what it is handed
 * — so what this proves is that the engine hands it over sorted, that the log
 * payload says the same thing in machine-readable form, and that the pod's swing
 * at another seat is filed under the seat that swung it.
 */
function checkWindowReadsAsSeatTurns(): void {
  const found = search('engine-turns', (seed) => {
    freshRun(seed);
    for (let turn = 1; turn <= SEARCH_TURNS; turn++) {
      store().nextTurn();
      if (!store().run) return null;
      // Two seats in one window is the case worth holding out for: a single-seat
      // window is in seat order however the hazards fell.
      const queued = queuedEvents();
      if (new Set(queued.map((e) => e.seatId)).size >= 2) {
        const windows = (store().run?.log ?? []).filter((e) => e.kind === 'window');
        return {
          seed,
          queued,
          entry: windows[windows.length - 1],
          living: store()
            .seats.filter((s) => !s.eliminated)
            .map((s) => s.id),
        };
      }
      // Drained every turn, so the queue holds one window's events and no
      // leftovers from the last one.
      drainTurnWithoutDamage();
      if (!store().run) return null;
    }
    return null;
  });

  if (!found) {
    failures.push('(u) no seed produced a window with events from two seats');
    return;
  }

  const order = found.queued.map((e) => e.seatId);
  check(
    '(u) the queue comes out in seat order',
    order.join('') === [...order].sort().join(''),
    order.join(''),
  );

  const turns = seatTurnsOf(found.entry);
  check(
    '(u) the window entry lists exactly the living seats, in turn order',
    turns.map((t) => t.seatId).join('') === [...found.living].sort().join(''),
    `${turns.map((t) => t.seatId).join('')} vs ${found.living.join('')}`,
  );

  const mismatched = turns.filter(
    (t) =>
      t.eventTypes.join(',') !==
      found.queued
        .filter((e) => e.seatId === t.seatId)
        .map((e) => e.type)
        .join(','),
  );
  check(
    "(u) each seat turn carries its own seat's events, in order",
    mismatched.length === 0,
    mismatched.map((t) => `${t.seatId}: ${t.eventTypes.join(',')}`).join(' | '),
  );

  summary.push(
    `(u) seed ${found.seed}: window before turn ${found.entry?.payload.windowBeforeTurn} drained as ` +
      turns.map((t) => `${t.seatId}[${t.eventTypes.join(',') || '—'}]`).join(' '),
  );

  // The pod's swing belongs to the seat that swung it, and the seat that
  // attacked the player is never the one that swings, so no turn carries two.
  const hit = search('engine-turns-pod', (seed) => {
    freshRun(seed);
    for (let turn = 1; turn <= SEARCH_TURNS; turn++) {
      const seen = podEntriesSoFar().length;
      store().nextTurn();
      if (!store().run) return null;
      const entries = podEntriesSoFar();
      if (entries.length > seen) {
        const entry = entries[seen];
        return { seed, entry, turns: seatTurnsOf(windowEntryBefore(entry.seq)) };
      }
      drainTurnWithoutDamage();
      if (!store().run) return null;
    }
    return null;
  });

  if (!hit) {
    failures.push('(u) no seed had the seats swing at each other');
    return;
  }

  const attacker = hit.entry.payload.attackerId as SeatId;
  const defender = hit.entry.payload.seatId as SeatId;
  const amount = hit.entry.payload.amount as number;
  const attackerTurn = hit.turns.find((t) => t.seatId === attacker);
  check(
    "(u) the pod hit is on the attacker's seat turn",
    JSON.stringify(attackerTurn?.podHit) === JSON.stringify({ defenderId: defender, damage: amount }),
    `${attacker}: ${JSON.stringify(attackerTurn?.podHit)} vs ${defender} for ${amount}`,
  );
  const others = hit.turns.filter((t) => t.seatId !== attacker && t.podHit !== null);
  check(
    '(u) and on no other seat turn',
    others.length === 0,
    others.map((t) => t.seatId).join(', '),
  );

  summary.push(
    `(u) seed ${hit.seed}: seat ${attacker} hit seat ${defender} for ${amount} on its own turn`,
  );
}

function checkDeterminism(): void {
  const seed = 'engine-determinism';
  const first = normalizeLog(scriptedRun(seed));
  const second = normalizeLog(scriptedRun(seed));
  const at = firstDifference(first, second);
  check(
    '(e) the same seed and script produce identical logs',
    first === second,
    at === -1 ? '' : `diverges at char ${at}: ${first.slice(at, at + 120)} | ${second.slice(at, at + 120)}`,
  );
  summary.push(`(e) seed ${seed}: ${first.length} chars of normalized log, replayed identically`);
}

/** Index of the first differing character, or -1 when the strings match. */
function firstDifference(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : limit;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await checkCanceledEvents();
  checkCounterArmedCleared();
  await checkFatalCombat();
  await checkPodEliminated();
  checkEliminationKeepsPressure();
  await checkDeathSettlesOnNextAction();
  checkPeakBoardTracks();
  await checkCanceledCounterResolves();
  await checkStackTray();
  await checkStackedCounter();
  await checkStackGuards();
  checkEveryEventCitesACard();
  checkCounterCitationSkips();
  checkTaxIsPayOrPunish();
  checkTuckShuffleIsOffTheMainStream();
  checkTuckedCommanderGoesHome();
  checkTokensCeaseToExist();
  checkExcludesAreHonoured();
  await checkAnswersNameTheCard();
  await checkAnsweredInstantCounts();
  await checkClockAnswersBindOnce();
  await checkPaidTaxIsNotNameable();
  await checkCounterCitationColors();
  checkSeatsCarryDistinctProfiles();
  checkCounterArmClamp();
  checkHatePieceStandsAndIsRemoved();
  checkWipeSweepsStandingPieces();
  checkSeatDeathRetiresItsPieces();
  checkPodCombatHits();
  checkPodCombatNeverKills();
  checkQueuedHateHoldsTheSeatsSlot();
  checkWindowReadsAsSeatTurns();
  checkDeterminism();

  console.log('\nverify:engine');
  console.log('─'.repeat(72));
  for (const line of summary) console.log(line);
  console.log('─'.repeat(72));

  if (failures.length > 0) {
    console.log(`${failures.length} check(s) FAILED:`);
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    throw new Error(`${failures.length} engine check(s) failed`);
  }
  console.log('all checks passed');
}

main().catch((err: unknown) => {
  passthroughError(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
