/**
 * Grades the advisory judge against the held-out set `eval:build` produced.
 *
 *   npm run eval:judge                      the whole set, live
 *   npm run eval:judge -- --limit 20        first N items
 *   npm run eval:judge -- --filter Rhystic  items whose card or id matches
 *   npm run eval:judge -- --mock            offline, exercises the harness only
 *   npm run eval:judge -- --resume <file>   carry graded items from that results file
 *   npm run eval:judge -- --no-resume       grade everything again
 *   npm run eval:judge -- --show-request <id>   print one item's request and exit
 *   npm run eval:judge -- --mock --mock-limit-after 6   exercise the stop path
 *   npm run eval:judge -- --mock --mock-error-at 3      exercise the errored-item path
 *
 * A run resumes by default, from the newest results file that was the same
 * measurement and stopped early. Every item in it that reached a verdict is
 * carried over rather than asked again, and a resumed run that grades everything
 * still outstanding is a full run and can PASS. This exists because the two ways
 * a run ends early -- a plan window that runs out, a login that expires -- would
 * otherwise make the next run pay again for every item the last one graded.
 *
 * "The same measurement" is corpus, driver, model, grounding and the harness
 * fingerprint: the policy prompt, the request shape and what retrieval selects.
 * An automatic resume additionally requires that the earlier run stopped early,
 * or the first good run would make every later one grade nothing and print PASS
 * from old verdicts, and that it was not a `--limit`, `--filter` or
 * `--no-examples` run, which graded a chosen part of the set.
 *
 * An explicit `--resume <file>` will also take a run that finished, so long as it
 * graded the whole set, and then it re-asks exactly the items that finished
 * without a verdict: the ones recorded as `error`, and any the file never
 * mentions. This is the hole the 2026-09-03 run fell into. Eighteen items failed
 * on a transient CLI error, the run graded the rest and completed, and every
 * later `--resume` answered "nothing left to grade", so those eighteen could
 * never be re-asked without paying for the other two hundred again. A file whose
 * every item already has a verdict is still refused: there is nothing to grade,
 * and printing PASS off old verdicts is what the completed-run rule is for.
 * An explicit `--resume` says why it refused rather than quietly grading
 * everything.
 *
 * Those two failures stop the run rather than failing an item: nothing new is
 * dispatched, the calls in flight are allowed to land, everything graded is
 * written, and the items never asked are simply absent from the results rather
 * than recorded as errors they did not commit.
 *
 * M3 ships when this prints PASS. Six conditions, and every one of them exists
 * because its absence let a judge look good without being good:
 *
 *   - agreement with the expert answers at 95% or better;
 *   - not one citation the corpus cannot verify;
 *   - declines under a quarter of the graded items;
 *   - at least 20 items graded, or the run is a smoke run and cannot pass;
 *   - no errored items at all, because a partial run is not a measurement;
 *   - at least one CR example that states its rule wrongly, so the CR half cannot
 *     be passed by agreeing with everything. `--allow-true-only` waives this, and
 *     is for smoke runs only.
 *
 * Declines are not counted as misses, because a judge that declines is behaving
 * as designed. They are capped instead: declining is the safe answer, and a judge
 * allowed unlimited safe answers is not being measured either.
 *
 * Two model calls per item, deliberately kept apart. The judge answers with the
 * corpus in front of it. A second call grades that answer against the expert
 * answer key and never sees the cited rules, so a persuasive-looking citation
 * cannot buy a passing grade.
 *
 * The corpus always holds out the sampled rules' worked examples, even under
 * `--no-examples`, so the cached system prefix is byte-identical between runs and
 * the hour-long cache actually gets hit. Under `--grounding full` the first
 * request runs alone to write that cache and the rest follow in parallel; under
 * the default retrieval grounding each question carries its own few rules, there
 * is no shared prefix, and nothing is serialised.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { JudgeGrounding, JudgeResponse, JudgeRule, JudgeUsage } from '../src/domain/judge.ts';
import { type Corpus, loadCorpus, resolveRule } from '../server/judge/corpus.ts';
import { MAX_QUESTION_CHARS, askJudge, buildSystemBlocks } from '../server/judge/core.ts';
import { ModelAuthError, ModelLimitError, type JudgeModel } from '../server/judge/model.ts';
import { buildExcerpt } from '../server/judge/retrieval.ts';
import {
  CR_EXAMPLES_PATH,
  QUESTIONS_PATH,
  RESULTS_DIR,
  RULINGS_PATH,
  SELF_CORRECTION,
  flagValue,
  isTransientStop,
  pool,
  readJson,
  reportStop,
  requireFlagValues,
  resolveModel,
  stopReasonLine,
  type StopKind,
} from './eval/lib.ts';

/** The gate. Every one of these must hold for the judge to ship. */
const MIN_AGREEMENT = 0.95;
/**
 * A judge that refuses a quarter of real questions has not earned shipping. The
 * decline is the safe verdict and it is never scored as wrong, so without a cap
 * the cheapest way to a passing agreement score is to answer almost nothing.
 */
const MAX_DECLINE_RATE = 0.25;
/**
 * Below this the run is a smoke test of the harness, not a measurement of the
 * judge. So is any run `--limit` cut short of the full set, however many items
 * that left: a chosen prefix of the questions is not the question set.
 */
const MIN_GRADED = 20;

/** USD per million tokens, by kind. */
const PRICE = { input: 5, cacheRead: 0.5, cacheWrite: 10, output: 25 };

/**
 * What the eval asks a judge, as a number to bump by hand.
 *
 * 1: the question alone.
 * 2: the question plus a "Card text for reference" block for the cards it names.
 * 3: that block carries each card's printed mana cost between type line and text.
 *
 * Bump it whenever the request an item produces changes shape. It is part of the
 * harness fingerprint below, so a bump makes every earlier result unresumable,
 * which is the point: a verdict earned under a different request is not a verdict
 * about this one.
 */
const REQUEST_SHAPE_VERSION = 3;

/**
 * Three questions whose excerpts are sensitive to the retrieval settings that
 * decide what a judge reads. The commander one comes in far under the ceiling, so
 * it moves with the relative score floor and the 903 boost; the hexproof one
 * saturates the ceiling and pulls in glossary entries, so it moves with the
 * character budget and the glossary caps; the delayed-trigger one carries a cue
 * phrase in its question text, so it moves with the cue table and with the floor
 * a cue lifts its family to. Without the third, editing a cue would leave the
 * fingerprint unchanged and a stopped run would resume onto verdicts earned from
 * a different excerpt.
 */
const FINGERPRINT_PROBES = [
  'If my commander dies, can I put it back in the command zone?',
  'Does hexproof stop a board wipe that destroys all creatures?',
  'My token says sacrifice it at the beginning of the next end step. Does it still get sacrificed if it stopped being a creature?',
];

/**
 * A short hash of everything about this harness that decides what a judge is
 * asked and what it is given to answer from: the policy prompt, the shape of the
 * request, and what retrieval selects.
 *
 * Resume matches on it, because corpus, driver, model and grounding do not say
 * whether the earlier run was the same measurement. The 2026-09-03 incident file
 * was graded with no card text and version 1 of the request; carrying those
 * verdicts into a run that sends card text would report grades for a question
 * nobody was asked.
 *
 * Retrieval is fingerprinted by what it does rather than by its constants: the
 * numbers themselves (the score floor, the character ceiling, the glossary caps,
 * the 903 boost, the cue table and its floor) are private to
 * `server/judge/retrieval.ts`, and running the three probes above through it
 * catches a change to any of them, and to the selection code around them, which
 * reading five constants would not.
 */
function harnessFingerprint(corpus: Corpus): string {
  const policy = buildSystemBlocks(corpus, 'retrieval', '')[0].text;
  const probes = FINGERPRINT_PROBES.map((question) => {
    const excerpt = buildExcerpt(corpus, { question });
    return `${excerpt.ruleIds.join(',')}|${excerpt.text.length}`;
  });
  return createHash('sha256')
    .update([`request-shape ${REQUEST_SHAPE_VERSION}`, policy, ...probes].join('\n|\n'))
    .digest('hex')
    .slice(0, 12);
}

/** `error` is the call itself failing. It is not a decline and never was one. */
type Verdict = 'agree' | 'disagree' | 'declined' | 'error';

interface EvalItem {
  id: string;
  source: 'wotc' | 'cr-example';
  /** Card name for a ruling item, rule id for a CR example. */
  card: string;
  question: string;
  answerKey: string;
  /** CR examples only: whether the quoted statement is true or deliberately wrong. */
  variant?: 'true' | 'false';
  /**
   * Cards whose oracle text is appended to the question as a reference block.
   * Recorded so the results file can say what the judge was given.
   */
  referenceCards: string[];
}

interface Graded {
  item: EvalItem;
  response: JudgeResponse;
  verdict: Verdict;
  reason: string;
  graderUsage: { inputTokens: number; outputTokens: number };
  /** Set when the call itself failed. The item is graded `error` and fails the gate. */
  error?: string;
  /**
   * Carried from an earlier results file, not graded in this run. Its usage was
   * paid for then, so it is reported apart from what this run spent.
   */
  carried?: boolean;
}

const args = process.argv.slice(2);
// Before anything resolves a driver: a value flag with nothing after it used to
// read as absent, so a trailing `--show-request` started a full live run.
requireFlagValues(args, [
  '--limit',
  '--filter',
  '--model',
  '--driver',
  '--out',
  '--grounding',
  '--resume',
  '--show-request',
  '--mock-limit-after',
  '--mock-error-at',
]);
const MOCK = args.includes('--mock');
const NO_EXAMPLES = args.includes('--no-examples');
/**
 * Lets a run pass with no false CR variants in the set. It is for smoke runs and
 * nothing else: a set of true statements asked as "confirm or correct" is a set a
 * judge passes by agreeing, so this flag turns off the check that says so.
 */
const ALLOW_TRUE_ONLY = args.includes('--allow-true-only');
const LIMIT = (() => {
  const raw = flagValue(args, '--limit');
  const n = Number(raw);
  return raw !== null && Number.isFinite(n) && n > 0 ? n : Infinity;
})();
const FILTER = flagValue(args, '--filter');
const MODEL = flagValue(args, '--model') ?? undefined;
const OUT = flagValue(args, '--out');
/**
 * Resume: on by default from the newest results file, `--resume <path>` for a
 * particular one, `--no-resume` for none. A mock run does not pick a file up on
 * its own -- it would carry real grades into a harness smoke test -- but it does
 * honour an explicit `--resume`, and it skips the driver/model match check when
 * it does, because a mock run matches no real run by construction.
 */
const RESUME_PATH = flagValue(args, '--resume');
const NO_RESUME = args.includes('--no-resume');
/** Print one item's request exactly as the judge would receive it, then stop. */
const SHOW_REQUEST = flagValue(args, '--show-request');
/**
 * Mock only: make the nth mock judge call, and every call after it, fail the way
 * a spent plan window fails. The stop path is the whole point of this change and
 * it was previously only reachable by editing the script. 0 means never.
 */
const MOCK_LIMIT_AFTER = (() => {
  const raw = flagValue(args, '--mock-limit-after');
  if (raw === null) return 0;
  if (!MOCK) {
    console.error('--mock-limit-after only means anything with --mock.');
    process.exit(1);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.error('--mock-limit-after needs a whole number (0 for never).');
    process.exit(1);
  }
  return n;
})();
/**
 * Mock only: fail the nth mock judge call the way one item failing on its own
 * account fails -- an ordinary error, not an auth or limit error, so the run
 * records the item as `error` and carries on grading the rest. The complement of
 * `--mock-limit-after`: that one exercises the stop path, this one exercises the
 * errored item a completed run leaves behind for an explicit `--resume` to
 * re-ask. 0 means never.
 */
const MOCK_ERROR_AT = (() => {
  const raw = flagValue(args, '--mock-error-at');
  if (raw === null) return 0;
  if (!MOCK) {
    console.error('--mock-error-at only means anything with --mock.');
    process.exit(1);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.error('--mock-error-at needs a whole number (0 for never).');
    process.exit(1);
  }
  return n;
})();
/** How much rules text the judge reads per question. */
const GROUNDING: JudgeGrounding = flagValue(args, '--grounding') === 'full' ? 'full' : 'retrieval';
/**
 * Only `full` grounding puts the same corpus in front of every question, so only
 * `full` has a prefix worth caching. Under retrieval each question carries its own
 * few rules, and there is nothing for a first request to warm.
 */
const SHARED_PREFIX = GROUNDING === 'full';

/**
 * The driver every live call goes through, judge and grader alike, so both
 * halves of a run are billed the same way. A `--mock` run resolves nothing, and
 * neither does `--show-request`: neither calls a model, and probing for a CLI
 * they will not use is just noise.
 */
const RESOLVED = MOCK || SHOW_REQUEST !== null ? null : await resolveModel(args, { defaultConcurrency: 3 });
const CONCURRENCY = RESOLVED?.concurrency ?? 3;

interface StoredQuestion {
  id: string;
  card: string;
  question: string;
  answerKey: string;
  /** Other cards the ruling depends on; their text is sent too when we have it. */
  otherCards?: string[];
  /** Corrected by hand; `eval-build` keeps it as written. Read the same as any other. */
  handEdited?: true;
}
interface StoredCardRulings {
  card: string;
  typeLine: string;
  /** Printed cost, `{1}{U}`. Absent in a rulings file written before it was stored. */
  manaCost?: string;
  oracleText: string;
}
interface StoredExample {
  ruleId: string;
  example: string;
  rule: string;
  /** Absent in a file written before false variants existed; read as `true`. */
  variant?: 'true' | 'false';
  statement?: string;
  answerKey?: string;
}

/**
 * A CR example is asked with its conclusion left in: the judge confirms or
 * corrects it, which is a harder ask than completing a sentence. Half the items
 * state the example wrongly on purpose, so confirming everything scores 50%.
 */
function exampleItem(entry: StoredExample, n: number): EvalItem {
  const fallback = entry.example.replace(/^Example:\s*/, '').trim();
  const statement = entry.statement ?? fallback;
  return {
    id: `cr:${entry.ruleId}#${n}`,
    source: 'cr-example',
    card: entry.ruleId,
    question: `Under rule ${entry.ruleId}: ${statement} Is that right? Confirm it or correct it.`,
    answerKey: entry.answerKey ?? fallback,
    variant: entry.variant ?? 'true',
    // A CR example is about the rules text itself; there is no card to quote.
    referenceCards: [],
  };
}

/**
 * The card text a ruling item is asked with, appended to the question.
 *
 * A judge asked about Krosan Grip with no text in front of it is being asked to
 * answer from memory, which the policy prompt forbids, and retrieval never sees
 * the keyword the rule hangs on. So the item's card, and any other card the
 * ruling named whose text we already hold, go into the question as a reference
 * block.
 *
 * It is a reference block and not a table snapshot on purpose. A snapshot is a
 * claim about the game state -- turn, life, zones, and by omission everything
 * that is not on it -- and the policy prompt makes that claim authoritative. The
 * questions carry their own scenarios ("I have Deadly Rollick in hand", "my
 * opponent casts"), so any board we invented would contradict the question it
 * came with. Card text is the one thing that is true regardless of the scenario.
 */
function referenceBlock(
  entry: StoredQuestion,
  cards: Map<string, StoredCardRulings>,
): { question: string; names: string[] } {
  const names = [entry.card, ...(entry.otherCards ?? [])];
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const name of names) {
    const hit = cards.get(name.toLowerCase()) ?? cards.get(name.toLowerCase().split(' // ')[0]);
    // A name we cannot resolve is left out. Inventing text for it would be worse
    // than the judge not having it.
    if (!hit || seen.has(hit.card)) continue;
    seen.add(hit.card);
    // Name, type, cost, text: the order a card is printed in, and the same order
    // `renderTableContext` writes a table card. The cost is left out when it is
    // empty rather than sent as a blank field, which would read as a cost of
    // nothing. Cyclonic Rift is why it is here at all: asked about overloading
    // it, the judge answered with a cost it remembered, because nothing in the
    // request carried one.
    const parts = [hit.card, hit.typeLine];
    if (hit.manaCost) parts.push(hit.manaCost);
    parts.push(hit.oracleText.replace(/\n+/g, ' / '));
    lines.push(`- ${parts.join(' | ')}`);
  }
  if (lines.length === 0) return { question: entry.question, names: [] };
  return {
    question: `${entry.question}\n\nCard text for reference:\n${lines.join('\n')}`,
    names: [...seen],
  };
}

function loadItems(): {
  items: EvalItem[];
  heldOutRules: Set<string>;
  crTrueOnly: boolean;
  truncated: boolean;
} {
  const questions = readJson<StoredQuestion[]>(QUESTIONS_PATH, []);
  const examples = readJson<StoredExample[]>(CR_EXAMPLES_PATH, []);
  const heldOutRules = new Set(examples.map((e) => e.ruleId));
  const crTrueOnly = examples.length > 0 && !examples.some((e) => e.variant === 'false');

  const cards = new Map<string, StoredCardRulings>();
  for (const entry of readJson<StoredCardRulings[]>(RULINGS_PATH, [])) {
    cards.set(entry.card.toLowerCase(), entry);
    const front = entry.card.toLowerCase().split(' // ')[0];
    if (!cards.has(front)) cards.set(front, entry);
  }

  // A self-correction in a generated question means the generator talked itself
  // out of its own text, so the item is dropped and `eval-build` rewrites it. A
  // hand-edited one is exempt: a person wrote those words on purpose, `eval-build`
  // will not regenerate it, and dropping it here would leave the item permanently
  // out of the set with no way to get it back.
  const usable = questions.filter((q) => q.handEdited === true || !SELF_CORRECTION.test(q.question));
  const skipped = questions.length - usable.length;
  if (skipped > 0) {
    console.log(
      `${skipped} generated question${skipped === 1 ? '' : 's'} skipped: the question text contains a self-correction (regenerate with eval:build; hand-edited questions are kept as written)`,
    );
  }

  const items: EvalItem[] = usable.map((q) => {
    const { question, names } = referenceBlock(q, cards);
    return {
      id: q.id,
      source: 'wotc',
      card: q.card,
      question,
      answerKey: q.answerKey,
      referenceCards: names,
    };
  });
  const withText = items.filter((item) => item.referenceCards.length > 0).length;
  console.log(`${withText} of ${items.length} ruling items carry their card's oracle text`);
  if (!NO_EXAMPLES) items.push(...examples.map(exampleItem));

  // A question the judge would reject outright is not a fair item; drop it here
  // rather than let it surface as a failure the judge did not cause.
  const asked = items.filter((item) => item.question.length <= MAX_QUESTION_CHARS);
  if (asked.length < items.length) {
    console.log(`${items.length - asked.length} items dropped: longer than ${MAX_QUESTION_CHARS} characters`);
  }

  const filtered = FILTER
    ? asked.filter(
        (item) =>
          item.card.toLowerCase().includes(FILTER.toLowerCase()) ||
          item.id.toLowerCase().includes(FILTER.toLowerCase()),
      )
    : asked;
  const limited = filtered.slice(0, LIMIT === Infinity ? filtered.length : LIMIT);
  return {
    items: limited,
    heldOutRules,
    crTrueOnly,
    truncated: limited.length < filtered.length,
  };
}

const GraderOutput = z.object({
  verdict: z.enum(['agree', 'disagree', 'declined']),
  reason: z.string(),
});

const GRADER_PROMPT = `You grade one answer from a Magic: the Gathering rules judge against an expert answer written by Wizards of the Coast. You never see the rules the judge cited, and you must not reward or punish an answer for how it is worded.

Return declined when the judge's status is decline, or when its answer asks for a fact or a clarification instead of answering the question.

Return agree only when the judge's conclusion matches the expert answer on every point that would matter at the table. Extra correct detail is fine. A different route to the same outcome is fine. A different outcome, a missing condition, or a reversed direction is not.

Some questions quote a statement and ask the judge to confirm or correct it, and some of those statements are deliberately wrong. You can tell from the expert answer: when it corrects the quoted statement, the correct behaviour is to correct it. A judge that confirms a statement the expert answer corrects is disagree, however well it is argued.

Return disagree otherwise.

Say why in one sentence.`;

async function gradeLive(
  model: JudgeModel,
  item: EvalItem,
  res: JudgeResponse,
): Promise<{ verdict: Verdict; reason: string; graderUsage: Graded['graderUsage'] }> {
  const user = [
    `QUESTION\n${item.question}`,
    `EXPERT ANSWER\n${item.answerKey}`,
    `JUDGE STATUS\n${res.status}`,
    `JUDGE ANSWER\n${res.answer}`,
  ].join('\n\n');
  const { parsed, usage } = await model.complete({
    system: [{ text: GRADER_PROMPT }],
    user,
    schema: GraderOutput,
    effort: 'medium',
    maxTokens: 2000,
  });
  return {
    verdict: parsed.verdict,
    reason: parsed.reason,
    graderUsage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  };
}

/** What the CLI says when a Claude plan's session window is spent. */
const MOCK_LIMIT_MESSAGE = "You've hit your session limit · resets 11:20pm (America/Los_Angeles)";

/**
 * Offline stand-ins. The judge stub answers from the answer key and cites a rule
 * the corpus really has; the grader stub is string equality. Together they make
 * a run that must come out PASS, so a failing `--mock` run is a harness bug.
 *
 * `--mock-limit-after n` makes the nth call, and every call after it, fail the
 * way a spent plan window fails. That is the only way to exercise the stop path
 * without spending a real plan, and it exercises the real one: the same error
 * type the claude-code driver throws, thrown from where a driver throws it.
 *
 * `--mock-error-at n` fails the nth call only, with an ordinary error, which is
 * how a single item errors while the run finishes around it. That is the state a
 * completed results file can be left in and the one an explicit `--resume` has to
 * be able to re-ask.
 */
function mockDeps(corpus: Corpus) {
  let calls = 0;
  const ask = async (item: EvalItem): Promise<JudgeResponse> => {
    const n = calls++;
    if (MOCK_LIMIT_AFTER > 0 && n + 1 >= MOCK_LIMIT_AFTER) {
      throw new ModelLimitError(MOCK_LIMIT_MESSAGE, '11:20pm (America/Los_Angeles)');
    }
    // Not an auth or limit error on purpose: those stop the run, and what this
    // flag exists to produce is one errored item in a run that goes on to finish.
    if (MOCK_ERROR_AT > 0 && n + 1 === MOCK_ERROR_AT) {
      throw new Error(`mock: item ${item.id} failed on its own account`);
    }
    const citation = item.source === 'cr-example' ? item.card : '903.9a';
    const hit = resolveRule(corpus, citation) ?? resolveRule(corpus, '903.9a');
    return {
      status: 'answer',
      answer: item.answerKey,
      rules: hit ? [{ id: hit.id, text: hit.text, verified: true }] : [],
      confidence: 'high',
      caveats: [],
      model: MODEL ?? 'mock',
      corpusDate: corpus.effectiveDate,
      // First request writes the cache, the rest read it, as the live path does.
      usage: {
        inputTokens: 400,
        outputTokens: 120,
        cacheRead: n === 0 ? 0 : 250_000,
        cacheWrite: n === 0 ? 250_000 : 0,
      },
    };
  };
  const grade = async (item: EvalItem, res: JudgeResponse) => ({
    verdict: (res.status === 'decline'
      ? 'declined'
      : res.answer.trim() === item.answerKey.trim()
        ? 'agree'
        : 'disagree') as Verdict,
    reason: 'mock string equality',
    graderUsage: { inputTokens: 0, outputTokens: 0 },
  });
  return { ask, grade };
}

/** The fields of a results file this script reads back when resuming. */
interface StoredResultItem {
  id: string;
  question?: string;
  answerKey?: string;
  verdict: Verdict;
  graderReason?: string;
  status: 'answer' | 'decline';
  answer: string;
  confidence: 'high' | 'medium' | 'low';
  rules: JudgeRule[];
  caveats: string[];
  usage?: JudgeUsage;
}
interface StoredResults {
  model?: string;
  driver?: string;
  grounding?: string;
  corpusDate?: string;
  /** This harness's fingerprint. Absent on files written before it existed. */
  harness?: string;
  /** `limit` or `auth` when that run ended early; null or absent when it finished. */
  stopped?: StopKind | null;
  /** `--limit` for that run, when it had one. Absent on files written before this field. */
  limitedTo?: number | null;
  /** `--filter` for that run, when it had one. */
  filter?: string | null;
  /** Whether that run was `--no-examples`. */
  noExamples?: boolean;
  items?: StoredResultItem[];
}

/** A run that graded a chosen part of the set. Never an automatic resume source. */
function isSubsetRun(prior: StoredResults): boolean {
  return (
    (prior.limitedTo !== undefined && prior.limitedTo !== null) ||
    (prior.filter !== undefined && prior.filter !== null) ||
    prior.noExamples === true
  );
}

/** What `loadResume` decided. `refused` ends the run without writing anything. */
type ResumeOutcome =
  | { kind: 'none' }
  | { kind: 'carried'; carried: Map<string, Graded>; file: string }
  | { kind: 'refused'; message: string };

/** Results files, newest first. The names are ISO stamps, so sorting them sorts by time. */
function resultsFilesNewestFirst(): string[] {
  try {
    return readdirSync(RESULTS_DIR)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .reverse()
      .map((name) => path.join(RESULTS_DIR, name));
  } catch {
    return [];
  }
}

/**
 * Grades from an earlier run that this one does not have to buy again.
 *
 * Only a verdict carries over: an errored item is not a grade, and neither is an
 * item the earlier run never dispatched. Three things have to hold before one is
 * carried at all.
 *
 * The earlier run must have been the same measurement: same corpus, driver,
 * model and grounding, and the same harness fingerprint. The fingerprint is the
 * one that catches what the others cannot -- a verdict earned against a bare
 * question says nothing about the same question asked with the card's text under
 * it, and a changed policy prompt or retrieval setting moves the whole set.
 *
 * The earlier run must have stopped early, or, for an explicit `--resume` only,
 * have finished with something still ungraded. An automatic resume from a
 * completed run would turn every later invocation into a rerun of old verdicts
 * that prints PASS without asking anything, which is why it stays refused. But a
 * run that completed with items recorded as `error` has something outstanding
 * that no other invocation can reach: without this, the only way to re-ask those
 * items is to buy the whole set again. So an explicit `--resume` takes such a
 * file, carries every verdict in it, and dispatches exactly the items that have
 * none. When there are none, it refuses as before.
 *
 * And the item must be the same item: the question and the answer key both word
 * for word, because a regenerated question, or a reworded ruling behind the same
 * id, is a different item wearing an old id.
 */
function loadResume(items: EvalItem[], corpus: Corpus, driver: string, modelId: string): ResumeOutcome {
  if (NO_RESUME) return { kind: 'none' };
  const fingerprint = harnessFingerprint(corpus);

  const mismatchesOf = (prior: StoredResults): string[] => {
    const out: string[] = [];
    if (prior.corpusDate !== corpus.effectiveDate) out.push(`corpus ${prior.corpusDate ?? 'unknown'}`);
    if (prior.driver !== driver) out.push(`driver ${prior.driver ?? 'unknown'}`);
    if (prior.model !== modelId) out.push(`model ${prior.model ?? 'unknown'}`);
    if (prior.grounding !== GROUNDING) out.push(`grounding ${prior.grounding ?? 'unknown'}`);
    if (prior.harness !== fingerprint) out.push(`harness ${prior.harness ?? 'unknown'} (now ${fingerprint})`);
    return out;
  };

  let file: string;
  let prior: StoredResults;
  /** Explicit resume of a run that finished: it is here only for its ungraded items. */
  let reasking = false;
  if (RESUME_PATH !== null) {
    file = RESUME_PATH;
    if (!existsSync(file)) return { kind: 'refused', message: `no results file at ${file}.` };
    prior = readJson<StoredResults>(file, {});
    const mismatch = mismatchesOf(prior);
    if (mismatch.length > 0) {
      // A mock run matches no real run by construction, so an explicit `--resume`
      // under `--mock` skips the check rather than refusing the exercise.
      if (!MOCK) {
        return {
          kind: 'refused',
          message: `cannot resume from ${file}: it was a different measurement (${mismatch.join(', ')}).`,
        };
      }
      console.log(`--mock: resuming from ${file} anyway; skipped the match check (${mismatch.join(', ')}).`);
    }
    if (prior.stopped === undefined || prior.stopped === null) {
      // A run that finished is still worth resuming when it finished around a
      // failure. Only for the whole set, though: a `--limit`, `--filter` or
      // `--no-examples` run that completed graded what it meant to grade, and
      // pouring its handful of verdicts into a full run would leave the rest of
      // the set looking like this run's own work.
      if (isSubsetRun(prior)) {
        return {
          kind: 'refused',
          message: `nothing left to grade: ${file} was a complete run over a chosen part of the set.`,
        };
      }
      reasking = true;
    }
  } else {
    // A mock run never picks a file up on its own: the files here are usually real
    // runs, and carrying real grades into a harness smoke test measures neither.
    if (MOCK) return { kind: 'none' };
    // Newest first, and the first file that was the same interrupted measurement
    // wins. Three kinds of file are passed over. A run under another driver, model,
    // corpus or harness measured something else. A `--limit`, `--filter` or
    // `--no-examples` run graded a chosen part of the set, so carrying its handful
    // of verdicts in place of an earlier run's hundreds would cost the rest. And a
    // run that finished has nothing outstanding to carry: without that rule the
    // first good run makes every later one grade nothing and print PASS from it.
    const found = resultsFilesNewestFirst()
      .map((candidate) => ({ file: candidate, prior: readJson<StoredResults>(candidate, {}) }))
      .find(
        (candidate) =>
          mismatchesOf(candidate.prior).length === 0 &&
          !isSubsetRun(candidate.prior) &&
          (candidate.prior.stopped === 'limit' || candidate.prior.stopped === 'auth'),
      );
    if (!found) return { kind: 'none' };
    file = found.file;
    prior = found.prior;
  }

  const byId = new Map(items.map((item) => [item.id, item]));
  const carried = new Map<string, Graded>();
  let stale = 0;
  for (const stored of prior.items ?? []) {
    if (stored.verdict !== 'agree' && stored.verdict !== 'disagree' && stored.verdict !== 'declined') continue;
    const item = byId.get(stored.id);
    if (!item) continue;
    const sameQuestion = stored.question === undefined || stored.question === item.question;
    const sameKey = stored.answerKey === undefined || stored.answerKey === item.answerKey;
    if (!sameQuestion || !sameKey) {
      stale++;
      continue;
    }
    carried.set(item.id, {
      item,
      response: {
        status: stored.status,
        answer: stored.answer,
        rules: stored.rules ?? [],
        confidence: stored.confidence,
        caveats: stored.caveats ?? [],
        model: prior.model ?? 'unknown',
        corpusDate: prior.corpusDate ?? corpus.effectiveDate,
        usage: stored.usage,
      },
      verdict: stored.verdict,
      reason: stored.graderReason ?? '',
      // The grader call was paid for in that run, and its tokens are reported
      // there. Counting them again here would double the only figure that matters.
      graderUsage: { inputTokens: 0, outputTokens: 0 },
      carried: true,
    });
  }
  if (stale > 0) {
    console.log(`${stale} resumable items ignored: their question or answer key has changed since.`);
  }
  if (reasking) {
    // What a completed file leaves outstanding is of two kinds, and both are
    // named because they mean different things: an item it recorded as `error`
    // was asked and the call failed, and an item it never mentions was added to
    // the set afterwards or dropped before dispatch.
    const outstanding = items.filter((item) => !carried.has(item.id));
    if (outstanding.length === 0) {
      return {
        kind: 'refused',
        message: `nothing left to grade: ${file} was a complete run and every item in it has a verdict.`,
      };
    }
    const erroredIds = new Set(
      (prior.items ?? []).filter((stored) => stored.verdict === 'error').map((stored) => stored.id),
    );
    const errored = outstanding.filter((item) => erroredIds.has(item.id)).length;
    const never = outstanding.length - errored;
    console.log(
      `${file} completed but left ${outstanding.length} item${outstanding.length === 1 ? '' : 's'} ungraded ` +
        `(${errored} errored, ${never} never asked); re-asking ${outstanding.length === 1 ? 'it' : 'them'}.`,
    );
  }
  if (carried.size === 0) return { kind: 'none' };
  console.log(`resumed ${carried.size} graded items from ${file}`);
  return { kind: 'carried', carried, file };
}

function pad(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
}

function usd(n: number) {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

async function main() {
  const { items, heldOutRules, crTrueOnly, truncated } = loadItems();
  if (items.length === 0) {
    console.error('No eval items. Run npm run eval:build first (questions.json may be missing).');
    process.exitCode = 1;
    return;
  }

  const corpus = loadCorpus({ excludeExampleRules: heldOutRules });

  // `--show-request` calls nothing. It prints what one item would be sent, which
  // is the only way to see the reference block and the retrieved rules together.
  if (SHOW_REQUEST !== null) {
    const item = items.find((candidate) => candidate.id === SHOW_REQUEST || candidate.card === SHOW_REQUEST);
    if (!item) {
      console.error(`No item with id or card "${SHOW_REQUEST}".`);
      process.exitCode = 1;
      return;
    }
    const excerpt = buildExcerpt(corpus, { question: item.question });
    console.log(`item            ${item.id} (${item.source}, ${item.card})`);
    console.log(`reference cards ${item.referenceCards.join(', ') || 'none'}`);
    console.log('');
    console.log('USER MESSAGE');
    console.log(`QUESTION\n${item.question}`);
    console.log('');
    console.log(`EXCERPT (retrieval) ${excerpt.text.length} chars, rules ${excerpt.ruleIds.join(', ')}`);
    console.log('');
    console.log(`ANSWER KEY\n${item.answerKey}`);
    return;
  }

  const startedAt = new Date().toISOString();
  console.log(
    `${items.length} items (${items.filter((i) => i.source === 'wotc').length} rulings, ${items.filter((i) => i.source === 'cr-example').length} CR examples), ` +
      `corpus ${corpus.effectiveDate}, ${heldOutRules.size} rules held out${MOCK ? ', MOCK' : ''}`,
  );

  let ask: (item: EvalItem) => Promise<JudgeResponse>;
  let grade: (
    item: EvalItem,
    res: JudgeResponse,
  ) => Promise<{ verdict: Verdict; reason: string; graderUsage: Graded['graderUsage'] }>;

  if (MOCK) {
    ({ ask, grade } = mockDeps(corpus));
  } else {
    const resolved = RESOLVED!;
    if (!resolved.hasCredentials) {
      console.error(`Cannot run: ${resolved.missingHint}. Use --mock to exercise the harness offline.`);
      process.exitCode = 1;
      return;
    }
    console.log(`driver ${resolved.driver}, model ${resolved.modelId}, grounding ${GROUNDING}`);
    if (resolved.note) console.log(resolved.note);
    const { model } = resolved;
    ask = (item) =>
      askJudge({ question: item.question }, { model, corpus, grounding: GROUNDING });
    grade = (item, res) => gradeLive(model, item, res);
  }

  const driverId = RESOLVED?.driver ?? 'mock';
  const modelId = RESOLVED?.modelId ?? MODEL ?? 'mock';
  const resume = loadResume(items, corpus, driverId, modelId);
  if (resume.kind === 'refused') {
    // Nothing is dispatched and no results file is written: a refused resume is
    // the run declining to measure, not a measurement that came out badly.
    console.error(resume.message);
    process.exitCode = 1;
    return;
  }
  const resumedFile = resume.kind === 'carried' ? resume.file : null;
  const carried = resume.kind === 'carried' ? resume.carried : new Map<string, Graded>();
  const todo = items.filter((item) => !carried.has(item.id));

  /**
   * Set by the first call that says the driver has nothing left to answer with:
   * no login, or no plan usage until some stated time. It stops dispatch rather
   * than failing an item, because every remaining call would fail the same way,
   * and an item that was never asked must not be recorded as an item that failed.
   *
   * A holder rather than a bare `let`: it is written inside the worker and read
   * after the pool, and a plain variable narrows to `null` for the reader.
   */
  const stop: { error: ModelAuthError | ModelLimitError | null; kind: StopKind | null } = {
    error: null,
    kind: null,
  };
  /** Only `api` and `claude-code` have a sentence; a mock run never stops. */
  const stopDriver = RESOLVED?.driver ?? 'api';
  let done = 0;
  type Outcome = { graded: Graded } | { skipped: true };

  const runOne = async (item: EvalItem): Promise<Outcome> => {
    if (stop.error !== null) return { skipped: true };
    const started = Date.now();
    const finish = (g: Graded): Outcome => {
      done += 1;
      console.log(`[${done}/${todo.length}] ${pad(g.item.id, 22)} ${pad(g.verdict, 9)} ${Date.now() - started}ms`);
      return { graded: g };
    };
    try {
      const response = await ask(item);
      const { verdict, reason, graderUsage } = await grade(item, response);
      return finish({ item, response, verdict, reason, graderUsage });
    } catch (err) {
      // One item can fail on its own account. A driver with no usable login, or
      // one out of plan usage, would fail every remaining item identically, so it
      // stops the run instead and this item is left ungraded rather than errored.
      if (err instanceof ModelAuthError || err instanceof ModelLimitError) {
        if (stop.error === null) {
          stop.error = err;
          stop.kind = err instanceof ModelLimitError ? 'limit' : 'auth';
        }
        return { skipped: true };
      }
      const message = (err as Error).message;
      return finish({
        item,
        response: {
          status: 'decline',
          answer: '',
          rules: [],
          confidence: 'low',
          caveats: [message],
          model: modelId,
          corpusDate: corpus.effectiveDate,
        },
        verdict: 'error',
        reason: message,
        graderUsage: { inputTokens: 0, outputTokens: 0 },
        error: message,
      });
    }
  };

  // Under full grounding the first item runs alone so its cache write is in place
  // before the rest. Under retrieval there is no shared prefix to warm, and
  // serialising one item would only make the run longer.
  let outcomes: Outcome[] = [];
  if (todo.length === 0) {
    console.log('nothing left to grade: every item was resumed.');
  } else if (SHARED_PREFIX) {
    const first = await runOne(todo[0]);
    const rest = await pool(todo.slice(1), CONCURRENCY, runOne);
    outcomes = [first, ...rest];
  } else {
    outcomes = await pool(todo, CONCURRENCY, runOne);
  }

  const fresh = outcomes.flatMap((outcome) => ('graded' in outcome ? [outcome.graded] : []));
  const undispatched = todo.length - fresh.length;
  /** Everything that has a verdict, in item order, carried and fresh together. */
  const byId = new Map<string, Graded>([...carried, ...fresh.map((g) => [g.item.id, g] as const)]);
  const graded = items.flatMap((item) => {
    const hit = byId.get(item.id);
    return hit ? [hit] : [];
  });
  const stopped: StopKind | null = stop.kind;

  if (graded.length === 0) {
    console.error('No items were graded.');
    if (stop.error !== null) reportStop(stopDriver, stop.error);
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log(`  ${pad('id', 22)} ${pad('verdict', 9)} ${pad('status', 8)} ${pad('conf', 7)} rules`);
  for (const g of graded) {
    const rules = g.response.rules
      .map((r) => `${r.id}${r.verified ? '' : ' [unverified]'}`)
      .join(', ');
    // A leading `~` is a carried item: graded by an earlier run, not by this one.
    console.log(
      `${g.carried ? '~' : ' '} ${pad(g.item.id, 22)} ${pad(g.verdict, 9)} ${pad(g.response.status, 8)} ${pad(g.response.confidence, 7)} ${rules || '-'}`,
    );
  }

  const agree = graded.filter((g) => g.verdict === 'agree').length;
  const disagree = graded.filter((g) => g.verdict === 'disagree').length;
  const declined = graded.filter((g) => g.verdict === 'declined').length;
  const errored = graded.filter((g) => g.verdict === 'error').length;
  /** Items that produced a verdict. An errored item was never graded at all. */
  const gradedCount = graded.length - errored;
  const answers = graded.filter((g) => g.verdict !== 'error' && g.response.status === 'answer');
  const cited = answers.filter((g) => g.response.rules.some((r) => r.verified)).length;
  // Answers, not citations: one answer resting on three invented rule ids is one
  // failure of the thing this feature exists to prevent, not three.
  const unverifiedCitations = graded.filter(
    (g) => g.verdict !== 'error' && g.response.rules.some((r) => !r.verified),
  ).length;
  const agreement = agree + disagree === 0 ? 0 : agree / (agree + disagree);
  const verifiedRuleShare = answers.length === 0 ? 0 : cited / answers.length;
  const declineRate = gradedCount === 0 ? 0 : declined / gradedCount;
  const smokeRun = gradedCount < MIN_GRADED || truncated;
  const smokeWhy = truncated
    ? '--limit graded a prefix of the set, not the set'
    : `${gradedCount} items graded is below ${MIN_GRADED}`;

  /** Judge and grader tokens for one set of items, and what they would bill. */
  const tally = (group: Graded[]) => {
    const judge: JudgeUsage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
    let graderIn = 0;
    let graderOut = 0;
    for (const g of group) {
      const u = g.response.usage;
      if (u) {
        judge.inputTokens += u.inputTokens;
        judge.outputTokens += u.outputTokens;
        judge.cacheRead += u.cacheRead;
        judge.cacheWrite += u.cacheWrite;
      }
      graderIn += g.graderUsage.inputTokens;
      graderOut += g.graderUsage.outputTokens;
    }
    const cost =
      ((judge.inputTokens + graderIn) * PRICE.input +
        judge.cacheRead * PRICE.cacheRead +
        judge.cacheWrite * PRICE.cacheWrite +
        (judge.outputTokens + graderOut) * PRICE.output) /
      1_000_000;
    return { judge, graderIn, graderOut, cost };
  };

  // Reported apart. A carried item's tokens were spent by the run that graded it,
  // and folding them into this run's figure would report a bill nobody paid twice.
  const thisRun = tally(graded.filter((g) => !g.carried));
  const carriedRun = tally(graded.filter((g) => g.carried === true));
  const cost = thisRun.cost + carriedRun.cost;
  const usageLine = (t: ReturnType<typeof tally>) =>
    `judge in ${t.judge.inputTokens}, out ${t.judge.outputTokens}, cache read ${t.judge.cacheRead}, cache write ${t.judge.cacheWrite}; grader in ${t.graderIn}, out ${t.graderOut}`;

  const afterFirst = fresh.slice(1);
  const cacheHits = afterFirst.filter((g) => (g.response.usage?.cacheRead ?? 0) > 0).length;

  // The CR half is only a test at all when some of its statements are wrong: asked
  // "confirm or correct" against sixty true statements, a judge that agrees with
  // everything scores 100% without reading a rule. So a set with no false variants
  // in it, or a slice of one that graded none, is not a measurement either.
  const crGraded = graded.filter((g) => g.verdict !== 'error' && g.item.source === 'cr-example');
  const crFalseGraded = crGraded.filter((g) => g.item.variant === 'false').length;

  const reasons: string[] = [];
  if (stopped !== null) {
    reasons.push(stopReasonLine(stopped, undispatched, { transient: isTransientStop(stop.error) }));
  }
  if (errored > 0) reasons.push(`${errored} item${errored === 1 ? '' : 's'} errored`);
  if (smokeRun) reasons.push(`smoke run (${smokeWhy})`);
  if (!ALLOW_TRUE_ONLY && crTrueOnly) {
    reasons.push(
      'CR examples are all true statements; run eval:build with credentials to generate false variants',
    );
  } else if (!ALLOW_TRUE_ONLY && crGraded.length > 0 && crFalseGraded === 0) {
    reasons.push(`no CR example with a false variant was graded (${crGraded.length} CR items, all true)`);
  }
  if (agreement < MIN_AGREEMENT) reasons.push(`agreement ${pct(agreement)} < ${pct(MIN_AGREEMENT)}`);
  if (unverifiedCitations > 0) reasons.push(`${unverifiedCitations} answers cite an unverified rule`);
  if (declineRate > MAX_DECLINE_RATE) reasons.push(`decline rate ${pct(declineRate)} > ${pct(MAX_DECLINE_RATE)}`);
  const pass = reasons.length === 0;

  console.log('');
  console.log(`agreement       ${pct(agreement)}  (${agree} agree, ${disagree} disagree)`);
  console.log(`decline rate    ${pct(declineRate)}  (${declined} of ${gradedCount} graded, cap ${pct(MAX_DECLINE_RATE)})`);
  console.log(`unverified      ${unverifiedCitations} answer${unverifiedCitations === 1 ? '' : 's'} cite a rule the corpus does not know`);
  console.log(`verified rule   ${pct(verifiedRuleShare)}  (${cited} of ${answers.length} answers carry one; information, not a gate)`);
  console.log(`errors          ${errored} item${errored === 1 ? '' : 's'} failed to run`);
  console.log(
    `CR examples     ${crGraded.length} graded, ${crFalseGraded} of them false variants${crTrueOnly ? ' (file has none)' : ''}`,
  );
  if (ALLOW_TRUE_ONLY) console.log('  --allow-true-only: the false-variant check is waived for this run');
  if (smokeRun) console.log(`smoke run       ${smokeWhy}; this run cannot PASS`);
  if (carried.size > 0) console.log(`resumed         ${carried.size} items carried from ${resumedFile ?? 'an earlier run'}`);
  // Usage and cost are both reported this run against carried, and for the same
  // reason: a carried item's tokens were spent by the run that graded it, and one
  // combined figure would report a bill nobody paid twice.
  console.log(`usage this run  ${usageLine(thisRun)}`);
  console.log(carried.size > 0 ? `usage carried   ${usageLine(carriedRun)}` : 'usage carried   none');
  // On the subscription driver these tokens cost nothing at the margin, so the
  // figure is what the same run would have billed as API credits, not a bill.
  const priced = RESOLVED?.driver === 'claude-code' ? 'at API list prices (this run drew on the subscription instead)' : 'estimated';
  console.log(`cost this run   ${usd(thisRun.cost)} ${priced}`);
  console.log(
    carried.size > 0
      ? `cost carried    ${usd(carriedRun.cost)} paid by the earlier run (total ${usd(cost)})`
      : 'cost carried    none',
  );
  if (SHARED_PREFIX) {
    console.log(`cache           ${cacheHits} of ${afterFirst.length} requests after the first read the cache`);
    if (afterFirst.length > 0 && cacheHits === 0) console.log('  warning: nothing read the cache; the prefix is changing between requests');
  } else {
    console.log('cache           retrieval grounding: no shared cache prefix expected');
  }
  console.log('');
  console.log(
    pass
      ? `PASS  ${gradedCount} items, agreement ${pct(agreement)} >= ${pct(MIN_AGREEMENT)}, 0 unverified citations, decline rate ${pct(declineRate)}, 0 errors`
      : `FAIL  ${reasons.join('; ')}`,
  );

  // Colons are illegal in Windows filenames, so the timestamp is dashed.
  const stamp = startedAt.replace(/[:.]/g, '-');
  const outPath = OUT ?? path.join(RESULTS_DIR, `${stamp}.json`);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        mock: MOCK,
        // The resolved id, not the flag: `--model` is absent on most runs, and a
        // result that cannot say which model produced it is not worth keeping.
        model: modelId,
        driver: driverId,
        grounding: GROUNDING,
        corpusDate: corpus.effectiveDate,
        /**
         * What this harness asked and what it grounded the answer in. Resume
         * requires it to match: corpus, driver, model and grounding do not say
         * whether the earlier run measured the same thing.
         */
        harness: harnessFingerprint(corpus),
        requestShape: REQUEST_SHAPE_VERSION,
        /** `limit` or `auth` when the driver ended the run early; null otherwise. */
        stopped,
        // What part of the set this run graded. A run with any of these three
        // measured a subset and is never resumed from automatically.
        limitedTo: LIMIT === Infinity ? null : LIMIT,
        filter: FILTER,
        noExamples: NO_EXAMPLES,
        resumedFrom: resumedFile,
        resumedCount: carried.size,
        /** Items this run had left to grade but never dispatched, after a stop. */
        notAsked: undispatched,
        heldOutRules: [...heldOutRules],
        crTrueOnly,
        gate: {
          pass,
          reasons,
          minAgreement: MIN_AGREEMENT,
          maxDeclineRate: MAX_DECLINE_RATE,
          minGraded: MIN_GRADED,
          allowTrueOnly: ALLOW_TRUE_ONLY,
        },
        metrics: {
          total: graded.length,
          graded: gradedCount,
          agree,
          disagree,
          declined,
          errored,
          agreement,
          declineRate,
          verifiedRuleShare,
          unverifiedCitations,
          smokeRun,
          crGraded: crGraded.length,
          crFalseGraded,
          cacheHitsAfterFirst: cacheHits,
          // This run's own spend. Carried items are reported beside it, never
          // folded in: their tokens belong to the run that graded them.
          judgeUsage: thisRun.judge,
          graderUsage: { inputTokens: thisRun.graderIn, outputTokens: thisRun.graderOut },
          estimatedCostUsd: thisRun.cost,
          carried: {
            items: carried.size,
            judgeUsage: carriedRun.judge,
            graderUsage: { inputTokens: carriedRun.graderIn, outputTokens: carriedRun.graderOut },
            estimatedCostUsd: carriedRun.cost,
          },
          totalCostUsd: cost,
        },
        items: graded.map((g) => ({
          id: g.item.id,
          source: g.item.source,
          card: g.item.card,
          variant: g.item.variant,
          carried: g.carried === true,
          /** Card text the question carried, so a decline asking for it is visible. */
          referenceCards: g.item.referenceCards,
          question: g.item.question,
          answerKey: g.item.answerKey,
          verdict: g.verdict,
          graderReason: g.reason,
          error: g.error,
          status: g.response.status,
          answer: g.response.answer,
          confidence: g.response.confidence,
          rules: g.response.rules,
          caveats: g.response.caveats,
          usage: g.response.usage,
        })),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`wrote ${outPath}`);

  // Said last, once every graded item is safely on disk: the sentence is what to
  // do next, and the next run carries all of this over rather than paying again.
  if (stop.error !== null) {
    reportStop(stopDriver, stop.error);
    process.exitCode = 1;
    return;
  }

  if (!pass) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`eval:judge failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
