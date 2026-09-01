import Dexie from 'dexie';
import type { EntityTable } from 'dexie';
import type { CardData, Deck, RunRecord, SettingRecord } from '../domain/types';

export type ProvingGroundsDb = Dexie & {
  decks: EntityTable<Deck, 'id'>;
  runs: EntityTable<RunRecord, 'id'>;
  cards: EntityTable<CardData, 'scryfallId'>;
  settings: EntityTable<SettingRecord, 'key'>;
};

export const db = new Dexie('proving-grounds') as ProvingGroundsDb;

db.version(1).stores({
  decks: 'id',
  runs: 'id, deckId, startedAt',
  cards: 'scryfallId, name',
  settings: 'key',
});

export async function saveDeck(deck: Deck): Promise<string> {
  return db.decks.put(deck);
}

export async function listDecks(): Promise<Deck[]> {
  const decks = await db.decks.toArray();
  return decks.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDeck(id: string): Promise<Deck | undefined> {
  return db.decks.get(id);
}

export async function deleteDeck(id: string): Promise<void> {
  await db.decks.delete(id);
}

export async function saveRun(run: RunRecord): Promise<string> {
  return db.runs.put(run);
}

export async function listRuns(deckId?: string): Promise<RunRecord[]> {
  const runs = deckId
    ? await db.runs.where('deckId').equals(deckId).toArray()
    : await db.runs.toArray();
  return runs.sort((a, b) => b.startedAt - a.startedAt);
}

export async function deleteRun(id: string): Promise<void> {
  await db.runs.delete(id);
}

export async function cacheCards(cards: CardData[]): Promise<void> {
  if (cards.length === 0) return;
  await db.cards.bulkPut(cards);
}

export async function getCachedCardsByIds(ids: string[]): Promise<CardData[]> {
  if (ids.length === 0) return [];
  const found = await db.cards.bulkGet(ids);
  return found.filter((c): c is CardData => Boolean(c));
}

export async function getCachedCardsByName(names: string[]): Promise<CardData[]> {
  if (names.length === 0) return [];
  return db.cards.where('name').anyOf(names).toArray();
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const row = await db.settings.get(key);
  return row?.value as T | undefined;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}
