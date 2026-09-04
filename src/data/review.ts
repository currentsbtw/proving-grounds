/**
 * Every number the review engine reads lives here, the same arrangement
 * `src/data/scorecard.ts` uses for scoring and `src/data/pressure.ts` uses for
 * the pressure engine: tuning the review is one file, and the type checker
 * guards the shape.
 *
 * The review is arithmetic over the run log and nothing else. It counts mana,
 * cards and turns; it never claims a spell was legal, castable in colour, or
 * timed correctly. Every threshold below is therefore a counting threshold, and
 * the copy each finding carries has to stay inside that claim.
 *
 * These are starting values, not measurements. Bump `version` whenever a number
 * here changes, so reviews produced under different tunings stay
 * distinguishable.
 */
export const REVIEW = {
  version: 2,

  /** Hard cap on findings shown. A debrief nobody reads changes no decklist. */
  maxFindings: 8,
  /** At most this many misses, notes and goods respectively, before the cap. */
  maxMisses: 5,
  maxNotes: 2,
  maxGoods: 3,
  /** More than two stuck cards is a hand description, not a finding. */
  maxStuckCards: 2,
  /** Turns named inline in a detail line before it switches to a count. */
  maxTurnsNamed: 4,

  landDrop: {
    /**
     * `good`: every land drop from turn 1 through this turn was hit. Five is
     * where a Commander curve stops being forgiving about a miss.
     */
    goodThroughTurn: 5,
  },

  manaLeft: {
    /**
     * Untapped lands at end of turn versus the cheapest nonland in hand. Turn 1
     * is exempt: a one-land turn with a one-drop held is a colour problem far
     * more often than a play mistake, and colours are not checked.
     */
    fromTurn: 2,
    /** At least this many untapped lands before the turn is worth naming. */
    minUntapped: 1,
  },

  stuckInHand: {
    /** Consecutive end-of-turn snapshots holding the card before it counts. */
    minTurnsHeld: 4,
    /** Of those turns, how many had mana value at or below the land count. */
    minCastableTurns: 2,
  },

  commander: {
    /**
     * Gap between the first turn the land count covered the commander's mana
     * value and the turn it actually hit the table. Tax is 0 for a first cast,
     * so the comparison is against the printed mana value alone.
     */
    lateByTurns: 2,
  },

  hazard: {
    /**
     * Turns a hate piece stood before the run is worth telling about it. Three
     * is a full cycle of the table plus one: a piece nobody has answered by then
     * was not going to be answered by accident. Nothing here says the piece
     * *could* have been removed — the log knows what was in hand, never what it
     * could legally have done — so the finding stops at how long it stood.
     */
    minTurnsStanding: 3,
    /** Removed within this many turns of landing earns the good. */
    quickRemovalTurns: 1,
  },

  overextend: {
    /** Mana value deployed in the turn before a resolved wrath. */
    minMvDeployed: 6,
    /** Nonland cards still in hand at the end of that turn. */
    minCardsInHand: 2,
  },

  /** The honest-limits line, printed under the list rather than as a finding. */
  footer: 'By the numbers only. Colours, timing and legality are not checked.',
  /** Appended wherever a finding leans on a mana count. */
  manaCaveat: 'By mana count; colours not checked.',
} as const;

export type ReviewConfig = typeof REVIEW;
