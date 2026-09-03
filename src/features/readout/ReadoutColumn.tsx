import { useCallback, useEffect, useRef, useState } from 'react';
import { useGameStore } from '../../state/gameStore';
import { keyLabel, useHotkeyStore } from '../../state/hotkeyStore';
import { FOCUS_DRAWER_EVENT, isTypingTarget } from '../../hooks/useHotkeys';
import type { FocusDrawerDetail } from '../../hooks/useHotkeys';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import JudgePanel from '../judge/JudgePanel';
import EventDock from '../pressure/EventDock';
import { seatLabel } from '../pressure/pressureUi';
import EndRunControls from '../hud/components/EndRunControls';
import RunLog from '../hud/components/RunLog';
import TokenBar from '../hud/components/TokenBar';
import SeatsBlock from './SeatsBlock';
import YouBlock from './YouBlock';
import '../hud/hud.css';
import '../pressure/pressure.css';
import './readout.css';

/** The drawers behind the foot tabs. `keys` is the hotkey overlay, not a drawer. */
type DrawerId = 'log' | 'notes' | 'tokens' | 'judge' | 'endrun';

/** Shown once after a wipe resolves; the board it swept is not the whole truth. */
const WIPE_HINT = 'Drag back anything that survived: indestructible, regenerated, protected.';

/** Below this the foot tab has no room for two words. */
const TIGHT_TABS = '(max-width: 1100px)';

/** One name per drawer: the tab and the head of the drawer it opens agree. */
const TAB_LABEL: Record<DrawerId, string> = {
  log: 'Log',
  notes: 'Notes',
  tokens: 'Tokens',
  judge: 'Judge',
  endrun: 'End run',
};

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
 * The readout: one fixed column ordered by how often the player looks at it.
 * Seats first, then your own numbers, then whatever the pod is telling you, with
 * the active event pinned to the foot above the on-demand tabs.
 */
export default function ReadoutColumn() {
  const [drawer, setDrawer] = useState<DrawerId | null>(null);
  const [wipeHint, setWipeHint] = useState(false);
  const helpOpen = useHotkeyStore((s) => s.helpOpen);
  const toggleHelp = useHotkeyStore((s) => s.toggleHelp);
  // The sentence and the ARMED chip on the seat row are one tell in two places,
  // so a seat that has been knocked out drops both rather than only the chip.
  const armed = useGameStore((s) =>
    s.counterArmed && !s.seats.find((seat) => seat.id === s.counterArmed?.seatId)?.eliminated
      ? s.counterArmed
      : null,
  );
  const tightTabs = useMediaQuery(TIGHT_TABS);

  // The settle runs off an attribute that alternates with the turn rather than
  // off a timer: a new value is a new animation name, so the column replays it
  // once per turn and never on any other store tick.
  const turn = useGameStore((s) => s.turn);
  const settle = turn % 2 === 0 ? 'a' : 'b';

  const closeDrawer = useCallback(() => setDrawer(null), []);

  // Read by the note listener below, which is registered once and must see the
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

  // A focus key has nowhere to land while the drawer is shut, so the column
  // opens the named drawer and re-fires once the box inside it exists. The
  // re-fire is heard here too and stops on the first line, the drawer being open
  // by then; the panel takes it from there.
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

  function openTab(id: DrawerId): void {
    setDrawer((open) => (open === id ? null : id));
    // A drawer with a field is opened at that field, so the tab lands where the
    // tab was for.
    const target = FOCUS_TARGET[id];
    if (target && drawer !== id) {
      window.setTimeout(() => window.dispatchEvent(focusDrawerEvent(target)), 0);
    }
  }

  return (
    <section className="pg-readout" aria-label="Readout" data-settle={settle}>
      <div className="rd-scroll">
        <SeatsBlock />
        <YouBlock />
      </div>

      {/* Tells and the active event share the pinned foot, so neither can scroll
          away under the other while the column above it moves. */}
      <div className="rd-pinned rd-settle is-step3">
        <section
          className={'rd-block rd-tells' + (armed || wipeHint ? '' : ' is-empty')}
          aria-label="Tells"
        >
          <div className="rd-head">
            <h2 className="rd-title">TELLS</h2>
          </div>

          {/* Both slots stay mounted and usually empty, so a tell is announced
              when it arrives rather than only when its container appears. */}
          <div className="rd-tell-slot" role="status">
            {armed && (
              <p className="rd-tell">
                {seatLabel(armed.seatId)} armed: counters {armed.threshold}+ mana
              </p>
            )}
          </div>

          <div className="rd-tell-slot" role="status">
            {wipeHint && (
              <p className="rd-tell is-quiet">
                {WIPE_HINT}
                <button
                  type="button"
                  className="rd-quiet-btn"
                  onClick={() => setWipeHint(false)}
                >
                  dismiss
                </button>
              </p>
            )}
          </div>
        </section>

        <EventDock onWipeResolved={setWipeHint} />
      </div>

      <div className="rd-tabs" role="group" aria-label="On demand">
        {(['log', 'notes', 'tokens', 'judge'] as DrawerId[]).map((id) => (
          <button
            key={id}
            type="button"
            className={'rd-tab' + (drawer === id ? ' is-open' : '')}
            aria-expanded={drawer === id}
            onClick={() => openTab(id)}
          >
            {TAB_LABEL[id]}
          </button>
        ))}
        <button
          type="button"
          className={'rd-tab' + (helpOpen ? ' is-open' : '')}
          aria-expanded={helpOpen}
          onClick={toggleHelp}
        >
          Keys
        </button>
        <button
          type="button"
          className={'rd-tab' + (drawer === 'endrun' ? ' is-open' : '')}
          aria-expanded={drawer === 'endrun'}
          aria-label="End run"
          title="End run"
          onClick={() => openTab('endrun')}
        >
          {tightTabs ? 'End' : 'End run'}
        </button>
      </div>

      {drawer && (
        <div className="rd-drawer" role="group" aria-label={TAB_LABEL[drawer]}>
          <div className="rd-drawer-head">
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
          <div className="rd-drawer-body pg-hud">
            <DrawerBody id={drawer} />
          </div>
        </div>
      )}
    </section>
  );
}
