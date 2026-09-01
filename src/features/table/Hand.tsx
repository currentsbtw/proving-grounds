import { useDroppable } from '@dnd-kit/core';
import type { CardInstance } from '../../domain/types';
import { useGameStore } from '../../state/gameStore';
import { DraggableCardView } from './CardView';

const HAND_CARD_WIDTH = 120;

export interface HandProps {
  cards: CardInstance[];
  /** Mulligan bottoming mode: clicking a card toggles selection. */
  selecting: boolean;
  selected: string[];
  onToggleSelect: (iid: string) => void;
}

export function Hand({ cards, selecting, selected, onToggleSelect }: HandProps) {
  const { setNodeRef, isOver } = useDroppable({ id: 'hand' });
  const moveCard = useGameStore((s) => s.moveCard);

  return (
    <div
      ref={setNodeRef}
      className={`tbl-hand tbl-drop${isOver ? ' is-over' : ''}`}
      aria-label="Hand"
    >
      {cards.length === 0 && <p className="tbl-hand-empty">Hand is empty</p>}
      {cards.map((card) => (
        <DraggableCardView
          key={card.iid}
          card={card}
          width={HAND_CARD_WIDTH}
          selected={selecting && selected.includes(card.iid)}
          onClick={selecting ? () => onToggleSelect(card.iid) : undefined}
          onDoubleClick={selecting ? undefined : () => moveCard(card.iid, 'battlefield')}
          title={selecting ? 'Click to put on the bottom' : 'Double-click to play · right-click for options'}
        />
      ))}
    </div>
  );
}
