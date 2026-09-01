import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PressureEvent } from '../../domain/types';
import type { ResolveEventPayload } from '../../state/gameStore';
import { cardName, isCreatureCard, useGameStore } from '../../state/gameStore';
import { CardView } from '../table/CardView';
import { collectChoices, EVENT_LABEL, seatLabel } from './pressureUi';
import type { Choice } from './pressureUi';

/** Shown once after a wipe resolves; the board it swept is not the whole truth. */
const WIPE_HINT = 'Drag back anything that survives (indestructible, regenerated, protected).';

interface PickerProps {
  title: string;
  choices: Choice[];
  selected?: string;
  emptyText: string;
  onPick: (iid: string) => void;
  onClose: () => void;
}

/**
 * A small card picker that hangs below the dock, so it covers the top of the
 * battlefield without taking the pointer away from the rest of the table.
 * Escape closes it; nothing is focus-trapped.
 */
function CardPicker({ title, choices, selected, emptyText, onPick, onClose }: PickerProps) {
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

  return (
    <div className="pgp-picker" role="group" aria-label={title}>
      <div className="pgp-picker-head">
        <span>{title}</span>
        <button type="button" className="pgp-picker-close" onClick={onClose} aria-label="Close picker">
          ×
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
    </div>
  );
}

interface DockBodyProps {
  event: PressureEvent;
  pendingCount: number;
  /** Called as the event leaves the dock; `hint` asks for the wipe aftermath note. */
  onRetired: (hint: boolean) => void;
}

/**
 * The dock's per-event contents. Mounted with the event id as its key, so every
 * new event arrives with a clean note, damage figure and target choice — which
 * also covers a counter event jumping the queue mid-`moveCard`.
 */
function DockBody({ event, pendingCount, onRetired }: DockBodyProps) {
  const respondToActiveEvent = useGameStore((s) => s.respondToActiveEvent);
  const resolveActiveEvent = useGameStore((s) => s.resolveActiveEvent);
  const declareInteraction = useGameStore((s) => s.declareInteraction);
  // The card cache never changes mid-run, so `cards` alone keys the pickers.
  const cards = useGameStore((s) => s.cards);

  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [damage, setDamage] = useState(() => Math.max(0, Math.round(event.severity.damage ?? 0)));
  const [targetIid, setTargetIid] = useState<string | undefined>(event.targetIid);
  const [pickIid, setPickIid] = useState<string | undefined>(undefined);
  const [nonlands, setNonlands] = useState(event.variant === 'nonlands');
  const [pickerOpen, setPickerOpen] = useState(false);

  const closePicker = useCallback(() => setPickerOpen(false), []);

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
  const needsDiscard = event.type === 'resource' && variant === 'discard' && hand.length > 0;
  const needsSacrifice = event.type === 'resource' && variant === 'sacrifice' && creatures.length > 0;
  const resolveBlocked = (needsDiscard || needsSacrifice) && !pickIid;

  function doRespond(): void {
    onRetired(false);
    respondToActiveEvent(note.trim() || undefined);
  }

  function doDeclare(): void {
    onRetired(false);
    declareInteraction();
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
        payload.wipeNonlands = nonlands;
        break;
      case 'resource':
        if (variant === 'discard' && pickIid) payload.discardIid = pickIid;
        if (variant === 'sacrifice' && pickIid) payload.sacrificeIid = pickIid;
        break;
      default:
        break;
    }

    onRetired(event.type === 'wipe');
    resolveActiveEvent(payload);
  }

  /** Mana-cost-free wording: the button says what happens at the table. */
  function resolveLabel(): string {
    switch (event.type) {
      case 'wipe':
        return nonlands ? 'Destroy all nonlands' : 'Destroy all creatures';
      case 'removal':
        return targetOnBoard && targetName ? `Destroy ${targetName}` : 'It resolves';
      case 'counter':
        return 'It gets countered';
      case 'combat':
        return `Take ${Math.max(0, Math.round(damage) || 0)}`;
      case 'resource':
        if (variant === 'discard') return pickName ? `Discard ${pickName}` : 'Discard a card';
        if (variant === 'sacrifice') return pickName ? `Sacrifice ${pickName}` : 'Sacrifice a permanent';
        return 'It resolves';
      case 'clock':
        return 'Acknowledge';
      default:
        return 'It resolves';
    }
  }

  const respondLabel =
    event.type === 'counter' ? 'Resolve spell (I answer it)' : 'I have an answer';

  return (
    <>
      <div className="pgp-dock-main">
        <span className="pgp-seat">{seatLabel(event.seatId)}</span>
        <span className="pgp-type">{EVENT_LABEL[event.type]}</span>
        <p className="pgp-prompt">{event.prompt}</p>
        {pendingCount > 0 && (
          <span className="pgp-more" title={`${pendingCount} more event(s) waiting behind this one`}>
            +{pendingCount} more
          </span>
        )}
      </div>

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
                target: <strong>{targetName}</strong>
              </>
            ) : (
              <em className="muted">
                {targetName ? `${targetName} already left the battlefield` : 'no target chosen'}
              </em>
            )}
            <button
              type="button"
              className="pgp-link"
              onClick={() => setPickerOpen((open) => !open)}
            >
              pick different target…
            </button>
          </span>
        )}

        {event.type === 'wipe' && (
          <label className="pgp-toggle">
            <input
              type="checkbox"
              checked={nonlands}
              onChange={(e) => setNonlands(e.target.checked)}
            />
            <span>all nonlands</span>
          </label>
        )}

        {event.type === 'resource' && (variant === 'discard' || variant === 'sacrifice') && (
          <span className="pgp-target">
            {pickName ? (
              <>
                {variant === 'discard' ? 'discarding' : 'sacrificing'}: <strong>{pickName}</strong>
              </>
            ) : (
              <em className="muted">
                {variant === 'discard'
                  ? hand.length === 0
                    ? 'your hand is empty'
                    : 'pick a card to pitch'
                  : creatures.length === 0
                    ? 'no creatures to sacrifice'
                    : 'pick a permanent to give up'}
              </em>
            )}
            {(needsDiscard || needsSacrifice || pickIid) && (
              <button
                type="button"
                className="pgp-link"
                onClick={() => setPickerOpen((open) => !open)}
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

        {event.type === 'clock' ? (
          <>
            <button type="button" className="pgp-btn is-primary" onClick={doDeclare}>
              Declare held interaction
            </button>
            <button type="button" className="pgp-btn" onClick={doResolve}>
              Acknowledge
            </button>
          </>
        ) : (
          <>
            <button type="button" className="pgp-btn" onClick={doRespond}>
              {respondLabel}
            </button>
            <button
              type="button"
              className="pgp-btn is-primary"
              disabled={resolveBlocked}
              title={resolveBlocked ? 'Choose a card first' : undefined}
              onClick={doResolve}
            >
              {resolveLabel()}
            </button>
          </>
        )}
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

      {pickerOpen && event.type === 'removal' && (
        <CardPicker
          title="Retarget — pick the permanent that actually died"
          choices={battlefield}
          selected={targetIid}
          emptyText="Nothing on your battlefield."
          onPick={(iid) => {
            setTargetIid(iid);
            closePicker();
          }}
          onClose={closePicker}
        />
      )}

      {pickerOpen && event.type === 'resource' && variant === 'discard' && (
        <CardPicker
          title="Discard — pick the card you pitch"
          choices={hand}
          selected={pickIid}
          emptyText="Your hand is empty."
          onPick={(iid) => {
            setPickIid(iid);
            closePicker();
          }}
          onClose={closePicker}
        />
      )}

      {pickerOpen && event.type === 'resource' && variant === 'sacrifice' && (
        <CardPicker
          title="Sacrifice — pick the creature you give up"
          choices={creatures}
          selected={pickIid}
          emptyText="No creatures on your battlefield."
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

/**
 * The non-modal pressure dock: a banner across the top of the table that never
 * takes control of the board away, so the player can tap mana and move cards
 * while deciding how the event resolves.
 */
export default function EventDock() {
  const event = useGameStore((s) => s.activeEvent);
  const pendingCount = useGameStore((s) => s.pendingEvents.length);
  // Set as an event leaves the dock, and cleared by the next one leaving — so a
  // wipe's aftermath note never outlives the event that follows it.
  const [wipeHint, setWipeHint] = useState(false);

  if (!event) {
    if (!wipeHint) return null;
    return (
      <div className="pgp-hint" role="status">
        <span>{WIPE_HINT}</span>
        <button type="button" className="pgp-link" onClick={() => setWipeHint(false)}>
          dismiss
        </button>
      </div>
    );
  }

  return (
    <section
      className={`pgp-dock type-${event.type}`}
      aria-label={`Pressure event from seat ${event.seatId}`}
    >
      <DockBody key={event.id} event={event} pendingCount={pendingCount} onRetired={setWipeHint} />
    </section>
  );
}
