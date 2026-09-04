/**
 * The paid path: the Anthropic SDK, billed to Console credits.
 *
 * This is the judge's original driver, lifted out of `core.ts` unchanged in
 * substance. It owns the only `Anthropic` client in the judge, so the SDK's
 * error types stay behind the `JudgeModel` seam and the proxy never has to know
 * which library answered.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

import {
  ModelAuthError,
  ModelLimitError,
  ModelUpstreamError,
  parseResetsAt,
  toJudgeUsage,
  type JudgeModel,
  type ModelRequest,
  type ModelResult,
  type SystemBlock,
} from '../model.ts';

export const API_DEFAULT_MODEL = 'claude-opus-5';

/**
 * The SDK raises a typed AuthenticationError once a request reaches the API. With
 * no credentials at all it never gets that far: the header check throws a plain
 * Error whose only distinguishing mark is its message, so the string match is the
 * fallback for that one case and not the primary test.
 */
export function isMissingCredentials(err: unknown): boolean {
  if (err instanceof Anthropic.AuthenticationError) return true;
  return err instanceof Error && err.message.includes('Could not resolve authentication method');
}

/**
 * A block asking to be cached becomes a 1h breakpoint. Only the corpus asks, so
 * the expensive half of the prompt is written once an hour and read thereafter.
 */
function toTextBlocks(system: SystemBlock[]): Anthropic.TextBlockParam[] {
  return system.map((block) =>
    block.cache
      ? { type: 'text', text: block.text, cache_control: { type: 'ephemeral', ttl: '1h' } }
      : { type: 'text', text: block.text },
  );
}

/**
 * Answer "can this process authenticate?", once, at startup.
 *
 * The env vars are conclusive on their own. Without them the zero-arg client may
 * still resolve a stored profile, which is why reading the environment alone used
 * to tell a profile user they had no key while their questions were answered
 * fine. The only honest test is a cheap authenticated call, so we make one.
 * `null` means the question stayed open (no network, a proxy, a 5xx).
 */
export async function probeApiCredentials(client?: Anthropic): Promise<boolean | null> {
  if (process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN) return true;
  try {
    await (client ?? new Anthropic()).models.list({ limit: 1 });
    return true;
  } catch (err) {
    if (isMissingCredentials(err)) return false;
    return null;
  }
}

export function createApiModel(opts?: { client?: Anthropic; model?: string }): JudgeModel {
  // Zero args on purpose: the SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN
  // or a stored profile itself, so no credential passes through this file.
  // The zero-arg client also keeps the SDK's default of two retries on 408, 409,
  // 429, 5xx and connection errors, so transient upstream failures are already
  // waited out here; the refresh-collision retry on the other driver has no
  // analogue on this one.
  const client = opts?.client ?? new Anthropic();
  const defaultModel = opts?.model ?? API_DEFAULT_MODEL;

  return {
    driver: 'api',
    defaultModel,
    async complete<T>(req: ModelRequest<T>): Promise<ModelResult<T>> {
      const model = defaultModel;

      // No server-side `fallbacks` here: a fallback turn does not carry the
      // parsed output that `messages.parse` exists to give us.
      let message;
      try {
        message = await client.messages.parse(
          {
            model,
            max_tokens: req.maxTokens,
            output_config: { effort: req.effort, format: zodOutputFormat(req.schema) },
            system: toTextBlocks(req.system),
            messages: [{ role: 'user', content: req.user }],
          },
          // The caller's abort reaches the socket, so a cancelled question stops
          // costing output tokens rather than finishing into a closed drawer.
          { signal: req.signal },
        );
      } catch (err) {
        if (isMissingCredentials(err)) {
          throw new ModelAuthError((err as Error).message);
        }
        // A 429 is the API's version of "nothing left to spend right now". It is
        // the same event as a spent plan window on the other driver, so it
        // crosses the seam as the same error and a batch caller stops on either.
        if (err instanceof Anthropic.RateLimitError) {
          throw new ModelLimitError(err.message, parseResetsAt(err.message));
        }
        // 5xx and the rest stay themselves: the proxy maps them.
        throw err;
      }

      // Check the stop reason before touching content: a refusal carries no answer.
      if (message.stop_reason === 'refusal') {
        const why = message.stop_details?.explanation ?? 'no explanation given';
        throw new ModelUpstreamError(`The judge declined to answer this request (${why}).`);
      }
      const parsed = message.parsed_output as T | null;
      if (!parsed) throw new ModelUpstreamError('The judge returned no parseable answer.');

      return { parsed, model: message.model || model, usage: toJudgeUsage(message.usage) };
    },
  };
}
