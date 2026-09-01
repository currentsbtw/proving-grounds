import { useState } from 'react';
import { useGameStore } from '../../state/gameStore';
import { resolveCardsByIds } from '../../services/scryfall';
import type { CardData, Deck } from '../../domain/types';
import { DeckList } from './DeckList';
import { DeckImport } from './DeckImport';
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
  const startRun = useGameStore((s) => s.startRun);

  const [view, setView] = useState<View>({ kind: 'list' });
  const [startingDeckId, setStartingDeckId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleStart(deck: Deck, seed: string) {
    setError(null);
    setStartingDeckId(deck.id);
    try {
      const ids = [...deck.commanderIds, ...deck.cards.map((c) => c.scryfallId)];
      const { found, notFound } = await resolveCardsByIds(ids);
      if (notFound.length > 0) {
        setError(
          `Could not resolve ${notFound.length} card${notFound.length === 1 ? '' : 's'} for this deck. Reimport it or check your connection.`,
        );
        return;
      }
      const record: Record<string, CardData> = {};
      for (const card of found) record[card.scryfallId] = card;
      startRun(deck, record, seed.trim() || undefined);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? `Could not start the run — ${err.message}` : 'Could not start the run',
      );
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
        </>
      )}
    </section>
  );
}
