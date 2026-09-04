import { useEffect, useRef, useState } from 'react';
import type { Seat, SeatId } from '../../domain/types';
import { highestThreatSeat, livingSeats } from '../../engine/pressure';
import { LETHAL_COMMANDER_DAMAGE, useGameStore } from '../../state/gameStore';
import type { LifeTarget } from '../../state/gameStore';
import { seatLabel } from '../pressure/pressureUi';

/** Segments in a threat meter — the engine's threat scale is 0–10. */
const THREAT_SEGMENTS = 10;

/** Life steps offered wherever life is adjusted. Small, quiet, always in order. */
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
export function seatToHit(seats: Seat[], clockSeat: SeatId | null): SeatId | null {
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

interface FrameProps {
  seat: Seat;
  previous: number;
  hasClock: boolean;
  armedThreshold: number | null;
  hit: boolean;
  /**
   * Whether the HIT chip is printed. A narrow frame has no room for a third
   * chip beside CLOCK and ARMED, and the accent already runs round the whole
   * frame; the reading in `aria-label` is unconditional either way.
   */
  showHit: boolean;
  /** Whether this seat is the one pinned open; one seat at a time. */
  pinned: boolean;
  onTogglePin: () => void;
  /**
   * Raised as the detail opens, closes or changes height. The HUD needs the
   * height because the detail hangs out of flow: the event pane below it has to
   * be pushed clear by hand, and only for the seat that owns both.
   */
  onDetailChange: (seatId: SeatId, open: boolean, height: number) => void;
}

/**
 * One opponent, as a unit frame over the board: the seat letter, its life as the
 * figure, its state chips, and the threat meter under them. The frame is a
 * button because the whole of it is the pin target — hover reads, click pins —
 * so nothing inside it may be interactive, and the detail it opens is its
 * sibling rather than its child.
 */
export default function SeatFrame({
  seat,
  previous,
  hasClock,
  armedThreshold,
  hit,
  showHit,
  pinned,
  onTogglePin,
  onDetailChange,
}: FrameProps) {
  const dealCommanderDamage = useGameStore((s) => s.dealCommanderDamage);
  // Hover and keyboard focus both open the detail to be read. Only the pin keeps
  // it open, which is what makes the buttons inside it reachable: a pane that
  // shut on mouse-out could never be clicked into.
  const [near, setNear] = useState(false);
  const detailRef = useRef<HTMLDivElement | null>(null);

  const dead = seat.eliminated;
  const { creatures, power, artifacts, openMana } = seat.silhouette;
  const filled = Math.max(0, Math.min(THREAT_SEGMENTS, Math.round(dead ? 0 : seat.threat)));
  const trend: Trend = dead ? 'steady' : trendOf(seat.threat, previous);
  const open = pinned || near;

  // The pane's height is not knowable from the markup — the silhouette line
  // wraps at some widths and the pinned state adds a row — so it is measured,
  // and re-measured whenever it changes rather than only when it opens.
  useEffect(() => {
    const node = detailRef.current;
    if (!open || !node) {
      onDetailChange(seat.id, false, 0);
      return;
    }
    const report = (): void => onDetailChange(seat.id, true, node.getBoundingClientRect().height);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, [open, pinned, dead, seat.id, onDetailChange]);

  // The frame carries the whole reading, so nothing inside it is announced
  // twice: the meter, the chips and the caption are all hidden from the tree.
  const states = [
    dead ? 'out' : null,
    !dead && hasClock ? 'clock' : null,
    !dead && armedThreshold !== null ? `armed, counters ${armedThreshold} or more mana` : null,
    !dead && hit ? 'the seat to hit' : null,
  ].filter(Boolean);
  const label = dead
    ? `${seatLabel(seat.id)}: eliminated`
    : [
        `${seatLabel(seat.id)}: ${seat.life} life`,
        `threat ${filled} of ${THREAT_SEGMENTS}, ${trend}`,
        ...states,
      ].join(', ');

  return (
    <div
      className="hud-frame-wrap"
      onMouseEnter={() => setNear(true)}
      onMouseLeave={() => setNear(false)}
    >
      <button
        type="button"
        className={
          'hud-frame pg-pane' + (dead ? ' is-out' : '') + (hit && !dead ? ' is-hit' : '')
        }
        aria-expanded={pinned}
        aria-label={label}
        title={pinned ? 'Unpin this seat' : 'Pin this seat open to adjust it'}
        onFocus={() => setNear(true)}
        onBlur={() => setNear(false)}
        onClick={onTogglePin}
      >
        <span className="hud-frame-top">
          <span className="hud-seat-id" aria-hidden="true">
            {seat.id}
          </span>
          <span className="hud-life num" aria-hidden="true">
            {seat.life}
          </span>
          <span className="rd-label" aria-hidden="true">
            life
          </span>

          <span className="rd-chips" aria-hidden="true">
            {dead && <span className="rd-chip is-out">OUT</span>}
            {!dead && hasClock && <span className="rd-chip is-clock">CLOCK</span>}
            {!dead && armedThreshold !== null && (
              <span className="rd-chip is-armed">ARMED {armedThreshold}+</span>
            )}
            {!dead && hit && showHit && <span className="rd-chip is-hit">HIT</span>}
          </span>
        </span>

        {/* Ten bordered segments, the number, and the word for which way it is
            going — the word carries the direction, so no arrow rides along. */}
        <span className="hud-frame-meter" aria-hidden="true">
          <span className="rd-threat-bar">
            {Array.from({ length: THREAT_SEGMENTS }, (_, i) => (
              <span key={i} className={'rd-threat-seg' + (i < filled ? ' is-on' : '')} />
            ))}
          </span>
          <span className="rd-threat-num num">{filled}</span>
          <span className={'rd-trend is-' + trend}>{trend}</span>
        </span>
      </button>

      {open && (
        <div className="hud-detail pg-pane" ref={detailRef}>
          <div className="hud-sil">
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
          </div>

          <div className="hud-detail-row">
            <span className="rd-label">cmdr dmg</span>
            <span className="num hud-cmdr-tally">
              {seat.commanderDamage}/{LETHAL_COMMANDER_DAMAGE}
            </span>
            {/* Read on hover, act on the pin. An un-pinned pane closes the
                moment the pointer leaves it, so it never offers a button the
                pointer cannot travel to. */}
            {pinned ? (
              <span className="rd-sil-actions">
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
            ) : (
              <span className="hud-pin-hint">click to adjust</span>
            )}
          </div>

          {pinned && (
            <div className="hud-detail-row">
              <span className="rd-label">life</span>
              <LifeSteps target={seat.id} disabled={dead} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
