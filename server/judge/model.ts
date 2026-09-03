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

import type { JudgeDriver, JudgeUsage } from '../../src/domain/judge.ts';

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
