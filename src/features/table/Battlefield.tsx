import { useDroppable } from '@dnd-kit/core';
import { useMemo } from 'react';
import type { CardData, CardInstance } from '../../domain/types';
import { useGameStore } from '../../state/gameStore';
import { DraggableCardView } from './CardView';

const BF_CARD_WIDTH = 140;

function isLand(card: CardInstance, cardData: Record<string, CardData>): boolean {
  const typeLine = card.isToken
    ? (card.tokenSpec?.typeLine ?? '')
    : (card.scryfallId ? (cardData[card.scryfallId]?.typeLine ?? '') : '');
  return typeLine.includes('Land');
}

export function Battlefield({ cards }: { cards: CardInstance[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'battlefield' });
  const cardData = useGameStore((s) => s.cardData);
  const toggleTapped = useGameStore((s) => s.toggleTapped);

  const [lands, nonlands] = useMemo(() => {
    const l: CardInstance[] = [];
    const n: CardInstance[] = [];
    for (const card of cards) {
      (isLand(card, cardData) ? l : n).push(card);
    }
    return [l, n];
  }, [cards, cardData]);

  return (
    <div
      ref={setNodeRef}
      className={`tbl-battlefield tbl-drop${isOver ? ' is-over' : ''}`}
      aria-label="Battlefield"
    >
      {cards.length === 0 && (
        <p className="tbl-bf-empty">
          Battlefield is empty — double-click a card in hand to play it, or drag it here.
        </p>
      )}

      <div className="tbl-bf-rows">
        {nonlands.length > 0 && (
          <div className="tbl-bf-row">
            {nonlands.map((card) => (
              <DraggableCardView
                key={card.iid}
                card={card}
                width={BF_CARD_WIDTH}
                onClick={() => toggleTapped(card.iid)}
                title="Click to tap / untap · right-click for options"
              />
            ))}
          </div>
        )}

        {lands.length > 0 && (
          <div className={`tbl-bf-row${nonlands.length > 0 ? ' is-lands' : ''}`}>
            {lands.map((card) => (
              <DraggableCardView
                key={card.iid}
                card={card}
                width={BF_CARD_WIDTH}
                onClick={() => toggleTapped(card.iid)}
                title="Click to tap / untap · right-click for options"
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
