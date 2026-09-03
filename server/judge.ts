/**
 * Local proxy for the advisory judge.
 *
 *   npm run judge
 *
 * It exists for one reason: the browser must never hold an API key. The SPA
 * stays a static build, Vite proxies `/api` here during `npm run dev`, and the
 * key lives only in this process's environment (it is never read into a variable
 * that anything prints). Plain node:http, no framework: two routes.
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
import { type Corpus, corpusExists, loadCorpus } from './judge/corpus.ts';
import { askJudge, JudgeBadRequestError } from './judge/core.ts';
import { ModelAuthError, ModelUpstreamError } from './judge/model.ts';
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

/**
 * The 503 for "reached nothing usable", worded for whichever driver is running.
 * The api driver wants a key in the environment; the claude-code driver wants a
 * login the player performs once, in a terminal, and never thinks about again.
 */
function failNoCredentials(res: ServerResponse): string {
  return driver === 'claude-code'
    ? fail(
        res,
        503,
        'no_login',
        'Judge is not logged in. Run claude /login once in a terminal, then ask again.',
      )
    : fail(res, 503, 'no_key', "No ANTHROPIC_API_KEY in the judge's environment.");
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
    // A driver that could not authenticate is the one failure the player can
    // fix, so it keeps its own code and its own sentence.
    if (err instanceof ModelAuthError) return failNoCredentials(res);
    if (err instanceof JudgeBadRequestError) return fail(res, 400, 'bad_request', err.message);
    if (err instanceof ModelUpstreamError) return fail(res, 502, 'upstream', err.message);
    // Rate limits, 5xx, a dead socket: the driver passed them through as-is.
    return fail(res, 502, 'upstream', (err as Error).message);
  } finally {
    clearTimeout(cap);
  }
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
