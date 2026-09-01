import { useEffect } from 'react';
import { useGameStore } from '../state/gameStore';

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

export const HOTKEYS: { key: string; label: string; action: string }[] = [
  { key: 'D', label: 'D', action: 'Draw a card' },
  { key: 'S', label: 'S', action: 'Shuffle library' },
  { key: 'U', label: 'U', action: 'Untap all' },
  { key: 'Space', label: 'Space', action: 'Next phase' },
  { key: 'T', label: 'T', action: 'Next turn' },
  { key: 'N', label: 'N', action: 'Jump to the note box' },
];

/** Fired by the N hotkey; the HUD's run-log note input focuses itself on it. */
export const FOCUS_NOTE_EVENT = 'pg:focus-note';

/** Global keyboard shortcuts. No-ops while no run is active. */
export function useHotkeys(): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;

      const state = useGameStore.getState();
      if (!state.run) return;

      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      switch (key) {
        case 'd':
          e.preventDefault();
          state.drawCards(1);
          break;
        case 's':
          e.preventDefault();
          state.shuffleLibrary();
          break;
        case 'u':
          e.preventDefault();
          state.untapAll();
          break;
        case ' ':
          e.preventDefault();
          state.nextPhase();
          break;
        case 't':
          e.preventDefault();
          state.nextTurn();
          break;
        case 'n':
          e.preventDefault();
          window.dispatchEvent(new CustomEvent(FOCUS_NOTE_EVENT));
          break;
        default:
          break;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
