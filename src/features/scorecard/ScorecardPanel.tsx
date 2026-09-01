import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getDeck } from '../../db/db';
import { aggregateProfile, compareScorecards } from '../../engine/scorecard';
import type { EventLedgerRow, Scorecard } from '../../engine/scorecard';
import type { Deck, RunResult } from '../../domain/types';
import { useUiStore } from '../../state/uiStore';
import TimelineChart from './TimelineChart';
import { useDeckScorecards, useScorecard } from './useScorecards';
import { renderScorecardPng } from './shareImage';
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

const CLOCK_WORD: Record<string, string> = {
  won: 'won first',
  'eliminated-seat': 'killed the seat',
  'declared-interaction': 'held interaction',
  expired: 'ran out',
  standing: 'still standing',
};

// --- formatting -------------------------------------------------------------

function num(value: number, digits = 1): string {
  const rounded = Number(value.toFixed(digits));
  return String(rounded);
}

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

/** "—", "1 turn", "2.5 turns". Averages are rounded before the noun is chosen. */
function turns(value: number | null): string {
  if (value === null) return '—';
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
      return `${row.variant ?? 'creatures'} · pod ${s.podCreatures ?? 0} creatures, ${s.podPower ?? 0} power`;
    case 'removal':
      return `target MV ${s.targetMv ?? 0}${s.commander ? ' · your commander' : ''}`;
    case 'counter':
      return `holds up ${s.threshold ?? 0}+ · your spell MV ${s.manaValue ?? 0}${s.commander ? ' · commander' : ''}`;
    case 'combat': {
      const attackers = s.attackers ?? 0;
      return `${attackers} attacker${attackers === 1 ? '' : 's'} for ${s.damage ?? 0}`;
    }
    case 'clock':
      return `deadline turn ${s.deadlineTurn ?? '?'}`;
    case 'resource':
      return row.variant ?? 'tax';
    default:
      return row.variant ?? '';
  }
}

/** What the table looked like afterwards, in a handful of words. */
function eventOutcome(row: EventLedgerRow): string {
  if (row.terminal === 'responded') return 'answered on the table';
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
      <span className="sc-tile-value num">{value}</span>
      <span className="sc-tile-sub">{sub}</span>
    </div>
  );
}

function MetricTiles({ card }: { card: Scorecard }) {
  const landed = card.wipes.filter((w) => !w.negated);
  const first = landed[0];
  const wipeValue = !first
    ? card.wipes.length > 0
      ? 'answered'
      : 'none'
    : first.turnsToRecover === null
      ? 'never'
      : String(first.turnsToRecover);
  const wipeSub = !first
    ? card.wipes.length > 0
      ? 'every wrath was answered on the table'
      : 'no wrath was cast this run'
    : 'turns to return to 70% of the pre-wipe board';

  const damage = card.seats.reduce((sum, seat) => sum + seat.damageDealt, 0);
  const killed = card.seats.filter((seat) => seat.eliminatedTurn !== null).length;
  const terminal = card.answers.total.responded + card.answers.total.resolved;

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
        sub={`${card.answers.total.responded} answered, ${card.answers.total.resolved} resolved of ${terminal} terminal events`}
      />
      <Tile
        label="Threat output"
        value={String(damage)}
        sub={`damage dealt to the pod · ${killed} seat${killed === 1 ? '' : 's'} eliminated`}
      />
      <Tile
        label="Clock"
        value={
          !card.clock.faced ? 'none' : card.clock.beatClock ? 'beaten' : (CLOCK_WORD[card.clock.outcome ?? ''] ?? '—')
        }
        sub={
          !card.clock.faced
            ? 'no seat ever threatened to win'
            : `spawned T${card.clock.spawnedTurn ?? '?'} · deadline T${card.clock.deadlineTurn ?? '?'}`
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
            <th scope="col">What it was</th>
            <th scope="col">State</th>
            <th scope="col">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.eventId}>
              <td className="num">{row.turn}</td>
              <td className="num">{row.seatId}</td>
              <td>
                <span className={`sc-evt type-${row.type}`}>{row.type}</span>
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
          <span className="sc-seat-name">SEAT {seat.seatId}</span>
          <span className="sc-seat-dmg num">{seat.damageDealt}</span>
          <span className="sc-seat-sub">damage dealt</span>
          <span className="sc-seat-sub">
            {seat.commanderDamageDealt > 0
              ? `${seat.commanderDamageDealt} commander damage`
              : 'no commander damage'}
          </span>
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

function Profile({ cards }: { cards: Scorecard[] }) {
  const profile = useMemo(() => aggregateProfile(cards), [cards]);

  if (cards.length < 2) {
    return (
      <p className="sc-empty">
        Play more runs for a profile — one game is a story, not a tendency.
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
          <dd className="num">
            {pct(profile.winRate)} <span className="sc-dim">({profile.wins}W {profile.losses}L)</span>
          </dd>
        </div>
        <div>
          <dt>Avg turns</dt>
          <dd className="num">{profile.avgTurns === null ? '—' : num(profile.avgTurns)}</dd>
        </div>
        <div>
          <dt>Avg first cast</dt>
          <dd className="num">
            {profile.avgFirstCommanderCast === null ? '—' : `T${num(profile.avgFirstCommanderCast)}`}
          </dd>
        </div>
        <div>
          <dt>Avg MV / turn</dt>
          <dd className="num">{profile.avgMvPerTurn === null ? '—' : num(profile.avgMvPerTurn)}</dd>
        </div>
        <div>
          <dt>Wipes faced</dt>
          <dd className="num">{profile.wipesFaced}</dd>
        </div>
        <div>
          <dt>Avg rebuild</dt>
          <dd className="num">{turns(profile.avgTurnsToRecover)}</dd>
        </div>
        <div>
          <dt>Never rebuilt</dt>
          <dd className="num">{pct(profile.unrecoveredWipeRate)}</dd>
        </div>
        <div>
          <dt>Cmdr downtime</dt>
          <dd className="num">{turns(profile.avgCommanderDowntime)}</dd>
        </div>
        <div>
          <dt>Answer rate</dt>
          <dd className="num">{pct(profile.answerRate)}</dd>
        </div>
        <div>
          <dt>Clocks</dt>
          <dd className="num">
            {profile.clocksBeaten}/{profile.clocksFaced} beaten
          </dd>
        </div>
        <div>
          <dt>Mulligan rate</dt>
          <dd className="num">{pct(profile.mulliganRate)}</dd>
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
          ? 'Same seed — like-for-like. Same shuffle, same pressure schedule; the deck is the only variable.'
          : 'Different seeds — pressure schedules differ, so these two runs were not asked the same questions.'}
      </p>
      {!comparison.sameBracket && (
        <p className="sc-banner is-warn">
          Different brackets (B{a.bracket} vs B{b.bracket}) — the pod hit harder in one of these.
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
              <th scope="col">Δ</th>
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
                  <td className="num">{m.a === null ? '—' : num(m.a, 2)}</td>
                  <td className="num">{m.b === null ? '—' : num(m.b, 2)}</td>
                  <td className={`num sc-delta ${better}`}>
                    {m.delta === null ? '—' : `${m.delta > 0 ? '+' : ''}${num(m.delta, 2)}`}
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

  const selected = useScorecard(selectedRunId);
  const compared = useScorecard(compareRunId);
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
        <p className="sc-empty">That run is no longer stored.</p>
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
      setError(err instanceof Error ? err.message : 'Could not start the run');
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
        err instanceof Error ? `Share image — ${err.message}` : 'Could not render the share image',
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
      setError(err instanceof Error ? `Copy — ${err.message}` : 'Could not copy the image');
    }
  }

  const canCopyImage =
    typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';

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
                : 'This deck has been deleted — the seed cannot be replayed'
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

      {card.partial && (
        <p className="sc-banner is-warn">
          Partial — this run was imported before card facts were stored, so board value is a
          lower bound.
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
        <div className="sc-section-head">
          <h3 className="panel-heading">Turn by turn</h3>
        </div>
        <TimelineChart card={card} />
      </section>

      <section className="sc-section">
        <div className="sc-section-head">
          <h3 className="panel-heading">Event ledger</h3>
        </div>
        <EventLedger card={card} />
      </section>

      <section className="sc-section">
        <div className="sc-section-head">
          <h3 className="panel-heading">Seats</h3>
        </div>
        <Seats card={card} />
      </section>

      <section className="sc-section">
        <div className="sc-section-head">
          <h3 className="panel-heading">Deck profile</h3>
        </div>
        {deckRuns ? <Profile cards={deckRuns.cards} /> : <p className="sc-empty">Scoring…</p>}
        <p className="sc-hint">Replay the seed after a deck edit to compare like for like.</p>
      </section>
    </section>
  );
}
