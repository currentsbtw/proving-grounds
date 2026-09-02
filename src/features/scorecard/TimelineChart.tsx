import { SCORING } from '../../data/scorecard';
import type { EventLedgerRow, Scorecard } from '../../engine/scorecard';
import { EVENT_MARK, EVENT_MARK_KEY } from './eventMarks';

/**
 * The run in one picture: what you deployed each turn, what the board was worth
 * at the end of it, and where the pod's pressure landed. Hand-written SVG —
 * there is no chart library in the dependency list and this needs exactly one
 * chart.
 *
 * Event colours are not chosen here: a `type-<event>` class picks up the same
 * `--mana-*` accent the dock's stripe uses, so the two cannot drift.
 */

const W = 700;
const H = 226;
const PAD = { l: 30, r: 30, t: 40, b: 20 };
const PLOT_W = W - PAD.l - PAD.r;
const PLOT_H = H - PAD.t - PAD.b;
const BASE = PAD.t + PLOT_H;
/** Pixels of the thin lands bar per land played — lands are 0–2, so a shared axis would hide them. */
const LAND_UNIT = 7;

/** Distance between two markers sharing a turn. Wide enough for a letter. */
const MARK_STEP = 13;

export interface TimelineChartProps {
  card: Scorecard;
}

export default function TimelineChart({ card }: TimelineChartProps) {
  const rows = card.timeline;
  if (rows.length === 0) {
    return <p className="sc-empty">No turns were logged for this run.</p>;
  }

  const byId = new Map<string, EventLedgerRow>(card.events.map((e) => [e.eventId, e]));
  const n = rows.length;
  const colW = PLOT_W / n;
  const left = (i: number) => PAD.l + colW * i;
  const mid = (i: number) => left(i) + colW / 2;

  const maxValue = Math.max(
    1,
    ...rows.map((row) => Math.max(row.boardValueEnd, row.mvDeployed)),
  );
  const yValue = (v: number) => BASE - (v / maxValue) * PLOT_H;

  const maxLife = Math.max(1, SCORING.startingLife, ...rows.map((row) => row.playerLifeEnd));
  const yLife = (v: number) => BASE - (v / maxLife) * PLOT_H;

  const boardLine = rows.map((row, i) => `${mid(i)},${yValue(row.boardValueEnd)}`).join(' ');
  const lifeLine = rows.map((row, i) => `${mid(i)},${yLife(row.playerLifeEnd)}`).join(' ');

  // Turn labels thin out rather than overlap; a 30-turn run still reads.
  const labelEvery = n <= 12 ? 1 : n <= 24 ? 2 : 5;

  const barW = Math.max(3, Math.min(18, colW * 0.42));
  const landW = Math.max(2, Math.min(7, colW * 0.16));

  return (
    <figure className="sc-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label={`Turn-by-turn chart over ${n} turns`}
      >
        {/* Gridlines and the board-value axis. */}
        {[0, 0.5, 1].map((frac) => {
          const y = BASE - frac * PLOT_H;
          return (
            <g key={frac}>
              <line
                x1={PAD.l}
                x2={PAD.l + PLOT_W}
                y1={y}
                y2={y}
                stroke="var(--line)"
                strokeWidth={1}
              />
              <text x={PAD.l - 5} y={y + 3} textAnchor="end" className="sc-chart-axis">
                {Math.round(maxValue * frac)}
              </text>
            </g>
          );
        })}

        {/* Life axis on the right, two ticks only — it is context, not the subject. */}
        <text x={PAD.l + PLOT_W + 5} y={yLife(maxLife) + 3} className="sc-chart-axis">
          {maxLife}
        </text>
        <text x={PAD.l + PLOT_W + 5} y={BASE + 3} className="sc-chart-axis">
          0
        </text>

        {/* Wipes: a dashed rule where the sweep landed, shaded until the board came back. */}
        {card.wipes
          .filter((wipe) => !wipe.negated)
          .map((wipe) => {
            const from = Math.min(Math.max(1, wipe.turn), n) - 1;
            const to = wipe.recoveredTurn === null ? n - 1 : Math.min(wipe.recoveredTurn, n) - 1;
            const x1 = mid(from);
            const x2 = mid(to);
            return (
              <g key={wipe.eventId}>
                {x2 > x1 && (
                  <rect
                    x={x1}
                    y={PAD.t}
                    width={x2 - x1}
                    height={PLOT_H}
                    fill="var(--mana-w)"
                    opacity={wipe.recoveredTurn === null ? 0.06 : 0.1}
                  />
                )}
                <line
                  x1={x1}
                  x2={x1}
                  y1={PAD.t - 6}
                  y2={BASE}
                  stroke="var(--mana-w)"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  opacity={0.8}
                />
                <title>
                  {wipe.recoveredTurn === null
                    ? `Wrath on turn ${wipe.turn}. Never rebuilt to 70% of ${wipe.boardValueBefore} MV`
                    : `Wrath on turn ${wipe.turn}. Rebuilt by turn ${wipe.recoveredTurn} (${wipe.turnsToRecover} turns)`}
                </title>
              </g>
            );
          })}

        {/* Deployment bars, plus the thin lands bar beside them. */}
        {rows.map((row, i) => {
          const x = mid(i);
          const barH = BASE - yValue(row.mvDeployed);
          const landH = row.landsPlayed * LAND_UNIT;
          return (
            <g key={row.turn}>
              {row.mvDeployed > 0 && (
                <rect
                  x={x - barW / 2 - landW / 2 - 1}
                  y={BASE - barH}
                  width={barW}
                  height={barH}
                  fill="var(--ink)"
                  opacity={0.7}
                />
              )}
              {landH > 0 && (
                <rect
                  x={x + barW / 2 - landW / 2 + 1}
                  y={BASE - landH}
                  width={landW}
                  height={landH}
                  fill="var(--muted)"
                  opacity={0.65}
                />
              )}
            </g>
          );
        })}

        {/* Life, then board value on top — board value is the headline series. */}
        <polyline
          points={lifeLine}
          fill="none"
          stroke="var(--muted)"
          strokeWidth={1}
          strokeDasharray="4 3"
          opacity={0.55}
        />
        <polyline points={boardLine} fill="none" stroke="var(--mana-u)" strokeWidth={1.75} />
        {rows.map((row, i) => (
          <circle
            key={row.turn}
            cx={mid(i)}
            cy={yValue(row.boardValueEnd)}
            r={2}
            fill="var(--mana-u)"
          />
        ))}

        {/* Event markers in the band above the plot: one letter per event, in
            its class's colour, struck through when the event was answered. */}
        {rows.map((row, i) => {
          const marks = row.eventIds
            .map((id) => byId.get(id))
            .filter((e): e is EventLedgerRow => e !== undefined);
          const count = marks.length;
          return marks.map((event, k) => {
            const x = mid(i) + (k - (count - 1) / 2) * MARK_STEP;
            const y = PAD.t - 14;
            return (
              <g key={event.eventId} className={`sc-evt-mark type-${event.type}`}>
                <text x={x} y={y} textAnchor="middle" className="sc-evt-mark">
                  {EVENT_MARK[event.type]}
                </text>
                {event.terminal === 'responded' && (
                  <line
                    className="sc-evt-strike"
                    x1={x - 5}
                    x2={x + 5}
                    y1={y - 3.5}
                    y2={y - 3.5}
                  />
                )}
                <title>{`T${event.turn} · Seat ${event.seatId} · ${event.type}${event.variant ? ` (${event.variant})` : ''} · ${event.terminal}`}</title>
              </g>
            );
          });
        })}

        {/* Turn labels, and a per-column hit area carrying the turn's numbers. */}
        {rows.map((row, i) => (
          <g key={`col-${row.turn}`}>
            <rect
              x={left(i)}
              y={PAD.t - 26}
              width={colW}
              height={PLOT_H + 26}
              fill="transparent"
            >
              <title>
                {`Turn ${row.turn}: deployed ${row.mvDeployed} MV, ${row.landsPlayed} land${row.landsPlayed === 1 ? '' : 's'}, drew ${row.cardsDrawn}; board ${row.boardValueEnd} MV, life ${row.playerLifeEnd}`}
              </title>
            </rect>
            {(i % labelEvery === 0 || i === n - 1) && (
              <text x={mid(i)} y={BASE + 14} textAnchor="middle" className="sc-chart-axis">
                {row.turn}
              </text>
            )}
          </g>
        ))}
      </svg>

      <figcaption className="sc-chart-legend">
        <span className="sc-legend-row">
          <span className="sc-key sc-key-bar">mana value deployed</span>
          <span className="sc-key sc-key-land">lands</span>
          <span className="sc-key sc-key-board">board value</span>
          <span className="sc-key sc-key-life">your life</span>
          <span className="sc-key sc-key-wipe">wrath &amp; rebuild</span>
        </span>
        {/* The marker key: the letter is what a reader without the colour has,
            so it is printed beside the word it stands for. */}
        <span className="sc-legend-row">
          {EVENT_MARK_KEY.map(({ type, word }) => (
            <span key={type} className="sc-mark-key">
              <span className={`sc-evt-mark type-${type}`}>{EVENT_MARK[type]}</span>
              {word}
            </span>
          ))}
          <span className="sc-mark-key">
            <span className="sc-evt-mark sc-mark-struck">A</span>answered
          </span>
        </span>
      </figcaption>
    </figure>
  );
}
