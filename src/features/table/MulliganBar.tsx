import { mulliganBottomCount, STARTING_HAND_SIZE } from '../../state/gameStore';
import { keyLabel, useHotkeyStore } from '../../state/hotkeyStore';

export interface MulliganBarProps {
  mulliganCount: number;
  selecting: boolean;
  selectedCount: number;
  onMulligan: () => void;
  onKeep: () => void;
  onStartBottoming: () => void;
  onConfirmBottoming: () => void;
  onCancelBottoming: () => void;
}

/** Slim bar above the hand, live only for the opening hand of turn 1. */
export function MulliganBar({
  mulliganCount,
  selecting,
  selectedCount,
  onMulligan,
  onKeep,
  onStartBottoming,
  onConfirmBottoming,
  onCancelBottoming,
}: MulliganBarProps) {
  // The one control here with a binding behind it. It is printed in the same
  // square the tray and the player bar print theirs in, so the key the player
  // would reach for is on the button rather than only in the help overlay.
  const mulliganKey = useHotkeyStore((s) => keyLabel(s.keymap.mulligan));
  // Commander's first mulligan is free: bottom nothing after one, one after two.
  const bottomCount = mulliganBottomCount(mulliganCount);
  const nextSize = Math.max(0, STARTING_HAND_SIZE - mulliganBottomCount(mulliganCount + 1));

  if (selecting) {
    return (
      <div className="tbl-mull" role="group" aria-label="Bottom cards after mulligan">
        <span className="tbl-mull-label">Bottom {bottomCount}</span>
        <span>
          Click {bottomCount} card{bottomCount === 1 ? '' : 's'} in hand to put on the bottom{' '}
          ·{' '}
          <span className="num">
            {selectedCount}/{bottomCount}
          </span>{' '}
          chosen
        </span>
        <span className="tbl-mull-spacer" />
        <button type="button" onClick={onCancelBottoming}>
          Back
        </button>
        <button
          type="button"
          className="is-primary"
          disabled={selectedCount !== bottomCount}
          onClick={onConfirmBottoming}
        >
          Put {bottomCount} on the bottom
        </button>
      </div>
    );
  }

  return (
    <div className="tbl-mull" role="group" aria-label="Mulligan">
      <span className="tbl-mull-label">Opening hand</span>
      {mulliganCount > 0 && (
        <span className="muted num">
          {mulliganCount} mulligan{mulliganCount === 1 ? '' : 's'}
        </span>
      )}
      <span className="tbl-mull-spacer" />
      <button type="button" onClick={onMulligan}>
        <span>Mulligan to {nextSize}</span>
        {mulliganKey && (
          <span className="rd-key" aria-hidden="true">
            {mulliganKey}
          </span>
        )}
      </button>
      {bottomCount > 0 ? (
        <button type="button" className="is-primary" onClick={onStartBottoming}>
          Keep and bottom {bottomCount}
        </button>
      ) : (
        <button type="button" className="is-primary" onClick={onKeep}>
          Keep
        </button>
      )}
    </div>
  );
}
