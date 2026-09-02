import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  HOTKEY_ACTIONS,
  keyLabel,
  useHotkeyStore,
} from '../../state/hotkeyStore';
import './hotkeys.css';

/** Everything inside the panel a Tab can land on, in document order. */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * The panel is `aria-modal`, so Tab has to stay inside it. The global key
 * listener stands down for everything but Escape and the help key while this is
 * open, which left Tab free to walk the board behind the overlay.
 */
function useFocusTrap(open: boolean, panel: React.RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const returnTo = document.activeElement;
    // The panel itself takes focus first, so a screen reader reads the dialog
    // rather than continuing from wherever the pointer left off.
    panel.current?.focus();

    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Tab') return;
      const box = panel.current;
      if (!box) return;
      const stops = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (stops.length === 0) {
        e.preventDefault();
        return;
      }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      if (!box.contains(active) || (e.shiftKey && active === first)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      if (returnTo instanceof HTMLElement) returnTo.focus();
    };
  }, [open, panel]);
}

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

  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(open, panel);

  if (!open) return null;

  return createPortal(
    <div
      className="hk-overlay"
      data-hotkeys="off"
      onPointerDown={() => setHelpOpen(false)}
    >
      <div
        ref={panel}
        className="hk-panel panel"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="hk-head">
          <h3>Keyboard</h3>
          <span className="muted">click a key to rebind</span>
          <span className="hk-spacer" />
          <button type="button" onClick={() => setHelpOpen(false)}>
            Close (Esc)
          </button>
        </div>

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
                  aria-label={`${action.label}: ${keyLabel(keymap[action.id]) || 'not bound'}. Click to rebind.`}
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

        {/* The fixed half of the reference: the two keys every focused card
            answers, and the mouse equivalents. Neither is rebindable — Enter
            and Space belong to whatever holds focus — so they are printed here
            rather than sitting in the list above. */}
        <div className="hk-body hk-fixed">
          <div className="hk-row">
            <span className="hk-label">
              Play the focused card
              <span className="hk-note">from hand, once Tab is on it</span>
            </span>
            <span className="hk-chip is-fixed">Enter</span>
          </div>
          <div className="hk-row">
            <span className="hk-label">
              Tap or untap the focused card
              <span className="hk-note">on the battlefield</span>
            </span>
            <span className="hk-chip is-fixed">Enter</span>
          </div>
        </div>
        <p className="hk-mouse">
          Space does the same on a card the keyboard put focus on. Mouse: double-click to
          play, drag to any zone, right-click for options.
        </p>

        <div className="hk-foot">
          <span className={`hk-msg${bindError ? ' is-error' : ''}`}>
            {bindError ?? (binding ? 'Escape cancels.' : '')}
          </span>
          <span className="hk-spacer" />
          <button type="button" onClick={resetKeymap}>
            Reset to defaults
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default HotkeyHelp;
