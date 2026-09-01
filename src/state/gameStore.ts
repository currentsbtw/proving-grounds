import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { createRng, randomSeed, shuffleInPlace } from '../domain/rng';
import { nextPhaseOf } from '../domain/phases';
import { saveRun } from '../db/db';
import type {
  CardData,
  CardInstance,
  Deck,
  LogEntry,
  LogKind,
  Phase,
  RunRecord,
  RunResult,
  Seat,
  SeatId,
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

const SEAT_IDS: SeatId[] = ['A', 'B', 'C'];

const ZONE_LABELS: Record<ZoneId, string> = {
  library: 'library',
  hand: 'hand',
  battlefield: 'battlefield',
  graveyard: 'graveyard',
  exile: 'exile',
  command: 'command zone',
};

function freshSeats(): Seat[] {
  return SEAT_IDS.map((id) => ({
    id,
    life: STARTING_LIFE,
    commanderDamage: 0,
    eliminated: false,
  }));
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
    set((s) => ({
      seats: s.seats.map((x) => (x.id === seatId ? { ...x, eliminated: true } : x)),
    }));
    appendLog('damage', `Seat ${seatId} eliminated`, {
      seatId,
      reason: byCommander ? 'commander-damage' : 'life',
      life: seat.life,
      commanderDamage: seat.commanderDamage,
    });
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

    startRun(deck, cardData, seed) {
      const runSeed = seed ?? randomSeed();
      const rng = createRng(runSeed);

      const cards: Record<string, CardInstance> = {};
      const libraryOrder: string[] = [];
      let stamp = 0;

      for (const ref of deck.cards) {
        for (let i = 0; i < ref.qty; i++) {
          const inst = makeInstance(ref.scryfallId, 'library', false, ++stamp);
          cards[inst.iid] = inst;
          libraryOrder.push(inst.iid);
        }
      }
      for (const commanderId of deck.commanderIds) {
        const inst = makeInstance(commanderId, 'command', true, ++stamp);
        cards[inst.iid] = inst;
      }

      shuffleInPlace(libraryOrder, rng);

      const run: RunRecord = {
        id: nanoid(12),
        deckId: deck.id,
        deckName: deck.name,
        seed: runSeed,
        bracket: deck.bracket,
        startedAt: Date.now(),
        log: [],
      };

      set({
        run,
        rng,
        phase: 'main1',
        turn: 1,
        playerLife: STARTING_LIFE,
        seats: freshSeats(),
        cards,
        libraryOrder,
        commanderCasts: {},
        cardData,
        mulliganCount: 0,
        mulliganResolved: false,
        lastAutoDrawTurn: 1,
        moveCounter: stamp,
      });

      appendLog('run', `Run started — ${deck.name} (seed ${runSeed})`, {
        runId: run.id,
        deckId: deck.id,
        deckName: deck.name,
        seed: runSeed,
        bracket: deck.bracket,
        librarySize: libraryOrder.length,
        commanders: deck.commanderIds,
      });
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
        appendLog('commander', `${name} changed zones to ${ZONE_LABELS[toZone]} — commander may return to the command zone`, {
          iid,
          name,
          to: toZone,
        });
      }
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
      set((s) => ({ seats: s.seats.map((x) => (x.id === target ? { ...x, life: after } : x)) }));
      appendLog('life', `Seat ${target}: ${before} → ${after}`, {
        target,
        seatId: target,
        delta,
        before,
        after,
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

      set((s) => ({
        seats: s.seats.map((x) =>
          x.id === seatId ? { ...x, commanderDamage: cmdAfter, life: lifeAfter } : x,
        ),
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
        set((s) => ({ phase: 'untap', turn: s.turn + 1 }));
        appendLog('turn', `Turn ${get().turn} begins`, { turn: get().turn, from: 'end' });
        performUntapStep();
        return;
      }

      set({ phase: to });
      appendLog('phase', `Phase: ${to}`, { from, to, turn: get().turn });

      if (to === 'untap') performUntapStep();
      if (to === 'draw') performDrawStep();
    },

    nextTurn() {
      if (!get().run) return;
      const from = get().turn;
      set((s) => ({ turn: s.turn + 1, phase: 'untap' }));
      appendLog('turn', `Turn ${get().turn} begins`, { turn: get().turn, previousTurn: from, skipped: true });
      performUntapStep();
      set({ phase: 'draw' });
      performDrawStep();
      set({ phase: 'main1' });
      appendLog('phase', 'Phase: main1', { from: 'draw', to: 'main1', turn: get().turn });
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

      if (target.kind === 'life') {
        const who = target.payload.target as LifeTarget;
        const life = target.payload.before as number;

        if (who === 'player') {
          set({ playerLife: life });
        } else {
          set((s) => ({
            seats: s.seats.map((x) =>
              x.id === who
                ? { ...x, life, eliminated: stillEliminated(x, life, x.commanderDamage) }
                : x,
            ),
          }));
        }

        appendLog('life', `Undid: ${target.message}`, {
          undoOf: target.seq,
          target: who,
          restoredLife: life,
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
            ? {
                ...x,
                life,
                commanderDamage,
                eliminated: stillEliminated(x, life, commanderDamage),
              }
            : x,
        ),
      }));

      appendLog('life', `Undid: ${target.message}`, {
        undoOf: target.seq,
        target: seatId,
        seatId,
        restoredLife: life,
        restoredCommanderDamage: commanderDamage,
      });
    },
  };
});
