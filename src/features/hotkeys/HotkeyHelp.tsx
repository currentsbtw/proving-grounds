import { createPortal } from 'react-dom';
import {
  HOTKEY_ACTIONS,
  keyLabel,
  useHotkeyStore,
} from '../../state/hotkeyStore';
import './hotkeys.css';

/**
 * Centered keyboard-help modal. Every key press while this is open is handled
 * by the global listener in `useHotkeys` — including rebinding — so this stays
 * a pure view over the hotkey store.
 */
export function HotkeyHelp() {
  const open = useHotkeyStore((s) => s.helpOpen);
  const keymap = useHotkeyStore((s) => s.keymap);
  const binding = useHotkeyStore((s) => s.binding);
  const bindError = useHotkeyStore((s) => s.bindError);
  const setHelpOpen = useHotkeyStore((s) => s.setHelpOpen);
  const startBinding = useHotkeyStore((s) => s.startBinding);
  const cancelBinding = useHotkeyStore((s) => s.cancelBinding);
  const resetKeymap = useHotkeyStore((s) => s.resetKeymap);

  if (!open) return null;

  return createPortal(
    <div
      className="hk-overlay"
      data-hotkeys="off"
      onPointerDown={() => setHelpOpen(false)}
    >
      <div
        className="hk-panel panel"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="hk-head">
          <h3>Keyboard</h3>
          <span className="muted">click a key to rebind</span>
          <span className="hk-spacer" />
          <button type="button" onClick={() => setHelpOpen(false)}>
            Close (Esc)
          </button>
        </header>

        <div className="hk-body">
          {HOTKEY_ACTIONS.map((action) => {
            const capturing = binding === action.id;
            return (
              <div className="hk-row" key={action.id}>
                <span className="hk-label">
                  {action.label}
                  {action.note && <span className="hk-note">{action.note}</span>}
                </span>
                <button
                  type="button"
                  className={`hk-chip${capturing ? ' is-capturing' : ''}`}
                  aria-label={`${action.label}: ${keyLabel(keymap[action.id])} — click to rebind`}
                  onClick={() =>
                    capturing ? cancelBinding() : startBinding(action.id)
                  }
                >
                  {capturing ? 'press a key…' : keyLabel(keymap[action.id])}
                </button>
              </div>
            );
          })}
        </div>

        <footer className="hk-foot">
          <span className={`hk-msg${bindError ? ' is-error' : ''}`}>
            {bindError ?? (binding ? 'Escape cancels.' : '')}
          </span>
          <span className="hk-spacer" />
          <button type="button" onClick={resetKeymap}>
            Reset to defaults
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

export default HotkeyHelp;
