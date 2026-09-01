import { PRESSURE, byBracket, type Hazard } from '../data/pressure';
import type {
  ClockState,
  CounterArmed,
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
}

/** One of the player's permanents, flattened for the targeting heuristic. */
export interface PermanentSummary {
  iid: string;
  name: string;
  manaValue: number;
  isCommander: boolean;
  isToken: boolean;
  isLand: boolean;
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
  return { creatures: 0, power: 0, artifacts: 0, openMana: 1 };
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

/** Probability for one hazard this window, before the caller's own gates. */
export function hazardChance(
  hazard: Hazard,
  turn: number,
  bracket: number,
  scale = 1,
): number {
  if (turn < hazard.startTurn) return 0;
  const ramp = hazard.base + hazard.perTurn * (turn - hazard.startTurn);
  const scaled = ramp * byBracket(PRESSURE.bracket.frequency, bracket) * scale;
  return clamp(scaled, 0, hazard.max);
}

function offCooldown(input: WindowInput, type: EventType, hazard: Hazard): boolean {
  if (input.firedCounts[type] >= hazard.cap) return false;
  const last = input.lastFiredWindow[type];
  if (last === 0) return true;
  return input.windowIndex - last > hazard.cooldown;
}

// ---------------------------------------------------------------------------
// Targeting
// ---------------------------------------------------------------------------

/**
 * What the pod's removal points at: the commander if it is on the battlefield,
 * otherwise the biggest real permanent, otherwise whatever arrived last.
 * Returns undefined when the player controls nothing worth answering.
 */
export function chooseRemovalTarget(
  permanents: PermanentSummary[],
): PermanentSummary | undefined {
  const commander = permanents.find((p) => p.isCommander);
  if (commander) return commander;

  const real = permanents.filter((p) => !p.isLand && !p.isToken);
  if (real.length > 0) {
    let best = real[0];
    for (const p of real) {
      if (p.manaValue > best.manaValue || (p.manaValue === best.manaValue && p.movedAt > best.movedAt)) {
        best = p;
      }
    }
    return best;
  }

  const nonlands = permanents.filter((p) => !p.isLand);
  const pool = nonlands.length > 0 ? nonlands : permanents;
  if (pool.length === 0) return undefined;
  return pool.reduce((a, b) => (b.movedAt > a.movedAt ? b : a));
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
  return {
    creatures: s.creatures + stochasticRound(seat.threat * c.creaturesPerThreat, rng),
    power: s.power + stochasticRound(seat.threat * c.powerPerThreat, rng),
    artifacts: s.artifacts + stochasticRound(seat.threat * c.artifactsPerThreat, rng),
    openMana: Math.min(turn, c.maxOpenMana),
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
    },
  };
}

/**
 * An eliminated seat's presence flows to the survivors rather than evaporating:
 * the pod stays as dangerous, it is just concentrated in fewer hands. Event
 * *frequency* is already seat-independent, so this only moves threat and board.
 * Returns updates for the survivors only.
 */
export function redistribute(seats: SeatSnapshot[], deadSeatId: SeatId): SeatUpdate[] {
  const dead = seats.find((s) => s.id === deadSeatId);
  const survivors = seats.filter((s) => s.id !== deadSeatId && !s.eliminated);
  if (!dead || survivors.length === 0) return [];

  const threatEach = (dead.threat * PRESSURE.threat.eliminationInheritShare) / survivors.length;
  const share = PRESSURE.silhouette.eliminationInheritShare / survivors.length;

  return survivors.map((s) => ({
    id: s.id,
    threat: clampThreat(s.threat + threatEach),
    silhouette: {
      creatures: s.silhouette.creatures + Math.round(dead.silhouette.creatures * share),
      power: s.silhouette.power + Math.round(dead.silhouette.power * share),
      artifacts: s.silhouette.artifacts + Math.round(dead.silhouette.artifacts * share),
      openMana: s.silhouette.openMana,
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

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/**
 * Resolve one opponent window.
 *
 * The rng is consumed in a fixed order so a seed replays exactly:
 *   1. threat jitter, one draw per living seat
 *   2. silhouette growth, three draws per living seat
 *   3. hazard rolls in the order wipe, removal, combat, resource, then the
 *      clock (plus any sub-rolls a firing event needs, drawn immediately after
 *      its own roll)
 *   4. the counterspell arming roll
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
      summary: `${seatLabel(input.clock.seatId)} wins — the clock ran out after turn ${input.clock.deadlineTurn}.`,
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
  const perWindow = byBracket(PRESSURE.bracket.threatGrowth, bracket);

  const working: SeatSnapshot[] = input.seats.map((seat) => {
    if (seat.eliminated) return { ...seat, silhouette: { ...seat.silhouette } };
    const threat = clampThreat(seat.threat + perWindow * (growthJitter + rng() * growthSpan));
    const grown = { ...seat, threat };
    return { ...grown, silhouette: grownSilhouette(grown, turn, rng) };
  });

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
    extra: { variant?: string; targetIid?: string } = {},
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
    offCooldown(input, 'wipe', wipeHazard) &&
    rng() < hazardChance(wipeHazard, turn, bracket)
  ) {
    // The seat with the least to lose is the one holding the wrath.
    const caster = bestSeat(alive(), (s) => -s.silhouette.power);
    if (caster) {
      const nonlands = rng() < byBracket(PRESSURE.wipe.nonlandChance, bracket);
      const variant = nonlands ? 'nonlands' : 'creatures';
      const scope = nonlands ? 'every nonland permanent' : 'every creature';
      events.push(
        makeEvent(
          'wipe',
          caster.id,
          `${seatLabel(caster.id)} wraths the table — ${scope} is destroyed. Resolve it, then drag back anything you actually protected.`,
          { podCreatures, podPower: alive().reduce((n, s) => n + s.silhouette.power, 0) },
          { variant },
        ),
      );
      bumpThreat(caster.id, 'wipe');
      wiped = true;
      notes.push(`wipe:${caster.id}:${variant}`);
    }
  }

  // Targeted removal — scales with how scary the player looks.
  const removalHazard = PRESSURE.hazards.removal;
  const removalScale =
    PRESSURE.removal.playerThreatBase + playerThreat * PRESSURE.removal.playerThreatPer;
  const target = chooseRemovalTarget(input.permanents);
  if (
    roomLeft() &&
    target &&
    offCooldown(input, 'removal', removalHazard) &&
    rng() < hazardChance(removalHazard, turn, bracket, removalScale)
  ) {
    const caster = bestSeat(alive(), (s) => s.threat);
    if (caster) {
      const why = target.isCommander
        ? 'their best answer meets your commander'
        : 'their best answer meets your biggest threat';
      events.push(
        makeEvent(
          'removal',
          caster.id,
          `${seatLabel(caster.id)} destroys ${target.name} (${why}).`,
          { targetMv: target.manaValue, playerThreat, commander: target.isCommander ? 1 : 0 },
          { targetIid: target.iid },
        ),
      );
      bumpThreat(caster.id, 'removal');
      notes.push(`removal:${caster.id}:${target.isCommander ? 'commander' : 'permanent'}`);
    }
  }

  // Combat — the highest-threat seat turns its silhouette sideways.
  const combatHazard = PRESSURE.hazards.combat;
  const attacker = highestThreatSeat(working);
  if (
    roomLeft() &&
    !wiped &&
    attacker &&
    attacker.silhouette.power >= PRESSURE.combat.minPower &&
    rng() < hazardChance(combatHazard, turn, bracket)
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
        : 'You have nothing back — block, answer, or take it.';
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
  if (
    roomLeft() &&
    offCooldown(input, 'resource', resourceHazard) &&
    rng() < hazardChance(resourceHazard, turn, bracket)
  ) {
    const caster = pick(alive(), rng);
    if (caster) {
      const roll = rng();
      const w = PRESSURE.resource.weights;
      const variant =
        roll < w.discard ? 'discard' : roll < w.discard + w.sacrifice ? 'sacrifice' : 'tax';
      const prompt =
        variant === 'discard'
          ? `${seatLabel(caster.id)} strips your hand — discard a card of your choice.`
          : variant === 'sacrifice'
            ? `${seatLabel(caster.id)} makes you sacrifice a permanent — pick one and put it in the graveyard.`
            : `${seatLabel(caster.id)} taxes the table: your next spell this turn costs 2 more, or it does not happen.`;
      events.push(makeEvent('resource', caster.id, prompt, { amount: 1 }, { variant }));
      bumpThreat(caster.id, 'resource');
      notes.push(`resource:${caster.id}:${variant}`);
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
  if (!clock) {
    const owner = highestThreatSeat(working);
    if (
      owner &&
      owner.threat >= PRESSURE.clock.minThreat &&
      offCooldown(input, 'clock', clockHazard) &&
      rng() < hazardChance(clockHazard, turn, bracket)
    ) {
      const deadlineTurn = turn + byBracket(PRESSURE.clock.deadlineOffset, bracket);
      clock = { seatId: owner.id, deadlineTurn, spawnedTurn: turn };
      events.push(
        makeEvent(
          'clock',
          owner.id,
          `${seatLabel(owner.id)} will win on their turn after your turn ${deadlineTurn} — win first, eliminate ${seatLabel(owner.id)}, or declare held interaction.`,
          { deadlineTurn, windows: deadlineTurn - turn },
        ),
      );
      bumpThreat(owner.id, 'clock');
      notes.push(`clock:${owner.id}:${deadlineTurn}`);
    }
  }

  // --- 4: counterspell arming ---------------------------------------------
  let counterArmed: CounterArmed | null = null;
  const counterStart = byBracket(PRESSURE.counter.startTurn, bracket);
  if (turn >= counterStart) {
    const armScale =
      PRESSURE.counter.playerThreatBase + playerThreat * PRESSURE.counter.playerThreatPer;
    const chance = clamp(
      byBracket(PRESSURE.counter.armChance, bracket) *
        byBracket(PRESSURE.bracket.frequency, bracket) *
        armScale,
      0,
      0.9,
    );
    if (rng() < chance) {
      // The seat with the most open mana is the credible threat to hold up.
      const holder = bestSeat(alive(), (s) => s.silhouette.openMana + s.threat / 10);
      if (holder) {
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
  const parts = [`Opponent window before turn ${turn} — ${boards || 'no seats left'}`];
  if (events.length > 0) parts.push(events.map((e) => e.type).join(' + '));
  else parts.push('no events');
  if (counterArmed) parts.push(`Seat ${counterArmed.seatId} holding up ${counterArmed.threshold}+`);
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
  isCommander = false,
): string {
  const outcome = isCommander
    ? 'Resolve it to send them back to the command zone — the tax still stands'
    : 'Resolve it to bin the spell';
  return `${seatLabel(seatId)} counters ${cardName} — they held up ${threshold}+ mana all turn. ${outcome}, or respond if you can force it through.`;
}

/**
 * Build the counter event the store raises when it intercepts a cast — a hand
 * play or a commander coming off the command zone.
 */
export function makeCounterEvent(
  windowIndex: number,
  seatId: SeatId,
  turn: number,
  iid: string,
  cardName: string,
  threshold: number,
  manaValue: number,
  isCommander = false,
): PressureEvent {
  return {
    id: `w${windowIndex}-counter-${seatId}-${iid}`,
    type: 'counter',
    seatId,
    turn,
    prompt: counterPrompt(seatId, cardName, threshold, isCommander),
    severity: { turn, threshold, manaValue, commander: isCommander ? 1 : 0 },
    targetIid: iid,
    state: 'pending',
  };
}
