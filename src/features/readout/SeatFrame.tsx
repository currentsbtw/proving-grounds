import { useEffect, useMemo, useRef, useState } from 'react';
import { PROFILES, colorLetters } from '../../data/profiles';
import type { Seat, SeatId } from '../../domain/types';
import { highestThreatSeat, livingSeats } from '../../engine/pressure';
import { LETHAL_COMMANDER_DAMAGE, useGameStore } from '../../state/gameStore';
import type { LifeTarget } from '../../state/gameStore';
import AnswerPicker, { answerPayload } from '../pressure/AnswerPicker';
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
  const removeHazard = useGameStore((s) => s.removeHazard);
  const allHazards = useGameStore((s) => s.hazards);
  // The last time the pod swung at this seat. Not an event — the player was not
  // asked anything — so it is only ever a reading in the detail.
  const podHit = useGameStore((s) => s.lastPodHit[seat.id]);
  // Hover and keyboard focus both open the detail to be read. Only the pin keeps
  // it open, which is what makes the buttons inside it reachable: a pane that
  // shut on mouse-out could never be clicked into.
  const [near, setNear] = useState(false);
  // Which standing piece has the Remove picker hanging under it, if any. One at
  // a time, and only while the seat is pinned.
  const [removing, setRemoving] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);

  const dead = seat.eliminated;
  // The pieces this seat is holding. A dead seat holds none — the store retires
  // them as it dies, and this is the floor under that: a piece printed under a
  // seat that is out would be a tell the player would go on honouring.
  const hazards = useMemo(
    () => (dead ? [] : allHazards.filter((hazard) => hazard.seatId === seat.id)),
    [allHazards, dead, seat.id],
  );
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

  // The picker belongs to the pin, so dropping the pin closes it — during render
  // rather than in an effect, because nothing outside React is being
  // synchronised and a hover reopening a picker the player had put away would be
  // the pane acting on its own. A piece that leaves by any other route (a wipe,
  // the seat's death) drops out of `hazards` and takes its picker with it.
  const [pinnedWas, setPinnedWas] = useState(pinned);
  if (pinnedWas !== pinned) {
    setPinnedWas(pinned);
    if (removing) setRemoving(null);
  }

  // The frame carries the whole reading, so nothing inside it is announced
  // twice: the meter, the chips and the caption are all hidden from the tree.
  // The archetype the seat is piloting. Absent on a run started before profiles
  // existed, and the frame simply says nothing extra when it is.
  const profile = seat.profile ? PROFILES[seat.profile] : null;
  const profileTitle = profile
    ? `${profile.label}. ${profile.blurb} Colours ${colorLetters(profile.colors)}`
    : undefined;

  const states = [
    dead ? 'out' : null,
    !dead && hasClock ? 'clock' : null,
    !dead && armedThreshold !== null ? `armed, counters ${armedThreshold} or more mana` : null,
    // The pieces are named rather than counted: "holding Blood Moon" is the
    // whole of what the player has to remember, and a chip reading HATE is only
    // the pointer to it.
    hazards.length > 0 ? `holding ${hazards.map((h) => h.card.name).join(', ')}` : null,
    podHit ? `last hit by ${seatLabel(podHit.attackerId)} for ${podHit.damage}` : null,
    !dead && hit ? 'the seat to hit' : null,
  ].filter(Boolean);
  // The colours go in the label, not only in the chip's `title`: the chip is
  // aria-hidden, a title is not reliably announced, and a seat's colour identity
  // is the thing a player checks before deciding what the seat can be holding.
  // Never colour alone, and never a tooltip alone either.
  const named = profile
    ? `${seatLabel(seat.id)}, ${profile.label}, colours ${colorLetters(profile.colors)}`
    : seatLabel(seat.id);
  const label = dead
    ? `${named}: eliminated`
    : [
        `${named}: ${seat.life} life`,
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
          {/* The archetype rides with the letter, because it names the same
              thing: which opponent this is. Its own title carries the line the
              chip has no room for. */}
          {profile && (
            <span className="rd-chip is-profile" aria-hidden="true" title={profileTitle}>
              {profile.label}
            </span>
          )}
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
            {/* The word is the whole signal; the colourless grey only agrees
                with it. The count rides along once a seat holds more than one,
                because the pane below is then the only place saying so. */}
            {hazards.length > 0 && (
              <span className="rd-chip is-hate" title={hazards.map((h) => h.card.name).join(', ')}>
                HATE{hazards.length > 1 ? ` ${hazards.length}` : ''}
              </span>
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

          {/* What this seat has left standing, and the way off it. The name is
              the fact; the tell under it is the thing the player is honouring by
              hand, so it is printed in full rather than clipped. */}
          {hazards.length > 0 && (
            <div className="hud-hazards">
              {hazards.map((hazard) => (
                <div key={hazard.id} className="hud-hazard">
                  <div className="hud-hazard-head">
                    <strong className="hud-hazard-name">{hazard.card.name}</strong>
                    {/* Read on hover, act on the pin — the same rule the
                        commander-damage row keeps, for the same reason. */}
                    {pinned && (
                      <button
                        type="button"
                        className="hud-hazard-remove"
                        aria-expanded={removing === hazard.id}
                        aria-label={`Remove ${hazard.card.name} with a card`}
                        onClick={() =>
                          setRemoving((open) => (open === hazard.id ? null : hazard.id))
                        }
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <p className="hud-hazard-tell">{hazard.card.tell ?? hazard.card.effect}</p>
                  {/* The same picker the dock answers events with, so removing a
                      piece names the card that did it exactly as answering an
                      event does — including the way out for an answer the app
                      has no instance for. */}
                  {pinned && removing === hazard.id && (
                    <AnswerPicker
                      title={`Remove ${hazard.card.name} with: pick the card`}
                      onAnswer={(iid) => {
                        setRemoving(null);
                        removeHazard(hazard.id, answerPayload(iid));
                      }}
                      onClose={() => setRemoving(null)}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {/* The pod swinging at itself. A reading only: nothing was asked of
              the player, and the life it cost is already on the frame. */}
          {podHit && (
            <div className="hud-detail-row">
              <span className="rd-label">pod</span>
              <span>
                hit by {podHit.attackerId} for <span className="num">{podHit.damage}</span> on T
                <span className="num">{podHit.turn}</span>
              </span>
            </div>
          )}

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
