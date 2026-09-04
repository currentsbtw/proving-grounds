import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { deleteDeck, getCachedCardsByIds, getSetting, listDecks, setSetting } from '../../db/db';
import type { Deck } from '../../domain/types';

/**
 * The key the last shot-clock choice is remembered under. One setting for the
 * rail rather than one per deck: it is how the player wants to practise today,
 * not a property of a list.
 */
const SHOT_CLOCK_KEY = 'shotClockSeconds';

/** Off, then the three lengths a Commander turn is worth timing against. */
const SHOT_CLOCKS: { value: number | null; label: string }[] = [
  { value: null, label: 'no clock' },
  { value: 60, label: '60 s' },
  { value: 90, label: '90 s' },
  { value: 120, label: '120 s' },
];

export interface DeckListProps {
  onImport: () => void;
  onEdit: (deck: Deck) => void;
  onStart: (deck: Deck, seed: string, shotClockSeconds: number | null) => void;
  onDrill: (deck: Deck, seed: string) => void;
  startingDeckId: string | null;
  drillingDeckId: string | null;
  busy: boolean;
  error: string | null;
}

function deckSize(deck: Deck): number {
  return deck.cards.reduce((sum, ref) => sum + ref.qty, 0) + deck.commanderIds.length;
}

export function DeckList({
  onImport,
  onEdit,
  onStart,
  onDrill,
  startingDeckId,
  drillingDeckId,
  busy,
  error,
}: DeckListProps) {
  const [seeds, setSeeds] = useState<Record<string, string>>({});
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [shotClock, setShotClock] = useState<number | null>(null);

  // The remembered choice arrives after the first paint, so the select opens on
  // "no clock" and corrects itself. Storage being refused is not worth a
  // message: the rail simply does not remember between sessions.
  useEffect(() => {
    let live = true;
    void getSetting<number | null>(SHOT_CLOCK_KEY)
      .then((stored) => {
        if (live && typeof stored === 'number') setShotClock(stored);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  function chooseShotClock(seconds: number | null): void {
    setShotClock(seconds);
    void setSetting(SHOT_CLOCK_KEY, seconds).catch(() => {});
  }

  const data = useLiveQuery(async () => {
    const decks = await listDecks();
    const ids = [...new Set(decks.flatMap((d) => d.commanderIds))];
    const cards = await getCachedCardsByIds(ids);
    const names: Record<string, string> = {};
    for (const card of cards) names[card.scryfallId] = card.name;
    return { decks, names };
  }, []);

  // A browser with storage switched off (a private window does this) leaves the
  // live query with nothing to attach to: it never calls the querier and never
  // errors, so the rail printed "Loading decks…" for the rest of the session.
  // One direct read settles the question and the rail says what is wrong.
  const [storageBlocked, setStorageBlocked] = useState(false);
  useEffect(() => {
    let live = true;
    void listDecks().catch(() => {
      if (live) setStorageBlocked(true);
    });
    return () => {
      live = false;
    };
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

      {storageBlocked && (
        <p className="dk-error">
          This browser is not letting the app store anything, so decks and runs cannot be
          saved here. A normal window, or one with site data allowed, will work.
        </p>
      )}
      {!data && !storageBlocked && <p className="dk-empty">Loading decks…</p>}
      {data && !storageBlocked && data.decks.length === 0 && (
        <p className="dk-empty">
          No decks yet. Import a plain-text decklist from Moxfield, Archidekt or MTGO.
        </p>
      )}

      {data?.decks.map((deck) => {
        const commanders = deck.commanderIds.map((id) => data.names[id] ?? 'Unknown commander');
        const starting = startingDeckId === deck.id;
        const drilling = drillingDeckId === deck.id;
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
                onClick={() => onStart(deck, seeds[deck.id] ?? '', shotClock)}
              >
                {starting ? 'Starting…' : 'Start run'}
              </button>
              <input
                className="dk-seed"
                type="text"
                aria-label={`Seed for ${deck.name}`}
                placeholder="random"
                value={seeds[deck.id] ?? ''}
                onChange={(e) => setSeeds((prev) => ({ ...prev, [deck.id]: e.target.value }))}
              />
              {/* The clock is a way to practise, not part of the seed, so it is
                  one choice for the rail and every row shows the same one. */}
              <select
                className="dk-select dk-clock"
                aria-label={`Shot clock for ${deck.name}`}
                value={shotClock === null ? 'off' : String(shotClock)}
                onChange={(e) =>
                  chooseShotClock(e.target.value === 'off' ? null : Number(e.target.value))
                }
              >
                {SHOT_CLOCKS.map((option) => (
                  <option
                    key={option.label}
                    value={option.value === null ? 'off' : String(option.value)}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
              {/* Opening hands with no run behind them: the seed field above is
                  the drill's starting seed too, so a hand worth keeping can be
                  started for real without retyping anything. */}
              <button
                type="button"
                className="dk-btn-quiet"
                disabled={busy}
                title="Deal opening hands off this seed and practise the keep/mull call"
                onClick={() => onDrill(deck, seeds[deck.id] ?? '')}
              >
                {drilling ? 'Dealing…' : 'Drill hands'}
              </button>
            </div>

            <div className="dk-deck-secondary">
              {confirmId === deck.id ? (
                <>
                  <span className="dk-deck-meta dk-grow">
                    Delete this deck? Its runs stay, but you cannot replay them.
                  </span>
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
