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
  PodHit,
  PressureEvent,
  Seat,
  SeatId,
  Silhouette,
  StandingHazard,
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
  /**
   * Hate pieces already standing when this window opens. Read-only here: the
   * engine never creates or clears one — a piece the player has not answered yet
   * is still an event, and resolving it is the store's job. All this list does
   * is keep a seat that already holds one from being dealt another.
   */
  hazards: StandingHazard[];
  firedCounts: FiredCounts;
  lastFiredWindow: LastFiredWindow;
}

export interface SeatUpdate {
  id: SeatId;
  threat: number;
  silhouette: Silhouette;
}

/**
 * One seat's turn inside the window, as the player reads it. The window rolls
 * hazard by hazard, but a pod's turns go round the table, so this is the shape
 * the readout and the log payload use: seat A's turn, then B's, then C's.
 *
 * Plain JSON — it goes straight into a log entry, and anything reading a run
 * back has only what is written here.
 */
export interface SeatTurn {
  seatId: SeatId;
  /** This seat's events, in the order the player will answer them. */
  eventTypes: EventType[];
  /**
   * The swing this seat took at another seat. It belongs to the attacker's
   * turn: the seat that attacked the player is never the pod attacker, so no
   * seat's turn ever carries two attacks.
   */
  podHit: { defenderId: SeatId; damage: number } | null;
  /** Threat as the window opened, before this window's growth. */
  threatFrom: number;
  /** Threat after everything this window did, the wrath's aftermath included. */
  threatTo: number;
  creaturesFrom: number;
  creaturesTo: number;
  powerFrom: number;
  powerTo: number;
  /** This is the seat holding up a counterspell after this window. */
  armed: boolean;
  /** This is the seat running the race clock after this window. */
  clockOwner: boolean;
}

export interface WindowResult {
  /** Replacement threat/silhouette for every seat, eliminated ones included. */
  seats: SeatUpdate[];
  /** Events to enqueue, in the order they should be shown: seat order, A to C. */
  events: PressureEvent[];
  /** The window read as seat turns — one per living seat, in seat order. */
  seatTurns: SeatTurn[];
  clock: ClockState | null;
  counterArmed: CounterArmed | null;
  /**
   * Seats that hit each other this window — at most one hit, and never the
   * player. The threat and silhouette changes are already folded into `seats`;
   * what the caller still owes is the defender's life, which the engine does not
   * own. A hit's `damage` is capped at the defender's `life - 1`, so subtracting
   * it can never eliminate a seat: the pod softens, the player kills.
   */
  podHits: PodHit[];
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
  'hate',
];

export function emptySilhouette(): Silhouette {
  return { creatures: 0, power: 0, artifacts: 0, openMana: 1, bonusMana: 0 };
}

export function zeroFiredCounts(): FiredCounts {
  return { wipe: 0, removal: 0, counter: 0, combat: 0, clock: 0, resource: 0, hate: 0 };
}

export function zeroLastFiredWindow(): LastFiredWindow {
  return { wipe: 0, removal: 0, counter: 0, combat: 0, clock: 0, resource: 0, hate: 0 };
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

/** A seat that could cast one hazard, carrying what it would cast. */
interface CasterCandidate<T> {
  seat: SeatSnapshot;
  list: T;
}

/**
 * The living seats that hold a card for this hazard, in seat order. `cards`
 * returns what the seat would cast, or null when it holds nothing.
 *
 * Candidates come before the preference everywhere they are used: filtering
 * afterwards would let the preferred seat swallow a hazard it owns no card for
 * and drop the whole step, which is how the least scary seat ends up silently
 * eating the pod's wrath because it happens to be mono-red.
 */
function casterCandidates<T>(
  seats: SeatSnapshot[],
  cards: (seat: SeatSnapshot) => T | null,
): CasterCandidate<T>[] {
  const out: CasterCandidate<T>[] = [];
  for (const seat of seats) {
    const list = cards(seat);
    if (list !== null) out.push({ seat, list });
  }
  return out;
}

/** The candidate `bestSeat` prefers, with its cards still attached. */
function preferredCaster<T>(
  candidates: CasterCandidate<T>[],
  score: (seat: SeatSnapshot) => number,
): CasterCandidate<T> | undefined {
  const chosen = bestSeat(
    candidates.map((c) => c.seat),
    score,
  );
  return candidates.find((c) => c.seat.id === chosen?.id);
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

/**
 * Chance the pod holds up a counterspell for the coming turn.
 *
 * Built the same way round as `hazardChance`, and for the same reason. The
 * player-threat scale is the pod answering *you*, so it sits under
 * `PRESSURE.counter.max` — that ceiling is a statement about how much
 * interaction a pod ever represents. `profileMult` is *whose seat* is holding
 * it up, so it scales the capped value instead: applied before the cap, a
 * control seat (1.5x) at bracket 5 against a scary player was pinned to the
 * same 0.9 as an unmodified seat, which is the archetype vanishing exactly
 * where holding up a counter is the whole point of it. See the long note on
 * `hazardChance` for the full argument.
 */
export function counterArmChance(
  bracket: number,
  playerThreat: number,
  profileMult = 1,
): number {
  const armScale =
    PRESSURE.counter.playerThreatBase + playerThreat * PRESSURE.counter.playerThreatPer;
  const capped = clamp(
    byBracket(PRESSURE.counter.armChance, bracket) * armScale,
    0,
    PRESSURE.counter.max,
  );
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
 *   3. hazard rolls in the order wipe, removal, combat, pod combat, resource,
 *      hate, then the clock (plus any sub-rolls a firing event needs, drawn
 *      immediately after its own roll, ending with the one draw that picks its
 *      card citation — no draw at all when nothing is eligible, because then
 *      nothing fires). Casters are chosen before the roll, because the roll is
 *      scaled by the caster's profile; only the resource attack's caster costs a
 *      draw, and it is taken immediately *before* that hazard's roll rather than
 *      after it. Pod combat is the odd one: it is a single roll that creates no
 *      event and cites no card, because the player is not being asked anything.
 *      That roll is drawn whenever there is an attacker and a defender, even in
 *      the windows where the hit is then withheld for being lethal — the draw is
 *      what has to stay fixed, not the outcome.
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
 * attack's caster draw ahead of its own hazard roll; versions 5 and 6 change no
 * draw order at all, only where a profile multiplier meets a cap — the hazards
 * in 5, the arming roll in 6 — which is enough to change the outcome of rolls
 * near that cap. Version 7 inserts two sites into the list above, so nothing
 * seeded before it replays.
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
      // Nobody took a turn: the run ended on the deadline, and nothing below the
      // short-circuit was computed.
      seatTurns: [],
      clock: input.clock,
      counterArmed: null,
      podHits: [],
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

  function bumpThreatBy(seatId: SeatId, amount: number): void {
    const seat = working.find((s) => s.id === seatId);
    if (seat) seat.threat = clampThreat(seat.threat + amount);
  }

  function bumpThreat(seatId: SeatId, type: EventType): void {
    bumpThreatBy(seatId, PRESSURE.threat.eventJump[type]);
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
    // it.
    const wipeCandidates = casterCandidates(alive(), (seat) => {
      const wipes = partitionWipes(
        seatMana(seat.silhouette, turn, bracket),
        bracket,
        turn,
        colorsOf(seat),
      );
      return wipes.creatures.length > 0 || wipes.wide.length > 0 ? wipes : null;
    });
    const entry = preferredCaster(wipeCandidates, (s) => -s.silhouette.power);
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
      const list = nonlands && entry.list.wide.length > 0 ? entry.list.wide : entry.list.creatures;
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
    const removalCandidates = casterCandidates(alive(), (seat) => {
      const list = eligibleRemoval(
        seatMana(seat.silhouette, turn, bracket),
        bracket,
        turn,
        target,
        colorsOf(seat),
      );
      return list.length > 0 ? list : null;
    });
    const entry = preferredCaster(removalCandidates, (s) => s.threat);
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
  let attackedPlayer: SeatId | null = null;
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
    attackedPlayer = attacker.id;
    notes.push(`combat:${attacker.id}:${damage}`);
  }

  // Pod combat — the seats swing at each other. No event: the player is not
  // being asked anything, so there is nothing to answer and nothing to resolve.
  // It is the reason a seat's threat can fall without the player spending a
  // card, and the reason the pod is a pod rather than three parallel timers.
  //
  // The seat that just attacked the player is out of the running — it turned its
  // creatures sideways once already this window — so the attacker here is the
  // *second* board at the table, swinging at whoever is scariest. That is the
  // same instinct the player has, and it means the pod polices its own leader.
  //
  // Gated on `wiped` for the same reason the swing at the player is: the wrath
  // in this window takes every seat's creatures with it, so a seat hitting its
  // neighbour with them would be attacking out of a graveyard.
  //
  // A pod hit never kills: see the `defender.life` cap below.
  const podHits: PodHit[] = [];
  const pod = PRESSURE.podCombat;
  if (!wiped && turn >= byBracket(pod.startTurn, bracket)) {
    const podAttacker = bestSeat(
      alive().filter((s) => s.id !== attackedPlayer && s.silhouette.power >= pod.minPower),
      (s) => s.silhouette.power,
    );
    const defender = podAttacker
      ? bestSeat(
          alive().filter((s) => s.id !== podAttacker.id),
          (s) => s.threat,
        )
      : undefined;
    if (
      podAttacker &&
      defender &&
      rng() <
        clamp(
          byBracket(pod.chance, bracket) * profileOf(podAttacker).hazardMult.combat,
          0,
          PRESSURE.profileCeiling,
        )
    ) {
      // The pod softens a seat up; it never finishes one. A seat already at 1
      // life is left alone entirely this window, and every other hit is capped
      // at `life - 1`. The reason is that the kill is the player's: a pod that
      // eliminates seats hands the player wins they did not play for, and the
      // whole point of the threat meters is that clearing the table is work.
      //
      // The check sits *after* the roll on purpose. Withholding the hit costs
      // no draw, so the fixed order documented above keeps its shape and a seed
      // still replays; skipping ahead of the roll would shift every later draw
      // in the window depending on a life total.
      if (defender.life > 1) {
        // Same plausible cap and the same severity multiplier as the swing at
        // the player, so a seat cannot hit its neighbour harder than it could
        // hit you — then the never-kill cap on top of that.
        const c = PRESSURE.combat;
        const damage = Math.min(
          Math.max(
            1,
            Math.round(
              Math.min(
                podAttacker.silhouette.power * pod.powerShare,
                Math.min(c.damageBase + c.damagePerTurn * turn, c.damageHardCap),
              ) * severityMult,
            ),
          ),
          defender.life - 1,
        );
        const hit = applyDamageToSeat(
          defender.threat,
          defender.silhouette,
          damage,
          defender.life,
        );
        defender.threat = hit.threat;
        defender.silhouette = hit.silhouette;
        // Life is the store's: the engine has no business deciding who died —
        // and after the cap above, nobody did.
        bumpThreatBy(podAttacker.id, PRESSURE.threat.podHitJump);
        podHits.push({ attackerId: podAttacker.id, defenderId: defender.id, damage });
        notes.push(`pod:${podAttacker.id}>${defender.id}:${damage}`);
      }
    }
  }

  // Resource attack — discard, sacrifice, or a tax.
  const resourceHazard = PRESSURE.hazards.resource;
  if (roomLeft() && offCooldown(input, 'resource', resourceHazard)) {
    // Which seat strips you is the one caster choice with no preference behind
    // it, so it stays a seeded pick — but only over seats that own a strip, an
    // edict or a tax piece in their colours. A Selesnya tokens seat owns none
    // of the three below bracket 3 and simply never comes up.
    const resourceCandidates = casterCandidates(alive(), (seat) => {
      const pool = resourcePool(seat, turn, bracket);
      return pool.length > 0 ? pool : null;
    });
    const entry = pick(resourceCandidates, rng);
    if (
      entry &&
      rng() <
        hazardChance(resourceHazard, turn, bracket, 1, profileOf(entry.seat).hazardMult.resource)
    ) {
      const caster = entry.seat;
      const pool = entry.list;
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

  // Hate piece — the one hazard that does not finish when the window does. The
  // engine stops at the event: the player may still answer it, and only the
  // store knows whether they did, so `StandingHazard` is made there. What the
  // engine reads back is `input.hazards`, which keeps a seat that is already
  // holding a piece from being dealt a second one.
  const hateHazard = PRESSURE.hazards.hate;
  if (roomLeft() && offCooldown(input, 'hate', hateHazard)) {
    const standingPerSeat = new Map<SeatId, number>();
    for (const hazard of input.hazards) {
      standingPerSeat.set(hazard.seatId, (standingPerSeat.get(hazard.seatId) ?? 0) + 1);
    }
    const hateCandidates = casterCandidates(alive(), (seat) => {
      if ((standingPerSeat.get(seat.id) ?? 0) >= PRESSURE.hate.maxStandingPerSeat) return null;
      const list = baseEligible(
        CITATIONS.hate,
        seatMana(seat.silhouette, turn, bracket),
        bracket,
        turn,
        colorsOf(seat),
      );
      return list.length > 0 ? list : null;
    });
    const entry = preferredCaster(hateCandidates, (s) => s.threat);
    if (
      entry &&
      rng() < hazardChance(hateHazard, turn, bracket, 1, profileOf(entry.seat).hazardMult.hate)
    ) {
      const caster = entry.seat;
      const card = pickCitation(entry.list, rng);
      if (card) {
        events.push(
          makeEvent(
            'hate',
            caster.id,
            [`${seatLabel(caster.id)} casts ${card.name}.`, card.tell, 'Respond or it stands.']
              .filter(Boolean)
              .join(' '),
            {},
            { card },
          ),
        );
        bumpThreat(caster.id, 'hate');
        notes.push(`hate:${caster.id}:${card.name}`);
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
    const clockCandidates = casterCandidates(alive(), (seat) => {
      if (seat.threat < minThreat) return null;
      const list = CITATIONS.clock.filter(
        (c) => inBracket(c, bracket) && inColors(c, colorsOf(seat)),
      );
      return list.length > 0 ? list : null;
    });
    const entry = preferredCaster(clockCandidates, (s) => s.threat);
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
      const chance = counterArmChance(bracket, playerThreat, profileOf(holder).counterArmMult);
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

  // --- the window, read back as seat turns ---------------------------------
  //
  // The hazards roll in hazard order and always will. The pod's turns go round
  // the table, so that is the order the player answers them in: everything seat
  // A did, then B, then C.
  //
  // This runs after the last rng draw of the window, and it has to: the draw
  // order is the whole of what makes a seed replay, so how a window *reads* may
  // never feed back into how it rolled. Nothing below this line touches `rng`.
  const seatIndex = new Map(working.map((s, i) => [s.id, i]));
  events.sort((a, b) => {
    const bySeat = (seatIndex.get(a.seatId) ?? 0) - (seatIndex.get(b.seatId) ?? 0);
    return bySeat !== 0 ? bySeat : eventTurnOrder(a.type) - eventTurnOrder(b.type);
  });

  const seatTurns = buildSeatTurns(input.seats, working, events, podHits, counterArmed, clock);
  const summary = buildSummary(turn, seatTurns, events, target?.name, counterArmed, clock);

  return {
    seats: working.map((s) => ({ id: s.id, threat: s.threat, silhouette: s.silhouette })),
    events,
    seatTurns,
    clock,
    counterArmed,
    podHits,
    playerThreat,
    summary,
    notes,
    clockExpired: false,
  };
}

/**
 * The order one seat's own events read in: what it cast first, the attack after,
 * and the clock last, because a clock is something the seat is setting up rather
 * than something it did to you this window. A counter is not in the list — the
 * store raises those on the player's cast, outside any window — so it sorts to
 * the end rather than to the front if one ever arrives here.
 */
const SEAT_TURN_EVENT_ORDER: EventType[] = [
  'wipe',
  'removal',
  'hate',
  'resource',
  'combat',
  'clock',
];

function eventTurnOrder(type: EventType): number {
  const at = SEAT_TURN_EVENT_ORDER.indexOf(type);
  return at === -1 ? SEAT_TURN_EVENT_ORDER.length : at;
}

/**
 * One entry per living seat, in seat order, whether or not the seat did
 * anything: a seat that only grew still took a turn, and the readout says so.
 * `events` must already be sorted, because each seat's `eventTypes` is the order
 * the player will actually be asked in.
 */
function buildSeatTurns(
  before: SeatSnapshot[],
  after: SeatSnapshot[],
  events: PressureEvent[],
  podHits: PodHit[],
  counterArmed: CounterArmed | null,
  clock: ClockState | null,
): SeatTurn[] {
  return livingSeats(after).map((seat) => {
    const opening = before.find((s) => s.id === seat.id) ?? seat;
    const hit = podHits.find((h) => h.attackerId === seat.id);
    return {
      seatId: seat.id,
      eventTypes: events.filter((e) => e.seatId === seat.id).map((e) => e.type),
      podHit: hit ? { defenderId: hit.defenderId, damage: hit.damage } : null,
      threatFrom: opening.threat,
      threatTo: seat.threat,
      creaturesFrom: opening.silhouette.creatures,
      creaturesTo: seat.silhouette.creatures,
      powerFrom: opening.silhouette.power,
      powerTo: seat.silhouette.power,
      armed: counterArmed?.seatId === seat.id,
      clockOwner: clock?.seatId === seat.id,
    };
  });
}

/**
 * What one seat did, in the voice the table would use. The card is the fact
 * worth carrying: "casts Toxic Deluge" tells a reader more than "wipe" does, and
 * the machine-readable version of the same window is in `notes` and `seatTurns`.
 */
function eventPhrase(event: PressureEvent, removalTarget: string | undefined): string {
  const name = event.card?.name ?? event.type;
  switch (event.type) {
    case 'combat':
      return `attacks for ${event.severity.damage}`;
    case 'clock':
      return `sets up ${name} (win after turn ${event.severity.deadlineTurn})`;
    case 'removal':
      return removalTarget ? `casts ${name} on ${removalTarget}` : `casts ${name}`;
    // A tax is already on the table by the time it costs anything, so a seat
    // does not "cast" it at you.
    case 'resource':
      return event.variant === 'tax' ? `taxes with ${name}` : `casts ${name}`;
    default:
      return `casts ${name}`;
  }
}

/** A seat that asked nothing of the player: it either grew, or it did not. */
function idlePhrase(seatTurn: SeatTurn): string {
  if (
    seatTurn.threatTo === seatTurn.threatFrom &&
    seatTurn.creaturesTo === seatTurn.creaturesFrom &&
    seatTurn.powerTo === seatTurn.powerFrom
  ) {
    return 'passes';
  }
  return (
    `builds (${seatTurn.threatFrom.toFixed(1)}→${seatTurn.threatTo.toFixed(1)}, ` +
    `${seatTurn.creaturesTo}c/${seatTurn.powerTo}p)`
  );
}

/**
 * The window as one line of table-talk: the turn it precedes, then each living
 * seat's turn in order, then what the pod is still representing. Segments are
 * joined with ` · `, which is what the run log splits on to print the cycle a
 * turn per line.
 */
function buildSummary(
  turn: number,
  seatTurns: SeatTurn[],
  events: PressureEvent[],
  removalTarget: string | undefined,
  counterArmed: CounterArmed | null,
  clock: ClockState | null,
): string {
  const parts = [`Before turn ${turn}`];
  if (seatTurns.length === 0) parts.push('no seats left');

  for (const seatTurn of seatTurns) {
    const did = events
      .filter((e) => e.seatId === seatTurn.seatId)
      .map((e) => eventPhrase(e, removalTarget));
    if (seatTurn.podHit) {
      did.push(`hits ${seatTurn.podHit.defenderId} for ${seatTurn.podHit.damage}`);
    }
    if (did.length === 0) did.push(idlePhrase(seatTurn));
    parts.push(`${seatTurn.seatId}: ${did.join(', ')}`);
  }

  if (counterArmed) {
    parts.push(`${counterArmed.seatId} holds up counters at ${counterArmed.threshold}+`);
  }
  // Only for a clock that was already ticking. A clock that spawned this window
  // is in its owner's turn above, with the same deadline on it, and printing it
  // twice reads as two clocks.
  if (clock && !events.some((e) => e.type === 'clock')) {
    parts.push(`clock: ${clock.seatId} by turn ${clock.deadlineTurn}`);
  }
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
