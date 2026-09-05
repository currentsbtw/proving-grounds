import { useDroppable } from '@dnd-kit/core';
import type { MouseEvent } from 'react';
import type { CardInstance, ZoneId } from '../../domain/types';
import { commanderTax, useGameStore } from '../../state/gameStore';
import { useCardUnit } from './cardGeometry';
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
  const unit = useCardUnit();
  const top = cards.length > 0 ? cards[cards.length - 1] : undefined;

  return (
    <div
      ref={setNodeRef}
      className={`tbl-zone tbl-drop${isOver ? ' is-over' : ''}`}
      title={`${name} (${cards.length}) · click to browse`}
      onClick={onOpen}
    >
      <button
        type="button"
        className="tbl-zone-head"
        aria-label={`Browse ${name.toLowerCase()}: ${cards.length} cards`}
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
      >
        <span>{label}</span>
        <span className="tbl-zone-count">{cards.length}</span>
      </button>
      <div className="tbl-zone-body">
        {top ? (
          <DraggableCardView
            card={top}
            width={unit}
            small
            badge={false}
            title="Drag out, or right-click for options"
          />
        ) : (
          <div className="tbl-zone-slot" />
        )}
      </div>
    </div>
  );
}

/**
 * A commander, with the tax figure the Cast row used to carry pinned to its
 * corner in the same chip the counters already use.
 *
 * The figure belongs to this commander rather than to the zone, which is why it
 * is not in the head: a one-card-wide head holds the zone's name and its count and
 * nothing else, and a partner pair's two taxes would have had to share it.
 */
function CommanderCard({ card }: { card: CardInstance }) {
  const tax = useGameStore((s) => (card.scryfallId ? commanderTax(s, card.scryfallId) : 0));
  const castCommander = useGameStore((s) => s.castCommander);
  const unit = useCardUnit();

  // The card swallows its own clicks: the zone behind it opens the browse
  // overlay on a plain click, and a first click that opened an overlay would
  // never let the second one land. Browsing stays on the head row and on the
  // rest of the frame.
  const swallow = (e: MouseEvent<HTMLDivElement>) => e.stopPropagation();
  const cast = () => castCommander(card.iid);

  return (
    <div className="tbl-commander">
      <DraggableCardView
        card={card}
        width={unit}
        small
        badge={false}
        onClick={swallow}
        onDoubleClick={(e) => {
          e.stopPropagation();
          cast();
        }}
        onActivate={cast}
        title={`Double-click or Enter to cast (tax +${tax}) · right-click for options`}
      />
      <span className="tbl-tax-chip">Tax {tax}</span>
    </div>
  );
}

/**
 * Command zone: the same frame as every other pile — one head row, one card
 * slot. Casting is the card's own action (double-click, Enter, or the
 * right-click menu's "Cast commander") rather than a button row that made this
 * one frame taller than the four beside it.
 */
export function CommandZone({ cards, onOpen }: { cards: CardInstance[]; onOpen: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'command' });

  return (
    <div
      ref={setNodeRef}
      className={`tbl-zone tbl-drop${isOver ? ' is-over' : ''}`}
      title="Command zone · click to browse · double-click a commander to cast it"
      onClick={onOpen}
    >
      <button
        type="button"
        className="tbl-zone-head"
        aria-label={`Browse command zone: ${cards.length} cards`}
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
      >
        <span>Command</span>
        <span className="tbl-zone-count">{cards.length}</span>
      </button>
      <div className="tbl-zone-body">
        {cards.length === 0 ? (
          <div className="tbl-zone-slot" />
        ) : (
          cards.map((card) => <CommanderCard key={card.iid} card={card} />)
        )}
      </div>
    </div>
  );
}

export interface LibraryStackProps {
  count: number;
  /** Draw one card — the same action as the D hotkey and the menu's "Draw 1". */
  onDraw: () => void;
  onOpenMenu: (x: number, y: number) => void;
}

/**
 * Library: a face-down card carrying the count, plus top/bottom drop strips.
 *
 * Drawing is the loop this zone is in the strip for, so it is the plain click,
 * everywhere on the frame; everything else is one right-click away. Both are
 * reachable without a mouse: the head button draws, and the "⋯" on the back —
 * which is where the room for it is, the head being the shared label-and-count
 * row every zone prints — opens the same menu at itself.
 */
export function LibraryStack({ count, onDraw, onOpenMenu }: LibraryStackProps) {
  const { setNodeRef: setTopRef, isOver: overTop } = useDroppable({ id: 'library-top' });
  const { setNodeRef: setBottomRef, isOver: overBottom } = useDroppable({ id: 'library-bottom' });

  return (
    <div
      className="tbl-zone"
      title={`Library (${count}) · click to draw · right-click for options`}
      onClick={onDraw}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenMenu(e.clientX, e.clientY);
      }}
    >
      <button
        type="button"
        className="tbl-zone-head"
        aria-label={`Library: ${count} cards. Draw one card.`}
        onClick={(e) => {
          e.stopPropagation();
          onDraw();
        }}
      >
        <span>Library</span>
        <span className="tbl-zone-count">{count}</span>
      </button>
      <div className="tbl-zone-body tbl-lib-body">
        {/* The back is the card, not a number in a box: the strip's one card
            size, a thin inner rule, and the count printed on it. */}
        <div className="tbl-lib-back">
          <span className="tbl-lib-count">{count}</span>
          <button
            type="button"
            className="tbl-lib-more"
            aria-label="Library options"
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              onOpenMenu(r.right, r.bottom);
            }}
          >
            ⋯
          </button>
        </div>
        <div ref={setTopRef} className={`tbl-lib-strip is-top${overTop ? ' is-over' : ''}`}>
          top
        </div>
        <div ref={setBottomRef} className={`tbl-lib-strip is-bottom${overBottom ? ' is-over' : ''}`}>
          bottom
        </div>
      </div>
    </div>
  );
}
