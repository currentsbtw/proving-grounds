import { useEffect, useState } from 'react';
import DeckPanel from './features/decks/DeckPanel';
import HandDrill from './features/drill/HandDrill';
import TablePanel from './features/table/TablePanel';
import HotkeyHelp from './features/hotkeys/HotkeyHelp';
import LiveHud from './features/readout/LiveHud';
import ScorecardPanel from './features/scorecard/ScorecardPanel';
import { useHotkeys } from './hooks/useHotkeys';
import { keyLabel, useHotkeyStore } from './state/hotkeyStore';
import { useGameStore } from './state/gameStore';
import { useUiStore } from './state/uiStore';
import './App.css';

const LEGAL =
  'Unofficial Fan Content permitted under the Wizards of the Coast Fan Content Policy. ' +
  'Card data and imagery via Scryfall. Not approved or endorsed by Wizards.';

/** Deck, bracket and seed, so the deck rail can stand down while a run is live. */
function RunChip() {
  // Three primitives rather than the run object: the run's log grows on every
  // action, and this chip has no interest in any of it.
  const deckName = useGameStore((s) => s.run?.deckName);
  const bracket = useGameStore((s) => s.run?.bracket);
  const seed = useGameStore((s) => s.run?.seed);
  if (seed === undefined) return null;
  return (
    <span
      className="pg-run-chip"
      title={`${deckName} · bracket ${bracket} · seed ${seed}`}
    >
      {/* The deck name is the only part of this chip with no fixed length, so it
          is the only part allowed to lose its tail. Bracket and seed keep their
          place whatever the player called the deck. */}
      <span className="pg-run-name">{deckName}</span>
      <span className="pg-run-sep" aria-hidden="true">
        ·
      </span>
      <span className="pg-run-fixed">bracket {bracket}</span>
      <span className="pg-run-sep" aria-hidden="true">
        ·
      </span>
      {/* Captioned, so the string reads as the run's seed rather than as an
          unexplained code sitting at the end of the chip. */}
      <span className="pg-run-fixed">
        seed <span className="pg-run-seed">{seed}</span>
      </span>
    </span>
  );
}

type Theme = 'dark' | 'light';

const THEME_KEY = 'pg-theme';

/** Dark ships by default; the stored choice is the only thing that overrides it. */
function storedTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** Flips the whole palette by swapping one attribute on the root element. */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(storedTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* Storage can be refused; the theme still applies for this session. */
    }
  }, [theme]);

  return (
    <button
      type="button"
      className="pg-help-btn"
      title={`Switch to the ${theme === 'dark' ? 'light' : 'dark'} readout`}
      aria-pressed={theme === 'light'}
      onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
    >
      Theme<span className="pg-help-key">{theme}</span>
    </button>
  );
}

export default function App() {
  useHotkeys();
  const helpKey = useHotkeyStore((s) => s.keymap.help);
  const toggleHelp = useHotkeyStore((s) => s.toggleHelp);
  // A live run takes the whole shell: the board full width, the readout floating
  // over it as unit frames and a foot bar. Between runs the two columns come
  // back, with the selected run's scorecard in the centre and the table's own
  // empty state before that.
  const runActive = useGameStore((s) => s.run !== null);
  const selectedRunId = useUiStore((s) => s.selectedRunId);
  const drillDeckId = useUiStore((s) => s.drill?.deckId ?? null);
  const showScorecard = !runActive && selectedRunId !== null;
  // The centre panel holds one thing. A scorecard wins over a drill, and a
  // drill over the table's empty state; opening either closes the other, so the
  // question only ever comes up between a stale drill and a fresh selection.
  const showDrill = !showScorecard && !runActive && drillDeckId !== null;

  return (
    <div className="pg-app">
      <header className="pg-titlebar">
        {/* The app's own name is the document's root heading, so heading
            navigation starts somewhere rather than at SEATS. */}
        <h1 className="pg-wordmark">Proving Grounds</h1>
        {runActive && <RunChip />}
        <span className="pg-titlebar-spacer" />
        {/* While a run is live the player bar's KEYS tab is the mouse entry
            point to the overlay, so the title row does not carry a second one.
            Between runs there is no bar, and this is the only one. */}
        {!runActive && (
          <button
            type="button"
            className="pg-help-btn"
            title="Keyboard shortcuts"
            onClick={toggleHelp}
          >
            Keyboard<span className="pg-help-key">{keyLabel(helpKey)}</span>
          </button>
        )}
        <ThemeToggle />
      </header>
      <main className={'pg-body' + (runActive ? ' is-live' : '')}>
        {runActive ? (
          <>
            <TablePanel />
            <LiveHud />
          </>
        ) : (
          <>
            <DeckPanel />
            {/* Keyed by run so switching runs remounts with clean local UI state;
                the drill is keyed by deck for the same reason, and deliberately
                not by seed — taking a new seed keeps the session's tally. */}
            {showScorecard ? (
              <ScorecardPanel key={selectedRunId} />
            ) : showDrill ? (
              <HandDrill key={drillDeckId} />
            ) : (
              <TablePanel />
            )}
          </>
        )}
      </main>
      <footer className="pg-legal">{LEGAL}</footer>
      <HotkeyHelp />
    </div>
  );
}
