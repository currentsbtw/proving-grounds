import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { deleteRun, listDecks, listRuns } from '../../db/db';
import { useUiStore } from '../../state/uiStore';
import type { RunRecord, RunResult } from '../../domain/types';
import '../scorecard/scorecard.css';

const RESULT_CLASS: Record<RunResult, string> = {
  win: 'is-win',
  loss: 'is-loss',
  concede: 'is-concede',
  abandoned: 'is-abandoned',
};

const RESULT_LABEL: Record<RunResult, string> = {
  win: 'WIN',
  loss: 'LOSS',
  concede: 'CONC',
  abandoned: 'ABND',
};

/**
 * Last turn the run reached. Cheap enough to run over every row in the rail —
 * the scoring engine derives the same number, but scoring a whole deck's logs to
 * label a list would be gratuitous.
 */
function runTurns(run: RunRecord): number {
  let turns = 1;
  for (const entry of run.log) {
    if (entry.turn > turns) turns = entry.turn;
    if (entry.kind === 'run' && typeof entry.payload.turns === 'number') {
      turns = entry.payload.turns;
    }
  }
  return turns;
}

function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(at).toLocaleDateString();
}

function DeckRuns({ deckId, deckName }: { deckId: string; deckName: string }) {
  const selectedRunId = useUiStore((s) => s.selectedRunId);
  const selectRun = useUiStore((s) => s.selectRun);
  const [expanded, setExpanded] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const runs = useLiveQuery(() => listRuns(deckId), [deckId]);
  if (!runs || runs.length === 0) return null;

  const selected = runs.find((run) => run.id === selectedRunId);
  // The deck holding the selected run opens itself, so ending a game reveals the
  // row the centre panel just started showing.
  const open = expanded || selected !== undefined;

  return (
    <div className="sc-hist-deck">
      <button
        type="button"
        className="sc-hist-toggle"
        aria-expanded={open}
        onClick={() => setExpanded((was) => !was)}
      >
        <span className="sc-hist-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="sc-hist-deck-name">{deckName}</span>
        <span className="sc-hist-count num">Runs ({runs.length})</span>
      </button>

      {open && (
        <ul className="sc-hist-list">
          {runs.map((run) => {
            const result = run.result ?? 'abandoned';
            const isSelected = run.id === selectedRunId;
            const sameSeed =
              selected !== undefined && !isSelected && selected.seed === run.seed;
            return (
              <li key={run.id}>
                <div className={`sc-hist-row${isSelected ? ' is-selected' : ''}`}>
                  <button
                    type="button"
                    className="sc-hist-open"
                    aria-current={isSelected ? 'true' : undefined}
                    onClick={() => selectRun(isSelected ? null : run.id)}
                  >
                    <span className={`sc-chip ${RESULT_CLASS[result]}`}>
                      {run.result ? RESULT_LABEL[result] : '—'}
                    </span>
                    <span className="sc-hist-turns num">T{runTurns(run)}</span>
                    <span className="sc-hist-bracket num">B{run.bracket}</span>
                    <span className="sc-hist-seed num" title={`Seed ${run.seed}`}>
                      {run.seed}
                    </span>
                    <span className="sc-hist-when">{relativeTime(run.startedAt)}</span>
                    {sameSeed && (
                      <span className="sc-hist-pair" title="Same seed as the selected run">
                        same seed
                      </span>
                    )}
                  </button>

                  {confirmId === run.id ? (
                    <span className="sc-hist-confirm">
                      <button
                        type="button"
                        className="dk-btn-quiet dk-btn-danger"
                        onClick={() => {
                          setConfirmId(null);
                          if (isSelected) selectRun(null);
                          void deleteRun(run.id);
                        }}
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        className="dk-btn-quiet"
                        onClick={() => setConfirmId(null)}
                      >
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="sc-hist-x"
                      aria-label={`Delete run ${run.seed}`}
                      title="Delete this run"
                      onClick={() => setConfirmId(run.id)}
                    >
                      ×
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Left-rail run history: one collapsible section per deck, newest run first. */
export default function RunHistory() {
  const decks = useLiveQuery(() => listDecks(), []);
  if (!decks || decks.length === 0) return null;

  return (
    <section className="sc-hist" aria-label="Run history">
      <h2 className="panel-heading sc-hist-head">History</h2>
      {decks.map((deck) => (
        <DeckRuns key={deck.id} deckId={deck.id} deckName={deck.name} />
      ))}
    </section>
  );
}
