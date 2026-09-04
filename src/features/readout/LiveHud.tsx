import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { SeatId } from '../../domain/types';
import { useGameStore } from '../../state/gameStore';
import { keyLabel, useHotkeyStore } from '../../state/hotkeyStore';
import { FOCUS_DRAWER_EVENT, isTypingTarget } from '../../hooks/useHotkeys';
import type { FocusDrawerDetail } from '../../hooks/useHotkeys';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import Glossed from '../glossary/Glossed';
import JudgePanel from '../judge/JudgePanel';
import EventDock from '../pressure/EventDock';
import { EVENT_LABEL, seatLabel } from '../pressure/pressureUi';
import EndRunControls from '../hud/components/EndRunControls';
import RunLog from '../hud/components/RunLog';
import TokenBar from '../hud/components/TokenBar';
import PlayerBar, { TAB_LABEL } from './PlayerBar';
import type { DrawerId } from './PlayerBar';
import SeatFrame, { seatToHit } from './SeatFrame';
import '../hud/hud.css';
import '../pressure/pressure.css';
import './readout.css';

/** Shown once after a wipe resolves; the board it swept is not the whole truth. */
const WIPE_HINT = 'Drag back anything that survived: indestructible, regenerated, protected.';

/**
 * Which of the three frame columns a seat owns. The event pane is placed by
 * column rather than moved between parents, because it is the run's live region:
 * a region only speaks if it was already mounted when its text changed, and
 * re-parenting it in React is a remount.
 */
const SEAT_COLUMN: Record<SeatId, number> = { A: 1, B: 2, C: 3 };

/** Below this a frame has no room for a third chip beside CLOCK and ARMED. */
const TIGHT_CHIPS = '(max-width: 1280px)';

/** Which seat's detail pane is open, and how tall it measured. */
interface OpenDetail {
  seatId: SeatId;
  height: number;
}

/**
 * The drawers whose panel owns a field worth aiming at. Opening one of these —
 * by tab or by hotkey — puts the cursor in that field; the rest just open.
 * Log is absent because the note box it holds is the Notes tab's business.
 */
const FOCUS_TARGET: Partial<Record<DrawerId, FocusDrawerDetail['drawer']>> = {
  notes: 'notes',
  judge: 'judge',
};

function focusDrawerEvent(drawer: FocusDrawerDetail['drawer']): CustomEvent<FocusDrawerDetail> {
  return new CustomEvent<FocusDrawerDetail>(FOCUS_DRAWER_EVENT, { detail: { drawer } });
}

function DrawerBody({ id }: { id: DrawerId }) {
  const untapAll = useGameStore((s) => s.untapAll);
  const keymap = useHotkeyStore((s) => s.keymap);

  if (id === 'tokens') {
    return (
      <>
        <TokenBar />
        <div className="rd-turn-actions">
          <button type="button" onClick={() => untapAll()}>
            Untap all<span className="rd-key">{keyLabel(keymap.untap)}</span>
          </button>
        </div>
      </>
    );
  }

  if (id === 'judge') return <JudgePanel />;

  if (id === 'endrun') return <EndRunControls />;

  // Log and Notes are the same panel: the notes live in the log, and the tab
  // only decides whether the cursor lands in the note box on the way in.
  return <RunLog />;
}

/**
 * The live readout, as unit frames floating over a full-width board.
 *
 * Three opponent frames pinned along the top edge, whatever each seat is telling
 * you hanging under its own frame, the active event under the seat that produced
 * it, and your own numbers as one bar across the foot. The containers take no
 * pointer events, only the panes do, so the board stays droppable everywhere a
 * pane is not.
 */
export default function LiveHud() {
  const [drawer, setDrawer] = useState<DrawerId | null>(null);
  // One seat pinned at a time: the pinned pane is the one holding buttons, and
  // three of them open at once would cover the board they are read against.
  const [pinned, setPinned] = useState<SeatId | null>(null);
  // The seat whose wipe just resolved, so the survivor hint hangs under it.
  const [wipeHintSeat, setWipeHintSeat] = useState<SeatId | null>(null);
  // Reported by the frames, because the detail hangs out of flow and the event
  // pane underneath has to be pushed clear of it by hand.
  const [openDetail, setOpenDetail] = useState<OpenDetail | null>(null);
  const helpOpen = useHotkeyStore((s) => s.helpOpen);
  const toggleHelp = useHotkeyStore((s) => s.toggleHelp);
  const tightChips = useMediaQuery(TIGHT_CHIPS);

  const seats = useGameStore((s) => s.seats);
  const previousThreat = useGameStore((s) => s.previousThreat);
  const clock = useGameStore((s) => s.clock);
  const activeEvent = useGameStore((s) => s.activeEvent);
  const pendingEvents = useGameStore((s) => s.pendingEvents);
  // The sentence and the ARMED chip on the frame are one tell in two places, so
  // a seat that has been knocked out drops both rather than only the chip.
  const armed = useGameStore((s) =>
    s.counterArmed && !s.seats.find((seat) => seat.id === s.counterArmed?.seatId)?.eliminated
      ? s.counterArmed
      : null,
  );

  // The settle runs off an attribute that alternates with the turn rather than
  // off a timer: a new value is a new animation name, so the HUD replays it once
  // per turn and never on any other store tick.
  const turn = useGameStore((s) => s.turn);
  const settle = turn % 2 === 0 ? 'a' : 'b';

  const closeDrawer = useCallback(() => setDrawer(null), []);

  // Stable, so the frames' measuring effect is not torn down and rebuilt on
  // every store tick. A seat closing only clears the record if it is still the
  // seat holding it: the pin moving from A to B reports B open before A closed.
  const onDetailChange = useCallback((seatId: SeatId, open: boolean, height: number): void => {
    setOpenDetail((current) => {
      if (!open) return current?.seatId === seatId ? null : current;
      if (current?.seatId === seatId && current.height === height) return current;
      return { seatId, height };
    });
  }, []);

  // Read by the focus listener below, which is registered once and must see the
  // drawer as it stands rather than as it was when the listener was made.
  const drawerRef = useRef<DrawerId | null>(drawer);
  useEffect(() => {
    drawerRef.current = drawer;
  }, [drawer]);

  // The drawer is the outermost thing Escape can close, so it listens in the
  // bubble phase and passes the press on: the browse overlay, the card menu and
  // the token form all take Escape first, and typing keeps it entirely.
  useEffect(() => {
    if (!drawer) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      if (isTypingTarget(e.target)) return;
      setDrawer(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  // A focus key has nowhere to land while the drawer is shut, so the HUD opens
  // the named drawer and re-fires once the box inside it exists. The re-fire is
  // heard here too and stops on the first line, the drawer being open by then;
  // the panel takes it from there.
  useEffect(() => {
    function onFocusDrawer(e: Event): void {
      const want = (e as CustomEvent<FocusDrawerDetail>).detail?.drawer ?? 'notes';
      const open = drawerRef.current;
      if (open === want) return;
      // The note box lives in the log panel, so the Log tab is already holding it.
      if (want === 'notes' && open === 'log') return;
      setDrawer(want);
      window.setTimeout(() => window.dispatchEvent(focusDrawerEvent(want)), 0);
    }
    window.addEventListener(FOCUS_DRAWER_EVENT, onFocusDrawer);
    return () => window.removeEventListener(FOCUS_DRAWER_EVENT, onFocusDrawer);
  }, []);

  const openTab = useCallback(
    (id: DrawerId): void => {
      setDrawer((open) => (open === id ? null : id));
      // A drawer with a field is opened at that field, so the tab lands where
      // the tab was for.
      const target = FOCUS_TARGET[id];
      if (target && drawer !== id) {
        window.setTimeout(() => window.dispatchEvent(focusDrawerEvent(target)), 0);
      }
    },
    [drawer],
  );

  const hit = seatToHit(seats, clock?.seatId ?? null);
  // The event pane hangs under the seat that produced it; a race clock with no
  // event in front of it hangs under the seat that is running it.
  const standingSeat = activeEvent?.seatId ?? clock?.seatId ?? null;

  return (
    <>
      <div className="hud-over" data-settle={settle}>
        <div className="hud-frames">
          {seats.map((seat) => (
            <div
              key={seat.id}
              className="hud-col"
              style={{ gridColumn: SEAT_COLUMN[seat.id] }}
            >
              <SeatFrame
                seat={seat}
                previous={previousThreat[seat.id] ?? seat.threat}
                hasClock={clock?.seatId === seat.id}
                armedThreshold={armed?.seatId === seat.id ? armed.threshold : null}
                hit={hit === seat.id}
                showHit={!tightChips}
                pinned={pinned === seat.id}
                onTogglePin={() =>
                  setPinned((current) => (current === seat.id ? null : seat.id))
                }
                onDetailChange={onDetailChange}
              />

              {/* Mounted empty on every seat, so anything arriving under one of
                  them is announced rather than only appearing. The queue lives
                  in here too: a second event landing behind the first is news,
                  and outside a live region it was news nobody was told. */}
              <div className="hud-tell-slot" role="status">
                {armed?.seatId === seat.id && (
                  <p className="hud-tell pg-pane">
                    {seatLabel(seat.id)} armed: counters {armed.threshold}+ mana
                  </p>
                )}
                {wipeHintSeat === seat.id && !seat.eliminated && (
                  <p className="hud-tell pg-pane is-quiet">
                    {/* The hint names three keywords and is read by whoever is
                        least sure which of their permanents survived, so it is
                        the one line on the board most worth glossing. */}
                    <Glossed text={WIPE_HINT} />
                    <button
                      type="button"
                      className="rd-quiet-btn"
                      onClick={() => setWipeHintSeat(null)}
                    >
                      dismiss
                    </button>
                  </p>
                )}

                {/* Everything still waiting behind the active event, each under
                    the seat that will throw it. */}
                {pendingEvents
                  .filter((pending) => pending.seatId === seat.id)
                  .map((pending) => (
                    <p key={pending.id} className="hud-queued">
                      queued: {EVENT_LABEL[pending.type].toLowerCase()}
                    </p>
                  ))}
              </div>
            </div>
          ))}

          {/* One event pane for the whole run, moved between columns rather than
              between parents. `is-empty` hides it visually without unrendering
              it, so the live region inside survives from the first event of the
              run to the last.

              When the seat that threw the event is also the seat whose detail is
              open, the pane is pushed clear of the detail hanging over it: the
              event's own head and answers must never be the thing a hover
              covers, and raising the pane instead would put it over the detail's
              buttons. Only this one element moves, so no other seat's column
              shifts by a pixel. */}
          <div
            className={
              'hud-event-host pg-pane-strong' +
              (standingSeat ? '' : ' is-empty') +
              (standingSeat && openDetail?.seatId === standingSeat ? ' is-under-detail' : '')
            }
            data-seat={standingSeat ?? undefined}
            style={
              standingSeat
                ? ({
                    gridColumn: SEAT_COLUMN[standingSeat],
                    '--hud-detail-h': `${Math.round(openDetail?.height ?? 0)}px`,
                  } as CSSProperties)
                : undefined
            }
          >
            <EventDock onWipeResolved={setWipeHintSeat} />
          </div>
        </div>

        {drawer && (
          <aside className="hud-drawer pg-pane-strong" role="group" aria-label={TAB_LABEL[drawer]}>
            <div className="hud-drawer-head">
              <span className="rd-title">{TAB_LABEL[drawer]}</span>
              <button
                type="button"
                className="rd-quiet-btn"
                aria-label={`Close ${TAB_LABEL[drawer]}`}
                onClick={closeDrawer}
              >
                close · Esc
              </button>
            </div>
            <div className="hud-drawer-body pg-hud">
              <DrawerBody id={drawer} />
            </div>
          </aside>
        )}
      </div>

      <PlayerBar
        drawer={drawer}
        helpOpen={helpOpen}
        onOpenTab={openTab}
        onToggleHelp={toggleHelp}
      />
    </>
  );
}
