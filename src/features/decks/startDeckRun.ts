import { resolveCardsByIds } from '../../services/scryfall';
import { useGameStore } from '../../state/gameStore';
import type { CardData, Deck } from '../../domain/types';

/**
 * Resolve a deck's cards and hand them to the store. Shared by the deck list's
 * "Start Run" and the scorecard's "Replay seed" so the two cannot drift: a
 * same-seed replay is only like-for-like if it is prepared exactly the same way.
 *
 * Throws with a message meant for the UI; callers surface it inline.
 */
export async function startDeckRun(deck: Deck, seed?: string): Promise<void> {
  const ids = [...deck.commanderIds, ...deck.cards.map((c) => c.scryfallId)];

  // A deck whose cards are all cached starts offline. One that still needs a
  // card does not, and "Failed to fetch" is the browser talking, not the app:
  // say which side of the wire the problem is on and what to do about it.
  let resolved;
  try {
    resolved = await resolveCardsByIds(ids);
  } catch (err: unknown) {
    const answered = err instanceof Error && err.message.startsWith('Scryfall responded');
    throw new Error(
      answered
        ? `${(err as Error).message}. This deck still has cards to fetch, so try again in a moment.`
        : 'Could not reach Scryfall for the cards this deck has not cached yet. Check your connection and start again.',
    );
  }
  const { found, notFound } = resolved;
  if (notFound.length > 0) {
    throw new Error(
      `Could not resolve ${notFound.length} card${notFound.length === 1 ? '' : 's'} for this deck. Reimport it or check your connection.`,
    );
  }
  const record: Record<string, CardData> = {};
  for (const card of found) record[card.scryfallId] = card;
  useGameStore.getState().startRun(deck, record, seed?.trim() || undefined);
}
