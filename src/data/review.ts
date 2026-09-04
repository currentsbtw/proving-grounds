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
 *
 * 3 — the pod. The first twelve findings all read the player's own curve; these
 * read how the pod was handled (`clock`, `counters`, `threat`) and how often a
 * finding comes back across a deck's history (`patterns`). Every one of them is
 * still a count: damage per seat and per turn off the scorecard's timeline,
 * threat per seat off the window entries, countered spells off the ledger. None
 * of them knows whether the seat *could* have been hit, or what else was
 * castable, and the copy stops where the counting does.
 *
 * 4 — the shot clock. One finding, and the only one in the file that reads a
 * wall clock rather than the board: how long each turn took, against the limit
 * the run was started under. It is still a count, and it is still not a
 * judgement — a long turn is a long turn, not a bad one, and nothing here knows
 * whether the player was thinking, reading a card or answering the door.
 *
 * 5 — `fastRebuild.minMvLost`, the size of the sweep the rebuild good is owed
 * to. The scorecard says whether the board came back; it cannot say whether
 * coming back was worth anything, and a wrath that took three mana value is met
 * by the next permanent played. It is the same shape as every number here: a
 * count of mana value off the table, not a reading of how the turn felt.
 */
export const REVIEW = {
  version: 5,

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

  fastRebuild: {
    /**
     * Mana value the wrath actually took off the table (`WipeRecovery.mvLost`)
     * before rebuilding from it is an achievement. A wrath that took *nothing*
     * never gets here — the scorecard leaves its `turnsToRecover` null, because
     * there was nothing to recover — but one that took three mana value is met
     * by the next permanent played, and that is a turn, not a comeback. Six
     * matches `overextend.minMvDeployed`: the same board worth calling a
     * commitment is the board worth calling a rebuild.
     */
    minMvLost: 6,
  },

  clock: {
    /**
     * Damage sent at seats other than the clock's owner while the clock ran,
     * before the split is worth naming. Eight is about one Commander combat
     * step: below that the swing pointed elsewhere, above it the race was being
     * run against the wrong seat. It says nothing about whether the owner
     * *could* have been attacked — evasion, blockers and colours are not read.
     */
    wrongSeatMinDamage: 8,
  },

  counters: {
    /**
     * Spells the pod countered before it reads as a habit rather than a tax.
     * Two is the smallest number that can be a pattern; one countered spell is
     * a seat having the card, which is what a counter event is.
     */
    minCountered: 2,
  },

  threat: {
    /**
     * Threat a seat has to be showing before "unchecked" describes anything. The
     * meter is 0-10, so nine is a seat one window from the top of it.
     */
    uncheckedMin: 9.0,
    /**
     * Consecutive opponent windows it has to hold that while taking nothing from
     * the player. Three windows is a full cycle of the table.
     */
    uncheckedWindows: 3,
  },

  shotClock: {
    /**
     * Turns over the limit before the run is worth telling about it. One is
     * enough: a player who asked for a clock asked to be told, and the finding
     * names the turns rather than grading them.
     */
    minOvertimeTurns: 1,
  },

  patterns: {
    /**
     * Runs a finding has to appear in before it is a tendency of the deck rather
     * than a thing that happened once. Matches `SCORING.tags.minRuns` in spirit:
     * one game is a story.
     */
    minRuns: 3,
    /** And the share of the runs looked at, so a long history cannot coast. */
    minShare: 0.5,
  },

  /** The honest-limits line, printed under the list rather than as a finding. */
  footer: 'By the numbers only. Colours, timing and legality are not checked.',
  /** Appended wherever a finding leans on a mana count. */
  manaCaveat: 'By mana count; colours not checked.',
} as const;

export type ReviewConfig = typeof REVIEW;
