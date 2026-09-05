/**
 * Deck links: reading one, turning what a site returns into entries the deck
 * parser already understands, and the sentence the import form shows when a
 * fetch does not come back.
 *
 * Everything here is pure. No fetch, no DOM, no browser globals — the same file
 * runs in the browser, in a verification script under Node, and inside the
 * worker that does the actual fetching, so the browser and the fetcher can
 * never disagree about what a link means or what a deck looks like.
 *
 * Why a fetcher at all: neither site can be read from a page on this origin.
 * Archidekt's API answers without auth but its CORS header names only
 * `http://localhost:3000`, and Moxfield's is behind Cloudflare's bot check,
 * which 403s anything without a user agent Moxfield has whitelisted on request.
 * So the page hands a link to `/api/deck` and gets a `FetchedDeck` back.
 */

// Type-only, so this stays a leaf module: `import type` is erased at build time
// and nothing from services is pulled in at runtime.
import type { ParsedEntry } from '../services/deckParser';

export type DeckSite = 'moxfield' | 'archidekt';

export interface DeckUrlRef {
  site: DeckSite;
  id: string;
  canonicalUrl: string;
  apiUrl: string;
}

export interface FetchedDeck {
  site: DeckSite;
  id: string;
  url: string;
  name: string;
  entries: ParsedEntry[];
  warnings: string[];
}

/** Printed in every sentence the form shows, so it is written once. */
const SITE_LABEL: Record<DeckSite, string> = {
  moxfield: 'Moxfield',
  archidekt: 'Archidekt',
};

export function deckSiteLabel(site: DeckSite): string {
  return SITE_LABEL[site];
}

/** Past this a response is not a decklist, whatever it says it is. */
const MAX_ENTRIES = 1000;

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * Moxfield public ids are short opaque strings (`AbCd_12EfGh`); Archidekt deck
 * ids are plain integers. Both patterns are applied to a link already stripped
 * of scheme, query and hash, so a slug, a `?utm_source=` or a `#primer` on the
 * end changes nothing.
 */
const MOXFIELD_RE = /^(?:www\.)?moxfield\.com\/decks\/([A-Za-z0-9_-]{3,64})(?:\/.*)?$/i;
const ARCHIDEKT_RE = /^(?:www\.)?archidekt\.com\/decks\/(\d{1,12})(?:\/.*)?$/i;
/** The API form, in case someone pastes what they found in a network tab. */
const ARCHIDEKT_API_RE = /^(?:www\.)?archidekt\.com\/api\/decks\/(\d{1,12})\/?$/i;

function refFor(site: DeckSite, id: string): DeckUrlRef {
  return site === 'moxfield'
    ? {
        site,
        id,
        canonicalUrl: `https://www.moxfield.com/decks/${id}`,
        apiUrl: `https://api2.moxfield.com/v2/decks/all/${id}`,
      }
    : {
        site,
        id,
        canonicalUrl: `https://archidekt.com/decks/${id}`,
        apiUrl: `https://archidekt.com/api/decks/${id}/`,
      };
}

/** A Moxfield or Archidekt deck link, or null for anything else. */
export function parseDeckUrl(input: string): DeckUrlRef | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 500 || /\s/.test(trimmed)) return null;

  // Scheme, then query and hash: what is left is host plus path.
  const withoutScheme = trimmed.replace(/^https?:\/\//i, '');
  const path = withoutScheme.split(/[?#]/)[0];

  const moxfield = MOXFIELD_RE.exec(path);
  if (moxfield) return refFor('moxfield', moxfield[1]);

  const archidekt = ARCHIDEKT_RE.exec(path);
  if (archidekt) return refFor('archidekt', archidekt[1]);

  const archidektApi = ARCHIDEKT_API_RE.exec(path);
  if (archidektApi) return refFor('archidekt', archidektApi[1]);

  return null;
}

/** True when the whole paste is one deck link and nothing else. */
export function isDeckUrl(text: string): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return false;
  return parseDeckUrl(trimmed) !== null;
}

// ---------------------------------------------------------------------------
// Reading unknown JSON
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A quantity a site could plausibly mean, or null when the row did not state a
 * readable one — which the callers read as a single copy.
 *
 * A stated zero comes back as 0 rather than as null, because the two mean
 * different things: a row that says it holds no copies is a row the deck does
 * not run, and importing it as one copy would put a card in a deck that never
 * had it. Callers skip a 0 and count it as skipped.
 */
function asQty(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const qty = Math.floor(value);
  return qty >= 0 ? qty : null;
}

/**
 * Collects entries by name so the same card listed twice — two printings of a
 * basic, a card in two categories — arrives as one entry with the copies added
 * up, which is what the rest of the import expects.
 */
class EntryBag {
  private readonly order: string[] = [];
  private readonly byKey = new Map<string, ParsedEntry>();
  private overLimit = 0;

  add(name: string, qty: number, isCommander: boolean): void {
    const key = name.toLowerCase();
    const existing = this.byKey.get(key);
    if (existing) {
      existing.qty += qty;
      existing.isCommander = existing.isCommander || isCommander;
      return;
    }
    if (this.byKey.size >= MAX_ENTRIES) {
      this.overLimit += 1;
      return;
    }
    this.byKey.set(key, { name, qty, isCommander });
    this.order.push(key);
  }

  /** Commanders first, so `toDecklistText` can print the two sections in order. */
  entries(): ParsedEntry[] {
    const all = this.order
      .map((key) => this.byKey.get(key))
      .filter((entry): entry is ParsedEntry => Boolean(entry));
    return [...all.filter((e) => e.isCommander), ...all.filter((e) => !e.isCommander)];
  }

  dropped(): number {
    return this.overLimit;
  }
}

function plural(count: number): string {
  return count === 1 ? '' : 's';
}

// ---------------------------------------------------------------------------
// Archidekt
// ---------------------------------------------------------------------------

/**
 * Verified against a real response (`scripts/fixtures/archidekt-deck-1.json`):
 *
 *   { name, categories: [{ name, isPremier, includedInDeck }],
 *     cards: [{ quantity, categories: string[] | null,
 *               card: { oracleCard: { name } } }] }
 *
 * A card's `categories` are names that point back at the deck's category list.
 * Commanders sit in the premier category (usually literally "Commander"), and
 * Maybeboard and Sideboard are categories with `includedInDeck: false` — the
 * cards themselves say nothing about which board they are on.
 */
export function normalizeArchidekt(json: unknown, ref: DeckUrlRef): FetchedDeck {
  const warnings: string[] = [];
  const root = asRecord(json);
  const bag = new EntryBag();

  const name = asString(root?.name) || `Archidekt deck ${ref.id}`;
  if (!root) warnings.push('Archidekt returned something that was not a deck');

  const categories = new Map<string, { premier: boolean; included: boolean }>();
  const rawCategories = Array.isArray(root?.categories) ? root.categories : [];
  for (const raw of rawCategories) {
    const category = asRecord(raw);
    const label = asString(category?.name);
    if (!label) continue;
    categories.set(label.toLowerCase(), {
      premier: category?.isPremier === true,
      // Absent means shown: only an explicit false takes a category off the deck.
      included: category?.includedInDeck !== false,
    });
  }

  const rawCards = Array.isArray(root?.cards) ? root.cards : [];
  if (root && rawCards.length === 0) warnings.push('Archidekt listed no cards in this deck');

  let unreadable = 0;
  let zeroQty = 0;
  let excludedCards = 0;
  const excludedFrom = new Set<string>();
  const unknownCategories = new Set<string>();

  for (const raw of rawCards) {
    const row = asRecord(raw);
    const card = asRecord(row?.card);
    const oracle = asRecord(card?.oracleCard);
    const cardName = asString(oracle?.name) || asString(card?.displayName);
    if (!cardName) {
      unreadable += 1;
      continue;
    }

    const qty = asQty(row?.quantity) ?? 1;
    // A row that says it holds no copies is not in the deck; it is reported
    // rather than imported as one.
    if (qty === 0) {
      zeroQty += 1;
      continue;
    }
    const cardCategories = Array.isArray(row?.categories)
      ? row.categories.map(asString).filter(Boolean)
      : [];

    let isCommander = false;
    let included = cardCategories.length === 0;
    const excludedLabels: string[] = [];
    for (const label of cardCategories) {
      const known = categories.get(label.toLowerCase());
      if (!known) {
        unknownCategories.add(label);
        // A category the deck never declared cannot be a board that hides
        // cards, so the card stays in.
        included = true;
        continue;
      }
      if (known.premier || label.toLowerCase() === 'commander') isCommander = true;
      if (known.included) included = true;
      else excludedLabels.push(label);
    }

    if (!included) {
      excludedCards += qty;
      for (const label of excludedLabels) excludedFrom.add(label);
      continue;
    }

    bag.add(cardName, qty, isCommander);
  }

  if (unreadable > 0) {
    warnings.push(`Skipped ${unreadable} Archidekt row${plural(unreadable)} with no card name`);
  }
  if (zeroQty > 0) {
    warnings.push(`Skipped ${zeroQty} Archidekt row${plural(zeroQty)} listing 0 copies`);
  }
  if (excludedCards > 0) {
    warnings.push(
      `Skipped ${excludedCards} card${plural(excludedCards)} in ${[...excludedFrom].join(', ')}`,
    );
  }
  if (unknownCategories.size > 0) {
    const what = unknownCategories.size === 1 ? 'category' : 'categories';
    warnings.push(`Kept cards in unlisted ${what}: ${[...unknownCategories].join(', ')}`);
  }
  const dropped = bag.dropped();
  if (dropped > 0) {
    warnings.push(`Stopped at ${MAX_ENTRIES} distinct cards; ${dropped} more skipped`);
  }

  return { site: ref.site, id: ref.id, url: ref.canonicalUrl, name, entries: bag.entries(), warnings };
}

// ---------------------------------------------------------------------------
// Moxfield
// ---------------------------------------------------------------------------

/**
 * UNVERIFIED against a live response. Moxfield's API is behind Cloudflare's bot
 * check and returns 403 to anything without a whitelisted user agent, so this
 * was written from the two documented shapes rather than from a capture, and
 * both are handled rather than guessed between:
 *
 *   v2  { name, commanders: { "Sol Ring": { quantity, card: { name } } },
 *         companions, mainboard, sideboard, maybeboard }   — boards keyed by name
 *   v3  { name, boards: { commanders: { cards: { "<id>": { quantity,
 *         card: { name } } } }, mainboard: {...}, ... } }  — boards keyed by id
 *
 * The reader takes either: a board is whatever object holds the rows, and a row
 * names its card either on `card.name` or, in v2, by the key it is filed under.
 * When a live capture does become available, check this against it before
 * trusting the shape.
 */
const MOXFIELD_INCLUDED: { key: string; commander: boolean }[] = [
  { key: 'commanders', commander: true },
  { key: 'companions', commander: false },
  { key: 'mainboard', commander: false },
];

/** Boards a Commander run never draws from; counted, then left behind. */
const MOXFIELD_SKIPPED = ['sideboard', 'maybeboard', 'tokens', 'stickers', 'attractions'];

/**
 * Whether a value on the deck (v2) or under `boards` (v3) is a board at all.
 * In v2 the boards hang off the deck beside `name`, `format` and the rest, so a
 * key alone proves nothing; a board is a record that either wraps its rows in
 * `cards` or holds rows that name a quantity or a card.
 */
function looksLikeBoard(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  if (asRecord(record.cards)) return true;
  for (const row of Object.values(record)) {
    const item = asRecord(row);
    if (item && ('quantity' in item || 'card' in item)) return true;
  }
  return false;
}

/** The rows of one board, whichever of the two shapes it arrived in. */
function moxfieldRows(board: unknown): [string, Json][] {
  const record = asRecord(board);
  if (!record) return [];
  const cards = asRecord(record.cards) ?? record;
  const rows: [string, Json][] = [];
  for (const [key, value] of Object.entries(cards)) {
    const row = asRecord(value);
    if (row) rows.push([key, row]);
  }
  return rows;
}

export function normalizeMoxfield(json: unknown, ref: DeckUrlRef): FetchedDeck {
  const warnings: string[] = [];
  const root = asRecord(json);
  const bag = new EntryBag();

  const name = asString(root?.name) || `Moxfield deck ${ref.id}`;
  if (!root) warnings.push('Moxfield returned something that was not a deck');

  // v3 files the boards under `boards`; v2 hangs them off the deck itself.
  const boards = asRecord(root?.boards) ?? root;

  let unreadable = 0;
  let zeroQty = 0;
  let counted = 0;
  for (const { key, commander } of MOXFIELD_INCLUDED) {
    for (const [rowKey, row] of moxfieldRows(boards?.[key])) {
      const card = asRecord(row.card);
      // v2 keys a board by card name, so the key is the fallback. v3 keys it by
      // an opaque id, which is not a name and is thrown out below rather than
      // imported as one.
      const cardName = asString(card?.name) || asString(rowKey);
      if (!cardName || /^[0-9a-f-]{20,}$/i.test(cardName)) {
        unreadable += 1;
        continue;
      }
      const qty = asQty(row.quantity) ?? 1;
      // A row that says it holds no copies is not in the deck; it is reported
      // rather than imported as one.
      if (qty === 0) {
        zeroQty += 1;
        continue;
      }
      counted += 1;
      bag.add(cardName, qty, commander);
    }
  }

  let skipped = 0;
  const skippedFrom: string[] = [];
  for (const key of MOXFIELD_SKIPPED) {
    const rows = moxfieldRows(boards?.[key]);
    if (rows.length === 0) continue;
    for (const [, row] of rows) skipped += asQty(row.quantity) ?? 1;
    skippedFrom.push(key);
  }

  // A board on neither list is a board this reader does not know about, and the
  // shape was written from documentation rather than from a capture. Dropping
  // one silently is how a Commander deck quietly loses its signature spells, so
  // each is named: the first real response tells us what it actually sends.
  const knownBoards = new Set<string>([
    ...MOXFIELD_INCLUDED.map((board) => board.key),
    ...MOXFIELD_SKIPPED,
  ]);
  const unknownBoards = Object.keys(boards ?? {}).filter(
    (key) => !knownBoards.has(key) && looksLikeBoard(boards?.[key]),
  );

  if (root && counted === 0) warnings.push('Moxfield listed no cards in this deck');
  if (unreadable > 0) {
    warnings.push(`Skipped ${unreadable} Moxfield row${plural(unreadable)} with no card name`);
  }
  if (zeroQty > 0) {
    warnings.push(`Skipped ${zeroQty} Moxfield row${plural(zeroQty)} listing 0 copies`);
  }
  if (skipped > 0) {
    warnings.push(`Skipped ${skipped} card${plural(skipped)} in ${skippedFrom.join(', ')}`);
  }
  for (const key of unknownBoards) warnings.push(`Ignored Moxfield board: ${key}`);
  const dropped = bag.dropped();
  if (dropped > 0) {
    warnings.push(`Stopped at ${MAX_ENTRIES} distinct cards; ${dropped} more skipped`);
  }

  return { site: ref.site, id: ref.id, url: ref.canonicalUrl, name, entries: bag.entries(), warnings };
}

// ---------------------------------------------------------------------------
// Back to text
// ---------------------------------------------------------------------------

/**
 * The fetched deck as the text the paste box takes. Nothing downstream changes:
 * the form drops this into the textarea, the player can see exactly what came
 * back, and the existing parser and Scryfall pass run on it unaltered.
 */
export function toDecklistText(deck: FetchedDeck): string {
  const commanders = deck.entries.filter((e) => e.isCommander);
  const rest = deck.entries.filter((e) => !e.isCommander);
  const lines: string[] = [];

  if (commanders.length > 0) {
    lines.push('Commander');
    for (const entry of commanders) lines.push(`${entry.qty} ${entry.name}`);
    lines.push('');
  }

  lines.push('Deck');
  for (const entry of rest) lines.push(`${entry.qty} ${entry.name}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// What the form says when it did not work
// ---------------------------------------------------------------------------

/**
 * The code the client raises for itself when this build was never given a
 * fetcher URL, so there is nothing to have reached. Everything else `code`
 * carries comes from the fetch route.
 */
export const NO_DECK_FETCHER_CODE = 'no_endpoint';

/**
 * One sentence per way a fetch ends badly, and every one of them says what to
 * do next. A player who wanted their deck in the app is not helped by a status
 * code; they are helped by being told to export the list and paste it.
 *
 * `status` is null when nothing answered at all — a dead connection, or a reply
 * that was not JSON. `code` is what the route called the failure, carried
 * through by `services/deckFetch`, which also supplies `NO_DECK_FETCHER_CODE`
 * itself. Three cases would otherwise blur into one:
 *
 *   nothing answered, no fetcher configured   this build cannot fetch at all
 *   nothing answered but one was configured,  the fetcher is down, or is not
 *     or it answered `bad_route`                serving the path it was given
 *   501 `no_fetcher`                          the fetcher cannot read that site
 *
 * The first and the last are the same instruction to a player — export the list
 * — so they share a sentence; the middle one is worth retrying and does not.
 */
export function describeDeckFetchError(
  site: DeckSite,
  status: number | null,
  code: string | null = null,
): string {
  const label = SITE_LABEL[site];

  if (status === null || status === 501) {
    const cannotFetch = status === null ? code === NO_DECK_FETCHER_CODE : code !== 'bad_route';
    if (!cannotFetch) {
      return 'The deck fetcher for this build could not be reached. Try again in a minute, or export the list as text and paste it.';
    }
    const how =
      site === 'moxfield'
        ? 'open the deck, choose More → Export'
        : 'open the deck, use the Export button';
    return `This build cannot fetch from ${label}. On ${label}, ${how}, and paste the text here.`;
  }
  if (status === 400) return `That link is not a ${label} deck.`;
  if (status === 404) return 'That deck is private or does not exist.';
  if (status === 429) return `${label} is rate-limiting deck reads; try again in a minute.`;
  if (status === 502 && site === 'moxfield') {
    return 'Moxfield blocks automated reads unless the fetcher has a whitelisted user agent; export the list as text and paste it.';
  }
  if (status === 502) return `${label} could not be reached.`;
  return `${label} answered with ${status}. Export the list as text and paste it.`;
}
