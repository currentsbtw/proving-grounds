import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { formatDuration } from '../../domain/duration';
import { PHASE_LABELS } from '../../domain/phases';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { commanderTax, isLandCard, useGameStore } from '../../state/gameStore';
import type { GameState } from '../../state/gameStore';
import { keyLabel, useHotkeyStore } from '../../state/hotkeyStore';
import { seatLabel } from '../pressure/pressureUi';
import { LifeSteps, signed } from './SeatFrame';

/** The drawers behind the bar's tabs. `keys` is the hotkey overlay, not a drawer. */
export type DrawerId = 'log' | 'notes' | 'tokens' | 'judge' | 'endrun';

/** One name per drawer: the tab and the head of the drawer it opens agree. */
export const TAB_LABEL: Record<DrawerId, string> = {
  log: 'Log',
  notes: 'Notes',
  tokens: 'Tokens',
  judge: 'Judge',
  endrun: 'End run',
};

/**
 * Below this the tab row gives up its one two-word label. It buys the row the
 * width the clock reading needs, and END RUN is the tab that can afford it: the
 * button keeps "End run" in its `aria-label` and its tooltip either way.
 */
const TIGHT_TABS = '(max-width: 1280px)';

/** How long the clock has left, in the wording the standing warning used. */
function turnsLabel(remaining: number): string {
  if (remaining <= 0) return 'last turn';
  if (remaining === 1) return '1 turn';
  return `${remaining} turns`;
}

/** Printed label, tabular figure, optional caption — the readout's unit, laid on its side. */
function Stat({ label, value, sub }: { label: string; value: string; sub?: ReactNode }) {
  return (
    <div className="hud-stat">
      <span className="rd-label">{label}</span>
      <span className="hud-stat-value num">{value}</span>
      {sub && <span className="hud-stat-sub">{sub}</span>}
    </div>
  );
}

/**
 * The shot clock, counting down and then up. Mounted only while a run is being
 * played against one, so a run with no clock pays nothing for it — not the
 * interval, not the slot.
 *
 * It reads two figures the store already holds and writes nothing back. A
 * countdown that logged, or that pushed a second into state, would put a line
 * in the run log for every second the player spent thinking, and the log is the
 * product (PRODUCT.md principle 3).
 *
 * OVER is a word, not a colour: the reading says which side of the limit it is
 * on before any ink does.
 */
function ShotClock({ seconds, startedAt }: { seconds: number; startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const spent = Math.max(0, Math.floor((now - startedAt) / 1000));
  const over = spent > seconds;
  const reading = over ? `OVER ${formatDuration(spent - seconds)}` : formatDuration(seconds - spent);

  // A span in the TURN stat's caption rather than a slot of its own: a slot
  // wide enough for "OVER 0:12" was what squeezed the race clock reading out of
  // the bar at 1440, and the time a turn has taken is a fact about the turn.
  return (
    <span
      className={'hud-shot num' + (over ? ' is-over' : '')}
      title={`Shot clock: ${formatDuration(seconds)} a turn`}
    >
      {reading}
    </span>
  );
}

interface PlayerBarProps {
  drawer: DrawerId | null;
  helpOpen: boolean;
  onOpenTab: (id: DrawerId) => void;
  onToggleHelp: () => void;
}

/**
 * Your own numbers as one bar across the foot of the live shell: the readings
 * first, in the order they are looked at, then the two turn controls, then the
 * tabs that open the on-demand drawers over the board.
 */
export default function PlayerBar({
  drawer,
  helpOpen,
  onOpenTab,
  onToggleHelp,
}: PlayerBarProps) {
  const turn = useGameStore((s) => s.turn);
  const phase = useGameStore((s) => s.phase);
  const life = useGameStore((s) => s.playerLife);
  const turnStartLife = useGameStore((s) => s.turnStartLife);
  const clock = useGameStore((s) => s.clock);
  const shotClockSeconds = useGameStore((s) => s.shotClockSeconds);
  const turnStartedAt = useGameStore((s) => s.turnStartedAt);
  const nextPhase = useGameStore((s) => s.nextPhase);
  const nextTurn = useGameStore((s) => s.nextTurn);
  const undoLastLifeChange = useGameStore((s) => s.undoLastLifeChange);
  const keymap = useHotkeyStore((s) => s.keymap);
  const tightTabs = useMediaQuery(TIGHT_TABS);

  // The three card-derived figures share one walk of the battlefield. Subscribing
  // to the inputs and deriving here keeps the bar off every unrelated store
  // tick — the run log alone writes a line for every action taken.
  const cards = useGameStore((s) => s.cards);
  const cardData = useGameStore((s) => s.cardData);
  const commanderCasts = useGameStore((s) => s.commanderCasts);

  const { handCount, mana, tax } = useMemo(() => {
    // `isLandCard` reads the type line out of `cardData` and `commanderTax` reads
    // `commanderCasts`; both take the whole state, so the two slices are handed
    // straight back to them rather than fetched again behind the memo's back.
    const state = { cards, cardData, commanderCasts } as GameState;
    let hand = 0;
    let open = 0;
    let lands = 0;
    // Partners each carry their own tax, so a pair shows both rather than a
    // number belonging to neither.
    const commanderIds = new Set<string>();

    for (const card of Object.values(cards)) {
      if (card.zone === 'hand') hand += 1;
      if (card.isCommander && card.scryfallId) commanderIds.add(card.scryfallId);
      if (card.zone !== 'battlefield' || !isLandCard(state, card)) continue;
      lands += 1;
      if (!card.tapped) open += 1;
    }

    return {
      handCount: hand,
      mana: `${open}/${lands}`,
      tax:
        commanderIds.size === 0
          ? '0'
          : [...commanderIds].map((id) => commanderTax(state, id)).join(' / '),
    };
  }, [cards, cardData, commanderCasts]);

  const swing = life - turnStartLife;
  const remaining = clock ? clock.deadlineTurn - turn : 0;
  const clockUrgent = clock !== null && remaining <= 1;

  // Two wordings of one reading. The bar prints the seat letter alone, because
  // the deadline turn is the number this slot exists for and "Seat A" was what
  // pushed it under the ellipsis at 1280. The full sentence is what is read
  // aloud and what the tooltip carries; nothing is lost, it is just abbreviated
  // where the frames already print A, B and C the same way.
  const clockText = clock
    ? `${clock.seatId} · T${clock.deadlineTurn} · ${turnsLabel(remaining)}`
    : 'none';
  const clockSpoken = clock
    ? `${seatLabel(clock.seatId)} · T${clock.deadlineTurn} · ${turnsLabel(remaining)}`
    : 'none';

  return (
    <section className="hud-bar" aria-label="You">
      {/* The shot clock rides in the turn's caption. Remounted on every turn
          (keyed on the turn's start stamp), so the countdown restarts from the
          limit without the component having to watch for the turn changing. */}
      <Stat
        label="TURN"
        value={String(turn)}
        sub={
          shotClockSeconds !== null ? (
            <>
              {PHASE_LABELS[phase]} ·{' '}
              <ShotClock key={turnStartedAt} seconds={shotClockSeconds} startedAt={turnStartedAt} />
            </>
          ) : (
            PHASE_LABELS[phase]
          )
        }
      />
      {/* "open / lands" under the word MANA needs no caption to say so, and the
          caption was the width that broke the bar onto a second row. */}
      <Stat label="MANA" value={mana} />
      <Stat label="HAND" value={String(handCount)} />
      <Stat label="TAX" value={tax} />

      <div className="hud-stat is-life">
        {/* A seat that reaches 0 is ruled through and chipped OUT. Your own
            reading gets the same treatment rather than printing a negative
            figure as if it were any other number. The slot stays mounted and
            usually empty, so the chip is announced when it arrives. */}
        <span className="rd-label">
          LIFE
          <span className="rd-dead-slot" role="status">
            {life <= 0 && <span className="rd-chip is-dead">DEAD</span>}
          </span>
        </span>
        <span className={'hud-stat-value num' + (life <= 0 ? ' is-urgent' : '')}>
          {life}{' '}
          <span className={'rd-swing' + (swing < 0 ? ' is-down' : '')}>({signed(swing)})</span>
        </span>
        <LifeSteps target="player" />
        <button
          type="button"
          className="rd-quiet-btn"
          title="Reverse the last life or commander-damage change (the log keeps both entries)"
          onClick={() => undoLastLifeChange()}
        >
          undo life
        </button>
      </div>

      <div className="hud-stat is-clock">
        <span className="rd-label">CLOCK</span>
        <span
          className={
            'hud-stat-value is-sentence' +
            (clock ? (clockUrgent ? ' is-urgent' : '') : ' is-none')
          }
          title={clockSpoken}
          aria-hidden="true"
        >
          {clockText}
        </span>
        {/* The abbreviation is for the eye; the sentence is what is announced. */}
        <span className="pg-sr-only">{clockSpoken}</span>
      </div>

      <span className="hud-bar-spacer" />

      <div className="rd-turn-actions">
        <button type="button" onClick={() => nextPhase()}>
          Next phase<span className="rd-key">{keyLabel(keymap.nextPhase)}</span>
        </button>
        <button type="button" onClick={() => nextTurn()}>
          Next turn<span className="rd-key">{keyLabel(keymap.nextTurn)}</span>
        </button>
      </div>

      <div className="rd-tabs" role="group" aria-label="On demand">
        {(['log', 'notes', 'tokens', 'judge'] as DrawerId[]).map((id) => (
          <button
            key={id}
            type="button"
            className={'rd-tab' + (drawer === id ? ' is-open' : '')}
            aria-expanded={drawer === id}
            onClick={() => onOpenTab(id)}
          >
            {TAB_LABEL[id]}
          </button>
        ))}
        <button
          type="button"
          className={'rd-tab' + (helpOpen ? ' is-open' : '')}
          aria-expanded={helpOpen}
          onClick={onToggleHelp}
        >
          Keys
        </button>
        <button
          type="button"
          className={'rd-tab' + (drawer === 'endrun' ? ' is-open' : '')}
          aria-expanded={drawer === 'endrun'}
          aria-label="End run"
          title="End run"
          onClick={() => onOpenTab('endrun')}
        >
          {tightTabs ? 'End' : 'End run'}
        </button>
      </div>
    </section>
  );
}
