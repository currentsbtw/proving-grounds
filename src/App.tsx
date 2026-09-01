import DeckPanel from './features/decks/DeckPanel';
import TablePanel from './features/table/TablePanel';
import HudPanel from './features/hud/HudPanel';
import { useHotkeys } from './hooks/useHotkeys';
import './App.css';

export default function App() {
  useHotkeys();

  return (
    <div className="pg-app">
      <header className="pg-titlebar">
        <span className="pg-wordmark">PROVING GROUNDS</span>
        <span className="pg-subtitle">unofficial fan content</span>
        <span className="pg-titlebar-spacer" />
      </header>
      <main className="pg-body">
        <DeckPanel />
        <TablePanel />
        <HudPanel />
      </main>
    </div>
  );
}
