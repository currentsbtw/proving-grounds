/**
 * Verification harness for the M1 pressure store.
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
 * Twelve checks, each labelled:
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
 * (a) to (c), (h), (i), (k) and (l) need a run where the pod actually did the thing
 * being tested, so each one searches seeds until it finds one and prints which
 * it used. Failures are collected rather than thrown, so one execution reports
 * everything.
 */
import {
  canMulligan,
  cardsInZone,
  isInstantOrSorceryCard,
  isLandCard,
  manaValueOf,
  useGameStore,
  type GameState,
} from '../src/state/gameStore.ts';
import { scoreRun } from '../src/engine/scorecard.ts';
import { PRESSURE } from '../src/data/pressure.ts';
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
    if (event.type === 'combat') store().respondToActiveEvent('blocked it');
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

  const found = search('engine-silhouette', (seed) => {
    freshRun(seed);
    for (let turn = 1; turn <= SEARCH_TURNS; turn++) {
      if (!store().run) return null;
      if (store().clock) store().declareInteraction();
      drainEventsWithoutDamage();
      if (!store().run) return null;
      const seat = seatOf(victim);
      if (seat && seat.threat >= PRESSURE.threat.max) return { seed, turn: store().turn };
      store().nextTurn();
    }
    return null;
  });

  if (!found) {
    failures.push('(h) no seed pinned a seat at the threat cap within the search');
    return;
  }

  const atCap = seatOf(victim);
  if (!atCap) {
    failures.push('(h) the seat vanished at the cap');
    return;
  }
  const boardAtCap: Silhouette = { ...atCap.silhouette };

  // Three more windows with threat unable to rise. The board grows anyway.
  for (let i = 0; i < 3; i++) {
    store().nextTurn();
    if (!store().run) break;
    if (store().clock) store().declareInteraction();
    drainEventsWithoutDamage();
  }

  const grown = seatOf(victim);
  const peakBoard = grown?.peakSilhouette;
  if (!grown || !peakBoard) {
    failures.push('(h) no peak board recorded for the seat');
    return;
  }
  check('(h) the seat is still pinned at the cap', grown.threat >= PRESSURE.threat.max, `${grown.threat}`);
  check(
    '(h) its board grew while the cap held',
    grown.silhouette.power > boardAtCap.power,
    `power ${boardAtCap.power} -> ${grown.silhouette.power}`,
  );
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

  store().respondToActiveEvent('forced it through');
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
 */
function normalizeLog(record: RunRecord): string {
  const stripped = record.log.map((entry) => ({ ...entry, at: 0 }));
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
