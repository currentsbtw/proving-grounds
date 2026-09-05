import { cacheCards, getCachedCardsByIds, getCachedCardsByName } from '../db/db';
import type { CardData, TokenSpec } from '../domain/types';

const COLLECTION_URL = 'https://api.scryfall.com/cards/collection';
const SEARCH_URL = 'https://api.scryfall.com/cards/search';
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
  loyalty?: string;
  image_uris?: { small?: string; normal?: string };
}

interface ScryfallCard extends ScryfallFace {
  id: string;
  name: string;
  cmc?: number;
  color_identity?: string[];
  layout?: string;
  keywords?: string[];
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

/**
 * How a `//` name is written when it is split or joined: Scryfall prints the
 * spaces, a decklist export may not, and both have to key the same.
 */
const FACE_SPLIT = /\s*\/\/\s*/g;

/**
 * Lookup key: case-insensitive, whitespace-collapsed, and with the `//` of a
 * two-faced name normalised to one spaced form. Without that last step a paste
 * of "Brazen Borrower//Petty Theft" was fetched and cached under the spaced name
 * Scryfall returns and then reported missing, because the key it was looked up
 * by was the unspaced one nothing had filed.
 */
export function nameKey(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .replace(FACE_SPLIT, ' // ')
    .toLowerCase();
}

/**
 * The name Scryfall's collection endpoint will answer to. It resolves a
 * double-faced or split card by its front face ("Westvale Abbey", "Fire") and
 * reports the full printed form ("Westvale Abbey // Ormendahl, Profane Prince")
 * as not found, which is exactly the form Archidekt exports and a player pastes.
 * The card that comes back carries the full name, and `indexByName` files it
 * under both, so the request is the only place the split matters.
 */
export function frontFaceName(name: string): string {
  return name.split(FACE_SPLIT)[0]?.trim() || name.trim();
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
    // Same card-then-front-face fallback as power and toughness: a transforming
    // planeswalker prints its loyalty on a face rather than at the card level,
    // and the face a question about casting it is about is the front one.
    loyalty: card.loyalty ?? front.loyalty,
    colorIdentity: card.color_identity ?? [],
    imageNormal: images?.normal,
    imageSmall: images?.small,
    layout: card.layout ?? 'normal',
    // Scryfall lists the keywords on a card whether or not they appear as bare
    // words in the oracle text, so this is the reliable answer to "what does
    // this card do that has a name". Left off entirely when the card has none,
    // to keep the cached row the same shape it has always been.
    keywords: card.keywords && card.keywords.length > 0 ? card.keywords : undefined,
  };
}

/**
 * The one stale cache row we top up: a planeswalker written before `loyalty` was
 * mapped. The field was added to `CardData` without a Dexie version bump, and
 * nothing else in the app refetches on a schema addition, so a walker imported
 * before this build would never gain a starting loyalty and the judge would be
 * handed a table with the one number a loyalty question needs missing.
 *
 * Deliberately narrow: this refetches one kind of row, not the cache. The test
 * reads the front face only, because that is the face `toCardData` takes loyalty
 * from and the face a question about casting the card is about. A modal card
 * with a creature front and a planeswalker back has no front-face loyalty to
 * find, so matching on the whole type line would refetch it on every resolve,
 * for ever, and still write the same row back.
 */
function needsLoyaltyTopUp(card: CardData): boolean {
  return card.loyalty === undefined && /planeswalker/i.test(card.typeLine.split('//')[0]);
}

/**
 * Index resolved cards by every name a decklist might use: the full Scryfall name
 * plus each face of a `//` name (DFC, split, adventure). The split is the same
 * regex `frontFaceName` requests by, and `nameKey` normalises the spacing around
 * a `//`, so a paste of either "Brazen Borrower // Petty Theft" or
 * "Brazen Borrower//Petty Theft" or just "Brazen Borrower" finds the same card.
 */
export function indexByName(cards: CardData[]): Map<string, CardData> {
  const map = new Map<string, CardData>();
  for (const card of cards) {
    const full = nameKey(card.name);
    if (!map.has(full)) map.set(full, card);
    for (const part of card.name.split(FACE_SPLIT)) {
      const key = nameKey(part);
      if (key && key !== full && !map.has(key)) map.set(key, card);
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
  // A hit that `needsLoyaltyTopUp` is sent to the network like a miss, so the
  // fetch below rewrites the row through `cacheCards`. The stale copy is kept as
  // a fallback: a top-up that cannot reach Scryfall must still hand back the card
  // we already had, one field short, rather than report it missing.
  const stale = new Map<string, CardData>();
  for (const name of requested) {
    const hit = byKey.get(nameKey(name));
    if (hit && !needsLoyaltyTopUp(hit)) {
      found.push(hit);
      continue;
    }
    if (hit) stale.set(nameKey(name), hit);
    toFetch.push(name);
  }

  if (toFetch.length === 0) return { found, notFound: [] };

  // 2. Network for the remainder.
  let cards: ScryfallCard[] = [];
  let missing: { name?: string; id?: string }[] = [];
  try {
    ({ cards, missing } = await fetchInBatches(toFetch.map((name) => ({ name: frontFaceName(name) }))));
  } catch (err) {
    // A batch of nothing but top-ups is allowed to fail quietly: every card in it
    // is already in hand, and an offline moment should cost the added field, not
    // the deck. One real miss riding along and the call fails as it always has.
    if (toFetch.some((name) => !stale.has(nameKey(name)))) throw err;
  }
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
    const hit = fetchedIndex.get(nameKey(name)) ?? stale.get(nameKey(name));
    if (hit) found.push(hit);
    else notFound.push(name);
  }

  // Names Scryfall explicitly rejected that we never asked about (defensive).
  for (const entry of missing) {
    const name = entry.name?.trim();
    if (name && !notFound.some((n) => nameKey(frontFaceName(n)) === nameKey(name))) notFound.push(name);
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
  // Same one top-up as `resolveCards`: a planeswalker row cached before `loyalty`
  // was mapped is refetched like a miss, and nothing else is. The stale row stays
  // in `byId` until a fresh one overwrites it, so a refetch that fails leaves the
  // card in hand rather than dropping it.
  const staleIds = new Set(
    unique.filter((id) => {
      const hit = byId.get(id);
      return hit !== undefined && needsLoyaltyTopUp(hit);
    }),
  );
  // Scryfall rejects the whole batch on a malformed `id`, so only send well-formed UUIDs.
  const missingIds = unique.filter((id) => (!byId.has(id) || staleIds.has(id)) && UUID_RE.test(id));
  if (staleIds.size === 0 && unique.every((id) => byId.has(id))) {
    return { found: unique.map((id) => byId.get(id)).filter((c): c is CardData => Boolean(c)), notFound: [] };
  }

  let cards: ScryfallCard[] = [];
  try {
    ({ cards } = await fetchInBatches(missingIds.map((id) => ({ id }))));
  } catch (err) {
    // As above: a batch of nothing but top-ups fails quietly, because every card
    // in it is already cached and the run can start without the added field.
    if (missingIds.some((id) => !staleIds.has(id))) throw err;
  }
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

// ---------------------------------------------------------------------------
// Token faces
// ---------------------------------------------------------------------------

/** The two fields a found printing contributes back to a `TokenSpec`. */
export interface TokenFace {
  scryfallId: string;
  imageNormal: string;
}

/**
 * Per-query results for the life of the session. Creating the same token twice
 * costs one call, and a name Scryfall has no token for is remembered as a miss
 * rather than asked about again on every click. Only settled answers are stored
 * — a hit, or the 404 Scryfall returns for a search that matched nothing. A
 * network failure or an abort is left out, so an offline moment does not pin a
 * token to the text frame for the rest of the run.
 */
const tokenFaceCache = new Map<string, TokenFace | null>();

/** Wall-clock stamp of the last search, for the same courtesy delay the collection batches keep. */
let lastSearchAt = 0;

/**
 * Splits a preset's display name into the name Scryfall knows and the ability
 * the parenthetical was standing in for: "Spirit (flying)" is a Spirit token
 * with flying, and Scryfall has no card named "Spirit (flying)".
 */
function splitTokenName(raw: string): { name: string; hint: string } {
  const match = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(raw.trim());
  if (!match) return { name: raw.trim(), hint: '' };
  return { name: (match[1] ?? '').trim(), hint: (match[2] ?? '').trim() };
}

/** Quotes are the one character that would end the `name:` term early. */
function quotable(value: string): string {
  return value.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The Scryfall search that finds a token's printing. `t:token` keeps the result
 * to the token set; the name, the body and the colours narrow it to the token
 * the player asked for; a parenthetical ability becomes an oracle term. Pure,
 * so the verification script can read every preset's query without a network.
 */
export function tokenSearchQuery(spec: TokenSpec): string {
  const { name, hint } = splitTokenName(spec.name);
  const terms = ['t:token'];

  const cleanName = quotable(name);
  if (cleanName) terms.push(`name:"${cleanName}"`);
  if (spec.power) terms.push(`pow=${quotable(spec.power)}`);
  if (spec.toughness) terms.push(`tou=${quotable(spec.toughness)}`);

  // `colors: []` is a real answer — the artifact presets are colourless and want
  // no colour term at all — so an empty list adds nothing. A spec that names
  // colours gets them as one term: ['W'] → c:w, ['C'] → c:c, ['W','U'] → c:wu.
  const colors = (spec.colors ?? [])
    .map((c) => c.trim().toLowerCase())
    .filter((c) => /^[wubrgc]$/.test(c))
    .join('');
  if (colors) terms.push(`c:${colors}`);

  const cleanHint = quotable(hint).toLowerCase();
  if (cleanHint) terms.push(`o:${cleanHint.replace(/\s+/g, '')}`);

  return terms.join(' ');
}

/**
 * The first entry in a search response that actually has a face to show. A
 * printing with no `image_uris` of its own is read through its front face, the
 * same fallback `toCardData` uses; one with neither is skipped rather than
 * returned as a token with a blank image.
 */
export function pickTokenFace(body: unknown): TokenFace | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;

  for (const entry of data) {
    const card = entry as ScryfallCard | null;
    if (!card || typeof card.id !== 'string') continue;
    const faces = Array.isArray(card.card_faces) ? card.card_faces : [];
    const image = card.image_uris?.normal ?? faces[0]?.image_uris?.normal;
    if (image) return { scryfallId: card.id, imageNormal: image };
  }
  return null;
}

/**
 * Finds the newest printing of a token and returns its id and normal image, or
 * null when there is none to be had. Never throws and never retries: the caller
 * is a button the player just pressed, and the text frame it would otherwise
 * draw is a complete token on its own. Scryfall answers 404 to a search that
 * matched nothing, so that status is a miss rather than an error.
 */
export async function findTokenFace(
  spec: TokenSpec,
  signal?: AbortSignal,
): Promise<TokenFace | null> {
  const query = tokenSearchQuery(spec);
  const cached = tokenFaceCache.get(query);
  if (cached !== undefined) return cached;

  const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&order=released&dir=desc&unique=cards`;

  try {
    const wait = lastSearchAt + BATCH_DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastSearchAt = Date.now();

    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        // Best effort — browsers override User-Agent. Node does not, and
        // Scryfall rejects a default runtime agent, so the scripts need it.
        'User-Agent': 'ProvingGrounds/0.1',
      },
      signal,
    });

    if (res.status === 404) {
      tokenFaceCache.set(query, null);
      return null;
    }
    if (!res.ok) return null;

    const face = pickTokenFace(await res.json());
    tokenFaceCache.set(query, face);
    return face;
  } catch {
    return null;
  }
}
