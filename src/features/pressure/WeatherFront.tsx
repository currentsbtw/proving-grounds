import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { SeatId } from '../../domain/types';
import { useGameStore } from '../../state/gameStore';
import { EVENT_LABEL } from './pressureUi';

/** How long the word that has just been answered stays struck through. */
const SPENT_MS = 600;
/** Per-letter stagger, and the ceiling the whole word settles inside. */
const STEP_MS = 24;
const STAGGER_CAP_MS = 300;
/** The rain strip's own height in px, matching `.pgf-rain`: every drop sits inside it. */
const RAIN_H = 40;

/**
 * FNV-1a over a string. The front has to look scattered and be the same scatter
 * every time the same event forms — a replayed run, a re-render, a second
 * monitor — so nothing here reaches for `Math.random`.
 */
function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface Letter {
  char: string;
  /** How far up this letter starts, 0–14px. */
  offset: number;
  /** When it starts settling. */
  delay: number;
  /** One of the last letters, which hold the silver flash until they land. */
  flash: boolean;
}

/** The class word broken into letters, each with its own start and stagger. */
function lettersOf(id: string, word: string): Letter[] {
  const glyphs = [...word];
  const count = glyphs.filter((c) => c !== ' ').length;
  // Two letters trail in silver, three once the word is long enough to carry it.
  const flashFrom = count - (count >= 9 ? 3 : 2);
  let seen = 0;
  return glyphs.map((char) => {
    if (char === ' ') return { char, offset: 0, delay: 0, flash: false };
    const i = seen;
    seen += 1;
    return {
      char,
      offset: hash(`${id}:${i}`) % 15,
      delay: Math.min(i * STEP_MS, STAGGER_CAP_MS),
      flash: i >= flashFrom,
    };
  });
}

interface Drop {
  /** A letter of the word this rain fell out of. */
  char: string;
  /** Percentage across the strip, so the rain stays inside the word's measure. */
  x: number;
  /** Pixels down the strip, always inside it: the rain never reaches the cards. */
  y: number;
  size: number;
  /** The few that keep the word's ink, against the rain grey of the rest. */
  ink: boolean;
}

/**
 * Fourteen to twenty small letterforms under the word, at fixed places per
 * event: the word coming apart into its own glyphs rather than into bars. The
 * letters are drawn from the class word itself, so the rain under COUNTERSPELL
 * is made of counterspell.
 */
function dropsOf(id: string, word: string): Drop[] {
  const glyphs = [...word].filter((c) => c !== ' ');
  if (glyphs.length === 0) return [];
  const count = 14 + (hash(`${id}#n`) % 7);
  const span = 92 / count;
  const drops: Drop[] = [];
  for (let i = 0; i < count; i += 1) {
    const j = hash(`${id}#${i}`);
    const size = 10 + (j % 3);
    // Each glyph gets its own share of the width and drifts inside it, so the
    // scatter reads as rain rather than as an evenly spaced row.
    drops.push({
      char: glyphs[(j >>> 3) % glyphs.length],
      x: 4 + i * span + (((j >>> 7) % 100) / 100) * span * 0.6,
      y: 1 + ((j >>> 13) % Math.max(1, RAIN_H - size - 2)),
      size,
      ink: (j >>> 19) % 4 === 0,
    });
  }
  return drops;
}

/** What the column is showing right now: a word forming, or one being spent. */
interface Shown {
  /** Remounts the word so a new event replays the settle from the top. */
  key: string;
  id: string;
  word: string;
  spent: boolean;
}

/**
 * The forming front: the active event's class word gathering over the seat that
 * cast it, and turning rain grey with a strike through it once that event is
 * answered or resolved.
 *
 * Decorative throughout — the event's own live region in the dock is what
 * announces it — so the whole thing is hidden from assistive tech. It reads the
 * store and never writes to it.
 */
export default function WeatherFront({ seatId }: { seatId: SeatId }) {
  const eventId = useGameStore((s) =>
    s.activeEvent && s.activeEvent.seatId === seatId ? s.activeEvent.id : null,
  );
  const eventType = useGameStore((s) =>
    s.activeEvent && s.activeEvent.seatId === seatId ? s.activeEvent.type : null,
  );

  const [shown, setShown] = useState<Shown | null>(null);
  /** The last event id this column reacted to, so a re-render is not a change. */
  const seenRef = useRef<string | null>(null);
  /** The word standing formed on screen, and the only thing a strike may spend. */
  const formedRef = useRef<{ id: string; word: string } | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const current = eventId && eventType ? { id: eventId, word: EVENT_LABEL[eventType] } : null;
    const nextId = current?.id ?? null;
    if (seenRef.current === nextId) return;
    seenRef.current = nextId;

    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const formed = formedRef.current;
    if (!formed) {
      formedRef.current = current;
      setShown(current ? { key: current.id, id: current.id, word: current.word, spent: false } : null);
      return;
    }

    // Spend what was standing first. Nothing is formed while the strike draws,
    // so a second change inside the window replaces the word rather than
    // striking one the player never saw.
    formedRef.current = null;
    setShown({ key: `${formed.id}:spent`, id: formed.id, word: formed.word, spent: true });
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      formedRef.current = current;
      setShown(current ? { key: current.id, id: current.id, word: current.word, spent: false } : null);
    }, SPENT_MS);
  }, [eventId, eventType]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  // `shown` only moves when the front does, and the word and its scatter are
  // both fixed by the event id, so this is the whole of the arithmetic.
  const letters = useMemo(() => (shown ? lettersOf(shown.id, shown.word) : []), [shown]);
  const drops = useMemo(() => (shown ? dropsOf(shown.id, shown.word) : []), [shown]);

  if (!shown) return null;

  // The one number the size formula in CSS needs: how many glyphs the word sets,
  // spaces excluded. A long class word (COUNTERSPELL) is divided down from the
  // step the window is on, so it never comes out larger than a short one.
  const glyphCount = letters.reduce((n, letter) => (letter.char === ' ' ? n : n + 1), 0);

  return (
    <div
      className={'pgf' + (shown.spent ? ' is-spent' : ' is-forming')}
      aria-hidden="true"
      style={{ '--pgf-n': String(glyphCount) } as CSSProperties}
    >
      <div className="pgf-body" key={shown.key}>
        <div className="pgf-word">
          {letters.map((letter, i) =>
            letter.char === ' ' ? (
              <span className="pgf-space" key={i} />
            ) : (
              <span
                className={'pgf-letter' + (letter.flash ? ' is-flash' : '')}
                key={i}
                style={
                  {
                    '--pgf-y': `${letter.offset}px`,
                    '--pgf-d': `${letter.delay}ms`,
                  } as CSSProperties
                }
              >
                {letter.char}
              </span>
            ),
          )}
        </div>
        <div className="pgf-rain">
          {drops.map((drop, i) => (
            <span
              className={'pgf-drop' + (drop.ink ? ' is-ink' : '')}
              key={i}
              style={
                {
                  left: `${drop.x}%`,
                  top: `${drop.y}px`,
                  fontSize: `${drop.size}px`,
                } as CSSProperties
              }
            >
              {drop.char}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
