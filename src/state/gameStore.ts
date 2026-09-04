import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { createRng, randomSeed, shuffleInPlace } from '../domain/rng';
import { nextPhaseOf } from '../domain/phases';
import {
  isCreatureTypeLine,
  isInstantOrSorceryTypeLine,
  isLandTypeLine,
  isPlaneswalkerTypeLine,
} from '../domain/typeLine';
import { normalizeSweep } from '../engine/scorecard';
import { saveRun } from '../db/db';
import { PRESSURE } from '../data/pressure';
import {
  applyDamageToSeat,
  chooseCounterCitation,
  colorsOf,
  drawProfiles,
  emptySilhouette,
  initialThreat,
  makeCounterEvent,
  punishPhrase,
  redistribute,
  resolveWindow,
  seatMana,
  toSnapshot,
  zeroFiredCounts,
  zeroLastFiredWindow,
  type FiredCounts,
  type LastFiredWindow,
  type PermanentSummary,
  type PlayerSummary,
} from '../engine/pressure';
import type { CitationPermanent, CitationSweep, CitationZone } from '../data/citations';
import type {
  CardData,
  CardInstance,
  ClockState,
  CounterArmed,
  Deck,
  EventCitation,
  EventType,
  LogEntry,
  LogKind,
  Phase,
  PodHit,
  PressureEvent,
  RosterEntry,
  RunRecord,
  RunResult,
  Seat,
  SeatId,
  Silhouette,
  StackItem,
  StandingHazard,
  TokenSpec,
  ZoneId,
} from '../domain/types';

export const STARTING_LIFE = 40;
export const STARTING_HAND_SIZE = 7;
export const LETHAL_COMMANDER_DAMAGE = 21;

/**
 * Cards to put on the bottom after `mulliganCount` mulligans. Commander gives
 * the first mulligan free (CR 103.5c), so the first one bottoms nothing and
 * every later one bottoms one more.
 */
export function mulliganBottomCount(mulliganCount: number): number {
  return Math.max(0, mulliganCount - 1);
}

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

/**
 * The answer the player claims to a pressure event, and the card that made it.
 *
 * Naming the card is the point: "I answer it" without one measures a claim, not
 * an answer, and teaches nothing about holding up the right card. It is still
 * optional, because the honor system is the rule everywhere else too — a player
 * whose answer is something the app has no instance for (a land's ability, a
 * card already exiled off a Cascade) has still answered, and says so unbound.
 */
export interface AnswerPayload {
  /** The instance that did the work: in hand, or already on the battlefield. */
  iid?: string;
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
  stack: 'stack',
};

/**
 * A counter event raised over a spell that is sitting on the stack tray, rather
 * than over one intercepted on its way from hand to battlefield. The two answer
 * differently: forcing a stacked spell through leaves it on the tray to be
 * resolved in the order the player declared, where an intercepted one finishes
 * its interrupted trip to the battlefield.
 */
function isStackedCounter(event: PressureEvent): boolean {
  return event.type === 'counter' && event.severity.stacked === 1;
}

/** Tail of a 'stack' log message: how deep the tray is after the operation. */
function depthText(depth: number): string {
  if (depth === 0) return 'stack empty';
  return `${depth} on the stack`;
}

/**
 * Three fresh seats. With an rng they open at a randomised 1–2 threat, which is
 * what `startRun` wants; without one they open flat, which is what the cleared
 * post-run state wants.
 */
function freshSeats(rng?: () => number): Seat[] {
  const seats: Seat[] = SEAT_IDS.map((id) => ({
    id,
    life: STARTING_LIFE,
    commanderDamage: 0,
    eliminated: false,
    threat: rng ? initialThreat(rng) : PRESSURE.threat.startMin,
    silhouette: emptySilhouette(),
  }));
  // Archetypes are dealt after the opening threats so the three threat draws
  // keep the position they had in the seed's stream; the profile draws simply
  // follow them. Cleared post-run seats carry no profile and the engine reads
  // them as a plain midrange pod in every colour.
  if (rng) {
    const profiles = drawProfiles(rng);
    seats.forEach((seat, i) => {
      seat.profile = profiles[i];
    });
  }
  return seats.map(trackPeak);
}

/**
 * Remember a seat at its scariest. Recording the high-water mark here is what
 * lets elimination redistribute what the seat *was* rather than the husk left
 * after the killing blow — see `redistribute`.
 *
 * Threat and board are tracked independently, because they do not move
 * together. A seat pinned at the threat cap, or regrowing after damage knocked
 * it back, keeps adding creatures and power every window while its threat sits
 * flat or below an earlier reading. Gating the board on "did threat rise" froze
 * the recorded board at whatever it happened to be the last time the number
 * ticked up, so the survivors inherited a board the seat had long outgrown.
 * Peak threat is the running max of threat; peak board is the componentwise max
 * of the boards seen, and both are refreshed on every update.
 */
function trackPeak(seat: Seat): Seat {
  const peakThreat = Math.max(seat.threat, seat.peakThreat ?? seat.threat);
  const recorded = seat.peakSilhouette;
  const peakSilhouette: Silhouette = recorded
    ? {
        creatures: Math.max(seat.silhouette.creatures, recorded.creatures),
        power: Math.max(seat.silhouette.power, recorded.power),
        artifacts: Math.max(seat.silhouette.artifacts, recorded.artifacts),
        openMana: Math.max(seat.silhouette.openMana, recorded.openMana),
        bonusMana: Math.max(seat.silhouette.bonusMana, recorded.bonusMana),
      }
    : seat.silhouette;

  // Nothing moved: hand back the same object so a seat row does not re-render.
  if (
    recorded &&
    peakThreat === seat.peakThreat &&
    peakSilhouette.creatures === recorded.creatures &&
    peakSilhouette.power === recorded.power &&
    peakSilhouette.artifacts === recorded.artifacts &&
    peakSilhouette.openMana === recorded.openMana &&
    peakSilhouette.bonusMana === recorded.bonusMana
  ) {
    return seat;
  }
  return { ...seat, peakThreat, peakSilhouette };
}

/** Threat per seat, as a plain record — the shape `previousThreat` is kept in. */
function threatBySeat(seats: Seat[]): Record<SeatId, number> {
  return {
    A: seats.find((s) => s.id === 'A')?.threat ?? 0,
    B: seats.find((s) => s.id === 'B')?.threat ?? 0,
    C: seats.find((s) => s.id === 'C')?.threat ?? 0,
  };
}

/** Type line for a card instance — tokens carry their own, real cards use the cache. */
function typeLineOf(state: GameState, card: CardInstance): string {
  if (card.isToken) return card.tokenSpec?.typeLine ?? 'Creature — Token';
  if (card.scryfallId) return state.cardData[card.scryfallId]?.typeLine ?? '';
  return '';
}

export function isLandCard(state: GameState, card: CardInstance): boolean {
  return isLandTypeLine(typeLineOf(state, card));
}

export function isCreatureCard(state: GameState, card: CardInstance): boolean {
  return isCreatureTypeLine(typeLineOf(state, card));
}

/**
 * Front-face planeswalker. Only the wipes ask: Farewell and Nevinyrral's Disk
 * sweep artifacts, creatures and enchantments and leave planeswalkers standing,
 * which is a difference a player would notice on the table.
 */
function isPlaneswalkerCard(state: GameState, card: CardInstance): boolean {
  return isPlaneswalkerTypeLine(typeLineOf(state, card));
}

/**
 * Whether a spell resolving off the stack tray goes to the graveyard rather
 * than the battlefield. The type line is the whole test — this is the only
 * "rule" the tray knows, and it is the one a player performs without thinking.
 * Read off the front face, so an Adventure creature is a creature and lands on
 * the battlefield rather than being binned for the Instant on its back.
 */
export function isInstantOrSorceryCard(state: GameState, card: CardInstance): boolean {
  return isInstantOrSorceryTypeLine(typeLineOf(state, card));
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
      typeLine: typeLineOf(state, c),
      movedAt: c.movedAt,
    }));
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
    // The cited card, flattened to plain keys so the scorers read it with
    // `readString`/`readNumber` — `severity` is a numbers-only map.
    card: event.card?.name,
    cardMv: event.card?.mv,
    cardEffect: event.card?.effect,
    cardZone: event.card?.zone,
    pay: event.card?.pay,
    punish: event.card?.punish,
  };
}

export interface GameState {
  run: RunRecord | null;
  phase: Phase;
  turn: number;
  playerLife: number;
  /** Player life as the current turn began, so the readout can show this turn's swing. */
  turnStartLife: number;
  seats: Seat[];
  /**
   * Each seat's threat as it stood before the most recent opponent window, so a
   * meter can say which way it is moving. Windows are the only cadence that
   * matters here: damage the player deals inside a turn moves threat too, and a
   * trend that flickered on every life button would read as noise.
   */
  previousThreat: Record<SeatId, number>;
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
  /**
   * Hate pieces the player let resolve, still on the table. Nothing here is
   * enforced: a standing piece is a tell the player honours by hand, and it
   * leaves when they remove it, a wrath wide enough sweeps it, or the seat that
   * cast it dies. The engine never writes one — it only ever offers the event,
   * because up to the moment the player says it resolved the piece is still a
   * question.
   */
  hazards: StandingHazard[];
  /**
   * The last swing each seat took from another seat, for the readout's "hit by
   * B for 7 on T6". Only the most recent one is kept; the log holds the rest.
   */
  lastPodHit: Partial<Record<SeatId, { attackerId: SeatId; damage: number; turn: number }>>;
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

  /**
   * The manual stack tray, bottom first — the last element is the top and the
   * only one `resolveTop` will hand back. Nothing arrives here on its own: the
   * player casts to it, names an ability on it, or a seat's counterspell lands
   * on top of a spell already sitting on it. Legality is never checked.
   */
  stack: StackItem[];

  /**
   * The player's life has been seen at or below zero and the table has been
   * told. Death is not settled on the action that caused it: the run ends on the
   * next action that is not an undo, so a mis-clicked life button is still
   * recoverable. Cleared the moment life is back above zero.
   */
  deathNoticed: boolean;
  /**
   * A run is being ended right now. Set synchronously at the top of `endRun`,
   * which then awaits the Dexie write before clearing the store — without this,
   * any action landing inside that window would settle the run a second time and
   * append a second "Run ended". Cleared when the state resets.
   */
  ending: boolean;

  startRun: (deck: Deck, cardData: Record<string, CardData>, seed?: string) => void;
  takeMulligan: () => void;
  resolveMulligan: (bottomIids: string[]) => void;
  moveCard: (iid: string, toZone: ZoneId, options?: MoveArg) => void;
  drawCards: (n: number) => void;
  shuffleLibrary: () => void;
  millCards: (n: number) => void;
  revealTop: (n: number) => CardInstance[];
  castCommander: (iid: string) => void;
  /**
   * Put a spell on the stack tray instead of straight onto the battlefield.
   * Accepts a card in hand, or the commander in the command zone (the cast is
   * counted and the tax accrues exactly as `castCommander` does it). Lands and
   * tokens never go on the stack, so they are a silent no-op.
   */
  castToStack: (iid: string) => void;
  /** Name an ability or trigger onto the tray. Empty text is ignored. */
  pushAbility: (label: string) => void;
  /**
   * Resolve the top item. A spell goes to the battlefield, or to the graveyard
   * if its type line says Instant or Sorcery; an ability is simply popped. A
   * no-op on an empty tray, or when the top is a counter — that one belongs to
   * the event in front of the player.
   */
  resolveTop: () => void;
  /** Take an item off the tray without resolving it. Counters cannot be removed here. */
  removeStackItem: (id: string) => void;
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
  /**
   * "I had an answer." Negates the active event without applying anything. An
   * `iid` binds the answer to the card that made it — spending it out of hand,
   * or leaving a permanent where it stands.
   */
  respondToActiveEvent: (answer?: AnswerPayload) => void;
  /** "It resolved." Applies the event's bookkeeping, then advances the queue. */
  resolveActiveEvent: (payload?: ResolveEventPayload) => void;
  /** Cancel the race clock by claiming held interaction, with or without a card. */
  declareInteraction: (answer?: AnswerPayload) => void;
  /**
   * "I dealt with it." Take a standing hate piece off the table, optionally
   * naming the card that did it — the same binding an answered event gets, so
   * the piece and the answer sit on one entry the scorers can pair up.
   */
  removeHazard: (id: string, answer?: AnswerPayload) => void;
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
  // 'stack' counts as already playing: a card the player has declared cast is
  // just as much a commitment as one already on the table.
  return !Object.values(state.cards).some(
    (c) =>
      !c.isCommander &&
      (c.zone === 'battlefield' ||
        c.zone === 'graveyard' ||
        c.zone === 'exile' ||
        c.zone === 'stack'),
  );
}

/**
 * Whether a counter event is currently live over this card — the one in front
 * of the player, or one still queued behind it. A spell a seat has spoken up
 * about is out of the player's hands until that question is answered, so it
 * cannot be cast (again) while the counter stands.
 *
 * Exported because `bindAnswer` refuses such a card and the answer picker has to
 * refuse it in the same breath: a picker offering the very spell under the
 * counter would be offering a choice the store then throws away.
 */
export function heldByLiveCounter(state: GameState, iid: string): boolean {
  const live = state.activeEvent ? [state.activeEvent, ...state.pendingEvents] : state.pendingEvents;
  return live.some((event) => event.type === 'counter' && event.targetIid === iid);
}

/**
 * Every condition the stack tray asks of a card before it will take it. Exported
 * so the menu item, the drag band and the hotkey all offer exactly what
 * `castToStack` will accept, rather than each re-deriving a near-miss of it.
 */
export function canCastToStack(state: GameState, iid: string): boolean {
  if (!state.run) return false;
  const card = state.cards[iid];
  if (!card) return false;
  if (card.isToken) return false;
  // Front face: an MDFC spell // land is a spell, and belongs on the tray.
  if (isLandCard(state, card)) return false;
  const fromCommand = card.isCommander && card.zone === 'command';
  if (card.zone !== 'hand' && !fromCommand) return false;
  if (heldByLiveCounter(state, iid)) return false;
  return true;
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

  /**
   * Put an item on the tray and say so. The id comes off the move counter rather
   * than a nanoid or the clock, so a seed replays a run's stack operations byte
   * for byte.
   */
  function pushStackItem(fields: Omit<StackItem, 'id'>): StackItem {
    const stamp = get().moveCounter + 1;
    const item: StackItem = { ...fields, id: `stk-${stamp}` };
    set((s) => ({ moveCounter: stamp, stack: [...s.stack, item] }));
    logStackOp('push', 'Stacked', item);
    return item;
  }

  /**
   * Drop an item off the tray by id, without logging. Returns whether it was
   * there. Nothing calls this without logging the drop itself: `logStackOp`
   * reads the depth back off the tray, so the entry has to come after the drop
   * rather than being folded into it.
   */
  function dropStackItem(id: string): boolean {
    if (!get().stack.some((item) => item.id === id)) return false;
    set((s) => ({ stack: s.stack.filter((item) => item.id !== id) }));
    return true;
  }

  /**
   * Take the tray item a counter event stands for off the tray. The spell it was
   * held over is left exactly where it is: on the stack, still owed a
   * resolution. Shared by every exit a counter has that is not "it resolved".
   * Returns the item that left, so the caller can say why it left.
   */
  function dropCounterItem(eventId: string): StackItem | null {
    const item = get().stack.find((x) => x.kind === 'counter' && x.eventId === eventId);
    if (!item) return null;
    dropStackItem(item.id);
    return item;
  }

  /**
   * Why an item left the tray. Only ever on a 'remove': a push and a resolve say
   * why by being what they are, but a removal is one of five different things —
   * the player tidied it away, the counter over it was answered, the counter
   * resolved and took the spell with it, the seat holding it died, or the whole
   * opening was mulliganed back.
   */
  type StackRemoveReason = 'answered' | 'countered' | 'seat-out' | 'mulligan';

  function logStackOp(
    op: 'push' | 'resolve' | 'remove',
    verb: 'Stacked' | 'Resolved' | 'Removed from the stack',
    item: StackItem,
    reason?: StackRemoveReason,
  ): void {
    appendLog('stack', `${verb}: ${item.label} (${depthText(get().stack.length)})`, {
      op,
      itemId: item.id,
      kind: item.kind,
      label: item.label,
      iid: item.iid,
      eventId: item.eventId,
      seatId: item.seatId,
      reason,
      depth: get().stack.length,
    });
  }

  /** Reorder the library with the supplied generator, without logging. */
  function shuffleWith(rng: () => number): void {
    set((s) => {
      const order = [...s.libraryOrder];
      shuffleInPlace(order, rng);
      return { libraryOrder: order };
    });
  }

  function shuffleSilently(): void {
    shuffleWith(rngOrFallback());
  }

  /**
   * Take standing hate pieces off the table, one entry each.
   *
   * The three ways a piece can leave — its seat dies, a wrath wide enough
   * sweeps it, the player removes it — differ only in what they say about it,
   * so they share this: the matching pieces come off state in a single `set`,
   * then each gets the entry `describe` asks for, in the order they were
   * standing. `describe` runs after the removal and before that piece's entry,
   * which is where a caller that binds an answer wants to be (the card's move
   * entry lands ahead of the retirement it paid for).
   *
   * Returns what it removed, so a caller can tell "nothing was standing" from
   * "one left" without re-reading state.
   */
  function retireHazards(
    matching: (hazard: StandingHazard) => boolean,
    describe: (hazard: StandingHazard) => {
      kind: 'threat' | 'respond';
      message: string;
      payload: Record<string, unknown>;
    },
  ): StandingHazard[] {
    const retired = get().hazards.filter(matching);
    if (retired.length === 0) return retired;

    const gone = new Set(retired.map((h) => h.id));
    set((s) => ({ hazards: s.hazards.filter((h) => !gone.has(h.id)) }));
    for (const hazard of retired) {
      const entry = describe(hazard);
      appendLog(entry.kind, entry.message, entry.payload);
    }
    return retired;
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
      appendLog('threat', `Seat ${seatId} is out. Its race clock is canceled.`, {
        seatId,
        canceled: true,
        reason: 'elimination',
        deadlineTurn: clock?.deadlineTurn,
      });
    }

    // Whatever the seat still had in front of the player, or behind it in the
    // queue, dies with it. The readout already hides a dead seat's chip; this is
    // the seam underneath, so nothing can be answered on a corpse's behalf.
    retireSeatEvents(seatId);

    const armed = get().counterArmed;
    if (armed && armed.seatId === seatId) {
      set({ counterArmed: null });
      appendLog('threat', `Seat ${seatId} is out. Nothing is held up any more.`, {
        seatId,
        canceled: true,
        reason: 'seat-eliminated',
        threshold: armed.threshold,
      });
    }

    // A hate piece is one seat's card sitting on one seat's side of the table.
    // The seat is gone, so the piece is gone with it, and the player stops
    // playing around a tell nobody is left to hold them to.
    retireHazards(
      (h) => h.seatId === seatId,
      (hazard) => ({
        kind: 'threat',
        message: `Seat ${seatId} is out. ${hazard.card.name} leaves with it.`,
        payload: {
          hazardId: hazard.id,
          eventId: hazard.eventId,
          seatId,
          cardName: hazard.card.name,
          canceled: true,
          reason: 'seat-eliminated',
        },
      }),
    );

    // Pressure does not drop when a seat dies; it concentrates. Event frequency
    // is already seat-independent, so only threat and board move here.
    const updates = redistribute(
      // The seat as it stood before the killing blow, peaks included: the
      // survivors inherit the seat at its scariest, never the husk. Burning a
      // seat down sheds threat point by point, so its last reading can be zero.
      get().seats.map((x) => (x.id === seatId ? toSnapshot(seat) : toSnapshot(x))),
      seatId,
    );
    if (updates.length > 0) {
      applySeatUpdates(updates);
      appendLog(
        'threat',
        `Pressure redistributed: ${updates.map((u) => `${u.id} ${u.threat.toFixed(1)}`).join(', ')}`,
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
        return update
          ? trackPeak({ ...seat, threat: update.threat, silhouette: update.silhouette })
          : seat;
      }),
    }));
  }

  /** Raise a seat's threat by a flat amount, clamped and rounded like the engine. */
  function bumpSeatThreatBy(seatId: SeatId, amount: number): void {
    if (amount === 0) return;
    set((s) => ({
      seats: s.seats.map((seat) =>
        seat.id === seatId
          ? trackPeak({
              ...seat,
              threat: Math.min(
                PRESSURE.threat.max,
                Math.round((seat.threat + amount) * 10) / 10,
              ),
            })
          : seat,
      ),
    }));
  }

  /** A seat that just did something gets scarier. */
  function bumpSeatThreat(seatId: SeatId, type: EventType): void {
    bumpSeatThreatBy(seatId, PRESSURE.threat.eventJump[type]);
  }

  /**
   * Bank mana on a seat. `bonusMana` is what `seatMana` adds on top of the land
   * drop, so this is the seam that makes an unpaid Treasure tax buy the seat a
   * bigger spell next window rather than a number nobody reads. `openMana` moves
   * with it so the readout says so straight away; growth recomputes it from
   * `bonusMana` from then on. Deliberately not routed through
   * `applySeatUpdates`, which writes a whole silhouette and would need the
   * caller to reconstruct one it does not own.
   */
  function bumpSeatMana(seatId: SeatId, n: number): void {
    if (n === 0) return;
    set((s) => ({
      seats: s.seats.map((seat) =>
        seat.id === seatId
          ? trackPeak({
              ...seat,
              silhouette: {
                ...seat.silhouette,
                openMana: seat.silhouette.openMana + n,
                bonusMana: seat.silhouette.bonusMana + n,
              },
            })
          : seat,
      ),
    }));
  }

  /**
   * One seat's swing at another, applied to the table's books.
   *
   * The engine has already folded what the hit cost the defender's threat and
   * board into this window's seat updates; what it hands back is the life,
   * which it does not own. Applying `applyDamageToSeat` a second time here
   * would shed the threat twice and walk the store off the curves the probe
   * fitted, so this only moves life — and the two threat readings on the entry
   * bracket the window the hit landed in rather than the hit alone.
   *
   * Two things it deliberately does not touch. `previousThreat` is the trend
   * baseline for damage the *player* deals, and this is the pod hurting itself:
   * the meters are supposed to show it. And `damageDealtByTurn` is the player's
   * own damage tally, which is what the scorecard scores them on — a seat the
   * pod softened up is not a seat the player burned down.
   *
   * `checkSeatElimination` at the tail is a belt on braces: the engine caps a
   * hit at `life - 1`, so this can never be the blow that kills, and if that
   * ever changes the seat still leaves the table properly.
   */
  function applyPodHit(hit: PodHit, turn: number): void {
    const seat = get().seats.find((s) => s.id === hit.defenderId);
    if (!seat || seat.eliminated || hit.damage <= 0) return;
    const before = seat.life;
    const after = before - hit.damage;
    const threatBefore = get().previousThreat[hit.defenderId] ?? seat.threat;

    set((s) => ({
      seats: s.seats.map((x) => (x.id === hit.defenderId ? { ...x, life: after } : x)),
      lastPodHit: {
        ...s.lastPodHit,
        [hit.defenderId]: { attackerId: hit.attackerId, damage: hit.damage, turn },
      },
    }));

    appendLog('damage', `Seat ${hit.attackerId} attacks Seat ${hit.defenderId} for ${hit.damage}`, {
      seatId: hit.defenderId,
      attackerId: hit.attackerId,
      amount: hit.damage,
      /** The flag every scorer reads: damage the player did not deal. */
      podCombat: true,
      before,
      after,
      threatBefore,
      threatAfter: seat.threat,
    });

    checkSeatElimination(hit.defenderId);
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

  /**
   * Finish the trip a counter event interrupted. The interception left the card
   * where it was cast from — hand for a normal spell, the command zone for a
   * commander whose cast is already counted and whose tax is already logged — so
   * the spell resolving is exactly one move onto the battlefield. Shared by
   * `respondToActiveEvent` (the player forced it through) and by
   * `retireSeatEvents` (the seat holding the counter died, so nobody is left to
   * counter it), which is what keeps the two paths identical.
   *
   * Returns the card's name when it moved, or null when there was nothing to
   * force — no target, or a card already on the battlefield.
   */
  function forceCounterThrough(event: PressureEvent): string | null {
    const iid = event.targetIid;
    if (!iid) return null;
    const held = get().cards[iid];
    if (!held || held.zone === 'battlefield') return null;
    const name = cardName(get(), iid);
    performMove(iid, 'battlefield');
    return name;
  }

  /** What binding an answer to a card produced: the log fields, and the name to print. */
  interface BoundAnswer {
    /** Flattened onto the 'respond' entry, the way every payload here is flat. */
    fields: Record<string, unknown>;
    /** Present only when a card really answered — the message names it. */
    name?: string;
  }

  /**
   * Bind an answer to the card that made it, and spend the card if answering
   * spent it.
   *
   * An answer is a card the player actually had: one in hand they cast, or a
   * permanent whose ability they activated. Nothing else the iid could name
   * qualifies — a spell on the tray is already cast and still owed a
   * resolution, a commander in the command zone has not been cast at all, and a
   * card a seat is holding a counter over is out of the player's hands until
   * that question is settled. Those are ignored rather than refused: the answer
   * still stands, it just does not name a card, and the entry says why.
   *
   * A card answering out of hand leaves the hand by the same front-face reading
   * `resolveTop` makes — instant or sorcery to the graveyard, anything else to
   * the battlefield. A permanent answering stays exactly where it is: an
   * activated ability moves nothing, and whether it tapped for it is the
   * player's own bookkeeping, not something to guess at here.
   */
  function bindAnswer(iid: string | undefined, eventId: string): BoundAnswer {
    if (!iid) return { fields: { bound: false } };
    const state = get();
    const card = state.cards[iid];
    const reject = (why: string): BoundAnswer => ({
      fields: { bound: false, boundRejected: true, boundReason: why, answerIid: iid },
    });
    if (!card) return reject('no such card');
    if (card.zone !== 'hand' && card.zone !== 'battlefield') {
      return reject(card.zone === 'stack' ? 'on the stack' : `in the ${ZONE_LABELS[card.zone]}`);
    }
    if (heldByLiveCounter(state, iid)) return reject('held by a counter');

    const name = cardName(state, iid);
    const answerMv = manaValueOf(state, card);
    const answerZone = card.zone;
    const answerTo: ZoneId | undefined =
      answerZone === 'hand'
        ? isInstantOrSorceryCard(state, card)
          ? 'graveyard'
          : 'battlefield'
        : undefined;
    if (answerTo) performMove(iid, answerTo, undefined, `answered ${eventId}`);

    return {
      name,
      fields: {
        answerIid: iid,
        answerName: name,
        answerZone,
        answerTo,
        answerMv,
        bound: true,
      },
    };
  }

  /**
   * Take a dead seat's events off the table: everything of its in the queue,
   * plus the one it currently has in front of the player. Each is logged as
   * canceled so the scorer can tell it apart from an event that was offered and
   * left unanswered — a canceled event was never really offered at all.
   *
   * A counter is the exception to "off the table". It is not a threat sitting in
   * front of the player, it is a spell of the player's own held out of play; if
   * the counter simply vanished, the spell would be stranded in hand (or in the
   * command zone with its cast already counted and its tax already paid). So the
   * counter is canceled *and* the spell it caught resolves. The event still logs
   * as canceled, because it was never offered as a question the player answered,
   * and the resolution is a plain move entry, so board value and commander stats
   * read it as the ordinary cast it turned out to be.
   */
  function retireSeatEvents(seatId: SeatId): void {
    const { activeEvent, pendingEvents } = get();
    const retiredActive = activeEvent && activeEvent.seatId === seatId ? activeEvent : null;
    const retiredPending = pendingEvents.filter((e) => e.seatId === seatId);
    if (!retiredActive && retiredPending.length === 0) return;

    const kept = pendingEvents.filter((e) => e.seatId !== seatId);
    if (retiredActive) set({ activeEvent: kept.shift() ?? null, pendingEvents: kept });
    else set({ pendingEvents: kept });

    for (const event of retiredActive ? [retiredActive, ...retiredPending] : retiredPending) {
      // A counter held over a spell on the stack tray has nowhere to force the
      // spell to: it is already cast, and the player still owes it a resolution
      // in the order they declared. Only the counter leaves.
      let forced: string | null = null;
      if (isStackedCounter(event)) {
        const dropped = dropCounterItem(event.id);
        if (dropped) logStackOp('remove', 'Removed from the stack', dropped, 'seat-out');
      } else if (event.type === 'counter') forced = forceCounterThrough(event);
      appendLog(
        'event',
        forced
          ? `Seat ${seatId} is out. Nobody counters ${forced}. It resolves.`
          : `Seat ${seatId} is out. Its pending ${event.type} is off the table.`,
        {
          ...eventPayload(event),
          canceled: true,
          reason: 'seat-eliminated',
          forcedThrough: forced ? event.targetIid : undefined,
          forcedName: forced ?? undefined,
        },
      );
    }

    // The queue moved, so say what the player is looking at now.
    const next = get().activeEvent;
    if (retiredActive && next) {
      appendLog('event', `Next: ${next.prompt}`, { ...eventPayload(next), activated: true });
    }
  }

  /**
   * All battlefield instances a wipe of this scope would sweep away. The scope
   * is the cited card's own: Wrath of God takes creatures, Planar Cleansing
   * takes every nonland, and Farewell and Nevinyrral's Disk take artifacts,
   * creatures and enchantments while planeswalkers watch.
   */
  function wipeVictims(sweep: CitationSweep): string[] {
    const state = get();
    return Object.values(state.cards)
      .filter((c) => c.zone === 'battlefield')
      .filter((c) => {
        if (sweep === 'creatures') return isCreatureCard(state, c);
        if (isLandCard(state, c)) return false;
        return sweep === 'nonland' || !isPlaneswalkerCard(state, c);
      })
      .sort(byArrival)
      .map((c) => c.iid);
  }

  /**
   * Does a wipe of this scope take a standing piece with it? A creatures-only
   * wrath only reaches the creature pieces — Thalia goes, Blood Moon does not —
   * and the wider sweeps (`nonland`, `ace`) reach every kind a piece can be. A
   * citation with no printed kind is read as "not a creature", which is the only
   * safe reading of an untagged permanent.
   */
  function sweepClearsHazard(sweep: CitationSweep, permanent?: CitationPermanent): boolean {
    return sweep === 'creatures' ? permanent === 'creature' : true;
  }

  /**
   * Put a card where the cited card actually sends it.
   *
   * Two things a player would do at the table without being told. A commander
   * tucked or bounced goes to the command zone instead, the same replacement
   * the counter path already performs and with the same non-effect on the tax —
   * nothing was cast, so nothing is owed. And a library destination is Chaos
   * Warp's: the bottom, then a shuffle, so the player is not left knowing where
   * it went.
   *
   * That shuffle draws from a generator derived from the run seed and the
   * event's id rather than from the run's own stream. Whether the player answers
   * a Chaos Warp or resolves it is a table decision, not a seeded one, and if it
   * consumed the run rng the two choices would hand the next window different
   * rolls.
   */
  function moveToCitedZone(iid: string, zone: CitationZone, eventId: string): void {
    const card = get().cards[iid];
    if (card?.isCommander && (zone === 'library' || zone === 'hand')) {
      const name = cardName(get(), iid);
      performMove(iid, 'command');
      appendLog(
        'commander',
        `${name} was ${zone === 'library' ? 'tucked' : 'bounced'}. Returned to the command zone`,
        { iid, name, scryfallId: card.scryfallId, from: card.zone, to: 'command', reason: zone },
      );
      return;
    }
    if (zone === 'library') {
      performMove(iid, 'library', 'bottom');
      shuffleWith(createRng(`${get().run?.seed ?? ''}:warp:${eventId}`));
      return;
    }
    performMove(iid, zone);
  }

  /**
   * The raw zone move. `moveCard` is this plus the counterspell interception,
   * so anything that must move regardless of held-up mana calls straight in
   * here: wipes, removal, a countered spell going to the graveyard, and a
   * spell the player forced through.
   *
   * `reason` rides onto the 'move' entry when the move was not the player
   * picking a card up and putting it down — an answer spent against an event
   * says which event it answered, so the log reads back as a sentence.
   */
  function performMove(iid: string, toZone: ZoneId, options?: MoveArg, reason?: string): void {
    const state = get();
    const card = state.cards[iid];
    if (!card || card.zone === toZone) return;
    const fromZone = card.zone;
    const name = cardName(state, iid);

    const opts: MoveOptions = typeof options === 'string' ? { position: options } : (options ?? {});
    const position = opts.position ?? 'top';
    const entersTapped = toZone === 'battlefield' && opts.tapped === true;

    // A token that leaves the battlefield ceases to exist (CR 111.7). It is the
    // one move with no destination: the instance goes away rather than sitting
    // in a graveyard nobody can point at, and it never joins `libraryOrder`. The
    // entry still says where it was headed, so a wipe's victim list reads the
    // same whether it swept a card or a Treasure.
    const tokenGone = card.isToken && toZone !== 'battlefield';
    if (tokenGone) {
      set((s) => {
        const cards = { ...s.cards };
        delete cards[iid];
        return {
          cards,
          libraryOrder: s.libraryOrder.filter((x) => x !== iid),
          moveCounter: s.moveCounter + 1,
        };
      });
      appendLog('move', `${name}: ${ZONE_LABELS[fromZone]} → ${ZONE_LABELS[toZone]} (ceases to exist)`, {
        iid,
        name,
        from: fromZone,
        to: toZone,
        isCommander: card.isCommander,
        tokenGone: true,
      });
      return;
    }

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

    const suffix = toZone === 'library' ? ` (${position})` : entersTapped ? ' (enters tapped)' : '';
    appendLog('move', `${name}: ${ZONE_LABELS[fromZone]} → ${ZONE_LABELS[toZone]}${suffix}`, {
      iid,
      name,
      from: fromZone,
      to: toZone,
      position: toZone === 'library' ? position : undefined,
      tapped: entersTapped || undefined,
      isCommander: card.isCommander,
      reason,
    });

    if (card.isCommander && (toZone === 'graveyard' || toZone === 'exile')) {
      appendLog(
        'commander',
        `${name} changed zones to ${ZONE_LABELS[toZone]}. The commander may return to the command zone`,
        { iid, name, to: toZone },
      );
    }
  }

  /**
   * The counterspell the armed seat is holding for this particular spell, or
   * undefined when it has nothing that catches it — a seat with only Negate up
   * does not counter a creature, and a seat holding one mana counters nothing
   * at all. Consumes no rng, so the answer is the same on every replay of the
   * seed whether or not the player cast into it.
   */
  function counterCitationFor(iid: string, armed: CounterArmed): EventCitation | undefined {
    const state = get();
    const card = state.cards[iid];
    if (!card || !state.run) return undefined;
    // No seat, no counterspell: a seat that is not at the table is holding
    // nothing, and its colour identity is the whole point of the pick below.
    const seat = state.seats.find((s) => s.id === armed.seatId);
    if (!seat) return undefined;
    const mana = seatMana(seat.silhouette, state.turn, state.run.bracket);
    // The holder's colours, so a Sultai seat never cites a white counterspell.
    // The arming step already refused to arm a seat with nothing in its colours;
    // this is the same reading applied to the card it actually names.
    return chooseCounterCitation(
      state.windowCount,
      state.turn,
      state.run.bracket,
      mana,
      {
        name: cardName(state, iid),
        manaValue: manaValueOf(state, card),
        typeLine: typeLineOf(state, card),
      },
      colorsOf(toSnapshot(seat)),
    );
  }

  /**
   * An armed seat catches a spell on its way to the battlefield with the card
   * `counterCitationFor` picked. The spell stays where it was cast from — hand
   * for a normal spell, the command zone for a commander — until the player
   * says what happened: `resolveActiveEvent` bins it (or returns a commander to
   * the command zone), `respondToActiveEvent` forces it through. Consumes no
   * rng, so a seed replays identically whether or not the player happened to
   * cast into an armed seat.
   */
  function raiseCounterEvent(
    iid: string,
    armed: CounterArmed,
    citation: EventCitation,
    stacked = false,
  ): PressureEvent | null {
    const state = get();
    const card = state.cards[iid];
    if (!card) return null;
    const manaValue = manaValueOf(state, card);
    const built = makeCounterEvent(
      state.windowCount,
      armed.seatId,
      state.turn,
      iid,
      cardName(state, iid),
      armed.threshold,
      manaValue,
      citation,
      card.isCommander,
    );
    // The spell was already on the tray when the seat spoke up, so the counter
    // lands on top of it rather than holding it out of play. Stamped on the
    // severity map so every later exit — answered, resolved, or the seat dying
    // — can tell the two shapes apart.
    const event: PressureEvent = stacked
      ? { ...built, severity: { ...built.severity, stacked: 1 } }
      : built;

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
    return active;
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

    set({ turn: upcoming, phase: 'untap', turnStartLife: get().playerLife });
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

    // A piece in front of the player counts as standing for the purpose of
    // dealing another. `state.hazards` holds only the pieces that resolved, so
    // a hate event still waiting in the queue — or sitting active, unanswered —
    // would be invisible to the engine's per-seat cap and the seat could be
    // dealt a second piece while the player has not answered the first. The
    // provisional entries below exist only in this call's `WindowInput`:
    // `state.hazards` and the window entry's `hazards` field keep listing the
    // real standing pieces. An event with no card can never stand, so it is not
    // counted.
    const unanswered = state.activeEvent
      ? [state.activeEvent, ...state.pendingEvents]
      : state.pendingEvents;
    const provisional: StandingHazard[] = unanswered.flatMap((event) =>
      event.type === 'hate' && event.card
        ? [
            {
              id: `hz-${event.id}`,
              eventId: event.id,
              seatId: event.seatId,
              card: event.card,
              spawnedTurn: event.turn,
            },
          ]
        : [],
    );

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
      // Read-only to the engine: a seat already holding a piece — resolved, or
      // still a question in front of the player — is not dealt another one.
      hazards: [...state.hazards, ...provisional],
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
      appendLog('run', `Lost the race. Seat ${clock?.seatId} won on the turn after turn ${clock?.deadlineTurn}.`, {
        reason: 'clock-expired',
        seatId: clock?.seatId,
        deadlineTurn: clock?.deadlineTurn,
        turn: upcomingTurn,
      });
      void get().endRun('loss');
      return false;
    }

    // Snapshot before the window's own growth lands, so the meters can show the
    // direction this window moved each seat in.
    set({ previousThreat: threatBySeat(state.seats) });
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
      // What was standing as the window opened, and what the seats did to each
      // other inside it.
      hazards: state.hazards.map((h) => h.id),
      /** Hate events still unanswered as the window opened; they held a seat's slot too. */
      queuedHate: provisional.map((h) => h.eventId),
      podHits: result.podHits,
      notes: result.notes,
    });

    const stamped = enqueueEvents(result.events);
    for (const event of stamped) {
      appendLog('event', event.prompt, { ...eventPayload(event), queued: true });
    }

    // After the queue, so the log reads in the order the table saw it: the
    // window, then what it is asking the player, then what the pod did to
    // itself while the player was being asked.
    for (const hit of result.podHits) applyPodHit(hit, upcomingTurn);
    return true;
  }

  // -------------------------------------------------------------------------
  // Run settlement
  // -------------------------------------------------------------------------

  /**
   * The two automatic end conditions: the player is dead, or the pod is. Only
   * ever called from `action` below, at the tail of a public action, never from
   * inside one. `endRun` appends "Run ended" synchronously and then clears the
   * store, and `appendLog` drops entries once `run` is null — so ending the run
   * the moment life crossed zero would swallow the entry the action still owed
   * the log (the fatal combat would read as unresolved forever).
   *
   * The two conditions settle differently, on purpose:
   *
   * - Killing the pod wins immediately. There is nothing to take back and
   *   nothing left to play against.
   * - Dying is noticed on the fatal action and settled on the next one. Life is
   *   kept with adjacent buttons, so a -5 at 3 life is a slip rather than a
   *   result, and settling it on the spot wrote it to the log and put
   *   `undoLastLifeChange` out of reach. Instead the table says so once, and the
   *   next action that is not an undo collects. An undo never settles a death,
   *   only clears the notice by bringing life back above zero.
   */
  function settleRun(recovery: boolean): void {
    const state = get();
    if (!state.run || state.ending) return;

    if (state.playerLife <= 0) {
      // Death is noticed first and settled later. The life buttons sit next to
      // each other, so a -5 at 3 life is a mis-click the player must be able to
      // take back; ending the run on the spot persists it and puts the undo out
      // of reach. The pod collects on the next action instead.
      if (!state.deathNoticed) {
        set({ deathNoticed: true });
        appendLog(
          'note',
          `Dead on ${state.playerLife}. Undo the life change, or the next action ends the run.`,
          { reason: 'life', life: state.playerLife, deathNoticed: true },
        );
        return;
      }
      // An undo is the way out, never the thing that closes the door: two bad
      // clicks take two undos, and the first must not be counted as "the next
      // action" and end the run before the second lands.
      if (recovery) return;
      appendLog('run', `Dead on ${state.playerLife}. The pod takes it.`, {
        reason: 'life',
        life: state.playerLife,
      });
      void get().endRun('loss');
      return;
    }

    // Back above zero: the notice is spent, and a later death starts over.
    if (state.deathNoticed) set({ deathNoticed: false });

    if (state.seats.length > 0 && state.seats.every((seat) => seat.eliminated)) {
      appendLog('run', 'Every seat is out. The table is yours.', { reason: 'pod-eliminated' });
      void get().endRun('win');
    }
  }

  /**
   * Depth of public actions on the stack. Actions nest — `resolveActiveEvent`
   * calls `adjustLife` for a combat hit — and only the outermost one settles, so
   * the run ends after the whole action has finished writing to the log.
   */
  let actionDepth = 0;
  /** Whether the outermost action currently on the stack is an undo. */
  let recovering = false;

  /**
   * Run a public action's body, then settle the run if this is the outer one.
   * `kind` is 'recovery' for an action whose whole job is to take something
   * back: it can clear a death notice but never cashes one in.
   */
  function action<T>(body: () => T, kind: 'action' | 'recovery' = 'action'): T {
    if (actionDepth === 0) recovering = kind === 'recovery';
    actionDepth += 1;
    try {
      return body();
    } finally {
      actionDepth -= 1;
      if (actionDepth === 0) {
        const wasRecovery = recovering;
        recovering = false;
        settleRun(wasRecovery);
      }
    }
  }

  return {
    run: null,
    phase: 'main1',
    turn: 1,
    playerLife: STARTING_LIFE,
    turnStartLife: STARTING_LIFE,
    seats: freshSeats(),
    previousThreat: threatBySeat(freshSeats()),
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
    hazards: [],
    lastPodHit: {},
    playerThreat: 0,
    windowCount: 0,
    firedCounts: zeroFiredCounts(),
    lastFiredWindow: zeroLastFiredWindow(),
    damageDealtByTurn: {},
    eventSeq: 0,
    stack: [],
    deathNoticed: false,
    ending: false,

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
        turnStartLife: STARTING_LIFE,
        seats,
        previousThreat: threatBySeat(seats),
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
        hazards: [],
        lastPodHit: {},
        playerThreat: 0,
        windowCount: 0,
        firedCounts: zeroFiredCounts(),
        lastFiredWindow: zeroLastFiredWindow(),
        damageDealtByTurn: {},
        eventSeq: 0,
        stack: [],
        deathNoticed: false,
        ending: false,
      });

      appendLog('run', `Run started: ${deck.name} (seed ${runSeed})`, {
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
        `Seats seated: ${seats
          .map((s) => `${s.id} ${s.profile ?? 'neutral'} ${s.threat.toFixed(1)}`)
          .join(', ')}`,
        {
          seats: seats.map((s) => ({
            id: s.id,
            threat: s.threat,
            silhouette: s.silhouette,
            profile: s.profile,
          })),
        },
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
      // `canMulligan` already refuses once anything has been declared cast, but
      // a mulligan taken anyway must not strand a card on the tray with its
      // instance swept back into the library. Everything on the stack goes home
      // with the hand, and the tray is emptied.
      const stranded = [...get().stack];
      const onStack = cardsInZone(get(), 'stack');
      const hand = [
        ...cardsInZone(get(), 'hand').map((c) => c.iid),
        // A commander is never a library card; it goes home instead, below.
        ...onStack.filter((c) => !c.isCommander).map((c) => c.iid),
      ];
      for (const item of stranded) {
        dropStackItem(item.id);
        logStackOp('remove', 'Removed from the stack', item, 'mulligan');
      }
      for (const card of onStack) {
        if (card.isCommander) performMove(card.iid, 'command');
      }
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
      const bottomCount = mulliganBottomCount(count);
      const keptSize = Math.max(0, STARTING_HAND_SIZE - bottomCount);
      appendLog('mull', `Mulligan to ${keptSize}${bottomCount === 0 ? ' (free)' : ''}`, {
        mulliganCount: count,
        bottomCount,
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
      action(() => {
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
          // Armed is not the same as holding an answer to *this* spell. With
          // nothing eligible the seat says nothing and the spell resolves; the
          // mana stays up for whatever comes next.
          const citation = counterCitationFor(iid, armed);
          if (citation) {
            raiseCounterEvent(iid, armed, citation);
            return;
          }
        }

        performMove(iid, toZone, options);
      });
    },

    drawCards(n) {
      action(() => {
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
      });
    },

    shuffleLibrary() {
      action(() => {
        if (!get().run) return;
        shuffleSilently();
        appendLog('shuffle', `Library shuffled (${get().libraryOrder.length} cards)`, {
          size: get().libraryOrder.length,
        });
      });
    },

    millCards(n) {
      action(() => {
        if (!get().run || n <= 0) return;
        const milled = get().libraryOrder.slice(0, n);
        if (milled.length === 0) {
          appendLog('note', 'Nothing to mill: the library is empty', { requested: n, available: 0 });
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
      action(() => {
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
        const citation =
          armed && manaValueOf(state, card) >= armed.threshold
            ? counterCitationFor(iid, armed)
            : undefined;
        if (armed && citation) {
          // The cast still happened, so the tax still accrues: the commander is
          // on the stack when it gets answered, and comes back more expensive.
          set((s) => ({ commanderCasts: { ...s.commanderCasts, [key]: priorCasts + 1 } }));
          // No `countered` on this entry. The seat has spoken up, but the
          // player has not answered yet and may well force it through — a cast
          // that claimed to be countered at the moment it was met would score a
          // countered cast for a decision that never happened, which is exactly
          // where this path used to disagree with the tray. The entry written
          // when the counter actually resolves is the one that says so, for both
          // paths alike. `to: 'stack'` stays: it is what tells the replayers the
          // card has not landed anywhere yet.
          appendLog(
            'commander',
            `Cast ${name} (cast #${priorCasts + 1}, tax +${tax}). Met by a counter`,
            {
              iid,
              name,
              scryfallId: key,
              castNumber: priorCasts + 1,
              taxPaid: tax,
              nextTax: 2 * (priorCasts + 1),
              from: card.zone,
              to: 'stack',
            },
          );
          raiseCounterEvent(iid, armed, citation);
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
      });
    },

    castToStack(iid) {
      action(() => {
        const state = get();
        // Nothing that cannot be cast belongs on the tray, and a player who
        // dragged a land onto it meant the battlefield. A card a seat has
        // already spoken up about is not the player's to cast either. Say
        // nothing, do nothing.
        if (!canCastToStack(state, iid)) return;
        const card = state.cards[iid];
        const fromCommand = card.isCommander && card.zone === 'command';

        const name = cardName(state, iid);

        if (fromCommand) {
          const key = card.scryfallId;
          if (!key) return;
          const tax = commanderTax(state, key);
          const priorCasts = state.commanderCasts[key] ?? 0;
          set((s) => ({ commanderCasts: { ...s.commanderCasts, [key]: priorCasts + 1 } }));
          // No `to` on this entry. `to: 'stack'` is the marker the scorers read
          // as "this cast was countered on the stack" (scorecard.ts, review.ts),
          // and this cast has not been answered yet — it may never be. The trip
          // itself is the 'move' entry `performMove` writes next.
          appendLog('commander', `Cast ${name} (cast #${priorCasts + 1}, tax +${tax})`, {
            iid,
            name,
            scryfallId: key,
            castNumber: priorCasts + 1,
            taxPaid: tax,
            nextTax: 2 * (priorCasts + 1),
            from: card.zone,
            via: 'stack',
          });
        }

        // `performMove`, not `moveCard`: the hand → battlefield counter seam
        // must not fire on the way to the tray. The tray raises its own below,
        // after the card is on it.
        performMove(iid, 'stack');
        pushStackItem({ kind: 'spell', label: name, iid });

        // Same threshold test the direct cast paths make. The seat speaks up
        // once the spell is on the tray, so its answer stacks on top of it.
        const armed = get().counterArmed;
        const citation =
          armed && manaValueOf(get(), card) >= armed.threshold
            ? counterCitationFor(iid, armed)
            : undefined;
        if (armed && citation) {
          const event = raiseCounterEvent(iid, armed, citation, true);
          if (event) {
            pushStackItem({
              kind: 'counter',
              label: `Seat ${armed.seatId} counters ${name}`,
              iid,
              eventId: event.id,
              seatId: armed.seatId,
            });
          }
        }
      });
    },

    pushAbility(label) {
      action(() => {
        const text = label.trim();
        if (!get().run || !text) return;
        pushStackItem({ kind: 'ability', label: text });
      });
    },

    resolveTop() {
      action(() => {
        const state = get();
        if (!state.run) return;
        const top = state.stack[state.stack.length - 1];
        // A counter on top is the event dialog's to settle, not the tray's.
        if (!top || top.kind === 'counter') return;

        dropStackItem(top.id);
        logStackOp('resolve', 'Resolved', top);

        if (top.kind !== 'spell' || !top.iid) return;
        const card = state.cards[top.iid];
        if (!card || card.zone !== 'stack') return;
        performMove(top.iid, isInstantOrSorceryCard(state, card) ? 'graveyard' : 'battlefield');
      });
    },

    removeStackItem(id) {
      action(() => {
        const state = get();
        const item = state.stack.find((x) => x.id === id);
        // A counter comes off the tray by being answered or resolved, never by
        // being tidied away: the event in front of the player owns it.
        if (!state.run || !item || item.kind === 'counter') return;
        // Nor may the spell underneath one be tidied away while the counter is
        // still standing on it — that would leave the counter pointing at
        // nothing and the question in front of the player unanswerable.
        if (
          item.iid !== undefined &&
          state.stack.some((x) => x.kind === 'counter' && x.iid === item.iid)
        ) {
          return;
        }

        dropStackItem(item.id);
        logStackOp('remove', 'Removed from the stack', item);

        if (item.kind !== 'spell' || !item.iid) return;
        const card = state.cards[item.iid];
        if (!card || card.zone !== 'stack') return;
        // A commander taken off the stack goes home, not to the graveyard. The
        // tax it accrued on the way stays paid.
        performMove(item.iid, card.isCommander ? 'command' : 'graveyard');
      });
    },

    toggleTapped(iid) {
      action(() => {
        const state = get();
        const card = state.cards[iid];
        if (!card) return;
        const name = cardName(state, iid);
        const tapped = !card.tapped;
        set((s) => ({ cards: { ...s.cards, [iid]: { ...s.cards[iid], tapped } } }));
        appendLog('tap', `${name} ${tapped ? 'tapped' : 'untapped'}`, { iid, name, tapped });
      });
    },

    untapAll() {
      action(() => {
        if (!get().run) return;
        const count = untapAllSilently();
        appendLog('tap', `Untapped all (${count} permanent${count === 1 ? '' : 's'})`, { count });
      });
    },

    addCounter(iid, kind, delta) {
      action(() => {
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
      });
    },

    createToken(spec, n) {
      action(() => {
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
      });
    },

    adjustLife(target, delta) {
      action(() => {
        if (!get().run || delta === 0) return;

        if (target === 'player') {
          const before = get().playerLife;
          const after = before + delta;
          set({ playerLife: after });
          appendLog('life', `You: ${before} → ${after}`, { target, delta, before, after });
          return;
        }

        const seat = get().seats.find((s) => s.id === target);
        if (!seat) return;
        const before = seat.life;
        const after = before + delta;
        const damage = Math.max(0, -delta);
        // Hurting a seat makes it less scary and shrinks the board it presents.
        const shrunk = applyDamageToSeat(seat.threat, seat.silhouette, damage, before);

        // The trend arrow reports what the *pod* did between windows, so damage the
        // player just dealt moves the baseline with it: hitting a seat must not
        // read back as "falling" when nothing about the seat's own play changed.
        const threatShift = shrunk.threat - seat.threat;

        set((s) => ({
          seats: s.seats.map((x) =>
            x.id === target
              ? { ...x, life: after, threat: shrunk.threat, silhouette: shrunk.silhouette }
              : x,
          ),
          previousThreat: threatShift
            ? {
                ...s.previousThreat,
                [target]: (s.previousThreat[target] ?? seat.threat) + threatShift,
              }
            : s.previousThreat,
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
      });
    },

    dealCommanderDamage(seatId, amount) {
      action(() => {
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

        // Same as `adjustLife`: your own damage moves the trend baseline with the
        // threat it shrinks, so it stays trend-neutral.
        const threatShift = shrunk.threat - seat.threat;

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
          previousThreat: threatShift
            ? {
                ...s.previousThreat,
                [seatId]: (s.previousThreat[seatId] ?? seat.threat) + threatShift,
              }
            : s.previousThreat,
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
      });
    },

    nextPhase() {
      action(() => {
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
      });
    },

    nextTurn() {
      action(() => {
        beginNextTurn('skip');
      });
    },

    async endRun(result) {
      const state = get();
      // The guard is synchronous and the await is not: without it, a second
      // action landing while the Dexie write is in flight would end the same run
      // again and the log would carry two "Run ended" entries.
      if (!state.run || state.ending) return;
      set({ ending: true });
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
        turnStartLife: STARTING_LIFE,
        seats: freshSeats(),
        previousThreat: threatBySeat(freshSeats()),
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
        hazards: [],
        lastPodHit: {},
        playerThreat: 0,
        windowCount: 0,
        firedCounts: zeroFiredCounts(),
        lastFiredWindow: zeroLastFiredWindow(),
        damageDealtByTurn: {},
        eventSeq: 0,
        stack: [],
        deathNoticed: false,
        ending: false,
      });
    },

    logNote(message) {
      action(() => {
        const text = message.trim();
        if (!get().run || !text) return;
        appendLog('note', text, { note: text, playerAuthored: true });
      });
    },

    undoLastLifeChange() {
      // 'recovery': taking a life change back is how a player climbs out of a
      // noticed death, so it can never be the action that settles one.
      action(() => {
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
          appendLog('note', 'Nothing to undo: no life change left in the log', {
            undo: true,
            noop: true,
          });
          return;
        }

        const entry = target;

        // Threat and silhouette were snapshotted on the entry being undone, so
        // rolling back life rolls back the pressure it caused too.
        const restoredThreat = entry.payload.threatBefore as number | undefined;
        const restoredSilhouette = entry.payload.silhouetteBefore as Silhouette | undefined;

        function restorePressure(seat: Seat): Seat {
          return {
            ...seat,
            threat: restoredThreat ?? seat.threat,
            silhouette: restoredSilhouette ?? seat.silhouette,
          };
        }

        /**
         * The mirror of the baseline shift `adjustLife` applied on the way in: the
         * undo puts the threat back, so the trend baseline goes back with it.
         */
        function restoreBaseline(
          s: GameState,
          seatId: SeatId,
        ): Record<SeatId, number> {
          const seat = s.seats.find((x) => x.id === seatId);
          if (!seat || restoredThreat === undefined) return s.previousThreat;
          const shift = restoredThreat - seat.threat;
          if (!shift) return s.previousThreat;
          return {
            ...s.previousThreat,
            [seatId]: (s.previousThreat[seatId] ?? seat.threat) + shift,
          };
        }

        if (entry.kind === 'life') {
          const who = entry.payload.target as LifeTarget;
          const life = entry.payload.before as number;

          if (who === 'player') {
            set((s) => ({
              playerLife: life,
              // Undoing a change made on an earlier turn must not rewrite this
              // turn's swing, so the turn's opening total moves with it.
              turnStartLife:
                entry.turn < s.turn ? s.turnStartLife + (life - s.playerLife) : s.turnStartLife,
            }));
          } else {
            // A seat can come back to life here. Its canceled events do not come
            // with it: they were logged as canceled once, and the scorer has
            // already written them off as never offered. The seat simply returns
            // with an empty queue, which is the consistent reading of a log that
            // is only ever appended to.
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
              previousThreat: restoreBaseline(s, who),
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
          previousThreat: restoreBaseline(s, seatId),
        }));

        appendLog('life', `Undid: ${target.message}`, {
          undoOf: target.seq,
          target: seatId,
          seatId,
          restoredLife: life,
          restoredCommanderDamage: commanderDamage,
          restoredThreat,
        });
      }, 'recovery');
    },

    resolveOpponentWindow(upcomingTurn) {
      return runOpponentWindow(upcomingTurn ?? get().turn + 1);
    },

    respondToActiveEvent(answer) {
      // Answering an event applies nothing, so it cannot end a run on its own.
      // It settles anyway, as the safety net that keeps every event-queue exit
      // on the same footing.
      action(() => {
        const state = get();
        const event = state.activeEvent;
        if (!state.run || !event) return;

        // A countered spell you force through actually resolves — the card
        // finishes the trip to the battlefield the interception interrupted,
        // whether it was cast from hand or off the command zone. A spell caught
        // on the stack tray is already cast: only the counter leaves, and the
        // spell waits its turn on the tray like everything else on it.
        if (isStackedCounter(event)) {
          const dropped = dropCounterItem(event.id);
          if (dropped) logStackOp('remove', 'Removed from the stack', dropped, 'answered');
        } else if (event.type === 'counter') forceCounterThrough(event);

        const answered: PressureEvent = { ...event, state: 'negated' };
        const trimmed = answer?.note?.trim();
        // Answering a tax is paying it. The price is on the entry, so the
        // scorers can tell a turn the player bought back from a turn the seat
        // collected on.
        const isTax = event.type === 'resource' && event.variant === 'tax';
        const paid = isTax ? event.card?.pay : undefined;
        // A tax is mana, not a card. Nothing asks for one, so nothing is bound
        // and the entry stays silent about binding rather than saying `false`
        // to a question that was never put.
        const bound = isTax ? { fields: {} } : bindAnswer(answer?.iid, event.id);
        const withCard = bound.name ? ` with ${bound.name}` : '';
        appendLog(
          'respond',
          `Answered ${event.type}${withCard}: ${event.prompt}${trimmed ? ` · "${trimmed}"` : ''}`,
          {
            ...eventPayload(answered),
            responded: true,
            negated: true,
            paid,
            ...bound.fields,
            note: trimmed,
          },
        );
        advanceQueue();
      });
    },

    resolveActiveEvent(payload) {
      action(() => {
        const state = get();
        const event = state.activeEvent;
        if (!state.run || !event) return;

        const outcome: Record<string, unknown> = {};
        /** Appended to the log message when the outcome needs naming. */
        let detail = '';

        switch (event.type) {
          case 'wipe': {
            // The cited card carries the true scope; the dock's toggle is the
            // player saying the board disagreed. All it can say is "more than
            // creatures" or "creatures only", so it widens or narrows, and an
            // untouched toggle leaves the card's own sweep alone.
            const cited: CitationSweep = event.card?.sweep ?? normalizeSweep(event.variant);
            const sweep: CitationSweep =
              payload?.wipeNonlands === undefined
                ? cited
                : payload.wipeNonlands
                  ? cited === 'creatures'
                    ? 'nonland'
                    : cited
                  : 'creatures';
            const zone = event.card?.zone ?? 'graveyard';
            const victims = wipeVictims(sweep);
            for (const iid of victims) moveToCitedZone(iid, zone, event.id);
            outcome.scope = sweep;
            outcome.zone = zone;
            outcome.swept = victims.length;
            outcome.iids = victims;

            // A wrath does not stop at the player's side of the table. Anything
            // standing that this sweep reaches goes with the board, which is the
            // one way a piece leaves without the player spending an answer.
            const cleared = retireHazards(
              (h) => sweepClearsHazard(sweep, h.card.permanent),
              (hazard) => ({
                kind: 'threat',
                message: `${hazard.card.name} (Seat ${hazard.seatId}) swept by ${event.card?.name ?? 'the wipe'}`,
                payload: {
                  hazardId: hazard.id,
                  eventId: hazard.eventId,
                  seatId: hazard.seatId,
                  cardName: hazard.card.name,
                  canceled: true,
                  reason: 'wiped',
                  byEventId: event.id,
                },
              }),
            );
            if (cleared.length > 0) outcome.hazardsSwept = cleared.map((h) => h.id);
            break;
          }

          case 'removal': {
            const iid = payload?.targetIid ?? event.targetIid;
            const card = iid ? state.cards[iid] : undefined;
            if (iid && card && card.zone === 'battlefield') {
              const zone = event.card?.zone ?? 'graveyard';
              outcome.targetIid = iid;
              outcome.targetName = cardName(state, iid);
              outcome.zone = zone;
              moveToCitedZone(iid, zone, event.id);
            } else {
              outcome.noTarget = true;
            }
            break;
          }

          case 'counter': {
            const iid = payload?.targetIid ?? event.targetIid;
            const card = iid ? state.cards[iid] : undefined;
            const stacked = isStackedCounter(event);
            if (stacked) {
              // The counter resolved, so both it and the spell under it come off
              // the tray. Where the spell goes is the same question as ever, and
              // the answer below is the same answer.
              const spell = iid
                ? get().stack.find((x) => x.kind === 'spell' && x.iid === iid)
                : undefined;
              const dropped = dropCounterItem(event.id);
              if (dropped) logStackOp('remove', 'Removed from the stack', dropped, 'countered');
              if (spell) {
                dropStackItem(spell.id);
                logStackOp('remove', 'Removed from the stack', spell, 'countered');
              }
              outcome.stacked = 1;
            }
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
                  `${name} countered. Returned to the command zone (next cast tax ${nextTax})`,
                  {
                    iid,
                    name,
                    scryfallId: card.scryfallId,
                    // This entry, and only this entry, is where a cast is marked
                    // countered — for the direct path and the tray path alike.
                    // A cast entry is written before anyone has answered, so it
                    // can never know; saying so there scored a countered cast
                    // for a counter the player went on to answer.
                    countered: true,
                    /** Which way the spell got here. Reporting only. */
                    stacked: stacked || undefined,
                    from: card.zone,
                    to: 'command',
                    nextTax,
                  },
                );
                detail = ` (${name} returned to the command zone)`;
              } else if (card.zone !== 'graveyard') {
                outcome.returnedTo = 'graveyard';
                performMove(iid, 'graveyard');
                detail = ` (${name} countered)`;
              }
            }
            break;
          }

          case 'combat': {
            const offered = event.severity.damage ?? 0;
            const taken = payload?.damageTaken ?? offered;
            outcome.offered = offered;
            outcome.taken = taken;
            // A lethal hit does not end the run here. `adjustLife` is a nested
            // action, so settlement waits for this one's tail and the "Resolved
            // combat" entry below lands in the log before "Run ended".
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
              detail = ` (${mode === 'discard' ? 'discarded' : 'sacrificed'} ${name})`;
            } else {
              const mode = event.variant ?? 'tax';
              outcome.mode = mode;
              if (mode === 'discard' || mode === 'sacrifice') {
                // No card came with the resolution: the player had nothing to give.
                // Say so on the entry, otherwise the log reads as an unexplained
                // no-op and the scorer cannot tell a whiff from a mis-click.
                outcome.noTarget = true;
                detail = mode === 'discard' ? ' (nothing to discard)' : ' (nothing to sacrifice)';
              } else {
                // A tax is pay-or-punish, and this is the punish: the player did
                // not pay, so the seat takes what the card offers. The seat was
                // already made scarier for casting the thing, in the window that
                // offered it; what it collects here is the punish's own, which
                // is a card for a draw and a mana for a Treasure.
                const punish = event.card?.punish ?? 'draw';
                outcome.punish = punish;
                if (event.card?.pay !== undefined) outcome.pay = event.card.pay;
                bumpSeatThreatBy(event.seatId, PRESSURE.threat.punish[punish]);
                if (punish === 'treasure') bumpSeatMana(event.seatId, 1);
                detail = ` (${punishPhrase(punish, event.seatId)})`;
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

          case 'hate': {
            // The piece resolving is what turns it from a question into a fact,
            // which is why the engine never made one: had the player answered
            // it, nothing would be standing. From here it is a tell printed
            // under the seat until it is removed, swept, or its seat dies.
            const card = event.card;
            if (card) {
              const hazard: StandingHazard = {
                id: `hz-${event.id}`,
                eventId: event.id,
                seatId: event.seatId,
                card,
                spawnedTurn: state.turn,
              };
              set((s) => ({ hazards: [...s.hazards, hazard] }));
              outcome.standing = true;
              outcome.hazardId = hazard.id;
              detail = ` (${card.name} stands)`;
            } else {
              // No citation, nothing to stand: an event with no card is not a
              // piece the player could name, let alone play around.
              outcome.standing = false;
            }
            break;
          }
        }

        const resolved: PressureEvent = { ...event, state: 'resolved' };
        const trimmed = payload?.note?.trim();
        appendLog('event', `Resolved ${event.type}: ${event.prompt}${detail}${trimmed ? ` · "${trimmed}"` : ''}`, {
          ...eventPayload(resolved),
          resolved: true,
          outcome,
          note: trimmed,
        });
        advanceQueue();
      });
    },

    declareInteraction(answer) {
      const state = get();
      if (!state.run) return;
      const clock = state.clock;
      if (!clock) return;

      set({ clock: null });
      // Bound once, and the fields land on exactly one entry. Declaring can
      // write two entries — the clock's own, and the warning card's if one is
      // still in front of the player — and every replayer counts the answer off
      // whichever entry carries `answerIid`, so putting the fields on both would
      // count one spent card twice. The warning entry wins when there is one,
      // because it is the entry with an event id for the ledger to file under;
      // with no warning the clock's own entry is the only place left.
      const active = get().activeEvent;
      const clockEvent =
        active && active.type === 'clock' && active.seatId === clock.seatId ? active : null;
      const bound = bindAnswer(answer?.iid, clockEvent?.id ?? `clock-${clock.seatId}`);
      const withCard = bound.name ? ` with ${bound.name}` : '';
      const trimmed = answer?.note?.trim();

      appendLog(
        'respond',
        `Declared held interaction${withCard}. Seat ${clock.seatId}'s clock is answered.`,
        {
          seatId: clock.seatId,
          deadlineTurn: clock.deadlineTurn,
          spawnedTurn: clock.spawnedTurn,
          canceled: true,
          reason: 'declared-interaction',
          ...(clockEvent ? {} : bound.fields),
          note: trimmed,
        },
      );

      // If the clock's own warning is still sitting in front of the player,
      // retire it — it has just been answered.
      if (clockEvent) {
        appendLog('respond', `Answered clock${withCard}: ${clockEvent.prompt}`, {
          ...eventPayload({ ...clockEvent, state: 'negated' }),
          responded: true,
          negated: true,
          ...bound.fields,
          note: trimmed,
        });
        advanceQueue();
      }
    },

    removeHazard(id, answer) {
      // Removing a piece applies nothing to the player, so it cannot end a run
      // on its own. It settles anyway, for the same reason answering an event
      // does: every exit a question has sits on the same footing.
      action(() => {
        const state = get();
        if (!state.run || !state.hazards.some((h) => h.id === id)) return;

        retireHazards(
          (h) => h.id === id,
          (hazard) => {
            // Bound to the event that put it there, not to the hazard: the
            // ledger files answers under event ids, and the piece and the event
            // the player let through are the same thing at two different ages.
            const bound = bindAnswer(answer?.iid, hazard.eventId);
            const withCard = bound.name ? ` with ${bound.name}` : '';
            return {
              kind: 'respond',
              message: `Removed ${hazard.card.name} (Seat ${hazard.seatId})${withCard}`,
              payload: {
                reason: 'removed-hazard',
                hazardId: hazard.id,
                eventId: hazard.eventId,
                seatId: hazard.seatId,
                cardName: hazard.card.name,
                spawnedTurn: hazard.spawnedTurn,
                /** How long the player played around it. 0 means the turn it landed. */
                turnsStanding: state.turn - hazard.spawnedTurn,
                ...bound.fields,
                note: answer?.note?.trim(),
              },
            };
          },
        );
      });
    },
  };
});
