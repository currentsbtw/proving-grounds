/**
 * The advisory judge itself: one model call, grounded in the Comprehensive
 * Rules, with every citation checked back against the corpus before it reaches
 * the player.
 *
 * Pure and importable: no network client of its own, no process state, no
 * environment reads. The proxy (`server/judge.ts`) owns the HTTP surface and
 * picks a driver; the eval harness calls `askJudge` with its own driver and a
 * corpus that holds out examples. Importing this file must do nothing.
 *
 * Three shapes matter here. The system prompt is two blocks, policy then rules,
 * so that in `full` grounding the corpus half can be cached for an hour while
 * the question varies; nothing volatile may enter block 1 or every request pays
 * to write the cache again. In `retrieval` grounding block 2 is a per-question
 * excerpt and is not cached, because a block that changes every time would only
 * ever be written and never read. And an answer citing no rule the corpus knows
 * is downgraded to a decline, because an uncheckable citation is exactly the
 * failure this feature exists to avoid.
 */
import { z } from 'zod';

import type {
  JudgeCardContext,
  JudgeGrounding,
  JudgeRequest,
  JudgeResponse,
  JudgeRule,
  JudgeTableContext,
  JudgeUsage,
} from '../../src/domain/judge.ts';
import { type Corpus, resolveRule } from './corpus.ts';
import type { JudgeModel, SystemBlock } from './model.ts';
import {
  buildExcerpt,
  type Excerpt,
  expandExcerpt,
  mergeExcerpt,
  missingRuleIds,
} from './retrieval.ts';

export const MAX_QUESTION_CHARS = 2000;

/**
 * Budget for the second pass when a decline names a topic instead of a rule id.
 * A top-up, not a second excerpt: the first one is still in the prompt.
 */
const TOPIC_PASS_BUDGET_CHARS = 8_000;

/** The question was unusable; the proxy answers 400 rather than calling out. */
export class JudgeBadRequestError extends Error {}

const JudgeOutput = z.object({
  status: z.enum(['answer', 'decline']),
  answer: z.string(),
  rules: z.array(z.string()),
  confidence: z.enum(['high', 'medium', 'low']),
  caveats: z.array(z.string()),
});

/**
 * Frozen. Cached as block 1, so a word changed here costs a cache write on the
 * corpus too. No dates, ids, or run state may appear in it.
 */
const POLICY_PROMPT = `You are the advisory rules judge at a solo Commander practice table. The player pilots a real deck against three abstract seats. You answer rules questions and do nothing else.

Commander is rule 903: four players, 40 starting life, 21 combat damage from a single commander eliminates its victim, a commander costs an extra two generic mana for each previous cast from the command zone, and a commander can be sent to the command zone instead of changing zones.

The Comprehensive Rules follow this block. That text is your only authority. Do not lean on remembered card rulings, policy documents or set releases that are not in it.

What follows is either the complete Comprehensive Rules or an excerpt of them chosen for this question. An excerpt says so on its first line and lists the rule numbers it contains. If the rule that settles the question is not in the text you were given, decline and name the rule number or the topic that would settle it, so it can be fetched for you. Do not answer from memory of rules that are not in front of you.

Answer first, in one or two sentences. Then say why. Under about 120 words unless the question genuinely needs more.

When you are asked to confirm or correct a statement, settle that in the first sentence. If the statement is right as written, or right as a fair simplification of the rules, confirm it plainly and put any refinement or edge case in caveats. Call it a correction only when following the statement as written would produce a wrong outcome at the table, and then say what changes. Sharper wording for wording that already works is not a correction.

Formatting, in the answer and in every caveat: plain sentences and plain punctuation, no em-dashes, no markdown, no headings, no bullets, no numbered lists.

Every answer cites the rule numbers it relies on in the rules field, ids only, such as 903.9a or 704.5g. Prefer the most specific subrule that settles the point over the parent rule that introduces it. An answer with no citation is not an answer.

When the facts you were given do not settle the question, or the rules text does not, set status to decline and say in the answer field exactly which fact or which rule would settle it. A decline is better than a guess. A confidently wrong judge is worse than no judge. Set confidence to high only when a cited rule states the answer outright, medium when it follows from rules you cite, low when you are reading across them.

Put anything the player still has to check themselves in caveats, one short line each.

You advise. You never enforce and never adjudicate. Do not say whether the player's earlier plays were legal unless they ask. Do not move the game along for them; they resolve everything themselves.

Assume the table context is honest and complete for the cards it lists. Card oracle text given in the context is authoritative for those cards. Anything not listed is not on the table.

Voice: terse table-talk for fluent Commander players. Jargon needs no gloss. No cheerleading, no filler, no apologies, no restating the question. Never mention being an AI or a model.`;

/**
 * System blocks in cache order: the frozen policy, then the rules.
 *
 * Block 1 is byte-identical in both grounding modes on purpose. It is the cached
 * prefix, and a prompt that differed by mode would halve the cache hit rate for
 * no gain. Block 2 is where the modes part: the whole corpus, marked for the
 * driver to cache, or a per-question excerpt left uncached because it changes
 * every time. The question and the table always go in the user message.
 */
export function buildSystemBlocks(
  corpus: Corpus,
  grounding: JudgeGrounding,
  excerpt?: string,
): SystemBlock[] {
  return [
    { text: POLICY_PROMPT },
    grounding === 'full' ? { text: corpus.text, cache: true } : { text: excerpt ?? '' },
  ];
}

/**
 * The status words an object carries, in one order, for both renderers. A tray
 * item is a card too: a commander cast to the stack has to read as a commander
 * there, or a question about the tax is answered against a plain spell.
 */
function statusParts(object: {
  isCommander?: boolean;
  isToken?: boolean;
  tapped?: boolean;
  counters?: Record<string, number>;
}): string[] {
  const parts: string[] = [];
  if (object.isCommander) parts.push('commander');
  if (object.isToken) parts.push('token');
  if (object.tapped) parts.push('tapped');
  const counters = Object.entries(object.counters ?? {}).filter(([, n]) => n !== 0);
  if (counters.length > 0) {
    parts.push(counters.map(([kind, n]) => `${n} ${kind} counter${n === 1 ? '' : 's'}`).join(', '));
  }
  return parts;
}

function describeCard(card: JudgeCardContext): string {
  const parts = [card.name];
  if (card.typeLine) parts.push(card.typeLine);
  // After the type line and before the status words, so a card reads the way it
  // is printed: name, type, cost, text. Empty for a land or a token, and an
  // empty field would read as a cost of nothing rather than as no cost at all.
  if (card.manaCost) parts.push(card.manaCost);
  parts.push(...statusParts(card));
  if (card.oracleText) parts.push(card.oracleText.replace(/\n+/g, ' / '));
  return `- ${parts.join(' | ')}`;
}

/**
 * Renders the run snapshot as the compact text block the model reads. Zones the
 * player cannot see the contents of are never sent, and empty sections are left
 * out entirely so the model does not read absence as emptiness it can trust.
 */
export function renderTableContext(table: JudgeTableContext): string {
  const out: string[] = ['TABLE'];
  const head = [`Turn ${table.turn}`, table.phase, `your life ${table.life}`];
  if (table.commanderTax !== undefined) head.push(`commander tax ${table.commanderTax}`);
  out.push(`${head.join(', ')}.`);

  // A cast spell normally arrives as a tray item and appears nowhere in `cards`,
  // so the 'stack' section is usually empty and prints nothing. It is here for
  // the client that sends one anyway: dropping a card the player can see is
  // worse than the duplication the tray was separated to avoid.
  const withOracle: { zone: JudgeCardContext['zone']; label: string }[] = [
    { zone: 'battlefield', label: 'Your battlefield' },
    { zone: 'hand', label: 'Your hand' },
    { zone: 'command', label: 'Command zone' },
    { zone: 'stack', label: 'On the stack' },
  ];
  for (const { zone, label } of withOracle) {
    const cards = table.cards.filter((c) => c.zone === zone);
    if (cards.length === 0) continue;
    out.push(`${label}:`);
    for (const card of cards) out.push(describeCard(card));
  }

  for (const [zone, label] of [
    ['graveyard', 'Your graveyard'],
    ['exile', 'Exiled'],
  ] as const) {
    const names = table.cards.filter((c) => c.zone === zone).map((c) => c.name);
    if (names.length > 0) out.push(`${label}: ${names.join(', ')}`);
  }

  if (table.stack && table.stack.length > 0) {
    out.push('Stack tray, top last:');
    table.stack.forEach((item, i) => {
      // A spell item carries the card's own text and status, since the client
      // sends a cast spell here and nowhere else. Everything else is a labelled
      // object only, and prints as `kind: label`.
      const parts = [item.label];
      if (item.typeLine) parts.push(item.typeLine);
      // Same place as in `describeCard`: name, type, cost, text. An ability or a
      // trigger has no printed cost and prints no field for one.
      if (item.manaCost) parts.push(item.manaCost);
      parts.push(...statusParts(item));
      if (item.oracleText) parts.push(item.oracleText.replace(/\n+/g, ' / '));
      const body = parts.length > 1 ? parts.join(' | ') : `${item.kind}: ${item.label}`;
      out.push(`${i + 1}. ${body}`);
    });
  }

  if (table.activeEvent) {
    const ev = table.activeEvent;
    const bits = [`Seat ${ev.seat} ${ev.type}`, ev.prompt];
    if (ev.card) bits.push(`cited card ${ev.card.name}: ${ev.card.effect}`);
    out.push(`Active event: ${bits.join(' | ')}`);
  }

  for (const seat of table.seats) {
    const sil = seat.silhouette;
    const state = seat.eliminated
      ? 'eliminated'
      : `${seat.life} life, threat ${seat.threat}, ${sil.creatures} creatures for ${sil.power} power, ${sil.artifacts} artifacts, ${sil.openMana} open mana`;
    out.push(`Seat ${seat.id}: ${state}`);
    // A hate piece is a permanent standing on that seat's side of the table, so
    // it prints indented under the seat that owns it rather than in a list of
    // its own: the seat is what makes it a fact about the board. The effect
    // carries a label because it is table-talk and not the card: a piece is not
    // in the player's deck, so the snapshot has no oracle text for it, and the
    // policy prompt tells the judge that card text in the context is what the
    // card says. The label is what keeps a paraphrase from being read as the
    // printed words. A dead seat prints none, and neither does a seat holding
    // nothing: the store retires a seat's pieces as it dies, and this is the
    // floor under that for a client the server cannot check.
    if (seat.eliminated) continue;
    for (const piece of seat.hate ?? []) {
      const parts = [
        piece.name,
        `since turn ${piece.sinceTurn}`,
        `summary, not oracle text: ${piece.effect.replace(/\n+/g, ' / ')}`,
      ];
      // `permanent` is which wipe sweeps the piece clear, not a type line, so it
      // prints as the clause it is rather than in the slot a type would sit in.
      if (piece.permanent) parts.push(`swept by ${piece.permanent} wipes`);
      out.push(`  standing: ${parts.join(' | ')}`);
    }
  }

  return out.join('\n');
}

export interface JudgeDeps {
  model: JudgeModel;
  corpus: Corpus;
  /** Defaults to `retrieval`: the cheap path is the one a player gets by default. */
  grounding?: JudgeGrounding;
  /** Abandon both passes. The proxy aborts on a closed drawer and on its own cap. */
  signal?: AbortSignal;
}

/** Two passes bill the player twice, so the response reports what both cost. */
function addUsage(a: JudgeUsage, b: JudgeUsage): JudgeUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/**
 * Ask the judge one question. Throws `JudgeBadRequestError` for an unusable
 * question and lets the driver's `ModelAuthError` and `ModelUpstreamError`
 * through for the caller to classify.
 *
 * At most two model calls. The second happens only under `retrieval` grounding
 * and only after a decline, in one of two shapes. Either the decline named a
 * rule the corpus has and the excerpt lacked, or it named a topic instead ("the
 * rules on assigning combat damage"), in which case the decline's own words
 * become a query and retrieval runs again on a small budget. Both are retrieval
 * admitting it missed, and either is worth one more call to fix. A decline that
 * names neither is the judge doing its job, and it stands.
 */
export async function askJudge(req: JudgeRequest, deps: JudgeDeps): Promise<JudgeResponse> {
  const question = (req.question ?? '').trim();
  if (question.length === 0) throw new JudgeBadRequestError('Ask a rules question.');
  if (question.length > MAX_QUESTION_CHARS) {
    throw new JudgeBadRequestError(`Question is longer than ${MAX_QUESTION_CHARS} characters.`);
  }

  const grounding = deps.grounding ?? 'retrieval';
  const userText = [
    req.table ? renderTableContext(req.table) : null,
    `QUESTION\n${question}`,
  ]
    .filter((part): part is string => part !== null)
    .join('\n\n');

  const excerpt: Excerpt | null =
    grounding === 'retrieval' ? buildExcerpt(deps.corpus, { ...req, question }) : null;

  const ask = (rules?: string) =>
    deps.model.complete({
      system: buildSystemBlocks(deps.corpus, grounding, rules),
      user: userText,
      schema: JudgeOutput,
      effort: 'high',
      maxTokens: 8000,
      signal: deps.signal,
    });

  const first = await ask(excerpt?.text);
  let parsed = first.parsed;
  let model = first.model;
  let usage = first.usage;
  const extraCaveats: string[] = [];

  if (excerpt && parsed.status === 'decline') {
    const missing = missingRuleIds(deps.corpus, excerpt, [
      parsed.answer,
      ...parsed.rules,
      ...parsed.caveats,
    ]);

    // Named ids first. Failing that, the decline's own words are the query: the
    // policy prompt asks for "the rule number or the topic", and a judge that
    // answered with the topic was being told nothing had been asked for.
    let widened: Excerpt | null = null;
    let note = '';
    if (missing.length > 0) {
      widened = expandExcerpt(deps.corpus, excerpt, missing);
      note = `Second pass: fetched ${missing.join(', ')}.`;
    } else if (parsed.answer.trim().length > 0) {
      // The table is left out of this query on purpose. It already shaped the
      // first excerpt, and on a budget this small it would crowd out the topic
      // the judge actually asked for with card names it has already read.
      const topical = buildExcerpt(
        deps.corpus,
        { question: parsed.answer.trim() },
        { budgetChars: TOPIC_PASS_BUDGET_CHARS },
      );
      const merged = mergeExcerpt(
        deps.corpus,
        excerpt,
        topical,
        'fetched for the topic this decline named',
      );
      if (merged !== excerpt) {
        widened = merged;
        note = 'Second pass: fetched more rules on the topic named in the decline.';
      }
    }

    if (widened) {
      const second = await ask(widened.text);
      parsed = second.parsed;
      model = second.model;
      usage = addUsage(usage, second.usage);
      extraCaveats.push(note);
    }
  }

  const rules: JudgeRule[] = [];
  const seen = new Set<string>();
  for (const cited of parsed.rules) {
    const hit = resolveRule(deps.corpus, cited);
    const id = hit ? hit.id : cited.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    rules.push(hit ? { id: hit.id, text: hit.text, verified: true } : { id, verified: false });
  }

  const caveats = [...parsed.caveats, ...extraCaveats];
  let status = parsed.status;
  if (status === 'answer' && !rules.some((rule) => rule.verified)) {
    status = 'decline';
    caveats.push('No verifiable rule citation.');
  }

  return {
    status,
    answer: parsed.answer,
    rules,
    confidence: parsed.confidence,
    caveats,
    model,
    driver: deps.model.driver,
    grounding,
    corpusDate: deps.corpus.effectiveDate,
    usage,
  };
}
