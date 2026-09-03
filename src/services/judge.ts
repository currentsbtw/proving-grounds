import {
  JUDGE_ENDPOINT,
  JUDGE_HEALTH_ENDPOINT,
  type JudgeErrorCode,
  type JudgeHealth,
  type JudgeRequest,
  type JudgeResponse,
} from '../domain/judge';

/**
 * The client half of the advisory judge: one POST, one health check, and a
 * typed failure for every way the local proxy can be unavailable. Nothing here
 * interprets an answer — the panel prints what came back, and the player decides
 * what to do about it.
 */

/**
 * A model answer can take a while; the drawer says so and waits. The proxy caps
 * a question at 150 s and cancels its own work when the browser aborts, so this
 * sits just past that: the server's own timeout is the one that gets to speak.
 */
const ASK_TIMEOUT_MS = 160_000;
/** The health line is a head, not an answer: it gives up quickly and reads offline. */
const HEALTH_TIMEOUT_MS = 4_000;

/**
 * One sentence per code. These are the words the drawer prints, so they live
 * beside the codes rather than in the view: the same sentence has to read the
 * same whether it arrived as a thrown error or as a health check.
 */
const MESSAGES: Record<JudgeErrorCode, string> = {
  offline: 'Judge offline. Start it with npm run judge.',
  no_key: 'Judge has no API key. Set ANTHROPIC_API_KEY where npm run judge runs.',
  no_login: 'Judge is not logged in. Run claude /login once, then ask again.',
  no_corpus: 'Judge has no rules text. Run npm run judge:corpus.',
  upstream: 'The judge could not answer. Ask again.',
  bad_request: 'The judge could not read that question.',
};

export function judgeErrorSentence(code: JudgeErrorCode): string {
  return MESSAGES[code];
}

/** Everything `askJudge` throws. The code is what the drawer renders on. */
export class JudgeServiceError extends Error {
  readonly code: JudgeErrorCode;

  constructor(code: JudgeErrorCode, message?: string) {
    super(message ?? MESSAGES[code]);
    this.name = 'JudgeServiceError';
    this.code = code;
  }
}

/** Body as JSON, or undefined when it was not JSON at all. */
async function readJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isErrorCode(value: unknown): value is JudgeErrorCode {
  return typeof value === 'string' && value in MESSAGES;
}

/** A `JudgeError` the proxy meant to send, as opposed to whatever Vite said. */
function errorCodeOf(body: unknown): JudgeErrorCode | null {
  if (!isRecord(body)) return null;
  return isErrorCode(body.code) ? body.code : null;
}

function isJudgeResponse(body: unknown): body is JudgeResponse {
  if (!isRecord(body)) return false;
  return (
    (body.status === 'answer' || body.status === 'decline') &&
    typeof body.answer === 'string' &&
    Array.isArray(body.rules) &&
    Array.isArray(body.caveats)
  );
}

/**
 * Every field the head reads, `driver` and `grounding` included. A body without
 * them came from a proxy older than this contract, and the head cannot say which
 * driver is answering or how it is grounded — so it is not a health report, and
 * the drawer prints the offline sentence, which is the honest state for a stale
 * proxy the player still has to restart.
 */
function isJudgeHealth(body: unknown): body is JudgeHealth {
  if (!isRecord(body)) return false;
  return (
    typeof body.ok === 'boolean' &&
    typeof body.hasKey === 'boolean' &&
    typeof body.model === 'string' &&
    (typeof body.corpusDate === 'string' || body.corpusDate === null) &&
    (body.driver === 'api' || body.driver === 'claude-code') &&
    (body.grounding === 'full' || body.grounding === 'retrieval')
  );
}

/**
 * Ask the local proxy a rules question.
 *
 * The proxy not running is the common case, and it does not surface as a
 * network error: Vite answers the dead `/api` upstream itself, with a 500 and a
 * plain-text body. So anything that fails to reach a `JudgeError` shaped body —
 * a thrown fetch, a non-JSON body, an unrecognised code — reads as `offline`,
 * which is the one state the player can fix from the drawer's own sentence.
 */
export async function askJudge(req: JudgeRequest): Promise<JudgeResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ASK_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(JUDGE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
  } catch {
    throw new JudgeServiceError(
      timedOut ? 'upstream' : 'offline',
      timedOut ? 'The judge took too long. Ask again.' : undefined,
    );
  } finally {
    clearTimeout(timer);
  }

  const body = await readJson(res);

  if (!res.ok) {
    const code = errorCodeOf(body);
    if (!code) throw new JudgeServiceError('offline');
    // The proxy's own wording wins where it can say something the code cannot,
    // and the fixed sentence stands everywhere the player has an action to take.
    const detail = isRecord(body) && typeof body.error === 'string' ? body.error : '';
    const useDetail = detail !== '' && (code === 'upstream' || code === 'bad_request');
    throw new JudgeServiceError(code, useDetail ? detail : undefined);
  }

  if (!isJudgeResponse(body)) throw new JudgeServiceError('offline');
  return body;
}

/**
 * What the drawer's head is built from. Null for every failure, including a
 * proxy that is not running, so the caller has one thing to check.
 *
 * A body that reads as a health report is handed back whatever the status was:
 * a proxy that is up but keyless may say so with a 503, and "no API key" is a
 * more useful head than "offline".
 */
export async function judgeHealth(): Promise<JudgeHealth | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(JUDGE_HEALTH_ENDPOINT, { signal: controller.signal });
    const body = await readJson(res);
    return isJudgeHealth(body) ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
