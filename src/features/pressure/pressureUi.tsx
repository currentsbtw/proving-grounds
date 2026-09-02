import type { CardInstance, EventType, PressureEvent, SeatId } from '../../domain/types';
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
  /** The wipe's "all nonlands" toggle. */
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
  const cards = Object.values(state.cards);

  // The gate: a discard with a hand to pitch from, or a sacrifice with a
  // creature to give up, cannot resolve until the player has named the card.
  // Nothing here guesses one.
  const needsCard =
    event.type === 'resource' &&
    ((variant === 'discard' && cards.some((card) => card.zone === 'hand')) ||
      (variant === 'sacrifice' &&
        cards.some((card) => card.zone === 'battlefield' && isCreatureCard(state, card))));
  const blocked = needsCard && !edits.pickIid;

  const pickName = edits.pickIid && state.cards[edits.pickIid] ? cardName(state, edits.pickIid) : null;

  let second: string;
  switch (event.type) {
    case 'wipe':
      second =
        (edits.nonlands ?? variant === 'nonlands')
          ? 'Destroy all nonlands'
          : 'Destroy all creatures';
      break;
    case 'removal': {
      const targetIid = edits.targetIid ?? event.targetIid;
      const target = targetIid ? state.cards[targetIid] : undefined;
      second =
        target && target.zone === 'battlefield'
          ? `Destroy ${cardName(state, target.iid)}`
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
      else second = 'Pay the tax';
      break;
    case 'clock':
      second = 'The clock stands';
      break;
    default:
      second = 'It resolves';
      break;
  }

  return {
    first:
      event.type === 'clock'
        ? 'Declare held interaction'
        : event.type === 'counter'
          ? 'Force it through'
          : 'I answer it',
    second,
    blocked,
  };
}
