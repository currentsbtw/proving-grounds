import { useGameStore } from '../../state/gameStore';
import { seatLabel } from './pressureUi';

/**
 * The fairness tell. A counter that arrives out of nowhere reads as random; the
 * same counter after this chip has been sitting over the hand all turn reads as
 * a read you could have played around.
 */
export default function CounterTell() {
  const armed = useGameStore((s) => s.counterArmed);
  if (!armed) return null;

  return (
    <span className="pgp-tell" role="status">
      <span className="pgp-tell-dot" aria-hidden="true" />
      {seatLabel(armed.seatId)} is holding up mana
      <span className="pgp-tell-sub">({armed.threshold}+ costs at risk)</span>
    </span>
  );
}
