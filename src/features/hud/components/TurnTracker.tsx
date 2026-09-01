import { useCallback } from 'react';
import { PHASES, PHASE_LABELS, phaseIndex } from '../../../domain/phases';
import { useGameStore } from '../../../state/gameStore';
import type { Phase } from '../../../domain/types';

/** Turn number, the seven-phase pill strip, and the phase/turn advance buttons. */
export default function TurnTracker() {
  const turn = useGameStore((s) => s.turn);
  const phase = useGameStore((s) => s.phase);
  const nextPhase = useGameStore((s) => s.nextPhase);
  const nextTurn = useGameStore((s) => s.nextTurn);
  const untapAll = useGameStore((s) => s.untapAll);

  const current = phaseIndex(phase);

  /** Advance to a later phase in this turn only — never rewind, never wrap. */
  const goToPhase = useCallback(
    (target: Phase) => {
      const from = phaseIndex(useGameStore.getState().phase);
      const to = phaseIndex(target);
      if (to <= from) return;
      const step = useGameStore.getState().nextPhase;
      for (let i = from; i < to; i++) step();
    },
    [],
  );

  return (
    <div className="pg-hud-block">
      <div className="hud-turn-head">
        <span className="hud-turn-number">TURN {turn}</span>
        <span className="hud-turn-phase">{PHASE_LABELS[phase]}</span>
      </div>

      <div className="hud-phase-strip" role="group" aria-label="Phase">
        {PHASES.map((p, i) => {
          const isCurrent = i === current;
          const ahead = i > current;
          return (
            <button
              key={p}
              type="button"
              className={
                'hud-phase-pill' +
                (isCurrent ? ' is-current' : ahead ? ' is-ahead' : ' is-past')
              }
              aria-current={isCurrent ? 'step' : undefined}
              disabled={!ahead}
              title={ahead ? `Advance to ${PHASE_LABELS[p]}` : PHASE_LABELS[p]}
              onClick={() => goToPhase(p)}
            >
              {PHASE_LABELS[p]}
            </button>
          );
        })}
      </div>

      <div className="hud-turn-actions">
        <button type="button" onClick={() => nextPhase()}>
          Next phase<span className="hud-key">Space</span>
        </button>
        <button type="button" onClick={() => nextTurn()}>
          Next turn<span className="hud-key">T</span>
        </button>
        <button type="button" onClick={() => untapAll()}>
          Untap all<span className="hud-key">U</span>
        </button>
      </div>
    </div>
  );
}
