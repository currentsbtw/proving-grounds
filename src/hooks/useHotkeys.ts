import { useEffect } from 'react';
import { canCastToStack, canMulligan, useGameStore } from '../state/gameStore';
import {
  actionForKey,
  isBindable,
  normalizeKey,
  useHotkeyStore,
} from '../state/hotkeyStore';

/**
 * Whether a key press belongs to whatever the player is typing into. Exported so
 * component-level key handlers can stand down on the same terms this one does.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
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
 * Whether this press belongs to a card the keyboard is sitting on. A focused
 * card answers Enter and Space itself — play it, tap it — so the global
 * listener has to let those two through rather than stepping the phase behind
 * it. Only the keyboard ever leaves a card focused: `CardView` blurs on pointer
 * release, so a mouse click on a permanent does not quietly reassign Space.
 */
function isCardActivation(e: KeyboardEvent): boolean {
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return false;
  if (!(e.target instanceof HTMLElement)) return false;
  return e.target.closest('[data-card-activate]') !== null;
}

/**
 * The card the keyboard is currently sitting on, or null. Read off the DOM
 * rather than out of the store because focus is the browser's state, not the
 * game's — and it has to be read *before* `blurActiveControl` runs, which is
 * why it is not folded into the switch below.
 */
function focusedCardIid(): string | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return null;
  return el.closest<HTMLElement>('[data-card-iid]')?.dataset.cardIid ?? null;
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

/** Fired by the note hotkey; the run log's note input focuses itself on it. */
export const FOCUS_NOTE_EVENT = 'pg:focus-note';

/**
 * Fired by the two response hotkeys. The active event card answers it, because
 * the second response often carries table detail the card is holding — the
 * damage figure, the retargeted permanent, the card being pitched — and only it
 * knows whether that detail is complete enough to resolve on.
 */
export const EVENT_RESPONSE_EVENT = 'pg:event-response';

export type EventResponseDetail = { slot: 1 | 2 };

/**
 * Fired by the ability hotkey. The stack tray answers it by focusing its own
 * input — the text of an ability is the player's to write, so the key opens the
 * field rather than guessing at a label.
 */
export const STACK_ABILITY_EVENT = 'pg:stack-ability';

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

      // 3. A focused card owns Enter and Space; the table is where the player is.
      if (isCardActivation(e)) return;

      // 4. Help opens with or without a run in progress.
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

      // Preview belongs to the card under the keyboard and to nothing else. It
      // was handed to that card above; with focus anywhere else the key stands
      // down rather than stealing focus from whatever holds it.
      if (action === 'preview') return;

      // Read before the blur below takes the focus this depends on away.
      const focusedIid = action === 'castToStack' ? focusedCardIid() : null;

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
        case 'castToStack':
          // Same test the menu and the drop band offer on: a land, a token, or
          // a spell a seat has already spoken up about is a silent no-op.
          if (focusedIid && canCastToStack(state, focusedIid)) state.castToStack(focusedIid);
          break;
        case 'resolveTop':
          state.resolveTop();
          break;
        case 'pushAbility':
          window.dispatchEvent(new CustomEvent(STACK_ABILITY_EVENT));
          break;
        case 'focusNote':
          window.dispatchEvent(new CustomEvent(FOCUS_NOTE_EVENT));
          break;
        case 'respondOne':
        case 'respondTwo':
          // A standing race clock is answerable on key 1 with no event in front
          // of it, so the clock alone is enough to make the responses live.
          if (state.activeEvent || state.clock) {
            window.dispatchEvent(
              new CustomEvent<EventResponseDetail>(EVENT_RESPONSE_EVENT, {
                detail: { slot: action === 'respondOne' ? 1 : 2 },
              }),
            );
          }
          break;
        case 'help':
          break;
      }
    }

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
