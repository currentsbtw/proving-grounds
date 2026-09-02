import { useDraggable } from '@dnd-kit/core';
import type { DraggableAttributes } from '@dnd-kit/core';
import { useCallback, useRef } from 'react';
import type { HTMLAttributes, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { isLandTypeLine } from '../../domain/typeLine';
import type { CardData, CardInstance } from '../../domain/types';
import { useGameStore } from '../../state/gameStore';
import { normalizeKey, useHotkeyStore } from '../../state/hotkeyStore';
import { useCardMenu } from './CardMenu';
import { CardPreview, useCardPreview } from './CardPreview';
import { CARD_ASPECT, cardHeight } from './cardGeometry';

export { CARD_ASPECT, cardHeight };

export function counterLabel(kind: string, n: number): string {
  return kind.includes('/') ? `${kind} ×${n}` : `${kind} ${n}`;
}

function counterClass(kind: string): string {
  if (kind.includes('/')) return ' is-plus';
  if (kind === 'loyalty') return ' is-loyalty';
  return '';
}

/**
 * The number for the mana-value badge, or null when the badge would be noise:
 * tokens, face-down cards, cards whose Scryfall data has not resolved, and
 * plain lands (which are always mana value 0).
 */
function manaValueBadge(
  card: CardInstance,
  data: CardData | undefined,
  faceDown?: boolean,
): number | null {
  if (card.isToken || card.faceDown || faceDown) return null;
  if (!data) return null;
  if (data.manaValue === 0 && isLandTypeLine(data.typeLine)) return null;
  return data.manaValue;
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
  /** Mana-value badge. Defaults to true; off for tiny stack previews. */
  badge?: boolean;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  onDoubleClick?: (e: MouseEvent<HTMLDivElement>) => void;
  /**
   * What Enter and Space do to this card while it holds keyboard focus: play it
   * from hand, tap or untap it on the battlefield. The drag library already
   * makes every card a `role="button"` tab stop, so without this the cards were
   * the one thing on the table the keyboard could reach and not use.
   */
  onActivate?: () => void;
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
        // Scryfall's images come off a CDN this app does not control. An image
        // that never arrives leaves the printed frame underneath as the card,
        // which is readable; a broken-image glyph laid over it is not.
        onError={(e) => {
          e.currentTarget.hidden = true;
        }}
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
    badge = true,
    onClick,
    onDoubleClick,
    onActivate,
    title,
  } = props;

  const data = useGameStore((s) => (card.scryfallId ? s.cardData[card.scryfallId] : undefined));
  const openMenu = useCardMenu();

  // The panel sits beside this element, so the preview needs the node the drag
  // library is already holding.
  const host = useRef<HTMLDivElement | null>(null);
  const dndRef = dnd?.setNodeRef;
  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      host.current = el;
      dndRef?.(el);
    },
    [dndRef],
  );

  // Nothing to preview for a face-down card, a card whose Scryfall data has not
  // arrived, or a token with no spec. A card being dragged, and the drag
  // overlay's copy of it, are both off limits: the card is in the air.
  const previewable =
    !faceDown &&
    !card.faceDown &&
    !lifted &&
    !dnd?.isDragging &&
    (card.isToken ? Boolean(card.tokenSpec) : Boolean(card.scryfallId && data));
  const preview = useCardPreview(previewable);

  const height = cardHeight(width);
  const interactive = Boolean(onClick || onDoubleClick || dnd);

  // The drag library points `aria-describedby` at its own keyboard
  // instructions, so the preview is added to that list rather than over it.
  const describedBy =
    [dnd?.attributes['aria-describedby'], preview.open ? preview.id : null]
      .filter(Boolean)
      .join(' ') || undefined;

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (onActivate && (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')) {
      e.preventDefault();
      e.stopPropagation();
      onActivate();
      return;
    }
    if (!previewable || e.metaKey || e.ctrlKey || e.altKey) return;
    // Read the binding at press time: the key is rebindable and every card on
    // the table would otherwise subscribe to the keymap.
    if (normalizeKey(e.nativeEvent) !== useHotkeyStore.getState().keymap.preview) return;
    e.preventDefault();
    e.stopPropagation();
    preview.toggle();
  }

  const classes = ['tbl-card'];
  if (card.tapped) classes.push('is-tapped');
  if (card.isCommander) classes.push('is-commander');
  if (selected) classes.push('is-selected');
  if (ghost || dnd?.isDragging) classes.push('is-ghost');
  if (lifted) classes.push('is-lifted');
  if (interactive) classes.push('is-interactive');

  const counters = Object.entries(card.counters).filter(([, n]) => n > 0);
  const manaValue = badge ? manaValueBadge(card, data, faceDown) : null;

  const inner = (
    <div
      ref={setRefs}
      className={classes.join(' ')}
      title={title}
      // The global hotkey listener stands down for a keyboard-focused card
      // carrying this attribute, which is what lets Space reach the card here
      // instead of stepping the phase behind it. (The preview key needs no such
      // attribute: the global listener stands down for it everywhere.)
      data-card-activate={onActivate ? '' : undefined}
      // Which card the keyboard is on, for the global hotkeys that act on the
      // focused card without the card itself having to own the binding.
      data-card-iid={card.iid}
      onPointerEnter={preview.onPointerEnter}
      onPointerMove={preview.onPointerMove}
      onPointerLeave={preview.onPointerLeave}
      // Tab moving off the card takes the panel with it.
      onBlur={preview.close}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      // A mouse press focuses the card, and a focused card owns Enter and
      // Space. The pilot who just clicked a permanent still means "next phase"
      // when they hit Space, so the pointer hands focus straight back; only Tab
      // leaves a card holding it. (`:focus-visible` cannot be used to tell the
      // two apart here: pressing a key on a pointer-focused element makes it
      // match, which is exactly the moment the answer is needed.)
      onPointerUp={
        onActivate
          ? (e) => {
              e.currentTarget.blur();
            }
          : undefined
      }
      onKeyDown={onKeyDown}
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
      aria-describedby={describedBy}
    >
      <div className="tbl-card-face">
        <CardArt card={card} data={data} small={small} faceDown={faceDown} />
      </div>
      {manaValue !== null && (
        <span className="tbl-mv num" aria-label={`Mana value ${manaValue}`}>
          {manaValue}
        </span>
      )}
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
      {preview.open && (
        <CardPreview
          id={preview.id}
          card={card}
          data={data}
          anchor={host}
          onDismiss={preview.close}
        />
      )}
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
