import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useGameStore } from '../../../state/gameStore';
import { FOCUS_NOTE_EVENT } from '../../../hooks/useHotkeys';
import { keyLabel, useHotkeyStore } from '../../../state/hotkeyStore';
import type { LogEntry, LogKind } from '../../../domain/types';

const EMPTY: LogEntry[] = [];

/** Phase/turn chatter — rendered smaller and dimmer, and tightened when consecutive. */
function isFlow(kind: LogKind): boolean {
  return kind === 'phase' || kind === 'turn';
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
      <span className="panel-heading">Run log</span>

      <div
        className="hud-log-scroll"
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
      >
        {log.length === 0 ? (
          <p className="hud-log-empty">No entries yet.</p>
        ) : (
          log.map((entry, i) => {
            const flow = isFlow(entry.kind);
            const collapsed = flow && i > 0 && isFlow(log[i - 1].kind);
            return (
              <div
                key={entry.seq}
                className={
                  `hud-log-row kind-${entry.kind}` +
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
          Add
        </button>
      </form>
    </div>
  );
}
