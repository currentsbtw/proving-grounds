import { SCORING } from '../../data/scorecard';
import type { Scorecard } from '../../engine/scorecard';

/**
 * The one line the debrief opens with, and the one line the shared PNG opens
 * with under the result word. Seven figures at equal weight say nothing on
 * their own; this names the worst thing the run did, in the same table-talk the
 * events are written in, and the slots below it are its evidence.
 *
 * It lives here rather than in the panel because two surfaces print it now: the
 * on-screen scorecard and the receipt that leaves the app. A player who posts
 * the image has to be posting the sentence they read.
 *
 * Every threshold comes from `src/data/scorecard.ts` — the same numbers the
 * profile's tags are cut against — so a tuning change moves the verdict and the
 * tags together. Findings are ranked by how far past their threshold they sit,
 * as a share of the threshold, so turns and percentages can be compared; a
 * failure with no "how far" (never rebuilt, clock expired) outranks all of them.
 */
const TERMINAL = 1000;

interface Finding {
  text: string;
  over: number;
}

// --- shared figure formatting ----------------------------------------------
// Every surface that prints a run's numbers prints them the same way: this
// file's findings, the panel's tiles and profile, the card table, and the share
// image. A figure rounded one way on screen and another way on the receipt is
// two numbers, so the formats live here rather than once per caller.

/** Printed wherever a metric has no value. `pct` falls back to it, and the
 *  `Figure` component keys its muted styling off it. */
export const NO_VALUE = 'n/a';

/** One decimal by default, trailing zero trimmed: 2.5 and 3 rather than 2.5 and 3.0. */
export function num(value: number, digits = 1): string {
  return String(Number(value.toFixed(digits)));
}

/**
 * One percentage format for every surface that prints a rate: this file's
 * findings, the panel's tiles and profile, and the share image's tiles. A rate
 * rounded one way on screen and another way on the receipt is two numbers.
 */
export function pct(value: number | null): string {
  return value === null ? NO_VALUE : `${Math.round(value * 100)}%`;
}

export function verdictOf(card: Scorecard): { text: string; clear: boolean } {
  const t = SCORING.tags;
  const found: Finding[] = [];

  // The same wrath the panel's tile reads: answered wraths were not rebuilt
  // from, and a wrath that took nothing measurable left nothing to rebuild, so
  // neither can make the run's worst line.
  const landed = card.wipes.filter((w) => !w.negated && w.mvLost > 0);
  const firstWipe = landed[0];
  if (firstWipe) {
    if (firstWipe.turnsToRecover === null) {
      found.push({ text: `Never rebuilt after the wrath on T${firstWipe.turn}.`, over: TERMINAL });
    } else if (firstWipe.turnsToRecover > t.brittleTurnsToRecover) {
      found.push({
        text: `${firstWipe.turnsToRecover} turns to rebuild after T${firstWipe.turn}, past ${t.brittleTurnsToRecover}.`,
        over: firstWipe.turnsToRecover / t.brittleTurnsToRecover - 1,
      });
    }
  }

  if (card.clock.faced && !card.clock.beatClock && card.clock.outcome === 'expired') {
    found.push({ text: `Lost the race. The clock ran out on T${card.clock.deadlineTurn}.`, over: TERMINAL });
  }

  const downtime = card.commander.downtimeTurns;
  if (downtime > t.commanderDowntimeTurns) {
    found.push({
      text: `Commander off the table ${downtime} turns, past ${t.commanderDowntimeTurns}.`,
      over: downtime / t.commanderDowntimeTurns - 1,
    });
  }

  const cast = card.deployment.firstCommanderCastTurn;
  if (cast === null && card.turns >= t.slowFirstCastTurn) {
    found.push({ text: `Commander never cast in ${card.turns} turns.`, over: TERMINAL });
  } else if (cast !== null && cast > t.slowFirstCastTurn) {
    found.push({
      text: `Commander landed T${cast}, past T${t.slowFirstCastTurn}.`,
      over: cast / t.slowFirstCastTurn - 1,
    });
  }

  const rate = card.answers.rate;
  if (rate !== null && rate < t.interactiveAnswerRate) {
    found.push({
      text: `Answered ${pct(rate)} of what ended, under ${pct(t.interactiveAnswerRate)}.`,
      over: t.interactiveAnswerRate / Math.max(rate, 0.01) - 1,
    });
  }

  if (found.length === 0) {
    return {
      text:
        card.events.length === 0
          ? 'The pod never presented an event. Nothing was tested.'
          : 'No metric crossed its threshold this run.',
      clear: true,
    };
  }

  found.sort((a, b) => b.over - a.over);
  return { text: found[0].text, clear: false };
}
