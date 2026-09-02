import type { EventType } from '../domain/types';

/**
 * Every number the pressure engine reads lives here, so tuning is one file and
 * the type checker guards the shape.
 *
 * ## The tuning story (version 2)
 *
 * Version 1 gave every hazard a single start turn and scaled the whole curve by
 * one per-bracket `frequency` multiplier. That made brackets differ only in *how
 * often* the pod acted, never in *when* — a cEDH pod threatened to win on turn 9
 * and a precon pod on turn 10.7, which reads as noise rather than as a bracket.
 * Version 2 deletes the global multiplier and makes every hazard dial a bracket
 * table, so the schedule itself moves: a bracket-5 clock starts on turn 4 and a
 * bracket-1 clock on turn 11.
 *
 * The shape each bracket is tuned to:
 *
 *   1 exhibition — almost nothing happens on schedule. Wraths arrive late if at
 *     all, the pod rarely holds up mana, and the "we win next turn" clock only
 *     appears in the last couple of turns, in about 40% of runs.
 *   2 core/precon — the same game one gear up: a wrath around turn 7, a clock
 *     from turn 9, occasional interaction.
 *   3 upgraded — the reference bracket the M1 report was fitted to. Wipe by
 *     turn 7 in ~68% of runs, commander answered 1–2 times, clock from turn 7
 *     with a 3-turn deadline. Every anchor in that report still holds here.
 *   4 optimized — the peak of fair pressure. The most wraths, hardest combat,
 *     removal on a one-window cooldown, a clock from turn 5 with a 2-turn
 *     deadline. This is the bracket that hurts the most on the board.
 *   5 cEDH — deliberately *not* "bracket 4 but more". A cEDH pod wraths and
 *     attacks less than an optimized casual pod (its wrath curve decays after
 *     the early turns, hence the negative `perTurn`); it interacts instead —
 *     the most removal, the most counter-armed windows, and a clock from turn 4
 *     because the win is a combo, not an army.
 *
 * Bracket tables are indexed by `bracket - 1`, i.e. `[b1, b2, b3, b4, b5]`.
 * Values were fitted with `npm run probe:pressure 1000`, which carries the
 * target for every metric and fails non-zero when one drifts out of band.
 */

/**
 * A per-window probability curve for one event type. Every field is a bracket
 * table: the bracket changes when a hazard turns on, how steeply it ramps, and
 * how many times it may fire — not just a single frequency dial.
 */
export interface Hazard {
  /** No roll fires for a window entering a turn below this. */
  startTurn: BracketTable;
  /** Probability at `startTurn`. */
  base: BracketTable;
  /** Added to the probability for each turn past `startTurn`. May be negative
   *  for a hazard whose bracket loses interest as the game speeds up. */
  perTurn: BracketTable;
  /** Ceiling applied after the per-turn ramp and every multiplier. */
  max: BracketTable;
  /** Hard limit on firings per run. */
  cap: BracketTable;
  /** Windows that must elapse after a firing before this type can fire again. */
  cooldown: BracketTable;
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
  version: 2,

  bracket: {
    /** Multiplies damage and other magnitudes. */
    severity: [0.6, 0.8, 1, 1.2, 1.45] as BracketTable,
    /**
     * Threat gained per opponent window on the first window, before jitter.
     * Low brackets start slow and accelerate (`threatGrowthRamp`); high
     * brackets open scary and flatten out against the 0–10 ceiling.
     */
    threatGrowth: [0.045, 0.21, 0.37, 0.51, 0.87] as BracketTable,
    /** Added to `threatGrowth` for each turn past turn 2. */
    threatGrowthRamp: [0.036, 0.01, 0, -0.011, -0.042] as BracketTable,
    /** Cap on events created in a single window (the race clock is exempt). */
    maxEventsPerWindow: [1, 2, 2, 3, 3] as BracketTable,
  },

  hazards: {
    /**
     * The pod's reset. Bracket 4 wraths the most (82% by turn 7); bracket 1
     * the least, and rarely before turn 8. Bracket 5 is the odd one out — it
     * wraths early or not at all, holding the highest chance of any bracket on
     * turn 4 and decaying to nothing by turn 10, which is what its negative
     * `perTurn` buys. A low `base` starting early (bracket 3) and a high `base`
     * starting late (bracket 5) are different games, not one curve shifted.
     */
    wipe: {
      startTurn: [5, 4, 3, 3, 4] as BracketTable,
      base: [0.09, 0.07, 0.03, 0.16, 0.27] as BracketTable,
      perTurn: [0.045, 0.055, 0.093, 0.075, -0.04] as BracketTable,
      max: [0.3, 0.4, 0.5, 0.55, 0.4] as BracketTable,
      cap: [2, 2, 3, 3, 2] as BracketTable,
      cooldown: [3, 3, 3, 2, 2] as BracketTable,
    },
    /**
     * Targeted answers — the one hazard whose pressure climbs all the way to
     * bracket 5 (0.6 removals a run at bracket 1, 2.5 at bracket 5). Three
     * dials share that climb: bracket 3 and up start rolling on turn 2, the
     * cooldown halves, and the cap rises, so `base` alone does not read
     * monotonic.
     */
    removal: {
      startTurn: [5, 4, 2, 2, 2] as BracketTable,
      base: [0.06, 0.06, 0.045, 0.085, 0.13] as BracketTable,
      perTurn: [0.012, 0.014, 0.016, 0.021, 0.026] as BracketTable,
      max: [0.2, 0.24, 0.28, 0.36, 0.45] as BracketTable,
      cap: [3, 4, 5, 6, 6] as BracketTable,
      cooldown: [2, 2, 1, 1, 1] as BracketTable,
    },
    /**
     * Turning the silhouette sideways. Bracket 4 is the hardest-hitting board;
     * bracket 5 attacks later and less, because it is holding up interaction
     * and winning off a combo instead.
     */
    combat: {
      startTurn: [5, 4, 4, 3, 4] as BracketTable,
      base: [0.3, 0.4, 0.45, 0.44, 0.22] as BracketTable,
      perTurn: [0.04, 0.05, 0.06, 0.07, 0.025] as BracketTable,
      max: [0.6, 0.75, 0.85, 0.9, 0.4] as BracketTable,
      cap: [99, 99, 99, 99, 99] as BracketTable,
      cooldown: [0, 0, 0, 0, 0] as BracketTable,
    },
    /** Discard, sacrifice, tax. Rare below bracket 3, routine at bracket 5. */
    resource: {
      startTurn: [5, 4, 3, 2, 2] as BracketTable,
      base: [0.05, 0.08, 0.09, 0.085, 0.1] as BracketTable,
      perTurn: [0.01, 0.014, 0.016, 0.02, 0.018] as BracketTable,
      max: [0.15, 0.2, 0.25, 0.3, 0.35] as BracketTable,
      cap: [2, 3, 3, 4, 4] as BracketTable,
      cooldown: [3, 2, 2, 2, 1] as BracketTable,
    },
    /**
     * "We win in N turns." The single most bracket-defining number in the file:
     * turn 11 at bracket 1, turn 4 at bracket 5.
     */
    clock: {
      startTurn: [11, 9, 7, 5, 4] as BracketTable,
      base: [0.23, 0.28, 0.28, 0.31, 0.4] as BracketTable,
      perTurn: [0, 0, 0.01, 0.015, 0.02] as BracketTable,
      max: [0.4, 0.45, 0.5, 0.6, 0.7] as BracketTable,
      cap: [4, 4, 4, 4, 4] as BracketTable,
      cooldown: [0, 0, 0, 0, 0] as BracketTable,
    },
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
    armChance: [0.06, 0.14, 0.24, 0.36, 0.55] as BracketTable,
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
    /**
     * A seat needs at least this much threat to start a clock. Lower at the low
     * brackets, where nobody's board ever gets scary but somebody still ends up
     * closest to winning.
     */
    minThreat: [2.5, 3, 3.5, 4, 4] as BracketTable,
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
