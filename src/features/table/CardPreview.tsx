import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { CardData, CardInstance } from '../../domain/types';
import { Glossed } from '../glossary/Glossed';
import { CARD_ASPECT } from './cardGeometry';

/** Widest the panel gets. The image fills it, so this is the printed card size. */
const PREVIEW_WIDTH = 312;
/** Narrowest the panel is allowed to shrink to before it starts overlapping. */
const MIN_WIDTH = 180;
/** Gap between the card and the panel, and between the panel and the viewport. */
const GAP = 10;
const EDGE = 8;

/** How long the pointer has to rest before the panel appears. */
const HOVER_DELAY = 350;
/**
 * The delay once a preview is already in play. Reading down a hand means moving
 * card to card, and paying the full rest every time reads as a stall.
 */
const SWAP_DELAY = 90;
const SWAP_WINDOW = 450;
/**
 * How long the panel survives the pointer leaving the card. The oracle text in
 * it is glossed, so a keyword in it is something to point at, and the trip from
 * the card to that word crosses the gap between them. Short enough that a
 * pointer heading anywhere else never notices it.
 */
const LEAVE_GRACE = 220;

/* ── Controller ──────────────────────────────────────────────────────────── */

/**
 * One preview at a time, owned by a mount token rather than a card instance id:
 * the same instance can be on screen twice (the dock's picker while the hand
 * still shows the card, the browse overlay over its zone stack), and keying by
 * iid put a panel up from each of them. The token is the hovered or focused
 * mount's own, so exactly one of them draws the panel. Kept in module scope
 * rather than a store: nothing here is run state, and every card on the table
 * subscribes to it, so it has to be cheaper than a render.
 */
let owner: string | null = null;
let lastChange = 0;
let pointerDown = false;
let installed = false;
/** True while the pointer is inside the open panel itself. */
let panelHover = false;
let grace: number | null = null;
/**
 * The open panel's element, so the global press handler can tell a press on a
 * glossed keyword inside it from a press anywhere else. Registered by the panel
 * rather than looked up, because it is portalled out of the card's subtree.
 */
let panelEl: HTMLElement | null = null;
const listeners = new Set<() => void>();

function setOwner(next: string | null): void {
  if (owner === next) return;
  owner = next;
  lastChange = performance.now();
  // Whatever the last panel knew about the pointer died with it.
  panelHover = false;
  for (const listener of listeners) listener();
}

function cancelGrace(): void {
  if (grace === null) return;
  window.clearTimeout(grace);
  grace = null;
}

/**
 * Close, but leave the panel up long enough for the pointer to reach it. The
 * check is deferred rather than the close: a panel the pointer landed on stays,
 * and one the owner has already changed out from under is left alone.
 */
function closeAfterGrace(id: string): void {
  cancelGrace();
  grace = window.setTimeout(() => {
    grace = null;
    if (!panelHover && owner === id) setOwner(null);
  }, LEAVE_GRACE);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * A pressed pointer is either a click on its way or a drag on its way; neither
 * wants a panel over the board. Watched globally because the press that starts
 * a drag belongs to the drag library, not to this.
 */
function install(): void {
  if (installed) return;
  installed = true;
  window.addEventListener(
    'pointerdown',
    (e) => {
      pointerDown = true;
      // A press inside the panel is the one press that is not on its way
      // somewhere else: it is a click on a glossed keyword, which focuses the
      // word and holds its definition open. Taking the panel down under it
      // would make the keyword unclickable and its tooltip unfocusable.
      const target = e.target;
      if (panelEl && target instanceof Node && panelEl.contains(target)) return;
      setOwner(null);
    },
    true,
  );
  const release = (): void => {
    pointerDown = false;
  };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  // A release the window never hears — the button let go outside the browser,
  // the tab switched away mid-press — used to leave the latch down for the rest
  // of the session, and every hover preview dead behind it.
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') release();
  });
}

export interface CardPreviewHandle {
  /** True while this card owns the preview. */
  open: boolean;
  /** Id of the panel, for `aria-describedby` while it is up. */
  id: string;
  onPointerEnter: (e: ReactPointerEvent) => void;
  /** Clears a stale press latch; it never opens a panel on its own. */
  onPointerMove: (e: ReactPointerEvent) => void;
  /** Closes after a grace period, so the pointer can reach the panel. */
  onPointerLeave: () => void;
  toggle: () => void;
  /** Closes at once — Escape, a scroll, the card leaving the table. */
  close: () => void;
}

/**
 * Hover and hotkey plumbing for one card's preview. `enabled` is false for the
 * cards that have nothing to show (face down, no Scryfall data) and for a card
 * that is mid-drag.
 */
export function useCardPreview(enabled: boolean): CardPreviewHandle {
  // One id does both jobs: it names the panel for `aria-describedby` and it is
  // the ownership token, unique to this mount of this card.
  const id = useId();
  const timer = useRef<number | null>(null);
  const open = useSyncExternalStore(
    subscribe,
    () => owner === id,
    () => false,
  );

  useEffect(() => {
    install();
  }, []);

  const clear = useCallback(() => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  // The grace timer is only ever this card's to cancel while this card owns the
  // panel; another card unmounting must not call off a countdown that is not its
  // own, which would leave the open panel with nothing left to close it.
  const close = useCallback(() => {
    clear();
    if (owner !== id) return;
    cancelGrace();
    setOwner(null);
  }, [clear, id]);

  /**
   * The pointer leaving the card is not the end of the panel any more: it may
   * be on its way to a glossed keyword in the oracle text. A pending open is
   * still cancelled outright — that hover never became a panel.
   */
  const leave = useCallback(() => {
    clear();
    if (owner === id) closeAfterGrace(id);
  }, [clear, id]);

  // A card that leaves the table (played, moved, run ended) takes its preview
  // with it; so does one that stops being previewable mid-hover.
  useEffect(() => {
    if (!enabled) close();
  }, [enabled, close]);
  useEffect(() => close, [close]);

  /**
   * A pointer event carrying no buttons is proof the latch is stale, whatever
   * the window heard: clear it before anything is decided on it. Kept off the
   * open path on purpose — a move is not a fresh hover, so it must not reopen
   * the panel a moment after Escape or a scroll took it down.
   */
  const unlatch = useCallback((e: ReactPointerEvent) => {
    if (e.buttons === 0) pointerDown = false;
  }, []);

  const onPointerEnter = useCallback(
    (e: ReactPointerEvent) => {
      unlatch(e);
      if (!enabled || pointerDown) return;
      if (e.pointerType === 'touch') return;
      clear();
      // Coming back to the card the panel already belongs to calls off the
      // countdown that leaving it started.
      if (owner === id) cancelGrace();
      const delay = performance.now() - lastChange < SWAP_WINDOW ? SWAP_DELAY : HOVER_DELAY;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        if (!pointerDown) setOwner(id);
      }, delay);
    },
    [clear, enabled, id, unlatch],
  );

  const toggle = useCallback(() => {
    if (!enabled) return;
    clear();
    setOwner(owner === id ? null : id);
  }, [clear, enabled, id]);

  return {
    open,
    id,
    onPointerEnter,
    onPointerMove: unlatch,
    onPointerLeave: leave,
    toggle,
    close,
  };
}

/* ── Panel ───────────────────────────────────────────────────────────────── */

interface Placement {
  left: number;
  top: number;
  width: number;
}

interface CardPreviewProps {
  id: string;
  card: CardInstance;
  data: CardData | undefined;
  /** The card element the panel sits beside. */
  anchor: RefObject<HTMLElement | null>;
  onDismiss: () => void;
}

/**
 * The large face and its oracle text, portalled to the body so no overflow
 * container on the table can clip it. Never interactive: it is a tooltip, and
 * `pointer-events: none` keeps it out of the hover it was opened by.
 */
export function CardPreview({ id, card, data, anchor, onDismiss }: CardPreviewProps) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Placement | null>(null);

  // Only one panel is ever up, so the module can hold the open one for the
  // global press handler to test a press against.
  useLayoutEffect(() => {
    panelEl = box.current;
    return () => {
      panelEl = null;
    };
  }, []);

  useLayoutEffect(() => {
    function place(): void {
      const el = box.current;
      const host = anchor.current;
      if (!el || !host) return;

      const rect = host.getBoundingClientRect();
      const roomRight = window.innerWidth - rect.right - GAP - EDGE;
      const roomLeft = rect.left - GAP - EDGE;
      // Width is decided before measuring: the panel takes what the wider side
      // of the card can give it, up to a printed card's worth.
      const width = Math.max(MIN_WIDTH, Math.min(PREVIEW_WIDTH, Math.max(roomRight, roomLeft)));
      el.style.width = `${width}px`;

      const height = el.offsetHeight;
      const toRight = roomRight >= width || roomRight >= roomLeft;
      const wanted = toRight ? rect.right + GAP : rect.left - GAP - width;
      const left = Math.min(
        Math.max(EDGE, wanted),
        Math.max(EDGE, window.innerWidth - width - EDGE),
      );
      const top = Math.min(
        Math.max(EDGE, rect.top + rect.height / 2 - height / 2),
        Math.max(EDGE, window.innerHeight - height - EDGE),
      );
      setPos({ left, top, width });
    }

    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor, card.iid, data]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onDismiss();
    }
    // Capture, because the board scrolls inside its own panes rather than at
    // the window: a scrolled card leaves its panel behind otherwise.
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onDismiss, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onDismiss, true);
    };
  }, [onDismiss]);

  const spec = card.tokenSpec;
  const name = card.isToken ? (spec?.name ?? 'Token') : (data?.name ?? 'Unknown card');
  const typeLine = card.isToken ? spec?.typeLine : data?.typeLine;
  const cost = card.isToken ? undefined : data?.manaCost;
  const oracle = card.isToken ? undefined : data?.oracleText;
  const image = card.isToken ? undefined : data?.imageNormal;
  const pt =
    card.isToken && spec?.power && spec?.toughness ? `${spec.power}/${spec.toughness}` : null;

  return createPortal(
    <div
      ref={box}
      id={id}
      role="tooltip"
      className="tbl-preview"
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        width: pos?.width ?? PREVIEW_WIDTH,
        visibility: pos ? 'visible' : 'hidden',
      }}
      // The panel itself never takes the pointer — the board under it has to
      // stay clickable — so these only ever fire by way of a glossed keyword
      // inside it, which does. Reaching one holds the panel open; leaving it
      // starts the countdown again rather than closing outright, so the pointer
      // can carry on to the next keyword.
      onPointerEnter={() => {
        panelHover = true;
        cancelGrace();
      }}
      onPointerLeave={() => {
        panelHover = false;
        closeAfterGrace(id);
      }}
    >
      {image && (
        <img
          className="tbl-preview-img"
          src={image}
          alt=""
          style={{ aspectRatio: `1 / ${CARD_ASPECT}` }}
          decoding="async"
          draggable={false}
          onError={(e) => {
            e.currentTarget.hidden = true;
          }}
        />
      )}
      <div className="tbl-preview-text">
        <div className="tbl-preview-head">
          <span className="tbl-preview-name">{name}</span>
          {cost && <span className="tbl-preview-cost">{cost}</span>}
        </div>
        {pt && <div className="tbl-preview-pt num">{pt}</div>}
        {typeLine && <div className="tbl-preview-type">{typeLine}</div>}
        {oracle && (
          <div className="tbl-preview-oracle">
            <Glossed text={oracle} />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export default CardPreview;
