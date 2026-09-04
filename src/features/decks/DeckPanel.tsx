import { useState } from 'react';
import type { Deck } from '../../domain/types';
import { useUiStore } from '../../state/uiStore';
import { DeckList } from './DeckList';
import { DeckImport } from './DeckImport';
import RunHistory from './RunHistory';
import { resolveDeckCards, startDeckRun } from './startDeckRun';
import './decks.css';

type View = { kind: 'list' } | { kind: 'import'; deck?: Deck };

export default function DeckPanel() {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [startingDeckId, setStartingDeckId] = useState<string | null>(null);
  const [drillingDeckId, setDrillingDeckId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openDrill = useUiStore((s) => s.openDrill);

  async function handleStart(deck: Deck, seed: string, shotClockSeconds: number | null) {
    setError(null);
    setStartingDeckId(deck.id);
    try {
      await startDeckRun(deck, seed, { shotClockSeconds });
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

  /**
   * Resolve first, open second. The drill deals its own hands from the same
   * cache, but a deck with cards it cannot reach has to say so here, in the rail
   * the player clicked in, rather than as an empty panel in the middle.
   */
  async function handleDrill(deck: Deck, seed: string) {
    setError(null);
    setDrillingDeckId(deck.id);
    try {
      await resolveDeckCards(deck);
      openDrill({ deckId: deck.id, seed: seed.trim() });
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Could not deal from this deck. Check it and try again.',
      );
    } finally {
      setDrillingDeckId(null);
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
            onStart={(deck, seed, shotClockSeconds) =>
              void handleStart(deck, seed, shotClockSeconds)
            }
            onDrill={(deck, seed) => void handleDrill(deck, seed)}
            startingDeckId={startingDeckId}
            drillingDeckId={drillingDeckId}
            busy={startingDeckId !== null || drillingDeckId !== null}
            error={error}
          />
          {startingDeckId && <p className="dk-busy">Preparing library</p>}
          <RunHistory />
        </>
      )}
    </section>
  );
}
