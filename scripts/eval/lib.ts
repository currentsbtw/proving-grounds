/**
 * The handful of things `eval-build.ts` and `eval-run.ts` both need. Both are
 * scripts, not library code, so this file stays small on purpose: paths, JSON
 * read/write, the bounded worker pool, and the driver both scripts resolve their
 * model calls through. Nothing here talks to a network or a model, and importing
 * it does nothing: `resolveModel` only builds a driver, it never calls one.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { JudgeDriver } from '../../src/domain/judge.ts';
import { ModelAuthError, type JudgeModel } from '../../server/judge/model.ts';
import { probeApiCredentials, probeClaudeCode, selectDriver } from '../../server/judge/drivers/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

export const EVAL_DIR = path.join(here, '..', '..', 'eval');
export const CARDS_PATH = path.join(EVAL_DIR, 'cards.txt');
export const RULINGS_PATH = path.join(EVAL_DIR, 'rulings.json');
export const QUESTIONS_PATH = path.join(EVAL_DIR, 'questions.json');
export const SKIPPED_PATH = path.join(EVAL_DIR, 'questions-skipped.json');
export const CR_EXAMPLES_PATH = path.join(EVAL_DIR, 'cr-examples.json');
export const RESULTS_DIR = path.join(EVAL_DIR, 'results');

/** Reads a JSON file, or returns `fallback` when it is missing or unreadable. */
export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Write via a sibling temp file and rename over the target, so a run that throws
 * partway cannot leave a truncated cache where a complete one used to be. Rename
 * within a directory is atomic enough for our purposes on both platforms.
 */
export function writeJsonAtomic(file: string, value: unknown) {
  const tmp = `${file}.tmp`;
  writeJson(tmp, value);
  renameSync(tmp, file);
}

/** `--name value` from an argv slice, or null when the flag is absent. */
export function flagValue(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? null);
}

export interface ResolvedModel {
  driver: JudgeDriver;
  /** Every model call in both scripts goes through this. */
  model: JudgeModel;
  /** The model id, for reporting. */
  modelId: string;
  /** How many calls to keep in flight. A subscription gets a gentler number. */
  concurrency: number;
  /**
   * Whether the driver has anything to call with, asked once. For claude-code
   * this only means a CLI exists and runs: whether it is logged in is not
   * knowable until a call is made, so a `ModelAuthError` from the first one is
   * the real answer.
   */
  hasCredentials: boolean;
  /** What to print when `hasCredentials` is false. */
  missingHint: string;
  /** Printed once at the top of a run when the driver is worth a word. */
  note: string | null;
}

/**
 * Which model the eval calls, and how hard it may lean on it.
 *
 * The choice itself is `selectDriver()`'s, not ours: the eval and the proxy must
 * agree about which driver answers, and one copy of that policy is the only way
 * they can. `selectDriver()` reads `JUDGE_DRIVER`/`JUDGE_MODEL` from the
 * environment and takes no overrides argument, and `server/judge/drivers/` is
 * outside this change, so `--driver` and `--model` are applied by setting those
 * two variables before the call. These are one-shot script processes and nothing
 * else in them reads either variable, so the assignment is local in effect.
 *
 * Credentials are then checked once, per driver, and the answer is what both
 * scripts gate on.
 */
export async function resolveModel(
  argv: string[],
  opts?: { defaultConcurrency?: number },
): Promise<ResolvedModel> {
  const driverFlag = flagValue(argv, '--driver')?.trim();
  const modelFlag = flagValue(argv, '--model')?.trim();
  if (driverFlag) process.env.JUDGE_DRIVER = driverFlag;
  if (modelFlag) process.env.JUDGE_MODEL = modelFlag;

  const { driver, model } = selectDriver();
  // `||`, not `??`: an empty string is no credential at all, and reading one as a
  // credential would hide the subscription note from the player who needs it and
  // report an API key this process does not have.
  const apiKey = (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '').trim();

  if (driver === 'claude-code') {
    return {
      driver,
      model,
      modelId: model.defaultModel,
      // Three at a time: each call is one local CLI process, and what these wait
      // on is that process starting up rather than a core or a credit balance.
      concurrency: 3,
      hasCredentials: probeClaudeCode(),
      missingHint: 'no Claude Code CLI found (set JUDGE_CLAUDE_BIN, or install Claude Code)',
      // Only true when no API key is in the environment for the CLI to prefer.
      // The driver scrubs the key from the child, so this holds either way; the
      // condition stays because the sentence must never be printed when it is
      // Console credits that are being spent.
      note:
        apiKey === ''
          ? 'driver claude-code: usage draws from your Claude subscription, not Console credits.'
          : null,
    };
  }

  // `probeApiCredentials` answers `null` when the question stayed open (no
  // network, a proxy, a 5xx). That is not a "no", so it does not stop a run: the
  // first real call will say so properly if there is nothing to authenticate with.
  const probed = await probeApiCredentials();
  return {
    driver,
    model,
    modelId: model.defaultModel,
    concurrency: opts?.defaultConcurrency ?? 3,
    hasCredentials: probed !== false,
    missingHint: 'no usable API credentials (no ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or stored profile)',
    note: null,
  };
}

/**
 * The one sentence a driver with no usable login gets, said the same way by both
 * scripts. Returns false when `err` was some other failure, which the caller owns.
 *
 * A driver that cannot log in would fail every remaining item identically, so the
 * player has exactly one thing to do about it and it is said exactly once.
 */
export function reportAuthFailure(driver: JudgeDriver, err: unknown): boolean {
  if (!(err instanceof ModelAuthError)) return false;
  console.error(
    driver === 'claude-code'
      ? `Stopped: Claude Code is not logged in (${err.message}). Run claude /login once, then run this again.`
      : `Stopped: no usable API credentials (${err.message}).`,
  );
  return true;
}

/** Runs `work` over `items` with at most `limit` in flight. Order is preserved. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  work: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}
