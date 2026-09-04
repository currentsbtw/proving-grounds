/**
 * Every number the scoring engine reads lives here, so tuning the scorecard is
 * one file and the type checker guards the shape — the same arrangement
 * `src/data/pressure.ts` uses for the pressure engine.
 *
 * The thresholds below are starting values, not measurements: they were chosen
 * to sort obviously-fast decks from obviously-slow ones on a handful of runs and
 * should be refitted once there is a real corpus of logs to fit against. Bump
 * `version` whenever a number here changes, so scorecards computed under
 * different tunings stay distinguishable.
 */
export const SCORING = {
  version: 2,

  /** Player life at the start of every run — mirrors `STARTING_LIFE` in the store. */
  startingLife: 40,

  wipe: {
    /**
     * A board counts as rebuilt once its end-of-turn value climbs back to this
     * share of what the wrath took. Not 100%: recovering the exact mana value
     * you lost is rarer than recovering a board that functions again.
     */
    recoveryShare: 0.7,
  },

  /**
   * Tag thresholds. A profile needs at least `minRuns` runs before any tag is
   * emitted — one game is a story, not a tendency.
   */
  tags: {
    minRuns: 2,

    /** `fast`: on the table early, by either measure. */
    fastFirstCastTurn: 3,
    fastMvPerTurn: 4,
    /** `slow`: the commander lands late in the game, run after run. */
    slowFirstCastTurn: 6,

    /** `brittle to wraths`: either half the wipes stick, or rebuilding is glacial. */
    brittleUnrecoveredRate: 0.5,
    brittleTurnsToRecover: 3,
    /** `resilient`: enough wipes faced to mean something, and rebuilt fast. */
    resilientMinWipes: 2,
    resilientTurnsToRecover: 1.5,
    resilientUnrecoveredRate: 0.25,

    /** `commander-dependent`: this many turns per run spent without it. */
    commanderDowntimeTurns: 3,

    /** `loses to the clock`: enough races faced, and mostly lost. */
    clockMinFaced: 2,
    clockBeatenShare: 0.34,

    /** `interactive`: this share of terminal events were answered, not eaten. */
    interactiveAnswerRate: 0.4,

    /** `mulligans often`: this share of runs opened with at least one mulligan. */
    mulliganRate: 0.4,

    /**
     * `lets hate pieces stand`: enough pieces actually resolved for the share to
     * mean anything, and most of them were still standing when the run ended.
     * Read against pieces that *stood*, not pieces faced — a hate piece the
     * player countered was answered, and answering is already what the answer
     * rate measures.
     */
    hateMinStood: 2,
    hateRemovedRate: 0.34,
  },

  /** The tag strings themselves, so the UI and the engine cannot drift apart. */
  tagLabels: {
    fast: 'fast',
    slow: 'slow',
    brittle: 'brittle to wraths',
    resilient: 'resilient',
    commanderDependent: 'commander-dependent',
    losesToClock: 'loses to the clock',
    interactive: 'interactive',
    mulligansOften: 'mulligans often',
    letsHateStand: 'lets hate pieces stand',
  },
} as const;

export type ScoringConfig = typeof SCORING;
