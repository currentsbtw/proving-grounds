import { useDroppable } from '@dnd-kit/core';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CardData, CardInstance } from '../../domain/types';
import { isLandTypeLine } from '../../domain/typeLine';
import { useGameStore } from '../../state/gameStore';
import { useCardUnit } from './cardGeometry';
import { cardHeight, DraggableCardView } from './CardView';

/**
 * The floor a board card is allowed to shrink to, as a fraction of the ceiling,
 * and the absolute floor under that. Past the floor a full half scrolls instead
 * of shrinking. The ceiling is the card unit itself, so a board card at its
 * largest is exactly a strip card.
 */
const BF_MIN_RATIO = 0.6;
const BF_MIN_FLOOR = 84;

/**
 * Which half of the board a permanent stands in. The shared front-face reading
 * is the whole test, so a modal double-faced card sorts by the face it was
 * played as rather than by the land printed on its back.
 */
function isLand(card: CardInstance, cardData: Record<string, CardData>): boolean {
  const typeLine = card.isToken
    ? (card.tokenSpec?.typeLine ?? '')
    : (card.scryfallId ? (cardData[card.scryfallId]?.typeLine ?? '') : '');
  return isLandTypeLine(typeLine);
}

/**
 * As large as fits: the widest card, up to the card unit, at which every card in
 * this half still stands inside the half without scrolling — wrapping into as
 * many rows as the half's width allows. Five permanents get the full size in one
 * row; a dozen step down until two rows fit; a crowded half bottoms out at the
 * readability floor and scrolls instead of shrinking to slivers.
 *
 * Shrinking a card never fits fewer per row and never needs more rows, so the
 * required height only falls as the width does: the first width that fits,
 * counting down, is the largest one that fits. Gaps and padding are read off the
 * element, so the stylesheet stays the one place either is decided.
 */
function widthForHalf(row: HTMLElement, count: number, max: number, min: number): number {
  if (count === 0) return max;

  const style = getComputedStyle(row);
  const height =
    row.clientHeight -
    Number.parseFloat(style.paddingTop) -
    Number.parseFloat(style.paddingBottom);
  const width =
    row.clientWidth -
    Number.parseFloat(style.paddingLeft) -
    Number.parseFloat(style.paddingRight);
  const rowGap = Number.parseFloat(style.rowGap) || 0;
  const columnGap = Number.parseFloat(style.columnGap) || 0;

  for (let w = max; w > min; w--) {
    const perRow = Math.max(1, Math.floor((width + columnGap) / (w + columnGap)));
    const rows = Math.ceil(count / perRow);
    // CardView rounds the derived height, so measure the rendered height rather
    // than the ideal one — the width that "just fits" on paper can render a
    // pixel taller.
    if (rows * cardHeight(w) + (rows - 1) * rowGap <= height) return w;
  }
  return min;
}

export function Battlefield({ cards }: { cards: CardInstance[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'battlefield' });
  const cardData = useGameStore((s) => s.cardData);
  const toggleTapped = useGameStore((s) => s.toggleTapped);
  // The board's ceiling is the strip's card, so the largest card the board ever
  // prints matches the hand it was played from; the floor holds its distance
  // under it, and never goes below the width at which a face stops reading.
  const max = useCardUnit();
  const min = Math.max(BF_MIN_FLOOR, Math.round(max * BF_MIN_RATIO));

  const rowsRef = useRef<HTMLDivElement | null>(null);

  const [lands, nonlands] = useMemo(() => {
    const l: CardInstance[] = [];
    const n: CardInstance[] = [];
    for (const card of cards) {
      (isLand(card, cardData) ? l : n).push(card);
    }
    return [l, n];
  }, [cards, cardData]);

  // Each half is sized on its own contents, so a spare land row never shrinks a
  // crowded creature row and neither half is held back by the other.
  const [widths, setWidths] = useState<[number, number]>(() => [max, max]);

  const measure = useCallback(() => {
    const box = rowsRef.current;
    if (!box) return;
    const rows = box.querySelectorAll<HTMLElement>('.tbl-bf-row');
    const counts = [nonlands.length, lands.length];
    const next: number[] = [];
    for (const [i, row] of rows.entries()) {
      if (row.clientHeight <= 0) return;
      next.push(widthForHalf(row, counts[i] ?? 0, max, min));
    }
    setWidths((prev) =>
      prev[0] === next[0] && prev[1] === next[1] ? prev : [next[0], next[1]],
    );
  }, [nonlands.length, lands.length, max, min]);

  // Re-measured on resize by the observer, on every change of either half's
  // count — the halves keep their size when cards arrive, so a new permanent
  // resizes nothing the observer would otherwise see — and whenever the card
  // unit moves, which changes the ceiling the fit counts down from.
  useLayoutEffect(() => {
    const box = rowsRef.current;
    if (!box) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    for (const row of box.querySelectorAll('.tbl-bf-row')) observer.observe(row);
    return () => observer.disconnect();
  }, [measure]);

  function renderCard(width: number) {
    return function card(card: CardInstance) {
      return (
        <DraggableCardView
          key={card.iid}
          card={card}
          width={width}
          onClick={() => toggleTapped(card.iid)}
          onActivate={() => toggleTapped(card.iid)}
          title="Click or Enter to tap / untap · right-click for options"
        />
      );
    };
  }

  return (
    <div
      ref={setNodeRef}
      className={`tbl-battlefield tbl-drop${isOver ? ' is-over' : ''}`}
      aria-label="Battlefield"
    >
      {cards.length === 0 && (
        <p className="tbl-bf-empty">
          Battlefield is empty. Double-click a card in hand to play it, or drag it here.
        </p>
      )}

      {/* Both halves always render, and each holds exactly half the board's
          height whatever is in it — neither zone ever grows at the other's
          expense, so nothing moves as permanents arrive. */}
      <div className="tbl-bf-rows" ref={rowsRef}>
        <div className="tbl-bf-row is-nonlands">{nonlands.map(renderCard(widths[0]))}</div>
        <div className="tbl-bf-row is-lands">{lands.map(renderCard(widths[1]))}</div>
      </div>
    </div>
  );
}
