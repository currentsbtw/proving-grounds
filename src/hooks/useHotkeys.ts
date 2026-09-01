import { useEffect } from 'react';
import { canMulligan, useGameStore } from '../state/gameStore';
import {
  actionForKey,
  isBindable,
  normalizeKey,
  useHotkeyStore,
} from '../state/hotkeyStore';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable ||
    target.closest('[data-hotkeys="off"]') !== null
  );
}

/**
 * A just-clicked control keeps focus, so the next Space (or Enter) re-fires it.
 * Every handled hotkey drops that focus before dispatching.
 */
function blurActiveControl(): void {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return;
  if (el === document.body) return;
  if (el.matches('button, [role="button"], a[href], summary, [tabindex]')) el.blur();
}

/** Fired by the note hotkey; the HUD's run-log note input focuses itself on it. */
export const FOCUS_NOTE_EVENT = 'pg:focus-note';

/**
 * The single global keyboard listener. Registered in the capture phase on
 * `window` so it runs before any component handler — that is what stops a
 * focused button from also acting on the same press.
 */
export function useHotkeys(): void {
  useEffect(() => {
    void useHotkeyStore.getState().loadKeymap();
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.repeat) return;

      const hk = useHotkeyStore.getState();
      const key = normalizeKey(e);

      // 1. Rebinding: the next press belongs to the help overlay, whatever it is.
      if (hk.binding) {
        e.preventDefault();
        e.stopPropagation();
        if (key === 'Escape') {
          hk.cancelBinding();
          return;
        }
        if (!isBindable(key)) return;
        hk.bind(hk.binding, key);
        return;
      }

      // 2. While the help overlay is up, only Escape and the help key act.
      if (hk.helpOpen) {
        if (key === 'Escape' || key === hk.keymap.help) {
          e.preventDefault();
          e.stopPropagation();
          hk.setHelpOpen(false);
          return;
        }
        // Never let a stray Space scroll or re-click behind the modal.
        if (key === 'Space') e.preventDefault();
        return;
      }

      if (isTypingTarget(e.target)) return;

      // 3. Help opens with or without a run in progress.
      if (key === hk.keymap.help) {
        e.preventDefault();
        e.stopPropagation();
        blurActiveControl();
        hk.setHelpOpen(true);
        return;
      }

      const state = useGameStore.getState();
      if (!state.run) return;

      const action = actionForKey(hk.keymap, key);
      if (!action) return;

      e.preventDefault();
      e.stopPropagation();
      blurActiveControl();

      switch (action) {
        case 'nextPhase':
          state.nextPhase();
          break;
        case 'nextTurn':
          state.nextTurn();
          break;
        case 'draw':
          state.drawCards(1);
          break;
        case 'shuffle':
          state.shuffleLibrary();
          break;
        case 'untap':
          state.untapAll();
          break;
        case 'mulligan':
          if (canMulligan(state)) state.takeMulligan();
          break;
        case 'focusNote':
          window.dispatchEvent(new CustomEvent(FOCUS_NOTE_EVENT));
          break;
        case 'help':
          break;
      }
    }

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
