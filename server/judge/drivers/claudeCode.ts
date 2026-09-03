/**
 * The free path: the local Claude Code CLI in print mode, answering on the
 * player's own subscription. Same prompt, same schema, no Console bill.
 *
 * Three things about this driver are deliberate and easy to undo by accident:
 *
 *   1. The prompt never touches argv. The system prompt is the whole
 *      Comprehensive Rules, about a megabyte, and Windows caps a command line
 *      near 32 KB. It goes to a temp file (`--system-prompt-file`) and the
 *      question goes on stdin; both are deleted or closed when the call ends.
 *   2. `--bare` is NOT used, though it is the documented mode for scripted
 *      calls. Bare mode reads "strictly ANTHROPIC_API_KEY or apiKeyHelper" and
 *      never touches OAuth or the keychain, which is exactly the subscription
 *      login this driver exists to spend: with `--bare` a logged-in player is
 *      told "Not logged in". The isolation it would have bought is assembled
 *      from the narrower flags instead (`--setting-sources ""`,
 *      `--strict-mcp-config`, `--disable-slash-commands`, `--no-chrome`), which
 *      leave auth alone. Measured on this machine, that prefix costs about 700
 *      cached tokens a call against about 33k for the CLI's usual context.
 *   3. Tools are off (`--tools ""`). The judge reads a prompt and returns JSON;
 *      it has no business running Bash in the player's repository.
 *   4. The child's environment is scrubbed of ANTHROPIC_API_KEY and
 *      ANTHROPIC_AUTH_TOKEN. This driver's whole claim is that it spends the
 *      subscription and never a key, and the CLI prefers a key in its
 *      environment when it finds one, so a developer with a key exported would
 *      otherwise be billed by the "free" path without being told.
 *
 * The CLI reports a failed run as a normal result on stdout with `is_error`
 * true and exit code 0, so neither the exit code nor `subtype` can be trusted
 * alone. See `parseCliResult`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  ModelAuthError,
  ModelLimitError,
  ModelUpstreamError,
  isLimitMessage,
  parseResetsAt,
  toJudgeUsage,
  type JudgeModel,
  type ModelRequest,
  type ModelResult,
} from '../model.ts';

export const CLAUDE_CODE_DEFAULT_MODEL = 'claude-opus-5';

/** A question can take a while at high effort; past this the child is killed. */
const CALL_TIMEOUT_MS = 180_000;

const IS_WINDOWS = process.platform === 'win32';
const EXE = IS_WINDOWS ? 'claude.exe' : 'claude';

/**
 * This process's environment minus anything the CLI would spend as an API key.
 * Every spawn in this file uses it, the login probe included, so what the probe
 * reports is the same authentication the answers will use.
 *
 * Exported so the harness can check the one thing that matters here and cannot
 * be read back out of a spawned child: that the two names are gone.
 */
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

/** `2.1.258` beats `2.1.99`, which a string sort gets backwards. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The newest `<version>/claude.exe` under a `claude-code` directory, if any. */
function newestInstall(root: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+(\.\d+)*$/.test(e.name))
      .map((e) => e.name);
  } catch {
    return null;
  }
  for (const version of entries.sort((a, b) => compareVersions(b, a))) {
    const candidate = path.join(root, version, EXE);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * `claude` as resolved by the OS path search.
 *
 * On Windows only a real executable is accepted. A global npm install leaves a
 * `claude.cmd` shim, and Node cannot spawn a `.cmd` without a shell; running the
 * judge's argv through a shell is a quoting hazard we do not need, because the
 * desktop app's own `claude.exe` is right below and `JUDGE_CLAUDE_BIN` covers
 * whatever neither finds.
 */
function fromPath(): string | null {
  const probe = spawnSync(IS_WINDOWS ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
  if (probe.status !== 0 || typeof probe.stdout !== 'string') return null;
  const hits = probe.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  for (const hit of hits) {
    if (IS_WINDOWS && !hit.toLowerCase().endsWith('.exe')) continue;
    if (existsSync(hit)) return hit;
  }
  return null;
}

/**
 * Where the desktop app keeps its bundled CLI.
 *
 * The app ships as an MSIX package, so the same path means two different things
 * depending on who asks. A process running inside the package sees
 * `%APPDATA%\Claude\...` through filesystem virtualization; from the user's own
 * terminal that directory is empty and the real files are under the package's
 * `LocalCache`. Both are searched, the virtualized path first because it is the
 * cheaper hit when it works, and the package family is globbed because the
 * suffix is not ours to hard-code.
 */
function bundledRoots(): string[] {
  const roots: string[] = [];
  const appData = process.env.APPDATA;
  if (appData) roots.push(path.join(appData, 'Claude', 'claude-code'));

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const packages = path.join(localAppData, 'Packages');
    try {
      for (const entry of readdirSync(packages, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('Claude_')) continue;
        roots.push(path.join(packages, entry.name, 'LocalCache', 'Roaming', 'Claude', 'claude-code'));
      }
    } catch {
      // No Packages directory: not a Windows install with the desktop app.
    }
  }
  return roots;
}

function locateClaudeBinary(): string | null {
  const override = process.env.JUDGE_CLAUDE_BIN?.trim();
  if (override) return existsSync(override) ? override : null;

  const onPath = fromPath();
  if (onPath) return onPath;

  for (const root of bundledRoots()) {
    const found = newestInstall(root);
    if (found) return found;
  }
  return null;
}

/** `undefined` until the first search; `null` once a search has come up empty. */
let cachedBin: string | null | undefined;

/**
 * The CLI this driver will spawn, or null when there is none to spawn. Order:
 * an explicit `JUDGE_CLAUDE_BIN`, then `claude` on PATH, then the desktop app's
 * bundled copies, newest version first.
 *
 * Memoised for the life of the process. The search shells out to `where` and
 * walks the package directories, and it was running on every question; the
 * binary does not move mid-session, and moving `JUDGE_CLAUDE_BIN` after startup
 * is not a case worth paying for on every call.
 */
export function findClaudeBinary(): string | null {
  if (cachedBin === undefined) cachedBin = locateClaudeBinary();
  return cachedBin;
}

/** The fields `claude auth status --json` prints that we read. */
const AuthStatus = z.object({ loggedIn: z.boolean().optional() });

/**
 * Is there a CLI, and is it logged in? Asked once at startup so health can say
 * so before the first question rather than after it.
 *
 * `auth status` is a local read of the stored credentials: it costs nothing and
 * calls no model. It runs under the same scrubbed environment as a real answer,
 * so it reports the login this driver will actually spend.
 */
export function probeClaudeCode(): boolean {
  const bin = findClaudeBinary();
  if (!bin) return false;
  const probe = spawnSync(bin, ['auth', 'status', '--json'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: scrubbedEnv(),
    windowsHide: true,
  });
  if (probe.status !== 0 || typeof probe.stdout !== 'string') return false;
  try {
    return AuthStatus.parse(JSON.parse(probe.stdout)).loggedIn === true;
  } catch {
    return false;
  }
}

/** The envelope `--output-format json` prints. Only the fields we read. */
const CliResult = z.object({
  is_error: z.boolean().optional(),
  subtype: z.string().optional(),
  result: z.unknown().optional(),
  structured_output: z.unknown().optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
    })
    .optional(),
});

/**
 * Turn one CLI envelope into the parsed answer, or throw the right error.
 *
 * A failed run is still a well-formed result on stdout: `is_error` is true while
 * `subtype` stays `"success"` and the process exits 0, so the failure has to be
 * read out of the body. Two sentences in that body mean something other than
 * "this call failed": "Not logged in" is the failure the player can fix, and a
 * spent plan window ("You've hit your session limit, resets ...") is the failure
 * nobody can fix until the stated time. Both get their own error type because a
 * caller batching calls has to stop on either.
 */
export function parseCliResult<T>(stdout: string, schema: z.ZodType<T>, requestedModel: string): ModelResult<T> {
  let envelope: z.infer<typeof CliResult>;
  try {
    envelope = CliResult.parse(JSON.parse(stdout));
  } catch {
    const head = stdout.trim().slice(0, 200);
    throw new ModelUpstreamError(`Claude Code returned no readable JSON${head ? `: ${head}` : '.'}`);
  }

  const resultText = typeof envelope.result === 'string' ? envelope.result : '';
  if (envelope.is_error === true || (envelope.subtype !== undefined && envelope.subtype !== 'success')) {
    // The CLI has no error code for this, so the sentence is the only signal.
    // It is a fallback: `probeClaudeCode` normally catches a missing login at
    // startup, and this catches the login that expired mid-session.
    if (/not logged in/i.test(resultText)) throw new ModelAuthError(resultText.trim());
    // A spent plan window reads the same way: prose in `result`, nothing else.
    // It is not an upstream failure and not a login problem, and a caller that
    // reads it as either keeps dispatching calls that cannot be answered.
    if (isLimitMessage(resultText)) {
      throw new ModelLimitError(resultText.trim(), parseResetsAt(resultText));
    }
    throw new ModelUpstreamError(resultText.trim() || 'Claude Code reported an error with no message.');
  }

  // `--json-schema` puts the answer in `structured_output`, always. A successful
  // envelope without it means the CLI ran something other than the call we asked
  // for, which is upstream's problem and not something to guess our way past.
  if (envelope.structured_output === undefined || envelope.structured_output === null) {
    throw new ModelUpstreamError('Claude Code returned no structured output.');
  }

  const parsed = schema.safeParse(envelope.structured_output);
  if (!parsed.success) {
    throw new ModelUpstreamError(`Claude Code's answer did not match the schema: ${parsed.error.message}`);
  }

  // Claude Code makes a small haiku helper call of its own and can list it
  // first, so an unmatched `modelUsage` is reported as the model we asked for
  // rather than as whichever key happened to come back first.
  const answered =
    Object.keys(envelope.modelUsage ?? {}).find(
      (id) => id === requestedModel || id.startsWith(requestedModel),
    ) ?? requestedModel;

  return { parsed: parsed.data, model: answered, usage: toJudgeUsage(envelope.usage) };
}

/**
 * The failure for a run that printed no JSON at all.
 *
 * A spent plan window does not always reach stdout: the CLI can refuse before it
 * has an envelope to print and say so on stderr, and reading that as an ordinary
 * upstream failure is the same mistake as reading the in-band sentence that way.
 * Exported so the harness can check both halves without spawning a CLI.
 */
export function noOutputError(code: number | null, stderr: string): ModelUpstreamError | ModelLimitError {
  const why = stderr.trim();
  if (isLimitMessage(why)) return new ModelLimitError(why.slice(0, 200), parseResetsAt(why));
  return new ModelUpstreamError(
    `Claude Code exited ${code ?? 'with no code'} and printed nothing${why ? `: ${why.slice(0, 200)}` : '.'}`,
  );
}

interface RunOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
}

function runCli(
  bin: string,
  args: string[],
  stdin: string,
  signal?: AbortSignal,
): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    // cwd is the temp directory, not the player's project: with --safe-mode the
    // CLI ignores project config anyway, and nothing here should be relative to
    // a repository the judge merely happens to be running inside.
    const child = spawn(bin, args, { cwd: os.tmpdir(), windowsHide: true, env: scrubbedEnv() });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, CALL_TIMEOUT_MS);

    // A cancelled question kills the child rather than letting it finish into a
    // drawer nobody has open. `close` still fires, so cleanup stays in one place.
    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      finish();
      reject(err);
    });
    child.on('close', (code) => {
      finish();
      resolve({ stdout, stderr, code, timedOut, aborted });
    });

    // The question, never argv. A closed stdin is what tells the CLI to start.
    child.stdin.on('error', () => {
      // The child can exit before the write lands (bad flag, no login); the
      // close handler above owns that failure, so this EPIPE is not ours.
    });
    child.stdin.end(stdin, 'utf8');
  });
}

export function createClaudeCodeModel(opts?: { bin?: string; model?: string }): JudgeModel {
  const defaultModel = opts?.model ?? CLAUDE_CODE_DEFAULT_MODEL;

  return {
    driver: 'claude-code',
    defaultModel,
    async complete<T>(req: ModelRequest<T>): Promise<ModelResult<T>> {
      const bin = opts?.bin ?? findClaudeBinary();
      if (!bin) {
        throw new ModelAuthError(
          'No Claude Code CLI found. Install Claude Code, or set JUDGE_CLAUDE_BIN to its path.',
        );
      }

      const model = defaultModel;
      // zod 4 stamps a `$schema` dialect URI on what it emits, and the CLI's
      // validator rejects the draft 2020-12 URI outright ("no schema with key or
      // ref"). The rest of the document is what it wants, so the key goes.
      const { $schema: _dialect, ...schemaJson } = z.toJSONSchema(req.schema) as Record<string, unknown>;
      const systemFile = path.join(os.tmpdir(), `judge-system-${randomUUID()}.txt`);
      writeFileSync(systemFile, req.system.map((block) => block.text).join('\n\n'), 'utf8');

      try {
        const outcome = await runCli(
          bin,
          [
            '-p',
            '--output-format',
            'json',
            '--json-schema',
            JSON.stringify(schemaJson),
            '--model',
            model,
            '--effort',
            req.effort,
            '--system-prompt-file',
            systemFile,
            '--no-session-persistence',
            // Isolation from the host's configuration, minus `--bare`'s auth
            // change. Measured: this prefix costs ~700 cached tokens per call
            // against ~33k when the CLI loads its usual context.
            '--setting-sources',
            '',
            '--strict-mcp-config',
            '--disable-slash-commands',
            '--no-chrome',
            // Variadic, so it stays last: an empty value is "no tools at all".
            '--tools',
            '',
          ],
          req.user,
          req.signal,
        );

        if (outcome.aborted) {
          throw new ModelUpstreamError('The question was cancelled before Claude Code answered.');
        }
        if (outcome.timedOut) {
          throw new ModelUpstreamError(`Claude Code did not answer within ${CALL_TIMEOUT_MS / 1000}s.`);
        }
        if (outcome.stdout.trim() === '') {
          throw noOutputError(outcome.code, outcome.stderr);
        }
        return parseCliResult(outcome.stdout, req.schema, model);
      } finally {
        // The system prompt is a megabyte of rules text per call; leaving those
        // in the temp directory would be a slow leak on a long session.
        rmSync(systemFile, { force: true });
      }
    },
  };
}
