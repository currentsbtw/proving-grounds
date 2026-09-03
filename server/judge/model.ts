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
export class ModelAuthError extends Error {}
/** The model was reached but did not answer usably (refusal, bad JSON, CLI error). */
export class ModelUpstreamError extends Error {}

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
