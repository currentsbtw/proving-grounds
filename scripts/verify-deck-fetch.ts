/**
 * Verification harness for the deck fetcher (`server/deckFetch.ts`), the module
 * both the local proxy and the Cloudflare Worker call.
 *
 * `verify:deck-url` already covers the pure half — parsing links and turning a
 * site's JSON into entries. This covers the half that talks to the network, and
 * it does so without touching it: `fetchDeck` takes a `fetchImpl`, so every
 * upstream answer is staged here and the whole run is offline and deterministic.
 * What is being checked is the status contract, because the client's sentences
 * (`describeDeckFetchError`) are written against exactly these numbers:
 *
 *   A — Archidekt: a 200 carrying the recorded fixture comes back as a deck;
 *       403 and 404 both read as 404 (private or gone is one story to a player);
 *       429 stays 429; a thrown fetch, a timeout-shaped abort and a 200 that is
 *       not JSON all read as 502; a 500 reads as 502. A 200 whose row states 0
 *       copies comes back without that card, and says so.
 *   B — Moxfield: with no user agent configured the answer is 501 `no_fetcher`
 *       and no request is made at all; with one, a 403 is 502 `blocked` (there
 *       is a fetcher and it was turned away), 404 is 404, 429 is 429, and a 200
 *       comes back as a deck. A 200 carrying a board this reader has never
 *       heard of names it rather than dropping it.
 *   C — the requests themselves: the right API URL, `Accept: application/json`,
 *       the ProvingGrounds user agent on Archidekt and the configured one on
 *       Moxfield. This is the whole reason Moxfield reads work at all, so it is
 *       asserted rather than assumed.
 *   D — a link that is not a deck link is 400 before anything is fetched.
 *   E — the join with the form: every failure this module produces, and the
 *       Worker's own 501 `bad_route`, turned into the sentence the player
 *       reads. `bad_route` and 501 `no_fetcher` must not read alike, and
 *       neither may read as a deck that does not exist.
 *   F — LIVE=1 only: one real read of Archidekt deck 1, which must come back as
 *       Fun With Fungus with Thelon of Havenwood as its commander. Off by
 *       default so the check stays offline and does not spend someone's rate
 *       limit on every run.
 *
 *   npx tsx scripts/verify-deck-fetch.ts
 *   LIVE=1 npx tsx scripts/verify-deck-fetch.ts
 *
 * Failures are collected rather than thrown one at a time, so a bad run reports
 * everything wrong in a single pass. The process exits non-zero if any failed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describeDeckFetchError, type DeckSite } from '../src/domain/deckUrl.ts';
import { fetchDeck, type DeckFetchOutcome } from '../server/deckFetch.ts';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

function fixture(file: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURE_DIR}${file}`, 'utf8')) as unknown;
}

const ARCHIDEKT_URL = 'https://archidekt.com/decks/1/fun_with_fungus';
const ARCHIDEKT_API = 'https://archidekt.com/api/decks/1/';
const MOXFIELD_URL = 'https://www.moxfield.com/decks/AbCd_12EfGh';
const MOXFIELD_API = 'https://api2.moxfield.com/v2/decks/all/AbCd_12EfGh';
const EXPECTED_ARCHIDEKT_UA = 'ProvingGrounds/0.1 (+https://github.com/currentsbtw/proving-grounds)';
const WHITELISTED_UA = 'ProvingGroundsTest/1.0 (whitelisted)';

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const failures: string[] = [];
let checked = 0;

function check(label: string, condition: boolean, detail = ''): void {
  checked += 1;
  if (!condition) failures.push(detail ? `${label} — ${detail}` : label);
}

function checkEqual(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(label, a === b, `got ${a}, expected ${b}`);
}

// ---------------------------------------------------------------------------
// A staged upstream
// ---------------------------------------------------------------------------

interface Seen {
  url: string;
  userAgent: string | null;
  accept: string | null;
  method: string;
}

/** What one staged request answers with: a status, a body, or a thrown error. */
type Stage =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'text'; status: number; body: string }
  | { kind: 'throw'; error: Error };

function stagedFetch(stage: Stage, seen: Seen[]): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: String(input),
      userAgent: headers.get('user-agent'),
      accept: headers.get('accept'),
      method: init?.method ?? 'GET',
    });
    if (stage.kind === 'throw') return Promise.reject(stage.error);
    const body = stage.kind === 'json' ? JSON.stringify(stage.body) : stage.body;
    const type = stage.kind === 'json' ? 'application/json' : 'text/html';
    return Promise.resolve(
      new Response(body, { status: stage.status, headers: { 'content-type': type } }),
    );
  }) as typeof fetch;
}

/** One staged call: the outcome, and every request it made on the way. */
async function run(
  url: string,
  stage: Stage,
  moxfieldUserAgent?: string,
): Promise<{ result: DeckFetchOutcome; seen: Seen[] }> {
  const seen: Seen[] = [];
  const result = await fetchDeck(url, {
    fetchImpl: stagedFetch(stage, seen),
    moxfieldUserAgent,
  });
  return { result, seen };
}

function statusOf(result: DeckFetchOutcome): number {
  return result.status;
}

function codeOf(result: DeckFetchOutcome): string {
  return result.status === 200 ? 'ok' : result.code;
}

// ---------------------------------------------------------------------------
// A — Archidekt
// ---------------------------------------------------------------------------

const ARCHIDEKT_JSON = fixture('archidekt-deck-1.json');
const MOXFIELD_JSON = fixture('moxfield-deck-v2.json');

/** A response stating 0 copies of a card, which is a card the deck does not run. */
const ARCHIDEKT_ZERO_COPIES = {
  name: 'Zero Copies',
  categories: [{ name: 'Commander', isPremier: true, includedInDeck: true }],
  cards: [
    { quantity: 0, categories: [], card: { oracleCard: { name: 'Sol Ring' } } },
    { quantity: 2, categories: [], card: { oracleCard: { name: 'Llanowar Elves' } } },
  ],
};

/** A response carrying a board this reader was never written for, plus a 0-copy row. */
const MOXFIELD_UNKNOWN_BOARD = {
  name: 'Signature Deck',
  boards: {
    commanders: { cards: { a1: { quantity: 1, card: { name: 'Thelon of Havenwood' } } } },
    mainboard: {
      cards: {
        b2: { quantity: 0, card: { name: 'Sol Ring' } },
        c3: { quantity: 1, card: { name: 'Forest' } },
      },
    },
    signatureSpells: { cards: { d4: { quantity: 1, card: { name: 'Ancestral Recall' } } } },
  },
};

async function checkArchidekt(): Promise<string[]> {
  const lines: string[] = [];

  const ok = await run(ARCHIDEKT_URL, { kind: 'json', status: 200, body: ARCHIDEKT_JSON });
  checkEqual('archidekt 200: status', statusOf(ok.result), 200);
  if (ok.result.status === 200) {
    const deck = ok.result.deck;
    checkEqual('archidekt 200: deck name', deck.name, 'Fun With Fungus');
    checkEqual('archidekt 200: entries', deck.entries.length, 17);
    checkEqual('archidekt 200: site', deck.site, 'archidekt');
    checkEqual('archidekt 200: canonical url', deck.url, 'https://archidekt.com/decks/1');
    checkEqual(
      'archidekt 200: commander',
      deck.entries.filter((e) => e.isCommander).map((e) => e.name),
      ['Thelon of Havenwood'],
    );
    checkEqual('archidekt 200: no warnings', deck.warnings, []);
    lines.push(`200  "${deck.name}" — ${deck.entries.length} entries`);
  }

  const cases: { label: string; stage: Stage; status: number; code: string }[] = [
    { label: '403 (private)', stage: { kind: 'json', status: 403, body: {} }, status: 404, code: 'not_found' },
    { label: '404 (missing)', stage: { kind: 'json', status: 404, body: {} }, status: 404, code: 'not_found' },
    { label: '429 (rate limit)', stage: { kind: 'json', status: 429, body: {} }, status: 429, code: 'rate_limited' },
    { label: '500 (upstream)', stage: { kind: 'json', status: 500, body: {} }, status: 502, code: 'upstream' },
    { label: 'network throw', stage: { kind: 'throw', error: new TypeError('fetch failed') }, status: 502, code: 'upstream' },
    { label: 'abort (timeout)', stage: { kind: 'throw', error: new DOMException('aborted', 'AbortError') }, status: 502, code: 'upstream' },
    { label: '200 that is not JSON', stage: { kind: 'text', status: 200, body: '<html>nope</html>' }, status: 502, code: 'upstream' },
  ];

  for (const item of cases) {
    const { result } = await run(ARCHIDEKT_URL, item.stage);
    checkEqual(`archidekt ${item.label}: status`, statusOf(result), item.status);
    checkEqual(`archidekt ${item.label}: code`, codeOf(result), item.code);
    check(
      `archidekt ${item.label}: says something`,
      result.status === 200 || result.message.length > 10,
      JSON.stringify(result),
    );
    lines.push(`${String(item.status).padEnd(4)} ${item.label} → ${codeOf(result)}`);
  }

  // A 200 is not automatically a deck the player asked for: a row stating 0
  // copies is a card the deck does not run, and importing it as one copy would
  // hand back a deck that never existed.
  const zero = await run(ARCHIDEKT_URL, { kind: 'json', status: 200, body: ARCHIDEKT_ZERO_COPIES });
  checkEqual('archidekt 0-copy row: status', statusOf(zero.result), 200);
  if (zero.result.status === 200) {
    const deck = zero.result.deck;
    checkEqual('archidekt 0-copy row: entries', deck.entries.map((e) => e.name), ['Llanowar Elves']);
    checkEqual('archidekt 0-copy row: copies', deck.entries[0]?.qty, 2);
    checkEqual('archidekt 0-copy row: warning', deck.warnings, [
      'Skipped 1 Archidekt row listing 0 copies',
    ]);
    lines.push(`200  a row stating 0 copies → ${deck.warnings.join(' / ')}`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// B — Moxfield
// ---------------------------------------------------------------------------

async function checkMoxfield(): Promise<string[]> {
  const lines: string[] = [];

  // No user agent: the read is not attempted, because Moxfield would refuse it.
  const none = await run(MOXFIELD_URL, { kind: 'json', status: 200, body: MOXFIELD_JSON });
  checkEqual('moxfield with no user agent: status', statusOf(none.result), 501);
  checkEqual('moxfield with no user agent: code', codeOf(none.result), 'no_fetcher');
  checkEqual('moxfield with no user agent: makes no request', none.seen.length, 0);
  lines.push(`501  no user agent configured → ${codeOf(none.result)} (0 requests made)`);

  // An empty string is no user agent, not a user agent.
  const blank = await run(MOXFIELD_URL, { kind: 'json', status: 200, body: MOXFIELD_JSON }, '   ');
  checkEqual('moxfield with a blank user agent: status', statusOf(blank.result), 501);
  checkEqual('moxfield with a blank user agent: makes no request', blank.seen.length, 0);

  const ok = await run(MOXFIELD_URL, { kind: 'json', status: 200, body: MOXFIELD_JSON }, WHITELISTED_UA);
  checkEqual('moxfield 200: status', statusOf(ok.result), 200);
  if (ok.result.status === 200) {
    const deck = ok.result.deck;
    checkEqual('moxfield 200: deck name', deck.name, 'Thelon Spore Engine');
    checkEqual('moxfield 200: site', deck.site, 'moxfield');
    checkEqual('moxfield 200: entries', deck.entries.length, 7);
    checkEqual(
      'moxfield 200: commander',
      deck.entries.filter((e) => e.isCommander).map((e) => e.name),
      ['Thelon of Havenwood'],
    );
    lines.push(`200  "${deck.name}" — ${deck.entries.length} entries`);
  }

  const cases: { label: string; stage: Stage; status: number; code: string }[] = [
    { label: '403 (bot check)', stage: { kind: 'text', status: 403, body: 'blocked' }, status: 502, code: 'blocked' },
    { label: '404 (private)', stage: { kind: 'json', status: 404, body: {} }, status: 404, code: 'not_found' },
    { label: '429 (rate limit)', stage: { kind: 'json', status: 429, body: {} }, status: 429, code: 'rate_limited' },
    { label: 'network throw', stage: { kind: 'throw', error: new TypeError('fetch failed') }, status: 502, code: 'upstream' },
  ];

  for (const item of cases) {
    const { result } = await run(MOXFIELD_URL, item.stage, WHITELISTED_UA);
    checkEqual(`moxfield ${item.label}: status`, statusOf(result), item.status);
    checkEqual(`moxfield ${item.label}: code`, codeOf(result), item.code);
    lines.push(`${String(item.status).padEnd(4)} ${item.label} → ${codeOf(result)}`);
  }

  // The Moxfield shape was written from documentation, never from a capture, so
  // a board the reader does not know has to arrive as a warning rather than as
  // a silent hole in the deck.
  const unknown = await run(
    MOXFIELD_URL,
    { kind: 'json', status: 200, body: MOXFIELD_UNKNOWN_BOARD },
    WHITELISTED_UA,
  );
  if (unknown.result.status === 200) {
    const deck = unknown.result.deck;
    checkEqual('moxfield unknown board: entries', deck.entries.map((e) => e.name), [
      'Thelon of Havenwood',
      'Forest',
    ]);
    check(
      'moxfield unknown board: names the board it ignored',
      deck.warnings.includes('Ignored Moxfield board: signatureSpells'),
      deck.warnings.join(' / '),
    );
    check(
      'moxfield unknown board: reports the 0-copy row',
      deck.warnings.includes('Skipped 1 Moxfield row listing 0 copies'),
      deck.warnings.join(' / '),
    );
    lines.push(`200  an unknown board and a 0-copy row → ${deck.warnings.join(' / ')}`);
  } else {
    check('moxfield unknown board: status', false, JSON.stringify(unknown.result));
  }

  return lines;
}

// ---------------------------------------------------------------------------
// C — the requests
// ---------------------------------------------------------------------------

async function checkRequests(): Promise<string[]> {
  const lines: string[] = [];

  const arch = await run(ARCHIDEKT_URL, { kind: 'json', status: 200, body: ARCHIDEKT_JSON });
  checkEqual('archidekt makes exactly one request', arch.seen.length, 1);
  const archReq = arch.seen[0];
  checkEqual('archidekt request url', archReq?.url, ARCHIDEKT_API);
  checkEqual('archidekt request method', archReq?.method, 'GET');
  checkEqual('archidekt request accept', archReq?.accept, 'application/json');
  checkEqual('archidekt request user agent', archReq?.userAgent, EXPECTED_ARCHIDEKT_UA);
  lines.push(`archidekt  ${archReq?.method} ${archReq?.url}`);
  lines.push(`           user-agent: ${archReq?.userAgent}`);

  const mox = await run(MOXFIELD_URL, { kind: 'json', status: 200, body: MOXFIELD_JSON }, WHITELISTED_UA);
  checkEqual('moxfield makes exactly one request', mox.seen.length, 1);
  const moxReq = mox.seen[0];
  checkEqual('moxfield request url', moxReq?.url, MOXFIELD_API);
  checkEqual('moxfield request accept', moxReq?.accept, 'application/json');
  checkEqual('moxfield carries the configured user agent', moxReq?.userAgent, WHITELISTED_UA);
  check(
    'moxfield does not fall back to the archidekt user agent',
    moxReq?.userAgent !== EXPECTED_ARCHIDEKT_UA,
    String(moxReq?.userAgent),
  );
  lines.push(`moxfield   ${moxReq?.method} ${moxReq?.url}`);
  lines.push(`           user-agent: ${moxReq?.userAgent}`);

  return lines;
}

// ---------------------------------------------------------------------------
// D — links that are not deck links
// ---------------------------------------------------------------------------

const BAD_URLS = [
  'https://scryfall.com/card/tsp/227/thelon-of-havenwood',
  'https://www.moxfield.com/users/gategeek42',
  'https://archidekt.com/decks/not-a-number',
  '1 Sol Ring',
  '',
];

async function checkBadUrls(): Promise<string[]> {
  const lines: string[] = [];
  for (const url of BAD_URLS) {
    const { result, seen } = await run(url, { kind: 'json', status: 200, body: ARCHIDEKT_JSON });
    checkEqual(`bad url "${url}": status`, statusOf(result), 400);
    checkEqual(`bad url "${url}": code`, codeOf(result), 'bad_url');
    checkEqual(`bad url "${url}": fetches nothing`, seen.length, 0);
    lines.push(`400  ${url || '(empty)'} → bad_url`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// E — the sentence each outcome becomes
// ---------------------------------------------------------------------------

/**
 * The status and the code are the whole contract between this module and the
 * form, so every failure it can produce is run through the sentence the player
 * will read. The Worker's own `bad_route` is checked here too: it never comes
 * out of `fetchDeck` — the Worker answers it before calling in — and the point
 * of it is that it must not read as a missing deck.
 */
async function checkSentences(): Promise<string[]> {
  const lines: string[] = [];

  const cases: { site: DeckSite; url: string; stage: Stage; ua?: string }[] = [
    { site: 'archidekt', url: ARCHIDEKT_URL, stage: { kind: 'json', status: 404, body: {} } },
    { site: 'archidekt', url: ARCHIDEKT_URL, stage: { kind: 'json', status: 429, body: {} } },
    { site: 'archidekt', url: ARCHIDEKT_URL, stage: { kind: 'throw', error: new TypeError('fetch failed') } },
    { site: 'archidekt', url: 'https://archidekt.com/decks/not-a-number', stage: { kind: 'json', status: 200, body: {} } },
    { site: 'moxfield', url: MOXFIELD_URL, stage: { kind: 'json', status: 200, body: MOXFIELD_JSON } },
    { site: 'moxfield', url: MOXFIELD_URL, stage: { kind: 'text', status: 403, body: 'blocked' }, ua: WHITELISTED_UA },
  ];

  for (const item of cases) {
    const { result } = await run(item.url, item.stage, item.ua);
    if (result.status === 200) continue;
    const sentence = describeDeckFetchError(item.site, result.status, result.code);
    check(`${result.status} ${result.code}: says something`, sentence.length > 20, sentence);
    check(`${result.status} ${result.code}: ends in a full stop`, sentence.endsWith('.'), sentence);
    lines.push(`${String(result.status).padEnd(4)} ${result.code.padEnd(12)} ${sentence}`);
  }

  // 501 `no_fetcher` is this build being unable to ask; the Worker's 501
  // `bad_route` is the fetcher not serving the path it was given. Neither is a
  // deck that does not exist, and they do not read alike.
  const noFetcher = describeDeckFetchError('moxfield', 501, 'no_fetcher');
  const badRoute = describeDeckFetchError('moxfield', 501, 'bad_route');
  check('501 no_fetcher tells the player to export', noFetcher.includes('Export'), noFetcher);
  check('501 bad_route blames the fetcher', badRoute.includes('fetcher'), badRoute);
  check('the two 501s do not read alike', noFetcher !== badRoute);
  check(
    'neither 501 reads as a missing deck',
    noFetcher !== describeDeckFetchError('moxfield', 404) &&
      badRoute !== describeDeckFetchError('moxfield', 404),
  );
  lines.push(`501  bad_route    ${badRoute}`);

  return lines;
}

// ---------------------------------------------------------------------------
// F — one live read, opt-in
// ---------------------------------------------------------------------------

async function checkLive(): Promise<string[]> {
  const result = await fetchDeck(ARCHIDEKT_URL);
  checkEqual('live archidekt: status', statusOf(result), 200);
  if (result.status !== 200) {
    return [`live archidekt FAILED — ${statusOf(result)} ${codeOf(result)}: ${result.message}`];
  }
  const deck = result.deck;
  checkEqual('live archidekt: deck name', deck.name, 'Fun With Fungus');
  checkEqual(
    'live archidekt: commander',
    deck.entries.filter((e) => e.isCommander).map((e) => e.name),
    ['Thelon of Havenwood'],
  );
  check('live archidekt: has cards', deck.entries.length > 0, String(deck.entries.length));
  return [
    `live  "${deck.name}" — ${deck.entries.length} entries, commander ${deck.entries
      .filter((e) => e.isCommander)
      .map((e) => e.name)
      .join(', ')}`,
  ];
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const archLines = await checkArchidekt();
  const moxLines = await checkMoxfield();
  const requestLines = await checkRequests();
  const badLines = await checkBadUrls();
  const sentenceLines = await checkSentences();
  const liveLines = process.env.LIVE === '1' ? await checkLive() : [];

  console.log('\nverify:deck-fetch');
  console.log('─'.repeat(76));
  console.log('archidekt');
  for (const line of archLines) console.log(`  ${line}`);
  console.log('─'.repeat(76));
  console.log('moxfield');
  for (const line of moxLines) console.log(`  ${line}`);
  console.log('─'.repeat(76));
  console.log('requests');
  for (const line of requestLines) console.log(`  ${line}`);
  console.log('─'.repeat(76));
  console.log('not a deck link');
  for (const line of badLines) console.log(`  ${line}`);
  console.log('─'.repeat(76));
  console.log('what the form will say');
  for (const line of sentenceLines) console.log(`  ${line}`);
  console.log('─'.repeat(76));
  if (liveLines.length > 0) {
    console.log('live (LIVE=1)');
    for (const line of liveLines) console.log(`  ${line}`);
  } else {
    console.log('live  skipped — set LIVE=1 to read Archidekt deck 1 for real');
  }
  console.log('─'.repeat(76));

  if (failures.length > 0) {
    console.log(`${failures.length} of ${checked} check(s) FAILED:`);
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    throw new Error(`${failures.length} deck-fetch check(s) failed`);
  }
  console.log(`all ${checked} checks passed`);
}

await main();
