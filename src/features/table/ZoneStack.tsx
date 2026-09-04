import { useDroppable } from '@dnd-kit/core';
import type { CardInstance, ZoneId } from '../../domain/types';
import { commanderTax, useGameStore } from '../../state/gameStore';
import { STRIP_CARD_WIDTH } from './cardGeometry';
import { DraggableCardView } from './CardView';

export interface ZoneStackProps {
  zone: Extract<ZoneId, 'graveyard' | 'exile'>;
  /** The printed label, authored short enough to never need truncating. */
  label: string;
  /** The zone's full name, for the title and the accessible name. */
  name: string;
  cards: CardInstance[];
  onOpen: () => void;
}

/**
 * Graveyard / exile: top card preview, count, click to browse.
 *
 * The pile itself is not a control. It holds a draggable card, and a button
 * wrapping another button leaves assistive technology unable to say what one
 * activation is meant to do — and puts an extra tab stop in front of the card
 * the pilot was reaching for. The browse action is the head row's own button;
 * the pile keeps a plain click for the pointer, which reaches the same place.
 */
export function ZoneStack({ zone, label, name, cards, onOpen }: ZoneStackProps) {
  const { setNodeRef, isOver } = useDroppable({ id: zone });
  const top = cards.length > 0 ? cards[cards.length - 1] : undefined;

  return (
    <div
      ref={setNodeRef}
      className={`tbl-stack tbl-drop${isOver ? ' is-over' : ''}`}
      title={`${name} (${cards.length}) · click to browse`}
      onClick={onOpen}
    >
      <button
        type="button"
        className="tbl-stack-head"
        aria-label={`Browse ${name.toLowerCase()}: ${cards.length} cards`}
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
      >
        <span>{label}</span>
        <span className="tbl-stack-count">{cards.length}</span>
      </button>
      {top ? (
        <DraggableCardView
          card={top}
          width={STRIP_CARD_WIDTH}
          small
          badge={false}
          title="Drag out, or right-click for options"
        />
      ) : (
        <div className="tbl-stack-slot" />
      )}
    </div>
  );
}

function CommanderCell({ card, onBrowse }: { card: CardInstance; onBrowse: () => void }) {
  const tax = useGameStore((s) => (card.scryfallId ? commanderTax(s, card.scryfallId) : 0));
  const castCommander = useGameStore((s) => s.castCommander);

  return (
    <div className="tbl-commander-cell">
      <button
        type="button"
        className="tbl-stack-head"
        aria-label="Browse command zone"
        onClick={(e) => {
          e.stopPropagation();
          onBrowse();
        }}
      >
        <span>Command</span>
      </button>
      <DraggableCardView card={card} width={STRIP_CARD_WIDTH} small badge={false} />
      {/* The tax figure has a fixed home in the readout's YOU block; this
          button only has to say what it does. */}
      <button
        type="button"
        className="tbl-tax"
        title={`Cast · commander tax +${tax}`}
        onClick={(e) => {
          e.stopPropagation();
          castCommander(card.iid);
        }}
      >
        Cast
      </button>
    </div>
  );
}

/**
 * Command zone: every commander with its current tax and a one-click cast.
 * Same rule as the piles above — the zone holds cards and Cast buttons, so it
 * cannot itself be a button. Each commander's head row browses.
 */
export function CommandZone({ cards, onOpen }: { cards: CardInstance[]; onOpen: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'command' });

  return (
    <div
      ref={setNodeRef}
      className={`tbl-stack is-wide tbl-drop${isOver ? ' is-over' : ''}`}
      title="Command zone · click to browse"
      onClick={onOpen}
    >
      {cards.length === 0 && (
        <div>
          <button
            type="button"
            className="tbl-stack-head"
            aria-label="Browse command zone: 0 cards"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
          >
            <span>Command</span>
            <span className="tbl-stack-count">0</span>
          </button>
          <div className="tbl-stack-slot" />
        </div>
      )}

      {cards.map((card) => (
        <CommanderCell key={card.iid} card={card} onBrowse={onOpen} />
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
      title={`Library (${count}) · click to draw, shuffle or search`}
      onClick={(e) => onOpenMenu(e.clientX, e.clientY)}
    >
      {/* The three piles work the same way: the head row is the control, the
          pile is a drop target that also takes a pointer click. */}
      <button
        type="button"
        className="tbl-stack-head"
        aria-label={`Library: ${count} cards. Draw, shuffle or search.`}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          onOpenMenu(r.right, r.top);
        }}
      >
        <span>Library</span>
      </button>
      <div className="tbl-lib-back">
        <span className="tbl-lib-count">{count}</span>
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
