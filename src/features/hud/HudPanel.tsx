import { useGameStore } from '../../state/gameStore';
import TurnTracker from './components/TurnTracker';
import LifePanel from './components/LifePanel';
import TokenBar from './components/TokenBar';
import RunLog from './components/RunLog';
import EndRunControls from './components/EndRunControls';
import './hud.css';

/** Right rail: turn/phase tracker, life totals, token quick-create, run log, end-run. */
export default function HudPanel() {
  const active = useGameStore((s) => s.run !== null);

  if (!active) {
    return (
      <section className="pg-rail pg-hud" aria-label="HUD">
        <h2 className="panel-heading">HUD</h2>
        <p className="hud-empty">Start a run to begin</p>
      </section>
    );
  }

  return (
    <section className="pg-rail pg-hud" aria-label="HUD">
      <TurnTracker />
      <LifePanel />
      <TokenBar />
      <RunLog />
      <EndRunControls />
    </section>
  );
}
