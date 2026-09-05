import { useDroppable } from '@dnd-kit/core';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { CardInstance } from '../../domain/types';
import { useGameStore } from '../../state/gameStore';
import { useCardUnit } from './cardGeometry';
import { DraggableCardView } from './CardView';

/** Breathing room between cards while they still fit side by side. */
const GAP_RATIO = 0.095;
/**
 * Smallest distance between two card left edges when overlapping — the sliver
 * of a covered card that stays readable. Both figures are a fraction of the
 * card unit rather than absolute room, so the hand fans the same way at every
 * window size the unit takes.
 */
const STEP_MIN_RATIO = 0.143;

/**
 * Distance between the left edges of two neighbouring cards. The card width is
 * the strip's one size and never gives — a hand that shrank to fit printed its
 * cards smaller than the graveyard beside it — so a hand too wide for its
 * column overlaps instead, down to the step floor. A step below the card width
 * means the cards overlap by `width - step`; hovering one lifts it clear.
 */
function handStep(avail: number, count: number, unit: number): number {
  const spread = unit + Math.round(unit * GAP_RATIO);
  if (count <= 1 || avail <= 0) return spread;
  const stepMin = Math.round(unit * STEP_MIN_RATIO);
  return Math.max(stepMin, Math.min(spread, (avail - unit) / (count - 1)));
}

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
  const unit = useCardUnit();

  const boxRef = useRef<HTMLDivElement | null>(null);
  const [avail, setAvail] = useState(0);
  // Where the keyboard was when a card was played out of the hand. The card it
  // was sitting on unmounts, and focus would otherwise fall to the document —
  // one keyboard play would cost the player their place in the hand.
  const refocus = useRef<number | null>(null);

  // The whole frame takes the drop, the way the four piles beside it do; the
  // card row is measured on its own, because it is the row's width — not the
  // frame's — that the fan has to fit inside.
  const setRowRef = useCallback((el: HTMLDivElement | null) => {
    boxRef.current = el;
  }, []);

  // Content-box width of the hand, tracked live so a window resize re-fans it.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;

    function measure(): void {
      const node = boxRef.current;
      if (!node) return;
      const style = getComputedStyle(node);
      const inner =
        node.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight);
      // A zero reading means the row is collapsed or the tab is not rendering;
      // keep the last good width rather than blanking the hand.
      setAvail((prev) => {
        if (inner <= 0) return prev;
        return Math.abs(prev - inner) < 0.5 ? prev : inner;
      });
    }

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Runs after the played card has gone, so the index that was under the
  // keyboard now holds the card that slid into its place.
  useLayoutEffect(() => {
    const index = refocus.current;
    if (index === null) return;
    refocus.current = null;
    const stops = boxRef.current?.querySelectorAll<HTMLElement>('.tbl-card');
    if (!stops || stops.length === 0) return;
    stops[Math.min(index, stops.length - 1)].focus();
  }, [cards.length]);

  const step = handStep(avail, cards.length, unit);
  const overlap = step - unit;

  return (
    <div
      ref={setNodeRef}
      className={`tbl-zone tbl-hand-zone tbl-drop${isOver ? ' is-over' : ''}`}
      aria-label="Hand"
    >
      {/* The same head row as the four piles: label, then the count. Nothing
          here is a control — the hand has no browse view, it is already open. */}
      <div className="tbl-zone-head is-static">
        <span>Hand</span>
        <span className="tbl-zone-count">{cards.length}</span>
      </div>

      <div ref={setRowRef} className="tbl-zone-body tbl-hand-row">
        {cards.length === 0 && (
          <p className="tbl-hand-empty">Hand is empty. Draw from the library.</p>
        )}

        {/* Nothing renders until the container has been measured, so the row can
            never briefly overflow at its default width. */}
        {avail > 0 &&
          cards.map((card, i) => (
            <div
              key={card.iid}
              className="tbl-hand-slot"
              style={
                {
                  marginLeft: i === 0 ? 0 : overlap,
                  // Earlier cards sit on top, so every card keeps its right edge
                  // — and its mana-value badge — visible when they overlap.
                  '--hand-z': cards.length - i,
                } as CSSProperties
              }
            >
              <DraggableCardView
                card={card}
                width={unit}
                selected={selecting && selected.includes(card.iid)}
                onClick={selecting ? () => onToggleSelect(card.iid) : undefined}
                onDoubleClick={
                  selecting ? undefined : () => moveCard(card.iid, 'battlefield')
                }
                onActivate={
                  selecting
                    ? () => onToggleSelect(card.iid)
                    : () => {
                        refocus.current = i;
                        moveCard(card.iid, 'battlefield');
                      }
                }
                title={
                  selecting
                    ? 'Click or Enter to put on the bottom'
                    : 'Double-click or Enter to play · right-click for options'
                }
              />
            </div>
          ))}
      </div>
    </div>
  );
}
