import { useDraggable } from '@dnd-kit/core';
import type { DraggableAttributes } from '@dnd-kit/core';
import type { HTMLAttributes, MouseEvent, ReactNode } from 'react';
import type { CardData, CardInstance } from '../../domain/types';
import { useGameStore } from '../../state/gameStore';
import { useCardMenu } from './CardMenu';

/** Standard MTG card aspect (height / width). */
export const CARD_ASPECT = 1.396;

export function cardHeight(width: number): number {
  return Math.round(width * CARD_ASPECT);
}

export function counterLabel(kind: string, n: number): string {
  return kind.includes('/') ? `${kind} ×${n}` : `${kind} ${n}`;
}

function counterClass(kind: string): string {
  if (kind.includes('/')) return ' is-plus';
  if (kind === 'loyalty') return ' is-loyalty';
  return '';
}

export interface CardViewProps {
  card: CardInstance;
  /** Rendered width in px; height is derived from the card aspect. */
  width?: number;
  /** Prefer the small Scryfall image (stack previews, dense grids). */
  small?: boolean;
  faceDown?: boolean;
  selected?: boolean;
  /** Dimmed because this card is the drag source. */
  ghost?: boolean;
  /** Drag-overlay styling (shadow, grab cursor). */
  lifted?: boolean;
  /** Right-click context menu. Defaults to true. */
  menu?: boolean;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  onDoubleClick?: (e: MouseEvent<HTMLDivElement>) => void;
  title?: string;
}

interface DndBits {
  setNodeRef: (el: HTMLElement | null) => void;
  listeners: HTMLAttributes<HTMLDivElement>;
  attributes: DraggableAttributes;
  isDragging: boolean;
}

function CardArt({
  card,
  data,
  small,
  faceDown,
}: {
  card: CardInstance;
  data: CardData | undefined;
  small?: boolean;
  faceDown?: boolean;
}): ReactNode {
  if (faceDown || card.faceDown) {
    return <div className="tbl-frame is-facedown" />;
  }

  if (card.isToken) {
    const spec = card.tokenSpec;
    const pt = spec?.power && spec?.toughness ? `${spec.power}/${spec.toughness}` : null;
    return (
      <div className="tbl-frame is-token">
        <div className="tbl-frame-name">{spec?.name ?? 'Token'}</div>
        {pt && <div className="tbl-frame-pt">{pt}</div>}
        {spec?.typeLine && <div className="tbl-frame-type">{spec.typeLine}</div>}
      </div>
    );
  }

  // The text frame always renders underneath, so a card is readable before its
  // image decodes and stays readable if the image never arrives.
  const frame = (
    <div className="tbl-frame">
      <div className="tbl-frame-top">
        <div className="tbl-frame-name">{data?.name ?? 'Unknown card'}</div>
        {data?.manaCost && <div className="tbl-frame-cost">{data.manaCost}</div>}
      </div>
      {data?.typeLine && <div className="tbl-frame-type">{data.typeLine}</div>}
    </div>
  );

  const src = small ? (data?.imageSmall ?? data?.imageNormal) : (data?.imageNormal ?? data?.imageSmall);
  if (!src) return frame;

  return (
    <>
      {frame}
      <img
        className="tbl-card-img"
        src={src}
        alt={data?.name ?? 'Card'}
        loading="lazy"
        decoding="async"
        draggable={false}
      />
    </>
  );
}

function CardFrame({ props, dnd }: { props: CardViewProps; dnd?: DndBits }) {
  const {
    card,
    width = 140,
    small,
    faceDown,
    selected,
    ghost,
    lifted,
    menu = true,
    onClick,
    onDoubleClick,
    title,
  } = props;

  const data = useGameStore((s) => (card.scryfallId ? s.cardData[card.scryfallId] : undefined));
  const openMenu = useCardMenu();

  const height = cardHeight(width);
  const interactive = Boolean(onClick || onDoubleClick || dnd);

  const classes = ['tbl-card'];
  if (card.tapped) classes.push('is-tapped');
  if (card.isCommander) classes.push('is-commander');
  if (selected) classes.push('is-selected');
  if (ghost || dnd?.isDragging) classes.push('is-ghost');
  if (lifted) classes.push('is-lifted');
  if (interactive) classes.push('is-interactive');

  const counters = Object.entries(card.counters).filter(([, n]) => n > 0);

  const inner = (
    <div
      ref={dnd?.setNodeRef}
      className={classes.join(' ')}
      title={title}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={
        menu
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              openMenu(card.iid, e.clientX, e.clientY);
            }
          : undefined
      }
      {...(dnd?.attributes ?? {})}
      {...(dnd?.listeners ?? {})}
    >
      <div className="tbl-card-face">
        <CardArt card={card} data={data} small={small} faceDown={faceDown} />
      </div>
      {counters.length > 0 && (
        <div className="tbl-counters">
          {counters.map(([kind, n]) => (
            <span key={kind} className={`tbl-counter${counterClass(kind)}`}>
              {counterLabel(kind, n)}
            </span>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="tbl-slot" style={{ width, height }}>
      {inner}
    </div>
  );
}

/** Non-draggable card. Use inside overlays and stack previews. */
export function CardView(props: CardViewProps) {
  return <CardFrame props={props} />;
}

/** Draggable card. Only mount one per card instance inside a DndContext. */
export function DraggableCardView(props: CardViewProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: props.card.iid });
  const dnd: DndBits = {
    setNodeRef,
    attributes,
    listeners: (listeners ?? {}) as unknown as HTMLAttributes<HTMLDivElement>,
    isDragging,
  };
  return <CardFrame props={props} dnd={dnd} />;
}
