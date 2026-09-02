import { useMemo } from 'react';
import { PHASE_LABELS } from '../../domain/phases';
import { commanderTax, isLandCard, useGameStore } from '../../state/gameStore';
import type { GameState } from '../../state/gameStore';
import { keyLabel, useHotkeyStore } from '../../state/hotkeyStore';
import { seatLabel } from '../pressure/pressureUi';
import { LifeSteps, signed } from './SeatsBlock';

/** How long the clock has left, in the wording the standing warning used. */
function turnsLabel(remaining: number): string {
  if (remaining <= 0) return 'last turn';
  if (remaining === 1) return '1 turn';
  return `${remaining} turns`;
}

function Pair({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rd-pair">
      <span className="rd-pair-label">{label}</span>
      <span className="rd-pair-value num">{value}</span>
      {sub && <span className="rd-pair-sub">{sub}</span>}
    </div>
  );
}

/** Your own numbers, in one fixed set of slots. */
export default function YouBlock() {
  const turn = useGameStore((s) => s.turn);
  const phase = useGameStore((s) => s.phase);
  const life = useGameStore((s) => s.playerLife);
  const turnStartLife = useGameStore((s) => s.turnStartLife);
  const librarySize = useGameStore((s) => s.libraryOrder.length);
  const clock = useGameStore((s) => s.clock);
  const nextPhase = useGameStore((s) => s.nextPhase);
  const nextTurn = useGameStore((s) => s.nextTurn);
  const keymap = useHotkeyStore((s) => s.keymap);

  // The three card-derived figures share one walk of the battlefield. Subscribing
  // to the inputs and deriving here keeps the block off every unrelated store
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

  const clockText = clock
    ? `${seatLabel(clock.seatId)} · T${clock.deadlineTurn} · ${turnsLabel(remaining)}`
    : 'none';

  return (
    <section className="rd-block rd-settle is-step2" aria-label="You">
      <div className="rd-head">
        <h2 className="rd-title">YOU</h2>
      </div>

      <div className="rd-pairs">
        <Pair label="TURN" value={String(turn)} sub="next: opponent window" />
        <Pair label="PHASE" value={PHASE_LABELS[phase]} />
        <Pair label="MANA" value={mana} sub="untapped lands" />
        <Pair label="HAND" value={String(handCount)} />
        <Pair label="TAX" value={tax} />
        <Pair label="LIBRARY" value={String(librarySize)} />
      </div>

      <div className="rd-pair is-wide">
        {/* A seat that reaches 0 is ruled through and chipped OUT. Your own row
            gets the same treatment rather than printing a negative figure as if
            it were any other number. The slot stays mounted and usually empty,
            so the chip is announced when it arrives. */}
        <span className="rd-pair-label">
          LIFE
          <span className="rd-dead-slot" role="status">
            {life <= 0 && <span className="rd-chip is-dead">DEAD</span>}
          </span>
        </span>
        <span className={'rd-pair-value num' + (life <= 0 ? ' is-urgent' : '')}>
          {life} <span className={'rd-swing' + (swing < 0 ? ' is-down' : '')}>({signed(swing)})</span>
        </span>
        <LifeSteps target="player" />
      </div>

      <div className="rd-pair is-wide is-clock">
        <span className="rd-pair-label">CLOCK</span>
        <span
          className={
            'rd-pair-value' + (clock ? (clockUrgent ? ' is-urgent' : '') : ' is-none')
          }
        >
          {clockText}
        </span>
      </div>

      <div className="rd-turn-actions">
        <button type="button" onClick={() => nextPhase()}>
          Next phase<span className="rd-key">{keyLabel(keymap.nextPhase)}</span>
        </button>
        <button type="button" onClick={() => nextTurn()}>
          Next turn<span className="rd-key">{keyLabel(keymap.nextTurn)}</span>
        </button>
      </div>
    </section>
  );
}
