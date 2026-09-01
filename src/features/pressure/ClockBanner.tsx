import { useGameStore } from '../../state/gameStore';
import { seatLabel } from './pressureUi';

function turnsLabel(remaining: number): string {
  if (remaining <= 0) return 'this is the last turn';
  if (remaining === 1) return '1 turn';
  return `${remaining} turns`;
}

/**
 * The standing race warning. Slim enough to live above the event dock without
 * eating table space, and it carries the same escape hatch the clock event
 * offered — declaring the interaction you are holding.
 */
export default function ClockBanner() {
  const clock = useGameStore((s) => s.clock);
  const turn = useGameStore((s) => s.turn);
  const declareInteraction = useGameStore((s) => s.declareInteraction);

  if (!clock) return null;

  const remaining = clock.deadlineTurn - turn;
  const urgent = remaining <= 1;

  return (
    <div
      className={'pgp-clock' + (urgent ? ' is-urgent' : '')}
      role="status"
      aria-label="Race clock"
    >
      <span className="pgp-clock-text">
        {seatLabel(clock.seatId)} WINS AFTER YOUR TURN {clock.deadlineTurn}
      </span>
      <span className="pgp-clock-left">{turnsLabel(remaining)}</span>
      <span className="pgp-dock-spacer" />
      <button type="button" className="pgp-btn" onClick={() => declareInteraction()}>
        Declare held interaction
      </button>
    </div>
  );
}
