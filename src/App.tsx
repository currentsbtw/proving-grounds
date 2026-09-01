import DeckPanel from './features/decks/DeckPanel';
import TablePanel from './features/table/TablePanel';
import HudPanel from './features/hud/HudPanel';
import HotkeyHelp from './features/hotkeys/HotkeyHelp';
import ScorecardPanel from './features/scorecard/ScorecardPanel';
import { useHotkeys } from './hooks/useHotkeys';
import { keyLabel, useHotkeyStore } from './state/hotkeyStore';
import { useGameStore } from './state/gameStore';
import { useUiStore } from './state/uiStore';
import './App.css';

export default function App() {
  useHotkeys();
  const helpKey = useHotkeyStore((s) => s.keymap.help);
  const toggleHelp = useHotkeyStore((s) => s.toggleHelp);
  // The centre column is the table while a run is live, and the selected run's
  // scorecard once one ends. With nothing selected it stays the table's own
  // empty state, so a cold start still says "import a deck".
  const runActive = useGameStore((s) => s.run !== null);
  const selectedRunId = useUiStore((s) => s.selectedRunId);
  const showScorecard = !runActive && selectedRunId !== null;

  return (
    <div className="pg-app">
      <header className="pg-titlebar">
        <span className="pg-wordmark">PROVING GROUNDS</span>
        <span className="pg-subtitle">unofficial fan content</span>
        <span className="pg-titlebar-spacer" />
        <button
          type="button"
          className="pg-help-btn"
          title="Keyboard shortcuts"
          onClick={toggleHelp}
        >
          Keyboard<span className="pg-help-key">{keyLabel(helpKey)}</span>
        </button>
      </header>
      <main className="pg-body">
        <DeckPanel />
        {/* Keyed by run so switching runs remounts with clean local UI state. */}
        {showScorecard ? <ScorecardPanel key={selectedRunId} /> : <TablePanel />}
        <HudPanel />
      </main>
      <HotkeyHelp />
    </div>
  );
}
