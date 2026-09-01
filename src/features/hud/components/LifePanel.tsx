import { LETHAL_COMMANDER_DAMAGE, useGameStore } from '../../../state/gameStore';
import type { LifeTarget } from '../../../state/gameStore';
import type { Seat } from '../../../domain/types';

const LIFE_STEPS: number[] = [-5, -1, 1, 5];

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
  return (
    <div className="hud-life-card is-you">
      <div className="hud-life-row">
        <span className="hud-life-name">YOU</span>
        <span className={'hud-life-total num' + lifeToneClass(life)}>{life}</span>
        <LifeButtons target="player" />
      </div>
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

  return (
    <div className="pg-hud-block">
      <span className="panel-heading">Life</span>
      <div className="hud-life-grid">
        <PlayerCard />
        {seats.map((seat) => (
          <SeatCard key={seat.id} seat={seat} />
        ))}
      </div>
    </div>
  );
}
