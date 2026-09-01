import { currentPlayerThreat, LETHAL_COMMANDER_DAMAGE, useGameStore } from '../../../state/gameStore';
import type { LifeTarget } from '../../../state/gameStore';
import type { Seat, Silhouette } from '../../../domain/types';
import { SilhouetteIcon } from '../../pressure/pressureUi';

const LIFE_STEPS: number[] = [-5, -1, 1, 5];

/** Segments in a threat meter — the engine's threat scale is 0–10. */
const THREAT_SEGMENTS = 10;

/** Colour band for a threat reading: quiet, dangerous, lethal. */
function threatTone(filled: number): string {
  if (filled >= 7) return 'is-high';
  if (filled >= 4) return 'is-mid';
  return 'is-low';
}

interface ThreatMeterProps {
  /** Raw 0–10 threat; displayed rounded. */
  value: number;
  label: string;
  /** The player's own meter is prefixed rather than bare. */
  prefix?: string;
}

/** A ten-segment bar plus the number, so the meter reads at a glance and exactly. */
function ThreatMeter({ value, label, prefix }: ThreatMeterProps) {
  const filled = Math.max(0, Math.min(THREAT_SEGMENTS, Math.round(value)));
  const tone = threatTone(filled);

  return (
    <div
      className={'hud-threat ' + tone}
      role="img"
      aria-label={`${label}: threat ${filled} of ${THREAT_SEGMENTS}`}
    >
      {prefix && <span className="hud-threat-prefix">{prefix}</span>}
      <span className="hud-threat-bar" aria-hidden="true">
        {Array.from({ length: THREAT_SEGMENTS }, (_, i) => (
          <span key={i} className={'hud-threat-seg' + (i < filled ? ' is-on' : '')} />
        ))}
      </span>
      <span className="hud-threat-num num">
        {filled}
        {prefix && <span className="hud-threat-max">/{THREAT_SEGMENTS}</span>}
      </span>
    </div>
  );
}

/** The abstract board a seat is presenting. Zeroes stay visible, just dimmed. */
function SilhouetteRow({ silhouette, dead }: { silhouette: Silhouette; dead: boolean }) {
  if (dead) {
    return (
      <div className="hud-sil is-dead" aria-label="No board — seat eliminated">
        —
      </div>
    );
  }

  const { creatures, power, artifacts, openMana } = silhouette;

  return (
    <div className="hud-sil">
      <span
        className={'hud-sil-cell' + (creatures === 0 ? ' is-zero' : '')}
        title={`${creatures} creature(s), ${power} total power`}
      >
        <SilhouetteIcon kind="creatures" />
        <span className="num">{creatures}</span>
        <span className="hud-sil-sub num">({power} power)</span>
      </span>
      <span className="hud-sil-dot" aria-hidden="true">
        ·
      </span>
      <span
        className={'hud-sil-cell' + (artifacts === 0 ? ' is-zero' : '')}
        title={`${artifacts} rocks / artifacts`}
      >
        <SilhouetteIcon kind="artifacts" />
        <span className="num">{artifacts}</span>
      </span>
      <span className="hud-sil-dot" aria-hidden="true">
        ·
      </span>
      <span
        className={'hud-sil-cell' + (openMana === 0 ? ' is-zero' : '')}
        title={`${openMana} open mana`}
      >
        <SilhouetteIcon kind="mana" />
        <span className="num">{openMana}</span>
        <span className="hud-sil-sub">open</span>
      </span>
    </div>
  );
}

function lifeToneClass(life: number): string {
  if (life >= 40) return ' is-high';
  if (life < 10) return ' is-low';
  return '';
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

interface LifeButtonsProps {
  target: LifeTarget;
  disabled?: boolean;
}

function LifeButtons({ target, disabled }: LifeButtonsProps) {
  const adjustLife = useGameStore((s) => s.adjustLife);
  const label = target === 'player' ? 'you' : `seat ${target}`;
  return (
    <span className="hud-life-buttons">
      {LIFE_STEPS.map((delta) => (
        <button
          key={delta}
          type="button"
          disabled={disabled}
          aria-label={`${signed(delta)} life for ${label}`}
          onClick={() => adjustLife(target, delta)}
        >
          {signed(delta)}
        </button>
      ))}
    </span>
  );
}

function PlayerCard() {
  const life = useGameStore((s) => s.playerLife);
  // Live, not the value the pod judged at the last window — that one is on the log.
  const threat = useGameStore(currentPlayerThreat);
  return (
    <div className="hud-life-card is-you">
      <div className="hud-life-row">
        <span className="hud-life-name">YOU</span>
        <span className={'hud-life-total num' + lifeToneClass(life)}>{life}</span>
        <LifeButtons target="player" />
      </div>
      <ThreatMeter value={threat} label="Your threat" prefix="YOUR THREAT" />
    </div>
  );
}

function SeatCard({ seat }: { seat: Seat }) {
  const dealCommanderDamage = useGameStore((s) => s.dealCommanderDamage);
  const dead = seat.eliminated;

  return (
    <div className={'hud-life-card' + (dead ? ' is-eliminated' : '')}>
      {dead && <span className="hud-life-stamp">ELIMINATED</span>}

      <div className="hud-life-row">
        <span className="hud-life-name">SEAT {seat.id}</span>
        <span className={'hud-life-total num' + lifeToneClass(seat.life)}>{seat.life}</span>
        <LifeButtons target={seat.id} disabled={dead} />
      </div>

      <ThreatMeter value={dead ? 0 : seat.threat} label={`Seat ${seat.id}`} />
      <SilhouetteRow silhouette={seat.silhouette} dead={dead} />

      <div className="hud-cmdr-row">
        <span className="hud-cmdr-label">CMDR</span>
        <span className="hud-cmdr-value num">
          {seat.commanderDamage}
          <span className="hud-cmdr-max">/{LETHAL_COMMANDER_DAMAGE}</span>
        </span>
        <span className="hud-life-buttons">
          {[1, 3].map((amount) => (
            <button
              key={amount}
              type="button"
              disabled={dead}
              aria-label={`Deal ${amount} commander damage to seat ${seat.id}`}
              title={`Deal ${amount} commander damage (also reduces life)`}
              onClick={() => dealCommanderDamage(seat.id, amount)}
            >
              +{amount}
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}

/** Life totals for the player and the three opposing seats, plus commander damage. */
export default function LifePanel() {
  const seats = useGameStore((s) => s.seats);
  const undoLastLifeChange = useGameStore((s) => s.undoLastLifeChange);

  return (
    <div className="pg-hud-block">
      <div className="hud-life-head">
        <span className="panel-heading">Life</span>
        <button
          type="button"
          className="hud-life-undo"
          title="Reverse the last life or commander-damage change (the log keeps both entries)"
          onClick={() => undoLastLifeChange()}
        >
          Undo
        </button>
      </div>
      <div className="hud-life-grid">
        <PlayerCard />
        {seats.map((seat) => (
          <SeatCard key={seat.id} seat={seat} />
        ))}
      </div>
    </div>
  );
}
