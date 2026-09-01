import { useDroppable } from '@dnd-kit/core';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { CardInstance } from '../../domain/types';
import { useGameStore } from '../../state/gameStore';
import { DraggableCardView } from './CardView';

/** Comfortable width; the hand never renders a card wider than this. */
const CARD_MAX = 120;
/** Readability floor. Past this the hand overlaps instead of shrinking. */
const CARD_MIN = 70;
/** Breathing room between cards while they still fit side by side. */
const GAP = 8;
/** Smallest distance between two card left edges when overlapping. */
const STEP_MIN = 12;

interface HandLayout {
  /** Rendered card width in px. */
  width: number;
  /** Distance between the left edges of two neighbouring cards. */
  step: number;
}

/**
 * Fit `count` cards into `avail` px without ever scrolling: shrink first, then
 * overlap. `step < width` means the cards overlap by `width - step`.
 */
function handLayout(avail: number, count: number): HandLayout {
  if (count <= 0 || avail <= 0) return { width: CARD_MAX, step: CARD_MAX + GAP };

  const spread = Math.min(CARD_MAX, (avail - (count - 1) * GAP) / count);
  if (spread >= CARD_MIN) {
    const width = Math.floor(spread);
    return { width, step: width + GAP };
  }

  const width = CARD_MIN;
  if (count === 1) return { width, step: width + GAP };
  return { width, step: Math.max(STEP_MIN, (avail - width) / (count - 1)) };
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

  const boxRef = useRef<HTMLDivElement | null>(null);
  const [avail, setAvail] = useState(0);

  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      boxRef.current = el;
      setNodeRef(el);
    },
    [setNodeRef],
  );

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

  const { width, step } = handLayout(avail, cards.length);
  const overlap = step - width;

  return (
    <div
      ref={setRefs}
      className={`tbl-hand tbl-drop${isOver ? ' is-over' : ''}`}
      aria-label="Hand"
    >
      {cards.length === 0 && <p className="tbl-hand-empty">Hand is empty</p>}

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
              width={width}
              selected={selecting && selected.includes(card.iid)}
              onClick={selecting ? () => onToggleSelect(card.iid) : undefined}
              onDoubleClick={
                selecting ? undefined : () => moveCard(card.iid, 'battlefield')
              }
              title={
                selecting
                  ? 'Click to put on the bottom'
                  : 'Double-click to play · right-click for options'
              }
            />
          </div>
        ))}
    </div>
  );
}
