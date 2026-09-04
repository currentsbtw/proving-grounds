import { resolveCardsByIds } from '../../services/scryfall';
import { useGameStore } from '../../state/gameStore';
import type { StartRunOptions } from '../../state/gameStore';
import type { CardData, Deck } from '../../domain/types';

/**
 * Every card a deck needs, keyed by scryfall id, in the shape the store and the
 * hand drill both want. Shared so that starting a run and drilling the same
 * list prepare the same library from the same cache with the same wording when
 * it fails: two copies of this would eventually disagree about which cards a
 * deck is, and the drill's whole claim is that it deals what a run would.
 *
 * Cache-first (`resolveCardsByIds` reads IndexedDB before the network), so a
 * second call for a deck just resolved costs one bulk read and no request.
 *
 * Throws with a message meant for the UI; callers surface it inline.
 */
export async function resolveDeckCards(deck: Deck): Promise<Record<string, CardData>> {
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
  return record;
}

/**
 * Resolve a deck's cards and hand them to the store. Shared by the deck list's
 * "Start Run" and the scorecard's "Replay seed" so the two cannot drift: a
 * same-seed replay is only like-for-like if it is prepared exactly the same way.
 *
 * `options` carries what is not part of the seed — the shot clock, which the
 * replay path deliberately does not pass on: it is a drill setting, and a run
 * replayed under a clock it was not played under would still be the same run.
 *
 * Throws with a message meant for the UI; callers surface it inline.
 */
export async function startDeckRun(
  deck: Deck,
  seed?: string,
  options?: StartRunOptions,
): Promise<void> {
  const record = await resolveDeckCards(deck);
  useGameStore.getState().startRun(deck, record, seed?.trim() || undefined, options);
}
