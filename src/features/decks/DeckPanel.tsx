import { useState } from 'react';
import { useGameStore } from '../../state/gameStore';
import type { Deck } from '../../domain/types';
import { DeckList } from './DeckList';
import { DeckImport } from './DeckImport';
import RunHistory from './RunHistory';
import { startDeckRun } from './startDeckRun';
import './decks.css';

type View = { kind: 'list' } | { kind: 'import'; deck?: Deck };

/** Read-only run facts. Ending the run lives in the HUD, not here. */
function ActiveRun() {
  const run = useGameStore((s) => s.run);
  const turn = useGameStore((s) => s.turn);
  const phase = useGameStore((s) => s.phase);

  if (!run) return null;

  return (
    <div>
      <h2 className="panel-heading">Run in progress</h2>
      <p className="dk-run-name">{run.deckName}</p>
      <dl className="dk-run-facts">
        <dt>Seed</dt>
        <dd className="num">{run.seed}</dd>
        <dt>Turn</dt>
        <dd className="num">
          {turn} · {phase}
        </dd>
        <dt>Bracket</dt>
        <dd className="num">{run.bracket}</dd>
      </dl>
      <p className="muted">End the run from the HUD.</p>
    </div>
  );
}

export default function DeckPanel() {
  const run = useGameStore((s) => s.run);

  const [view, setView] = useState<View>({ kind: 'list' });
  const [startingDeckId, setStartingDeckId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleStart(deck: Deck, seed: string) {
    setError(null);
    setStartingDeckId(deck.id);
    try {
      await startDeckRun(deck, seed);
    } catch (err: unknown) {
      // `startDeckRun` already phrases the resolve failure for the reader; only a
      // surprise (a thrown non-Error) needs the generic wording.
      setError(err instanceof Error ? err.message : 'Could not start the run');
    } finally {
      setStartingDeckId(null);
    }
  }

  return (
    <section className="pg-rail" aria-label="Decks">
      {run ? (
        <ActiveRun />
      ) : view.kind === 'import' ? (
        <DeckImport
          initialDeck={view.deck}
          onSaved={() => setView({ kind: 'list' })}
          onCancel={() => setView({ kind: 'list' })}
        />
      ) : (
        <>
          <DeckList
            onImport={() => setView({ kind: 'import' })}
            onEdit={(deck) => setView({ kind: 'import', deck })}
            onStart={(deck, seed) => void handleStart(deck, seed)}
            startingDeckId={startingDeckId}
            busy={startingDeckId !== null}
            error={error}
          />
          {startingDeckId && <p className="dk-busy">Preparing library</p>}
          <RunHistory />
        </>
      )}
    </section>
  );
}
