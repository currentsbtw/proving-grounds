import { PRESSURE, byBracket, type Hazard } from '../data/pressure';
import {
  CITATIONS,
  type Citation,
  type CitationSweep,
  type CounterTarget,
  type Punish,
  type RemovalTarget,
} from '../data/citations';
import {
  PROFILES,
  PROFILE_IDS,
  type ManaColor,
  type SeatProfile,
  type SeatProfileId,
} from '../data/profiles';
import {
  isArtifactTypeLine,
  isCreatureTypeLine,
  isEnchantmentTypeLine,
  isInstantOrSorceryTypeLine,
  isLegendaryTypeLine,
  isPlaneswalkerTypeLine,
} from '../domain/typeLine';
import type {
  ClockState,
  CounterArmed,
  EventCitation,
  EventType,
  PressureEvent,
  Seat,
  SeatId,
  Silhouette,
} from '../domain/types';

/**
 * The pressure engine. Every export here is a pure function: it reads its input,
 * draws from the supplied rng closure, and returns new values. Nothing imports
 * the store, touches Dexie, or reaches for the clock. Same input plus the same
 * rng sequence always yields the same output — that is what makes a seed replay.
 *
 * Vocabulary: an *opponent window* is the stretch between the player's turns.
 * A window is named for the turn it precedes, so the first window of a run is
 * "the window before turn 2".
 */

// ---------------------------------------------------------------------------
// Input / output contracts
// ---------------------------------------------------------------------------

/** The subset of a `Seat` the engine reads and rewrites. */
export interface SeatSnapshot {
  id: SeatId;
  life: number;
  eliminated: boolean;
  threat: number;
  silhouette: Silhouette;
  /** Highest threat held this run; defaults to `threat` when absent. */
  peakThreat?: number;
  /** The board held at that peak; defaults to `silhouette` when absent. */
  peakSilhouette?: Silhouette;
  /** The seat's archetype. Absent means `neutral` — see `profileOf`. */
  profile?: SeatProfileId;
}

/** One of the player's permanents, flattened for the targeting heuristic. */
export interface PermanentSummary {
  iid: string;
  name: string;
  manaValue: number;
  isCommander: boolean;
  isToken: boolean;
  isLand: boolean;
  /**
   * The printed type line. Read front-face only, and only to ask what a removal
   * spell would have to be able to point at: no card can cite Krosan Grip on a
   * creature.
   */
  typeLine: string;
  /** The store's monotonic move stamp — higher means more recently arrived. */
  movedAt: number;
}

/** Everything the engine knows about the player. No card list, by design. */
export interface PlayerSummary {
  life: number;
  /** Total mana value of nonland, non-token permanents on the battlefield. */
  boardMV: number;
  /** Total power of the player's creatures — used only to phrase block prompts. */
  boardPower: number;
  commanderOnBattlefield: boolean;
  /** Damage the player dealt to seats over the last `PRESSURE.playerThreat.recentTurns` turns. */
  damageDealtRecent: number;
}

export type FiredCounts = Record<EventType, number>;
/** Window index of the most recent firing per type; 0 means "never fired". */
export type LastFiredWindow = Record<EventType, number>;

export interface WindowInput {
  /** The player turn about to begin. The window sits immediately before it. */
  turn: number;
  /** 1-based count of opponent windows resolved this run, including this one. */
  windowIndex: number;
  bracket: number;
  /** The run's seeded PRNG. Consumed in a fixed order — see `resolveWindow`. */
  rng: () => number;
  seats: SeatSnapshot[];
  player: PlayerSummary;
  /** The player's battlefield, for the removal targeting heuristic. */
  permanents: PermanentSummary[];
  clock: ClockState | null;
  counterArmed: CounterArmed | null;
  firedCounts: FiredCounts;
  lastFiredWindow: LastFiredWindow;
}

export interface SeatUpdate {
  id: SeatId;
  threat: number;
  silhouette: Silhouette;
}

export interface WindowResult {
  /** Replacement threat/silhouette for every seat, eliminated ones included. */
  seats: SeatUpdate[];
  /** Events to enqueue, in the order they should be shown. */
  events: PressureEvent[];
  clock: ClockState | null;
  counterArmed: CounterArmed | null;
  /** The derived 0–10 player threat this window was judged against. */
  playerThreat: number;
  /** Line for the 'window' log entry. */
  summary: string;
  /** Extra machine-readable notes for the log payload. */
  notes: string[];
  /**
   * True when the race clock's deadline has passed. The caller ends the run as
   * a loss; nothing else in this result was computed.
   */
  clockExpired: boolean;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export const EVENT_TYPES: EventType[] = [
  'wipe',
  'removal',
  'counter',
  'combat',
  'clock',
  'resource',
];

export function emptySilhouette(): Silhouette {
  return { creatures: 0, power: 0, artifacts: 0, openMana: 1, bonusMana: 0 };
}

export function zeroFiredCounts(): FiredCounts {
  return { wipe: 0, removal: 0, counter: 0, combat: 0, clock: 0, resource: 0 };
}

export function zeroLastFiredWindow(): LastFiredWindow {
  return { wipe: 0, removal: 0, counter: 0, combat: 0, clock: 0, resource: 0 };
}

/** Opening threat for a seat, drawn from `PRESSURE.threat.startMin..startMax`. */
export function initialThreat(rng: () => number): number {
  const { startMin, startMax } = PRESSURE.threat;
  return round1(startMin + rng() * (startMax - startMin));
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function clampThreat(n: number): number {
  return round1(clamp(n, PRESSURE.threat.min, PRESSURE.threat.max));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Round `n` to a whole number, using the rng for the fractional part. Lets a
 * "+0.6 creatures per window" growth rate produce integer creature counts
 * without ever silently truncating to zero.
 */
function stochasticRound(n: number, rng: () => number): number {
  const whole = Math.floor(n);
  return whole + (rng() < n - whole ? 1 : 0);
}

/** Deterministic pick from a list. Returns undefined for an empty list. */
function pick<T>(list: T[], rng: () => number): T | undefined {
  if (list.length === 0) return undefined;
  return list[Math.floor(rng() * list.length)];
}

/** Highest value wins; ties break on seat id so replays never diverge. */
function bestSeat(
  seats: SeatSnapshot[],
  score: (s: SeatSnapshot) => number,
): SeatSnapshot | undefined {
  let best: SeatSnapshot | undefined;
  let bestScore = -Infinity;
  for (const seat of seats) {
    const value = score(seat);
    if (value > bestScore || (value === bestScore && best && seat.id < best.id)) {
      best = seat;
      bestScore = value;
    }
  }
  return best;
}

export function livingSeats(seats: SeatSnapshot[]): SeatSnapshot[] {
  return seats.filter((s) => !s.eliminated);
}

/** The seat that attacks, starts clocks, and fires removal. */
export function highestThreatSeat(seats: SeatSnapshot[]): SeatSnapshot | undefined {
  return bestSeat(livingSeats(seats), (s) => s.threat);
}

// ---------------------------------------------------------------------------
// Seat profiles
// ---------------------------------------------------------------------------

/**
 * The archetype a seat is piloting. Optional on the snapshot on purpose: a
 * caller that assigns no profiles falls back to `neutral`, whose every
 * multiplier is exactly 1.0 and whose colours are all five, so the engine
 * behaves as it did before profiles existed. `neutral` is never dealt to a
 * seat — it is only ever this fallback.
 */
export function profileOf(seat: SeatSnapshot): SeatProfile {
  return PROFILES[seat.profile ?? 'neutral'];
}

/**
 * The colours a seat may cite from — the same fallback, so the two functions
 * cannot disagree about what an unprofiled seat is. An unprofiled seat has no
 * colour identity to be honest about, and pinning it to any archetype's would
 * quietly delete cards from its table; `neutral` runs all five instead, which
 * is the whole citation table, exactly as it was before profiles existed.
 */
export function colorsOf(seat: SeatSnapshot): readonly ManaColor[] {
  return profileOf(seat).colors;
}

/**
 * Three distinct archetypes for seats A, B and C, drawn once at run start.
 * Distinct because a table of three Control seats is the thing this replaces:
 * the point of a profile is that the seats behave differently from each other.
 *
 * A partial Fisher-Yates over `PROFILE_IDS`, so it costs exactly three draws
 * and the same rng sequence always deals the same table.
 */
export function drawProfiles(rng: () => number): SeatProfileId[] {
  const pool = [...PROFILE_IDS];
  const out: SeatProfileId[] = [];
  for (let i = 0; i < 3; i++) {
    const j = i + Math.floor(rng() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
    out.push(pool[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Derived player threat
// ---------------------------------------------------------------------------

/**
 * The player's own 0–10 threat rating. The pod answers what scares it: removal
 * and counterspell frequency both scale with this.
 */
export function playerThreatOf(player: PlayerSummary): number {
  const c = PRESSURE.playerThreat;
  const fromBoard = clamp(player.boardMV * c.perBoardMv, 0, c.boardMvCap);
  const fromDamage = clamp(player.damageDealtRecent * c.perDamage, 0, c.damageCap);
  const fromCommander = player.commanderOnBattlefield ? c.commanderBonus : 0;
  return clampThreat(c.base + fromBoard + fromDamage + fromCommander);
}

// ---------------------------------------------------------------------------
// Hazard rolls
// ---------------------------------------------------------------------------

/**
 * Probability for one hazard this window, before the caller's own gates. Every
 * dial is bracket-indexed, so the bracket moves the *schedule* — when the
 * hazard switches on and how steeply it climbs — not just an overall frequency.
 * A negative `perTurn` is legal: it makes a hazard decay out of the game.
 *
 * Two multipliers land here, and they sit on opposite sides of the bracket's
 * `max` because they answer different questions.
 *
 * `scale` is the pod's response to the *player* — removal's player-threat
 * scale. It belongs before the cap: the bracket's `max` is the statement "a
 * bracket-3 pod never points removal at you more than 28% of windows, however
 * scary you look", and moving that scale after the cap would delete it. Bracket
 * ceilings stay ceilings on how much pressure a bracket produces.
 *
 * `profileMult` is *whose seat* is casting it, and it belongs after the cap. Put
 * it before, and a multiplier above 1.0 gets swallowed the moment the ramp
 * reaches the cap — bracket-4 combat pinned aggro (1.6x) and tokens (1.4x) to
 * the same 0.9 from turn 5, and bracket-3 wipe pinned control (2.0x) to the same
 * 0.5 as an unmodified seat from turn 6, while every multiplier below 1.0 kept
 * its full effect. The archetypes stopped being distinguishable exactly where
 * the game gets interesting. Scaling the capped value instead keeps the gap, and
 * `PRESSURE.profileCeiling` is the one thing above it: no hazard becomes
 * certain, whoever is holding it.
 */
export function hazardChance(
  hazard: Hazard,
  turn: number,
  bracket: number,
  scale = 1,
  profileMult = 1,
): number {
  const startTurn = byBracket(hazard.startTurn, bracket);
  if (turn < startTurn) return 0;
  const ramp =
    byBracket(hazard.base, bracket) + byBracket(hazard.perTurn, bracket) * (turn - startTurn);
  const capped = clamp(ramp * scale, 0, byBracket(hazard.max, bracket));
  return clamp(capped * profileMult, 0, PRESSURE.profileCeiling);
}

function offCooldown(input: WindowInput, type: EventType, hazard: Hazard): boolean {
  if (input.firedCounts[type] >= byBracket(hazard.cap, input.bracket)) return false;
  const last = input.lastFiredWindow[type];
  if (last === 0) return true;
  return input.windowIndex - last > byBracket(hazard.cooldown, input.bracket);
}

// ---------------------------------------------------------------------------
// Targeting
// ---------------------------------------------------------------------------

/**
 * What the pod's removal points at: the commander if it is on the battlefield,
 * otherwise the biggest real permanent, breaking ties on whatever arrived last.
 * Returns undefined when the player controls nothing worth answering.
 *
 * Lands and tokens are not worth answering. No card in the table can point at a
 * land, and a token that gets removed simply stops existing — spending a card on
 * one is not a story a pod tells, and it would read as the app inventing a
 * threat out of a Treasure.
 */
export function chooseRemovalTarget(
  permanents: PermanentSummary[],
): PermanentSummary | undefined {
  const commander = permanents.find((p) => p.isCommander);
  if (commander) return commander;

  let best: PermanentSummary | undefined;
  for (const p of permanents) {
    if (p.isLand || p.isToken) continue;
    if (
      !best ||
      p.manaValue > best.manaValue ||
      (p.manaValue === best.manaValue && p.movedAt > best.movedAt)
    ) {
      best = p;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Card citations
// ---------------------------------------------------------------------------

/**
 * Every event names a card the seat cast, and no event fires without one.
 *
 * The rule the whole section serves is "no card, no event": a prompt the player
 * cannot picture happening at a real table is worse than no prompt at all, so
 * eligibility is checked first and the hazard is dropped when nothing fits. A
 * bracket-2 pod cannot cite Force of Will, and nobody wraths the nonlands on
 * turn four with four mana up, because no printed card does that.
 *
 * Selection costs exactly one rng draw, taken immediately after the hazard's own
 * sub-rolls (see the `resolveWindow` docblock). Counters are the exception: they
 * are raised by the store on a cast, outside the window's rng stream, so they
 * index deterministically instead.
 */

/**
 * Mana a seat can actually spend: its land drop, or the fast mana its bracket
 * runs, plus whatever it banked outside both. `bonusMana` is added rather than
 * folded into the `max` on purpose — a Treasure that only raised `openMana` to
 * a number `turn + accel` already beat would buy the seat nothing, which is
 * exactly the failure the punish is meant not to have.
 */
export function seatMana(silhouette: Silhouette, turn: number, bracket: number): number {
  return (
    Math.max(silhouette.openMana, turn + byBracket(PRESSURE.seatMana.accel, bracket)) +
    silhouette.bonusMana
  );
}

function inBracket(citation: Citation, bracket: number): boolean {
  const b = Math.min(5, Math.max(1, Math.round(bracket)));
  return b >= citation.brackets[0] && b <= citation.brackets[1];
}

/**
 * Whether a seat running `colors` could be holding this card. A colourless card
 * is castable out of any pile, which is why an empty `colors` on the citation
 * passes for everyone.
 */
function inColors(citation: Citation, colors: readonly ManaColor[]): boolean {
  return citation.colors.every((c) => colors.includes(c));
}

/** Bracket, mana, turn and the caster's colours — the filters every kind of citation shares. */
function baseEligible(
  list: Citation[],
  mana: number,
  bracket: number,
  turn: number,
  colors: readonly ManaColor[],
): Citation[] {
  return list.filter(
    (c) =>
      inBracket(c, bracket) &&
      inColors(c, colors) &&
      c.cost <= mana &&
      turn >= (c.minTurn ?? 0) &&
      turn <= (c.maxTurn ?? Infinity),
  );
}

/** The event's copy: the card facts, without the filters that chose it. */
function toEventCitation(citation: Citation): EventCitation {
  const {
    brackets: _brackets,
    minTurn: _minTurn,
    maxTurn: _maxTurn,
    targets: _targets,
    minTargetMv: _minTargetMv,
    excludes: _excludes,
    counters: _counters,
    ...card
  } = citation;
  return Object.freeze(card);
}

/** One rng draw, or none at all when the list is empty. */
function pickCitation(list: Citation[], rng: () => number): EventCitation | undefined {
  const chosen = pick(list, rng);
  return chosen ? toEventCitation(chosen) : undefined;
}

/** What a removal spell would have to be able to target to answer this permanent. */
function removalTargetsOf(permanent: PermanentSummary): Set<RemovalTarget> {
  const kinds = new Set<RemovalTarget>();
  // Nothing in the table answers a land, so a board of nothing but lands is a
  // board the pod has no removal for.
  if (permanent.isLand) return kinds;
  kinds.add('permanent');
  const line = permanent.typeLine;
  if (isCreatureTypeLine(line)) kinds.add('creature');
  if (isArtifactTypeLine(line)) kinds.add('artifact');
  if (isEnchantmentTypeLine(line)) kinds.add('enchantment');
  if (isPlaneswalkerTypeLine(line)) kinds.add('planeswalker');
  return kinds;
}

/** What a counterspell would have to be able to hit to catch this spell. */
export function counterShapesOf(typeLine: string): Set<CounterTarget> {
  const shapes = new Set<CounterTarget>(['any']);
  shapes.add(isCreatureTypeLine(typeLine) ? 'creature' : 'noncreature');
  if (isInstantOrSorceryTypeLine(typeLine)) shapes.add('instant-sorcery');
  if (isEnchantmentTypeLine(typeLine)) shapes.add('enchantment');
  if (isLegendaryTypeLine(typeLine)) shapes.add('legendary');
  return shapes;
}

/**
 * The wrath the seat is holding, split by scope. There is no dial holding wide
 * sweeps back any more: the cheapest printed one that reaches past creatures is
 * Nevinyrral's Disk, which has to survive a turn before it can be cracked, so
 * the table's own `minTurn` is what keeps a turn-four Farewell off the table.
 */
function partitionWipes(
  mana: number,
  bracket: number,
  turn: number,
  colors: readonly ManaColor[],
): { creatures: Citation[]; wide: Citation[] } {
  const creatures: Citation[] = [];
  const wide: Citation[] = [];
  for (const c of baseEligible(CITATIONS.wipe, mana, bracket, turn, colors)) {
    if (c.sweep === 'creatures') creatures.push(c);
    else if (c.sweep === 'nonland' || c.sweep === 'ace') wide.push(c);
  }
  return { creatures, wide };
}

function eligibleRemoval(
  mana: number,
  bracket: number,
  turn: number,
  target: PermanentSummary,
  colors: readonly ManaColor[],
): Citation[] {
  const kinds = removalTargetsOf(target);
  if (kinds.size === 0) return [];
  return baseEligible(CITATIONS.removal, mana, bracket, turn, colors).filter(
    (c) =>
      (c.targets ?? []).some((t) => kinds.has(t)) &&
      // Go for the Throat is a nonartifact creature card, and a player would
      // notice a seat citing it on their Signet-shaped Golem.
      !(c.excludes ?? []).some((t) => kinds.has(t)) &&
      target.manaValue >= (c.minTargetMv ?? 0),
  );
}

/** One kind of resource attack a seat could make, with its roll weight. */
interface ResourceOption {
  variant: 'discard' | 'sacrifice' | 'tax';
  weight: number;
  list: Citation[];
}

/**
 * The resource attacks a seat can actually make. Only variants it owns a card
 * for are on the table and the weights are renormalised over what is left — a
 * bracket-1 pod runs no stax piece, so it strips and edicts instead of taxing
 * at four fifths the rate. The weights come from the seat's profile when it has
 * its own shape (a stax seat mostly taxes), and from `PRESSURE` otherwise.
 */
function resourcePool(seat: SeatSnapshot, turn: number, bracket: number): ResourceOption[] {
  const profile = profileOf(seat);
  const w = profile.resourceWeights ?? PRESSURE.resource.weights;
  const mana = seatMana(seat.silhouette, turn, bracket);
  const options: ResourceOption[] = [
    { variant: 'discard', weight: w.discard, list: CITATIONS.discard },
    { variant: 'sacrifice', weight: w.sacrifice, list: CITATIONS.sacrifice },
    { variant: 'tax', weight: w.tax, list: CITATIONS.tax },
  ];
  return options
    .map((o) => ({ ...o, list: baseEligible(o.list, mana, bracket, turn, colorsOf(seat)) }))
    .filter((o) => o.list.length > 0);
}

/**
 * The counterspell an armed seat actually holds, chosen without touching the
 * rng: the store raises counters on the player's cast, which is not a point in
 * the window's draw order, so a seed has to replay the same whether or not the
 * player cast into it. The index is a hash of things already fixed by the seed
 * and the spell. Returns undefined when the seat has nothing that catches this
 * spell — the seat then does not counter at all.
 *
 * `colors` is the holding seat's colour identity, and it is required. The
 * arming step in `resolveWindow` only ever arms a seat that owns a counterspell
 * in its colours, so a caller that left it out here could hand that same seat a
 * card it was never eligible to be holding. Pass `colorsOf(seat)`.
 */
export function chooseCounterCitation(
  windowIndex: number,
  turn: number,
  bracket: number,
  mana: number,
  spell: { name: string; manaValue: number; typeLine: string },
  colors: readonly ManaColor[],
): EventCitation | undefined {
  const shapes = counterShapesOf(spell.typeLine);
  const eligible = baseEligible(CITATIONS.counter, mana, bracket, turn, colors).filter((c) =>
    (c.counters ?? []).some((t) => shapes.has(t)),
  );
  if (eligible.length === 0) return undefined;
  const index = (windowIndex + spell.manaValue + spell.name.length) % eligible.length;
  return toEventCitation(eligible[index]);
}

// ---------------------------------------------------------------------------
// Growth
// ---------------------------------------------------------------------------

function grownSilhouette(
  seat: SeatSnapshot,
  turn: number,
  rng: () => number,
): Silhouette {
  const c = PRESSURE.silhouette;
  const s = seat.silhouette;
  // The profile decides the *shape* of the board, not how fast it arrives: a
  // tokens seat grows more bodies and less power out of the same threat, an
  // aggro seat the other way round.
  const shape = profileOf(seat).silhouette;
  return {
    creatures:
      s.creatures + stochasticRound(seat.threat * c.creaturesPerThreat * shape.creaturesMult, rng),
    power: s.power + stochasticRound(seat.threat * c.powerPerThreat * shape.powerMult, rng),
    artifacts: s.artifacts + stochasticRound(seat.threat * c.artifactsPerThreat, rng),
    // The land drop is recomputed every window; the banked mana rides along, so
    // the readout keeps showing what the seat can really represent.
    openMana: Math.min(turn, c.maxOpenMana) + s.bonusMana,
    bonusMana: s.bonusMana,
  };
}

/**
 * A seat that just took damage is less scary and has a smaller board. Called by
 * the store from `adjustLife` and `dealCommanderDamage`.
 */
export function applyDamageToSeat(
  threat: number,
  silhouette: Silhouette,
  amount: number,
  lifeBefore: number,
): { threat: number; silhouette: Silhouette } {
  if (amount <= 0) return { threat, silhouette };
  const nextThreat = clampThreat(threat - amount / PRESSURE.threat.damagePerPoint);
  const shrink = clamp(amount / Math.max(1, lifeBefore), 0, PRESSURE.silhouette.damageShrinkCap);
  const keep = 1 - shrink;
  return {
    threat: nextThreat,
    silhouette: {
      creatures: Math.round(silhouette.creatures * keep),
      power: Math.round(silhouette.power * keep),
      artifacts: silhouette.artifacts,
      openMana: silhouette.openMana,
      bonusMana: silhouette.bonusMana,
    },
  };
}

/**
 * An eliminated seat's presence flows to the survivors rather than evaporating:
 * the pod stays as dangerous, it is just concentrated in fewer hands. Event
 * *frequency* is already seat-independent, so this only moves threat and board.
 * Returns updates for the survivors only.
 *
 * What flows is the dead seat's *peak*, not its last reading. Damage sheds
 * threat and shrinks a silhouette on the way down, so a seat burned from 40 to
 * 0 arrives here at threat 0 with an empty board — and redistributing that
 * would mean killing a seat relieved the table's pressure, which is exactly the
 * thing the rule forbids. `peakThreat`/`peakSilhouette` fall back to the live
 * values, so a caller that does not track peaks still gets the old behaviour.
 */
export function redistribute(seats: SeatSnapshot[], deadSeatId: SeatId): SeatUpdate[] {
  const dead = seats.find((s) => s.id === deadSeatId);
  const survivors = seats.filter((s) => s.id !== deadSeatId && !s.eliminated);
  if (!dead || survivors.length === 0) return [];

  const deadThreat = Math.max(dead.threat, dead.peakThreat ?? 0);
  const deadBoard = dead.peakSilhouette ?? dead.silhouette;
  const threatEach = (deadThreat * PRESSURE.threat.eliminationInheritShare) / survivors.length;
  const share = PRESSURE.silhouette.eliminationInheritShare / survivors.length;

  return survivors.map((s) => ({
    id: s.id,
    threat: clampThreat(s.threat + threatEach),
    silhouette: {
      creatures: s.silhouette.creatures + Math.round(deadBoard.creatures * share),
      power: s.silhouette.power + Math.round(deadBoard.power * share),
      artifacts: s.silhouette.artifacts + Math.round(deadBoard.artifacts * share),
      openMana: s.silhouette.openMana,
      bonusMana: s.silhouette.bonusMana,
    },
  }));
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function seatLabel(id: SeatId): string {
  return `Seat ${id}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * What a seat collects when a pay-or-punish tax goes unpaid, as a sentence
 * fragment with the seat named. One export so the prompt, the resolution detail
 * and the dock's button all say the same thing.
 */
export function punishPhrase(punish: Punish | undefined, seatId: SeatId): string {
  return punish === 'treasure'
    ? `${seatLabel(seatId)} makes a Treasure`
    : `${seatLabel(seatId)} draws a card`;
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/**
 * Resolve one opponent window.
 *
 * Every hazard is cast by a seat, and which seat it is now changes the odds:
 * the candidates are the living seats that could actually do the thing (they
 * hold at least one citation in their colours at their mana — combat needs no
 * card), the existing preference picks one of them, and the hazard's chance is
 * multiplied by that seat's profile. So a table with the control seat still in
 * it wraths more than one without, and a seat never cites a card outside its
 * colours. A seat with no profile reads as `neutral`, whose multipliers are all
 * exactly 1.0 and whose colours are all five.
 *
 * The rng is consumed in a fixed order so a seed replays exactly:
 *   1. threat jitter, one draw per living seat
 *   2. silhouette growth, three draws per living seat
 *   3. hazard rolls in the order wipe, removal, combat, resource, then the
 *      clock (plus any sub-rolls a firing event needs, drawn immediately after
 *      its own roll, ending with the one draw that picks its card citation —
 *      no draw at all when nothing is eligible, because then nothing fires).
 *      Casters are chosen before the roll, because the roll is scaled by the
 *      caster's profile; only the resource attack's caster costs a draw, and it
 *      is taken immediately *before* that hazard's roll rather than after it.
 *   4. the counterspell arming roll
 *
 * The order is fixed, but the *number* of draws a window costs is not, and that
 * is the thing to understand before comparing two seeds. A hazard that finds no
 * eligible citation never rolls at all — the wipe, removal, clock and
 * counter-arm steps each build their candidate list first and skip the whole
 * step when no living seat holds a card for it — so how many draws a window
 * takes depends on which profiles were dealt, what those seats can afford, and
 * what is in `src/data/citations.ts`. Editing the citation table or a profile's
 * colours moves every later window of every seed, which is why both bump
 * `PRESSURE.version` (see the note there). Version 4 moved the resource
 * attack's caster draw ahead of its own hazard roll; version 5 changes no draw
 * order at all, only where a profile multiplier meets a hazard's cap, which is
 * enough to change the outcome of rolls near that cap.
 *
 * When the clock's deadline has passed the function short-circuits: it reports
 * `clockExpired` and returns the seats untouched, because the run is over.
 */
export function resolveWindow(input: WindowInput): WindowResult {
  const { turn, bracket, rng, windowIndex } = input;

  if (input.clock && turn > input.clock.deadlineTurn) {
    return {
      seats: input.seats.map((s) => ({ id: s.id, threat: s.threat, silhouette: s.silhouette })),
      events: [],
      clock: input.clock,
      counterArmed: null,
      playerThreat: playerThreatOf(input.player),
      summary: `${seatLabel(input.clock.seatId)} wins. The clock ran out after turn ${input.clock.deadlineTurn}.`,
      notes: ['clock-expired'],
      clockExpired: true,
    };
  }

  const playerThreat = playerThreatOf(input.player);
  const severityMult = byBracket(PRESSURE.bracket.severity, bracket);
  const maxEvents = byBracket(PRESSURE.bracket.maxEventsPerWindow, bracket);
  const notes: string[] = [];

  // --- 1 & 2: growth -------------------------------------------------------
  const growthJitter = PRESSURE.threat.jitterMin;
  const growthSpan = PRESSURE.threat.jitterSpan;
  // Growth ramps with the turn: a low-bracket pod builds slowly and only gets
  // scary late, a high-bracket pod opens fast and then runs into the 0–10 cap.
  const perWindow = Math.max(
    0,
    byBracket(PRESSURE.bracket.threatGrowth, bracket) +
      byBracket(PRESSURE.bracket.threatGrowthRamp, bracket) * Math.max(0, turn - 2),
  );

  const working: SeatSnapshot[] = input.seats.map((seat) => {
    if (seat.eliminated) return { ...seat, silhouette: { ...seat.silhouette } };
    const growth = perWindow * profileOf(seat).threatGrowthMult;
    const threat = clampThreat(seat.threat + growth * (growthJitter + rng() * growthSpan));
    const grown = { ...seat, threat };
    return { ...grown, silhouette: grownSilhouette(grown, turn, rng) };
  });

  // No profile notes here. A seat's archetype is dealt once at run start and
  // never changes, so repeating all three of them every window said nothing new;
  // anything attributing a window's events to archetypes reads `seat.profile`
  // off the seats it already holds rather than parsing them back out of a log
  // line.

  // --- 3: hazards ----------------------------------------------------------
  const events: PressureEvent[] = [];
  const alive = () => livingSeats(working);

  function bumpThreat(seatId: SeatId, type: EventType): void {
    const seat = working.find((s) => s.id === seatId);
    if (seat) seat.threat = clampThreat(seat.threat + PRESSURE.threat.eventJump[type]);
  }

  function makeEvent(
    type: EventType,
    seatId: SeatId,
    prompt: string,
    severity: Record<string, number>,
    extra: { variant?: string; targetIid?: string; card?: EventCitation } = {},
  ): PressureEvent {
    return {
      id: `w${windowIndex}-${type}-${seatId}`,
      type,
      seatId,
      turn,
      prompt,
      severity: { turn, bracket, ...severity },
      state: 'pending',
      ...extra,
    };
  }

  const roomLeft = () => events.length < maxEvents;

  // Wipe — the pod's reset. Rare, and it hits every board including the seats'.
  const wipeHazard = PRESSURE.hazards.wipe;
  const podCreatures = alive().reduce((n, s) => n + s.silhouette.creatures, 0);
  let wiped = false;
  if (
    roomLeft() &&
    podCreatures >= PRESSURE.wipe.minPodCreatures &&
    offCooldown(input, 'wipe', wipeHazard)
  ) {
    // Only seats that own a wrath in their colours at their mana are in the
    // running; among those, the seat with the least to lose is the one holding
    // it. Filtering before the preference is what stops the least-scary seat
    // from silently swallowing the pod's wrath because it happens to be mono-red.
    const wipeCandidates = alive()
      .map((seat) => ({
        seat,
        wipes: partitionWipes(
          seatMana(seat.silhouette, turn, bracket),
          bracket,
          turn,
          colorsOf(seat),
        ),
      }))
      .filter((c) => c.wipes.creatures.length > 0 || c.wipes.wide.length > 0);
    const chosen = bestSeat(
      wipeCandidates.map((c) => c.seat),
      (s) => -s.silhouette.power,
    );
    const entry = wipeCandidates.find((c) => c.seat.id === chosen?.id);
    if (
      entry &&
      rng() < hazardChance(wipeHazard, turn, bracket, 1, profileOf(entry.seat).hazardMult.wipe)
    ) {
      const caster = entry.seat;
      const nonlands = rng() < byBracket(PRESSURE.wipe.nonlandChance, bracket);
      // The roll asks for a nonland sweep; the table decides whether the seat
      // owns one. Nobody blows up the world with four mana up, so a pod that
      // cannot afford it settles for a creature wrath, and a pod that cannot
      // afford either was never a candidate.
      const list = nonlands && entry.wipes.wide.length > 0 ? entry.wipes.wide : entry.wipes.creatures;
      const card = pickCitation(list, rng);
      if (card) {
        // One vocabulary for scope everywhere: the event's variant is the card's
        // own `CitationSweep`, ace included, and so is the resolution's scope.
        const variant: CitationSweep = card.sweep ?? 'creatures';
        events.push(
          makeEvent(
            'wipe',
            caster.id,
            `${seatLabel(caster.id)} casts ${card.name}.`,
            { podCreatures, podPower: alive().reduce((n, s) => n + s.silhouette.power, 0) },
            { variant, card },
          ),
        );
        bumpThreat(caster.id, 'wipe');
        wiped = true;
        notes.push(`wipe:${caster.id}:${variant}:${card.name}`);
      }
    }
  }

  // Targeted removal — scales with how scary the player looks.
  const removalHazard = PRESSURE.hazards.removal;
  const removalScale =
    PRESSURE.removal.playerThreatBase + playerThreat * PRESSURE.removal.playerThreatPer;
  const target = chooseRemovalTarget(input.permanents);
  if (roomLeft() && target && offCooldown(input, 'removal', removalHazard)) {
    // Candidates first, preference second: the scariest seat fires the removal,
    // but only out of the seats that own something that can point at this
    // permanent in their colours.
    const removalCandidates = alive()
      .map((seat) => ({
        seat,
        list: eligibleRemoval(
          seatMana(seat.silhouette, turn, bracket),
          bracket,
          turn,
          target,
          colorsOf(seat),
        ),
      }))
      .filter((c) => c.list.length > 0);
    const chosen = bestSeat(
      removalCandidates.map((c) => c.seat),
      (s) => s.threat,
    );
    const entry = removalCandidates.find((c) => c.seat.id === chosen?.id);
    if (
      entry &&
      rng() <
        hazardChance(
          removalHazard,
          turn,
          bracket,
          removalScale,
          profileOf(entry.seat).hazardMult.removal,
        )
    ) {
      const caster = entry.seat;
      const card = pickCitation(entry.list, rng);
      if (card) {
        events.push(
          makeEvent(
            'removal',
            caster.id,
            `${seatLabel(caster.id)} casts ${card.name} on ${target.name}.`,
            { targetMv: target.manaValue, playerThreat, commander: target.isCommander ? 1 : 0 },
            { targetIid: target.iid, card },
          ),
        );
        bumpThreat(caster.id, 'removal');
        notes.push(
          `removal:${caster.id}:${target.isCommander ? 'commander' : 'permanent'}:${card.name}`,
        );
      }
    }
  }

  // Combat — the highest-threat seat turns its silhouette sideways. The only
  // hazard with no citation to satisfy, so every living seat is a candidate and
  // the board it grew is the whole gate.
  const combatHazard = PRESSURE.hazards.combat;
  const attacker = highestThreatSeat(working);
  if (
    roomLeft() &&
    !wiped &&
    attacker &&
    attacker.silhouette.power >= PRESSURE.combat.minPower &&
    rng() < hazardChance(combatHazard, turn, bracket, 1, profileOf(attacker).hazardMult.combat)
  ) {
    const c = PRESSURE.combat;
    const plausible = Math.round(
      Math.min(c.damageBase + c.damagePerTurn * turn, c.damageHardCap) * severityMult,
    );
    const swung = Math.round(attacker.silhouette.power * c.powerShare * severityMult);
    const damage = Math.max(1, Math.min(swung, plausible));
    const attackers = Math.max(1, attacker.silhouette.creatures);
    const block = input.player.boardPower;
    const blockLine =
      block > 0
        ? `Block with up to ${block} power or take it.`
        : 'You have nothing back. Answer it or take it.';
    events.push(
      makeEvent(
        'combat',
        attacker.id,
        `${seatLabel(attacker.id)} attacks with ${plural(attackers, 'creature')} for ${damage}. ${blockLine}`,
        { damage, attackers, power: attacker.silhouette.power, blockPower: block },
      ),
    );
    bumpThreat(attacker.id, 'combat');
    notes.push(`combat:${attacker.id}:${damage}`);
  }

  // Resource attack — discard, sacrifice, or a tax.
  const resourceHazard = PRESSURE.hazards.resource;
  if (roomLeft() && offCooldown(input, 'resource', resourceHazard)) {
    // Which seat strips you is the one caster choice with no preference behind
    // it, so it stays a seeded pick — but only over seats that own a strip, an
    // edict or a tax piece in their colours. A Selesnya tokens seat owns none
    // of the three below bracket 3 and simply never comes up.
    const resourceCandidates = alive()
      .map((seat) => ({ seat, pool: resourcePool(seat, turn, bracket) }))
      .filter((c) => c.pool.length > 0);
    const entry = resourceCandidates.length > 0 ? pick(resourceCandidates, rng) : undefined;
    if (
      entry &&
      rng() <
        hazardChance(resourceHazard, turn, bracket, 1, profileOf(entry.seat).hazardMult.resource)
    ) {
      const caster = entry.seat;
      const pool = entry.pool;
      const total = pool.reduce((n, e) => n + e.weight, 0);
      const roll = rng() * total;
      let acc = 0;
      let chosen = pool[pool.length - 1];
      for (const e of pool) {
        acc += e.weight;
        if (roll < acc) {
          chosen = e;
          break;
        }
      }
      const variant = chosen.variant;
      const card = pickCitation(chosen.list, rng);
      if (card) {
        const seat = seatLabel(caster.id);
        const prompt =
          variant === 'discard'
            ? `${seat} casts ${card.name}. Discard a card of your choice.`
            : variant === 'sacrifice'
              ? `${seat} casts ${card.name}. Sacrifice a creature.`
              : // Pay-or-punish, not a one-shot surcharge: the price is real,
                // and so is what the seat gets when it goes unpaid.
                `${seat} has ${card.name} out. Pay ${card.pay ?? 1} ${
                  card.punish === 'treasure' ? 'when you next draw' : 'for your next spell'
                }, or ${punishPhrase(card.punish, caster.id)}.`;
        events.push(makeEvent('resource', caster.id, prompt, { amount: 1 }, { variant, card }));
        bumpThreat(caster.id, 'resource');
        notes.push(`resource:${caster.id}:${variant}:${card.name}`);
      }
    }
  }

  // Race clock — exempt from the per-window event cap; it is a warning, not a hit.
  const clockHazard = PRESSURE.hazards.clock;
  let clock: ClockState | null = input.clock;
  if (clock && working.find((s) => s.id === clock?.seatId)?.eliminated) {
    // Belt and braces: the store cancels on elimination, but never carry a
    // clock owned by a corpse.
    clock = null;
    notes.push('clock-canceled:dead-owner');
  }
  if (!clock && offCooldown(input, 'clock', clockHazard)) {
    // A clock is what the seat is assembling, not a spell it just cast, so the
    // citation is filtered on the bracket and the seat's colours alone: the mana
    // is the thing it is still finding.
    const minThreat = byBracket(PRESSURE.clock.minThreat, bracket);
    const clockCandidates = alive()
      .filter((seat) => seat.threat >= minThreat)
      .map((seat) => ({
        seat,
        list: CITATIONS.clock.filter(
          (c) => inBracket(c, bracket) && inColors(c, colorsOf(seat)),
        ),
      }))
      .filter((c) => c.list.length > 0);
    const chosen = bestSeat(
      clockCandidates.map((c) => c.seat),
      (s) => s.threat,
    );
    const entry = clockCandidates.find((c) => c.seat.id === chosen?.id);
    if (
      entry &&
      rng() < hazardChance(clockHazard, turn, bracket, 1, profileOf(entry.seat).hazardMult.clock)
    ) {
      const owner = entry.seat;
      const card = pickCitation(entry.list, rng);
      if (card) {
        const deadlineTurn = turn + byBracket(PRESSURE.clock.deadlineOffset, bracket);
        clock = { seatId: owner.id, deadlineTurn, spawnedTurn: turn };
        events.push(
          makeEvent(
            'clock',
            owner.id,
            `${seatLabel(owner.id)} is setting up ${card.name}. They win on their turn after your turn ${deadlineTurn}. Win first, eliminate ${seatLabel(owner.id)}, or declare held interaction.`,
            { deadlineTurn, windows: deadlineTurn - turn },
            { card },
          ),
        );
        bumpThreat(owner.id, 'clock');
        notes.push(`clock:${owner.id}:${deadlineTurn}:${card.name}`);
      }
    }
  }

  // --- 4: counterspell arming ---------------------------------------------
  let counterArmed: CounterArmed | null = null;
  const counterStart = byBracket(PRESSURE.counter.startTurn, bracket);
  if (turn >= counterStart) {
    // Counterspells are blue, so only a seat with blue in it can be holding one
    // up: a Selesnya tokens seat never represents interaction, and a table with
    // no blue seat at it holds up nothing all run. Among those that can, the one
    // with the most open mana is the credible threat.
    const holder = bestSeat(
      alive().filter(
        (seat) =>
          baseEligible(
            CITATIONS.counter,
            seatMana(seat.silhouette, turn, bracket),
            bracket,
            turn,
            colorsOf(seat),
          ).length > 0,
      ),
      (s) => s.silhouette.openMana + s.threat / 10,
    );
    if (holder) {
      const armScale =
        PRESSURE.counter.playerThreatBase + playerThreat * PRESSURE.counter.playerThreatPer;
      const chance = clamp(
        byBracket(PRESSURE.counter.armChance, bracket) *
          armScale *
          profileOf(holder).counterArmMult,
        0,
        0.9,
      );
      if (rng() < chance) {
        counterArmed = { seatId: holder.id, threshold: byBracket(PRESSURE.counter.threshold, bracket) };
        notes.push(`armed:${holder.id}:${counterArmed.threshold}`);
      }
    }
  }

  // --- wipe aftermath: the wrath hits the seats too ------------------------
  if (wiped) {
    for (const seat of working) {
      if (seat.eliminated) continue;
      seat.silhouette = { ...seat.silhouette, creatures: 0, power: 0 };
    }
  }

  const summary = buildSummary(turn, working, events, counterArmed, clock);

  return {
    seats: working.map((s) => ({ id: s.id, threat: s.threat, silhouette: s.silhouette })),
    events,
    clock,
    counterArmed,
    playerThreat,
    summary,
    notes,
    clockExpired: false,
  };
}

function buildSummary(
  turn: number,
  seats: SeatSnapshot[],
  events: PressureEvent[],
  counterArmed: CounterArmed | null,
  clock: ClockState | null,
): string {
  const boards = livingSeats(seats)
    .map((s) => `${s.id} ${s.threat.toFixed(1)}/${s.silhouette.creatures}c ${s.silhouette.power}p`)
    .join(', ');
  const parts = [`Opponent window before turn ${turn}: ${boards || 'no seats left'}`];
  if (events.length > 0) parts.push(events.map((e) => e.type).join(' + '));
  else parts.push('no events');
  if (counterArmed) {
    parts.push(`Seat ${counterArmed.seatId} counters at ${counterArmed.threshold}+ mana`);
  }
  if (clock) parts.push(`clock: Seat ${clock.seatId} by turn ${clock.deadlineTurn}`);
  return parts.join(' · ');
}

/** Convenience for the store: a full `Seat` shrunk to what the engine reads. */
export function toSnapshot(seat: Seat): SeatSnapshot {
  return {
    id: seat.id,
    life: seat.life,
    eliminated: seat.eliminated,
    threat: seat.threat,
    silhouette: seat.silhouette,
    peakThreat: seat.peakThreat,
    peakSilhouette: seat.peakSilhouette,
    profile: seat.profile,
  };
}

/**
 * The prompt shown when an armed seat catches a spell. Built here so the
 * wording lives beside every other prompt. A countered commander goes back to
 * the command zone rather than the graveyard, so it gets its own phrasing.
 */
export function counterPrompt(
  seatId: SeatId,
  cardName: string,
  threshold: number,
  citationName: string,
  isCommander = false,
): string {
  const outcome = isCommander
    ? 'Resolve it to send them back to the command zone. The tax still stands'
    : 'Resolve it to bin the spell';
  return `${seatLabel(seatId)} casts ${citationName} on ${cardName}. They counter anything at ${threshold}+ mana. ${outcome}, or respond if you can force it through.`;
}

/**
 * Build the counter event the store raises when it intercepts a cast — a hand
 * play or a commander coming off the command zone. The citation comes from
 * `chooseCounterCitation`; a seat with nothing that catches this spell never
 * gets here, so `card` is always present on a counter.
 */
export function makeCounterEvent(
  windowIndex: number,
  seatId: SeatId,
  turn: number,
  iid: string,
  cardName: string,
  threshold: number,
  manaValue: number,
  card: EventCitation,
  isCommander = false,
): PressureEvent {
  return {
    id: `w${windowIndex}-counter-${seatId}-${iid}`,
    type: 'counter',
    seatId,
    turn,
    prompt: counterPrompt(seatId, cardName, threshold, card.name, isCommander),
    severity: { turn, threshold, manaValue, commander: isCommander ? 1 : 0 },
    targetIid: iid,
    card,
    state: 'pending',
  };
}
