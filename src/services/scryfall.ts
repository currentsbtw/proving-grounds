import { cacheCards, getCachedCardsByIds, getCachedCardsByName } from '../db/db';
import type { CardData } from '../domain/types';

const COLLECTION_URL = 'https://api.scryfall.com/cards/collection';
const BATCH_SIZE = 75;
const BATCH_DELAY_MS = 120;
const MAX_RETRIES = 2;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResolveResult {
  found: CardData[];
  notFound: string[];
}

interface ScryfallFace {
  name?: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  image_uris?: { small?: string; normal?: string };
}

interface ScryfallCard extends ScryfallFace {
  id: string;
  name: string;
  cmc?: number;
  color_identity?: string[];
  layout?: string;
  card_faces?: ScryfallFace[];
}

interface CollectionResponse {
  data?: ScryfallCard[];
  not_found?: { name?: string; id?: string }[];
}

type Identifier = { name: string } | { id: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Lookup key: case-insensitive, whitespace-collapsed. */
export function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Maps a Scryfall card object onto the cached CardData subset. */
export function toCardData(card: ScryfallCard): CardData {
  const faces = Array.isArray(card.card_faces) ? card.card_faces : [];
  const front: ScryfallFace = faces[0] ?? {};
  const images = card.image_uris ?? front.image_uris;
  const oracle =
    card.oracle_text ??
    (faces.length > 0
      ? faces
          .map((f) => f.oracle_text)
          .filter(Boolean)
          .join('\n—\n')
      : '');

  return {
    scryfallId: card.id,
    name: card.name,
    manaCost: card.mana_cost ?? front.mana_cost ?? '',
    manaValue: typeof card.cmc === 'number' ? card.cmc : 0,
    typeLine: card.type_line ?? front.type_line ?? '',
    oracleText: oracle,
    power: card.power ?? front.power,
    toughness: card.toughness ?? front.toughness,
    colorIdentity: card.color_identity ?? [],
    imageNormal: images?.normal,
    imageSmall: images?.small,
    layout: card.layout ?? 'normal',
  };
}

/**
 * Index resolved cards by every name a decklist might use: the full Scryfall name
 * plus each face of a `//` name (DFC, split, adventure).
 */
export function indexByName(cards: CardData[]): Map<string, CardData> {
  const map = new Map<string, CardData>();
  for (const card of cards) {
    const full = nameKey(card.name);
    if (!map.has(full)) map.set(full, card);
    if (card.name.includes('//')) {
      for (const part of card.name.split('//')) {
        const key = nameKey(part);
        if (key && !map.has(key)) map.set(key, card);
      }
    }
  }
  return map;
}

async function postCollection(identifiers: Identifier[]): Promise<CollectionResponse> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(COLLECTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Best effort — browsers override User-Agent.
          'User-Agent': 'ProvingGrounds/0.1',
        },
        body: JSON.stringify({ identifiers }),
      });

      if (res.ok) return (await res.json()) as CollectionResponse;

      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`Scryfall responded ${res.status}`);
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw new Error(`Scryfall responded ${res.status} ${res.statusText}`);
    } catch (err) {
      lastError = err;
      if (attempt === MAX_RETRIES) break;
      await sleep(400 * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Scryfall request failed');
}

/** Fetches identifiers in sequential batches of 75 with a short courtesy delay. */
async function fetchInBatches(
  identifiers: Identifier[],
): Promise<{ cards: ScryfallCard[]; missing: { name?: string; id?: string }[] }> {
  const cards: ScryfallCard[] = [];
  const missing: { name?: string; id?: string }[] = [];

  for (let i = 0; i < identifiers.length; i += BATCH_SIZE) {
    if (i > 0) await sleep(BATCH_DELAY_MS);
    const body = await postCollection(identifiers.slice(i, i + BATCH_SIZE));
    if (body.data) cards.push(...body.data);
    if (body.not_found) missing.push(...body.not_found);
  }

  return { cards, missing };
}

/**
 * Resolves card names to CardData, cache-first. Anything fetched is written to the
 * Dexie card cache. Names Scryfall does not recognise come back in `notFound`.
 */
export async function resolveCards(names: string[]): Promise<ResolveResult> {
  const requested: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim().replace(/\s+/g, ' ');
    if (!name) continue;
    const key = nameKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    requested.push(name);
  }
  if (requested.length === 0) return { found: [], notFound: [] };

  // 1. Cache: exact name index, then a case-insensitive map built from those hits.
  let cached: CardData[] = [];
  try {
    cached = await getCachedCardsByName(requested);
  } catch {
    cached = [];
  }
  const byKey = indexByName(cached);

  const found: CardData[] = [];
  const toFetch: string[] = [];
  for (const name of requested) {
    const hit = byKey.get(nameKey(name));
    if (hit) found.push(hit);
    else toFetch.push(name);
  }

  if (toFetch.length === 0) return { found, notFound: [] };

  // 2. Network for the remainder.
  const { cards, missing } = await fetchInBatches(toFetch.map((name) => ({ name })));
  const fetched = cards.map(toCardData);
  if (fetched.length > 0) {
    try {
      await cacheCards(fetched);
    } catch {
      /* cache write is best effort */
    }
  }

  const fetchedIndex = indexByName(fetched);
  const notFound: string[] = [];

  for (const name of toFetch) {
    const hit = fetchedIndex.get(nameKey(name));
    if (hit) found.push(hit);
    else notFound.push(name);
  }

  // Names Scryfall explicitly rejected that we never asked about (defensive).
  for (const entry of missing) {
    const name = entry.name?.trim();
    if (name && !notFound.some((n) => nameKey(n) === nameKey(name))) notFound.push(name);
  }

  return { found, notFound };
}

/**
 * Resolves Scryfall ids to CardData, cache-first, fetching any cache misses.
 * Ids Scryfall does not recognise come back in `notFound`.
 */
export async function resolveCardsByIds(
  ids: string[],
): Promise<{ found: CardData[]; notFound: string[] }> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return { found: [], notFound: [] };

  let cached: CardData[] = [];
  try {
    cached = await getCachedCardsByIds(unique);
  } catch {
    cached = [];
  }

  const byId = new Map(cached.map((c) => [c.scryfallId, c]));
  // Scryfall rejects the whole batch on a malformed `id`, so only send well-formed UUIDs.
  const missingIds = unique.filter((id) => !byId.has(id) && UUID_RE.test(id));
  if (unique.every((id) => byId.has(id))) {
    return { found: unique.map((id) => byId.get(id)).filter((c): c is CardData => Boolean(c)), notFound: [] };
  }

  const { cards } = await fetchInBatches(missingIds.map((id) => ({ id })));
  const fetched = cards.map(toCardData);
  if (fetched.length > 0) {
    try {
      await cacheCards(fetched);
    } catch {
      /* cache write is best effort */
    }
  }
  for (const card of fetched) byId.set(card.scryfallId, card);

  const found: CardData[] = [];
  const notFound: string[] = [];
  for (const id of unique) {
    const card = byId.get(id);
    if (card) found.push(card);
    else notFound.push(id);
  }

  return { found, notFound };
}
