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
 * Three of the checks are rules rather than bands, and fail the probe on their
 * own however well the curves fit: no event fires without a card citation, no
 * seat cites a card outside its colour identity (events and the counter pick
 * both), and `neutral` is never dealt to a seat. The last two rows of `TARGETS`
 * are rules wearing bands — `archetypeGap` measures how much more often the
 * aggro seat attacks than the control seat and `counterArmGap` how much more
 * often the control seat holds up a counter than the stax seat, per bracket,
 * because every other metric here sums over the whole table and would happily
 * pass with three identical seats at it.
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
import { PROFILES, PROFILE_IDS, type SeatProfileId } from '../src/data/profiles.ts';
import {
  applyDamageToSeat,
  chooseCounterCitation,
  drawProfiles,
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
import type { ClockState, CounterArmed, EventType, SeatId } from '../src/domain/types.ts';

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
      typeLine: 'Legendary Creature — Probe Avatar',
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
      // Alternating, because removal is chosen by what it can point at: a board
      // of nothing but creatures would never see Krosan Grip.
      typeLine: i % 2 === 0 ? 'Artifact' : 'Creature — Probe Beast',
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
  /** Resource events by sub-kind, so the renormalised weights are visible. */
  discardEvents: number;
  sacrificeEvents: number;
  taxEvents: number;
  /**
   * Events that fired without naming a card. The product rule is "no card, no
   * event", so this is the one diagnostic that is really an assertion: any
   * number but zero means an event escaped the citation table.
   */
  citationMissing: number;
  /**
   * Seat-runs and turn-6-to-10 combat events per archetype, *at this bracket*.
   * The pooled table at the bottom of the report cannot catch a profile that
   * has stopped mattering inside one bracket, which is exactly how the hazard
   * cap swallowed the multipliers — see the `archetypeGap` metric.
   */
  seatRunsHere: ProfileCounts;
  combat6to10Here: ProfileCounts;
  /** Windows this archetype spent holding up a counter, *at this bracket*. */
  armedHere: ProfileCounts;
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
    discardEvents: 0,
    sacrificeEvents: 0,
    taxEvents: 0,
    citationMissing: 0,
    seatRunsHere: zeroProfileCounts(),
    combat6to10Here: zeroProfileCounts(),
    armedHere: zeroProfileCounts(),
  };
}

/**
 * Three seats with three different archetypes, dealt off the run's own rng in
 * the store's order: one opening threat per seat, then the three profile draws.
 *
 * This mirrors the store's seat deal, not a whole run start — the app also
 * shuffles the library off the same rng before any of this, so a probe seed and
 * an app seed of the same string are different streams by design. What has to
 * match is the *relative* order here, because the engine's own draw order is
 * what the probe is measuring and a seat table dealt in the wrong order would
 * measure a different pod than the app plays.
 */
function freshSeats(rng: () => number): SeatSnapshot[] {
  const seats = SEAT_IDS.map((id) => ({
    id,
    life: STARTING_SEAT_LIFE,
    eliminated: false,
    threat: initialThreat(rng),
    silhouette: emptySilhouette(),
  })) satisfies SeatSnapshot[];
  const profiles = drawProfiles(rng);
  return seats.map((seat, i) => ({ ...seat, profile: profiles[i] }));
}

// ---------------------------------------------------------------------------
// Profile attribution
// ---------------------------------------------------------------------------
// Which archetype produced which events, pooled across every bracket: a seat
// profile is not a bracket dial, so its shape should read the same wherever it
// sits, and pooling gives each of the six enough seat-runs to be worth reading.
// A "seat-run" is one seat holding one profile for one simulated run.

type ProfileCounts = Record<SeatProfileId, number>;
type ProfileEvents = Record<SeatProfileId, Record<EventType, number>>;

// Seeded over every key of `PROFILES`, not over `PROFILE_IDS`: `neutral` is
// never dealt, so a nonzero count against it is a bug worth seeing as a zero
// that became a one rather than as an `undefined` turning every sum into NaN.
function zeroProfileCounts(): ProfileCounts {
  return Object.fromEntries(profileKeys().map((id) => [id, 0])) as ProfileCounts;
}

function zeroProfileEvents(): ProfileEvents {
  return Object.fromEntries(
    profileKeys().map((id) => [id, zeroFiredCounts()]),
  ) as ProfileEvents;
}

function profileKeys(): SeatProfileId[] {
  return Object.keys(PROFILES) as SeatProfileId[];
}

const seatRunsByProfile = zeroProfileCounts();
const eventsByProfile = zeroProfileEvents();

/**
 * Citations cast outside the caster's colour identity. Not a band and not a
 * tuning question: a seat citing a card it could not be running is a visible
 * bug, so any breach fails the probe on its own.
 */
let colorBreaches = 0;
const colorBreachSamples: string[] = [];

function checkCitationColors(
  seatId: SeatId,
  profile: SeatProfileId,
  type: EventType,
  card: { name: string; colors: readonly string[] } | undefined,
): void {
  if (!card) return;
  const allowed = PROFILES[profile].colors as readonly string[];
  const wrong = card.colors.filter((c) => !allowed.includes(c));
  if (wrong.length === 0) return;
  colorBreaches += 1;
  if (colorBreachSamples.length < 5) {
    colorBreachSamples.push(
      `seat ${seatId} (${profile}, ${allowed.join('')}) cited ${card.name} [${card.colors.join('')}] on a ${type}`,
    );
  }
}

/**
 * The counter citation is the one selection the window's rng never makes: the
 * store raises counters on the player's own cast, which is not a point in the
 * draw order, so `chooseCounterCitation` indexes a hash instead of drawing. That
 * puts it outside every loop above — no simulated player casts anything — so it
 * is exercised here directly, over every archetype's colours against a spread
 * of spell shapes, brackets, turns and open mana.
 *
 * Same rule as the events: a citation outside the holder's colour identity is
 * not a tuning question, it is a seat holding a card it could not be running.
 */
const COUNTER_PROBE_SPELLS = [
  { name: 'Probe Beast', manaValue: 4, typeLine: 'Creature — Probe Beast' },
  { name: 'Probe Ritual', manaValue: 3, typeLine: 'Sorcery' },
  { name: 'Probe Aura', manaValue: 5, typeLine: 'Enchantment' },
  { name: 'Probe Avatar', manaValue: 6, typeLine: 'Legendary Creature — Probe Avatar' },
  { name: 'Probe Signet', manaValue: 2, typeLine: 'Artifact' },
];

interface CounterCheck {
  calls: number;
  cited: number;
  breaches: number;
  samples: string[];
}

function checkCounterCitationColors(): CounterCheck {
  const out: CounterCheck = { calls: 0, cited: 0, breaches: 0, samples: [] };
  for (const id of PROFILE_IDS) {
    const allowed = PROFILES[id].colors as readonly string[];
    for (const bracket of BRACKETS) {
      for (let turn = FIRST_TURN; turn <= LAST_TURN; turn++) {
        for (let mana = 0; mana <= 10; mana++) {
          for (let i = 0; i < COUNTER_PROBE_SPELLS.length; i++) {
            const spell = COUNTER_PROBE_SPELLS[i];
            out.calls += 1;
            const card = chooseCounterCitation(
              turn - FIRST_TURN + 1,
              turn,
              bracket,
              mana,
              spell,
              PROFILES[id].colors,
            );
            if (!card) continue;
            out.cited += 1;
            const wrong = card.colors.filter((c) => !allowed.includes(c));
            if (wrong.length === 0) continue;
            out.breaches += 1;
            if (out.samples.length < 5) {
              out.samples.push(
                `${id} (${allowed.join('')}) would counter ${spell.name} with ${card.name} [${card.colors.join('')}]`,
              );
            }
          }
        }
      }
    }
  }
  return out;
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
  for (const seat of seats) {
    if (seat.profile) {
      seatRunsByProfile[seat.profile] += 1;
      tally.seatRunsHere[seat.profile] += 1;
    }
  }

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
    if (counterArmed) {
      tally.counterArmedWindows += 1;
      // Attributed to the seat actually holding it up, the same way an event is
      // attributed to the seat that cast it — see the `counterArmGap` metric.
      const armedProfile = seats.find((s) => s.id === counterArmed?.seatId)?.profile;
      if (armedProfile) tally.armedHere[armedProfile] += 1;
    }

    for (const event of result.events) {
      // Combat is the silhouette turning sideways rather than a spell; every
      // other event has to name the card it came off.
      if (event.type !== 'combat' && !event.card) tally.citationMissing += 1;
      const profile = seats.find((s) => s.id === event.seatId)?.profile;
      if (profile) {
        eventsByProfile[profile][event.type] += 1;
        checkCitationColors(event.seatId, profile, event.type, event.card);
      }
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
          // Turns 6-10 on purpose: that is the stretch where the hazard ramps
          // meet their bracket ceilings, so it is where a mis-placed profile
          // multiplier stops showing up at all.
          if (profile && event.turn >= 6 && event.turn <= 10) {
            tally.combat6to10Here[profile] += 1;
          }
          break;
        case 'resource':
          tally.resourceEvents += 1;
          if (event.variant === 'discard') tally.discardEvents += 1;
          else if (event.variant === 'sacrifice') tally.sacrificeEvents += 1;
          else if (event.variant === 'tax') tally.taxEvents += 1;
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
  {
    // The archetype gap, and the only row here that is about seats rather than
    // about the pod. Every other metric sums over the table, so all three seats
    // could quietly converge on the same behaviour without moving one of them.
    // That is precisely what happened when a profile multiplier was applied
    // before the hazard's bracket ceiling: from turn 5 at bracket 4 the aggro
    // seat (1.6x) and the tokens seat (1.4x) both pinned at the same 0.9, and
    // an aggro seat that attacks exactly as often as a control seat is not an
    // archetype, it is a label.
    //
    // The fiction: aggro is the seat that turns creatures sideways and control
    // is the seat that would rather not, so over the turns where both have a
    // board — 6 to 10, which is also where the ramps are up against their
    // ceilings — aggro should be attacking a clear multiple as often. The ratio
    // is per seat-run, so it does not care how many of each the shuffle dealt.
    //
    // The band is really a floor with an upper edge attached: every lower edge
    // is 2.0 or above, so "the archetypes collapsed together" fails here long
    // before a player could see it, and the upper edge still holds the gap to a
    // multiplier on a shared curve rather than letting the control seat stop
    // blocking entirely. The gap narrows with the bracket because the ceilings
    // do the narrowing — at bracket 4 both curves spend the late turns pressed
    // against `max`, which is the least room the two archetypes ever have.
    //
    // Bands are per bracket because the noise is proportional and the value is
    // not: at bracket 1 the control seat almost never has the board to attack
    // with, so the denominator is small and the ratio is both large and loose.
    key: 'archetypeGap',
    label: 'aggro:control combat, t6-10',
    kind: 'num',
    digits: 2,
    band: 1.1,
    bands: [2.5, 1.8, 1.1, 0.8, 1.1],
    targets: [7.0, 5.8, 3.8, 2.8, 3.7],
    value: (t) => profileRatio(t.combat6to10Here, t.seatRunsHere, 'aggro', 'control'),
  },
  {
    // The same rule as `archetypeGap`, pointed at the other half of the engine:
    // the counter-arming roll had the version-4 shape long after the hazards
    // were fixed, so a control seat at bracket 5 against a scary player hit the
    // same 0.9 ceiling as a seat with no multiplier at all.
    //
    // The fiction: holding up a counter is the one thing a control seat is
    // named for, so it should be doing it a clear multiple as often as a seat
    // that would rather spend its mana on the board. The pair is control (1.5x)
    // against stax (0.7x) rather than against aggro, because only a seat with
    // blue in it is ever a candidate to hold one: aggro is Mardu and can never
    // arm at all, so an aggro denominator would be a division by zero dressed
    // up as a gap. Control and stax are the same three colours in the same
    // order, so their eligibility is identical every window and what separates
    // them is `counterArmMult` and nothing else — which is exactly the number
    // being measured.
    //
    // The band is a floor, like `archetypeGap`'s: every lower edge is 1.35, so
    // a collapse back to ~1.0 — the two seats arming equally often, the
    // multiplier swallowed again — MISSES at every bracket. The measured gap is
    // well under the 2.14x the multipliers alone would suggest, and bracket 5
    // is the narrowest of the five rather than the widest, because only one
    // seat holds up a counter per window and the holder is whoever has the most
    // open mana and threat: the control seat grows threat slowest of the six,
    // so it loses the roll to the stax seat often enough to eat into the gap,
    // and at bracket 5 its own chance is against `profileCeiling` while the
    // stax seat's is still climbing. Per-bracket bands, because that narrowing
    // is real and one width would either pass a collapse at bracket 1 or fail
    // an honest bracket 5.
    key: 'counterArmGap',
    label: 'control:stax armed windows',
    kind: 'num',
    digits: 2,
    band: 0.5,
    bands: [0.6, 0.55, 0.5, 0.6, 0.3],
    targets: [1.95, 1.9, 1.85, 1.95, 1.65],
    value: (t) => profileRatio(t.armedHere, t.seatRunsHere, 'control', 'stax'),
  },
];

/**
 * Something-per-seat-run for one archetype against another, at this bracket.
 * Null rather than Infinity when the denominator saw none at all — a bracket
 * where the control seat never attacks is a result to read, not a number to
 * divide by.
 */
function profileRatio(
  counts: ProfileCounts,
  seatRuns: ProfileCounts,
  over: SeatProfileId,
  under: SeatProfileId,
): number | null {
  const a = mean(counts[over], seatRuns[over]);
  const b = mean(counts[under], seatRuns[under]);
  if (a === null || b === null || b === 0) return null;
  return a / b;
}

/** Rows worth reading that nothing is fitted to. */
const DIAGNOSTICS: Diagnostic[] = [
  { label: 'commander removals per run', value: (t) => mean(t.commanderRemovals, t.runs), digits: 2 },
  { label: 'combat events per run', value: (t) => mean(t.combatEvents, t.runs), digits: 2 },
  { label: 'deadlines hit per run', value: (t) => mean(t.clockExpiries, t.runs), digits: 2 },
  { label: 'runs that hit a deadline (%)', value: (t) => mean(t.runsWithExpiry * 100, t.runs), digits: 1 },
  { label: 'discard events per run', value: (t) => mean(t.discardEvents, t.runs), digits: 2 },
  { label: 'sacrifice events per run', value: (t) => mean(t.sacrificeEvents, t.runs), digits: 2 },
  { label: 'tax events per run', value: (t) => mean(t.taxEvents, t.runs), digits: 2 },
  { label: 'events missing a citation', value: (t) => t.citationMissing, digits: 0 },
];

interface Metric {
  key: string;
  label: string;
  kind: 'pct' | 'num';
  digits: number;
  /** Half-width of the pass band, in the metric's own unit. */
  band: number;
  /**
   * Per-bracket half-widths, indexed `bracket - 1`, overriding `band`. For a
   * metric whose value is a ratio rather than a rate: the same proportional
   * noise is a much wider absolute band at a bracket where the ratio is 5 than
   * at one where it is 2, so one number cannot serve both.
   */
  bands?: number[];
  /** One target per bracket, indexed `bracket - 1`. */
  targets: number[];
  value: (tally: Tally) => number | null;
}

/** The band this metric is judged against at one bracket. */
function bandAt(metric: Metric, bracket: number): number {
  return metric.bands?.[bracket - 1] ?? metric.band;
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
    const half = bandAt(metric, bracket);
    const ok = value !== null && Math.abs(value - target) <= half;
    if (!ok) missed.push(metric.key);
    const band = `±${half}${metric.kind === 'pct' ? ' pts' : ''}`;
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

/**
 * Events per 1000 seat-runs, one row per archetype, pooled across brackets.
 * This is the table a profile tuning pass reads: the bracket rows above say how
 * much pressure the pod produced, and this one says who produced it.
 */
function reportProfiles(): void {
  const types: EventType[] = ['wipe', 'removal', 'combat', 'resource', 'clock'];
  console.log('');
  console.log('═'.repeat(56));
  console.log('Seat archetypes  (events per 1000 seat-runs, all brackets pooled)');
  console.log(
    `  ${'profile'.padEnd(10)}${'colours'.padStart(8)}${'seat-runs'.padStart(11)}` +
      types.map((t) => t.padStart(9)).join(''),
  );
  console.log('  ' + '─'.repeat(66));
  for (const id of PROFILE_IDS) {
    const runs = seatRunsByProfile[id];
    const per1000 = (n: number): string => (runs === 0 ? 'n/a' : ((n * 1000) / runs).toFixed(1));
    console.log(
      `  ${id.padEnd(10)}${PROFILES[id].colors.join('').padStart(8)}${String(runs).padStart(11)}` +
        types.map((t) => per1000(eventsByProfile[id][t]).padStart(9)).join(''),
    );
  }
  console.log('  ' + '─'.repeat(66));
  console.log(
    `  citations outside the caster's colours: ${colorBreaches}` +
      (colorBreaches === 0 ? '  (PASS)' : '  (FAIL)'),
  );
  for (const sample of colorBreachSamples) console.log(`    ${sample}`);
  console.log(
    `  neutral profiles dealt to a seat: ${seatRunsByProfile.neutral}` +
      (seatRunsByProfile.neutral === 0 ? '  (PASS)' : '  (FAIL)'),
  );
}

/** The counter-citation colour check, printed as its own short section. */
function reportCounterColors(check: CounterCheck): void {
  console.log('');
  console.log('═'.repeat(56));
  console.log('Counter citations  (chooseCounterCitation, outside the rng stream)');
  console.log(
    `  ${check.calls} calls across ${PROFILE_IDS.length} archetypes x ${BRACKETS.length} brackets` +
      ` x turns ${FIRST_TURN}-${LAST_TURN} x mana 0-10 x ${COUNTER_PROBE_SPELLS.length} spell shapes`,
  );
  console.log(`  calls that produced a citation: ${check.cited}`);
  console.log(
    `  citations outside the holder's colours: ${check.breaches}` +
      (check.breaches === 0 ? '  (PASS)' : '  (FAIL)'),
  );
  for (const sample of check.samples) console.log(`    ${sample}`);
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
  let citationMisses = 0;
  for (const bracket of BRACKETS) {
    const tally = freshTally();
    for (let i = 0; i < RUNS; i++) probeRun(bracket, `probe-b${bracket}-r${i}`, tally);
    missTotal += report(bracket, tally).length;
    citationMisses += tally.citationMissing;
  }

  reportProfiles();
  const counterCheck = checkCounterCitationColors();
  reportCounterColors(counterCheck);

  const checks = TARGETS.length * BRACKETS.length;
  console.log('');
  console.log('═'.repeat(56));
  if (missTotal === 0) {
    console.log(`PASS — all ${checks} metrics inside their band.`);
  } else {
    console.log(`FAIL — ${missTotal} of ${checks} metrics outside their band.`);
  }
  // Not a band: "no card, no event" is a rule, so any breach fails the probe on
  // its own however well the curves fit.
  if (citationMisses > 0) {
    console.log(`FAIL — ${citationMisses} event(s) fired without a card citation.`);
  }
  // Same class of rule: a seat may only cite cards inside its colour identity.
  if (colorBreaches > 0) {
    console.log(`FAIL — ${colorBreaches} citation(s) outside the caster's colours.`);
  }
  if (counterCheck.breaches > 0) {
    console.log(
      `FAIL — ${counterCheck.breaches} counter citation(s) outside the holder's colours.`,
    );
  }
  // And `neutral` is the shape of "no profile", not an opponent: dealing it to a
  // seat would put an archetype-less seat at the table.
  if (seatRunsByProfile.neutral > 0) {
    console.log(`FAIL — neutral was dealt to ${seatRunsByProfile.neutral} seat-run(s).`);
  }
  console.log('');
  process.exitCode =
    missTotal === 0 &&
    citationMisses === 0 &&
    colorBreaches === 0 &&
    counterCheck.breaches === 0 &&
    seatRunsByProfile.neutral === 0
      ? 0
      : 1;
}

main();
