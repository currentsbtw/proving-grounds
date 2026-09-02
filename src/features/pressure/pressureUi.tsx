import type { CardInstance, EventType, SeatId } from '../../domain/types';
import { byArrival, cardName, useGameStore } from '../../state/gameStore';
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
