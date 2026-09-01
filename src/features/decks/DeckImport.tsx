import { useEffect, useMemo, useState } from 'react';
import { nanoid } from 'nanoid';
import { saveDeck } from '../../db/db';
import { parseDecklist } from '../../services/deckParser';
import type { ParsedEntry } from '../../services/deckParser';
import { indexByName, nameKey, resolveCards, resolveCardsByIds } from '../../services/scryfall';
import type { CardData, Deck, DeckCardRef } from '../../domain/types';
import { CommanderPicker } from './CommanderPicker';

const BRACKETS: Deck['bracket'][] = [1, 2, 3, 4, 5];
const DECK_SIZE = 100;

interface ResolvedRow {
  entry: ParsedEntry;
  card: CardData;
}

interface Review {
  rows: ResolvedRow[];
  notFound: string[];
  parseWarnings: string[];
}

export interface DeckImportProps {
  /** When present the import edits/reimports this deck in place. */
  initialDeck?: Deck;
  onSaved: () => void;
  onCancel: () => void;
}

/** Rebuilds a pasteable decklist from a saved deck so it can be edited. */
async function decklistText(deck: Deck): Promise<string> {
  const ids = [...deck.commanderIds, ...deck.cards.map((c) => c.scryfallId)];
  const { found } = await resolveCardsByIds(ids);
  const byId = new Map(found.map((c) => [c.scryfallId, c]));
  const lines: string[] = [];

  if (deck.commanderIds.length > 0) {
    lines.push('Commander');
    for (const id of deck.commanderIds) lines.push(`1 ${byId.get(id)?.name ?? id}`);
    lines.push('');
  }
  lines.push('Deck');
  for (const ref of deck.cards) lines.push(`${ref.qty} ${byId.get(ref.scryfallId)?.name ?? ref.scryfallId}`);

  return lines.join('\n');
}

export function DeckImport({ initialDeck, onSaved, onCancel }: DeckImportProps) {
  const [name, setName] = useState(initialDeck?.name ?? '');
  const [bracket, setBracket] = useState<Deck['bracket']>(initialDeck?.bracket ?? 3);
  const [text, setText] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [commanderIds, setCommanderIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(initialDeck ? 'Loading deck' : null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!initialDeck) return;
    let cancelled = false;
    decklistText(initialDeck)
      .then((body) => {
        if (cancelled) return;
        setText(body);
        setCommanderIds(initialDeck.commanderIds);
        setBusy(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load this deck');
        setBusy(null);
      });
    return () => {
      cancelled = true;
    };
  }, [initialDeck]);

  const totals = useMemo(() => {
    if (!review) return { main: 0, total: 0 };
    let main = 0;
    for (const row of review.rows) {
      if (commanderIds.includes(row.card.scryfallId)) continue;
      main += row.entry.qty;
    }
    return { main, total: main + commanderIds.length };
  }, [review, commanderIds]);

  async function handleResolve() {
    setError(null);
    const parsed = parseDecklist(text);
    if (parsed.entries.length === 0) {
      setError('Nothing to import — paste a decklist first.');
      return;
    }

    setBusy(`Resolving ${parsed.entries.length} cards`);
    try {
      const { found } = await resolveCards(parsed.entries.map((e) => e.name));
      const index = indexByName(found);

      const rows: ResolvedRow[] = [];
      const notFound: string[] = [];
      for (const entry of parsed.entries) {
        const card = index.get(nameKey(entry.name));
        if (card) rows.push({ entry, card });
        else notFound.push(entry.name);
      }

      const marked: string[] = [];
      for (const row of rows) {
        if (row.entry.isCommander && !marked.includes(row.card.scryfallId) && marked.length < 2) {
          marked.push(row.card.scryfallId);
        }
      }

      setReview({ rows, notFound, parseWarnings: parsed.warnings });
      setCommanderIds((prev) => {
        const valid = prev.filter((id) => rows.some((r) => r.card.scryfallId === id));
        return marked.length > 0 ? marked : valid;
      });
      if (!name.trim() && marked.length > 0) {
        const lead = rows.find((r) => r.card.scryfallId === marked[0]);
        if (lead) setName(lead.card.name);
      }
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? `Could not reach Scryfall — ${err.message}`
          : 'Could not reach Scryfall',
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleSave() {
    if (!review) return;
    setError(null);
    setBusy('Saving deck');
    try {
      const byId = new Map<string, DeckCardRef>();
      for (const row of review.rows) {
        const id = row.card.scryfallId;
        if (commanderIds.includes(id)) continue;
        const existing = byId.get(id);
        if (existing) existing.qty += row.entry.qty;
        else byId.set(id, { scryfallId: id, qty: row.entry.qty });
      }

      const now = Date.now();
      const deck: Deck = {
        id: initialDeck?.id ?? nanoid(12),
        name: name.trim() || 'Untitled deck',
        commanderIds,
        cards: [...byId.values()],
        bracket,
        createdAt: initialDeck?.createdAt ?? now,
        updatedAt: now,
      };
      await saveDeck(deck);
      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? `Could not save deck — ${err.message}` : 'Could not save deck');
      setBusy(null);
    }
  }

  const commanderOptions = review ? review.rows.map((r) => r.card) : [];

  return (
    <div className="dk-stack">
      <div className="dk-head">
        <h2 className="panel-heading">{initialDeck ? 'Edit deck' : 'Import deck'}</h2>
        <button type="button" className="dk-btn-quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>

      <label className="dk-field">
        <span className="dk-label">Deck name</span>
        <input
          className="dk-input"
          type="text"
          value={name}
          placeholder="e.g. Atraxa Superfriends"
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <label className="dk-field">
        <span className="dk-label">Bracket</span>
        <select
          className="dk-select"
          value={bracket}
          onChange={(e) => setBracket(Number(e.target.value) as Deck['bracket'])}
        >
          {BRACKETS.map((b) => (
            <option key={b} value={b}>
              Bracket {b}
            </option>
          ))}
        </select>
      </label>

      {!review && (
        <>
          <label className="dk-field">
            <span className="dk-label">Decklist</span>
            <textarea
              className="dk-textarea"
              value={text}
              spellCheck={false}
              placeholder={'Commander\n1 Atraxa, Praetors’ Voice\n\nDeck\n1 Sol Ring\n1 Arcane Signet\n…'}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <div className="dk-row">
            <button
              type="button"
              className="dk-btn-primary dk-grow"
              disabled={Boolean(busy) || text.trim().length === 0}
              onClick={() => void handleResolve()}
            >
              Resolve list
            </button>
          </div>
        </>
      )}

      {review && (
        <>
          <CommanderPicker
            options={commanderOptions}
            selectedIds={commanderIds}
            onChange={setCommanderIds}
          />

          <div className="dk-deck-meta">
            <span className="num">{totals.main}</span> maindeck +{' '}
            <span className="num">{commanderIds.length}</span> commander
            {commanderIds.length === 1 ? '' : 's'} ={' '}
            <span className="num">{totals.total}</span> cards
          </div>

          {totals.total !== DECK_SIZE && (
            <p className="dk-warn">
              That is {totals.total} cards, not {DECK_SIZE}. You can still save it.
            </p>
          )}

          {review.notFound.length > 0 && (
            <div className="dk-warn">
              <div>{review.notFound.length} card names were not found on Scryfall:</div>
              <ul className="dk-warn-list">
                {review.notFound.slice(0, 12).map((n) => (
                  <li key={n}>{n}</li>
                ))}
                {review.notFound.length > 12 && <li>+{review.notFound.length - 12} more</li>}
              </ul>
            </div>
          )}

          {review.parseWarnings.length > 0 && (
            <div className="dk-warn">
              <ul className="dk-warn-list">
                {review.parseWarnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="dk-row">
            <button
              type="button"
              className="dk-btn-primary dk-grow"
              disabled={Boolean(busy) || review.rows.length === 0}
              onClick={() => void handleSave()}
            >
              {initialDeck ? 'Save changes' : 'Save deck'}
            </button>
            <button
              type="button"
              className="dk-btn-quiet"
              disabled={Boolean(busy)}
              onClick={() => setReview(null)}
            >
              Back
            </button>
          </div>
        </>
      )}

      {busy && <p className="dk-busy">{busy}</p>}
      {error && <p className="dk-error">{error}</p>}
    </div>
  );
}
