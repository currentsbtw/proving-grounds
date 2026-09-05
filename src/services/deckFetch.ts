import {
  describeDeckFetchError,
  NO_DECK_FETCHER_CODE,
  type DeckUrlRef,
  type FetchedDeck,
} from '../domain/deckUrl';

/**
 * The client half of deck fetching: one GET, and a sentence for every way it
 * can fail. The page never talks to Moxfield or Archidekt itself — Archidekt's
 * CORS header names one origin that is not ours, and Moxfield's Cloudflare
 * check refuses anything without a whitelisted user agent — so the link goes to
 * a fetch route, which does the reading and returns an already-normalised deck.
 *
 * Nothing here re-normalises. The route and this file share `src/domain/deckUrl`,
 * so the shape is settled in one place; the client only checks that what came
 * back looks like a deck before handing it to the form.
 */

/** A deck read should not take long; past this the fetcher is not coming back. */
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Where the fetch route lives. In dev and on any deployment that carries a
 * server, `/api/deck` is proxied to it. The static Pages build has no `/api`,
 * so it is given the absolute URL of a Worker at build time instead; unset
 * means there is no fetcher, and the failure says so rather than guessing.
 *
 * `server/deckFetch.ts` keeps its own `DECK_FETCH_ENDPOINT` with the same path
 * rather than importing this one, and deliberately: this file is browser code
 * that reads `import.meta.env`, which Vite replaces at build time and which
 * neither Node nor workerd defines, so the server could not call it. The two
 * constants agree on `/api/deck`; change one and change the other.
 */
export function deckFetchEndpoint(): string {
  const override = import.meta.env.VITE_DECK_FETCH_URL as unknown;
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  return '/api/deck';
}

/** True when this build was handed a fetcher URL, i.e. it is not the bare static build. */
function hasConfiguredFetcher(): boolean {
  const override = import.meta.env.VITE_DECK_FETCH_URL as unknown;
  return typeof override === 'string' && override.trim().length > 0;
}

export type DeckFetchResult =
  | { ok: true; deck: FetchedDeck }
  /** `code` is the route's own name for the failure, or null when it gave none. */
  | { ok: false; status: number | null; code: string | null; message: string };

/** Body as JSON, or undefined when the reply was not JSON at all. */
async function readJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Enough of a check to know a deck arrived: the site, a name, and an array of
 * entries. A reply that passes this and is still wrong is a bug in the route,
 * not something the form can do anything about.
 */
function asDeck(body: unknown): FetchedDeck | null {
  if (typeof body !== 'object' || body === null) return null;
  const deck = body as Partial<FetchedDeck>;
  if (deck.site !== 'moxfield' && deck.site !== 'archidekt') return null;
  if (typeof deck.name !== 'string') return null;
  if (!Array.isArray(deck.entries)) return null;
  return {
    site: deck.site,
    id: typeof deck.id === 'string' ? deck.id : '',
    url: typeof deck.url === 'string' ? deck.url : '',
    name: deck.name,
    entries: deck.entries,
    warnings: Array.isArray(deck.warnings) ? deck.warnings : [],
  };
}

/** The route's `code`, when it sent one this file can pass on. */
function errorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' && code.trim().length > 0 ? code.trim() : null;
}

function failed(ref: DeckUrlRef, status: number | null, code: string | null): DeckFetchResult {
  return { ok: false, status, code, message: describeDeckFetchError(ref.site, status, code) };
}

/**
 * Nothing answered. Which of the two silences it was is something only this
 * file knows: a build with no fetcher URL cannot have reached one, while a
 * build that has one and heard nothing has a fetcher that is down. The domain
 * module is told which by the code rather than reading the environment itself.
 */
function unreachable(ref: DeckUrlRef): DeckFetchResult {
  return failed(ref, null, hasConfiguredFetcher() ? null : NO_DECK_FETCHER_CODE);
}

export async function fetchDeckFromUrl(
  ref: DeckUrlRef,
  signal?: AbortSignal,
): Promise<DeckFetchResult> {
  const endpoint = deckFetchEndpoint();
  const joiner = endpoint.includes('?') ? '&' : '?';
  const url = `${endpoint}${joiner}url=${encodeURIComponent(ref.canonicalUrl)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
  } catch {
    // Nothing answered: no route on this build, no connection, or a caller who
    // walked away.
    return unreachable(ref);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  const body = await readJson(res);
  // A reply that is not JSON is not this route answering — a dev proxy's 404
  // page, an index.html from a static host. Same story as no fetcher at all.
  if (body === undefined) return unreachable(ref);
  if (!res.ok) return failed(ref, res.status, errorCode(body));

  const deck = asDeck(body);
  if (!deck) return unreachable(ref);
  return { ok: true, deck };
}
