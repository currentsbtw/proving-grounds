import { createRng, shuffleInPlace } from '../domain/rng';
import { isLandTypeLine } from '../domain/typeLine';
import { drawProfiles, initialThreat } from './pressure';
import type { CardData } from '../domain/types';

/**
 * The keep/mull drill's arithmetic. Pure: no React, no store, no Dexie — the
 * same inputs give the same hands forever, which is the whole point of drilling
 * against a seed.
 *
 * The drill is not a second shuffler. It reproduces the sequence a real run with
 * that seed would deal, so a brewer who liked what they saw at hand 3 can start
 * that seed for real, mulligan twice, and be looking at the same seven cards.
 * That makes `dealHands` a mirror of `startRun` plus `takeMulligan`, and the two
 * are pinned against each other by `npm run verify:drill`.
 *
 * Nothing here judges a hand. It counts lands, mana values and spells, and the
 * player makes the call — "measure the deck, do not certify it" (PRODUCT.md).
 */

/**
 * Mirrors `STARTING_HAND_SIZE` in the game store. Copied rather than imported
 * because importing the store here would drag zustand and the whole live-run
 * module into a pure engine file; `verify:drill` deals both ways and compares,
 * so the two cannot drift silently.
 */
const HAND_SIZE = 7;

export interface DealHandsInput {
  /** `deck.cards` expanded by qty, in deck order — the library `startRun` builds. */
  cardIds: string[];
  seed: string;
  /** How many successive hands to deal. Hand k+1 is hand k mulliganed away. */
  hands: number;
}

/**
 * The pod, seated off the run's own generator.
 *
 * `startRun` shuffles, then calls `freshSeats(rng)` — three opening threats and
 * one archetype draw — and only then takes the opening seven. Those draws sit
 * between the shuffle and any later reshuffle, so a drill that skipped them
 * would agree with the run on hand 1 and disagree on every hand after it. The
 * engine's own functions are called rather than a count of `rng()` calls, so
 * seating that ever draws again keeps the drill in step by construction.
 */
function seatPodOffStream(rng: () => number): void {
  for (let i = 0; i < 3; i++) initialThreat(rng);
  drawProfiles(rng);
}

/**
 * Successive opening hands off one seed, as scryfall ids in the order they were
 * drawn. Hand 1 is the run's opening seven; hand k+1 is what `takeMulligan`
 * deals next — the hand goes back on the bottom of the library in hand order,
 * the library is reshuffled off the same rng stream, seven come off the top.
 */
export function dealHands({ cardIds, seed, hands }: DealHandsInput): string[][] {
  if (hands <= 0 || cardIds.length === 0) return [];

  const rng = createRng(seed);
  const library = [...cardIds];
  shuffleInPlace(library, rng);
  seatPodOffStream(rng);

  const out: string[][] = [];
  let hand = library.splice(0, HAND_SIZE);
  out.push([...hand]);

  for (let i = 1; i < hands; i++) {
    library.push(...hand);
    shuffleInPlace(library, rng);
    hand = library.splice(0, HAND_SIZE);
    out.push([...hand]);
  }
  return out;
}

export interface HandStats {
  lands: number;
  /** Cheapest nonland mana value, or null in a hand with no spells at all. */
  cheapest: number | null;
  /** Nonlands at or below mana value 2 and 3 — the two brackets a keep turns on. */
  spellsAtOrBelow: Record<2 | 3, number>;
  /** Mean mana value of the nonlands. 0 in a hand of seven lands. */
  avgMv: number;
}

/**
 * What a hand counts up to. Lands are read off the front face by the same
 * helper the table uses, so an MDFC spell // land is a spell here exactly as it
 * is when it is cast. No colours are read, no curve is graded, and no verdict is
 * returned: these are the numbers a player would count off the cards themselves.
 */
export function handStats(hand: CardData[]): HandStats {
  let lands = 0;
  const spellMvs: number[] = [];
  for (const card of hand) {
    if (isLandTypeLine(card.typeLine)) {
      lands += 1;
      continue;
    }
    spellMvs.push(card.manaValue);
  }

  const total = spellMvs.reduce((sum, mv) => sum + mv, 0);
  return {
    lands,
    cheapest: spellMvs.length === 0 ? null : Math.min(...spellMvs),
    spellsAtOrBelow: {
      2: spellMvs.filter((mv) => mv <= 2).length,
      3: spellMvs.filter((mv) => mv <= 3).length,
    },
    // Two decimals so a mean of thirds does not print as a float tail; the
    // readout rounds again to one on the way to the screen.
    avgMv: spellMvs.length === 0 ? 0 : Math.round((total / spellMvs.length) * 100) / 100,
  };
}
