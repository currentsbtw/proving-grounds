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

function pointIn(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * Whether a point falls on the open panel. The panel takes no pointer events —
 * the board under it has to stay clickable — so on a crowded table the browser
 * reports the pointer as being over whatever card the panel is covering, and a
 * hover decision made on that alone swaps the preview to a card the reader
 * cannot see. Every such decision asks this first and treats a hit as the panel.
 */
function overPanel(x: number, y: number): boolean {
  return panelEl !== null && pointIn(panelEl.getBoundingClientRect(), x, y);
}

/** The pointer reached the panel: hold it open, exactly as a keyword does. */
function holdPanel(): void {
  panelHover = true;
  cancelGrace();
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
  /**
   * Clears a stale press latch, keeps a pending open's reading of the pointer
   * current, and pays back the open that entering under the panel withheld.
   */
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
  /** Where the pointer was last seen on this card, kept current by every move. */
  const at = useRef<{ x: number; y: number } | null>(null);
  /**
   * True while this card's hover belongs to the panel rather than to the card:
   * the pointer is on the card only because the open panel covers the part of it
   * under the pointer. The open that hover would have scheduled is owed, and a
   * move onto a part of the card the panel does not cover pays it.
   */
  const viaPanel = useRef(false);
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
    viaPanel.current = false;
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
    viaPanel.current = false;
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

  /**
   * Arm the open, and read the pointer again when it fires rather than trusting
   * where it was armed from: during the wait a panel can open over this card, or
   * the pointer can slide along the card onto the part an open panel covers, and
   * neither is a `pointerleave` this card would hear. An open decided on the
   * stale point is the swap to an unreadable card this all exists to prevent.
   */
  const schedule = useCallback(
    (x: number, y: number) => {
      viaPanel.current = false;
      at.current = { x, y };
      const delay = performance.now() - lastChange < SWAP_WINDOW ? SWAP_DELAY : HOVER_DELAY;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        const p = at.current;
        if (p && overPanel(p.x, p.y)) {
          viaPanel.current = true;
          holdPanel();
          return;
        }
        if (!pointerDown) setOwner(id);
      }, delay);
    },
    [id],
  );

  const onPointerEnter = useCallback(
    (e: ReactPointerEvent) => {
      unlatch(e);
      if (!enabled || pointerDown) return;
      if (e.pointerType === 'touch') return;
      clear();
      at.current = { x: e.clientX, y: e.clientY };
      // The pointer only reached this card by passing through the panel's
      // rectangle, which does not take the pointer itself. Reading the open
      // panel is not a hover on the card it happens to cover, so this holds the
      // panel open the way reaching a keyword in it does, and schedules nothing
      // — until the pointer reaches a part of the card the panel leaves clear.
      if (overPanel(e.clientX, e.clientY)) {
        viaPanel.current = true;
        holdPanel();
        return;
      }
      // Coming back to the card the panel already belongs to calls off the
      // countdown that leaving it started.
      if (owner === id) cancelGrace();
      schedule(e.clientX, e.clientY);
    },
    [clear, enabled, id, schedule, unlatch],
  );

  /**
   * The pointer can cross between the panel's rectangle and the card's own face
   * without ever leaving the card, so a move is the only word this card gets on
   * where inside it the pointer actually is: it keeps a pending open honest, and
   * it opens the panel the entry under the rectangle withheld. A move that never
   * had anything to do with the panel still opens nothing — one is not a fresh
   * hover, and must not put back a panel Escape or a scroll just took down.
   */
  const move = useCallback(
    (e: ReactPointerEvent) => {
      unlatch(e);
      if (!enabled || pointerDown) return;
      if (e.pointerType === 'touch') return;
      if (overPanel(e.clientX, e.clientY)) {
        // Slid under the panel mid-wait: the open is off, and owed again.
        clear();
        viaPanel.current = true;
        holdPanel();
        return;
      }
      at.current = { x: e.clientX, y: e.clientY };
      if (timer.current !== null || owner === id) return;
      if (viaPanel.current) schedule(e.clientX, e.clientY);
    },
    [clear, enabled, id, schedule, unlatch],
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
    onPointerMove: move,
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

  /**
   * The panel's rectangle behaves as if the panel took the pointer, even though
   * it does not: inside it the panel is held open, and leaving it starts the
   * same countdown that leaving the card does. The cards under the panel answer
   * for the part of the rectangle they cover; this answers for the rest of it
   * (empty board, the gap between cards) and for every way out of it.
   */
  useEffect(() => {
    function onMove(e: PointerEvent): void {
      // A touch drag is not a hover: one that ends inside the rectangle used to
      // leave the panel held open for good, and every later countdown — a
      // keyboard-toggled panel's included — with nothing to close.
      if (e.pointerType === 'touch') return;
      if (overPanel(e.clientX, e.clientY)) {
        if (!panelHover) holdPanel();
        return;
      }
      if (!panelHover) return;
      panelHover = false;
      // Stepping back onto the card the panel belongs to is not leaving it:
      // that card's own hover holds the panel, and its `pointerenter` has
      // already fired by the time this move is heard.
      const host = anchor.current;
      if (host && pointIn(host.getBoundingClientRect(), e.clientX, e.clientY)) {
        cancelGrace();
        return;
      }
      closeAfterGrace(id);
    }
    window.addEventListener('pointermove', onMove, true);
    return () => window.removeEventListener('pointermove', onMove, true);
  }, [anchor, id]);

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
      // inside it, which does. Reaching one holds the panel open; leaving one
      // for the panel's own body is not leaving the panel at all, so it only
      // hands back to the countdown once the pointer is out of the rectangle.
      onPointerEnter={holdPanel}
      onPointerLeave={(e) => {
        if (overPanel(e.clientX, e.clientY)) return;
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
