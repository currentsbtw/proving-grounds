/**
 * Which driver answers, and why.
 *
 * The default is chosen so the judge works without being configured: an API key
 * in the environment is an explicit statement that credits are available, so it
 * wins; otherwise a local CLI answers for free. When there is neither, the api
 * driver is still returned rather than nothing, because its `no_key` sentence is
 * the one that tells the player what to do about it.
 *
 * `JUDGE_DRIVER` overrides the choice, `JUDGE_MODEL` overrides the model id for
 * whichever driver runs.
 */
import type { JudgeDriver } from '../../../src/domain/judge.ts';
import type { JudgeModel } from '../model.ts';
import { createApiModel, probeApiCredentials } from './api.ts';
import { createClaudeCodeModel, findClaudeBinary, probeClaudeCode } from './claudeCode.ts';

export { createApiModel, probeApiCredentials } from './api.ts';
export { createClaudeCodeModel, findClaudeBinary, probeClaudeCode } from './claudeCode.ts';

export interface DriverChoice {
  driver: JudgeDriver;
  model: JudgeModel;
  /** One line for the startup log, saying what was chosen and what decided it. */
  reason: string;
}

function hasApiCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN);
}

export function selectDriver(): DriverChoice {
  const modelOverride = process.env.JUDGE_MODEL?.trim() || undefined;
  const requested = process.env.JUDGE_DRIVER?.trim().toLowerCase();

  const api = (reason: string): DriverChoice => ({
    driver: 'api',
    model: createApiModel({ model: modelOverride }),
    reason,
  });
  const claudeCode = (reason: string): DriverChoice => ({
    driver: 'claude-code',
    model: createClaudeCodeModel({ model: modelOverride }),
    reason,
  });

  if (requested === 'api') return api('JUDGE_DRIVER=api');
  if (requested === 'claude-code') return claudeCode('JUDGE_DRIVER=claude-code');
  if (requested !== undefined && requested !== '') {
    return api(`JUDGE_DRIVER="${requested}" is not a driver; using api`);
  }

  if (hasApiCredentials()) return api('ANTHROPIC_API_KEY is set');
  if (findClaudeBinary()) return claudeCode('no API key, Claude Code CLI found');
  return api('no API key and no Claude Code CLI');
}

/**
 * Can this driver reach anything, resolved once at startup? `null` means the
 * question stayed open. For claude-code it is a local read of the CLI's own
 * login state, so it costs nothing and is false when the CLI is missing or
 * logged out.
 */
export async function probeDriver(driver: JudgeDriver): Promise<boolean | null> {
  return driver === 'claude-code' ? probeClaudeCode() : probeApiCredentials();
}
