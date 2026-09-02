import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClockState, EventType, PressureEvent, SeatId } from '../../domain/types';
import { useGameStore } from '../../state/gameStore';
import { keyLabel, useHotkeyStore } from '../../state/hotkeyStore';
import { EVENT_RESPONSE_EVENT } from '../../hooks/useHotkeys';
import type { EventResponseDetail } from '../../hooks/useHotkeys';
import { describeAnswers, EVENT_LABEL, seatLabel } from './pressureUi';

/** How long a toast stands before it leaves. Paused while hovered or focused. */
const DWELL_MS = 7000;
/** The fade it leaves on, matching the dock's 140ms arrival. */
const LEAVE_MS = 140;

interface Toast {
  /** Event id, or a clock's own key. Identity is what replaces a standing toast. */
  key: string;
  kind: 'event' | 'clock';
  seatId: SeatId;
  type: EventType;
  head: string;
  prompt: string;
  /** Label on the first response, matching the dock's button at arrival. */
  first: string;
  /** Label on the second response; a bare clock has only the first. */
  second: string | null;
  /** The event being announced, so the gate can be re-read live. Null for a clock. */
  event: PressureEvent | null;
}

function clockKey(clock: ClockState | null): string | null {
  return clock ? `clock:${clock.seatId}:${clock.spawnedTurn}` : null;
}

/**
 * The two answers as the dock prints them the moment the event lands, worded by
 * the dock's own helper so the two can no longer drift. The dock re-labels its
 * second button as the player edits the damage figure or picks a target; the
 * toast is gone long before that, so it passes no edits and reads the arriving
 * event. The one thing it does not freeze is the gate, which is re-read live
 * below.
 */
function describeEvent(event: PressureEvent): Toast {
  const answers = describeAnswers(event, useGameStore.getState());
  return {
    key: event.id,
    kind: 'event',
    seatId: event.seatId,
    type: event.type,
    head: 'active event',
    prompt: event.prompt,
    first: answers.first,
    second: answers.second,
    event,
  };
}

/** A clock that arrived on its own: one answer, the same one the dock offers. */
function describeClock(clock: ClockState): Toast {
  return {
    key: clockKey(clock)!,
    kind: 'clock',
    seatId: clock.seatId,
    type: 'clock',
    head: 'race clock',
    prompt: `${seatLabel(clock.seatId)} wins after your turn ${clock.deadlineTurn}.`,
    first: 'Declare held interaction',
    second: null,
    event: null,
  };
}

/**
 * A transient notice over the board when the pod acts. The event dock in the
 * readout stays the source of truth: this repeats it where the player's eyes
 * already are, offers the same two answers, and leaves on its own.
 *
 * It answers by dispatching the response hotkeys' own window event rather than
 * calling the store, so the dock keeps every decision it holds — the damage
 * figure, the chosen target, whether a resolution is still missing the card it
 * needs. Nothing here blocks the table: the toast never takes focus, and it
 * carries no live attributes, so the dock's status region stays the one voice
 * that announces an event.
 */
export default function EventToast() {
  const activeEvent = useGameStore((s) => s.activeEvent);
  const clock = useGameStore((s) => s.clock);
  const keymap = useHotkeyStore((s) => s.keymap);

  const [toast, setToast] = useState<Toast | null>(null);
  const [leaving, setLeaving] = useState(false);
  /** Hovered or focused: the dwell stops while the player is reading it. */
  const [held, setHeld] = useState(false);

  // Seeded from the store rather than from null, so whatever is already standing
  // when a run mounts does not announce itself as new.
  const seenEvent = useRef<string | null>(useGameStore.getState().activeEvent?.id ?? null);
  const seenClock = useRef<string | null>(clockKey(useGameStore.getState().clock));
  /** The dwell budget and the toast that earned it. See the dwell effect below. */
  const budget = useRef<{ key: string | null; ms: number }>({ key: null, ms: DWELL_MS });

  /**
   * Live gate on the second answer. The dock holds the picked card in local
   * state, so what this can see is whether the resolution still needs a card at
   * all; the dock's own listener is the hard gate and no-ops a slot 2 it cannot
   * honour. Selecting the boolean rather than the whole answer keeps the
   * snapshot stable, and keeps the toast honest as the board moves under it.
   */
  const blocked = useGameStore((s) => (toast?.event ? describeAnswers(toast.event, s).blocked : false));

  useEffect(() => {
    const eventId = activeEvent?.id ?? null;
    const nextClock = clockKey(clock);
    const newEvent = eventId !== null && eventId !== seenEvent.current;
    const newClock = nextClock !== null && nextClock !== seenClock.current;
    seenEvent.current = eventId;
    seenClock.current = nextClock;

    // A new event wins over a clock arriving in the same tick: the clock rides
    // along inside the event that announced it.
    if (newEvent && activeEvent) {
      setLeaving(false);
      setToast(describeEvent(activeEvent));
      return;
    }
    // A bare clock notice only stands when nothing else does. A window sets the
    // clock before it queues its events, so a clock landing while an event is in
    // front of the player would otherwise print a toast whose first answer means
    // "declare interaction" while the dock is listening for that slot on behalf
    // of the standing event — and would negate that event for free. Nothing is
    // lost by staying quiet: the clock queues its own 'clock' event, which
    // toasts when it reaches the front. The clock is marked seen either way, so
    // it does not announce itself late.
    if (newClock && clock && !activeEvent) {
      setLeaving(false);
      setToast(describeClock(clock));
      return;
    }

    // Answered, retired, or queued away: the notice has nothing left to say.
    setToast((current) => {
      if (!current) return null;
      if (current.kind === 'clock') return nextClock ? current : null;
      return current.key === eventId ? current : null;
    });
  }, [activeEvent, clock]);

  useEffect(() => {
    if (!toast) return;
    // Ordering: the subscription above calls setToast during a store update, and
    // React does not run this effect's cleanup for the outgoing toast until the
    // incoming one has committed. A budget reset up there would therefore be
    // debited by the toast it just replaced, and the arriving notice would stand
    // for DWELL_MS minus however long the last one had been up. Keying the
    // budget to the toast that earned it makes the order irrelevant: a fresh key
    // starts a fresh budget here, and a cleanup only debits while the same toast
    // continues, which is the held/unheld toggle this effect exists for.
    if (budget.current.key !== toast.key) budget.current = { key: toast.key, ms: DWELL_MS };
    if (held) return;

    const owner = toast.key;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => setLeaving(true), budget.current.ms);
    return () => {
      window.clearTimeout(timer);
      if (budget.current.key !== owner) return;
      budget.current.ms = Math.max(0, budget.current.ms - (Date.now() - startedAt));
    };
  }, [toast, held]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => {
      setToast(null);
      setLeaving(false);
    }, LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  const respond = useCallback((slot: 1 | 2) => {
    window.dispatchEvent(
      new CustomEvent<EventResponseDetail>(EVENT_RESPONSE_EVENT, { detail: { slot } }),
    );
  }, []);

  /** Hands the player to the dock, which holds the target, the figure and the note. */
  const showDock = useCallback(() => {
    const dock = document.querySelector<HTMLElement>('.pgp-dock');
    if (dock) {
      dock.scrollIntoView({ block: 'nearest' });
      const answer = dock.querySelector<HTMLElement>('.pgp-btn');
      if (answer) {
        answer.focus();
      } else {
        dock.tabIndex = -1;
        dock.focus();
      }
    }
    setLeaving(true);
  }, []);

  if (!toast) return null;

  return (
    <div className="pgp-toast-host">
      {/* A plain group, with no live attributes of its own: the dock's status
          region is what announces the event, and a region that is not live does
          not speak a second time when this appears. Hiding the group instead
          would leave focusable buttons inside a hidden subtree. */}
      <div
        className={`pgp-toast type-${toast.type}${leaving ? ' is-leaving' : ''}`}
        role="group"
        aria-label="Event shortcut"
        onMouseEnter={() => setHeld(true)}
        onMouseLeave={() => setHeld(false)}
        onFocus={() => setHeld(true)}
        onBlur={() => setHeld(false)}
      >
        <div className="pgp-toast-head">
          {/* The One Accent Rule: the accent head belongs to the active event.
              A bare race clock is a standing condition, so it prints in rule. */}
          <span className={`pgp-toast-label${toast.kind === 'clock' ? ' is-clock' : ''}`}>
            {toast.head}
          </span>
          <span className="pgp-seat">{seatLabel(toast.seatId)}</span>
          <span className={`pgp-type type-${toast.type}`}>{EVENT_LABEL[toast.type]}</span>
        </div>

        <p className="pgp-toast-prompt">{toast.prompt}</p>

        <div className="pgp-toast-answers">
          <button type="button" className="pgp-btn" onClick={() => respond(1)}>
            <span className="pgp-answer-key">{keyLabel(keymap.respondOne)}</span>
            <span className="pgp-btn-label">{toast.first}</span>
          </button>
          {toast.second && (
            <button
              type="button"
              className="pgp-btn is-primary"
              disabled={blocked}
              title={toast.second}
              onClick={() => respond(2)}
            >
              <span className="pgp-answer-key">{keyLabel(keymap.respondTwo)}</span>
              <span className="pgp-btn-label">
                {blocked ? 'Pick a card in the dock' : toast.second}
              </span>
            </button>
          )}
        </div>

        <button type="button" className="pgp-link pgp-toast-details" onClick={showDock}>
          Details
        </button>
      </div>
    </div>
  );
}
