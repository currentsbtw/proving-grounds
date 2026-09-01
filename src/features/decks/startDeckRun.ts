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
  const { found, notFound } = await resolveCardsByIds(ids);
  if (notFound.length > 0) {
    throw new Error(
      `Could not resolve ${notFound.length} card${notFound.length === 1 ? '' : 's'} for this deck. Reimport it or check your connection.`,
    );
  }
  const record: Record<string, CardData> = {};
  for (const card of found) record[card.scryfallId] = card;
  useGameStore.getState().startRun(deck, record, seed?.trim() || undefined);
}
