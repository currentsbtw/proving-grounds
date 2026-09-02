import { useState } from 'react';
import type { Seat, SeatId } from '../../domain/types';
import { highestThreatSeat, livingSeats } from '../../engine/pressure';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { LETHAL_COMMANDER_DAMAGE, useGameStore } from '../../state/gameStore';
import type { LifeTarget } from '../../state/gameStore';
import { seatLabel } from '../pressure/pressureUi';

/** Below this the seat row folds to two lines and line three moves into the
    disclosure, so three seats plus your own numbers still fit at 768px tall. */
const NARROW = '(max-width: 1280px)';

/** Segments in a threat meter — the engine's threat scale is 0–10. */
const THREAT_SEGMENTS = 10;

/** Life steps offered on every row. Small, quiet, always in the same place. */
const LIFE_STEPS: number[] = [-5, -1, 1, 5];

/** Movement smaller than this reads as noise rather than a direction. */
const TREND_EPSILON = 0.05;

export function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/**
 * The seat to hit: whoever is racing you, and failing that the scariest seat
 * still alive — the same seat the engine itself picks to attack and start
 * clocks, so the readout's answer and the pod's behaviour cannot drift apart.
 */
function seatToHit(seats: Seat[], clockSeat: SeatId | null): SeatId | null {
  const living = livingSeats(seats);
  if (clockSeat && living.some((s) => s.id === clockSeat)) return clockSeat;
  return highestThreatSeat(living)?.id ?? null;
}

type Trend = 'rising' | 'steady' | 'falling';

function trendOf(now: number, before: number): Trend {
  if (now - before > TREND_EPSILON) return 'rising';
  if (before - now > TREND_EPSILON) return 'falling';
  return 'steady';
}

export function LifeSteps({ target, disabled }: { target: LifeTarget; disabled?: boolean }) {
  const adjustLife = useGameStore((s) => s.adjustLife);
  const who = target === 'player' ? 'you' : seatLabel(target);
  return (
    <span className="rd-steps">
      {LIFE_STEPS.map((delta) => (
        <button
          key={delta}
          type="button"
          disabled={disabled}
          aria-label={`${signed(delta)} life for ${who}`}
          onClick={() => adjustLife(target, delta)}
        >
          {signed(delta)}
        </button>
      ))}
    </span>
  );
}

/** Ten bordered segments, the number, and the word for which way it is going —
    the word carries the direction, so no arrow rides along with it. */
function ThreatMeter({ value, trend, label }: { value: number; trend: Trend; label: string }) {
  const filled = Math.max(0, Math.min(THREAT_SEGMENTS, Math.round(value)));
  return (
    <span
      className="rd-threat"
      role="img"
      aria-label={`${label}: threat ${filled} of ${THREAT_SEGMENTS}, ${trend}`}
    >
      <span className="rd-label" aria-hidden="true">
        threat
      </span>
      <span className="rd-threat-bar" aria-hidden="true">
        {Array.from({ length: THREAT_SEGMENTS }, (_, i) => (
          <span key={i} className={'rd-threat-seg' + (i < filled ? ' is-on' : '')} />
        ))}
      </span>
      <span className="rd-threat-num num" aria-hidden="true">
        {filled}
      </span>
      <span className={'rd-trend is-' + trend} aria-hidden="true">
        {trend}
      </span>
    </span>
  );
}

interface RowProps {
  seat: Seat;
  previous: number;
  hasClock: boolean;
  armedThreshold: number | null;
  hit: boolean;
  /** Narrow column: line three folds into the disclosure. */
  folded: boolean;
}

function SeatRow({ seat, previous, hasClock, armedThreshold, hit, folded }: RowProps) {
  const dealCommanderDamage = useGameStore((s) => s.dealCommanderDamage);
  const [open, setOpen] = useState(false);
  const dead = seat.eliminated;
  const { creatures, power, artifacts, openMana } = seat.silhouette;

  const cmdrTally = (
    <span className="num">
      {seat.commanderDamage}/{LETHAL_COMMANDER_DAMAGE}
    </span>
  );

  const cmdrDamage = (
    <span className="rd-cmdr num" title="Commander damage dealt to this seat">
      cmdr dmg {cmdrTally}
    </span>
  );

  const disclose = (
    <button
      type="button"
      className="rd-disclose"
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
    >
      silhouette
    </button>
  );

  return (
    <div className={'rd-seat' + (dead ? ' is-out' : '') + (hit ? ' is-hit' : '')}>
      {/* Line one is the reading: who, how much life, what state. The chips keep
          this line to themselves at every width rather than wrapping into it. */}
      <div className="rd-seat-line is-top">
        <span className="rd-seat-id">{seat.id}</span>
        <span className="rd-seat-life num">{seat.life}</span>
        <span className="rd-label">life</span>

        <span className="rd-chips">
          {dead && <span className="rd-chip is-out">OUT</span>}
          {!dead && hasClock && <span className="rd-chip is-clock">CLOCK</span>}
          {!dead && armedThreshold !== null && (
            <span className="rd-chip is-armed">ARMED {armedThreshold}+</span>
          )}
          {!dead && hit && <span className="rd-chip is-hit">HIT</span>}
        </span>
      </div>

      <div className="rd-seat-line is-meter">
        <ThreatMeter
          value={dead ? 0 : seat.threat}
          trend={dead ? 'steady' : trendOf(seat.threat, previous)}
          label={seatLabel(seat.id)}
        />
        {folded && disclose}
      </div>

      {/* Line three is the on-demand half of the row: what it cost the seat, and
          the two ways to change it. A narrow column cannot spend a third line on
          three seats, so it goes behind the disclosure with the silhouette. */}
      {!folded && (
        <div className="rd-seat-line is-foot">
          {cmdrDamage}
          {disclose}
          <LifeSteps target={seat.id} disabled={dead} />
        </div>
      )}

      {open && (
        <div className="rd-sil">
          {dead ? (
            <span className="muted">Board gone with the seat.</span>
          ) : (
            <>
              <span>
                creatures <span className="num">{creatures}</span>
              </span>
              <span>
                power <span className="num">{power}</span>
              </span>
              <span>
                artifacts <span className="num">{artifacts}</span>
              </span>
              <span>
                open mana <span className="num">{openMana}</span>
              </span>
            </>
          )}
          {/* The folded row hands its reading to the disclosure, where the
              buttons already carry the name: printing "cmdr dmg" a second time
              a few millimetres away named it twice. */}
          <span className="rd-sil-actions">
            <span className="rd-sil-label">cmdr dmg</span>
            {folded && cmdrTally}
            {[1, 3].map((amount) => (
              <button
                key={amount}
                type="button"
                disabled={dead}
                aria-label={`Deal ${amount} commander damage to ${seatLabel(seat.id)}`}
                title={`Deal ${amount} commander damage (also reduces life)`}
                onClick={() => dealCommanderDamage(seat.id, amount)}
              >
                +{amount}
              </button>
            ))}
          </span>
          {folded && (
            <span className="rd-sil-actions">
              <span className="rd-sil-label">life</span>
              <LifeSteps target={seat.id} disabled={dead} />
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Three ruled rows, always in the same order. An eliminated seat keeps its place. */
export default function SeatsBlock() {
  const seats = useGameStore((s) => s.seats);
  const previousThreat = useGameStore((s) => s.previousThreat);
  const clock = useGameStore((s) => s.clock);
  const armed = useGameStore((s) => s.counterArmed);
  const undoLastLifeChange = useGameStore((s) => s.undoLastLifeChange);
  const folded = useMediaQuery(NARROW);

  const hit = seatToHit(seats, clock?.seatId ?? null);

  return (
    <section className="rd-block rd-settle is-step1" aria-label="Seats">
      <div className="rd-head">
        <h2 className="rd-title">SEATS</h2>
        <button
          type="button"
          className="rd-quiet-btn"
          title="Reverse the last life or commander-damage change (the log keeps both entries)"
          onClick={() => undoLastLifeChange()}
        >
          undo life
        </button>
      </div>

      {seats.map((seat) => (
        <SeatRow
          key={seat.id}
          seat={seat}
          previous={previousThreat[seat.id] ?? seat.threat}
          hasClock={clock?.seatId === seat.id}
          armedThreshold={armed?.seatId === seat.id ? armed.threshold : null}
          hit={hit === seat.id}
          folded={folded}
        />
      ))}
    </section>
  );
}
