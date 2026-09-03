/**
 * Grades the advisory judge against the held-out set `eval:build` produced.
 *
 *   npm run eval:judge                      the whole set, live
 *   npm run eval:judge -- --limit 20        first N items
 *   npm run eval:judge -- --filter Rhystic  items whose card or id matches
 *   npm run eval:judge -- --mock            offline, exercises the harness only
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
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { JudgeGrounding, JudgeResponse, JudgeUsage } from '../src/domain/judge.ts';
import { type Corpus, loadCorpus, resolveRule } from '../server/judge/corpus.ts';
import { MAX_QUESTION_CHARS, askJudge } from '../server/judge/core.ts';
import { ModelAuthError, type JudgeModel } from '../server/judge/model.ts';
import {
  CR_EXAMPLES_PATH,
  QUESTIONS_PATH,
  RESULTS_DIR,
  flagValue,
  pool,
  readJson,
  reportAuthFailure,
  resolveModel,
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
}

interface Graded {
  item: EvalItem;
  response: JudgeResponse;
  verdict: Verdict;
  reason: string;
  graderUsage: { inputTokens: number; outputTokens: number };
  /** Set when the call itself failed. The item is graded `error` and fails the gate. */
  error?: string;
}

const args = process.argv.slice(2);
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
 * halves of a run are billed the same way. A `--mock` run resolves nothing: it
 * never calls a model, and probing for a CLI it will not use is just noise.
 */
const RESOLVED = MOCK ? null : await resolveModel(args, { defaultConcurrency: 3 });
const CONCURRENCY = RESOLVED?.concurrency ?? 3;

interface StoredQuestion {
  id: string;
  card: string;
  question: string;
  answerKey: string;
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

  const items: EvalItem[] = questions.map((q) => ({
    id: q.id,
    source: 'wotc',
    card: q.card,
    question: q.question,
    answerKey: q.answerKey,
  }));
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

/**
 * Offline stand-ins. The judge stub answers from the answer key and cites a rule
 * the corpus really has; the grader stub is string equality. Together they make
 * a run that must come out PASS, so a failing `--mock` run is a harness bug.
 */
function mockDeps(corpus: Corpus) {
  let calls = 0;
  const ask = async (item: EvalItem): Promise<JudgeResponse> => {
    const n = calls++;
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

  const runOne = async (item: EvalItem): Promise<Graded> => {
    try {
      const response = await ask(item);
      const { verdict, reason, graderUsage } = await grade(item, response);
      return { item, response, verdict, reason, graderUsage };
    } catch (err) {
      // One item can fail on its own account. A driver with no usable login
      // would fail every remaining item identically, so it ends the run instead.
      if (err instanceof ModelAuthError) throw err;
      const message = (err as Error).message;
      return {
        item,
        response: {
          status: 'decline',
          answer: '',
          rules: [],
          confidence: 'low',
          caveats: [message],
          model: RESOLVED?.modelId ?? MODEL ?? 'unknown',
          corpusDate: corpus.effectiveDate,
        },
        verdict: 'error',
        reason: message,
        graderUsage: { inputTokens: 0, outputTokens: 0 },
        error: message,
      };
    }
  };

  // Under full grounding the first item runs alone so its cache write is in place
  // before the rest. Under retrieval there is no shared prefix to warm, and
  // serialising one item would only make the run longer.
  let graded: Graded[];
  try {
    if (SHARED_PREFIX) {
      const first = await runOne(items[0]);
      const rest = await pool(items.slice(1), CONCURRENCY, runOne);
      graded = [first, ...rest];
    } else {
      graded = await pool(items, CONCURRENCY, runOne);
    }
  } catch (err) {
    if (reportAuthFailure(RESOLVED?.driver ?? 'api', err)) {
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  console.log('');
  console.log(`${pad('id', 22)} ${pad('verdict', 9)} ${pad('status', 8)} ${pad('conf', 7)} rules`);
  for (const g of graded) {
    const rules = g.response.rules
      .map((r) => `${r.id}${r.verified ? '' : ' [unverified]'}`)
      .join(', ');
    console.log(
      `${pad(g.item.id, 22)} ${pad(g.verdict, 9)} ${pad(g.response.status, 8)} ${pad(g.response.confidence, 7)} ${rules || '-'}`,
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

  const judgeUsage: JudgeUsage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
  let graderIn = 0;
  let graderOut = 0;
  for (const g of graded) {
    const u = g.response.usage;
    if (u) {
      judgeUsage.inputTokens += u.inputTokens;
      judgeUsage.outputTokens += u.outputTokens;
      judgeUsage.cacheRead += u.cacheRead;
      judgeUsage.cacheWrite += u.cacheWrite;
    }
    graderIn += g.graderUsage.inputTokens;
    graderOut += g.graderUsage.outputTokens;
  }
  const cost =
    ((judgeUsage.inputTokens + graderIn) * PRICE.input +
      judgeUsage.cacheRead * PRICE.cacheRead +
      judgeUsage.cacheWrite * PRICE.cacheWrite +
      (judgeUsage.outputTokens + graderOut) * PRICE.output) /
    1_000_000;

  const afterFirst = graded.slice(1);
  const cacheHits = afterFirst.filter((g) => (g.response.usage?.cacheRead ?? 0) > 0).length;

  // The CR half is only a test at all when some of its statements are wrong: asked
  // "confirm or correct" against sixty true statements, a judge that agrees with
  // everything scores 100% without reading a rule. So a set with no false variants
  // in it, or a slice of one that graded none, is not a measurement either.
  const crGraded = graded.filter((g) => g.verdict !== 'error' && g.item.source === 'cr-example');
  const crFalseGraded = crGraded.filter((g) => g.item.variant === 'false').length;

  const reasons: string[] = [];
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
  console.log(
    `usage           judge in ${judgeUsage.inputTokens}, out ${judgeUsage.outputTokens}, cache read ${judgeUsage.cacheRead}, cache write ${judgeUsage.cacheWrite}; grader in ${graderIn}, out ${graderOut}`,
  );
  // On the subscription driver these tokens cost nothing at the margin, so the
  // figure is what the same run would have billed as API credits, not a bill.
  console.log(
    `cost            ${usd(cost)} ${RESOLVED?.driver === 'claude-code' ? 'at API list prices (this run drew on the subscription instead)' : 'estimated'}`,
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
        model: RESOLVED?.modelId ?? graded[0].response.model,
        driver: RESOLVED?.driver ?? 'mock',
        grounding: GROUNDING,
        corpusDate: corpus.effectiveDate,
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
          judgeUsage,
          graderUsage: { inputTokens: graderIn, outputTokens: graderOut },
          estimatedCostUsd: cost,
        },
        items: graded.map((g) => ({
          id: g.item.id,
          source: g.item.source,
          card: g.item.card,
          variant: g.item.variant,
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

  if (!pass) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`eval:judge failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
