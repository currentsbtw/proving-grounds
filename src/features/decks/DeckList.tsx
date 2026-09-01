import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { deleteDeck, getCachedCardsByIds, listDecks } from '../../db/db';
import type { Deck } from '../../domain/types';

export interface DeckListProps {
  onImport: () => void;
  onEdit: (deck: Deck) => void;
  onStart: (deck: Deck, seed: string) => void;
  startingDeckId: string | null;
  busy: boolean;
  error: string | null;
}

function deckSize(deck: Deck): number {
  return deck.cards.reduce((sum, ref) => sum + ref.qty, 0) + deck.commanderIds.length;
}

export function DeckList({ onImport, onEdit, onStart, startingDeckId, busy, error }: DeckListProps) {
  const [seeds, setSeeds] = useState<Record<string, string>>({});
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const data = useLiveQuery(async () => {
    const decks = await listDecks();
    const ids = [...new Set(decks.flatMap((d) => d.commanderIds))];
    const cards = await getCachedCardsByIds(ids);
    const names: Record<string, string> = {};
    for (const card of cards) names[card.scryfallId] = card.name;
    return { decks, names };
  }, []);

  return (
    <div className="dk-stack">
      <div className="dk-head">
        <h2 className="panel-heading">Decks</h2>
        <button type="button" className="dk-btn-quiet" onClick={onImport}>
          + Import deck
        </button>
      </div>

      {error && <p className="dk-error">{error}</p>}

      {!data && <p className="dk-empty">Loading decks…</p>}
      {data && data.decks.length === 0 && (
        <p className="dk-empty">No decks yet. Import a plain-text decklist to get started.</p>
      )}

      {data?.decks.map((deck) => {
        const commanders = deck.commanderIds.map((id) => data.names[id] ?? 'Unknown commander');
        const starting = startingDeckId === deck.id;
        return (
          <article className="dk-deck" key={deck.id}>
            <div className="dk-deck-title">
              <span className="dk-deck-name">{deck.name}</span>
              <span className="dk-bracket">B{deck.bracket}</span>
            </div>
            <div className="dk-deck-meta">
              {commanders.length > 0 ? commanders.join(' + ') : 'No commander'}
              {' · '}
              <span className="num">{deckSize(deck)}</span> cards
            </div>

            <div className="dk-deck-actions">
              <button
                type="button"
                className="dk-btn-primary"
                disabled={busy}
                onClick={() => onStart(deck, seeds[deck.id] ?? '')}
              >
                {starting ? 'Starting…' : 'Start Run'}
              </button>
              <input
                className="dk-seed"
                type="text"
                aria-label={`Seed for ${deck.name}`}
                placeholder="random"
                value={seeds[deck.id] ?? ''}
                onChange={(e) => setSeeds((prev) => ({ ...prev, [deck.id]: e.target.value }))}
              />
            </div>

            <div className="dk-deck-secondary">
              {confirmId === deck.id ? (
                <>
                  <span className="dk-deck-meta dk-grow">Delete this deck?</span>
                  <button
                    type="button"
                    className="dk-btn-quiet dk-btn-danger"
                    onClick={() => {
                      setConfirmId(null);
                      void deleteDeck(deck.id);
                    }}
                  >
                    Delete
                  </button>
                  <button type="button" className="dk-btn-quiet" onClick={() => setConfirmId(null)}>
                    Keep
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="dk-btn-quiet" onClick={() => onEdit(deck)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="dk-btn-quiet dk-btn-danger"
                    onClick={() => setConfirmId(deck.id)}
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
