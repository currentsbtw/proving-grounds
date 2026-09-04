import type { FocusEvent as ReactFocusEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { KeywordEntry } from '../../data/keywords';
import { KEYWORDS, lookupKeyword } from '../../data/keywords';
import './glossary.css';

/**
 * Prints rules text with every glossary keyword in it hoverable.
 *
 * The trainer's whole job is reading a board under time pressure, and the thing
 * that stalls that read is a word the player half-knows. So the definition is
 * put where the word already is rather than in a reference screen nobody opens
 * mid-run: hover or focus the word, read two sentences, carry on.
 */

/* ── Tokenizer ───────────────────────────────────────────────────────────── */

export interface GlossRun {
  /** The slice of the source text, verbatim — glossing never rewrites the card. */
  text: string;
  /** Set when this run is a glossary term. */
  entry?: KeywordEntry;
}

function escapeForPattern(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One alternation over every term, longest first: regex alternation takes the
 * first branch that matches at a position, so "first strike" has to be offered
 * before "strike" would be, or the multi-word terms get eaten a word at a time.
 * `\b` keeps it whole-word — "scry" must not light up inside a card named
 * Scryb Sprites. Built once; `matchAll` works on a copy, so it stays reentrant.
 */
const TERM_PATTERN = new RegExp(
  `\\b(${[...KEYWORDS]
    .map((entry) => entry.term)
    .sort((a, b) => b.length - a.length)
    .map(escapeForPattern)
    .join('|')})\\b`,
  'gi',
);

/**
 * Splits rules text into plain runs and keyword runs. A pure function of `text`
 * — same input, same runs — which is what makes it testable on its own and what
 * lets the component render without state.
 */
export function tokenizeGloss(text: string): GlossRun[] {
  const runs: GlossRun[] = [];
  let at = 0;

  for (const match of text.matchAll(TERM_PATTERN)) {
    const start = match.index ?? 0;
    const entry = lookupKeyword(match[0]);
    if (!entry) continue;
    if (start > at) runs.push({ text: text.slice(at, start) });
    runs.push({ text: match[0], entry });
    at = start + match[0].length;
  }
  if (at < text.length) runs.push({ text: text.slice(at) });

  return runs;
}

/** True when `text` has at least one keyword worth hovering. */
export function hasGloss(text: string): boolean {
  return tokenizeGloss(text).some((run) => run.entry !== undefined);
}

/* ── Placement ───────────────────────────────────────────────────────────── */

/** Matches `--gl-tip-w` in glossary.css. */
const TIP_WIDTH = 240;
const TIP_GAP = 6;
const TIP_EDGE = 8;
/**
 * Enough room for the tallest pane the glossary prints. Below this much space
 * over the word, the pane flips under it instead — which is the common case in
 * a card preview, where the oracle text can sit near the top of the screen.
 */
const TIP_ROOM = 132;

/**
 * Writes the pane's viewport coordinates onto the word as custom properties.
 *
 * The pane is `position: fixed` so no overflow container between it and the
 * viewport can clip it — the card preview it first appears inside is a
 * scrolling, clipped panel — and fixed means it has to be told where the word
 * is. Done by hand on the DOM node rather than through state: which word is
 * open is decided by CSS `:hover`/`:focus`, and a re-render per hovered word
 * would be a state machine for something the browser already tracks.
 */
function place(host: HTMLElement): void {
  const rect = host.getBoundingClientRect();
  const left = Math.min(
    Math.max(TIP_EDGE, rect.left + rect.width / 2 - TIP_WIDTH / 2),
    Math.max(TIP_EDGE, window.innerWidth - TIP_WIDTH - TIP_EDGE),
  );
  const below = rect.top < TIP_ROOM;

  host.style.setProperty('--gl-x', `${Math.round(left)}px`);
  host.style.setProperty('--gl-top', `${Math.round(rect.bottom + TIP_GAP)}px`);
  host.style.setProperty(
    '--gl-bottom',
    `${Math.round(window.innerHeight - rect.top + TIP_GAP)}px`,
  );
  host.dataset.glSide = below ? 'below' : 'above';
}

/* ── Component ───────────────────────────────────────────────────────────── */

interface GlossedProps {
  /** Rules text, printed verbatim. Newlines are kept. */
  text: string;
  className?: string;
}

/**
 * Inline by design: it renders a `<span>`, so it can stand in for a text node
 * anywhere the app prints rules text without changing that element's layout.
 */
export function Glossed({ text, className }: GlossedProps) {
  const runs = tokenizeGloss(text);

  return (
    <span className={className ? `gl ${className}` : 'gl'}>
      {runs.map((run, i) => {
        if (!run.entry) return <span key={i}>{run.text}</span>;
        const entry = run.entry;
        return (
          <span
            key={i}
            className="gl-kw"
            tabIndex={0}
            onPointerEnter={(e: ReactPointerEvent<HTMLSpanElement>) => place(e.currentTarget)}
            onFocus={(e: ReactFocusEvent<HTMLSpanElement>) => place(e.currentTarget)}
          >
            {run.text}
            {/*
              Hidden from assistive technology on purpose. These panes are
              children of the text they gloss, and the card preview hands that
              whole block to a screen reader as the card's description — so left
              visible to it, an oracle text with six keywords in it would be read
              back as six definitions interleaved with the card. The rules text
              is read once; the panes are for the eye.
            */}
            <span className="gl-tip" aria-hidden="true">
              <span className="gl-tip-term">{entry.term}</span>
              <span className="gl-tip-text">{entry.text}</span>
              <span className="gl-tip-cr num">CR {entry.cr}</span>
            </span>
          </span>
        );
      })}
    </span>
  );
}

export default Glossed;
