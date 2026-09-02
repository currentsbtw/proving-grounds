import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useGameStore } from '../../../state/gameStore';
import { FOCUS_NOTE_EVENT } from '../../../hooks/useHotkeys';
import { keyLabel, useHotkeyStore } from '../../../state/hotkeyStore';
import type { LogEntry, LogKind } from '../../../domain/types';

const EMPTY: LogEntry[] = [];

/**
 * How many entries the panel draws. The log itself is never trimmed: it is the
 * run record and the scorer reads all of it. This is only what the drawer paints
 * on every store tick, and a long run pays for it on every action taken. At
 * three thousand entries a single phase step cost over 120ms with the drawer
 * open, which is the drawer taxing the play it is supposed to record.
 */
const VISIBLE_ENTRIES = 400;

/** Phase/turn chatter — rendered smaller and dimmer, and tightened when consecutive. */
function isFlow(kind: LogKind): boolean {
  return kind === 'phase' || kind === 'turn';
}

/**
 * The pressure event class an entry belongs to, so 'event' and 'respond' rows
 * carry the same colour the dock used. Windows and threat notes have no type.
 */
function eventClassOf(entry: LogEntry): string {
  const type = entry.payload.eventType;
  return typeof type === 'string' ? ` evt-${type}` : '';
}

/**
 * An opponent window renders as a separator rather than a line of prose: a rule
 * across the log with the turn it precedes, then the engine's summary beneath.
 */
function WindowSeparator({ entry }: { entry: LogEntry }) {
  const before = entry.payload.windowBeforeTurn;
  const turn = typeof before === 'number' ? before : entry.turn + 1;
  return (
    <div className="hud-log-window">
      <div className="hud-log-window-rule">
        <span>OPPONENT WINDOW → TURN {turn}</span>
      </div>
      <div className="hud-log-window-sum">{entry.message}</div>
    </div>
  );
}

/** Live run log: newest at the bottom, chat-style auto-scroll, plus a note input. */
export default function RunLog() {
  const log = useGameStore((s) => s.run?.log) ?? EMPTY;
  const logNote = useGameStore((s) => s.logNote);
  const noteKey = useHotkeyStore((s) => s.keymap.focusNote);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [note, setNote] = useState('');

  const hidden = Math.max(0, log.length - VISIBLE_ENTRIES);
  const shown = hidden > 0 ? log.slice(hidden) : log;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [log.length]);

  // The N hotkey aims here instead of opening a window.prompt.
  useEffect(() => {
    function focusNote(): void {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    }
    window.addEventListener(FOCUS_NOTE_EVENT, focusNote);
    return () => window.removeEventListener(FOCUS_NOTE_EVENT, focusNote);
  }, []);

  function handleScroll(): void {
    const el = scrollRef.current;
    if (!el) return;
    const stuck = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    stickRef.current = stuck;
    setAtBottom((prev) => (prev === stuck ? prev : stuck));
  }

  function jumpToLatest(): void {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    setAtBottom(true);
    el.scrollTop = el.scrollHeight;
  }

  function submitNote(e: FormEvent): void {
    e.preventDefault();
    const text = note.trim();
    if (!text) return;
    logNote(text);
    setNote('');
    jumpToLatest();
  }

  return (
    <div className="pg-hud-block pg-hud-log">
      {/* The log is the product, and it scrolls. Without a tab stop of its own a
          keyboard-only pilot can read whatever slice happens to be in view and
          nothing else, so the region takes focus and says what it is. */}
      <div
        className="hud-log-scroll"
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-label="Run log"
        tabIndex={0}
      >
        {hidden > 0 && (
          <p className="hud-log-trimmed">
            {hidden} earlier {hidden === 1 ? 'entry' : 'entries'} kept in the run, not drawn here.
          </p>
        )}

        {log.length === 0 ? (
          <p className="hud-log-empty">No entries yet. Every action you take lands here.</p>
        ) : (
          shown.map((entry, i) => {
            if (entry.kind === 'window') return <WindowSeparator key={entry.seq} entry={entry} />;
            const flow = isFlow(entry.kind);
            const collapsed = flow && i > 0 && isFlow(shown[i - 1].kind);
            return (
              <div
                key={entry.seq}
                className={
                  `hud-log-row kind-${entry.kind}` +
                  eventClassOf(entry) +
                  (flow ? ' is-flow' : '') +
                  (collapsed ? ' is-collapsed' : '')
                }
              >
                <span className="hud-log-turn">T{entry.turn}</span>
                <span className="hud-log-msg">{entry.message}</span>
              </div>
            );
          })
        )}
      </div>

      {!atBottom && (
        <button type="button" className="hud-log-jump" onClick={jumpToLatest}>
          ↓ jump to latest
        </button>
      )}

      <form className="hud-note-form" data-hotkeys="off" onSubmit={submitNote}>
        <input
          ref={inputRef}
          type="text"
          value={note}
          placeholder={`Log a note… (${keyLabel(noteKey)})`}
          aria-label="Log a note"
          onChange={(e) => setNote(e.target.value)}
        />
        <button type="submit" disabled={note.trim() === ''}>
          Add note
        </button>
      </form>
    </div>
  );
}
