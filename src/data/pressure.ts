import type { EventType } from '../domain/types';

/**
 * Every number the pressure engine reads lives here, so tuning is one file and
 * the type checker guards the shape. Values were fitted by Monte-Carlo probe
 * against the bracket-3 design anchors (see the M1 report):
 *
 *   - a board wipe lands by turn 7 in ~65–75% of runs, and is rare before turn 4
 *   - targeted removal answers the player's commander 1–2 times per run
 *   - a race clock spawns from turn ~7 with a 3-turn deadline
 *   - resource attacks land ~1–2 times per run
 *
 * Bracket tables are indexed by `bracket - 1`, i.e. `[b1, b2, b3, b4, b5]`.
 */

/** A per-window probability curve for one event type. */
export interface Hazard {
  /** No roll happens for a window entering a turn below this. */
  startTurn: number;
  /** Probability at `startTurn`. */
  base: number;
  /** Added to the probability for each turn past `startTurn`. */
  perTurn: number;
  /** Ceiling applied after the per-turn ramp and every multiplier. */
  max: number;
  /** Hard limit on firings per run. */
  cap: number;
  /** Windows that must elapse after a firing before this type can fire again. */
  cooldown: number;
}

export type BracketTable = readonly [number, number, number, number, number];

/** Clamp a bracket (1–5) to a zero-based index into a `BracketTable`. */
export function bracketIndex(bracket: number): number {
  if (!Number.isFinite(bracket)) return 2;
  return Math.min(5, Math.max(1, Math.round(bracket))) - 1;
}

/** Read a bracket-indexed table. */
export function byBracket(table: BracketTable, bracket: number): number {
  return table[bracketIndex(bracket)];
}

export const PRESSURE = {
  /** Bumped whenever the numbers below change, so logged runs stay comparable. */
  version: 1,

  bracket: {
    /** Multiplies every hazard probability. */
    frequency: [0.5, 0.72, 1, 1.3, 1.6] as BracketTable,
    /** Multiplies damage and other magnitudes. */
    severity: [0.6, 0.8, 1, 1.2, 1.45] as BracketTable,
    /** Threat gained per opponent window, before jitter. */
    threatGrowth: [0.2, 0.28, 0.36, 0.46, 0.58] as BracketTable,
    /** Cap on events created in a single window (the race clock is exempt). */
    maxEventsPerWindow: [1, 2, 2, 3, 3] as BracketTable,
  },

  hazards: {
    wipe: { startTurn: 3, base: 0.03, perTurn: 0.093, max: 0.5, cap: 3, cooldown: 3 },
    removal: { startTurn: 2, base: 0.04, perTurn: 0.018, max: 0.26, cap: 5, cooldown: 1 },
    combat: { startTurn: 4, base: 0.45, perTurn: 0.06, max: 0.85, cap: 99, cooldown: 0 },
    resource: { startTurn: 2, base: 0.065, perTurn: 0.016, max: 0.25, cap: 3, cooldown: 2 },
    clock: { startTurn: 7, base: 0.1, perTurn: 0.07, max: 0.6, cap: 4, cooldown: 0 },
  } satisfies Record<Exclude<EventType, 'counter'>, Hazard>,

  wipe: {
    /** The pod never wraths an empty board. */
    minPodCreatures: 3,
    /** Chance the wipe sweeps all nonlands rather than only creatures. */
    nonlandChance: [0.05, 0.1, 0.15, 0.22, 0.3] as BracketTable,
  },

  removal: {
    /** Probability multiplier = base + player threat x per. Threat 5 ≈ 1.0x. */
    playerThreatBase: 0.55,
    playerThreatPer: 0.09,
  },

  counter: {
    /** First turn a seat may be armed. */
    startTurn: [5, 4, 3, 2, 2] as BracketTable,
    /** Chance a seat is armed for the coming turn, before the player-threat scale. */
    armChance: [0.12, 0.18, 0.25, 0.35, 0.45] as BracketTable,
    /** Mana value at or above which an armed seat counters. */
    threshold: [6, 5, 4, 4, 3] as BracketTable,
    playerThreatBase: 0.6,
    playerThreatPer: 0.08,
  },

  combat: {
    /** Fraction of the attacking seat's silhouette power that swings at you. */
    powerShare: 1,
    /** Plausible-damage cap: `base + perTurn x turn`, then the severity multiplier. */
    damageBase: 2,
    damagePerTurn: 1.4,
    damageHardCap: 30,
    /** Below this much power the seat holds back rather than attacking. */
    minPower: 2,
  },

  clock: {
    /** Deadline = spawn turn + this. */
    deadlineOffset: [5, 4, 3, 2, 2] as BracketTable,
    /** A seat needs at least this much threat to start a clock. */
    minThreat: 4,
  },

  resource: {
    /** Relative weights for the sub-kind roll: discard, sacrifice, tax. */
    weights: { discard: 0.45, sacrifice: 0.35, tax: 0.2 },
  },

  threat: {
    min: 0,
    max: 10,
    /** Opening threat is drawn uniformly from this range. */
    startMin: 1,
    startMax: 2,
    /** Per-window growth is multiplied by `jitterMin + rng() x jitterSpan`. */
    jitterMin: 0.6,
    jitterSpan: 0.8,
    /** A seat's threat jumps by this much when it emits that event. */
    eventJump: {
      wipe: 1.5,
      removal: 0.8,
      counter: 0.6,
      combat: 0.5,
      clock: 1.2,
      resource: 0.6,
    } satisfies Record<EventType, number>,
    /** Damage a seat must take to shed one point of threat. */
    damagePerPoint: 8,
    /** Share of an eliminated seat's threat inherited by the survivors. */
    eliminationInheritShare: 0.6,
  },

  silhouette: {
    /** Power added per window ≈ threat x this. */
    powerPerThreat: 0.5,
    /** Creatures added per window ≈ threat x this (stochastically rounded). */
    creaturesPerThreat: 0.16,
    /** Chance per window of an extra artifact/enchantment ≈ threat x this. */
    artifactsPerThreat: 0.045,
    /** `openMana = min(turn, this)`. */
    maxOpenMana: 8,
    /** Upper bound on the fraction of a board that damage can shave off. */
    damageShrinkCap: 0.6,
    /** Share of a dead seat's board the survivors absorb. */
    eliminationInheritShare: 0.4,
  },

  playerThreat: {
    /** Floor so an empty board is not literally zero pressure. */
    base: 0.5,
    /** Threat per point of mana value on the player's nonland board. */
    perBoardMv: 0.25,
    boardMvCap: 4,
    /** Threat per point of damage the player dealt over `recentTurns`. */
    perDamage: 1 / 6,
    damageCap: 3,
    /** Flat bonus while the commander is on the battlefield. */
    commanderBonus: 2.5,
    /** How far back `damageDealtRecent` looks. */
    recentTurns: 3,
  },
} as const;

export type PressureConfig = typeof PRESSURE;
