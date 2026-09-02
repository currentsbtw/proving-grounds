import { useDroppable } from '@dnd-kit/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { StackItem } from '../../domain/types';
import { manaValueOf, useGameStore } from '../../state/gameStore';
import { keyLabel, useHotkeyStore } from '../../state/hotkeyStore';
import { STACK_ABILITY_EVENT } from '../../hooks/useHotkeys';
import { seatLabel } from '../pressure/pressureUi';
import './stack.css';

/** The droppable a dragged card is cast on. */
export const STACK_DROP_ID = 'stack-tray';

/**
 * What each item prints on its chip. The counter reads as the event class it is
 * — the same word the dock prints — so the two never look like two different
 * things happening.
 */
const KIND_LABEL: Record<StackItem['kind'], string> = {
  spell: 'Spell',
  ability: 'Ability',
  counter: 'Counterspell',
};

/** The mana value badge only exists for a card, and only once its face is known. */
function useManaValue(iid: string | undefined): number | null {
  return useGameStore((s) => {
    if (!iid) return null;
    const card = s.cards[iid];
    if (!card || card.isToken) return null;
    return manaValueOf(s, card);
  });
}

interface RowProps {
  item: StackItem;
  /** 1 is the top of the stack: the next thing that resolves. */
  position: number;
  top: boolean;
  /** Accent is spent on the event when one is waiting, so Resolve stands down. */
  accent: boolean;
  /** A spell a counter is held over: it leaves the tray with the counter. */
  locked: boolean;
}

function StackRow({ item, position, top, accent, locked }: RowProps) {
  const resolveTop = useGameStore((s) => s.resolveTop);
  const removeStackItem = useGameStore((s) => s.removeStackItem);
  const resolveKey = useHotkeyStore((s) => keyLabel(s.keymap.resolveTop));
  const mv = useManaValue(item.kind === 'spell' ? item.iid : undefined);
  const isCounter = item.kind === 'counter';

  return (
    <li className={`tbl-tray-row${top ? ' is-top' : ''}`}>
      <span className="tbl-tray-pos">{position}</span>

      <span className={`rd-chip tbl-tray-chip${isCounter ? ' is-counter' : ''}`}>
        {KIND_LABEL[item.kind]}
      </span>

      {isCounter && item.seatId && (
        <span className="rd-chip tbl-tray-chip">{seatLabel(item.seatId)}</span>
      )}

      <span className="tbl-tray-label">{item.label}</span>

      {mv !== null && <span className="tbl-tray-mv">{mv}</span>}

      {/* The action sits in a slot of its own width, so the mana values above
          and below it line up the way every other figure on the sheet does. */}
      <span className="tbl-tray-act">
        {top && (
          <button
            type="button"
            className={`tbl-tray-resolve${accent ? ' is-accent' : ''}`}
            disabled={isCounter}
            onClick={() => resolveTop()}
            title={isCounter ? 'The counter is answered on the event card' : undefined}
          >
            <span>Resolve</span>
            {resolveKey && (
              <span className="rd-key" aria-hidden="true">
                {resolveKey}
              </span>
            )}
          </button>
        )}

        {/* Taking something back is a correction, and the top of the stack is
            exactly where a mis-cast lands: the quiet word is printed on every
            row it applies to, the top row included, so an accident costs a
            click rather than a resolution. A counter, and the spell held under
            one, are the event's to settle and neither offers it. */}
        {!isCounter && !locked && (
          <button
            type="button"
            className="rd-quiet-btn tbl-tray-remove"
            onClick={() => removeStackItem(item.id)}
          >
            remove
          </button>
        )}
      </span>
    </li>
  );
}

/**
 * The stack as the player declared it: last in, first out, top of the list.
 *
 * Bookkeeping only. Nothing here decides what triggers, what is legal, or whose
 * turn it is to act — it holds the order the player put things in and hands one
 * back at a time, so a turn with three things waiting is readable instead of
 * remembered.
 *
 * It costs the board nothing while it is empty: with no item on the stack, no
 * drag under way and no ability being typed, the component renders nothing at
 * all and the grid row it lives in collapses.
 */
interface TrayProps {
  /** A card is in the air. */
  dragging: boolean;
  /**
   * That card can actually be cast — the store's rule, read once at drag start.
   * A land or a token gets no rule to aim at, so the offer is never made and
   * never silently declined.
   */
  canDrop: boolean;
}

export function StackTray({ dragging, canDrop }: TrayProps) {
  const stack = useGameStore((s) => s.stack);
  const pushAbility = useGameStore((s) => s.pushAbility);
  const hasEvent = useGameStore((s) => s.activeEvent !== null);

  const [asking, setAsking] = useState(false);
  const [text, setText] = useState('');
  const [focusTick, setFocusTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const { setNodeRef, isOver } = useDroppable({ id: STACK_DROP_ID });

  const ask = useCallback(() => {
    setAsking(true);
    setFocusTick((n) => n + 1);
  }, []);

  // The ability key aims here rather than opening a prompt, and mounts the tray
  // on the way in when nothing is on the stack yet.
  useEffect(() => {
    function onAsk(): void {
      ask();
    }
    window.addEventListener(STACK_ABILITY_EVENT, onAsk);
    return () => window.removeEventListener(STACK_ABILITY_EVENT, onAsk);
  }, [ask]);

  useEffect(() => {
    if (focusTick === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusTick]);

  // The band only opens for a drag it can accept. Dragging a land over an empty
  // stack leaves the board exactly as it was, which is the honest answer.
  const offering = dragging && canDrop;
  const visible = stack.length > 0 || offering || asking;
  if (!visible) return null;

  const rows = stack.slice().reverse();
  const topItem = rows[0];
  const topIsCounter = topItem?.kind === 'counter';
  // A spell with a counter held over it is not the player's to tidy away: the
  // event decides whether it resolves or dies, and both come off together.
  const held = new Set(
    stack.filter((item) => item.kind === 'counter' && item.iid).map((item) => item.iid),
  );

  function push(): void {
    const label = text.trim();
    if (!label) return;
    pushAbility(label);
    setText('');
    // The push is the end of the ask. The row it made is what keeps the tray
    // open from here.
    setAsking(false);
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    push();
  }

  function onInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>): void {
    // Enter is handled here rather than left to the form's implicit submit, so
    // one press is one push whatever the browser would have done with it.
    if (e.key === 'Enter') {
      e.preventDefault();
      push();
      return;
    }
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    setText('');
    setAsking(false);
    e.currentTarget.blur();
  }

  return (
    <section className="tbl-tray" aria-label="Stack">
      {/* The printed rule is the target, and nothing else in the band is: a card
          let go over a row, the note or the ability field is a card let go over
          the tray, not a cast. The rule is drawn at a comfortable height so
          aiming at it is not a skill. */}
      <div
        ref={setNodeRef}
        className={`tbl-tray-drop${offering ? ' is-live' : ''}${isOver ? ' is-over' : ''}`}
        aria-hidden={!offering}
      >
        <span>Cast to stack</span>
      </div>

      <div className="tbl-tray-head">
        <span className="panel-heading tbl-tray-title">Stack</span>
        <span className="tbl-tray-count">{stack.length}</span>
        <span className="tbl-tray-caption">Resolves top first</span>
        <button type="button" className="rd-quiet-btn tbl-tray-quiet" onClick={ask}>
          + ability
        </button>
      </div>

      {stack.length > 0 && (
        <ol className="tbl-tray-list">
          {rows.map((item, i) => (
            <StackRow
              key={item.id}
              item={item}
              position={i + 1}
              top={i === 0}
              accent={!hasEvent}
              locked={item.kind === 'spell' && !!item.iid && held.has(item.iid)}
            />
          ))}
        </ol>
      )}

      {topIsCounter && (
        <p className="tbl-tray-note">Answer the counter on 1 or 2.</p>
      )}

      <form className="tbl-tray-foot" data-hotkeys="off" onSubmit={submit}>
        <input
          ref={inputRef}
          type="text"
          value={text}
          maxLength={140}
          placeholder="Ability or trigger"
          aria-label="Push an ability or trigger onto the stack"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onInputKeyDown}
          // Looking away ends the ask, whatever was typed. The draft is kept in
          // state rather than in the tray's existence, so a tray held open by
          // half a sentence is not a thing that happens, and the key comes back
          // to the words that were left.
          onBlur={() => setAsking(false)}
        />
        {/* Pressing this must not first take the focus away from the field it
            submits: with an empty stack that blur is what closes the tray, and
            the button would go out from under the pointer. */}
        <button
          type="submit"
          className="tbl-tray-push"
          disabled={text.trim() === ''}
          onMouseDown={(e) => e.preventDefault()}
        >
          Push
        </button>
      </form>
    </section>
  );
}

export default StackTray;
