import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { createRng, randomSeed, shuffleInPlace } from '../domain/rng';
import { nextPhaseOf } from '../domain/phases';
import { saveRun } from '../db/db';
import { PRESSURE } from '../data/pressure';
import {
  applyDamageToSeat,
  emptySilhouette,
  initialThreat,
  makeCounterEvent,
  playerThreatOf,
  redistribute,
  resolveWindow,
  toSnapshot,
  zeroFiredCounts,
  zeroLastFiredWindow,
  type FiredCounts,
  type LastFiredWindow,
  type PermanentSummary,
  type PlayerSummary,
} from '../engine/pressure';
import type {
  CardData,
  CardInstance,
  ClockState,
  CounterArmed,
  Deck,
  EventType,
  LogEntry,
  LogKind,
  Phase,
  PressureEvent,
  RosterEntry,
  RunRecord,
  RunResult,
  Seat,
  SeatId,
  Silhouette,
  TokenSpec,
  ZoneId,
} from '../domain/types';

export const STARTING_LIFE = 40;
export const STARTING_HAND_SIZE = 7;
export const LETHAL_COMMANDER_DAMAGE = 21;

export type LifeTarget = 'player' | SeatId;

/** Extra options for `moveCard`. The bare 'top' | 'bottom' form is still accepted. */
export interface MoveOptions {
  /** Only meaningful when moving to the library. Defaults to 'top'. */
  position?: 'top' | 'bottom';
  /** Arrive on the battlefield already tapped. Ignored for other zones. */
  tapped?: boolean;
}

export type MoveArg = 'top' | 'bottom' | MoveOptions;

/**
 * Optional detail supplied when the player resolves a pressure event on the
 * table. Everything is optional: the engine's own numbers are the default, and
 * the payload only overrides what the real board disagreed with.
 */
export interface ResolveEventPayload {
  /** combat — how much actually got through after blocks. Defaults to the offer. */
  damageTaken?: number;
  /** removal / counter — override the engine's chosen target. */
  targetIid?: string;
  /** resource (discard) — the card you pitched. */
  discardIid?: string;
  /** resource (sacrifice) — the permanent you gave up. */
  sacrificeIid?: string;
  /** wipe — force the "all nonlands" variant regardless of what was rolled. */
  wipeNonlands?: boolean;
  /** Free-text table note recorded on the log entry. */
  note?: string;
}

const SEAT_IDS: SeatId[] = ['A', 'B', 'C'];

const ZONE_LABELS: Record<ZoneId, string> = {
  library: 'library',
  hand: 'hand',
  battlefield: 'battlefield',
  graveyard: 'graveyard',
  exile: 'exile',
  command: 'command zone',
};

/**
 * Three fresh seats. With an rng they open at a randomised 1–2 threat, which is
 * what `startRun` wants; without one they open flat, which is what the cleared
 * post-run state wants.
 */
function freshSeats(rng?: () => number): Seat[] {
  return SEAT_IDS.map((id) => ({
    id,
    life: STARTING_LIFE,
    commanderDamage: 0,
    eliminated: false,
    threat: rng ? initialThreat(rng) : PRESSURE.threat.startMin,
    silhouette: emptySilhouette(),
  }));
}

/** Type line for a card instance — tokens carry their own, real cards use the cache. */
function typeLineOf(state: GameState, card: CardInstance): string {
  if (card.isToken) return card.tokenSpec?.typeLine ?? 'Creature — Token';
  if (card.scryfallId) return state.cardData[card.scryfallId]?.typeLine ?? '';
  return '';
}

export function isLandCard(state: GameState, card: CardInstance): boolean {
  return /\bLand\b/i.test(typeLineOf(state, card));
}

export function isCreatureCard(state: GameState, card: CardInstance): boolean {
  return /\bCreature\b/i.test(typeLineOf(state, card));
}

/** Mana value from the Scryfall cache. Tokens are 0. */
export function manaValueOf(state: GameState, card: CardInstance): number {
  if (card.isToken || !card.scryfallId) return 0;
  return state.cardData[card.scryfallId]?.manaValue ?? 0;
}

/** Printed power as a number; `*` and missing values read as 0. */
function powerOf(state: GameState, card: CardInstance): number {
  const raw = card.isToken
    ? card.tokenSpec?.power
    : card.scryfallId
      ? state.cardData[card.scryfallId]?.power
      : undefined;
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

/** Everything the engine is told about the player. Never a card list. */
function playerSummaryOf(state: GameState): PlayerSummary {
  let boardMV = 0;
  let boardPower = 0;
  let commanderOnBattlefield = false;
  for (const card of Object.values(state.cards)) {
    if (card.zone !== 'battlefield') continue;
    if (card.isCommander) commanderOnBattlefield = true;
    if (!card.isToken && !isLandCard(state, card)) boardMV += manaValueOf(state, card);
    if (isCreatureCard(state, card)) boardPower += powerOf(state, card);
  }

  let damageDealtRecent = 0;
  const oldest = state.turn - PRESSURE.playerThreat.recentTurns + 1;
  for (const [turn, amount] of Object.entries(state.damageDealtByTurn)) {
    if (Number(turn) >= oldest) damageDealtRecent += amount;
  }

  return {
    life: state.playerLife,
    boardMV,
    boardPower,
    commanderOnBattlefield,
    damageDealtRecent,
  };
}

/** The player's battlefield, flattened for the engine's targeting heuristic. */
function playerPermanentsOf(state: GameState): PermanentSummary[] {
  return Object.values(state.cards)
    .filter((c) => c.zone === 'battlefield')
    .sort(byArrival)
    .map((c) => ({
      iid: c.iid,
      name: cardName(state, c.iid),
      manaValue: manaValueOf(state, c),
      isCommander: c.isCommander,
      isToken: c.isToken,
      isLand: isLandCard(state, c),
      movedAt: c.movedAt,
    }));
}

/**
 * The player's 0–10 threat as it stands *right now*, rather than as of the last
 * window (`state.playerThreat`). Use this for a live meter; use the stored one
 * when showing what the pod actually judged.
 */
export function currentPlayerThreat(state: GameState): number {
  return playerThreatOf(playerSummaryOf(state));
}

/** Machine-readable payload for a pressure event, shared by every log entry. */
function eventPayload(event: PressureEvent): Record<string, unknown> {
  return {
    eventId: event.id,
    eventType: event.type,
    seatId: event.seatId,
    eventTurn: event.turn,
    severity: event.severity,
    variant: event.variant,
    targetIid: event.targetIid,
    state: event.state,
  };
}

export interface GameState {
  run: RunRecord | null;
  phase: Phase;
  turn: number;
  playerLife: number;
  seats: Seat[];
  cards: Record<string, CardInstance>;
  libraryOrder: string[];
  commanderCasts: Record<string, number>;
  cardData: Record<string, CardData>;
  mulliganCount: number;
  /** True once the opening hand has been kept. Reset by startRun and takeMulligan. */
  mulliganResolved: boolean;
  rng: (() => number) | null;
  lastAutoDrawTurn: number;
  /** Monotonic source for CardInstance.movedAt. Never reset mid-run. */
  moveCounter: number;

  // --- M1 pressure state --------------------------------------------------
  /** Queue behind `activeEvent` — the active one is NOT also in here. */
  pendingEvents: PressureEvent[];
  /** The event in front of the player right now, or null. */
  activeEvent: PressureEvent | null;
  /** The seat racing to win, and the last turn you may finish before losing. */
  clock: ClockState | null;
  /** A seat holding up interaction for the current turn, or null. */
  counterArmed: CounterArmed | null;
  /** Derived 0–10 rating of how scary the player looked at the last window. */
  playerThreat: number;
  /** How many opponent windows have resolved this run. */
  windowCount: number;
  /** Firings per event type this run, for the engine's caps. */
  firedCounts: FiredCounts;
  /** Window index of the last firing per type, for the engine's cooldowns. */
  lastFiredWindow: LastFiredWindow;
  /** Damage the player dealt to seats, keyed by the turn it landed on. */
  damageDealtByTurn: Record<number, number>;
  /** Monotonic suffix that keeps event ids unique without breaking determinism. */
  eventSeq: number;

  startRun: (deck: Deck, cardData: Record<string, CardData>, seed?: string) => void;
  takeMulligan: () => void;
  resolveMulligan: (bottomIids: string[]) => void;
  moveCard: (iid: string, toZone: ZoneId, options?: MoveArg) => void;
  drawCards: (n: number) => void;
  shuffleLibrary: () => void;
  millCards: (n: number) => void;
  revealTop: (n: number) => CardInstance[];
  castCommander: (iid: string) => void;
  toggleTapped: (iid: string) => void;
  untapAll: () => void;
  addCounter: (iid: string, kind: string, delta: number) => void;
  createToken: (spec: TokenSpec, n: number) => void;
  adjustLife: (target: LifeTarget, delta: number) => void;
  dealCommanderDamage: (seatId: SeatId, amount: number) => void;
  nextPhase: () => void;
  nextTurn: () => void;
  endRun: (result: RunResult) => Promise<void>;
  logNote: (message: string) => void;
  undoLastLifeChange: () => void;

  /**
   * Resolve the opponent window that sits before `upcomingTurn`. Called
   * automatically by the turn-advance path — the UI should not call it.
   * Returns false when the run ended (the race clock ran out).
   */
  resolveOpponentWindow: (upcomingTurn?: number) => boolean;
  /** "I had an answer." Negates the active event without applying anything. */
  respondToActiveEvent: (note?: string) => void;
  /** "It resolved." Applies the event's bookkeeping, then advances the queue. */
  resolveActiveEvent: (payload?: ResolveEventPayload) => void;
  /** Cancel the race clock by claiming held interaction (honor system). */
  declareInteraction: () => void;
}

/** Display name for a card instance (token name, cached Scryfall name, or a fallback). */
export function cardName(state: GameState, iid: string): string {
  const card = state.cards[iid];
  if (!card) return 'Unknown card';
  if (card.isToken) return card.tokenSpec?.name ?? 'Token';
  if (card.scryfallId) return state.cardData[card.scryfallId]?.name ?? 'Unknown card';
  return 'Unknown card';
}

/**
 * All instances currently in a zone. The library is returned in library order
 * (top first); every other zone is ordered by arrival, oldest first — so the
 * last element is the most recently arrived card ("top of the graveyard").
 */
export function cardsInZone(state: GameState, zone: ZoneId): CardInstance[] {
  if (zone === 'library') {
    return state.libraryOrder.map((iid) => state.cards[iid]).filter(Boolean);
  }
  return Object.values(state.cards)
    .filter((c) => c.zone === zone)
    .sort(byArrival);
}

/** Sort comparator for the unordered zones: oldest arrival first. */
export function byArrival(a: CardInstance, b: CardInstance): number {
  return a.movedAt - b.movedAt;
}

/**
 * Whether the opening hand is still undecided — the condition the mulligan bar
 * and the mulligan hotkey both key off. The `mulliganResolved` flag is
 * authoritative; the zone check also retires the bar the moment a card is
 * actually played without a keep having been recorded.
 */
export function canMulligan(state: GameState): boolean {
  if (!state.run) return false;
  if (state.turn !== 1 || state.phase !== 'main1') return false;
  if (state.mulliganResolved) return false;
  return !Object.values(state.cards).some(
    (c) =>
      !c.isCommander &&
      (c.zone === 'battlefield' || c.zone === 'graveyard' || c.zone === 'exile'),
  );
}

export function commanderTax(state: GameState, scryfallId: string): number {
  return 2 * (state.commanderCasts[scryfallId] ?? 0);
}

function makeInstance(
  scryfallId: string | null,
  zone: ZoneId,
  isCommander: boolean,
  movedAt: number,
): CardInstance {
  return {
    iid: nanoid(10),
    scryfallId,
    zone,
    tapped: false,
    faceDown: false,
    counters: {},
    isCommander,
    isToken: scryfallId === null,
    movedAt,
  };
}

/**
 * A log entry that `undoLastLifeChange` knows how to reverse: a life adjustment
 * or a commander-damage hit. Elimination notices (kind 'damage' with a `reason`
 * but no `amount`) and undo entries themselves are deliberately excluded.
 */
function isUndoableLifeEntry(entry: LogEntry): boolean {
  if (entry.payload.undoOf !== undefined) return false;
  if (entry.kind === 'life') {
    return typeof entry.payload.before === 'number' && typeof entry.payload.target === 'string';
  }
  if (entry.kind === 'damage') {
    return (
      typeof entry.payload.amount === 'number' &&
      typeof entry.payload.lifeBefore === 'number' &&
      typeof entry.payload.commanderDamageBefore === 'number'
    );
  }
  return false;
}

/** Whether a seat that is currently eliminated stays eliminated at the restored totals. */
function stillEliminated(seat: Seat, life: number, commanderDamage: number): boolean {
  if (!seat.eliminated) return false;
  return life <= 0 || commanderDamage >= LETHAL_COMMANDER_DAMAGE;
}

export const useGameStore = create<GameState>((set, get) => {
  function appendLog(kind: LogKind, message: string, payload: Record<string, unknown> = {}): void {
    set((s) => {
      if (!s.run) return s;
      const entry: LogEntry = {
        seq: s.run.log.length + 1,
        turn: s.turn,
        phase: s.phase,
        kind,
        message,
        payload,
        at: Date.now(),
      };
      return { run: { ...s.run, log: [...s.run.log, entry] } };
    });
  }

  function rngOrFallback(): () => number {
    const rng = get().rng;
    if (rng) return rng;
    const fallback = createRng(get().run?.seed ?? randomSeed());
    set({ rng: fallback });
    return fallback;
  }

  /** Draw without logging; returns the iids actually drawn. */
  function takeFromTop(n: number): string[] {
    const { libraryOrder } = get();
    const taken = libraryOrder.slice(0, n);
    if (taken.length === 0) return [];
    set((s) => {
      const cards = { ...s.cards };
      let stamp = s.moveCounter;
      for (const iid of taken) {
        stamp += 1;
        cards[iid] = { ...cards[iid], zone: 'hand', tapped: false, movedAt: stamp };
      }
      return { cards, libraryOrder: s.libraryOrder.slice(taken.length), moveCounter: stamp };
    });
    return taken;
  }

  function shuffleSilently(): void {
    const rng = rngOrFallback();
    set((s) => {
      const order = [...s.libraryOrder];
      shuffleInPlace(order, rng);
      return { libraryOrder: order };
    });
  }

  function checkSeatElimination(seatId: SeatId): void {
    const seat = get().seats.find((s) => s.id === seatId);
    if (!seat || seat.eliminated) return;
    const byLife = seat.life <= 0;
    const byCommander = seat.commanderDamage >= LETHAL_COMMANDER_DAMAGE;
    if (!byLife && !byCommander) return;
    // The seat is out: it stops growing, stops attacking, and its board is gone.
    set((s) => ({
      seats: s.seats.map((x) =>
        x.id === seatId
          ? { ...x, eliminated: true, threat: 0, silhouette: emptySilhouette() }
          : x,
      ),
    }));
    appendLog('damage', `Seat ${seatId} eliminated`, {
      seatId,
      reason: byCommander ? 'commander-damage' : 'life',
      life: seat.life,
      commanderDamage: seat.commanderDamage,
      threatAtDeath: seat.threat,
      silhouetteAtDeath: seat.silhouette,
    });

    // An eliminated seat cannot win the race it started.
    if (get().clock?.seatId === seatId) {
      const clock = get().clock;
      set({ clock: null });
      appendLog('threat', `Seat ${seatId} is out — its race clock is canceled.`, {
        seatId,
        canceled: true,
        reason: 'elimination',
        deadlineTurn: clock?.deadlineTurn,
      });
    }

    // Pressure does not drop when a seat dies; it concentrates. Event frequency
    // is already seat-independent, so only threat and board move here.
    const updates = redistribute(
      // The dead seat's own pre-death numbers are what the survivors inherit.
      get().seats.map((x) => (x.id === seatId ? { ...toSnapshot(x), threat: seat.threat, silhouette: seat.silhouette } : toSnapshot(x))),
      seatId,
    );
    if (updates.length > 0) {
      applySeatUpdates(updates);
      appendLog(
        'threat',
        `Pressure redistributed — ${updates.map((u) => `${u.id} ${u.threat.toFixed(1)}`).join(', ')}`,
        { from: seatId, updates, reason: 'elimination' },
      );
    }
  }

  /** Untap everything on the battlefield without logging; returns how many untapped. */
  function untapAllSilently(): number {
    let count = 0;
    set((s) => {
      const cards = { ...s.cards };
      for (const card of Object.values(s.cards)) {
        if (card.zone === 'battlefield' && card.tapped) {
          cards[card.iid] = { ...card, tapped: false };
          count++;
        }
      }
      return { cards };
    });
    return count;
  }

  function performUntapStep(): void {
    const count = untapAllSilently();
    appendLog('tap', `Untap step: ${count} permanent${count === 1 ? '' : 's'} untapped`, { count });
  }

  function performDrawStep(): void {
    const { turn, lastAutoDrawTurn } = get();
    if (lastAutoDrawTurn === turn) return;
    set({ lastAutoDrawTurn: turn });
    get().drawCards(1);
  }

  // -------------------------------------------------------------------------
  // Pressure plumbing
  // -------------------------------------------------------------------------

  /** Write threat/silhouette back onto the named seats. Leaves life alone. */
  function applySeatUpdates(
    updates: { id: SeatId; threat: number; silhouette: Silhouette }[],
  ): void {
    if (updates.length === 0) return;
    const byId = new Map(updates.map((u) => [u.id, u]));
    set((s) => ({
      seats: s.seats.map((seat) => {
        const update = byId.get(seat.id);
        return update ? { ...seat, threat: update.threat, silhouette: update.silhouette } : seat;
      }),
    }));
  }

  /** A seat that just did something gets scarier. */
  function bumpSeatThreat(seatId: SeatId, type: EventType): void {
    set((s) => ({
      seats: s.seats.map((seat) =>
        seat.id === seatId
          ? {
              ...seat,
              threat: Math.min(
                PRESSURE.threat.max,
                Math.round((seat.threat + PRESSURE.threat.eventJump[type]) * 10) / 10,
              ),
            }
          : seat,
      ),
    }));
  }

  /**
   * Push events onto the queue, stamping each id with a monotonic suffix so
   * two identical-looking events never collide as React keys. The first event
   * becomes active when nothing is active already.
   */
  function enqueueEvents(events: PressureEvent[]): PressureEvent[] {
    if (events.length === 0) return [];
    const stamped: PressureEvent[] = [];
    set((s) => {
      let seq = s.eventSeq;
      for (const event of events) stamped.push({ ...event, id: `${event.id}-${++seq}` });
      const queue = [...s.pendingEvents, ...stamped];
      const active = s.activeEvent ?? queue.shift() ?? null;
      return { eventSeq: seq, pendingEvents: queue, activeEvent: active };
    });
    return stamped;
  }

  /** Retire the active event and pull the next one forward. */
  function advanceQueue(): void {
    set((s) => {
      const queue = [...s.pendingEvents];
      const next = queue.shift() ?? null;
      return { activeEvent: next, pendingEvents: queue };
    });
    const next = get().activeEvent;
    if (next) {
      appendLog('event', `Next: ${next.prompt}`, { ...eventPayload(next), activated: true });
    }
  }

  /** All battlefield instances a wipe of this scope would sweep away. */
  function wipeVictims(nonlands: boolean): string[] {
    const state = get();
    return Object.values(state.cards)
      .filter((c) => c.zone === 'battlefield')
      .filter((c) => (nonlands ? !isLandCard(state, c) : isCreatureCard(state, c)))
      .sort(byArrival)
      .map((c) => c.iid);
  }

  /**
   * The raw zone move. `moveCard` is this plus the counterspell interception,
   * so anything that must move regardless of held-up mana calls straight in
   * here: wipes, removal, a countered spell going to the graveyard, and a
   * spell the player forced through.
   */
  function performMove(iid: string, toZone: ZoneId, options?: MoveArg): void {
    const state = get();
    const card = state.cards[iid];
    if (!card || card.zone === toZone) return;
    const fromZone = card.zone;
    const name = cardName(state, iid);

    const opts: MoveOptions = typeof options === 'string' ? { position: options } : (options ?? {});
    const position = opts.position ?? 'top';
    const entersTapped = toZone === 'battlefield' && opts.tapped === true;

    set((s) => {
      const next: CardInstance = {
        ...s.cards[iid],
        zone: toZone,
        tapped: toZone === 'battlefield' ? s.cards[iid].tapped || entersTapped : false,
        counters: toZone === 'battlefield' ? s.cards[iid].counters : {},
        movedAt: s.moveCounter + 1,
      };
      const cards = { ...s.cards, [iid]: next };
      let libraryOrder = s.libraryOrder.filter((x) => x !== iid);
      if (toZone === 'library') {
        libraryOrder = position === 'bottom' ? [...libraryOrder, iid] : [iid, ...libraryOrder];
      }
      return { cards, libraryOrder, moveCounter: s.moveCounter + 1 };
    });

    const suffix = toZone === 'library' ? ` (${position})` : entersTapped ? ' — enters tapped' : '';
    appendLog('move', `${name}: ${ZONE_LABELS[fromZone]} → ${ZONE_LABELS[toZone]}${suffix}`, {
      iid,
      name,
      from: fromZone,
      to: toZone,
      position: toZone === 'library' ? position : undefined,
      tapped: entersTapped || undefined,
      isCommander: card.isCommander,
    });

    if (card.isCommander && (toZone === 'graveyard' || toZone === 'exile')) {
      appendLog(
        'commander',
        `${name} changed zones to ${ZONE_LABELS[toZone]} — commander may return to the command zone`,
        { iid, name, to: toZone },
      );
    }
  }

  /**
   * An armed seat catches a spell on its way to the battlefield. The card stays
   * where it was cast from — hand for a normal spell, the command zone for a
   * commander — until the player says what happened: `resolveActiveEvent` bins
   * it (or returns a commander to the command zone), `respondToActiveEvent`
   * forces it through. Consumes no rng, so a seed replays identically whether
   * or not the player happened to cast into an armed seat.
   */
  function raiseCounterEvent(iid: string, armed: CounterArmed): void {
    const state = get();
    const card = state.cards[iid];
    if (!card) return;
    const manaValue = manaValueOf(state, card);
    const event = makeCounterEvent(
      state.windowCount,
      armed.seatId,
      state.turn,
      iid,
      cardName(state, iid),
      armed.threshold,
      manaValue,
      card.isCommander,
    );

    // A counter is about the spell you just cast, so it jumps the queue; the
    // event it displaced goes back to the front and returns after.
    set((s) => {
      const seq = s.eventSeq + 1;
      const stamped: PressureEvent = { ...event, id: `${event.id}-${seq}` };
      return {
        eventSeq: seq,
        activeEvent: stamped,
        pendingEvents: s.activeEvent ? [s.activeEvent, ...s.pendingEvents] : s.pendingEvents,
        counterArmed: null,
        firedCounts: { ...s.firedCounts, counter: s.firedCounts.counter + 1 },
        lastFiredWindow: { ...s.lastFiredWindow, counter: s.windowCount },
      };
    });

    const active = get().activeEvent;
    if (active) {
      appendLog('event', active.prompt, { ...eventPayload(active), intercepted: true });
    }
    bumpSeatThreat(armed.seatId, 'counter');
  }

  /**
   * Advance to `turn + 1` through the single path both `nextPhase` (wrapping
   * off the end step) and `nextTurn` (skipping ahead) share. The opponent
   * window resolves first — the pod takes its turns before yours begins.
   */
  function beginNextTurn(via: 'phase' | 'skip'): void {
    const state = get();
    if (!state.run) return;
    const upcoming = state.turn + 1;

    if (!runOpponentWindow(upcoming)) return;

    set({ turn: upcoming, phase: 'untap' });
    appendLog('turn', `Turn ${upcoming} begins`, {
      turn: upcoming,
      previousTurn: upcoming - 1,
      from: via === 'phase' ? 'end' : undefined,
      skipped: via === 'skip' || undefined,
    });
    performUntapStep();

    if (via === 'skip') {
      set({ phase: 'draw' });
      performDrawStep();
      set({ phase: 'main1' });
      appendLog('phase', 'Phase: main1', { from: 'draw', to: 'main1', turn: upcoming });
    }
  }

  /**
   * Run the engine for the window before `upcomingTurn` and fold the result
   * into state. Returns false when the race clock expired and the run ended.
   */
  function runOpponentWindow(upcomingTurn: number): boolean {
    const state = get();
    if (!state.run) return true;

    const windowIndex = state.windowCount + 1;
    const result = resolveWindow({
      turn: upcomingTurn,
      windowIndex,
      bracket: state.run.bracket,
      rng: rngOrFallback(),
      seats: state.seats.map(toSnapshot),
      player: playerSummaryOf(state),
      permanents: playerPermanentsOf(state),
      clock: state.clock,
      counterArmed: state.counterArmed,
      firedCounts: state.firedCounts,
      lastFiredWindow: state.lastFiredWindow,
    });

    if (result.clockExpired) {
      const clock = state.clock;
      appendLog('window', result.summary, {
        window: windowIndex,
        windowBeforeTurn: upcomingTurn,
        clockExpired: true,
        clockSeatId: clock?.seatId,
        deadlineTurn: clock?.deadlineTurn,
      });
      appendLog('run', `Lost the race — Seat ${clock?.seatId} won on the turn after turn ${clock?.deadlineTurn}.`, {
        reason: 'clock-expired',
        seatId: clock?.seatId,
        deadlineTurn: clock?.deadlineTurn,
        turn: upcomingTurn,
      });
      void get().endRun('loss');
      return false;
    }

    applySeatUpdates(result.seats);

    const firedCounts = { ...state.firedCounts };
    const lastFiredWindow = { ...state.lastFiredWindow };
    for (const event of result.events) {
      firedCounts[event.type] += 1;
      lastFiredWindow[event.type] = windowIndex;
    }

    set({
      windowCount: windowIndex,
      clock: result.clock,
      counterArmed: result.counterArmed,
      playerThreat: result.playerThreat,
      firedCounts,
      lastFiredWindow,
    });

    appendLog('window', result.summary, {
      window: windowIndex,
      windowBeforeTurn: upcomingTurn,
      bracket: state.run.bracket,
      playerThreat: result.playerThreat,
      seats: result.seats,
      eventTypes: result.events.map((e) => e.type),
      counterArmed: result.counterArmed,
      clock: result.clock,
      notes: result.notes,
    });

    const stamped = enqueueEvents(result.events);
    for (const event of stamped) {
      appendLog('event', event.prompt, { ...eventPayload(event), queued: true });
    }
    return true;
  }

  return {
    run: null,
    phase: 'main1',
    turn: 1,
    playerLife: STARTING_LIFE,
    seats: freshSeats(),
    cards: {},
    libraryOrder: [],
    commanderCasts: {},
    cardData: {},
    mulliganCount: 0,
    mulliganResolved: false,
    rng: null,
    lastAutoDrawTurn: 0,
    moveCounter: 0,

    pendingEvents: [],
    activeEvent: null,
    clock: null,
    counterArmed: null,
    playerThreat: 0,
    windowCount: 0,
    firedCounts: zeroFiredCounts(),
    lastFiredWindow: zeroLastFiredWindow(),
    damageDealtByTurn: {},
    eventSeq: 0,

    startRun(deck, cardData, seed) {
      const runSeed = seed ?? randomSeed();
      const rng = createRng(runSeed);

      const cards: Record<string, CardInstance> = {};
      const libraryOrder: string[] = [];
      // Frozen card facts for the scorer. Written here rather than read back off
      // the card cache at scoring time so a run stays scorable forever, even if
      // the deck is edited or the cached Scryfall rows are evicted.
      const roster: Record<string, RosterEntry> = {};
      let stamp = 0;

      function enroll(inst: CardInstance, scryfallId: string, isCommander: boolean): void {
        const data = cardData[scryfallId];
        roster[inst.iid] = {
          scryfallId,
          name: data?.name ?? 'Unknown card',
          manaValue: data?.manaValue ?? 0,
          typeLine: data?.typeLine ?? '',
          isCommander,
        };
      }

      for (const ref of deck.cards) {
        for (let i = 0; i < ref.qty; i++) {
          const inst = makeInstance(ref.scryfallId, 'library', false, ++stamp);
          cards[inst.iid] = inst;
          libraryOrder.push(inst.iid);
          enroll(inst, ref.scryfallId, false);
        }
      }
      for (const commanderId of deck.commanderIds) {
        const inst = makeInstance(commanderId, 'command', true, ++stamp);
        cards[inst.iid] = inst;
        enroll(inst, commanderId, true);
      }

      shuffleInPlace(libraryOrder, rng);
      // Drawn after the shuffle so the rng sequence is fixed for a given seed.
      const seats = freshSeats(rng);

      const run: RunRecord = {
        id: nanoid(12),
        deckId: deck.id,
        deckName: deck.name,
        seed: runSeed,
        bracket: deck.bracket,
        startedAt: Date.now(),
        roster,
        log: [],
      };

      set({
        run,
        rng,
        phase: 'main1',
        turn: 1,
        playerLife: STARTING_LIFE,
        seats,
        cards,
        libraryOrder,
        commanderCasts: {},
        cardData,
        mulliganCount: 0,
        mulliganResolved: false,
        lastAutoDrawTurn: 1,
        moveCounter: stamp,
        pendingEvents: [],
        activeEvent: null,
        clock: null,
        counterArmed: null,
        playerThreat: 0,
        windowCount: 0,
        firedCounts: zeroFiredCounts(),
        lastFiredWindow: zeroLastFiredWindow(),
        damageDealtByTurn: {},
        eventSeq: 0,
      });

      appendLog('run', `Run started — ${deck.name} (seed ${runSeed})`, {
        runId: run.id,
        deckId: deck.id,
        deckName: deck.name,
        seed: runSeed,
        bracket: deck.bracket,
        librarySize: libraryOrder.length,
        commanders: deck.commanderIds,
        pressureVersion: PRESSURE.version,
      });
      appendLog(
        'threat',
        `Seats seated — ${seats.map((s) => `${s.id} ${s.threat.toFixed(1)}`).join(', ')}`,
        { seats: seats.map((s) => ({ id: s.id, threat: s.threat, silhouette: s.silhouette })) },
      );
      appendLog('shuffle', `Library shuffled (${libraryOrder.length} cards)`, {
        size: libraryOrder.length,
        seed: runSeed,
      });

      const drawn = takeFromTop(STARTING_HAND_SIZE);
      appendLog('draw', `Opening hand: ${drawn.length} cards`, {
        count: drawn.length,
        iids: drawn,
        opening: true,
      });
    },

    takeMulligan() {
      if (!get().run) return;
      const hand = cardsInZone(get(), 'hand').map((c) => c.iid);
      set((s) => {
        const cards = { ...s.cards };
        let stamp = s.moveCounter;
        for (const iid of hand) {
          stamp += 1;
          cards[iid] = { ...cards[iid], zone: 'library', movedAt: stamp };
        }
        return {
          cards,
          libraryOrder: [...s.libraryOrder, ...hand],
          mulliganCount: s.mulliganCount + 1,
          mulliganResolved: false,
          moveCounter: stamp,
        };
      });
      shuffleSilently();
      const count = get().mulliganCount;
      appendLog('mull', `Mulligan to ${Math.max(0, STARTING_HAND_SIZE - count)}`, {
        mulliganCount: count,
        returned: hand.length,
      });
      const drawn = takeFromTop(STARTING_HAND_SIZE);
      appendLog('draw', `Drew ${drawn.length} cards after mulligan`, {
        count: drawn.length,
        iids: drawn,
        mulligan: true,
      });
    },

    resolveMulligan(bottomIids) {
      if (!get().run) return;
      const valid = bottomIids.filter((iid) => get().cards[iid]?.zone === 'hand');
      set((s) => {
        const cards = { ...s.cards };
        let stamp = s.moveCounter;
        for (const iid of valid) {
          stamp += 1;
          cards[iid] = { ...cards[iid], zone: 'library', movedAt: stamp };
        }
        return {
          cards,
          libraryOrder: [...s.libraryOrder, ...valid],
          mulliganResolved: true,
          moveCounter: stamp,
        };
      });
      const names = valid.map((iid) => cardName(get(), iid));
      appendLog('mull', `Kept ${cardsInZone(get(), 'hand').length}; ${valid.length} to the bottom`, {
        mulliganCount: get().mulliganCount,
        bottomIids: valid,
        bottomNames: names,
      });
    },

    moveCard(iid, toZone, options) {
      const state = get();
      const card = state.cards[iid];
      if (!card || card.zone === toZone) return;

      // Counterspell seam. Every M0 path into the battlefield — drag,
      // double-click, card menu — comes through here, so the interception lives
      // here and the feature components stay untouched. Only hand → battlefield
      // is a "cast"; scooping a card back from the graveyard is not.
      const armed = state.counterArmed;
      if (
        armed &&
        card.zone === 'hand' &&
        toZone === 'battlefield' &&
        manaValueOf(state, card) >= armed.threshold
      ) {
        raiseCounterEvent(iid, armed);
        return;
      }

      performMove(iid, toZone, options);
    },

    drawCards(n) {
      if (!get().run || n <= 0) return;
      const available = get().libraryOrder.length;
      const drawn = takeFromTop(Math.min(n, available));
      const names = drawn.map((iid) => cardName(get(), iid));
      appendLog('draw', `Drew ${drawn.length} card${drawn.length === 1 ? '' : 's'}`, {
        count: drawn.length,
        requested: n,
        iids: drawn,
        names,
        libraryRemaining: get().libraryOrder.length,
      });
      if (drawn.length < n) {
        appendLog('note', `Attempted to draw ${n} with ${available} card${available === 1 ? '' : 's'} in library`, {
          requested: n,
          available,
          emptyLibrary: true,
        });
      }
    },

    shuffleLibrary() {
      if (!get().run) return;
      shuffleSilently();
      appendLog('shuffle', `Library shuffled (${get().libraryOrder.length} cards)`, {
        size: get().libraryOrder.length,
      });
    },

    millCards(n) {
      if (!get().run || n <= 0) return;
      const milled = get().libraryOrder.slice(0, n);
      if (milled.length === 0) {
        appendLog('note', 'Nothing to mill — library is empty', { requested: n, available: 0 });
        return;
      }
      set((s) => {
        const cards = { ...s.cards };
        let stamp = s.moveCounter;
        for (const iid of milled) {
          stamp += 1;
          cards[iid] = { ...cards[iid], zone: 'graveyard', tapped: false, counters: {}, movedAt: stamp };
        }
        return { cards, libraryOrder: s.libraryOrder.slice(milled.length), moveCounter: stamp };
      });
      const names = milled.map((iid) => cardName(get(), iid));
      appendLog('move', `Milled ${milled.length}: ${names.join(', ')}`, {
        count: milled.length,
        requested: n,
        iids: milled,
        names,
        from: 'library',
        to: 'graveyard',
      });
    },

    revealTop(n) {
      const state = get();
      const iids = state.libraryOrder.slice(0, Math.max(0, n));
      const revealed = iids.map((iid) => state.cards[iid]).filter(Boolean);
      const names = iids.map((iid) => cardName(state, iid));
      appendLog('note', `Looked at top ${revealed.length}: ${names.join(', ') || '(empty library)'}`, {
        count: revealed.length,
        requested: n,
        iids,
        names,
      });
      return revealed;
    },

    castCommander(iid) {
      const state = get();
      const card = state.cards[iid];
      if (!card || !card.isCommander || !card.scryfallId) return;
      const name = cardName(state, iid);
      const key = card.scryfallId;
      const tax = commanderTax(state, key);
      const priorCasts = state.commanderCasts[key] ?? 0;

      // Commanders are counterable like anything else. The threshold compares
      // the printed mana value — commander tax is paid on top of the cost, it
      // does not make the spell bigger.
      const armed = state.counterArmed;
      if (armed && manaValueOf(state, card) >= armed.threshold) {
        // The cast still happened, so the tax still accrues: the commander is
        // on the stack when it gets answered, and comes back more expensive.
        set((s) => ({ commanderCasts: { ...s.commanderCasts, [key]: priorCasts + 1 } }));
        appendLog(
          'commander',
          `Cast ${name} (cast #${priorCasts + 1}, tax +${tax}) — met by a counter`,
          {
            iid,
            name,
            scryfallId: key,
            castNumber: priorCasts + 1,
            taxPaid: tax,
            nextTax: 2 * (priorCasts + 1),
            from: card.zone,
            to: 'stack',
            countered: true,
          },
        );
        raiseCounterEvent(iid, armed);
        return;
      }

      set((s) => ({
        cards: {
          ...s.cards,
          [iid]: { ...s.cards[iid], zone: 'battlefield', counters: {}, movedAt: s.moveCounter + 1 },
        },
        libraryOrder: s.libraryOrder.filter((x) => x !== iid),
        commanderCasts: { ...s.commanderCasts, [key]: priorCasts + 1 },
        moveCounter: s.moveCounter + 1,
      }));

      appendLog('commander', `Cast ${name} (cast #${priorCasts + 1}, tax +${tax})`, {
        iid,
        name,
        scryfallId: key,
        castNumber: priorCasts + 1,
        taxPaid: tax,
        nextTax: 2 * (priorCasts + 1),
        from: card.zone,
        to: 'battlefield',
      });
    },

    toggleTapped(iid) {
      const state = get();
      const card = state.cards[iid];
      if (!card) return;
      const name = cardName(state, iid);
      const tapped = !card.tapped;
      set((s) => ({ cards: { ...s.cards, [iid]: { ...s.cards[iid], tapped } } }));
      appendLog('tap', `${name} ${tapped ? 'tapped' : 'untapped'}`, { iid, name, tapped });
    },

    untapAll() {
      if (!get().run) return;
      const count = untapAllSilently();
      appendLog('tap', `Untapped all (${count} permanent${count === 1 ? '' : 's'})`, { count });
    },

    addCounter(iid, kind, delta) {
      const state = get();
      const card = state.cards[iid];
      if (!card || delta === 0) return;
      const name = cardName(state, iid);
      const before = card.counters[kind] ?? 0;
      const after = Math.max(0, before + delta);

      set((s) => {
        const counters = { ...s.cards[iid].counters };
        if (after === 0) delete counters[kind];
        else counters[kind] = after;
        return { cards: { ...s.cards, [iid]: { ...s.cards[iid], counters } } };
      });

      appendLog('counter', `${name}: ${kind} ${before} → ${after}`, {
        iid,
        name,
        kind,
        delta,
        before,
        after,
      });
    },

    createToken(spec, n) {
      if (!get().run || n <= 0) return;
      const created: string[] = [];
      set((s) => {
        const cards = { ...s.cards };
        let stamp = s.moveCounter;
        for (let i = 0; i < n; i++) {
          const inst = makeInstance(null, 'battlefield', false, ++stamp);
          inst.tokenSpec = spec;
          cards[inst.iid] = inst;
          created.push(inst.iid);
        }
        return { cards, moveCounter: stamp };
      });
      const size = spec.power && spec.toughness ? `${spec.power}/${spec.toughness} ` : '';
      appendLog('token', `Created ${n} ${size}${spec.name} token${n === 1 ? '' : 's'}`, {
        count: n,
        iids: created,
        spec,
      });
    },

    adjustLife(target, delta) {
      if (!get().run || delta === 0) return;

      if (target === 'player') {
        const before = get().playerLife;
        const after = before + delta;
        set({ playerLife: after });
        appendLog('life', `You: ${before} → ${after}`, { target, delta, before, after });
        if (after <= 0) {
          appendLog('note', 'Player life reached 0', { target, life: after });
        }
        return;
      }

      const seat = get().seats.find((s) => s.id === target);
      if (!seat) return;
      const before = seat.life;
      const after = before + delta;
      const damage = Math.max(0, -delta);
      // Hurting a seat makes it less scary and shrinks the board it presents.
      const shrunk = applyDamageToSeat(seat.threat, seat.silhouette, damage, before);

      set((s) => ({
        seats: s.seats.map((x) =>
          x.id === target
            ? { ...x, life: after, threat: shrunk.threat, silhouette: shrunk.silhouette }
            : x,
        ),
        damageDealtByTurn: damage
          ? { ...s.damageDealtByTurn, [s.turn]: (s.damageDealtByTurn[s.turn] ?? 0) + damage }
          : s.damageDealtByTurn,
      }));

      appendLog('life', `Seat ${target}: ${before} → ${after}`, {
        target,
        seatId: target,
        delta,
        before,
        after,
        threatBefore: seat.threat,
        threatAfter: shrunk.threat,
        silhouetteBefore: seat.silhouette,
      });
      checkSeatElimination(target);
    },

    dealCommanderDamage(seatId, amount) {
      if (!get().run || amount === 0) return;
      const seat = get().seats.find((s) => s.id === seatId);
      if (!seat) return;
      const cmdBefore = seat.commanderDamage;
      const cmdAfter = Math.max(0, cmdBefore + amount);
      const lifeBefore = seat.life;
      const lifeAfter = lifeBefore - amount;
      const shrunk = applyDamageToSeat(
        seat.threat,
        seat.silhouette,
        Math.max(0, amount),
        lifeBefore,
      );

      set((s) => ({
        seats: s.seats.map((x) =>
          x.id === seatId
            ? {
                ...x,
                commanderDamage: cmdAfter,
                life: lifeAfter,
                threat: shrunk.threat,
                silhouette: shrunk.silhouette,
              }
            : x,
        ),
        damageDealtByTurn:
          amount > 0
            ? { ...s.damageDealtByTurn, [s.turn]: (s.damageDealtByTurn[s.turn] ?? 0) + amount }
            : s.damageDealtByTurn,
      }));

      appendLog(
        'damage',
        `Seat ${seatId} took ${amount} commander damage (${cmdAfter}/${LETHAL_COMMANDER_DAMAGE}); life ${lifeBefore} → ${lifeAfter}`,
        {
          seatId,
          amount,
          commanderDamageBefore: cmdBefore,
          commanderDamageAfter: cmdAfter,
          lifeBefore,
          lifeAfter,
          threatBefore: seat.threat,
          threatAfter: shrunk.threat,
          silhouetteBefore: seat.silhouette,
        },
      );
      checkSeatElimination(seatId);
    },

    nextPhase() {
      if (!get().run) return;
      const from = get().phase;
      const to = nextPhaseOf(from);
      const wrapping = from === 'end';

      if (wrapping) {
        beginNextTurn('phase');
        return;
      }

      set({ phase: to });
      appendLog('phase', `Phase: ${to}`, { from, to, turn: get().turn });

      if (to === 'untap') performUntapStep();
      if (to === 'draw') performDrawStep();
    },

    nextTurn() {
      beginNextTurn('skip');
    },

    async endRun(result) {
      const state = get();
      if (!state.run) return;
      const endedAt = Date.now();

      appendLog('run', `Run ended: ${result}`, {
        result,
        endedAt,
        turns: state.turn,
        playerLife: state.playerLife,
        seats: state.seats,
        windows: state.windowCount,
        firedCounts: state.firedCounts,
        unresolvedEvents: (state.activeEvent ? 1 : 0) + state.pendingEvents.length,
        clock: state.clock,
        pressureVersion: PRESSURE.version,
      });

      const finished = get().run;
      if (!finished) return;
      const record: RunRecord = { ...finished, endedAt, result };

      try {
        await saveRun(record);
      } catch (err) {
        console.error('Failed to persist run', err);
      }

      set({
        run: null,
        rng: null,
        phase: 'main1',
        turn: 1,
        playerLife: STARTING_LIFE,
        seats: freshSeats(),
        cards: {},
        libraryOrder: [],
        commanderCasts: {},
        cardData: {},
        mulliganCount: 0,
        mulliganResolved: false,
        lastAutoDrawTurn: 0,
        moveCounter: 0,
        pendingEvents: [],
        activeEvent: null,
        clock: null,
        counterArmed: null,
        playerThreat: 0,
        windowCount: 0,
        firedCounts: zeroFiredCounts(),
        lastFiredWindow: zeroLastFiredWindow(),
        damageDealtByTurn: {},
        eventSeq: 0,
      });
    },

    logNote(message) {
      const text = message.trim();
      if (!get().run || !text) return;
      appendLog('note', text, { note: text, playerAuthored: true });
    },

    undoLastLifeChange() {
      const run = get().run;
      if (!run) return;

      // The log is append-only: an undo never removes the entry it reverses, it
      // marks it with `undoOf`. So "already undone" is read back off the log.
      const undone = new Set<number>();
      for (const entry of run.log) {
        const of = entry.payload.undoOf;
        if (typeof of === 'number') undone.add(of);
      }

      let target: LogEntry | undefined;
      for (let i = run.log.length - 1; i >= 0; i--) {
        const entry = run.log[i];
        if (isUndoableLifeEntry(entry) && !undone.has(entry.seq)) {
          target = entry;
          break;
        }
      }

      if (!target) {
        appendLog('note', 'Nothing to undo — no life change left in the log', {
          undo: true,
          noop: true,
        });
        return;
      }

      // Threat and silhouette were snapshotted on the entry being undone, so
      // rolling back life rolls back the pressure it caused too.
      const restoredThreat = target.payload.threatBefore as number | undefined;
      const restoredSilhouette = target.payload.silhouetteBefore as Silhouette | undefined;

      function restorePressure(seat: Seat): Seat {
        return {
          ...seat,
          threat: restoredThreat ?? seat.threat,
          silhouette: restoredSilhouette ?? seat.silhouette,
        };
      }

      if (target.kind === 'life') {
        const who = target.payload.target as LifeTarget;
        const life = target.payload.before as number;

        if (who === 'player') {
          set({ playerLife: life });
        } else {
          set((s) => ({
            seats: s.seats.map((x) =>
              x.id === who
                ? restorePressure({
                    ...x,
                    life,
                    eliminated: stillEliminated(x, life, x.commanderDamage),
                  })
                : x,
            ),
          }));
        }

        appendLog('life', `Undid: ${target.message}`, {
          undoOf: target.seq,
          target: who,
          restoredLife: life,
          restoredThreat,
        });
        return;
      }

      // Commander damage: life and the commander-damage tally both roll back.
      const seatId = target.payload.seatId as SeatId;
      const life = target.payload.lifeBefore as number;
      const commanderDamage = target.payload.commanderDamageBefore as number;

      set((s) => ({
        seats: s.seats.map((x) =>
          x.id === seatId
            ? restorePressure({
                ...x,
                life,
                commanderDamage,
                eliminated: stillEliminated(x, life, commanderDamage),
              })
            : x,
        ),
      }));

      appendLog('life', `Undid: ${target.message}`, {
        undoOf: target.seq,
        target: seatId,
        seatId,
        restoredLife: life,
        restoredCommanderDamage: commanderDamage,
        restoredThreat,
      });
    },

    resolveOpponentWindow(upcomingTurn) {
      return runOpponentWindow(upcomingTurn ?? get().turn + 1);
    },

    respondToActiveEvent(note) {
      const state = get();
      const event = state.activeEvent;
      if (!state.run || !event) return;

      // A countered spell you force through actually resolves — the card
      // finishes the trip to the battlefield the interception interrupted,
      // whether it was cast from hand or off the command zone.
      if (event.type === 'counter' && event.targetIid) {
        const held = state.cards[event.targetIid];
        if (held && held.zone !== 'battlefield') performMove(event.targetIid, 'battlefield');
      }

      const answered: PressureEvent = { ...event, state: 'negated' };
      const trimmed = note?.trim();
      appendLog('respond', `Answered ${event.type}: ${event.prompt}${trimmed ? ` — "${trimmed}"` : ''}`, {
        ...eventPayload(answered),
        responded: true,
        negated: true,
        note: trimmed,
      });
      advanceQueue();
    },

    resolveActiveEvent(payload) {
      const state = get();
      const event = state.activeEvent;
      if (!state.run || !event) return;

      const outcome: Record<string, unknown> = {};
      /** Appended to the log message when the outcome needs naming. */
      let detail = '';

      switch (event.type) {
        case 'wipe': {
          const nonlands = payload?.wipeNonlands ?? event.variant === 'nonlands';
          const victims = wipeVictims(nonlands);
          for (const iid of victims) performMove(iid, 'graveyard');
          outcome.scope = nonlands ? 'nonlands' : 'creatures';
          outcome.swept = victims.length;
          outcome.iids = victims;
          break;
        }

        case 'removal': {
          const iid = payload?.targetIid ?? event.targetIid;
          const card = iid ? state.cards[iid] : undefined;
          if (iid && card && card.zone === 'battlefield') {
            outcome.targetIid = iid;
            outcome.targetName = cardName(state, iid);
            performMove(iid, 'graveyard');
          } else {
            outcome.noTarget = true;
          }
          break;
        }

        case 'counter': {
          const iid = payload?.targetIid ?? event.targetIid;
          const card = iid ? state.cards[iid] : undefined;
          if (iid && card) {
            const name = cardName(state, iid);
            outcome.counteredIid = iid;
            outcome.counteredName = name;
            outcome.commander = card.isCommander ? 1 : 0;

            if (card.isCommander) {
              // A countered commander never sees the graveyard — it goes back
              // to the command zone. The tax it accrued on the way stays paid,
              // so the next attempt costs more.
              const nextTax = card.scryfallId ? commanderTax(state, card.scryfallId) : 0;
              outcome.returnedTo = 'command';
              outcome.nextTax = nextTax;
              if (card.zone !== 'command') performMove(iid, 'command');
              appendLog(
                'commander',
                `${name} countered — returned to command zone (next cast tax ${nextTax})`,
                {
                  iid,
                  name,
                  scryfallId: card.scryfallId,
                  countered: true,
                  from: card.zone,
                  to: 'command',
                  nextTax,
                },
              );
              detail = ` — ${name} returned to the command zone`;
            } else if (card.zone !== 'graveyard') {
              outcome.returnedTo = 'graveyard';
              performMove(iid, 'graveyard');
              detail = ` — ${name} countered`;
            }
          }
          break;
        }

        case 'combat': {
          const offered = event.severity.damage ?? 0;
          const taken = payload?.damageTaken ?? offered;
          outcome.offered = offered;
          outcome.taken = taken;
          if (taken > 0) get().adjustLife('player', -taken);
          break;
        }

        case 'resource': {
          const discardIid = payload?.discardIid;
          const sacrificeIid = payload?.sacrificeIid;
          const iid = discardIid ?? sacrificeIid;
          const card = iid ? state.cards[iid] : undefined;
          if (iid && card) {
            // Which payload field the caller filled in is a claim; the card's
            // actual zone is the truth. A card in hand is discarded, one on the
            // battlefield is sacrificed — believe the board, and say so.
            const claimed = discardIid ? 'discard' : 'sacrifice';
            const actual =
              card.zone === 'hand'
                ? 'discard'
                : card.zone === 'battlefield'
                  ? 'sacrifice'
                  : null;
            const mode = actual ?? claimed;
            const name = cardName(state, iid);

            outcome.mode = mode;
            outcome.claimedMode = claimed;
            outcome.fromZone = card.zone;
            outcome.iid = iid;
            outcome.name = name;
            if (actual && actual !== claimed) outcome.modeCorrected = true;
            if (!actual) outcome.unexpectedZone = card.zone;

            performMove(iid, 'graveyard');
            detail = ` — ${mode === 'discard' ? 'discarded' : 'sacrificed'} ${name}`;
          } else {
            const mode = event.variant ?? 'tax';
            outcome.mode = mode;
            if (mode === 'discard' || mode === 'sacrifice') {
              // No card came with the resolution: the player had nothing to give.
              // Say so on the entry, otherwise the log reads as an unexplained
              // no-op and the scorer cannot tell a whiff from a mis-click.
              outcome.noTarget = true;
              detail = mode === 'discard' ? ' — nothing to discard' : ' — nothing to sacrifice';
            } else {
              // The 'tax' variant has no bookkeeping — acknowledging it is enough.
              outcome.acknowledged = true;
            }
          }
          break;
        }

        case 'clock': {
          // A clock is a standing warning, not a one-off hit. Acknowledging it
          // files the prompt away; the clock itself lives on in `state.clock`
          // until you win, eliminate the seat, or declare interaction.
          outcome.acknowledged = true;
          outcome.deadlineTurn = event.severity.deadlineTurn;
          break;
        }
      }

      const resolved: PressureEvent = { ...event, state: 'resolved' };
      const trimmed = payload?.note?.trim();
      appendLog('event', `Resolved ${event.type}: ${event.prompt}${detail}${trimmed ? ` — "${trimmed}"` : ''}`, {
        ...eventPayload(resolved),
        resolved: true,
        outcome,
        note: trimmed,
      });
      advanceQueue();
    },

    declareInteraction() {
      const state = get();
      if (!state.run) return;
      const clock = state.clock;
      if (!clock) return;

      set({ clock: null });
      appendLog(
        'respond',
        `Declared held interaction — Seat ${clock.seatId}'s clock is answered.`,
        {
          seatId: clock.seatId,
          deadlineTurn: clock.deadlineTurn,
          spawnedTurn: clock.spawnedTurn,
          canceled: true,
          reason: 'declared-interaction',
        },
      );

      // If the clock's own warning is still sitting in front of the player,
      // retire it — it has just been answered.
      const active = get().activeEvent;
      if (active && active.type === 'clock' && active.seatId === clock.seatId) {
        appendLog('respond', `Answered clock: ${active.prompt}`, {
          ...eventPayload({ ...active, state: 'negated' }),
          responded: true,
          negated: true,
        });
        advanceQueue();
      }
    },
  };
});
