/**
 * The fetching half of deck import: a deck link in, a normalised `FetchedDeck`
 * out, or a status the client already has a sentence for.
 *
 * This exists because neither site can be read from the page. Archidekt's API
 * answers without auth but its CORS header names `http://localhost:3000` and
 * nothing else, so a browser on any other origin is refused before it sees a
 * body. Moxfield's API sits behind Cloudflare's bot check, which 403s anything
 * whose user agent Moxfield has not whitelisted on request. So a fetcher outside
 * the browser does the reading, and the page only ever talks to it.
 *
 * Two callers share this file: the local proxy (`server/judge.ts`, for
 * `npm run dev` and `npm run play`) and the Cloudflare Worker under
 * `workers/deck-fetch/`, which is what the published static build talks to.
 * That is why nothing here imports from `node:` — only `fetch`, `AbortSignal`
 * and `setTimeout`, which Node 24 and workerd both provide. The normaliser is
 * imported from `src/domain/deckUrl.ts`, so the browser, the proxy, the Worker
 * and the verification scripts can never disagree about what a deck looks like.
 *
 * Nothing here logs a URL, a deck name or a card. The caller logs the route and
 * the status; a decklist is the player's, and it does not belong in a log.
 */
import {
  normalizeArchidekt,
  normalizeMoxfield,
  parseDeckUrl,
  type FetchedDeck,
} from '../src/domain/deckUrl.ts';

/**
 * Where the proxy serves this. The client resolves the same path itself
 * (`src/services/deckFetch.ts`) because on the static build it is replaced by an
 * absolute Worker URL at build time; this constant is the server's copy, so the
 * route and the dev proxy rule are written once on this side.
 */
export const DECK_FETCH_ENDPOINT = '/api/deck';

/**
 * A deck read is one small JSON GET. Past ten seconds the upstream is not
 * answering, and the player is better served by the paste instruction than by a
 * spinner: the client's own ceiling is twice this, so a timeout here always
 * arrives as a 502 with a reason rather than as a silence.
 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Archidekt does not require this, but sending a name and a link is the polite
 * form for an unauthenticated API, and it is what they would look for if the app
 * ever needed to be identified in their logs. Rate limit is about 40 reads a
 * minute; one player pasting one link is nowhere near it.
 */
const ARCHIDEKT_USER_AGENT = 'ProvingGrounds/0.1 (+https://github.com/currentsbtw/proving-grounds)';

export type DeckFetchFailureStatus = 400 | 404 | 429 | 501 | 502;

export type DeckFetchOutcome =
  | { status: 200; deck: FetchedDeck }
  | { status: DeckFetchFailureStatus; code: string; message: string };

export interface DeckFetchOptions {
  /**
   * The user agent Moxfield has whitelisted for this app. Absent means there is
   * no Moxfield fetcher on this deployment, which is a 501 rather than a failed
   * read: nothing is wrong upstream, this build simply cannot ask.
   */
  moxfieldUserAgent?: string;
  /** Injected by the verification harness so the checks need no network. */
  fetchImpl?: typeof fetch;
  /** Aborted when the caller walks away, so a dropped request stops the read. */
  signal?: AbortSignal;
}

function fail(status: DeckFetchFailureStatus, code: string, message: string): DeckFetchOutcome {
  return { status, code, message };
}

/**
 * What one upstream GET can end as. `network` covers everything that never
 * produced a status — DNS, TLS, a dropped socket, the timeout — and `body`
 * covers a 200 that was not JSON; both mean the same thing to the caller.
 */
type Upstream =
  | { kind: 'json'; json: unknown }
  | { kind: 'status'; status: number }
  | { kind: 'network' };

async function getJson(
  url: string,
  userAgent: string,
  opts: DeckFetchOptions,
): Promise<Upstream> {
  const doFetch = opts.fetchImpl ?? fetch;

  // Own controller, so the cap and the caller's abort both land on this read
  // and neither can be confused for the other by the upstream.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  else opts.signal?.addEventListener('abort', onAbort);

  try {
    const res = await doFetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': userAgent },
    });
    if (!res.ok) return { kind: 'status', status: res.status };
    try {
      return { kind: 'json', json: (await res.json()) as unknown };
    } catch {
      // A 200 that is not JSON is a bot wall or an error page wearing a 200.
      return { kind: 'network' };
    }
  } catch {
    return { kind: 'network' };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Read a Moxfield or Archidekt deck link.
 *
 * The statuses are the contract the client's `describeDeckFetchError` is written
 * against, so each one has to mean exactly one thing:
 *
 *   400  the link is not a deck link on either site
 *   404  the deck is private or gone (Archidekt answers 403 for private, which
 *        is the same story to a player and is reported as 404)
 *   429  the site is rate-limiting; try again in a minute
 *   501  this deployment has no fetcher for that site (Moxfield with no
 *        whitelisted user agent configured)
 *   502  the site could not be reached, or refused an automated read
 */
export async function fetchDeck(url: string, opts: DeckFetchOptions = {}): Promise<DeckFetchOutcome> {
  const ref = parseDeckUrl(url);
  if (!ref) return fail(400, 'bad_url', 'Not a Moxfield or Archidekt deck link.');

  if (ref.site === 'moxfield') {
    const userAgent = opts.moxfieldUserAgent?.trim();
    if (!userAgent) {
      // Not a failure to report as one: Moxfield's bot check would refuse this
      // read, so the honest answer is that this build cannot make it.
      return fail(
        501,
        'no_fetcher',
        'This deployment has no Moxfield user agent; Moxfield refuses automated reads without one.',
      );
    }

    const result = await getJson(ref.apiUrl, userAgent, opts);
    if (result.kind === 'json') return { status: 200, deck: normalizeMoxfield(result.json, ref) };
    if (result.kind === 'network') return fail(502, 'upstream', 'Moxfield could not be reached.');
    if (result.status === 403) {
      // The configured user agent is not (or is no longer) whitelisted. 502
      // rather than 501: there is a fetcher, and it was turned away.
      return fail(502, 'blocked', 'Moxfield refused the read; the user agent is not whitelisted.');
    }
    if (result.status === 404) return fail(404, 'not_found', 'That deck is private or does not exist.');
    if (result.status === 429) return fail(429, 'rate_limited', 'Moxfield is rate-limiting deck reads.');
    return fail(502, 'upstream', `Moxfield answered ${result.status}.`);
  }

  const result = await getJson(ref.apiUrl, ARCHIDEKT_USER_AGENT, opts);
  if (result.kind === 'json') return { status: 200, deck: normalizeArchidekt(result.json, ref) };
  if (result.kind === 'network') return fail(502, 'upstream', 'Archidekt could not be reached.');
  if (result.status === 403 || result.status === 404) {
    return fail(404, 'not_found', 'That deck is private or does not exist.');
  }
  if (result.status === 429) return fail(429, 'rate_limited', 'Archidekt is rate-limiting deck reads.');
  return fail(502, 'upstream', `Archidekt answered ${result.status}.`);
}
