import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { PressureEvent, SeatId } from '../../domain/types';
import type { AnswerPayload, ResolveEventPayload } from '../../state/gameStore';
import { cardName, isCreatureCard, useGameStore } from '../../state/gameStore';
import { keyLabel, useHotkeyStore } from '../../state/hotkeyStore';
import { EVENT_RESPONSE_EVENT } from '../../hooks/useHotkeys';
import type { EventResponseDetail } from '../../hooks/useHotkeys';
import Glossed from '../glossary/Glossed';
import { CardView } from '../table/CardView';
import {
  answerChoices,
  collectChoices,
  describeAnswers,
  effectiveSweep,
  EVENT_LABEL,
  seatLabel,
  sweepScope,
  untappedLandCount,
} from './pressureUi';
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
 * A small card picker that hangs off the event card, over the battlefield, so it
 * covers cards rather than the readout. Escape closes it; nothing is
 * focus-trapped.
 *
 * The keyboard reaches every choice: the arrows walk the row (it scrolls
 * sideways, so left/right and up/down do the same thing), Enter picks the
 * focused card because it is an ordinary button, and Escape leaves without
 * answering.
 */
function CardPicker({
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
const ANSWER_TITLE = 'Answer with: pick the card';
const ANSWER_EMPTY = 'Nothing in hand or on the board. Answer without a card.';

/**
 * The one shape an answer leaves the dock in. Both places that can send one —
 * the event card and the standing clock — build it here, so a table note is
 * never dropped by whichever path the player happened to answer through.
 * Absent keys rather than empty ones: the store reads `iid` and `note` as
 * optional, and a blank string is not a note.
 */
function answerPayload(iid: string | undefined, note: string): AnswerPayload {
  const payload: AnswerPayload = {};
  if (iid) payload.iid = iid;
  const trimmed = note.trim();
  if (trimmed) payload.note = trimmed;
  return payload;
}

interface AnswerPickerProps {
  /** Called with the card that answered, or nothing at all for an unbound answer. */
  onAnswer: (iid?: string) => void;
  onClose: () => void;
  autoFocus?: boolean;
}

/**
 * The one picker that binds an answer to a card. Every way of answering — the
 * first button, its hotkey, the declare link, the standing clock — opens this
 * one, so the choices, the untapped-land tell and the way out are the same
 * everywhere.
 *
 * It subscribes to `cards` itself rather than taking them as a prop. Only the
 * open picker cares what is in hand, and a caller holding the subscription for
 * it would re-render on every tap, draw and move the player makes with the
 * picker shut.
 */
function AnswerPicker({ onAnswer, onClose, autoFocus }: AnswerPickerProps) {
  const cards = useGameStore((s) => s.cards);
  const choices = useMemo(() => answerChoices(cards), [cards]);
  const lands = useMemo(() => untappedLandCount(cards), [cards]);

  return (
    <CardPicker
      title={ANSWER_TITLE}
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

interface DockBodyProps {
  event: PressureEvent;
  /**
   * Called as the event leaves the pane. A seat id asks for the post-wipe tell
   * under that seat's frame; null clears whatever tell was standing.
   */
  onRetired: (seatId: SeatId | null) => void;
}

/**
 * The card's per-event controls. Mounted with the event id as its key, so every
 * new event arrives with a clean note, damage figure and target choice — which
 * also covers a counter event jumping the queue mid-`moveCard`. The reading
 * above it is not keyed: it is a live region and has to outlive the event.
 */
function DockBody({ event, onRetired }: DockBodyProps) {
  const respondToActiveEvent = useGameStore((s) => s.respondToActiveEvent);
  const resolveActiveEvent = useGameStore((s) => s.resolveActiveEvent);
  const declareInteraction = useGameStore((s) => s.declareInteraction);
  const clock = useGameStore((s) => s.clock);
  // The card cache never changes mid-run, so `cards` alone keys the pickers.
  const cards = useGameStore((s) => s.cards);
  const keymap = useHotkeyStore((s) => s.keymap);

  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [damage, setDamage] = useState(() => Math.max(0, Math.round(event.severity.damage ?? 0)));
  const [targetIid, setTargetIid] = useState<string | undefined>(event.targetIid);
  const [pickIid, setPickIid] = useState<string | undefined>(undefined);
  // The scope toggle starts where the cited card stands, and stays undefined
  // until the player says otherwise: an untouched toggle must not overrule the
  // card's own sweep on the way to the store.
  const [nonlands, setNonlands] = useState<boolean | undefined>(undefined);
  /**
   * Which picker is hanging off the card, if any. 'resolve' is the one the
   * event's own type decides (retarget, discard, sacrifice); 'answer' binds the
   * answer to a card; 'declare' does the same for the race clock. Only ever one
   * at a time, and `openedByKey` says whether it should take the keyboard.
   */
  const [picker, setPicker] = useState<'resolve' | 'answer' | 'declare' | null>(null);
  const [openedByKey, setOpenedByKey] = useState(false);

  const closePicker = useCallback(() => setPicker(null), []);

  const battlefield = useMemo(
    () => collectChoices(cards, (_s, c) => c.zone === 'battlefield'),
    [cards],
  );
  const creatures = useMemo(
    () => collectChoices(cards, (s, c) => c.zone === 'battlefield' && isCreatureCard(s, c)),
    [cards],
  );
  const hand = useMemo(() => collectChoices(cards, (_s, c) => c.zone === 'hand'), [cards]);

  const targetName = useGameStore((s) =>
    targetIid && s.cards[targetIid] ? cardName(s, targetIid) : null,
  );
  const targetOnBoard = useGameStore((s) =>
    targetIid ? s.cards[targetIid]?.zone === 'battlefield' : false,
  );
  const pickName = useGameStore((s) => (pickIid && s.cards[pickIid] ? cardName(s, pickIid) : null));

  const variant = event.variant ?? 'tax';
  // What the wipe sweeps as it stands, and what ticking the box would widen it
  // to. Both come from the citation, so a card that already sweeps artifacts,
  // creatures and enchantments never offers "all nonlands" instead.
  const sweep = effectiveSweep(event, nonlands);
  const wideSweep = effectiveSweep(event, true);

  const needsDiscard = event.type === 'resource' && variant === 'discard' && hand.length > 0;
  const needsSacrifice = event.type === 'resource' && variant === 'sacrifice' && creatures.length > 0;

  // Both answers, worded and gated in the one place the toast over the board
  // reads them from too. Every edit the player has made rides along, so the
  // second button keeps naming the card, the figure and the target it will
  // actually use. Read from the snapshot: this body re-renders whenever `cards`,
  // the target or the pick moves, which is everything the labels depend on.
  const answers = describeAnswers(event, useGameStore.getState(), {
    pickIid,
    targetIid,
    damage,
    nonlands,
  });
  const resolveBlocked = answers.blocked;

  // A tax is mana, not a card. Nothing is asked for and no picker opens — "Pay
  // 2" is the whole answer.
  const isTax = event.type === 'resource' && variant === 'tax';

  function doRespond(iid?: string): void {
    onRetired(null);
    setPicker(null);
    respondToActiveEvent(answerPayload(iid, note));
  }

  function doDeclare(iid?: string): void {
    onRetired(null);
    setPicker(null);
    declareInteraction(answerPayload(iid, note));
  }

  /**
   * The first response, one step later than it used to be: an answer names the
   * card that made it, so the button opens the picker rather than filing a
   * claim. The tax is the exception — it is the one answer with no card in it.
   */
  function beginAnswer(byKey: boolean): void {
    if (isTax) {
      doRespond();
      return;
    }
    setOpenedByKey(byKey);
    setPicker((open) => (open === 'answer' ? null : 'answer'));
  }

  function beginDeclare(byKey: boolean): void {
    setOpenedByKey(byKey);
    setPicker((open) => (open === 'declare' ? null : 'declare'));
  }

  function doResolve(): void {
    const payload: ResolveEventPayload = {};
    const trimmed = note.trim();
    if (trimmed) payload.note = trimmed;

    switch (event.type) {
      case 'combat':
        payload.damageTaken = Math.max(0, Math.round(damage) || 0);
        break;
      case 'removal':
        if (targetIid) payload.targetIid = targetIid;
        break;
      case 'wipe':
        // Sent only when the player touched the toggle. Sending it untouched
        // would narrow every exile-and-artifacts wrath to the two-way scope the
        // checkbox can express.
        if (nonlands !== undefined) payload.wipeNonlands = nonlands;
        break;
      case 'resource':
        if (variant === 'discard' && pickIid) payload.discardIid = pickIid;
        if (variant === 'sacrifice' && pickIid) payload.sacrificeIid = pickIid;
        break;
      default:
        break;
    }

    onRetired(event.type === 'wipe' ? event.seatId : null);
    setPicker(null);
    resolveActiveEvent(payload);
  }

  /**
   * The two numbered responses, answered by the keyboard as well as the mouse.
   * Held in a ref so the listener below is registered once and still calls the
   * current closures — every one of them reads local state that moves.
   */
  const handlers = useRef<{ first: () => void; second: () => void; blocked: boolean }>({
    first: () => beginAnswer(true),
    second: doResolve,
    blocked: false,
  });

  useEffect(() => {
    handlers.current = {
      first: event.type === 'clock' ? () => beginDeclare(true) : () => beginAnswer(true),
      second: doResolve,
      blocked: resolveBlocked,
    };
  });

  useEffect(() => {
    function onResponse(e: Event): void {
      const slot = (e as CustomEvent<EventResponseDetail>).detail?.slot;
      const current = handlers.current;
      if (slot === 1) current.first();
      // A resolution still missing the card it needs is a no-op, not a guess.
      if (slot === 2 && !current.blocked) current.second();
    }
    window.addEventListener(EVENT_RESPONSE_EVENT, onResponse);
    return () => window.removeEventListener(EVENT_RESPONSE_EVENT, onResponse);
  }, []);

  const firstKey = keyLabel(keymap.respondOne);
  const secondKey = keyLabel(keymap.respondTwo);
  // Card names have no length limit worth designing to (the longest printed one
  // runs 141 characters), and this label carries one. It is clamped to two lines
  // in CSS and the whole string rides in the tooltip.
  const resolveText = answers.second;

  return (
    <>
      <div className="pgp-dock-extras">
        {event.type === 'combat' && (
          <label className="pgp-field">
            <span>take</span>
            <input
              type="number"
              min={0}
              className="num"
              data-hotkeys="off"
              value={damage}
              aria-label="Damage taken"
              onChange={(e) => setDamage(Number.parseInt(e.target.value, 10) || 0)}
            />
          </label>
        )}

        {event.type === 'removal' && (
          <span className="pgp-target">
            {targetOnBoard && targetName ? (
              <>
                target:{' '}
                <strong className="pgp-name" title={targetName}>
                  {targetName}
                </strong>
              </>
            ) : (
              <em className="muted pgp-name" title={targetName ?? undefined}>
                {targetName ? `${targetName} already left the battlefield` : 'no target chosen'}
              </em>
            )}
            <button
              type="button"
              className="pgp-link"
              onClick={() => setPicker((open) => (open === 'resolve' ? null : 'resolve'))}
            >
              pick different target…
            </button>
          </span>
        )}

        {event.type === 'wipe' && (
          <label className="pgp-toggle">
            <input
              type="checkbox"
              checked={sweep !== 'creatures'}
              onChange={(e) => setNonlands(e.target.checked)}
            />
            {/* The label reads the card, so the box the player is ticking says
                what ticking it means. Farewell's box says what Farewell does. */}
            <span>{sweepScope(wideSweep)}</span>
          </label>
        )}

        {event.type === 'resource' && (variant === 'discard' || variant === 'sacrifice') && (
          <span className="pgp-target">
            {pickName ? (
              <>
                {variant === 'discard' ? 'discarding' : 'sacrificing'}:{' '}
                <strong className="pgp-name" title={pickName}>
                  {pickName}
                </strong>
              </>
            ) : (
              <em className="muted">
                {variant === 'discard'
                  ? hand.length === 0
                    ? 'your hand is empty'
                    : 'pick a card to pitch'
                  : creatures.length === 0
                    ? 'no creatures to sacrifice'
                    : 'pick a creature to give up'}
              </em>
            )}
            {(needsDiscard || needsSacrifice || pickIid) && (
              <button
                type="button"
                className="pgp-link"
                onClick={() => setPicker((open) => (open === 'resolve' ? null : 'resolve'))}
              >
                {pickIid ? 'change…' : 'choose…'}
              </button>
            )}
          </span>
        )}

        <span className="pgp-dock-spacer" />

        <button
          type="button"
          className="pgp-link pgp-note-toggle"
          aria-expanded={noteOpen}
          onClick={() => setNoteOpen((open) => !open)}
        >
          {noteOpen ? 'hide note' : 'add note'}
        </button>
      </div>

      {noteOpen && (
        <div className="pgp-note" data-hotkeys="off">
          <input
            type="text"
            value={note}
            autoFocus
            placeholder="What's your answer?"
            aria-label="What's your answer?"
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      )}

      <div className="pgp-answers">
        {event.type === 'clock' ? (
          <>
            <button
              type="button"
              className="pgp-btn is-primary"
              aria-expanded={picker === 'declare'}
              onClick={() => beginDeclare(false)}
            >
              <span className="pgp-answer-key">{firstKey}</span>
              {answers.first}
            </button>
            <button type="button" className="pgp-btn" onClick={doResolve}>
              <span className="pgp-answer-key">{secondKey}</span>
              {resolveText}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="pgp-btn"
              aria-expanded={isTax ? undefined : picker === 'answer'}
              onClick={() => beginAnswer(false)}
            >
              <span className="pgp-answer-key">{firstKey}</span>
              <span className="pgp-btn-label">{answers.first}</span>
            </button>
            <button
              type="button"
              className="pgp-btn is-primary"
              disabled={resolveBlocked}
              title={resolveBlocked ? 'Choose a card first' : resolveText}
              onClick={doResolve}
            >
              <span className="pgp-answer-key">{secondKey}</span>
              <span className="pgp-btn-label">{resolveText}</span>
            </button>
          </>
        )}
      </div>

      {/* A clock outlives the warning that announced it, so its escape hatch
          rides along with whatever event is in front of the player. It answers
          the clock only: the event in front stays on the card, unretired. */}
      {clock && event.type !== 'clock' && (
        <button
          type="button"
          className="pgp-link pgp-declare"
          aria-expanded={picker === 'declare'}
          onClick={() => beginDeclare(false)}
        >
          declare held interaction · answers {seatLabel(clock.seatId)}'s clock
        </button>
      )}

      {/* One picker for both ways of answering. They ask the same question and
          offer the same cards; only where the answer is filed differs. */}
      {(picker === 'answer' || picker === 'declare') && (
        <AnswerPicker
          autoFocus={openedByKey}
          onAnswer={picker === 'declare' ? doDeclare : doRespond}
          onClose={closePicker}
        />
      )}

      {picker === 'resolve' && event.type === 'removal' && (
        <CardPicker
          title="Retarget: pick the permanent that actually died"
          choices={battlefield}
          selected={targetIid}
          emptyText="Nothing on your battlefield. Resolve it with nothing to destroy."
          onPick={(iid) => {
            setTargetIid(iid);
            closePicker();
          }}
          onClose={closePicker}
        />
      )}

      {picker === 'resolve' && event.type === 'resource' && variant === 'discard' && (
        <CardPicker
          title="Discard: pick the card you pitch"
          choices={hand}
          selected={pickIid}
          emptyText="Your hand is empty. Resolve it with nothing to discard."
          onPick={(iid) => {
            setPickIid(iid);
            closePicker();
          }}
          onClose={closePicker}
        />
      )}

      {picker === 'resolve' && event.type === 'resource' && variant === 'sacrifice' && (
        <CardPicker
          title="Sacrifice: pick the creature you give up"
          choices={creatures}
          selected={pickIid}
          emptyText="No creatures on your battlefield. Resolve it with nothing to sacrifice."
          onPick={(iid) => {
            setPickIid(iid);
            closePicker();
          }}
          onClose={closePicker}
        />
      )}
    </>
  );
}

/** Standing race clock with no event in front of it — the declare hatch stays reachable. */
function ClockAnswer() {
  const declareInteraction = useGameStore((s) => s.declareInteraction);
  const keymap = useHotkeyStore((s) => s.keymap);

  const [open, setOpen] = useState(false);
  const [openedByKey, setOpenedByKey] = useState(false);
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);

  // The clock is the only thing to answer here, so it owns the first response
  // key just as an event card's first button would — and answers the same way,
  // by naming the card that is holding the seat off.
  useEffect(() => {
    function onResponse(e: Event): void {
      if ((e as CustomEvent<EventResponseDetail>).detail?.slot !== 1) return;
      setOpenedByKey(true);
      setOpen((standing) => !standing);
    }
    window.addEventListener(EVENT_RESPONSE_EVENT, onResponse);
    return () => window.removeEventListener(EVENT_RESPONSE_EVENT, onResponse);
  }, []);

  return (
    <>
      <div className="pgp-dock-extras">
        <span className="pgp-dock-spacer" />
        <button
          type="button"
          className="pgp-link pgp-note-toggle"
          aria-expanded={noteOpen}
          onClick={() => setNoteOpen((shown) => !shown)}
        >
          {noteOpen ? 'hide note' : 'add note'}
        </button>
      </div>

      {noteOpen && (
        <div className="pgp-note" data-hotkeys="off">
          <input
            type="text"
            value={note}
            autoFocus
            placeholder="What's your answer?"
            aria-label="What's your answer?"
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      )}

      <div className="pgp-answers">
        <button
          type="button"
          className="pgp-btn is-primary"
          aria-expanded={open}
          onClick={() => {
            setOpenedByKey(false);
            setOpen((standing) => !standing);
          }}
        >
          <span className="pgp-answer-key">{keyLabel(keymap.respondOne)}</span>
          Declare held interaction
        </button>
      </div>

      {open && (
        <AnswerPicker
          autoFocus={openedByKey}
          onAnswer={(iid) => {
            setOpen(false);
            declareInteraction(answerPayload(iid, note));
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

interface EventDockProps {
  /**
   * Raised as an event retires. A seat id asks the HUD to post the post-wipe
   * survivor tell under that seat; null clears it.
   */
  onWipeResolved: (seatId: SeatId | null) => void;
}

/**
 * The active event, hung under the frame of the seat that produced it. Non-modal
 * by design: the player can tap mana and move cards while deciding how the event
 * resolves, and the hand never leaves the screen.
 *
 * One section serves the event and the bare race clock alike, because the
 * reading at the top of it — seat, class, prompt — is a live region, and a live
 * region only speaks if it was already mounted when its text changed. Keying the
 * controls beneath it is what resets the note, the damage figure and the target
 * choice per event; the reading itself is never keyed.
 */
export default function EventDock({ onWipeResolved }: EventDockProps) {
  const event = useGameStore((s) => s.activeEvent);
  const clock = useGameStore((s) => s.clock);

  const standing = event ?? clock;
  const type = event?.type ?? 'clock';
  const seatId = standing?.seatId;
  const prompt = event
    ? event.prompt
    : clock
      ? `${seatLabel(clock.seatId)} wins after your turn ${clock.deadlineTurn}.`
      : null;

  return (
    <section
      className={
        `pgp-dock type-${type}` + (event ? '' : ' is-quiet') + (standing ? '' : ' is-empty')
      }
      aria-label={
        event
          ? `Active event: ${EVENT_LABEL[event.type]} from ${seatLabel(event.seatId)}`
          : 'Race clock'
      }
    >
      {/* Mounted whether or not anything is standing, and clipped to nothing
          when nothing is: a live region only speaks if it was already there
          when its text arrived, so the first event of a run has to land in a
          region that existed before it did. */}
      <div className="pgp-say" role="status">
        {standing && (
          <>
            {/* Whatever is waiting behind this one is printed under the seat
                that will throw it, so the head no longer carries a count. */}
            <div className="pgp-dock-head">
              <span className="pgp-head-label">{event ? 'active event' : 'race clock'}</span>
            </div>

            <div className="pgp-dock-main">
              <span className="pgp-seat">{seatLabel(seatId!)}</span>
              <span className={`pgp-type type-${type}`}>{EVENT_LABEL[type]}</span>
            </div>

            {/* The prose the player actually reads under time pressure, so the
                keywords in it carry their reminder text. The answer buttons
                below are labels, not rules text, and are left alone. */}
            <p className="pgp-prompt">{prompt && <Glossed text={prompt} />}</p>

            {/* The card the seat is casting, cited: name, printed mana value,
                and the real effect the player resolves by hand. The prompt says
                what happened; this says what it was, so the run teaches which
                cards produce which pressure. The effect is the line that gives
                way when the foot is short. */}
            {event?.card && (
              <div className="pgp-cite">
                <div className="pgp-cite-head">
                  <span className="pgp-cite-name" title={event.card.name}>
                    {event.card.name}
                  </span>
                  <span className="pgp-cite-mv" title={`Mana value ${event.card.mv}`}>
                    {event.card.mv}
                  </span>
                </div>
                <p className="pgp-cite-effect" title={event.card.effect}>
                  <Glossed text={event.card.effect} />
                </p>
              </div>
            )}
          </>
        )}
      </div>

      {event && <DockBody key={event.id} event={event} onRetired={onWipeResolved} />}
      {!event && clock && <ClockAnswer />}
    </section>
  );
}
