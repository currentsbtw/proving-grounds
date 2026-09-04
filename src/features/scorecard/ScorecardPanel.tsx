import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getDeck } from '../../db/db';
import { aggregateProfile, compareScorecards } from '../../engine/scorecard';
import type { EventLedgerRow, Scorecard } from '../../engine/scorecard';
import { reviewPatterns } from '../../engine/review';
import type { FindingKind, Review } from '../../engine/review';
import type { Deck, RunResult } from '../../domain/types';
import { useUiStore } from '../../state/uiStore';
import { normalizeSweep, sweepWord } from '../pressure/pressureUi';
import CardStatsSection from './CardStatsSection';
import ReviewSection from './ReviewSection';
import TimelineChart from './TimelineChart';
import { useDeckScorecards, useScorecard } from './useScorecards';
import { renderScorecardPng } from './shareImage';
import { Figure } from './figures';
import { NO_VALUE, num, pct, verdictOf } from './verdict';
import { startDeckRun } from '../decks/startDeckRun';
import './scorecard.css';

/**
 * The centre panel when no run is live and a run is selected. The milestone's
 * exit criterion is a brewer changing a real decklist because of something in
 * here, so every tile carries a sentence saying what its number means — a wall
 * of unexplained integers changes nobody's deck.
 */

const RESULT_WORD: Record<RunResult, string> = {
  win: 'Win',
  loss: 'Loss',
  concede: 'Conceded',
  abandoned: 'Abandoned',
};

const RESULT_CLASS: Record<RunResult, string> = {
  win: 'is-win',
  loss: 'is-loss',
  concede: 'is-concede',
  abandoned: 'is-abandoned',
};

/**
 * The same three words `ReviewSection` prints, for the same reason: the kind is
 * a word before it is a colour. Declared here rather than imported from that
 * file, which exports a component and nothing else.
 */
const KIND_WORD: Record<FindingKind, string> = {
  miss: 'MISS',
  good: 'GOOD',
  note: 'NOTE',
};

const CLOCK_WORD: Record<string, string> = {
  won: 'won first',
  'eliminated-seat': 'eliminated the seat',
  'declared-interaction': 'held interaction',
  expired: 'ran out',
  standing: 'still standing',
};

// --- formatting -------------------------------------------------------------
// `num`, `pct` and `NO_VALUE` are the scorecard's shared figure formats and live
// in `verdict.ts`, so the panel, the card table and the share image all round
// the same number the same way.

/** "n/a", "1 turn", "2.5 turns". Averages are rounded before the noun is chosen. */
function turns(value: number | null): string {
  if (value === null) return NO_VALUE;
  const text = num(value);
  return `${text} ${text === '1' ? 'turn' : 'turns'}`;
}

function readNum(bag: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = bag?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStr(bag: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = bag?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** The severity numbers that actually say how hard an event hit. */
function eventDetail(row: EventLedgerRow): string {
  const s = row.severity;
  switch (row.type) {
    case 'wipe':
      // The stored variant is the sweep, and old runs still say 'nonlands'; the
      // ledger prints the scope in the same words the dock offered it in.
      return `${sweepWord(normalizeSweep(row.variant))} · pod ${s.podCreatures ?? 0} creatures, ${s.podPower ?? 0} power`;
    case 'removal':
      return `target MV ${s.targetMv ?? 0}${s.commander ? ' · your commander' : ''}`;
    case 'counter':
      return `counters at ${s.threshold ?? 0}+ · your spell MV ${s.manaValue ?? 0}${s.commander ? ' · commander' : ''}`;
    case 'combat': {
      const attackers = s.attackers ?? 0;
      return `${attackers} attacker${attackers === 1 ? '' : 's'} for ${s.damage ?? 0}`;
    }
    case 'clock':
      return `deadline turn ${s.deadlineTurn ?? '?'}`;
    case 'resource':
      return row.variant ?? 'tax';
    case 'hate':
      // Nothing is enforced: the piece is a standing tell, and what it says is
      // already printed under the card name in the event column.
      return 'stands until answered';
    default:
      return row.variant ?? '';
  }
}

/** What the table looked like afterwards, in a handful of words. */
function eventOutcome(row: EventLedgerRow): string {
  // A bound answer names the card; an unbound one is still only a claim.
  if (row.terminal === 'responded')
    return row.answerCard ? `answered with ${row.answerCard}` : 'answered on the table';
  if (row.terminal === 'unresolved') return 'never resolved';
  const o = row.outcome;
  switch (row.type) {
    case 'wipe':
      return `swept ${readNum(o, 'swept') ?? 0}`;
    case 'removal':
      return o?.noTarget ? 'no legal target' : (readStr(o, 'targetName') ?? 'destroyed');
    case 'counter': {
      const name = readStr(o, 'counteredName');
      if (!name) return 'countered';
      return readStr(o, 'returnedTo') === 'command'
        ? `${name} → command zone`
        : `${name} countered`;
    }
    case 'combat': {
      const taken = readNum(o, 'taken') ?? 0;
      const offered = readNum(o, 'offered') ?? taken;
      return taken < offered ? `took ${taken} of ${offered}` : `took ${taken}`;
    }
    case 'hate':
      // The event resolved either way — the piece stood. What is printed is what
      // happened to it afterwards, which is a separate fact from the answer the
      // player did not give at the time.
      if (row.removedTurn !== undefined) {
        return row.removedWith
          ? `removed T${row.removedTurn} with ${row.removedWith}`
          : `removed T${row.removedTurn}`;
      }
      if (row.sweptTurn !== undefined) return `swept T${row.sweptTurn}`;
      return 'stands';
    case 'resource': {
      const mode = readStr(o, 'mode') ?? 'tax';
      if (o?.noTarget) return `nothing to ${mode}`;
      const name = readStr(o, 'name');
      if (name) return `${mode === 'discard' ? 'discarded' : 'sacrificed'} ${name}`;
      return 'paid the tax';
    }
    default:
      return 'acknowledged';
  }
}

// --- small pieces -----------------------------------------------------------

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="sc-tile">
      <span className="sc-tile-label">{label}</span>
      <Figure className="sc-tile-value" value={value} />
      <span className="sc-tile-sub">{sub}</span>
    </div>
  );
}

function MetricTiles({ card }: { card: Scorecard }) {
  // A wrath is only worth a recovery reading if it took something: a negated one
  // was answered, and one that swept an empty board (or only tokens and lands,
  // which count 0) left nothing to rebuild. Either way the tile says what
  // happened instead of printing a number nobody earned.
  const measured = card.wipes.filter((w) => !w.negated && w.mvLost > 0);
  const first = measured[0];
  const tookNothing = card.wipes.some((w) => !w.negated && w.mvLost === 0);
  const wipeValue = first
    ? first.turnsToRecover === null
      ? 'never'
      : String(first.turnsToRecover)
    : card.wipes.length === 0
      ? 'none'
      : tookNothing
        ? 'nothing'
        : 'answered';
  const wipeSub = first
    ? 'turns to return to 70% of the pre-wipe board'
    : card.wipes.length === 0
      ? 'no wrath was cast this run'
      : tookNothing
        ? 'no wrath took anything off the table to rebuild'
        : 'every wrath was answered on the table';

  const damage = card.seats.reduce((sum, seat) => sum + seat.damageDealt, 0);
  const killed = card.seats.filter((seat) => seat.eliminatedTurn !== null).length;
  const terminal = card.answers.total.responded + card.answers.total.resolved;

  // Runs scored before hate pieces existed carry no `hazards` at all; an absent
  // count is "none faced", which is the honest reading of a run that could not
  // have faced one.
  const hazards = card.hazards ?? { faced: 0, stood: 0, removed: 0, swept: 0, turnsStanding: [] };
  const avgStanding =
    hazards.turnsStanding.length > 0
      ? hazards.turnsStanding.reduce((a, b) => a + b, 0) / hazards.turnsStanding.length
      : null;
  // A piece the run ended on top of was never answered and never stood: it is in
  // `faced` and in the tally's `unresolved`, and in neither `stood` nor
  // `responded`. Read the answer counts off the tally rather than inferring them
  // from `faced - stood`, which cannot tell an answer from a run that stopped.
  // Scorecards written before the per-type tallies existed carry no `hate` entry;
  // a zeroed tally leaves the sentence where it was.
  const hate = card.answers.byType?.hate;
  const hateAnswered = hate?.responded ?? 0;
  const hateOpen = hate?.unresolved ?? 0;

  return (
    <div className="sc-tiles">
      <Tile
        label="Deployment"
        value={num(card.deployment.avgMvPerTurn)}
        sub={`mana value per turn · commander first cast ${
          card.deployment.firstCommanderCastTurn === null
            ? 'never'
            : `T${card.deployment.firstCommanderCastTurn}`
        }`}
      />
      <Tile label="Wipe recovery" value={wipeValue} sub={wipeSub} />
      <Tile
        label="Commander downtime"
        value={String(card.commander.downtimeTurns)}
        sub={`turns without it on the table · removed ${card.commander.removals}× · tax paid ${card.commander.totalTaxPaid}`}
      />
      <Tile
        label="Answer rate"
        value={pct(card.answers.rate)}
        sub={`${card.answers.total.responded} answered, ${card.answers.total.resolved} resolved of ${terminal} events that ended`}
      />
      <Tile
        label="Threat output"
        value={String(damage)}
        sub={`damage dealt to the pod · ${killed} seat${killed === 1 ? '' : 's'} eliminated`}
      />
      <Tile
        label="Clock"
        value={
          !card.clock.faced ? 'none' : card.clock.beatClock ? 'beaten' : (CLOCK_WORD[card.clock.outcome ?? ''] ?? NO_VALUE)
        }
        sub={
          !card.clock.faced
            ? 'no seat ever threatened to win'
            : `spawned T${card.clock.spawnedTurn ?? '?'} · deadline T${card.clock.deadlineTurn ?? '?'}`
        }
      />
      <Tile
        label="Hate pieces"
        value={hazards.faced === 0 ? 'none' : `${hazards.faced} faced`}
        sub={
          hazards.faced === 0
            ? 'no seat cast a persistent piece this run'
            : hazards.stood === 0
              ? hateOpen === 0
                ? 'every one was answered on the stack'
                : `${hateAnswered === 0 ? 'none' : hateAnswered} answered on the stack · ${hateOpen} still open when the run ended`
              : `${hazards.stood} stood · ${turns(avgStanding)} on average · ${hazards.removed} removed · ${hazards.swept} swept${
                  hateOpen > 0 ? ` · ${hateOpen} open at the end` : ''
                }`
        }
      />
      <Tile
        label="Keep"
        value={`${card.keep.landsInKeptHand}/${card.keep.keptHandSize}`}
        sub={`lands in the kept hand · ${card.keep.mulligans} mulligan${card.keep.mulligans === 1 ? '' : 's'} · ${card.keep.landsInOpeningSeven} in the opening seven`}
      />
    </div>
  );
}

function EventLedger({ card }: { card: Scorecard }) {
  const rows = [...card.events].sort(
    (a, b) => a.turn - b.turn || a.eventId.localeCompare(b.eventId),
  );
  if (rows.length === 0) {
    return <p className="sc-empty">The pod never presented an event this run.</p>;
  }

  return (
    <div className="sc-table-wrap">
      <table className="sc-table">
        <thead>
          <tr>
            <th scope="col">T</th>
            <th scope="col">Seat</th>
            <th scope="col">Event</th>
            <th scope="col">Detail</th>
            <th scope="col">State</th>
            <th scope="col">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            /* The card text is printed under the card name rather than hidden
               in the row's tooltip: a tooltip is unreachable by keyboard and
               gone on touch, and the effect is the thing a run is meant to
               teach. It stays inside the event column, so the ledger is still
               six columns wide at 1024. */
            <tr key={row.eventId}>
              <td className="num">{row.turn}</td>
              <td className="num">{row.seatId}</td>
              <td>
                <span className={`sc-evt type-${row.type}`}>{row.type}</span>
                {row.card && <span className="sc-evt-card">{row.card}</span>}
                {row.cardEffect && <span className="sc-evt-effect">{row.cardEffect}</span>}
              </td>
              <td className="sc-cell-detail">{eventDetail(row)}</td>
              <td className={`sc-term is-${row.terminal}`}>{row.terminal}</td>
              <td className="sc-cell-detail">
                {eventOutcome(row)}
                {row.note && <em className="sc-note"> “{row.note}”</em>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Seats({ card }: { card: Scorecard }) {
  return (
    <div className="sc-seats">
      {card.seats.map((seat) => (
        <div key={seat.seatId} className={`sc-seat${seat.eliminatedTurn !== null ? ' is-dead' : ''}`}>
          <span className="sc-seat-name">
            SEAT {seat.seatId}
            {seat.profile && <span className="sc-dim"> · {seat.profile}</span>}
          </span>
          <span className="sc-seat-dmg num">{seat.damageDealt}</span>
          <span className="sc-seat-sub">damage dealt</span>
          <span className="sc-seat-sub">
            {seat.commanderDamageDealt > 0
              ? `${seat.commanderDamageDealt} commander damage`
              : 'no commander damage'}
          </span>
          {/* What the pod did to this seat while the player untapped. Printed
              only when it happened, and kept plainly apart from the damage
              above it, which is the player's. */}
          {seat.podDamageTaken > 0 && (
            <span className="sc-seat-sub">pod dmg taken {seat.podDamageTaken}</span>
          )}
          <span className="sc-seat-sub">
            {seat.eliminatedTurn === null
              ? 'survived'
              : `eliminated T${seat.eliminatedTurn} (${seat.eliminationReason === 'commander-damage' ? 'commander damage' : 'life'})`}
          </span>
        </div>
      ))}
    </div>
  );
}

function Profile({ cards, reviews }: { cards: Scorecard[]; reviews: Review[] }) {
  const profile = useMemo(() => aggregateProfile(cards), [cards]);
  // What the runs keep saying, as opposed to what they averaged. The figures
  // above are the deck's shape; this is the sentence that repeats.
  const patterns = useMemo(() => reviewPatterns(reviews), [reviews]);

  if (cards.length < 2) {
    return (
      <p className="sc-empty">
        Play more runs for a profile. One game is a story, not a tendency.
      </p>
    );
  }

  return (
    <>
      <dl className="sc-profile">
        <div>
          <dt>Runs</dt>
          <dd className="num">{profile.runs}</dd>
        </div>
        <div>
          <dt>Win rate</dt>
          <dd>
            <Figure value={pct(profile.winRate)} />{' '}
            <span className="sc-dim">({profile.wins}W {profile.losses}L)</span>
          </dd>
        </div>
        <div>
          <dt>Avg turns</dt>
          <dd>
            <Figure value={profile.avgTurns === null ? NO_VALUE : num(profile.avgTurns)} />
          </dd>
        </div>
        <div>
          <dt>Avg first cast</dt>
          <dd>
            <Figure
              value={
                profile.avgFirstCommanderCast === null
                  ? NO_VALUE
                  : `T${num(profile.avgFirstCommanderCast)}`
              }
            />
          </dd>
        </div>
        <div>
          <dt>Avg MV / turn</dt>
          <dd>
            <Figure
              value={profile.avgMvPerTurn === null ? NO_VALUE : num(profile.avgMvPerTurn)}
            />
          </dd>
        </div>
        <div>
          <dt>Wipes faced</dt>
          <dd className="num">{profile.wipesFaced}</dd>
        </div>
        <div>
          <dt>Avg rebuild</dt>
          <dd>
            <Figure value={turns(profile.avgTurnsToRecover)} />
          </dd>
        </div>
        <div>
          <dt>Never rebuilt</dt>
          <dd>
            <Figure value={pct(profile.unrecoveredWipeRate)} />
          </dd>
        </div>
        <div>
          <dt>Cmdr downtime</dt>
          <dd>
            <Figure value={turns(profile.avgCommanderDowntime)} />
          </dd>
        </div>
        <div>
          <dt>Answer rate</dt>
          <dd>
            <Figure value={pct(profile.answerRate)} />
          </dd>
        </div>
        <div>
          <dt>Clocks</dt>
          <dd className="num">
            {profile.clocksBeaten}/{profile.clocksFaced} beaten
          </dd>
        </div>
        <div>
          <dt>Hate faced</dt>
          <dd className="num">{profile.hateFaced}</dd>
        </div>
        <div>
          <dt>Hate removed</dt>
          <dd>
            <Figure value={pct(profile.hateRemovedRate)} />{' '}
            <span className="sc-dim">(of {profile.hateStood} stood)</span>
          </dd>
        </div>
        <div>
          <dt>Mulligan rate</dt>
          <dd>
            <Figure value={pct(profile.mulliganRate)} />
          </dd>
        </div>
      </dl>

      {profile.tags.length > 0 && (
        <div className="sc-tags">
          {profile.tags.map((tag) => (
            <span key={tag} className="sc-tag">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Nothing at all when no code recurs: "play more runs for a profile"
          already covers a history too short to have a tendency, and an empty
          heading would read as a deck with no problems rather than as a deck
          with too little evidence. */}
      {patterns.length > 0 && (
        <div className="sc-patterns">
          <h4 className="panel-heading">
            Patterns · {reviews.length} {reviews.length === 1 ? 'run' : 'runs'}
          </h4>
          <ul className="sc-review-list">
            {patterns.map((pattern) => (
              <li key={pattern.code} className={`sc-review-row is-${pattern.kind}`}>
                <span className="sc-review-kind">{KIND_WORD[pattern.kind]}</span>
                <span className="sc-review-body">
                  <span className="sc-review-title">
                    {pattern.title}{' '}
                    <span className="sc-dim num">
                      · {pattern.runs} of {pattern.of} runs
                    </span>
                  </span>
                  <span className="sc-review-detail">{pattern.sampleDetail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function CompareView({ a, b, onClose }: { a: Scorecard; b: Scorecard; onClose: () => void }) {
  const comparison = useMemo(() => compareScorecards(a, b), [a, b]);

  return (
    <section className="sc-section sc-compare">
      <div className="sc-section-head">
        <h3 className="panel-heading">Compare</h3>
        <button type="button" className="dk-btn-quiet" onClick={onClose}>
          Clear
        </button>
      </div>

      <p className={`sc-banner${comparison.sameSeed ? ' is-good' : ''}`}>
        {comparison.sameSeed
          ? 'Same seed. Same shuffle, same pressure schedule: the deck is the only variable.'
          : 'Different seeds. Pressure schedules differ, so these two runs were not asked the same questions.'}
      </p>
      {!comparison.sameBracket && (
        <p className="sc-banner is-warn">
          Different brackets (B{a.bracket} vs B{b.bracket}). The pod hit harder in one of these.
        </p>
      )}

      <div className="sc-table-wrap">
        <table className="sc-table">
          <thead>
            <tr>
              <th scope="col">Metric</th>
              {/* Seeds are user data — the header's small caps must not rewrite them. */}
              <th scope="col">
                A · <span className="sc-seed-inline num">{a.seed}</span>
              </th>
              <th scope="col">
                B · <span className="sc-seed-inline num">{b.seed}</span>
              </th>
              <th scope="col" title="B minus A">Δ</th>
            </tr>
          </thead>
          <tbody>
            {comparison.metrics.map((m) => {
              const better =
                m.delta === null || m.delta === 0
                  ? 'is-flat'
                  : m.delta > 0 === m.higherIsBetter
                    ? 'is-better'
                    : 'is-worse';
              return (
                <tr key={m.key}>
                  <td>{m.label}</td>
                  <td className={`num${m.a === null ? ' is-na' : ''}`}>
                    {m.a === null ? NO_VALUE : num(m.a, 2)}
                  </td>
                  <td className={`num${m.b === null ? ' is-na' : ''}`}>
                    {m.b === null ? NO_VALUE : num(m.b, 2)}
                  </td>
                  <td className={`num sc-delta ${m.delta === null ? 'is-na' : better}`}>
                    {m.delta === null ? NO_VALUE : `${m.delta > 0 ? '+' : ''}${num(m.delta, 2)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// --- the panel --------------------------------------------------------------

export default function ScorecardPanel() {
  const selectedRunId = useUiStore((s) => s.selectedRunId);
  const compareRunId = useUiStore((s) => s.compareRunId);
  const selectRun = useUiStore((s) => s.selectRun);
  const setCompare = useUiStore((s) => s.setCompare);

  // A lookup answering for a different run id than the one asked for is the
  // hook's stale previous value — still loading, not "deleted".
  const selectedLookup = useScorecard(selectedRunId);
  const comparedLookup = useScorecard(compareRunId);
  const selected =
    selectedLookup && selectedLookup.runId === selectedRunId ? selectedLookup.scored : undefined;
  const compared =
    comparedLookup && comparedLookup.runId === compareRunId ? comparedLookup.scored : undefined;
  const deckId = selected?.run.deckId ?? null;
  const deckRuns = useDeckScorecards(deckId);
  const deck = useLiveQuery(
    async (): Promise<Deck | null> => (deckId ? ((await getDeck(deckId)) ?? null) : null),
    [deckId],
  );

  const [copiedSeed, setCopiedSeed] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<'replay' | 'share' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [share, setShare] = useState<{ url: string; blob: Blob } | null>(null);

  // A new selection invalidates everything transient about the old one — App
  // keys this component by run id, so the remount does that resetting for us.

  // Object URLs outlive the component unless we say otherwise.
  useEffect(() => {
    if (!share) return;
    return () => URL.revokeObjectURL(share.url);
  }, [share]);

  // The run was deleted out from under us (from the rail, or another tab).
  // `selectRun` is read off the store rather than the hook binding: this is an
  // external-store update, not a local setState cascade.
  const missing = selectedRunId !== null && selected === null;
  const compareMissing = compareRunId !== null && compared === null;
  useEffect(() => {
    if (missing) useUiStore.getState().selectRun(null);
    else if (compareMissing) useUiStore.getState().setCompare(null);
  }, [missing, compareMissing]);

  if (!selectedRunId) return null;
  if (selected === undefined) {
    return (
      <section className="pg-table sc-root" aria-label="Scorecard">
        <p className="sc-empty">Scoring the run…</p>
      </section>
    );
  }
  if (selected === null) {
    return (
      <section className="pg-table sc-root" aria-label="Scorecard">
        <p className="sc-empty">That run is no longer stored. Pick another run from History.</p>
      </section>
    );
  }

  const { run, card } = selected;
  const result = card.result;
  const others = (deckRuns?.runs ?? []).filter((other) => other.id !== run.id);
  const sameSeedFirst = [...others].sort((x, y) => {
    const xs = x.seed === run.seed ? 0 : 1;
    const ys = y.seed === run.seed ? 0 : 1;
    return xs - ys || y.startedAt - x.startedAt;
  });

  function copySeed(): void {
    navigator.clipboard?.writeText(run.seed).then(
      () => {
        setCopiedSeed(true);
        setTimeout(() => setCopiedSeed(false), 1200);
      },
      () => undefined,
    );
  }

  async function handleReplay(): Promise<void> {
    if (!deck) return;
    setBusy('replay');
    setError(null);
    try {
      await startDeckRun(deck, run.seed);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not start the run. Check the deck and try again.',
      );
      setBusy(null);
    }
  }

  async function handleShare(): Promise<void> {
    setBusy('share');
    setError(null);
    try {
      const profile = deckRuns && deckRuns.cards.length > 0 ? aggregateProfile(deckRuns.cards) : undefined;
      const blob = await renderScorecardPng(card, { profile });
      setShare({ url: URL.createObjectURL(blob), blob });
    } catch (err) {
      setError(
        err instanceof Error
          ? `Could not render the share image. ${err.message}`
          : 'Could not render the share image.',
      );
    } finally {
      setBusy(null);
    }
  }

  async function copyImage(blob: Blob): Promise<void> {
    setError(null);
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    } catch (err) {
      setError(
        err instanceof Error ? `Could not copy the image. ${err.message}` : 'Could not copy the image.',
      );
    }
  }

  const canCopyImage =
    typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';

  const verdict = verdictOf(card);

  return (
    <section className="pg-table sc-root" aria-label="Scorecard">
      <header className="sc-header">
        <div className="sc-header-main">
          <h2 className="sc-deck">{card.deckName}</h2>
          <p className="sc-verdict">
            <span className={`sc-result ${result ? RESULT_CLASS[result] : 'is-abandoned'}`}>
              {result ? RESULT_WORD[result] : 'Unfinished'}
            </span>
            <span className="sc-facts num">
              turn {card.turns} · bracket {card.bracket}
            </span>
            <button
              type="button"
              className="sc-seed"
              title="Copy run seed"
              aria-label={
                copiedSeed ? `Run seed ${card.seed} copied` : `Copy run seed ${card.seed}`
              }
              onClick={copySeed}
            >
              {copiedSeed ? 'copied' : `seed ${card.seed}`}
            </button>
            <span className="sc-facts">
              {new Date(card.endedAt ?? card.startedAt).toLocaleString()}
            </span>
          </p>
        </div>

        <div className="sc-actions">
          <button
            type="button"
            className="dk-btn-primary"
            disabled={!deck || busy !== null}
            title={
              deck
                ? `Start a new run of ${card.deckName} on seed ${card.seed}`
                : 'This deck has been deleted, so the seed cannot be replayed'
            }
            onClick={() => void handleReplay()}
          >
            {busy === 'replay' ? 'Starting…' : 'Replay seed'}
          </button>
          <button
            type="button"
            disabled={others.length === 0}
            title={others.length === 0 ? 'No other runs of this deck yet' : undefined}
            onClick={() => setPicking((was) => !was)}
          >
            Compare…
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void handleShare()}>
            {busy === 'share' ? 'Rendering…' : 'Share image'}
          </button>
          <button type="button" className="dk-btn-quiet" onClick={() => selectRun(null)}>
            Close
          </button>
        </div>
      </header>

      {/* The finding, before the evidence for it. */}
      <p className="sc-verdict-line">
        <span className="panel-heading">Verdict</span>
        <span className={'sc-verdict-text' + (verdict.clear ? ' is-clear' : '')}>
          {verdict.text}
        </span>
      </p>

      {/* The verdict names one finding; this is the rest of them. */}
      <ReviewSection review={selected.review} partial={card.partial} />

      {card.partial && (
        <p className="sc-banner is-warn">
          Partial: this run was imported before card facts were stored, so board value is a lower
          bound.
        </p>
      )}
      {error && <p className="sc-banner is-error">{error}</p>}

      {share && (
        <p className="sc-banner is-good sc-share-row">
          <a href={share.url} download={`proving-grounds-${card.seed}.png`}>
            Download PNG
          </a>
          {canCopyImage && (
            <button type="button" className="dk-btn-quiet" onClick={() => void copyImage(share.blob)}>
              Copy to clipboard
            </button>
          )}
        </p>
      )}

      {picking && (
        <div className="sc-picker">
          <span className="sc-picker-head">Compare against</span>
          {sameSeedFirst.map((other) => (
            <button
              key={other.id}
              type="button"
              className={`sc-picker-item${other.id === compareRunId ? ' is-picked' : ''}`}
              onClick={() => {
                setCompare(other.id === compareRunId ? null : other.id);
                setPicking(false);
              }}
            >
              <span className="num">{other.result ?? 'unfinished'}</span>
              <span className="num sc-dim">{other.seed}</span>
              <span className="sc-dim">{new Date(other.startedAt).toLocaleDateString()}</span>
              {other.seed === run.seed && <span className="sc-hist-pair">same seed</span>}
            </button>
          ))}
        </div>
      )}

      {compared && <CompareView a={card} b={compared.card} onClose={() => setCompare(null)} />}

      <MetricTiles card={card} />

      <section className="sc-section">
        <h3 className="panel-heading">Turn by turn</h3>
        <TimelineChart card={card} />
      </section>

      <section className="sc-section">
        <h3 className="panel-heading">Event ledger</h3>
        <EventLedger card={card} />
      </section>

      <section className="sc-section">
        <h3 className="panel-heading">Seats</h3>
        <Seats card={card} />
      </section>

      <section className="sc-section">
        <h3 className="panel-heading">Deck profile</h3>
        {deckRuns ? (
          <Profile cards={deckRuns.cards} reviews={deckRuns.reviews} />
        ) : (
          <p className="sc-empty">Scoring…</p>
        )}
        <p className="sc-hint">Replay the seed after a deck edit to compare like for like.</p>
      </section>

      {/* The profile above is the deck's tendency; this is which card produced
          it, which is the view that gets a card cut. */}
      <CardStatsSection stats={deckRuns?.cardStats} />
    </section>
  );
}
