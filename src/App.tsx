import DeckPanel from './features/decks/DeckPanel';
import TablePanel from './features/table/TablePanel';
import HudPanel from './features/hud/HudPanel';
import HotkeyHelp from './features/hotkeys/HotkeyHelp';
import { useHotkeys } from './hooks/useHotkeys';
import { keyLabel, useHotkeyStore } from './state/hotkeyStore';
import './App.css';

export default function App() {
  useHotkeys();
  const helpKey = useHotkeyStore((s) => s.keymap.help);
  const toggleHelp = useHotkeyStore((s) => s.toggleHelp);

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
        <TablePanel />
        <HudPanel />
      </main>
      <HotkeyHelp />
    </div>
  );
}
