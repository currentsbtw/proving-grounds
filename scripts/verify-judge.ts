/**
 * Verification harness for the advisory judge's backend.
 *
 *   npm run verify:judge          offline, downloads nothing, calls no API
 *   npm run verify:judge -- --live   adds two real model calls
 *
 * The offline pass is the one that runs in a build: it checks the corpus index,
 * the citation resolver, the table renderer, the two grounding shapes of the
 * system prompt, retrieval itself, and `askJudge` against a fake driver,
 * including the two cases that matter most (an answer whose every citation is
 * unverifiable must come back as a decline, and a decline that names a rule the
 * excerpt lacked must trigger exactly one widening pass).
 *
 * `--live` exists to check the two things a fake cannot: that in `full`
 * grounding the corpus block really is read from cache on a second call, and
 * that `retrieval` really does read an order of magnitude less. It drives the
 * real api driver, so a drift there shows up here.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import type { JudgeTableContext } from '../src/domain/judge.ts';
import { CORPUS_PATH, corpusExists, loadCorpus, resolveRule } from '../server/judge/corpus.ts';
import { askJudge, buildSystemBlocks, renderTableContext } from '../server/judge/core.ts';
import { createApiModel } from '../server/judge/drivers/api.ts';
import { noOutputError, parseCliResult, scrubbedEnv } from '../server/judge/drivers/claudeCode.ts';
import type { JudgeModel, ModelRequest, ModelResult, SystemBlock } from '../server/judge/model.ts';
import {
  classifyModelFailure,
  ModelAuthError,
  ModelLimitError,
  ModelUpstreamError,
} from '../server/judge/model.ts';
import { buildExcerpt, missingRuleIds } from '../server/judge/retrieval.ts';

const failures: string[] = [];
let checks = 0;

/** Any schema does for the CLI parser's failure paths: they throw before it is used. */
const JudgeOutputShape = z.object({ answer: z.string() });

function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) {
    console.log(`  ok   ${label}${detail ? ` (${detail})` : ''}`);
  } else {
    console.log(`  FAIL ${label}${detail ? ` (${detail})` : ''}`);
    failures.push(label);
  }
}

function note(label: string, detail: string) {
  console.log(`  ..   ${label} (${detail})`);
}

const FIXTURE: JudgeTableContext = {
  turn: 6,
  phase: 'precombat main',
  life: 27,
  commanderTax: 4,
  cards: [
    {
      name: 'Sol Ring',
      zone: 'battlefield',
      tapped: true,
      typeLine: 'Artifact',
      oracleText: '{T}: Add {C}{C}.',
    },
    {
      name: 'Kenrith, the Returned King',
      zone: 'command',
      isCommander: true,
      typeLine: 'Legendary Creature — Human Noble',
      oracleText: '{R}: All creatures gain haste until end of turn.',
    },
    { name: 'Swords to Plowshares', zone: 'hand', typeLine: 'Instant', oracleText: 'Exile target creature.' },
    { name: 'Llanowar Elves', zone: 'graveyard' },
    { name: 'Brainstorm', zone: 'exile' },
  ],
  // A cast spell arrives as a tray item carrying its own text and appears
  // nowhere under `cards`; a trigger is a labelled object with no text.
  stack: [
    { kind: 'trigger', label: 'Kenrith activated ability' },
    {
      kind: 'spell',
      label: 'Cultivate',
      typeLine: 'Sorcery',
      oracleText:
        'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.',
    },
  ],
  activeEvent: {
    seat: 'B',
    type: 'counter',
    prompt: 'Respond or resolve.',
    card: { name: 'Swan Song', effect: 'Counter target enchantment, instant, or Sorcery spell.' },
  },
  seats: [
    { id: 'A', life: 40, eliminated: false, threat: 3, silhouette: { creatures: 2, power: 5, artifacts: 1, openMana: 3 } },
    { id: 'B', life: 33, eliminated: false, threat: 6, silhouette: { creatures: 4, power: 11, artifacts: 0, openMana: 2 } },
    { id: 'C', life: 0, eliminated: true, threat: 0, silhouette: { creatures: 0, power: 0, artifacts: 0, openMana: 0 } },
  ],
};

interface StubReply {
  status: 'answer' | 'decline';
  answer: string;
  rules: string[];
  confidence: 'high' | 'medium' | 'low';
  caveats: string[];
}

interface StubModel extends JudgeModel {
  /** Every request `askJudge` made, so a test can count calls and read block 2. */
  calls: { system: SystemBlock[]; user: string }[];
}

/**
 * Stands in for a driver so the offline pass never touches the network. Replies
 * are consumed in order; the last one repeats, which keeps single-reply call
 * sites terse.
 */
function stubModel(replies: StubReply | StubReply[]): StubModel {
  const queue = Array.isArray(replies) ? replies : [replies];
  const calls: { system: SystemBlock[]; user: string }[] = [];
  return {
    driver: 'api',
    defaultModel: 'stub-judge',
    calls,
    async complete<T>(req: ModelRequest<T>): Promise<ModelResult<T>> {
      calls.push({ system: req.system, user: req.user });
      const reply = queue[Math.min(calls.length - 1, queue.length - 1)];
      if (!reply) throw new ModelUpstreamError('stub ran out of replies');
      return {
        parsed: reply as unknown as T,
        model: 'stub-judge',
        usage: { inputTokens: 12, outputTokens: 34, cacheRead: 250_000, cacheWrite: 0 },
      };
    },
  };
}

function reply(rules: string[], status: 'answer' | 'decline' = 'answer'): StubReply {
  return {
    status,
    answer: 'Yes. Commander replacement applies on the way to the graveyard.',
    rules,
    confidence: 'high',
    caveats: [],
  };
}

async function offline() {
  if (!corpusExists()) {
    console.error(`No Comprehensive Rules text at ${CORPUS_PATH}.`);
    console.error('Fetch it with: npm run judge:corpus');
    process.exit(1);
  }

  console.log('corpus');
  const corpus = loadCorpus();
  check('rule count', corpus.rules.size >= 3000, `${corpus.rules.size} rules`);
  check('effective date parsed', /\d{4}$/.test(corpus.effectiveDate), corpus.effectiveDate);
  const bom = String.fromCodePoint(0xfeff);
  check('no BOM or CRLF in text', !corpus.text.startsWith(bom) && !corpus.text.includes('\r'));

  console.log('resolveRule');
  // 704.5aa is the two-letter subrule: rule 704.5 runs past `z`, and a
  // one-letter id pattern indexed neither the line nor the citation.
  for (const id of ['903.9a', '704.5g', '903.8', '704.5aa']) {
    const hit = resolveRule(corpus, id);
    check(`finds ${id}`, hit !== null && hit.id === id, hit ? `${hit.text.slice(0, 48)}...` : 'missing');
  }
  check('rejects 999.99z', resolveRule(corpus, '999.99z') === null);
  check('rejects a three-letter suffix', resolveRule(corpus, '704.5aaa') === null);
  for (const spelling of ['903.9(a)', 'rule 903.9a', 'CR 903.9a', '903.9a.']) {
    check(`accepts "${spelling}"`, resolveRule(corpus, spelling)?.id === '903.9a');
  }

  console.log('glossary');
  check('term count', corpus.glossary.size >= 300, `${corpus.glossary.size} terms`);
  check('has Commander', (corpus.glossary.get('Commander') ?? '').includes('903'));

  console.log('examples');
  const exampleCount = [...corpus.rules.values()].reduce((n, rule) => n + rule.examples.length, 0);
  check('example count', exampleCount >= 250, `${exampleCount} examples`);
  const withExamples = [...corpus.rules.values()].filter((rule) => rule.examples.length > 0);
  const heldOut = withExamples.slice(0, 3);
  const heldOutIds = new Set(heldOut.map((rule) => rule.id));
  const trimmed = loadCorpus({ excludeExampleRules: heldOutIds });
  const heldLines = heldOut.flatMap((rule) => rule.examples);
  check(
    'held-out examples leave the text',
    heldLines.every((line) => corpus.text.includes(line) && !trimmed.text.includes(line)),
    `${heldLines.length} lines from ${heldOut.map((r) => r.id).join(', ')}`,
  );
  check('nothing else is cut', trimmed.rules.size === corpus.rules.size);

  console.log('table renderer');
  const rendered = renderTableContext(FIXTURE);
  check('names the battlefield card', rendered.includes('Sol Ring'));
  check('names the commander', rendered.includes('Kenrith, the Returned King'));
  check('carries oracle text', rendered.includes('{T}: Add {C}{C}.'));
  check('names the graveyard card', rendered.includes('Llanowar Elves'));
  check('cites the event card', rendered.includes('Swan Song'));
  check('a tray spell is not repeated as a stack card', !rendered.includes('On the stack'));
  check('stack tray is a list, top last', rendered.includes('Stack tray, top last:'));
  check('tray trigger reads kind and label', rendered.includes('1. trigger: Kenrith activated ability'));
  check(
    'tray spell carries its own text',
    rendered.includes('2. Cultivate | Sorcery |') && rendered.includes('Search your library for up to two basic land cards'),
  );
  check(
    'tray item carries commander, tapped and counters',
    renderTableContext({
      ...FIXTURE,
      stack: [
        {
          kind: 'spell',
          label: 'Kenrith, the Returned King',
          typeLine: 'Legendary Creature — Human Noble',
          isCommander: true,
          tapped: true,
          counters: { '+1/+1': 2, loyalty: 0 },
        },
      ],
    }).includes('1. Kenrith, the Returned King | Legendary Creature — Human Noble | commander | tapped | 2 +1/+1 counters'),
  );
  const stackZone = renderTableContext({
    ...FIXTURE,
    cards: [
      {
        name: 'Cyclonic Rift',
        zone: 'stack',
        typeLine: 'Instant',
        oracleText: 'Return target nonland permanent you do not control to its owner’s hand.',
      },
    ],
  });
  check(
    'a stack-zone card is rendered, not dropped',
    stackZone.includes('On the stack:') &&
      stackZone.includes('- Cyclonic Rift | Instant | Return target nonland permanent'),
  );
  check('marks the dead seat', rendered.includes('Seat C: eliminated'));
  // The guard is against a library *section*, not against the word: real oracle
  // text says "search your library" constantly and always will.
  check('omits the library zone', !/^\s*(your )?library\b/im.test(rendered));
  const bare = renderTableContext({ ...FIXTURE, cards: [], stack: [], activeEvent: undefined });
  check('omits empty sections', !bare.includes('Your hand:') && !bare.includes('Stack tray'));

  console.log('claude-code driver');
  // The driver's name has to be true: it spends the subscription, never a key.
  // Nothing can read the environment back out of a spawned child, so the check
  // is on the environment the driver builds for every spawn it makes.
  const before = {
    key: process.env.ANTHROPIC_API_KEY,
    token: process.env.ANTHROPIC_AUTH_TOKEN,
  };
  process.env.ANTHROPIC_API_KEY = 'sk-ant-verify-judge';
  process.env.ANTHROPIC_AUTH_TOKEN = 'verify-judge-token';
  const childEnv = scrubbedEnv();
  check(
    'the spawn environment drops both API credentials',
    !('ANTHROPIC_API_KEY' in childEnv) && !('ANTHROPIC_AUTH_TOKEN' in childEnv),
  );
  check('and keeps the rest of the environment', childEnv.PATH === process.env.PATH);
  if (before.key === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = before.key;
  if (before.token === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  else process.env.ANTHROPIC_AUTH_TOKEN = before.token;

  // The CLI reports a spent plan window the way it reports everything else: a
  // successful-looking envelope with `is_error` true and one sentence in
  // `result`. The sentence below is verbatim from the run that stopped 119 items
  // in on 2026-09-03, and reading it as an ordinary upstream failure is what let
  // that run keep dispatching calls no plan could answer.
  const limitEnvelope = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: "You've hit your session limit · resets 11:20pm (America/Los_Angeles)",
  });
  let limitErr: unknown;
  try {
    parseCliResult(limitEnvelope, JudgeOutputShape, 'claude-opus-5');
  } catch (err) {
    limitErr = err;
  }
  check('a session limit is a ModelLimitError', limitErr instanceof ModelLimitError);
  check(
    'and carries the reset time verbatim',
    limitErr instanceof ModelLimitError && limitErr.resetsAt === '11:20pm (America/Los_Angeles)',
    limitErr instanceof ModelLimitError ? String(limitErr.resetsAt) : 'not a limit error',
  );
  let authErr: unknown;
  try {
    parseCliResult(
      JSON.stringify({ is_error: true, result: 'Not logged in. Run /login.' }),
      JudgeOutputShape,
      'claude-opus-5',
    );
  } catch (err) {
    authErr = err;
  }
  check('a missing login is still a ModelAuthError', authErr instanceof ModelAuthError);
  let otherErr: unknown;
  try {
    parseCliResult(
      JSON.stringify({ is_error: true, result: 'Model overloaded, try again.' }),
      JudgeOutputShape,
      'claude-opus-5',
    );
  } catch (err) {
    otherErr = err;
  }
  check(
    'any other failure is still upstream',
    otherErr instanceof ModelUpstreamError && !(otherErr instanceof ModelLimitError),
  );
  // A weekly limit words the reset as a date. The check is on "limit" or a
  // "resets" clause rather than on the sentences we have happened to see.
  let weeklyErr: unknown;
  try {
    parseCliResult(
      JSON.stringify({ is_error: true, result: 'Weekly usage exhausted, resets Nov 5' }),
      JudgeOutputShape,
      'claude-opus-5',
    );
  } catch (err) {
    weeklyErr = err;
  }
  check(
    'a weekly "resets Nov 5" wording is a limit too',
    weeklyErr instanceof ModelLimitError && weeklyErr.resetsAt === 'Nov 5',
    weeklyErr instanceof ModelLimitError ? String(weeklyErr.resetsAt) : 'not a limit error',
  );
  // The CLI can refuse before it has an envelope to print, and say so on stderr.
  // That path threw a plain upstream error, which a batch caller keeps dispatching past.
  const stderrLimit = noOutputError(1, "You've hit your session limit · resets 11:20pm (America/Los_Angeles)");
  check(
    'a limit on stderr with no stdout is a ModelLimitError',
    stderrLimit instanceof ModelLimitError &&
      stderrLimit.resetsAt === '11:20pm (America/Los_Angeles)',
    stderrLimit instanceof ModelLimitError ? String(stderrLimit.resetsAt) : stderrLimit.message,
  );
  check(
    'an ordinary silent exit is still upstream',
    noOutputError(1, 'spawn failed') instanceof ModelUpstreamError,
  );

  console.log('api driver');
  // The SDK's own 429. It reaches the proxy and the eval as the same error the
  // CLI's session limit does, so one stop rule covers both drivers.
  const rateLimited = new Anthropic.RateLimitError(
    429,
    { error: { message: 'rate limit exceeded' } },
    'Rate limited; resets in a minute',
    new Headers(),
  );
  const rateLimitedClient = {
    messages: {
      parse: () => {
        throw rateLimited;
      },
    },
  } as unknown as Anthropic;
  let apiErr: unknown;
  try {
    await createApiModel({ client: rateLimitedClient }).complete({
      system: [{ text: 'x' }],
      user: 'x',
      schema: JudgeOutputShape,
      effort: 'low',
      maxTokens: 16,
    });
  } catch (err) {
    apiErr = err;
  }
  check('a 429 becomes a ModelLimitError', apiErr instanceof ModelLimitError, String((apiErr as Error)?.message));
  check(
    'and the proxy answers 503 limit for it',
    classifyModelFailure(apiErr, 'api')?.code === 'limit',
  );

  console.log('proxy error codes');
  const limitFailure = classifyModelFailure(
    new ModelLimitError('session limit', '11:20pm (America/Los_Angeles)'),
    'claude-code',
  );
  check(
    'a limit answers 503 limit',
    limitFailure?.status === 503 && limitFailure.code === 'limit',
    `${limitFailure?.status} ${limitFailure?.code}`,
  );
  check(
    'and names the reset time',
    limitFailure?.error === 'Judge is out of plan usage until 11:20pm (America/Los_Angeles).',
    limitFailure?.error ?? 'no message',
  );
  check(
    'a limit with no reset time says try again',
    classifyModelFailure(new ModelLimitError('rate limited'), 'api')?.error ===
      'Judge is rate limited. Try again in a minute.',
  );
  check(
    'no login still answers 503 no_login on claude-code',
    classifyModelFailure(new ModelAuthError('x'), 'claude-code')?.code === 'no_login',
  );
  check(
    'no key still answers 503 no_key on api',
    classifyModelFailure(new ModelAuthError('x'), 'api')?.code === 'no_key',
  );
  check(
    'an upstream failure still answers 502 upstream',
    classifyModelFailure(new ModelUpstreamError('x'), 'api')?.status === 502,
  );
  check('anything else is not the driver seam’s to classify', classifyModelFailure(new Error('x'), 'api') === null);

  console.log('system prompt');
  const blocks = buildSystemBlocks(corpus, 'full');
  check('two blocks', blocks.length === 2);
  check('policy first', blocks[0].text.startsWith('You are the advisory rules judge'));
  check('policy is not cached alone', blocks[0].cache === undefined);
  check('corpus second', blocks[1].text === corpus.text);
  check('corpus marked for cache', blocks[1].cache === true);
  check(
    'no date in the cached prefix',
    !blocks[0].text.includes(corpus.effectiveDate) && !/\b20\d\d\b/.test(blocks[0].text),
  );
  // Half the eval asks "Is that right? Confirm it or correct it." On a verbatim,
  // true CR example about colour identity the judge answered "Close, but ...",
  // restated the same rule in its own words and was graded disagree. Every fact
  // was right; the verdict framing was not. The fake driver cannot exercise the
  // model, so what is checked here is that the instruction is in the prompt.
  check(
    'policy prompt carries confirm-or-correct guidance',
    blocks[0].text.includes('asked to confirm or correct a statement') &&
      blocks[0].text.includes('confirm it plainly') &&
      blocks[0].text.includes('wrong outcome at the table'),
  );

  console.log('askJudge');
  const mixed = await askJudge(
    { question: 'Can a commander go to the command zone instead of the graveyard?', table: FIXTURE },
    { model: stubModel(reply(['903.9a', '999.99z'])), corpus, grounding: 'full' },
  );
  check('keeps status answer', mixed.status === 'answer');
  check('two citations', mixed.rules.length === 2);
  check(
    'verified rule carries text',
    mixed.rules[0].verified && (mixed.rules[0].text ?? '').startsWith('903.9a'),
  );
  check('unknown rule kept unverified', mixed.rules[1].id === '999.99z' && !mixed.rules[1].verified);
  check('reports the corpus date', mixed.corpusDate === corpus.effectiveDate);
  check('reports usage', mixed.usage?.cacheRead === 250_000);

  const unverified = await askJudge(
    { question: 'Does this work?' },
    { model: stubModel(reply(['999.99z'])), corpus, grounding: 'full' },
  );
  check('all-unverified downgrades to decline', unverified.status === 'decline');
  check(
    'downgrade leaves a caveat',
    unverified.caveats.includes('No verifiable rule citation.'),
    unverified.caveats.join(' / '),
  );

  const empty = await askJudge(
    { question: 'x' },
    { model: stubModel(reply([])), corpus, grounding: 'full' },
  );
  check('no citations at all also declines', empty.status === 'decline');

  for (const [label, question] of [
    ['empty question', '   '],
    ['overlong question', 'a'.repeat(2001)],
  ] as const) {
    let threw = false;
    try {
      await askJudge({ question }, { model: stubModel(reply(['903.9a'])), corpus, grounding: 'full' });
    } catch {
      threw = true;
    }
    check(`rejects ${label}`, threw);
  }

  console.log('grounding');
  const retrievalBlocks = buildSystemBlocks(corpus, 'retrieval', 'RULES EXCERPT (...)');
  check('policy prompt is byte-identical in both modes', retrievalBlocks[0].text === blocks[0].text);
  check('excerpt block is not cached', retrievalBlocks[1].cache === undefined);
  check('excerpt block carries the excerpt', retrievalBlocks[1].text === 'RULES EXCERPT (...)');
  const groundingDefault = await askJudge(
    { question: 'If my commander dies, can I put it back in the command zone?' },
    { model: stubModel(reply(['903.9a'])), corpus },
  );
  check('grounding defaults to retrieval', groundingDefault.grounding === 'retrieval');
  check('response reports the driver model', groundingDefault.model === 'stub-judge');
  const fullReported = await askJudge(
    { question: 'x' },
    { model: stubModel(reply(['903.9a'])), corpus, grounding: 'full' },
  );
  check('full grounding is reported back', fullReported.grounding === 'full');

  console.log('retrieval');
  const commanderQ = 'If my commander dies, can I put it back in the command zone?';
  const commanderExcerpt = buildExcerpt(corpus, { question: commanderQ, table: undefined });
  note('commander excerpt', `${commanderExcerpt.text.length} chars, ${commanderExcerpt.ruleIds.length} rules`);
  check('includes 903.9a', commanderExcerpt.ruleIds.includes('903.9a'));
  check('includes its parent 903.9', commanderExcerpt.ruleIds.includes('903.9'));
  // The budget is a ceiling, not a target: a narrow question spends a fraction
  // of it, because selection stops at the score floor long before it runs out.
  check(
    'comes in well under the budget',
    commanderExcerpt.text.length < 20_000,
    `${commanderExcerpt.text.length} chars of 48,000`,
  );
  const header = commanderExcerpt.text.split('\n')[0];
  check(
    'header names the corpus and lists ids',
    header.startsWith(`RULES EXCERPT (Comprehensive Rules effective ${corpus.effectiveDate}; contains rules: `) &&
      header.includes('903.9a'),
  );
  check(
    'excerpt is deterministic',
    buildExcerpt(corpus, { question: commanderQ }).text === commanderExcerpt.text,
  );
  check(
    'excerpt is far smaller than the corpus',
    commanderExcerpt.text.length < corpus.text.length / 15,
    `1/${Math.round(corpus.text.length / commanderExcerpt.text.length)} of the corpus`,
  );

  const explicitQ = 'Does rule 704.5aa apply if my library is empty and I have not drawn yet?';
  const explicitExcerpt = buildExcerpt(corpus, { question: explicitQ });
  note('explicit-id excerpt', `${explicitExcerpt.text.length} chars, ${explicitExcerpt.ruleIds.length} rules`);
  check('includes the named 704.5aa', explicitExcerpt.ruleIds.includes('704.5aa'));
  check('includes its parent 704.5', explicitExcerpt.ruleIds.includes('704.5'));

  const rhystic = {
    question:
      'My opponent casts a spell while I control Rhystic Study. When does the trigger go on the stack and when do they choose to pay?',
    table: {
      ...FIXTURE,
      cards: [
        {
          name: 'Rhystic Study',
          zone: 'battlefield' as const,
          typeLine: 'Enchantment',
          oracleText:
            'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.',
        },
      ],
      stack: [],
      activeEvent: undefined,
    },
  };
  const rhysticExcerpt = buildExcerpt(corpus, rhystic);
  note('rhystic excerpt', `${rhysticExcerpt.text.length} chars, ${rhysticExcerpt.ruleIds.length} rules`);
  const castingRules = rhysticExcerpt.ruleIds.filter((id) => id.startsWith('601.') || id.startsWith('603.'));
  check(
    'reaches casting or triggered-ability rules',
    castingRules.length > 0,
    castingRules.slice(0, 6).join(', '),
  );

  const hexproofExcerpt = buildExcerpt(corpus, {
    question: 'Does hexproof stop a board wipe that destroys all creatures?',
  });
  note('hexproof excerpt', `${hexproofExcerpt.text.length} chars, ${hexproofExcerpt.ruleIds.length} rules`);
  check('glossary section is present', hexproofExcerpt.text.includes('\nGLOSSARY\n'));
  check(
    'glossary carries the Hexproof entry',
    hexproofExcerpt.text.includes('\nHexproof\n') &&
      hexproofExcerpt.text.includes((corpus.glossary.get('Hexproof') ?? 'missing').slice(0, 40)),
  );

  // Delayed triggered abilities, from the live eval item that declined on them.
  // The card's words are "sacrifice it at the beginning of the next end step";
  // the rule that settles it, 603.7, says "delayed triggered ability" and shares
  // almost no vocabulary with the question, so BM25 alone never reached it and
  // the judge declined naming 603.7 itself. The cue table is what puts it in.
  const kikiOracle =
    "Kiki-Jiki, Mirror Breaker | Legendary Creature — Goblin Shaman | Haste / {T}: Create a token that's a copy of target nonlegendary creature you control, except it has haste. Sacrifice it at the beginning of the next end step.";
  const kikiQ =
    'I control Kiki-Jiki, Mirror Breaker, a Doubling Season, and a nonlegendary Llanowar Elves. I tap Kiki-Jiki targeting the Llanowar Elves, and because of Doubling Season I end up with two hasty token copies instead of one. At the beginning of the next end step, what happens to those tokens?';
  // The eval appends reference card text to the question; the client sends the
  // same words as oracle text on a table card. Both shapes are checked, because
  // the cue is read off the question and the table together.
  const delayedExcerpt = buildExcerpt(corpus, {
    question: `${kikiQ}\n\nCard text for reference:\n- ${kikiOracle}`,
  });
  note('delayed-trigger excerpt', `${delayedExcerpt.text.length} chars, ${delayedExcerpt.ruleIds.length} rules`);
  check(
    'a delayed-trigger question carries 603.7 and its subrules',
    delayedExcerpt.ruleIds.includes('603.7') && delayedExcerpt.ruleIds.includes('603.7a'),
    delayedExcerpt.ruleIds.filter((id) => id.startsWith('603.7')).join(', ') || 'no 603.7 family',
  );
  // The table path, and its two controls. A cue may read a table card's oracle
  // text only when the question names that card, so all three cases below use a
  // question that carries no cue phrase of its own and differ only in the table:
  // the cue firing or not is then the single thing under test.
  const kikiCard = {
    name: 'Kiki-Jiki, Mirror Breaker',
    zone: 'battlefield' as const,
    typeLine: 'Legendary Creature — Goblin Shaman',
    oracleText: kikiOracle.split(' | ').slice(2).join(' '),
  };
  const namedQ =
    'I copy Llanowar Elves with Kiki-Jiki, Mirror Breaker. What happens to the copy later in the turn?';
  const namedWithCard = buildExcerpt(corpus, {
    question: namedQ,
    table: { ...FIXTURE, cards: [kikiCard], stack: [], activeEvent: undefined },
  });
  check(
    'the cue is read off the oracle text of a card the question names',
    namedWithCard.ruleIds.includes('603.7') && namedWithCard.ruleIds.includes('603.7a'),
    namedWithCard.ruleIds.filter((id) => id.startsWith('603.7')).join(', ') || 'no 603.7 family',
  );
  // Same words, no table. If this one carried 603.7 as well, the check above
  // would be testing the question text rather than the table path.
  const namedNoTable = buildExcerpt(corpus, {
    question: namedQ,
    table: { ...FIXTURE, cards: [], stack: [], activeEvent: undefined },
  });
  check(
    'the same question with no table does not reach 603.7 on its own',
    !namedNoTable.ruleIds.some((id) => id.startsWith('603.7')),
    namedNoTable.ruleIds.filter((id) => id.startsWith('603.7')).join(', ') || 'no 603.7 family',
  );
  // The control that costs real budget. Kiki-Jiki is on the battlefield and its
  // text carries the cue, but the question is about trample and never names the
  // card, so the excerpt must not spend several kilobytes on delayed triggers.
  const trampleQ = 'How does trample assign combat damage to a blocking creature?';
  const trampleWithKiki = buildExcerpt(corpus, {
    question: trampleQ,
    table: { ...FIXTURE, cards: [kikiCard], stack: [], activeEvent: undefined },
  });
  check(
    'a card on the battlefield the question never names does not fire the cue',
    !trampleWithKiki.ruleIds.some((id) => id.startsWith('603.7')),
    trampleWithKiki.ruleIds.filter((id) => id.startsWith('603.7')).join(', ') || 'no 603.7 family',
  );
  check(
    'a question with no delayed-trigger cue does not pull 603.7 in',
    !buildExcerpt(corpus, { question: trampleQ }).ruleIds.some((id) => id.startsWith('603.7')),
  );

  // A cue is a floor and must never be a promotion past the top hit: selection
  // measures its cut against the best score, so a cue that outranked the real
  // best would raise the cut for everything else and evict the rules the question
  // is literally about. Asked as the eval asks it, cr:603.7c is the case that
  // caught it: 603.7 is named outright so both spellings below select the same
  // family, and the only thing that can differ is what the cue did to the cut.
  const crStatement = (corpus.rules.get('603.7c')?.examples[0] ?? '')
    .replace(/^Example:\s*/, '')
    .trim();
  const crQ = `Under rule 603.7c: ${crStatement} Is that right? Confirm it or correct it.`;
  // The cue phrases broken with a double space. The tokenizer collapses runs of
  // non-alphanumerics, so the BM25 stream is byte-for-byte the same query and the
  // cue is the only variable.
  const crNoCue = crQ.replace(/\bthe next end step\b/gi, 'the  next  end step');
  const cued = buildExcerpt(corpus, { question: crQ });
  const uncued = buildExcerpt(corpus, { question: crNoCue });
  note(
    'cr:603.7c excerpt',
    `cue on ${cued.ruleIds.length} rules / ${cued.text.length} chars, cue off ${uncued.ruleIds.length} / ${uncued.text.length}`,
  );
  check(
    'a cue does not shrink the excerpt it fires on',
    cued.ruleIds.length >= uncued.ruleIds.length,
    `${cued.ruleIds.length} vs ${uncued.ruleIds.length} rules`,
  );
  check(
    'the neighbourhood a raised cut used to evict is still there',
    cued.ruleIds.includes('603.6a'),
    cued.ruleIds.filter((id) => id.startsWith('603.6')).join(', ') || 'no 603.6 family',
  );
  // Same selection either way is the strongest form of "the cue did not move the
  // cut": it means the top-ranked rule, and so the floor read off it, is unchanged.
  check(
    'the cue leaves the rest of the selection untouched',
    cued.ruleIds.join(',') === uncued.ruleIds.join(','),
    uncued.ruleIds.filter((id) => !cued.ruleIds.includes(id)).join(', ') || 'identical',
  );

  const sizes: [string, number][] = [
    ['commander', commanderExcerpt.text.length],
    ['explicit-id', explicitExcerpt.text.length],
    ['rhystic', rhysticExcerpt.text.length],
    ['hexproof', hexproofExcerpt.text.length],
    ['delayed-trigger', delayedExcerpt.text.length],
  ];
  note('excerpt sizes', sizes.map(([label, chars]) => `${label} ${chars}`).join(', ') + ' chars');
  check(
    'every excerpt stays inside the budget',
    sizes.every(([, chars]) => chars <= 48_000),
    `largest ${Math.max(...sizes.map(([, chars]) => chars))} chars`,
  );

  const paren = buildExcerpt(corpus, { question: 'What does rule 704.5(g) do to a player at 0 life?' });
  check('reads a parenthesised id', paren.ruleIds.includes('704.5g'));

  // Held-out examples must not come back through retrieval. The rules are named
  // by id so both excerpts are forced to contain them; only the examples differ.
  const heldQuestion = `What do rules ${heldOut.map((rule) => rule.id).join(', ')} mean?`;
  const fullExample = buildExcerpt(corpus, { question: heldQuestion });
  const trimmedExample = buildExcerpt(trimmed, { question: heldQuestion });
  check(
    'held-out rules are still selected',
    heldOut.every((rule) => trimmedExample.ruleIds.includes(rule.id)),
    heldOut.map((rule) => rule.id).join(', '),
  );
  check(
    'held-out examples never reach the excerpt',
    heldLines.every((line) => fullExample.text.includes(line) && !trimmedExample.text.includes(line)),
    `${heldLines.length} lines`,
  );

  console.log('second pass');
  const secondQ = 'How does trample assign combat damage to a blocking creature?';
  const secondExcerpt = buildExcerpt(corpus, { question: secondQ });
  check('the missing rule really is absent', !secondExcerpt.ruleIds.includes('903.11'));
  const twoPass = stubModel([
    {
      status: 'decline',
      answer: 'The excerpt does not carry rule 903.11, which would settle this.',
      rules: [],
      confidence: 'low',
      caveats: [],
    },
    {
      status: 'answer',
      answer: 'No. Cards from outside the game cannot be brought in.',
      rules: ['903.11'],
      confidence: 'high',
      caveats: [],
    },
  ]);
  const widened = await askJudge({ question: secondQ }, { model: twoPass, corpus });
  check('exactly two model calls', twoPass.calls.length === 2, `${twoPass.calls.length} calls`);
  check(
    'second call carries the fetched rule',
    (twoPass.calls[1]?.system[1].text ?? '').includes('ADDITIONAL RULES') &&
      (twoPass.calls[1]?.system[1].text ?? '').includes('903.11.'),
  );
  check('second pass answers', widened.status === 'answer');
  check(
    'second pass leaves its caveat',
    widened.caveats.includes('Second pass: fetched 903.11.'),
    widened.caveats.join(' / '),
  );
  check(
    'fetched rule verifies',
    widened.rules.some((rule) => rule.id === '903.11' && rule.verified),
  );
  check('usage covers both calls', widened.usage?.inputTokens === 24, `${widened.usage?.inputTokens} tokens`);

  // A top-level id fetches its whole subrule family: 903.4 alone is the sentence
  // that introduces the rule, and the subrules under it are the rule.
  const topLevel = stubModel([
    {
      status: 'decline',
      answer: 'Rule 903.4 would settle this, but the excerpt does not carry it.',
      rules: [],
      confidence: 'low',
      caveats: [],
    },
    reply(['903.4a']),
  ]);
  await askJudge({ question: secondQ }, { model: topLevel, corpus });
  const widenedBlock = topLevel.calls[1]?.system[1].text ?? '';
  check(
    'a top-level id brings its subrules',
    widenedBlock.includes('\n903.4.') && widenedBlock.includes('\n903.4a'),
  );

  // The topic form of a decline. The judge named no id, so retrieval runs again
  // on the decline's own words and the combat damage rules arrive.
  const topicPass = stubModel([
    {
      status: 'decline',
      answer: 'The excerpt does not carry the rules on assigning combat damage to blockers.',
      rules: [],
      confidence: 'low',
      caveats: [],
    },
    reply(['510.1a']),
  ]);
  // Asked on the commander question, whose excerpt has no reason to carry the
  // combat damage rules, so what arrives on the second call arrived because the
  // decline asked for it.
  const topical = await askJudge({ question: commanderQ }, { model: topicPass, corpus });
  check('a topic-form decline runs a second pass', topicPass.calls.length === 2, `${topicPass.calls.length} calls`);
  const topicBlock = topicPass.calls[1]?.system[1].text ?? '';
  const fetched = [...topicBlock.matchAll(/^(510\.\d+[a-z]?)[.\s]/gm)].map((m) => m[1]);
  check(
    'the second call carries a combat damage rule',
    topicBlock.includes('ADDITIONAL RULES') && fetched.length > 0,
    fetched.slice(0, 6).join(', ') || 'no 510 rule',
  );
  check(
    'topic pass leaves its caveat',
    topical.caveats.includes('Second pass: fetched more rules on the topic named in the decline.'),
    topical.caveats.join(' / '),
  );

  // A named top-level id is a request for the subrules under it, not for the
  // sentence that introduces them: `fetchFamily` already reads it that way. An
  // excerpt that dragged 603.7 in as some subrule's parent used to count as
  // carrying it, so a decline asking for "603.7 and its subrules" found nothing
  // missing and fell through to the weaker topic pass.
  const namesTheParent = ['Rule 603.7 and its subrules would settle this.'];
  const stillMissing = missingRuleIds(corpus, { text: '', ruleIds: ['603.7', '603.7c'] }, namesTheParent);
  check(
    'a named top-level id is missing while its subrules are absent',
    stillMissing.includes('603.7'),
    stillMissing.join(', ') || 'none',
  );
  const wholeFamily = {
    text: '',
    ruleIds: ['603.7', ...[...corpus.rules.keys()].filter((id) => /^603\.7[a-z]{1,2}$/.test(id))],
  };
  check(
    'and is not missing once the whole family is there',
    missingRuleIds(corpus, wholeFamily, ['Rule 603.7 would settle this.']).length === 0,
  );
  check(
    'a named subrule that is present is still not missing',
    missingRuleIds(corpus, { text: '', ruleIds: ['603.7c'] }, ['Rule 603.7c settles it.']).length === 0,
  );

  const onePass = stubModel({ status: 'decline', answer: '?', rules: [], confidence: 'low', caveats: [] });
  await askJudge({ question: commanderQ }, { model: onePass, corpus });
  check('a decline whose words find nothing new stays one call', onePass.calls.length === 1);
  const fullDecline = stubModel({
    status: 'decline',
    answer: 'Rule 903.11 would settle this.',
    rules: [],
    confidence: 'low',
    caveats: [],
  });
  await askJudge({ question: secondQ }, { model: fullDecline, corpus, grounding: 'full' });
  check('full grounding never runs a second pass', fullDecline.calls.length === 1);
}

async function live() {
  console.log('live');
  if (!(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN)) {
    console.error('No ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN set; --live needs credentials.');
    process.exit(1);
  }
  const corpus = loadCorpus();
  const model = createApiModel();

  const first = await askJudge(
    { question: 'Can a commander that is put into the graveyard be moved to the command zone instead?' },
    { model, corpus, grounding: 'full' },
  );
  console.log(`  status     ${first.status} (${first.confidence})`);
  console.log(`  answer     ${first.answer}`);
  console.log(`  rules      ${first.rules.map((r) => `${r.id}${r.verified ? '' : ' [unverified]'}`).join(', ')}`);
  console.log(`  usage      ${JSON.stringify(first.usage)}`);

  const second = await askJudge(
    { question: 'How much does the commander tax add on the third cast from the command zone?' },
    { model, corpus, grounding: 'full' },
  );
  console.log(`  answer 2   ${second.answer}`);
  console.log(`  usage 2    ${JSON.stringify(second.usage)}`);
  check('second call reads the cache', (second.usage?.cacheRead ?? 0) > 0, `${second.usage?.cacheRead ?? 0} tokens`);

  const retrieved = await askJudge(
    { question: 'If my commander dies, can I put it back in the command zone?' },
    { model, corpus, grounding: 'retrieval' },
  );
  console.log(`  retrieval  ${retrieved.status}: ${retrieved.answer}`);
  console.log(`  usage 3    ${JSON.stringify(retrieved.usage)}`);
  check(
    'retrieval reads far less than the corpus',
    (retrieved.usage?.inputTokens ?? 0) + (retrieved.usage?.cacheRead ?? 0) < 60_000,
    `${(retrieved.usage?.inputTokens ?? 0) + (retrieved.usage?.cacheRead ?? 0)} tokens`,
  );
}

async function main() {
  await offline();
  if (process.argv.includes('--live')) {
    try {
      await live();
    } catch (err) {
      console.error(`  live check failed: ${(err as Error).message}`);
      failures.push('live');
    }
  }

  console.log('');
  if (failures.length > 0) {
    console.log(`verify:judge FAILED ${failures.length} of ${checks}: ${failures.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log(`verify:judge passed ${checks} checks.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
