import { useDroppable } from '@dnd-kit/core';
import { useMemo } from 'react';
import type { CardData, CardInstance } from '../../domain/types';
import { useGameStore } from '../../state/gameStore';
import { cardHeight, DraggableCardView } from './CardView';

const BF_CARD_WIDTH = 140;

/** Height the land row holds open, so the first land does not shove the board. */
const LAND_ROW_MIN = cardHeight(BF_CARD_WIDTH) + 16;

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

  function renderCard(card: CardInstance) {
    return (
      <DraggableCardView
        key={card.iid}
        card={card}
        width={BF_CARD_WIDTH}
        onClick={() => toggleTapped(card.iid)}
        title="Click to tap / untap · right-click for options"
      />
    );
  }

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

      {/* Both rows always render: nonlands grow downward from the top, lands
          stay pinned to the bottom edge from the very first one. */}
      <div className="tbl-bf-rows">
        <div className="tbl-bf-row is-nonlands">{nonlands.map(renderCard)}</div>
        <div className="tbl-bf-row is-lands" style={{ minHeight: LAND_ROW_MIN }}>
          {lands.map(renderCard)}
        </div>
      </div>
    </div>
  );
}
