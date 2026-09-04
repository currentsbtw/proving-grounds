import { useEffect, useMemo, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { AnswerPayload } from '../../state/gameStore';
import { useGameStore } from '../../state/gameStore';
import { CardView } from '../table/CardView';
import { answerChoices, untappedLandCount } from './pressureUi';
import type { Choice } from './pressureUi';

interface PickerProps {
  title: string;
  choices: Choice[];
  selected?: string;
  emptyText: string;
  /** A reading printed beside the title. Never a gate on what can be picked. */
  tell?: string;
  /** An extra way out, printed under the row (the answer picker's unbound link). */
  footer?: ReactNode;
  /** Take the keyboard on open. Set where the picker was opened by a hotkey. */
  autoFocus?: boolean;
  onPick: (iid: string) => void;
  onClose: () => void;
}

/**
 * A small card picker that hangs off whatever opened it, over the battlefield,
 * so it covers cards rather than the readout. Escape closes it; nothing is
 * focus-trapped.
 *
 * The keyboard reaches every choice: the arrows walk the row (it scrolls
 * sideways, so left/right and up/down do the same thing), Enter picks the
 * focused card because it is an ordinary button, and Escape leaves without
 * answering.
 *
 * It lives here rather than in the dock because `AnswerPicker` is the thing two
 * features share, and a picker whose only implementation sat in `EventDock`
 * would have made the seat frames import the dock to remove a hate piece.
 */
export function CardPicker({
  title,
  choices,
  selected,
  emptyText,
  tell,
  footer,
  autoFocus,
  onPick,
  onClose,
}: PickerProps) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // On a hotkey open the first choice takes the keyboard, so the player who
  // never touched the mouse can answer without hunting for the row. An empty
  // row falls back to whatever else the picker offers, rather than dropping the
  // focus on the floor.
  useEffect(() => {
    if (!autoFocus) return;
    const first = root.current?.querySelector<HTMLElement>('.pgp-pick, .pgp-picker-unbound');
    first?.focus();
  }, [autoFocus]);

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    const picks = Array.from(root.current?.querySelectorAll<HTMLElement>('.pgp-pick') ?? []);
    if (picks.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    // The card inside each choice is its own tab stop (the drag library makes it
    // one), so walk up from whatever actually holds focus.
    const held =
      document.activeElement instanceof Element
        ? document.activeElement.closest('.pgp-pick')
        : null;
    const at = held ? picks.indexOf(held as HTMLElement) : -1;
    picks[at === -1 ? 0 : (at + step + picks.length) % picks.length].focus();
  }

  return (
    <div
      className="pgp-picker"
      role="group"
      aria-label={title}
      ref={root}
      onKeyDown={onKeyDown}
    >
      <div className="pgp-picker-head">
        <span>{title}</span>
        {tell && <span className="pgp-picker-tell">{tell}</span>}
        <button type="button" className="pgp-picker-close" onClick={onClose} aria-label="Close picker">
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false">
            <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1.2" fill="none" />
          </svg>
        </button>
      </div>
      {choices.length === 0 ? (
        <p className="pgp-picker-empty">{emptyText}</p>
      ) : (
        <div className="pgp-picker-row">
          {choices.map((choice) => (
            <button
              key={choice.card.iid}
              type="button"
              className={'pgp-pick' + (selected === choice.card.iid ? ' is-picked' : '')}
              title={choice.name}
              onClick={() => onPick(choice.card.iid)}
            >
              <CardView card={choice.card} width={54} small badge={false} menu={false} />
              <span className="pgp-pick-name">{choice.name}</span>
            </button>
          ))}
        </div>
      )}
      {footer}
    </div>
  );
}

/** Title and empty line the answer picker wears, wherever it is opened from. */
export const ANSWER_TITLE = 'Answer with: pick the card';
export const ANSWER_EMPTY = 'Nothing in hand or on the board. Answer without a card.';

/**
 * The one shape an answer leaves the readout in. Every place that can send one —
 * the event card, the standing clock, the Remove button on a hate piece — builds
 * it here, so a table note is never dropped by whichever path the player
 * happened to answer through. Absent keys rather than empty ones: the store
 * reads `iid` and `note` as optional, and a blank string is not a note. The note
 * is defaulted away because only the dock has a box to type one in.
 */
export function answerPayload(iid: string | undefined, note = ''): AnswerPayload {
  const payload: AnswerPayload = {};
  if (iid) payload.iid = iid;
  const trimmed = note.trim();
  if (trimmed) payload.note = trimmed;
  return payload;
}

export interface AnswerPickerProps {
  /** Called with the card that answered, or nothing at all for an unbound answer. */
  onAnswer: (iid?: string) => void;
  onClose: () => void;
  autoFocus?: boolean;
  /**
   * What the picker is being asked for, when it is not the event in front of the
   * player: a hate piece names the card being removed, because a seat can be
   * holding one while an unrelated event is on the dock.
   */
  title?: string;
}

/**
 * The one picker that binds an answer to a card. Every way of answering — the
 * first button, its hotkey, the declare link, the standing clock, a seat's
 * Remove button — opens this one, so the choices, the untapped-land tell and the
 * way out are the same everywhere.
 *
 * It subscribes to `cards` itself rather than taking them as a prop. Only the
 * open picker cares what is in hand, and a caller holding the subscription for
 * it would re-render on every tap, draw and move the player makes with the
 * picker shut.
 */
export default function AnswerPicker({ onAnswer, onClose, autoFocus, title }: AnswerPickerProps) {
  const cards = useGameStore((s) => s.cards);
  const choices = useMemo(() => answerChoices(cards), [cards]);
  const lands = useMemo(() => untappedLandCount(cards), [cards]);

  return (
    <CardPicker
      title={title ?? ANSWER_TITLE}
      choices={choices}
      emptyText={ANSWER_EMPTY}
      tell={`untapped lands: ${lands}`}
      autoFocus={autoFocus}
      onPick={(iid) => onAnswer(iid)}
      onClose={onClose}
      footer={
        <button type="button" className="pgp-link pgp-picker-unbound" onClick={() => onAnswer()}>
          answer without a card
        </button>
      }
    />
  );
}
