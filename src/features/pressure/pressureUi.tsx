import type { ReactElement } from 'react';
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

export function seatLabel(id: SeatId): string {
  return `SEAT ${id}`;
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
 * The silhouette glyphs. Inline SVG rather than unicode so no seat row depends
 * on a symbol font being installed — and so none of them render as emoji.
 */
export function SilhouetteIcon({ kind }: { kind: 'creatures' | 'artifacts' | 'mana' }): ReactElement {
  const common = {
    className: 'pgp-glyph',
    viewBox: '0 0 16 16',
    width: 11,
    height: 11,
    'aria-hidden': true,
    focusable: 'false' as const,
  };

  if (kind === 'creatures') {
    // Crossed swords.
    return (
      <svg {...common}>
        <path
          d="M2.6 2.2 L9.4 11.6 M13.4 2.2 L6.6 11.6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M8.4 12.1 L10.4 14.1 M7.6 12.1 L5.6 14.1"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    );
  }

  if (kind === 'artifacts') {
    // Cog: a ring plus four spokes.
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="3.6" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <path
          d="M8 1.4 V3.4 M8 12.6 V14.6 M1.4 8 H3.4 M12.6 8 H14.6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    );
  }

  // Open mana: a hollow diamond.
  return (
    <svg {...common}>
      <path d="M8 1.6 L14.4 8 L8 14.4 L1.6 8 Z" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </svg>
  );
}
