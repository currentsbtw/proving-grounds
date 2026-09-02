/**
 * Monte-Carlo probe for the pressure engine, and its regression gate.
 *
 *   npm run probe:pressure [runs]      (default 2000)
 *
 * `resolveWindow` is pure, so this drives it directly — no store, no log, no
 * scorer. Each simulated run walks the opponent windows before turns 2 through
 * 12 for one bracket, feeding the engine a synthetic player who deploys on a
 * plausible curve, and tallies what the pod did. This is the tool a tuning pass
 * points at `src/data/pressure.ts`: change a knob, re-run, read the table.
 *
 * Every metric that defines the bracket curve carries a target and a band (see
 * `TARGETS`). Each row prints PASS or MISS against its band and the process
 * exits non-zero if anything missed, so the probe doubles as a regression check
 * on the tuning. The bands are sized for 1000 runs per bracket; at much smaller
 * run counts sampling noise alone will trip them.
 *
 * The player is a fiction, and every number below is a consequence of that
 * fiction as much as of the engine, so the assumptions are printed with the
 * results. They are deliberately plain — a mid-speed deck that keeps developing
 * and starts attacking the scariest seat halfway through.
 *
 * One deliberate divergence from a real run: when a race clock's deadline
 * passes, the app ends the run as a loss, but the probe records the deadline
 * and keeps playing (it drops the clock and re-resolves the same window, which
 * costs no rng draws because the expiry branch short-circuits before the first
 * one). A synthetic player who never answers anything would otherwise lose at
 * turn 8 at bracket 5 and turn 12 at bracket 2, and every "per run" number
 * would be measuring a different number of windows at each bracket. "deadlines
 * hit per run" below is what that costs a player who never responds.
 */
import { createRng } from '../src/domain/rng.ts';
import { PRESSURE } from '../src/data/pressure.ts';
import {
  applyDamageToSeat,
  emptySilhouette,
  initialThreat,
  resolveWindow,
  zeroFiredCounts,
  zeroLastFiredWindow,
  type FiredCounts,
  type LastFiredWindow,
  type PermanentSummary,
  type PlayerSummary,
  type SeatSnapshot,
} from '../src/engine/pressure.ts';
import type { ClockState, CounterArmed, SeatId } from '../src/domain/types.ts';

const RUNS = Math.max(1, Number.parseInt(process.argv[2] ?? '', 10) || 2000);
const BRACKETS = [1, 2, 3, 4, 5];
const FIRST_TURN = 2;
const LAST_TURN = 12;
const SEAT_IDS: SeatId[] = ['A', 'B', 'C'];
const STARTING_SEAT_LIFE = 40;

// ---------------------------------------------------------------------------
// The synthetic player
// ---------------------------------------------------------------------------
// One nonland permanent of mana value 3 arrives per turn from turn 2, so board
// mana value grows by about 3 a turn. The commander is on the battlefield from
// turn 4 onward and never leaves — the probe does not model the player losing
// it, so removal and counterspell rates read as "how often would the pod go for
// it", not "how long was it down". Creature power grows more slowly than board
// value, which is what a deck that also plays ramp and artifacts looks like.
// From turn 5 the player attacks the scariest living seat for a flat 4 a turn:
// enough to move that seat's threat and silhouette, never enough to kill it, so
// every run keeps three seats and the numbers stay comparable.

const BOARD_MV_PER_TURN = 3;
const COMMANDER_TURN = 4;
const COMMANDER_MV = 5;
const PERMANENT_MV = 3;
const POWER_PER_TURN = 2;
const POWER_START_TURN = 3;
const DAMAGE_PER_TURN = 4;
const DAMAGE_START_TURN = 5;

function boardMvAt(turn: number): number {
  return Math.max(0, BOARD_MV_PER_TURN * (turn - 1));
}

function boardPowerAt(turn: number): number {
  return Math.max(0, POWER_PER_TURN * (turn - POWER_START_TURN + 1));
}

/** Damage dealt over the engine's recent-damage window, ending on `turn`. */
function damageRecentAt(turn: number): number {
  let total = 0;
  const oldest = turn - PRESSURE.playerThreat.recentTurns + 1;
  for (let t = Math.max(DAMAGE_START_TURN, oldest); t <= turn; t++) total += DAMAGE_PER_TURN;
  return Math.max(0, total);
}

function playerAt(turn: number): PlayerSummary {
  return {
    life: 40,
    boardMV: boardMvAt(turn),
    boardPower: boardPowerAt(turn),
    commanderOnBattlefield: turn >= COMMANDER_TURN,
    damageDealtRecent: damageRecentAt(turn),
  };
}

/** The battlefield the removal heuristic gets to choose from. */
function permanentsAt(turn: number): PermanentSummary[] {
  const out: PermanentSummary[] = [];
  if (turn >= COMMANDER_TURN) {
    out.push({
      iid: 'commander',
      name: 'Probe Commander',
      manaValue: COMMANDER_MV,
      isCommander: true,
      isToken: false,
      isLand: false,
      movedAt: 1000,
    });
  }
  const count = Math.max(0, turn - 1);
  for (let i = 0; i < count; i++) {
    out.push({
      iid: `perm-${i}`,
      name: `Probe Permanent ${i + 1}`,
      manaValue: PERMANENT_MV,
      isCommander: false,
      isToken: false,
      isLand: false,
      movedAt: 100 + i,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tallies
// ---------------------------------------------------------------------------

interface Tally {
  runs: number;
  runsWipedByTurn7: number;
  runsWithWipe: number;
  firstWipeTurnSum: number;
  removals: number;
  commanderRemovals: number;
  combatEvents: number;
  combatDamageByTurn10: number;
  resourceEvents: number;
  runsWithClock: number;
  clockSpawnTurnSum: number;
  counterArmedWindows: number;
  threatAtTurn5: number;
  threatAtTurn5Samples: number;
  threatAtTurn10: number;
  threatAtTurn10Samples: number;
  clockExpiries: number;
  runsWithExpiry: number;
}

function freshTally(): Tally {
  return {
    runs: 0,
    runsWipedByTurn7: 0,
    runsWithWipe: 0,
    firstWipeTurnSum: 0,
    removals: 0,
    commanderRemovals: 0,
    combatEvents: 0,
    combatDamageByTurn10: 0,
    resourceEvents: 0,
    runsWithClock: 0,
    clockSpawnTurnSum: 0,
    counterArmedWindows: 0,
    threatAtTurn5: 0,
    threatAtTurn5Samples: 0,
    threatAtTurn10: 0,
    threatAtTurn10Samples: 0,
    clockExpiries: 0,
    runsWithExpiry: 0,
  };
}

function freshSeats(rng: () => number): SeatSnapshot[] {
  return SEAT_IDS.map((id) => ({
    id,
    life: STARTING_SEAT_LIFE,
    eliminated: false,
    threat: initialThreat(rng),
    silhouette: emptySilhouette(),
  }));
}

/** Mean threat across the seats still in the game. */
function meanLivingThreat(seats: SeatSnapshot[]): number | null {
  const living = seats.filter((s) => !s.eliminated);
  if (living.length === 0) return null;
  return living.reduce((n, s) => n + s.threat, 0) / living.length;
}

/** The seat the player attacks: the scariest one still alive. */
function topSeat(seats: SeatSnapshot[]): SeatSnapshot | undefined {
  let best: SeatSnapshot | undefined;
  for (const seat of seats) {
    if (seat.eliminated) continue;
    if (!best || seat.threat > best.threat || (seat.threat === best.threat && seat.id < best.id)) {
      best = seat;
    }
  }
  return best;
}

/** One simulated run at one bracket, folded into `tally`. */
function probeRun(bracket: number, seed: string, tally: Tally): void {
  const rng = createRng(seed);
  const seats = freshSeats(rng);

  let clock: ClockState | null = null;
  let counterArmed: CounterArmed | null = null;
  const firedCounts: FiredCounts = zeroFiredCounts();
  const lastFiredWindow: LastFiredWindow = zeroLastFiredWindow();

  let firstWipeTurn: number | null = null;
  let clockSpawnTurn: number | null = null;
  let expired = false;

  tally.runs += 1;

  for (let turn = FIRST_TURN; turn <= LAST_TURN; turn++) {
    const windowIndex = turn - FIRST_TURN + 1;
    const window = () => ({
      turn,
      windowIndex,
      bracket,
      rng,
      seats,
      player: playerAt(turn),
      permanents: permanentsAt(turn),
      clock,
      counterArmed,
      firedCounts,
      lastFiredWindow,
    });

    let result = resolveWindow(window());

    if (result.clockExpired) {
      // The app would end the run here. The probe books the deadline and plays
      // on, so every bracket contributes the same eleven windows to the tally.
      // The expiry branch returns before the first rng draw, so re-resolving
      // the window with the clock cleared replays it exactly.
      tally.clockExpiries += 1;
      expired = true;
      clock = null;
      result = resolveWindow(window());
    }

    // Fold the window back into the seats, exactly as the store does.
    for (const update of result.seats) {
      const seat = seats.find((s) => s.id === update.id);
      if (seat) {
        seat.threat = update.threat;
        seat.silhouette = update.silhouette;
      }
    }
    for (const event of result.events) {
      firedCounts[event.type] += 1;
      lastFiredWindow[event.type] = windowIndex;
    }
    clock = result.clock;
    counterArmed = result.counterArmed;
    if (counterArmed) tally.counterArmedWindows += 1;

    for (const event of result.events) {
      switch (event.type) {
        case 'wipe':
          if (firstWipeTurn === null) firstWipeTurn = event.turn;
          break;
        case 'removal':
          tally.removals += 1;
          if (event.severity.commander === 1) tally.commanderRemovals += 1;
          break;
        case 'combat':
          tally.combatEvents += 1;
          if (event.turn <= 10) tally.combatDamageByTurn10 += event.severity.damage ?? 0;
          break;
        case 'resource':
          tally.resourceEvents += 1;
          break;
        case 'clock':
          if (clockSpawnTurn === null) clockSpawnTurn = event.turn;
          break;
        default:
          break;
      }
    }

    if (turn === 5 || turn === 10) {
      const threat = meanLivingThreat(seats);
      if (threat !== null) {
        if (turn === 5) {
          tally.threatAtTurn5 += threat;
          tally.threatAtTurn5Samples += 1;
        } else {
          tally.threatAtTurn10 += threat;
          tally.threatAtTurn10Samples += 1;
        }
      }
    }

    // The player's own turn: swing at the scariest seat.
    if (turn >= DAMAGE_START_TURN) {
      const target = topSeat(seats);
      if (target) {
        const shrunk = applyDamageToSeat(
          target.threat,
          target.silhouette,
          DAMAGE_PER_TURN,
          target.life,
        );
        target.life -= DAMAGE_PER_TURN;
        target.threat = shrunk.threat;
        target.silhouette = shrunk.silhouette;
        if (target.life <= 0) {
          target.eliminated = true;
          target.threat = 0;
          target.silhouette = emptySilhouette();
        }
      }
    }
  }

  if (firstWipeTurn !== null) {
    tally.runsWithWipe += 1;
    tally.firstWipeTurnSum += firstWipeTurn;
    if (firstWipeTurn <= 7) tally.runsWipedByTurn7 += 1;
  }
  if (clockSpawnTurn !== null) {
    tally.runsWithClock += 1;
    tally.clockSpawnTurnSum += clockSpawnTurn;
  }
  if (expired) tally.runsWithExpiry += 1;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * What each bracket is supposed to feel like, as numbers. The point of the
 * table is that the *schedule* moves with the bracket, not only the frequency:
 * a bracket-5 pod is threatening to win six turns before a bracket-1 pod is.
 * Two rows deliberately peak at bracket 4 rather than 5 — a cEDH pod wraths and
 * attacks less than an optimised casual pod, because it interacts and combos
 * instead. The bands are the tuning tolerance, not a measurement error bar.
 */
const TARGETS: Metric[] = [
  {
    key: 'clockSpawnTurn',
    label: 'clock spawn turn (runs with one)',
    kind: 'num',
    digits: 2,
    band: 0.7,
    targets: [11.5, 10, 8.5, 7, 5.5],
    value: (t) => mean(t.clockSpawnTurnSum, t.runsWithClock),
  },
  {
    key: 'clockSpawnRate',
    label: 'clock spawn rate by turn 12',
    kind: 'pct',
    digits: 1,
    band: 8,
    targets: [40, 65, 85, 95, 98],
    value: (t) => mean(t.runsWithClock * 100, t.runs),
  },
  {
    key: 'wipeByTurn7',
    label: 'wipe by turn 7',
    kind: 'pct',
    digits: 1,
    band: 8,
    targets: [30, 50, 68, 78, 60],
    value: (t) => mean(t.runsWipedByTurn7 * 100, t.runs),
  },
  {
    key: 'firstWipeTurn',
    label: 'first wipe turn (runs with one)',
    kind: 'num',
    digits: 2,
    band: 0.6,
    targets: [8.5, 7.5, 6.5, 5.5, 5.5],
    value: (t) => mean(t.firstWipeTurnSum, t.runsWithWipe),
  },
  {
    key: 'removals',
    label: 'removals per run',
    kind: 'num',
    digits: 2,
    band: 0.3,
    targets: [0.6, 1.0, 1.4, 2.0, 2.6],
    value: (t) => mean(t.removals, t.runs),
  },
  {
    key: 'combatDamage',
    label: 'combat damage by turn 10',
    kind: 'num',
    digits: 1,
    band: 5,
    targets: [6, 12, 21, 30, 28],
    value: (t) => mean(t.combatDamageByTurn10, t.runs),
  },
  {
    key: 'resource',
    label: 'resource events per run',
    kind: 'num',
    digits: 2,
    band: 0.3,
    targets: [0.3, 0.8, 1.1, 1.4, 1.8],
    value: (t) => mean(t.resourceEvents, t.runs),
  },
  {
    key: 'counterArmed',
    label: 'counter-armed windows per run',
    kind: 'num',
    digits: 2,
    band: 0.8,
    targets: [0.5, 1.3, 2.8, 4.5, 7],
    value: (t) => mean(t.counterArmedWindows, t.runs),
  },
  {
    key: 'threatT5',
    label: 'seat threat at turn 5',
    kind: 'num',
    digits: 2,
    band: 0.5,
    targets: [2.0, 2.7, 3.4, 4.3, 5.5],
    value: (t) => mean(t.threatAtTurn5, t.threatAtTurn5Samples),
  },
  {
    key: 'threatT10',
    label: 'seat threat at turn 10',
    kind: 'num',
    digits: 2,
    band: 0.6,
    targets: [3.2, 4.5, 6.0, 7.5, 9.0],
    value: (t) => mean(t.threatAtTurn10, t.threatAtTurn10Samples),
  },
];

/** Rows worth reading that nothing is fitted to. */
const DIAGNOSTICS: Diagnostic[] = [
  { label: 'commander removals per run', value: (t) => mean(t.commanderRemovals, t.runs), digits: 2 },
  { label: 'combat events per run', value: (t) => mean(t.combatEvents, t.runs), digits: 2 },
  { label: 'deadlines hit per run', value: (t) => mean(t.clockExpiries, t.runs), digits: 2 },
  { label: 'runs that hit a deadline (%)', value: (t) => mean(t.runsWithExpiry * 100, t.runs), digits: 1 },
];

interface Metric {
  key: string;
  label: string;
  kind: 'pct' | 'num';
  digits: number;
  /** Half-width of the pass band, in the metric's own unit. */
  band: number;
  /** One target per bracket, indexed `bracket - 1`. */
  targets: number[];
  value: (tally: Tally) => number | null;
}

interface Diagnostic {
  label: string;
  digits: number;
  value: (tally: Tally) => number | null;
}

function mean(total: number, whole: number): number | null {
  return whole === 0 ? null : total / whole;
}

function fmt(value: number | null, digits: number, kind: 'pct' | 'num'): string {
  if (value === null) return 'n/a';
  return kind === 'pct' ? `${value.toFixed(digits)}%` : value.toFixed(digits);
}

/** Prints one bracket's table. Returns the metrics that fell outside their band. */
function report(bracket: number, tally: Tally): string[] {
  console.log(`\nBracket ${bracket}  (${tally.runs} runs, turns ${FIRST_TURN}-${LAST_TURN})`);
  console.log(
    `  ${'metric'.padEnd(34)}${'value'.padStart(8)}${'target'.padStart(9)}${'band'.padStart(9)}  result`,
  );
  console.log('  ' + '─'.repeat(66));

  const missed: string[] = [];
  for (const metric of TARGETS) {
    const value = metric.value(tally);
    const target = metric.targets[bracket - 1];
    const ok = value !== null && Math.abs(value - target) <= metric.band;
    if (!ok) missed.push(metric.key);
    const band = `±${metric.band}${metric.kind === 'pct' ? ' pts' : ''}`;
    console.log(
      `  ${metric.label.padEnd(34)}${fmt(value, metric.digits, metric.kind).padStart(8)}` +
        `${fmt(target, metric.digits, metric.kind).padStart(9)}${band.padStart(9)}  ${ok ? 'PASS' : 'MISS'}`,
    );
  }

  console.log('  ' + '─'.repeat(66));
  for (const d of DIAGNOSTICS) {
    console.log(`  ${d.label.padEnd(34)}${fmt(d.value(tally), d.digits, 'num').padStart(8)}`);
  }

  const passed = TARGETS.length - missed.length;
  console.log(
    `  bracket ${bracket}: ${passed}/${TARGETS.length} in band` +
      (missed.length > 0 ? `  ·  MISS: ${missed.join(', ')}` : ''),
  );
  return missed;
}

function main(): void {
  console.log('\nprobe:pressure');
  console.log('═'.repeat(56));
  console.log(`pressure version ${PRESSURE.version}, ${RUNS} runs per bracket`);
  console.log('');
  console.log('Synthetic player trajectory (the same one at every bracket):');
  console.log(`  board mana value    +${BOARD_MV_PER_TURN} per turn from turn 2 (one MV-${PERMANENT_MV} permanent a turn)`);
  console.log(`  commander           on the battlefield from turn ${COMMANDER_TURN}, never leaves`);
  console.log(`  creature power      +${POWER_PER_TURN} per turn from turn ${POWER_START_TURN}`);
  console.log(`  damage dealt        ${DAMAGE_PER_TURN} per turn to the top living seat from turn ${DAMAGE_START_TURN}`);
  console.log(`  seat life           ${STARTING_SEAT_LIFE}, so no seat dies inside the probe`);
  console.log('  answers             the player never responds; every event is taken');
  console.log('  deadlines           recorded, then played through (see the header)');

  let missTotal = 0;
  for (const bracket of BRACKETS) {
    const tally = freshTally();
    for (let i = 0; i < RUNS; i++) probeRun(bracket, `probe-b${bracket}-r${i}`, tally);
    missTotal += report(bracket, tally).length;
  }

  const checks = TARGETS.length * BRACKETS.length;
  console.log('');
  console.log('═'.repeat(56));
  if (missTotal === 0) {
    console.log(`PASS — all ${checks} metrics inside their band.`);
  } else {
    console.log(`FAIL — ${missTotal} of ${checks} metrics outside their band.`);
  }
  console.log('');
  process.exitCode = missTotal === 0 ? 0 : 1;
}

main();
