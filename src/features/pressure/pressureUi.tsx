import type { CitationSweep, CitationZone } from '../../data/citations';
import type { CardInstance, EventType, PressureEvent, SeatId } from '../../domain/types';
import { punishPhrase } from '../../engine/pressure';
import { byArrival, cardName, isCreatureCard, useGameStore } from '../../state/gameStore';
import type { GameState } from '../../state/gameStore';

/** Short display name for an event type, used on the dock's class chip. */
export const EVENT_LABEL: Record<EventType, string> = {
  wipe: 'BOARD WIPE',
  removal: 'REMOVAL',
  counter: 'COUNTERSPELL',
  combat: 'COMBAT',
  clock: 'RACE CLOCK',
  resource: 'RESOURCE',
};

/**
 * How a seat is named everywhere it is named. Sentence case, because it reads
 * inside prose as often as it sits in a chip — and the chips are upper-cased by
 * their own type rules rather than by the string.
 */
export function seatLabel(id: SeatId): string {
  return `Seat ${id}`;
}

/** A battlefield/hand card offered in one of the dock's pickers. */
export interface Choice {
  card: CardInstance;
  name: string;
}

/**
 * Cards matching `pred`, in arrival order, paired with their display names.
 * Reads the live store snapshot so the exported `isCreatureCard` / `cardName`
 * helpers can be reused without threading `GameState` through every prop.
 */
export function collectChoices(
  cards: Record<string, CardInstance>,
  pred: (state: GameState, card: CardInstance) => boolean,
): Choice[] {
  const state = useGameStore.getState();
  return Object.values(cards)
    .filter((card) => pred(state, card))
    .sort(byArrival)
    .map((card) => ({ card, name: cardName(state, card.iid) }));
}

/**
 * The sweep a wipe row or event is really talking about. `variant` carried the
 * two-way scope before the citations landed and legacy runs still say
 * 'nonlands', so every reader of a stored variant comes through here.
 */
export function normalizeSweep(variant: string | undefined): CitationSweep {
  if (variant === 'ace') return 'ace';
  if (variant === 'nonland' || variant === 'nonlands') return 'nonland';
  return 'creatures';
}

/** The sweep as one noun phrase, the way the ledger prints it. */
export function sweepWord(sweep: CitationSweep): string {
  if (sweep === 'ace') return 'artifacts, creatures, enchantments';
  return sweep === 'nonland' ? 'nonlands' : 'creatures';
}

/** The sweep as the object of a verb: "Exile all creatures", "Bounce all nonlands". */
export function sweepScope(sweep: CitationSweep): string {
  return sweep === 'ace' ? sweepWord(sweep) : `all ${sweepWord(sweep)}`;
}

/**
 * What the wipe sweeps once the player has had their say. The cited card owns
 * the scope; the dock's toggle is the player reporting that the board
 * disagreed, so it can only widen or narrow, and an untouched toggle leaves the
 * card alone. This is the same arithmetic the store resolves with, worded here
 * so the button and the resolution can never name different things.
 */
export function effectiveSweep(event: PressureEvent, nonlands?: boolean): CitationSweep {
  const cited = event.card?.sweep ?? normalizeSweep(event.variant);
  if (nonlands === undefined) return cited;
  if (!nonlands) return 'creatures';
  return cited === 'creatures' ? 'nonland' : cited;
}

/**
 * What the cited card does to what it touches. A wrath destroys, a Farewell
 * exiles, a Cyclonic Rift bounces, and an uncited legacy event destroys because
 * that is all the old runs ever did.
 */
const ZONE_VERB: Record<CitationZone, string> = {
  graveyard: 'Destroy',
  exile: 'Exile',
  hand: 'Bounce',
  library: 'Shuffle away',
};

/** The verb the citation's zone prints, or the legacy 'Destroy'. */
export function zoneVerb(zone: CitationZone | undefined): string {
  return zone ? ZONE_VERB[zone] : 'Destroy';
}

/** The two numbered answers as they are printed, and whether the second is dead. */
export interface EventAnswers {
  /** The first response: answer it, force it through, or declare interaction. */
  first: string;
  /** The second response: what happens at the table if it resolves. */
  second: string;
  /** The resolution needs a card the player has not named yet, so it cannot fire. */
  blocked: boolean;
}

/**
 * What the player has changed about the event since it landed. The dock holds
 * all of it in local state; a caller with none of it (the toast) gets the labels
 * the event arrived with.
 */
export interface AnswerEdits {
  /** The card chosen to pitch or give up. */
  pickIid?: string;
  /** The permanent the removal actually killed. */
  targetIid?: string;
  /** The damage figure as the player has it. */
  damage?: number;
  /**
   * The wipe's scope toggle, and only once the player has touched it: undefined
   * means the cited card's own sweep stands.
   */
  nonlands?: boolean;
}

/**
 * The one place an event's two answers are worded and the one place the second
 * one is gated. Both the dock and the toast over the board print these, and a
 * second copy of the switch is how they drifted apart before.
 *
 * Pure: everything it reads comes from `event`, `state` and `edits`, so a caller
 * can run it inside a store selector on the boolean it needs.
 */
export function describeAnswers(
  event: PressureEvent,
  state: GameState,
  edits: AnswerEdits = {},
): EventAnswers {
  const variant = event.variant ?? 'tax';

  // The gate: a discard with a hand to pitch from, or a sacrifice with a
  // creature to give up, cannot resolve until the player has named the card.
  // Nothing here guesses one. The board scan is inside the branch because the
  // toast runs this inside a store selector: every other event type answers
  // without touching `state.cards` at all.
  const needsCard =
    event.type === 'resource' &&
    (() => {
      const cards = Object.values(state.cards);
      if (variant === 'discard') return cards.some((card) => card.zone === 'hand');
      if (variant === 'sacrifice')
        return cards.some((card) => card.zone === 'battlefield' && isCreatureCard(state, card));
      return false;
    })();
  const blocked = needsCard && !edits.pickIid;

  const pickName = edits.pickIid && state.cards[edits.pickIid] ? cardName(state, edits.pickIid) : null;

  let second: string;
  switch (event.type) {
    // The button says what the cited card does, not what a wrath does: the
    // verb comes from where the card puts things and the scope from what it
    // sweeps, so "Exile all creatures" and "Bounce all nonlands" are both
    // printable and both true.
    case 'wipe':
      second = `${zoneVerb(event.card?.zone)} ${sweepScope(effectiveSweep(event, edits.nonlands))}`;
      break;
    case 'removal': {
      const targetIid = edits.targetIid ?? event.targetIid;
      const target = targetIid ? state.cards[targetIid] : undefined;
      second =
        target && target.zone === 'battlefield'
          ? `${zoneVerb(event.card?.zone)} ${cardName(state, target.iid)}`
          : 'Nothing to destroy';
      break;
    }
    case 'counter':
      second = 'It gets countered';
      break;
    case 'combat':
      second = `Take ${Math.max(0, Math.round(edits.damage ?? event.severity.damage ?? 0) || 0)}`;
      break;
    case 'resource':
      if (variant === 'discard') second = pickName ? `Discard ${pickName}` : 'Discard a card';
      else if (variant === 'sacrifice')
        second = pickName ? `Sacrifice ${pickName}` : 'Sacrifice a creature';
      // A tax is pay-or-punish, and both sides are printed: the price is on the
      // first button, and this is what the seat gets when it goes unpaid. "Pay
      // the tax" said neither, and named a thing no card on the table is called.
      // The sentence itself is the engine's, so the button, the toast and the
      // log all say it the same way.
      else second = punishPhrase(event.card?.punish, event.seatId);
      break;
    case 'clock':
      second = 'The clock stands';
      break;
    default:
      second = 'It resolves';
      break;
  }

  // A counter raised off the tray sits on top of the spell it is aimed at, and
  // both are printed there. "Force it through" reads as putting the spell on the
  // table; what it actually does is take the counter off and leave the spell
  // waiting, so the answer is worded the way every other event's is.
  const stackedCounter = event.type === 'counter' && event.severity.stacked === 1;

  // The price of the tax, when the citation carries one. It is the whole of the
  // first answer: paying is the answer.
  const taxPay = event.type === 'resource' && variant === 'tax' ? event.card?.pay : undefined;

  return {
    first:
      event.type === 'clock'
        ? 'Declare held interaction'
        : taxPay !== undefined
          ? `Pay ${taxPay}`
          : event.type === 'counter' && !stackedCounter
            ? 'Force it through'
            : 'I answer it',
    second,
    blocked,
  };
}
