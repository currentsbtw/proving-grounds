import { useState } from 'react';
import type { Deck } from '../../domain/types';
import { DeckList } from './DeckList';
import { DeckImport } from './DeckImport';
import RunHistory from './RunHistory';
import { startDeckRun } from './startDeckRun';
import './decks.css';

type View = { kind: 'list' } | { kind: 'import'; deck?: Deck };

export default function DeckPanel() {
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
      setError(
        err instanceof Error ? err.message : 'Could not start the run. Check the deck and try again.',
      );
    } finally {
      setStartingDeckId(null);
    }
  }

  return (
    <section className="pg-rail" aria-label="Decks">
      {view.kind === 'import' ? (
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
