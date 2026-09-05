/**
 * Local proxy for the advisory judge, and the fetcher for deck links.
 *
 *   npm run judge
 *
 * The judge half exists for one reason: the browser must never hold an API key.
 * The SPA stays a static build, Vite proxies `/api` here during `npm run dev`,
 * and the key lives only in this process's environment (it is never read into a
 * variable that anything prints). Plain node:http, no framework.
 *
 * The deck half is here because it needs the same thing for a different reason:
 * Archidekt's CORS names one origin that is not ours and Moxfield's API is bot-
 * gated, so a link has to be read off-page. `GET /api/deck` needs no credentials
 * at all — the route is served from the moment the socket is up, before the
 * credential probe resolves — so `npm run judge` with no key set is still a
 * working deck fetcher and the judge simply reports itself offline.
 *
 * The corpus is loaded once at startup because it is a megabyte of text that
 * every request needs and none of them changes.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type {
  JudgeError,
  JudgeErrorCode,
  JudgeGrounding,
  JudgeHealth,
  JudgeRequest,
} from '../src/domain/judge.ts';
import { JUDGE_ENDPOINT, JUDGE_HEALTH_ENDPOINT, JUDGE_PORT } from '../src/domain/judge.ts';
import { DECK_FETCH_ENDPOINT, fetchDeck } from './deckFetch.ts';
import { type Corpus, corpusExists, loadCorpus } from './judge/corpus.ts';
import { askJudge, JudgeBadRequestError } from './judge/core.ts';
import { classifyModelFailure } from './judge/model.ts';
import { probeDriver, selectDriver } from './judge/drivers/index.ts';

const MAX_BODY_BYTES = 256 * 1024;

/**
 * Ceiling on one question, both passes together. The client waits a little
 * longer than this (160s), so a slow answer is reported by the proxy with a
 * reason rather than by the drawer as a silence.
 */
const ANSWER_TIMEOUT_MS = 150_000;

let corpus: Corpus | null = null;
if (corpusExists()) {
  corpus = loadCorpus();
  console.log(`Corpus effective ${corpus.effectiveDate}, ${corpus.rules.size} rules loaded.`);
} else {
  console.log('No Comprehensive Rules text found. Run npm run judge:corpus first.');
}

// Which driver answers, chosen once. The credential itself never passes through
// this file: the api driver holds the SDK client, the claude-code driver spawns
// a CLI that owns its own login.
const { driver, model, reason } = selectDriver();

/**
 * How much of the rules text the model reads per question. `retrieval` sends the
 * rules a question actually needs and is the default; `full` sends the corpus,
 * which only the api driver can cache and only Console credits pay for.
 *
 * Read the way `JUDGE_DRIVER` is: case-insensitively, and a value that is not a
 * mode says so instead of silently becoming the default.
 */
function selectGrounding(): JudgeGrounding {
  const raw = process.env.JUDGE_GROUNDING?.trim();
  if (raw === undefined || raw === '') return 'retrieval';
  const mode = raw.toLowerCase();
  if (mode === 'full' || mode === 'retrieval') return mode;
  console.warn(`JUDGE_GROUNDING="${raw}" is not a grounding mode; using retrieval.`);
  return 'retrieval';
}

const grounding: JudgeGrounding = selectGrounding();

/**
 * Whether this process can reach its model, resolved once at startup: true,
 * false, or null for "could not tell" (the network was down when we asked, which
 * is not the same as having no key). For claude-code it means the CLI was found
 * and reports itself logged in, so the drawer is right before the first question
 * rather than after it.
 */
let hasKey: boolean | null = null;

/** The oversize body case, kept apart so the handler can answer before it drops the socket. */
class BodyTooLargeError extends JudgeBadRequestError {}

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function fail(res: ServerResponse, status: number, code: JudgeErrorCode, error: string) {
  send(res, status, { error, code } satisfies JudgeError);
  return code;
}

/**
 * The same `{ error, code }` body as `fail`, for the deck route's own codes.
 * They are not `JudgeErrorCode`s -- a deck read knows nothing about drivers or
 * corpora -- so they get their own helper rather than widening that union.
 */
function failDeck(res: ServerResponse, status: number, code: string, error: string) {
  send(res, status, { error, code });
  return `${status} ${code}`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop reading, but leave the socket alone: destroying it here means the
        // client sees a reset instead of the 400, and the drawer reports that as
        // "offline". The handler writes the error first, then drops the rest.
        req.pause();
        reject(new BodyTooLargeError('Question and table are too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleAsk(req: IncomingMessage, res: ServerResponse): Promise<string> {
  if (!corpus) {
    return fail(res, 503, 'no_corpus', 'Run npm run judge:corpus first.');
  }

  let body: JudgeRequest;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw) as JudgeRequest;
  } catch (err) {
    const why = err instanceof JudgeBadRequestError ? err.message : 'Body is not valid JSON.';
    const code = fail(res, 400, 'bad_request', why);
    if (err instanceof BodyTooLargeError) {
      // The 400 is written; only now is the rest of the oversize body dropped.
      if (res.writableFinished) req.destroy();
      else res.on('finish', () => req.destroy());
    }
    return code;
  }
  if (typeof body?.question !== 'string') {
    return fail(res, 400, 'bad_request', 'Body needs a question string.');
  }

  // One controller for the whole question, both passes. It is aborted when the
  // player closes the drawer (the socket closes) and when the answer outlives
  // its cap; either way the driver stops paying for an answer nobody reads.
  const control = new AbortController();
  let clientGone = false;
  let timedOut = false;
  const cap = setTimeout(() => {
    timedOut = true;
    control.abort();
  }, ANSWER_TIMEOUT_MS);
  // The response's close, not the request's. A fully received request emits
  // 'close' as soon as its body has been read, which is before the model is even
  // called; the response emits it when the socket goes away, which is the event
  // that actually means the player is no longer waiting.
  res.on('close', () => {
    if (res.writableEnded) return;
    clientGone = true;
    control.abort();
  });

  try {
    const answer = await askJudge(body, { model, corpus, grounding, signal: control.signal });
    if (clientGone) return 'abandoned';
    send(res, 200, answer);
    const u = answer.usage;
    return `${answer.status} in=${u?.inputTokens ?? 0} out=${u?.outputTokens ?? 0} cacheRead=${u?.cacheRead ?? 0} cacheWrite=${u?.cacheWrite ?? 0}`;
  } catch (err) {
    // Nobody is listening: the abort was ours, and writing to a closed socket
    // would only log a second failure.
    if (clientGone) return 'abandoned';
    if (timedOut) {
      return fail(res, 504, 'upstream', `No answer within ${ANSWER_TIMEOUT_MS / 1000}s.`);
    }
    // A failure the driver named -- no credentials, no usage left, nothing
    // usable back -- has its own code and its own sentence, worded for whichever
    // driver is running. `classifyModelFailure` owns that mapping so the harness
    // can check it without starting a server.
    const failure = classifyModelFailure(err, driver);
    if (failure) return fail(res, failure.status, failure.code, failure.error);
    if (err instanceof JudgeBadRequestError) return fail(res, 400, 'bad_request', err.message);
    // 5xx, a dead socket, anything else: the driver passed them through as-is.
    return fail(res, 502, 'upstream', (err as Error).message);
  } finally {
    clearTimeout(cap);
  }
}

/**
 * `GET /api/deck?url=<deck link>`: the link is read off-page and the normalised
 * deck comes back verbatim, because the client and this route share
 * `src/domain/deckUrl.ts` and there is nothing left to translate.
 *
 * No credentials are involved. `MOXFIELD_USER_AGENT` is the one piece of
 * configuration, and without it a Moxfield link answers 501 (this build has no
 * fetcher for that site) rather than pretending the read failed.
 */
async function handleDeck(req: IncomingMessage, res: ServerResponse): Promise<string> {
  const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
  const link = query.get('url');
  if (!link) return failDeck(res, 400, 'bad_url', 'Pass a deck link as ?url=.');

  // A player who closes the form should not leave a read running upstream.
  const control = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) control.abort();
  });

  const result = await fetchDeck(link, {
    moxfieldUserAgent: process.env.MOXFIELD_USER_AGENT,
    signal: control.signal,
  });

  if (result.status === 200) {
    if (res.writableEnded) return 'abandoned';
    send(res, 200, result.deck);
    // The site and the count, never the deck: a decklist is the player's.
    return `200 ${result.deck.site} ${result.deck.entries.length} entries`;
  }
  if (res.writableEnded) return 'abandoned';
  return failDeck(res, result.status, result.code, result.message);
}

const server = createServer((req, res) => {
  const started = Date.now();
  const url = (req.url ?? '').split('?')[0];
  const route = `${req.method} ${url}`;

  const done = (note: string) => {
    // Never log the question: it can carry the player's whole decklist.
    console.log(`${route} ${note} ${Date.now() - started}ms`);
  };

  if (req.method === 'GET' && url === JUDGE_HEALTH_ENDPOINT) {
    // `null` (never resolved, or the check itself could not reach the API) is
    // reported as false: the drawer only has room for "usable" or "not yet".
    const health: JudgeHealth = {
      ok: Boolean(corpus) && hasKey === true,
      hasKey: hasKey === true,
      corpusDate: corpus?.effectiveDate ?? null,
      model: model.defaultModel,
      driver,
      grounding,
    };
    send(res, 200, health);
    done('ok');
    return;
  }

  if (req.method === 'GET' && url === DECK_FETCH_ENDPOINT) {
    handleDeck(req, res).then(done, (err: Error) => {
      if (!res.headersSent) failDeck(res, 502, 'upstream', err.message);
      done('crashed');
    });
    return;
  }

  if (req.method === 'POST' && url === JUDGE_ENDPOINT) {
    handleAsk(req, res).then(done, (err: Error) => {
      if (!res.headersSent) fail(res, 502, 'upstream', err.message);
      done('crashed');
    });
    return;
  }

  fail(res, 404, 'bad_request', 'No such route.');
  done('404');
});

// Loopback only, explicitly. The default binds every interface, which would put
// a process holding an API key on the LAN.
server.listen(JUDGE_PORT, '127.0.0.1', () => {
  console.log(`Judge listening on http://127.0.0.1:${JUDGE_PORT} (checking credentials).`);
  console.log(`Driver ${driver} (${reason}), model ${model.defaultModel}, grounding ${grounding}.`);
  // Never the value, only whether there is one.
  const moxfield = process.env.MOXFIELD_USER_AGENT?.trim()
    ? 'Moxfield user agent set'
    : 'Moxfield needs MOXFIELD_USER_AGENT';
  console.log(`Deck links at ${DECK_FETCH_ENDPOINT}, no credentials needed (${moxfield}).`);
});

// Resolved after listen so the port is up straight away; health reports
// hasKey false until the answer lands, which is the safe way round.
void probeDriver(driver).then((result) => {
  hasKey = result;
  const note =
    result === true
      ? driver === 'claude-code'
        ? 'Claude Code CLI is logged in'
        : 'present'
      : result === false
        ? driver === 'claude-code'
          ? 'no Claude Code CLI, or it is not logged in (run claude auth login once)'
          : 'missing'
        : 'unknown (could not reach the API)';
  console.log(`Credentials ${note}.`);
});
