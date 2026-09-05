/**
 * The deck fetcher, as a Cloudflare Worker.
 *
 * The published build is static GitHub Pages: there is no `/api` there, so the
 * page needs a fetcher somewhere with an origin of its own. This is that, and it
 * is deliberately thin — the reading and the normalising are `server/deckFetch.ts`,
 * the same module the local proxy calls, so the two deployments cannot drift.
 * Everything this file adds is HTTP: the query, CORS, and the method check.
 *
 * See README.md in this folder for the deploy steps.
 */
import { fetchDeck } from '../../../server/deckFetch.ts';

/**
 * Declared here rather than pulled from `@cloudflare/workers-types`, which the
 * app does not depend on and which nothing in this repo would otherwise need.
 * The root tsconfig projects cover `src`, `scripts`, `server` and the Vite
 * config, so this folder is never type-checked by `npm run build`; wrangler
 * bundles it with esbuild, which strips the types without checking them.
 */
interface ExportedHandler<E> {
  fetch(request: Request, env: E, ctx: unknown): Promise<Response> | Response;
}

interface Env {
  /** Secret. Absent means Moxfield links answer 501, which the page has a sentence for. */
  MOXFIELD_USER_AGENT?: string;
  /** Comma-separated origins allowed to call this Worker. */
  ALLOWED_ORIGINS?: string;
}

/** Used when the var is unset, so a fresh `wrangler deploy` already works. */
const DEFAULT_ALLOWED_ORIGINS =
  'https://currentsbtw.github.io,http://localhost:5173,http://localhost:4173';

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * CORS for an allowed origin and nothing for anyone else: a browser on an origin
 * this Worker does not know gets a reply it is not allowed to read. `Vary:
 * Origin` is always sent, because the answer differs by origin and a cache that
 * did not know that would hand one origin another's headers.
 */
function corsHeaders(request: Request, env: Env): Record<string, string> {
  const headers: Record<string, string> = { vary: 'Origin' };
  const origin = request.headers.get('Origin');
  if (origin && allowedOrigins(env).includes(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-methods'] = 'GET, OPTIONS';
    headers['access-control-allow-headers'] = 'accept, content-type';
    headers['access-control-max-age'] = '86400';
  }
  return headers;
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') {
      return json({ error: 'Use GET.', code: 'bad_method' }, 405, { ...cors, allow: 'GET, OPTIONS' });
    }

    const url = new URL(request.url);
    // The Worker answers at its root; `/deck` is accepted too, so the same
    // deployment works whether or not it is put behind a route with a path.
    //
    // A path this Worker does not serve is a fetcher problem, not a deck
    // problem: 404 `bad_url` would reach the player as "that deck is private or
    // does not exist", which is a lie about their deck. 501 `bad_route` reads
    // as a fetcher that could not be reached, which is what happened.
    if (url.pathname !== '/' && url.pathname !== '/deck' && url.pathname !== '/api/deck') {
      return json({ error: 'No such route.', code: 'bad_route' }, 501, cors);
    }

    const link = url.searchParams.get('url');
    if (!link) return json({ error: 'Pass a deck link as ?url=.', code: 'bad_url' }, 400, cors);

    const result = await fetchDeck(link, {
      moxfieldUserAgent: env.MOXFIELD_USER_AGENT,
      signal: request.signal,
    });

    if (result.status === 200) return json(result.deck, 200, cors);
    return json({ error: result.message, code: result.code }, result.status, cors);
  },
} satisfies ExportedHandler<Env>;
