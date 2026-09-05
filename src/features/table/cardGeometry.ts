import { useSyncExternalStore } from 'react';

/** Standard MTG card aspect (height / width). */
export const CARD_ASPECT = 1.396;

/** The registered property's own initial value, for a read that finds nothing. */
const FALLBACK = 105;

/**
 * The card unit, in px: `--card-w` off the root element.
 *
 * The token is registered in tokens.css with a `<length>` syntax, which is what
 * makes this a number rather than the literal text of a `clamp()` — the browser
 * resolves it against the current window and hands back one figure, so nothing
 * here has to re-derive the rule the stylesheet already states.
 *
 * A whole pixel: the battlefield fits its cards by counting widths down one at a
 * time, so a card at the board's ceiling and a card in hand have to be the same
 * integer or they print a pixel apart in height. The token itself is rounded in
 * CSS — `round(clamp(...), 1px)` in tokens.css — so the figure the stylesheet
 * draws frames and empty slots at is the same integer this hands back; the round
 * here is the floor under a browser that resolves the token some other way.
 */
export function readCardUnit(): number {
  if (typeof document === 'undefined') return FALLBACK;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--card-w');
  const px = Number.parseFloat(raw);
  return Number.isFinite(px) && px > 0 ? Math.round(px) : FALLBACK;
}

/* One observer and one cached reading for the whole app: every card on the
   table asks for the same number at the same moment, and `getComputedStyle` on
   each of them is a forced layout each of them does not need. The read is
   deferred to an animation frame, so a drag-resize costs one reading a frame
   and nothing measures the document from inside a resize callback.

   The root element is watched rather than the window, because the root's box is
   what the `vw` and `vh` in the token resolve against: it moves for a window
   resize, for a zoom step, and for an emulated viewport, where a bare `resize`
   listener hears nothing at all. */
let cached: number | null = null;
let queued = 0;
let observer: ResizeObserver | null = null;
const listeners = new Set<() => void>();

function publish(): void {
  queued = 0;
  const next = readCardUnit();
  if (next === cached) return;
  cached = next;
  for (const listener of listeners) listener();
}

function schedule(): void {
  if (queued !== 0) return;
  queued = requestAnimationFrame(publish);
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    observer = new ResizeObserver(schedule);
    observer.observe(document.documentElement);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    observer?.disconnect();
    observer = null;
    // Nothing is watching the root any more, so a resize while the table is
    // unmounted would go unheard and leave this reading behind for the next
    // mount to start from. Dropped, so the next snapshot measures afresh.
    cached = null;
    if (queued !== 0) cancelAnimationFrame(queued);
    queued = 0;
  };
}

function getSnapshot(): number {
  cached ??= readCardUnit();
  return cached;
}

function getServerSnapshot(): number {
  return FALLBACK;
}

/** The card unit, re-read whenever the window changes size. */
export function useCardUnit(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function cardHeight(width: number): number {
  return Math.round(width * CARD_ASPECT);
}
