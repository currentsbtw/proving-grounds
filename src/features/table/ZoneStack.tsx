import { useDroppable } from '@dnd-kit/core';
import type { CardInstance, ZoneId } from '../../domain/types';
import { commanderTax, useGameStore } from '../../state/gameStore';
import { DraggableCardView } from './CardView';

const STACK_CARD_WIDTH = 80;

export interface ZoneStackProps {
  zone: Extract<ZoneId, 'graveyard' | 'exile'>;
  label: string;
  cards: CardInstance[];
  onOpen: () => void;
}

/** Graveyard / exile: top card preview, count, click to browse. */
export function ZoneStack({ zone, label, cards, onOpen }: ZoneStackProps) {
  const { setNodeRef, isOver } = useDroppable({ id: zone });
  const top = cards.length > 0 ? cards[cards.length - 1] : undefined;

  return (
    <div
      ref={setNodeRef}
      className={`tbl-stack tbl-drop${isOver ? ' is-over' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`${label} — ${cards.length} cards`}
      title={`${label} (${cards.length}) — click to browse`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="tbl-stack-head">
        <span>{label}</span>
        <span className="tbl-stack-count">{cards.length}</span>
      </div>
      {top ? (
        <DraggableCardView
          card={top}
          width={STACK_CARD_WIDTH}
          small
          title="Drag out, or right-click for options"
        />
      ) : (
        <div className="tbl-stack-slot">
          <span className="tbl-stack-empty">empty</span>
        </div>
      )}
    </div>
  );
}

function CommanderCell({ card }: { card: CardInstance }) {
  const tax = useGameStore((s) => (card.scryfallId ? commanderTax(s, card.scryfallId) : 0));
  const castCommander = useGameStore((s) => s.castCommander);

  return (
    <div className="tbl-commander-cell">
      <div className="tbl-stack-head">
        <span>Command</span>
      </div>
      <DraggableCardView card={card} width={STACK_CARD_WIDTH} small />
      <button
        type="button"
        className="tbl-tax"
        title={`Cast — commander tax +${tax}`}
        onClick={(e) => {
          e.stopPropagation();
          castCommander(card.iid);
        }}
      >
        Cast · Tax {tax}
      </button>
    </div>
  );
}

/** Command zone: every commander with its current tax and a one-click cast. */
export function CommandZone({ cards, onOpen }: { cards: CardInstance[]; onOpen: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'command' });

  return (
    <div
      ref={setNodeRef}
      className={`tbl-stack is-wide tbl-drop${isOver ? ' is-over' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`Command zone — ${cards.length} cards`}
      title="Command zone — click to browse"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      {cards.length === 0 && (
        <div>
          <div className="tbl-stack-head">
            <span>Command</span>
            <span className="tbl-stack-count">0</span>
          </div>
          <div className="tbl-stack-slot">
            <span className="tbl-stack-empty">empty</span>
          </div>
        </div>
      )}

      {cards.map((card) => (
        <CommanderCell key={card.iid} card={card} />
      ))}
    </div>
  );
}

/** Library: face-down back with a prominent count, plus top/bottom drop strips. */
export function LibraryStack({ count, onOpenMenu }: { count: number; onOpenMenu: (x: number, y: number) => void }) {
  const { setNodeRef: setTopRef, isOver: overTop } = useDroppable({ id: 'library-top' });
  const { setNodeRef: setBottomRef, isOver: overBottom } = useDroppable({ id: 'library-bottom' });

  return (
    <div
      className="tbl-stack"
      role="button"
      tabIndex={0}
      aria-label={`Library — ${count} cards`}
      title={`Library (${count}) — click for draw / shuffle / search`}
      onClick={(e) => onOpenMenu(e.clientX, e.clientY)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          onOpenMenu(r.right, r.top);
        }
      }}
    >
      <div className="tbl-stack-head">
        <span>Library</span>
      </div>
      <div className="tbl-lib-back">
        <span className="tbl-lib-count">{count}</span>
        <span className="tbl-lib-sub">cards</span>
      </div>
      <div ref={setTopRef} className={`tbl-lib-strip is-top${overTop ? ' is-over' : ''}`}>
        top
      </div>
      <div ref={setBottomRef} className={`tbl-lib-strip is-bottom${overBottom ? ' is-over' : ''}`}>
        bottom
      </div>
    </div>
  );
}
