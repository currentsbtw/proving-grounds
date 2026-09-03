/**
 * The seam between the judge and whatever answers it. `askJudge` builds one
 * request (system blocks, user text, output schema) and hands it to a
 * `JudgeModel`; the driver decides how that reaches Claude and who is billed.
 *
 * Two drivers exist: `api` (the Anthropic SDK, pay-as-you-go credits) and
 * `claude-code` (the local Claude Code CLI in print mode, covered by the
 * player's own subscription). The judge, the prompt and the eval harness are
 * the same either way, so the cheap path today is the paid path later with one
 * environment variable changed.
 */
import type { z } from 'zod';

import type { JudgeDriver, JudgeErrorCode, JudgeUsage } from '../../src/domain/judge.ts';

export interface SystemBlock {
  text: string;
  /**
   * Mark the block as the stable, expensive prefix. The api driver turns this
   * into a 1h cache breakpoint; the claude-code driver has no such control and
   * ignores it.
   */
  cache?: boolean;
}

export interface ModelRequest<T> {
  system: SystemBlock[];
  user: string;
  schema: z.ZodType<T>;
  effort: 'low' | 'medium' | 'high';
  maxTokens: number;
  /**
   * Abandon the call. The proxy aborts when the player closes the drawer or the
   * request outlives its cap; the api driver hands this to the SDK and the
   * claude-code driver kills its child, so neither leaves a call running for an
   * answer nobody will read.
   */
  signal?: AbortSignal;
}

export interface ModelResult<T> {
  parsed: T;
  /** The model id that actually answered. */
  model: string;
  usage: JudgeUsage;
}

export interface JudgeModel {
  readonly driver: JudgeDriver;
  readonly defaultModel: string;
  complete<T>(req: ModelRequest<T>): Promise<ModelResult<T>>;
}

/**
 * Usage as every Anthropic surface spells it -- the SDK's `Usage` and the CLI's
 * JSON envelope use the same four snake_case names -- reduced to the four
 * numbers the response reports. One mapping, so a driver cannot quietly report
 * a cache read as a cache write.
 */
export function toJudgeUsage(raw?: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): JudgeUsage {
  return {
    inputTokens: raw?.input_tokens ?? 0,
    outputTokens: raw?.output_tokens ?? 0,
    cacheRead: raw?.cache_read_input_tokens ?? 0,
    cacheWrite: raw?.cache_creation_input_tokens ?? 0,
  };
}

/** No usable credentials or login for this driver; the proxy answers 503. */
export class ModelAuthError extends Error {
  /**
   * Why the credentials could not be used, when the sentence alone does not say
   * it. Only `TRANSIENT_STOP_CODE` is set today, by `withTransientRetry` after
   * every retry of a refresh collision was spent: the login was never wrong, so
   * a batch caller telling the player to log in again would send them to fix
   * something that is not broken.
   */
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}
/** The model was reached but did not answer usably (refusal, bad JSON, CLI error). */
export class ModelUpstreamError extends Error {}

/** `ModelAuthError.code` for a refresh collision that outlasted its retries. */
export const TRANSIENT_STOP_CODE = 'transient';

/**
 * What a cancelled call reports, in one place so that an abort during a retry
 * wait is indistinguishable from an abort during the call itself. The proxy
 * treats a cancelled question by its own `clientGone`/`timedOut` flags and never
 * reads this sentence, which is exactly why the two must not diverge.
 */
export const CANCELLED_MESSAGE = 'The question was cancelled before Claude Code answered.';

export function cancelledError(): ModelUpstreamError {
  return new ModelUpstreamError(CANCELLED_MESSAGE);
}

/**
 * A failure the caller is expected to wait out rather than record: the login is
 * good, the plan has usage left, and the same call a few seconds later normally
 * succeeds. Today there is one member, the CLI's OAuth refresh collision.
 *
 * A subtype of `ModelUpstreamError` on purpose. Only the driver's retry loop
 * treats it specially; anything that lets one escape -- a caller that does not
 * retry, a future driver -- keeps the old behaviour of a 502 upstream failure
 * rather than falling through `classifyModelFailure` unrecognised.
 */
export class ModelTransientError extends ModelUpstreamError {}

/**
 * Does this failure text say the CLI tripped over its own credential refresh?
 *
 * The wording seen on 2026-09-03 was "Failed to refresh OAuth token: another
 * Claude Code process is refreshing it or exited mid-refresh. This is usually
 * transient; retry in a minute". Every process on the machine shares one stored
 * OAuth token, so two Claude Code runs at once can collide on renewing it; the
 * CLI reports that the same way it reports a real failure, and a batch caller
 * that reads it as one burns its whole queue in seconds.
 *
 * Matched two ways, because the sentence is not ours to control: the distinctive
 * "another Claude Code process" clause, or "refresh" alongside "OAuth" or
 * "token". Narrower than `isLimitMessage` deliberately -- a false positive here
 * costs a wait and a retry of a call that was never going to work.
 */
export function isTransientAuthMessage(text: string): boolean {
  if (/another claude code process/i.test(text)) return true;
  return /\brefresh(?:ing|ed|es)?\b/i.test(text) && /\boauth\b|\btokens?\b/i.test(text);
}

/** Waits before retries 1, 2 and 3 of a transient failure. */
export const TRANSIENT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

export interface TransientRetryOptions {
  /** One wait per retry; its length is the retry count. Injectable so tests do not sleep. */
  delaysMs?: number[];
  /**
   * The wait itself. It is handed the signal so a cancelled call stops during
   * the wait rather than at the end of it; a substitute that ignores the signal
   * still works, it just waits out its own clock first.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Jitter source, `Math.random` by default. Injectable so tests get a fixed delay. */
  random?: () => number;
  signal?: AbortSignal;
  /** Called before each wait, for a harness that wants to say it is waiting. */
  onRetry?: (attempt: number, delayMs: number, message: string) => void;
}

/**
 * Sleep that ends the moment the signal fires, with the timer cleared and the
 * listener removed either way. A bare `setTimeout` would hold a cancelled
 * question open for the rest of its wait, which on the last retry is half a
 * minute of nobody waiting for the answer.
 */
const realSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

/**
 * One waiter at a time, process-wide. Concurrent callers hit the refresh
 * collision together, so unjittered waits of the same length would wake them
 * together and collide again; this chain makes each wait start where the last
 * one ended, which spreads the retries out on its own.
 *
 * A promise chain rather than a queue because there is nothing to schedule: a
 * waiter appends its own wait to the tail and awaits it, and the tail swallows
 * failures so an aborted waiter cannot strand the ones behind it.
 */
let retryGate: Promise<void> = Promise.resolve();

function waitInTurn(
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  const mine = retryGate.then(() => sleep(ms, signal));
  retryGate = mine.then(
    () => undefined,
    () => undefined,
  );
  return mine;
}

/** The delay for retry `i`, spread over `[base, 1.5 * base)`. */
export function jitteredDelay(base: number, random: () => number): number {
  return Math.round(base + random() * (base / 2));
}

/**
 * Run one model call, waiting out a transient credential-refresh collision.
 *
 * Anything that is not `ModelTransientError` is rethrown untouched on the first
 * attempt: a spent plan window and a missing login are both final, and retrying
 * either would only spend the wait. A transient failure that survives every
 * retry becomes a `ModelAuthError` carrying the CLI's own sentence and the code
 * `transient`, because by then the credentials genuinely cannot be renewed and a
 * batch caller has to stop and write what it has rather than mark the rest of
 * its queue errored -- but the code says the login itself was never the problem,
 * so the caller can word its stop as something a rerun fixes.
 *
 * A cancelled call ends as a cancelled call, not as an auth failure: the same
 * `cancelledError` the driver raises when the child is killed mid-answer, so the
 * proxy's `clientGone` and `timedOut` handling sees one shape either way.
 */
export async function withTransientRetry<T>(
  attempt: () => Promise<T>,
  opts?: TransientRetryOptions,
): Promise<T> {
  const delays = opts?.delaysMs ?? TRANSIENT_RETRY_DELAYS_MS;
  const sleep = opts?.sleep ?? realSleep;
  const random = opts?.random ?? Math.random;
  for (let i = 0; ; i += 1) {
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof ModelTransientError)) throw err;
      const message = err.message.trim();
      if (opts?.signal?.aborted) throw cancelledError();
      if (i >= delays.length) throw new ModelAuthError(message, TRANSIENT_STOP_CODE);
      const delay = jitteredDelay(delays[i], random);
      opts?.onRetry?.(i + 1, delay, message);
      await waitInTurn(sleep, delay, opts?.signal);
      if (opts?.signal?.aborted) throw cancelledError();
    }
  }
}

/**
 * The credentials are good and there is nothing left to spend: a Claude plan's
 * session window is used up, or the API is rate limiting. Distinct from
 * `ModelAuthError` because there is nothing to fix and nothing to retry now;
 * every later call fails the same way until the stated time.
 */
export class ModelLimitError extends Error {
  /**
   * When the limit lifts, exactly as the provider worded it (for example
   * `11:20pm (America/Los_Angeles)`). Free text on purpose: it is quoted back to
   * the player and never parsed into a date, because a wrong date read out of a
   * message is worse than the message.
   */
  readonly resetsAt?: string;

  constructor(message: string, resetsAt?: string) {
    super(message);
    this.resetsAt = resetsAt;
  }
}

/**
 * Does this failure text say the usage is spent rather than that the call went
 * wrong? The CLI reports a limit as prose and nothing else, so the sentence is
 * the only signal there is.
 *
 * Deliberately broad: any "limit", or any "resets" clause. It is only ever asked
 * about text the CLI has already flagged as a failure, so the cost of a false
 * positive is one failure reported as a limit, while the cost of a false
 * negative is a run that keeps dispatching calls no plan can answer. The
 * wordings differ by which limit was hit -- "session limit ... resets 11:20pm",
 * a weekly one that says "resets Nov 5" -- and neither is ours to predict.
 */
export function isLimitMessage(text: string): boolean {
  return /\blimits?\b/i.test(text) || /\bresets?\b/i.test(text);
}

/** The clause after "resets" in a limit message, or undefined when it has none. */
export function parseResetsAt(text: string): string | undefined {
  const hit = /\bresets?\s+(?:at\s+)?([^.\n]+)/i.exec(text);
  const value = hit?.[1]?.trim().replace(/[.,;·]+$/, '').trim();
  return value ? value : undefined;
}

/** One driver failure as the proxy answers it: an HTTP status, a code, a sentence. */
export interface ModelFailure {
  status: number;
  code: JudgeErrorCode;
  error: string;
}

/**
 * The proxy's error classification, kept here rather than in `server/judge.ts`
 * so it can be checked without starting a server. Returns null for anything that
 * did not come from a driver, which the caller still owns.
 */
export function classifyModelFailure(err: unknown, driver: JudgeDriver): ModelFailure | null {
  if (err instanceof ModelLimitError) {
    return {
      status: 503,
      code: 'limit',
      error: err.resetsAt
        ? `Judge is out of plan usage until ${err.resetsAt}.`
        : 'Judge is rate limited. Try again in a minute.',
    };
  }
  if (err instanceof ModelAuthError) {
    // The api driver wants a key in the environment; the claude-code driver wants
    // a login the player performs once, in a terminal, and never thinks about again.
    return driver === 'claude-code'
      ? {
          status: 503,
          code: 'no_login',
          error: 'Judge is not logged in. Run claude /login once in a terminal, then ask again.',
        }
      : { status: 503, code: 'no_key', error: "No ANTHROPIC_API_KEY in the judge's environment." };
  }
  if (err instanceof ModelUpstreamError) {
    return { status: 502, code: 'upstream', error: err.message };
  }
  return null;
}
