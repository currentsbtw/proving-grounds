import { useEffect, useMemo, useState } from 'react';
import { nanoid } from 'nanoid';
import { saveDeck } from '../../db/db';
import { parseDecklist } from '../../services/deckParser';
import type { ParsedEntry } from '../../services/deckParser';
import { deckSiteLabel, isDeckUrl, parseDeckUrl, toDecklistText } from '../../domain/deckUrl';
import type { DeckUrlRef } from '../../domain/deckUrl';
import { fetchDeckFromUrl } from '../../services/deckFetch';
import { indexByName, nameKey, resolveCards, resolveCardsByIds } from '../../services/scryfall';
import type { CardData, Deck, DeckCardRef } from '../../domain/types';
import { CommanderPicker } from './CommanderPicker';

const BRACKETS: Deck['bracket'][] = [1, 2, 3, 4, 5];
const DECK_SIZE = 100;

/**
 * How many lines of either list the review prints. A list of garbage produces a
 * warning per line, and an uncapped column of them pushes Save off the rail.
 */
const LISTED = 12;

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

  /**
   * The three arguments exist for the fetch path, which resolves a deck in the
   * same tick it received one: the text comes from what just arrived rather
   * than from state React has not committed yet, whatever the site's list lost
   * on the way in (a Maybeboard, a row with no name) is shown in the review
   * beside the parser's own complaints, and `known` is the deck name as it will
   * be — so the commander fallback below does not overwrite the name the site
   * gave the deck.
   */
  async function handleResolve(
    source: string = text,
    extraWarnings: string[] = [],
    known: string = name,
  ) {
    setError(null);
    const parsed = parseDecklist(source);
    if (parsed.entries.length === 0) {
      // Nothing to resolve, so nothing below runs — but the fetch path set
      // `busy` before calling in, and leaving it set locks the form. On that
      // path the site's own warnings are the only account of why a deck arrived
      // empty (everything was on a Maybeboard, the deck listed no cards), so
      // they are shown instead of an instruction to paste a list that is
      // already pasted.
      setError(
        extraWarnings.length > 0
          ? `${extraWarnings.join('. ')}. Nothing was imported.`
          : 'Nothing to import. Paste a decklist first.',
      );
      setBusy(null);
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

      setReview({ rows, notFound, parseWarnings: [...extraWarnings, ...parsed.warnings] });
      setCommanderIds((prev) => {
        const valid = prev.filter((id) => rows.some((r) => r.card.scryfallId === id));
        return marked.length > 0 ? marked : valid;
      });
      if (!known.trim() && marked.length > 0) {
        const lead = rows.find((r) => r.card.scryfallId === marked[0]);
        if (lead) setName(lead.card.name);
      }
    } catch (err: unknown) {
      // A status from Scryfall is worth repeating; the browser's own wording for
      // a dead connection ("Failed to fetch") tells the reader nothing and
      // offers no next move, so that case gets a sentence with one in it.
      const answered = err instanceof Error && err.message.startsWith('Scryfall responded');
      setError(
        answered
          ? `${(err as Error).message}. Resolve the list again in a moment.`
          : 'Could not reach Scryfall. Check your connection, then resolve the list again.',
      );
    } finally {
      setBusy(null);
    }
  }

  /**
   * A pasted link, fetched and dropped into the box as a list. The player sees
   * exactly what came back, and everything after this point — the review, the
   * commander marking, Scryfall — is the paste flow untouched.
   */
  async function handleFetch(ref: DeckUrlRef) {
    setError(null);
    setBusy(`Reading the deck on ${deckSiteLabel(ref.site)}`);
    const result = await fetchDeckFromUrl(ref);
    if (!result.ok) {
      setError(result.message);
      setBusy(null);
      return;
    }

    const body = toDecklistText(result.deck);
    setText(body);
    // The site's own name for the deck, unless the player already typed one.
    const fetched = result.deck.name.trim();
    const known = name.trim() || fetched;
    if (!name.trim() && fetched) setName(fetched);
    await handleResolve(body, result.deck.warnings, known);
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
      setError(
        err instanceof Error ? `Could not save deck. ${err.message}` : 'Could not save deck.',
      );
      setBusy(null);
    }
  }

  const commanderOptions = review ? review.rows.map((r) => r.card) : [];
  /** A box holding one deck link fetches it; anything else is a pasted list. */
  const link = useMemo(() => (isDeckUrl(text) ? parseDeckUrl(text) : null), [text]);

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
              placeholder={
                'Commander\n1 Atraxa, Praetors’ Voice\n\nDeck\n1 Sol Ring\n1 Arcane Signet\n…\n\n' +
                'or paste a Moxfield / Archidekt deck link'
              }
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <div className="dk-row">
            <button
              type="button"
              className="dk-btn-primary dk-grow"
              disabled={Boolean(busy) || text.trim().length === 0}
              onClick={() => void (link ? handleFetch(link) : handleResolve())}
            >
              {link ? `Fetch from ${deckSiteLabel(link.site)}` : 'Resolve list'}
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
              <div>
                {review.notFound.length} card name{review.notFound.length === 1 ? ' was' : 's were'} not
                found on Scryfall. Go Back to fix the spelling, or save the deck without them.
              </div>
              <ul className="dk-warn-list">
                {review.notFound.slice(0, LISTED).map((n) => (
                  <li key={n} className="dk-user-text">
                    {n}
                  </li>
                ))}
                {review.notFound.length > LISTED && (
                  <li>+{review.notFound.length - LISTED} more</li>
                )}
              </ul>
            </div>
          )}

          {review.parseWarnings.length > 0 && (
            <div className="dk-warn">
              <div>Problems in the pasted list:</div>
              <ul className="dk-warn-list">
                {review.parseWarnings.slice(0, LISTED).map((w) => (
                  <li key={w} className="dk-user-text">
                    {w}
                  </li>
                ))}
                {review.parseWarnings.length > LISTED && (
                  <li>+{review.parseWarnings.length - LISTED} more</li>
                )}
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
