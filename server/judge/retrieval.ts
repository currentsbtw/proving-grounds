/**
 * Retrieval grounding for the advisory judge: choose the slice of the
 * Comprehensive Rules a question actually needs, so one answer reads roughly
 * twelve thousand tokens of rules instead of a quarter of a million.
 *
 * Why this exists: the full corpus is about a megabyte. Sending it every time is
 * correct but expensive on any driver, and only the api driver can cache it. An
 * excerpt costs about fifteen times less and works the same on a driver with no
 * cache control at all. The cost is that the excerpt can be wrong, so the policy
 * prompt tells the judge to decline when the rule it needs is not present, and
 * `askJudge` runs one widening pass when that happens.
 *
 * Pure and offline: no network, no filesystem, no process state. The index is
 * derived from a `Corpus` and memoised against that object, so the second
 * question on a running proxy pays only for scoring.
 *
 * Everything here is deterministic. The same corpus and the same request produce
 * the same bytes, which is what makes the eval harness reproducible and makes a
 * bad excerpt debuggable after the fact.
 */
import type { JudgeRequest } from '../../src/domain/judge.ts';
import {
  type Corpus,
  type CorpusRule,
  isTopLevelRuleId,
  resolveRule,
  ruleMentionScanner,
  ruleParentId,
} from './corpus.ts';

export interface Excerpt {
  /** The block handed to the model as system block 2. */
  text: string;
  /** Rule ids present in `text`, in Comprehensive Rules order. */
  ruleIds: string[];
}

export interface ExcerptOptions {
  /**
   * Ceiling on the rendered excerpt, not a target: selection stops at the score
   * floor long before this on most questions. 48,000 characters is about 12k
   * tokens of rules text, which leaves room for the policy prompt, the table
   * snapshot and an 8k answer inside a comfortable request. `askJudge` passes a
   * much smaller one for the second pass, where the excerpt is a top-up.
   */
  budgetChars?: number;
}

const DEFAULT_BUDGET_CHARS = 48_000;
/** Held back for the header line and its list of ids, which is written last. */
const HEADER_RESERVE_CHARS = 2_000;
/** Glossary entries are short and high precision, but they must not crowd out rules. */
const GLOSSARY_BUDGET_CHARS = 6_000;
const GLOSSARY_MAX_ENTRIES = 12;

const K1 = 1.2;
const B = 0.75;
/** A token from the question counts three times a token from the table snapshot. */
const QUESTION_WEIGHT = 3;
const CONTEXT_WEIGHT = 1;

/** Commander is rule 903, and this is a Commander trainer, so 903 gets a thumb on the scale. */
const COMMANDER_SECTION = '903';
const COMMANDER_MULTIPLIER = 1.6;
/** A floor, not a free pass: an unmatched 903 rule is a candidate only if budget is left over. */
const COMMANDER_FLOOR = 1;

/**
 * Cues that name a mechanic whose settling rule the words of the question do not
 * contain. BM25 can only rank text that shares tokens with the query, so a
 * question about a card that says "sacrifice it at the beginning of the next end
 * step" ranks the rules that repeat those words and never reaches 603.7, which
 * calls the thing a "delayed triggered ability" and says "end step" nowhere near
 * the top. That is what let a live eval item about two Kiki-Jiki tokens decline:
 * the judge named 603.7 itself, and it was not in front of it.
 *
 * Deliberately tiny, and it stays that way. This is not a synonym system: an
 * entry earns its place only when the vocabulary gap is structural, the target
 * rule is the one that settles the whole class of question, and the cue cannot
 * plausibly fire on questions the rule has nothing to do with. Everything else
 * BM25 already handles, and every entry here spends budget on every matching
 * question whether it helped or not.
 */
const CUE_BOOSTS: { cues: RegExp; rule: string }[] = [
  // Delayed triggered abilities. Cards write them as a second sentence naming a
  // later moment ("Sacrifice it at the beginning of the next end step"), so the
  // cues are the card's words and the target is the rule that governs them. The
  // "next" in every phrase is what keeps an ordinary end-step trigger out.
  {
    cues: /\bdelayed\b|\bnext end step\b|\bat the beginning of the next\b|\bsacrifice (?:it|them|that \w+) at\b/i,
    rule: '603.7',
  },
];
/**
 * A cue lifts its family to this share of the best hit and does nothing else.
 *
 * Unlike `COMMANDER_FLOOR`, the floor is a share rather than an absolute,
 * because that is what "reliably present" costs: selection stops at
 * `RELATIVE_SCORE_FLOOR` of the top score, so an absolute floor of 1 leaves a
 * cued rule below the cut on any question that scores in the tens.
 *
 * It is a floor and never a multiplier, because the cut is measured against the
 * top score: `buildExcerpt` reads its floor off `ranked[0].score`, so a cue that
 * could push its family past the true best hit would raise the cut for every
 * other rule from 0.4 of that best to 0.64 of it and quietly evict the rules the
 * question was literally about. Measured on the 603.7c eval item, a 1.6x
 * multiplier cost 22 rules and 10,183 characters of excerpt, 603.6a-603.6e among
 * them. Above the relative floor and below the top, always.
 *
 * The share is high because a floor sets rank as well as survival, and on a
 * question that saturates the character budget rank is what decides. At 0.5 the
 * cued family sorted into the tail and the Kiki-Jiki item -- the item the cue was
 * written for -- reached the ceiling with only 603.7 and 603.7b, both of them
 * ordinary BM25 hits. 0.7 through 0.95 all bring the whole 603.7 family and leave
 * the 603.7c excerpt untouched, so the value sits in the middle of that band,
 * near the top hit and never level with it.
 */
const CUE_FLOOR_SHARE = 0.8;

/**
 * Cap on how many ids one decline may fetch on the second pass. It counts
 * fetches, not rules: asking for `704.5` brings its whole subrule family and
 * still spends one of the eight.
 */
export const MAX_SECOND_PASS_RULES = 8;

/**
 * Stop taking BM25 candidates once they score below this share of the best hit,
 * so the budget is a ceiling rather than a target: without it every question
 * filled 48,000 characters, most of it rules that matched one common word.
 *
 * The number is measured, not chosen. Each candidate above the floor brings its
 * whole family, so the excerpt grows several times faster than the candidate
 * count, and a gentle floor changes nothing: on "if my commander dies, can I put
 * it back in the command zone?" a 0.15 floor left 229 candidates and a 47,598
 * character excerpt, 0.3 left 38,183, and 0.4 lands it at 18,706 with 903.9 and
 * 903.9a still in. Broad questions still reach the ceiling, which is correct;
 * they are broad.
 */
const RELATIVE_SCORE_FLOOR = 0.4;

/** "rule 903", "rules 704". Pulls in that section's top-level rules. */
const SECTION_MENTION_PATTERN = /\brules?\s+(\d{3})\b/gi;

/**
 * Deliberately small. BM25 already flattens common words to near-zero weight,
 * so this list is here to keep the postings tidy rather than to do the ranking.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'do', 'does',
  'for', 'from', 'had', 'has', 'have', 'he', 'her', 'him', 'his', 'how', 'i', 'if', 'in', 'into',
  'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'she', 'so', 'than', 'that',
  'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'us', 'was', 'we',
  'were', 'what', 'when', 'which', 'who', 'will', 'with', 'would', 'you', 'your',
]);

/**
 * Enough stemming to make "casts", "casting" and "cast" the same token, and no
 * more. A real stemmer is a dependency, and this text is one document written in
 * one register, so the cheap rules cover it. The "ies" case earns its line on
 * its own: "abilities" against "ability" is the single most common miss.
 */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * Lowercase, strip everything that is not a letter or a digit, drop stopwords,
 * stem. Curly quotes and mana braces fall out as separators, so `{T}` and
 * `player’s` tokenise the way a question about them does.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    const token = stem(raw);
    if (token.length >= 2) out.push(token);
  }
  return out;
}

interface IndexedRule {
  rule: CorpusRule;
  /** Position in the printed Comprehensive Rules; the output is sorted by this. */
  order: number;
  /** The rule's line plus its examples, exactly as the excerpt prints them. */
  body: string;
  chars: number;
  length: number;
  section: string;
  /** `903.9` for `903.9a`; null for a top-level rule. */
  parent: string | null;
}

interface GlossaryEntry {
  term: string;
  definition: string;
  tokens: string[];
  chars: number;
}

interface CorpusIndex {
  rules: IndexedRule[];
  byId: Map<string, IndexedRule>;
  /** token -> postings, each the rule's array position and its term frequency. */
  postings: Map<string, { at: number; tf: number }[]>;
  avgLength: number;
  /** Numeric rule id -> its lettered subrule ids, in printed order. */
  children: Map<string, string[]>;
  /** Section number -> its top-level rule ids, in printed order. */
  topLevel: Map<string, string[]>;
  glossary: GlossaryEntry[];
}

const INDEX_CACHE = new WeakMap<Corpus, CorpusIndex>();

/**
 * The excerpt must show a rule the same way the full corpus does, held-out
 * examples included: `excludeExampleRules` cuts examples from `corpus.text`, and
 * an index that read `rule.examples` blindly would put them back, leaking the
 * eval's answers into the very prompt being evaluated.
 */
function renderRule(corpus: Corpus, rule: CorpusRule): string {
  if (corpus.excludedExampleRules.has(rule.id) || rule.examples.length === 0) return rule.text;
  return [rule.text, ...rule.examples].join('\n');
}

function buildIndex(corpus: Corpus): CorpusIndex {
  const rules: IndexedRule[] = [];
  const byId = new Map<string, IndexedRule>();
  const postings = new Map<string, { at: number; tf: number }[]>();
  const children = new Map<string, string[]>();
  const topLevel = new Map<string, string[]>();
  let totalLength = 0;

  let order = 0;
  for (const rule of corpus.rules.values()) {
    const body = renderRule(corpus, rule);
    const section = rule.id.slice(0, 3);
    const parent = ruleParentId(rule.id);

    const tf = new Map<string, number>();
    for (const token of tokenize(body)) tf.set(token, (tf.get(token) ?? 0) + 1);
    const length = [...tf.values()].reduce((n, count) => n + count, 0);

    const at = rules.length;
    const indexed: IndexedRule = {
      rule,
      order: order++,
      body,
      chars: body.length + 1,
      length,
      section,
      parent,
    };
    rules.push(indexed);
    byId.set(rule.id, indexed);
    totalLength += length;

    for (const [token, count] of tf) {
      const list = postings.get(token);
      if (list) list.push({ at, tf: count });
      else postings.set(token, [{ at, tf: count }]);
    }

    if (parent) {
      const list = children.get(parent);
      if (list) list.push(rule.id);
      else children.set(parent, [rule.id]);
    } else if (isTopLevelRuleId(rule.id)) {
      const list = topLevel.get(section);
      if (list) list.push(rule.id);
      else topLevel.set(section, [rule.id]);
    }
  }

  const glossary: GlossaryEntry[] = [];
  for (const [term, definition] of corpus.glossary) {
    const tokens = tokenize(term);
    if (tokens.length === 0) continue;
    glossary.push({ term, definition, tokens, chars: term.length + definition.length + 2 });
  }

  return {
    rules,
    byId,
    postings,
    avgLength: rules.length > 0 ? totalLength / rules.length : 1,
    children,
    topLevel,
    glossary,
  };
}

function getIndex(corpus: Corpus): CorpusIndex {
  const cached = INDEX_CACHE.get(corpus);
  if (cached) return cached;
  const built = buildIndex(corpus);
  INDEX_CACHE.set(corpus, built);
  return built;
}

interface Query {
  /** token -> weight, 3 if the token is anywhere in the question, else 1. */
  terms: Map<string, number>;
  question: string;
  /** True when the question says "commander" or the table shows one. */
  commander: boolean;
  /** Rule ids whose family a cue asked for; see `CUE_BOOSTS`. */
  cueRules: string[];
}

/**
 * The question plus everything on the table that is made of rules text: card
 * names, type lines, oracle text, the stack tray, the active event, and the hate
 * pieces standing on the seats. The rest of a seat line is life totals and
 * threat meters, which no rule is about, so those are skipped rather than
 * diluting the scores.
 */
function buildQuery(req: JudgeRequest): Query {
  const question = req.question ?? '';
  const terms = new Map<string, number>();
  for (const token of tokenize(question)) terms.set(token, QUESTION_WEIGHT);

  const context: string[] = [];
  // What a cue is allowed to read, kept apart from the scoring context on
  // purpose; see `cueText` below for why it is a subset of it.
  const cueParts: string[] = [question];
  const asked = question.toLowerCase();
  let commander = /\bcommanders?\b/i.test(question);
  const table = req.table;
  if (table) {
    for (const card of table.cards) {
      if (card.isCommander) commander = true;
      context.push(card.name);
      if (card.typeLine) context.push(card.typeLine);
      if (card.oracleText) {
        context.push(card.oracleText);
        if (card.name && asked.includes(card.name.toLowerCase())) cueParts.push(card.oracleText);
      }
    }
    for (const item of table.stack ?? []) {
      context.push(item.label);
      cueParts.push(item.label);
      if (item.typeLine) context.push(item.typeLine);
      if (item.oracleText) {
        context.push(item.oracleText);
        cueParts.push(item.oracleText);
      }
    }
    if (table.activeEvent) {
      context.push(table.activeEvent.prompt);
      cueParts.push(table.activeEvent.prompt);
      if (table.activeEvent.card) {
        context.push(table.activeEvent.card.name, table.activeEvent.card.effect);
        cueParts.push(table.activeEvent.card.effect);
      }
    }
    for (const seat of table.seats) {
      for (const piece of seat.hate ?? []) {
        context.push(piece.name, piece.effect);
        if (asked.includes(piece.name.toLowerCase())) cueParts.push(piece.effect);
      }
    }
  }
  for (const token of tokenize(context.join(' '))) {
    if (!terms.has(token)) terms.set(token, CONTEXT_WEIGHT);
  }

  // Cues are read off the raw text, not the token stream: they are phrases. What
  // counts as that text is narrower than the scoring context, because a cue is a
  // claim about what the question is about and the battlefield is not. A card
  // that says "sacrifice it at the beginning of the next end step" sitting in
  // some zone, or in a graveyard, would otherwise spend 7.5 KB of every
  // unrelated question's budget on 603.7 -- measured on a trample question with
  // Kiki-Jiki on the table, which lost 701.14a-c to pay for it.
  //
  // So: the question itself; the oracle text of a table card the question names,
  // because the card that says the words is usually on the battlefield rather
  // than in the question, and naming it is how the player says which one; and
  // the stack tray and the active event, which are what is happening right now
  // whether the question spells them out or not. The eval sends the card's words
  // appended to the question, so both request shapes reach the same rules. A
  // hate piece standing on a seat is read the same way a battlefield card is,
  // and for the same reason: it is a permanent sitting there, not what is
  // happening right now, so its effect is a cue only once the question names it.
  const cueText = cueParts.join(' ');
  const cueRules = CUE_BOOSTS.filter((boost) => boost.cues.test(cueText)).map((boost) => boost.rule);

  return { terms, question, commander, cueRules };
}

function scoreRules(index: CorpusIndex, query: Query): Float64Array {
  const scores = new Float64Array(index.rules.length);
  const n = index.rules.length;
  for (const [token, weight] of query.terms) {
    const list = index.postings.get(token);
    if (!list) continue;
    const df = list.length;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    for (const { at, tf } of list) {
      const norm = tf + K1 * (1 - B + (B * index.rules[at].length) / index.avgLength);
      scores[at] += weight * idf * ((tf * (K1 + 1)) / norm);
    }
  }
  if (query.commander) {
    for (let i = 0; i < n; i++) {
      if (index.rules[i].section !== COMMANDER_SECTION) continue;
      scores[i] = scores[i] * COMMANDER_MULTIPLIER + COMMANDER_FLOOR;
    }
  }
  if (query.cueRules.length > 0) {
    const cued = new Set<string>();
    for (const id of query.cueRules) for (const member of fetchFamily(index, id)) cued.add(member);
    // The floor is read after the Commander boost so it is a share of the score
    // that selection will actually measure the cut against. Raising a cued rule
    // to the floor can never move `best`, which is what keeps the cue from
    // tightening the cut on everything else.
    let best = 0;
    for (let i = 0; i < n; i++) if (scores[i] > best) best = scores[i];
    const floor = best * CUE_FLOOR_SHARE;
    for (let i = 0; i < n; i++) {
      if (!cued.has(index.rules[i].rule.id)) continue;
      scores[i] = Math.max(scores[i], floor);
    }
  }
  return scores;
}

/** The rule, its parent, and every subrule sharing that parent, in printed order. */
function familyOf(index: CorpusIndex, id: string): { core: string[]; siblings: string[] } {
  const entry = index.byId.get(id);
  if (!entry) return { core: [], siblings: [] };
  const core = entry.parent && index.byId.has(entry.parent) ? [entry.parent, id] : [id];
  // Siblings are defined for subrules only. A top-level rule's "siblings" would
  // be the whole section, which is a section request, not a neighbourhood.
  const siblings = entry.parent
    ? (index.children.get(entry.parent) ?? []).filter((sib) => sib !== id)
    : [];
  return { core, siblings };
}

/**
 * Everything one fetched id is worth bringing with it, in printed order.
 *
 * The two shapes are not symmetric. A subrule is a sentence out of a paragraph,
 * so it arrives with the parent that introduces it and the siblings it is read
 * against. A top-level rule is that introducing sentence, and on its own it is
 * usually the least useful line in its family: a judge that asked for 704.5
 * wants the state-based actions, not the sentence saying there are some. So a
 * top-level id brings its whole subrule family instead.
 */
function fetchFamily(index: CorpusIndex, id: string): string[] {
  const entry = index.byId.get(id);
  if (!entry) return [];
  if (entry.parent) {
    const { core, siblings } = familyOf(index, id);
    return [...core, ...siblings];
  }
  return [id, ...(index.children.get(id) ?? [])];
}

/**
 * Glossary terms whose every word appears in the query. Ranked by how rare those
 * words are across the rules, so "Hexproof" outranks "Ability" when a question
 * happens to contain both.
 */
function selectGlossary(index: CorpusIndex, query: Query): GlossaryEntry[] {
  const n = index.rules.length;
  const rarity = (token: string) => {
    const df = index.postings.get(token)?.length ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  };

  const hits: { entry: GlossaryEntry; weight: number }[] = [];
  for (const entry of index.glossary) {
    if (!entry.tokens.every((token) => query.terms.has(token))) continue;
    hits.push({ entry, weight: entry.tokens.reduce((sum, token) => sum + rarity(token), 0) });
  }
  hits.sort((a, b) => b.weight - a.weight || a.entry.term.localeCompare(b.entry.term));

  const picked: GlossaryEntry[] = [];
  let used = 0;
  for (const { entry } of hits) {
    if (picked.length >= GLOSSARY_MAX_ENTRIES) break;
    if (used + entry.chars > GLOSSARY_BUDGET_CHARS) continue;
    picked.push(entry);
    used += entry.chars;
  }
  picked.sort((a, b) => a.term.localeCompare(b.term));
  return picked;
}

function renderExcerpt(
  corpus: Corpus,
  index: CorpusIndex,
  ruleIds: string[],
  glossary: GlossaryEntry[],
): string {
  const lines = [
    `RULES EXCERPT (Comprehensive Rules effective ${corpus.effectiveDate}; contains rules: ${ruleIds.join(', ')})`,
  ];
  for (const id of ruleIds) {
    const entry = index.byId.get(id);
    if (entry) lines.push(entry.body);
  }
  if (glossary.length > 0) {
    lines.push('', 'GLOSSARY');
    for (const entry of glossary) lines.push(entry.term, entry.definition);
  }
  return lines.join('\n');
}

/**
 * Pick the rules this question needs and render them as one block.
 *
 * Selection runs in three passes. Anything the question named outright (a rule
 * id, a section number) goes in first, because an explicit ask beats a score.
 * Then BM25 hits are taken in rank order, each with its parent and, when the
 * whole neighbourhood fits, its siblings: a subrule read without the sentence
 * that introduces it is how a judge misreads it. Scoring is where the two thumbs
 * on the scale live, the Commander section and `CUE_BOOSTS`, so a promoted rule
 * still arrives as a ranked hit with its family rather than as a special case.
 * Whatever is chosen is printed
 * back in Comprehensive Rules order, never in score order, so the model reads
 * the document rather than a ranking.
 */
export function buildExcerpt(corpus: Corpus, req: JudgeRequest, opts: ExcerptOptions = {}): Excerpt {
  const index = getIndex(corpus);
  const query = buildQuery(req);
  const glossary = selectGlossary(index, query);
  const glossaryChars = glossary.reduce((n, entry) => n + entry.chars, 0);
  const budget = Math.max(
    0,
    (opts.budgetChars ?? DEFAULT_BUDGET_CHARS) - HEADER_RESERVE_CHARS - glossaryChars,
  );

  const chosen = new Set<string>();
  let used = 0;
  const take = (ids: string[], force: boolean): boolean => {
    const fresh = ids.filter((id) => !chosen.has(id) && index.byId.has(id));
    const cost = fresh.reduce((n, id) => n + (index.byId.get(id)?.chars ?? 0), 0);
    if (!force && used + cost > budget) return false;
    for (const id of fresh) chosen.add(id);
    used += cost;
    return true;
  };

  // Pass 1: what the question named. `force` because a player who typed
  // "704.5aa" is owed 704.5aa even if the budget is tight. Ids are read in every
  // spelling the shared scanner knows and normalised through the corpus, so
  // "704.5(g)" and "rule 704.5g" land on the same rule as "704.5g".
  for (const match of query.question.matchAll(ruleMentionScanner())) {
    const id = resolveRule(corpus, match[0])?.id;
    if (id === undefined || !index.byId.has(id)) continue;
    const { core, siblings } = familyOf(index, id);
    take(core, true);
    take(siblings, false);
  }
  for (const match of query.question.matchAll(SECTION_MENTION_PATTERN)) {
    take(index.topLevel.get(match[1]) ?? [], true);
  }

  // Pass 2: BM25, best first, each hit with its family.
  const scores = scoreRules(index, query);
  const ranked = index.rules
    .map((entry, at) => ({ entry, score: scores[at] }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.order - b.entry.order);

  // The floor, not the budget, is what usually stops this loop. A question about
  // one narrow point should send a short excerpt and leave the rest of the budget
  // unspent; only a genuinely broad question fills it.
  const floor = (ranked[0]?.score ?? 0) * RELATIVE_SCORE_FLOOR;
  for (const { entry, score } of ranked) {
    if (used >= budget || score < floor) break;
    if (chosen.has(entry.rule.id)) continue;
    const { core, siblings } = familyOf(index, entry.rule.id);
    // Try the whole neighbourhood, fall back to the rule and its parent, and
    // otherwise skip: a later, smaller hit may still fit.
    if (!take([...core, ...siblings], false)) take(core, false);
  }

  const ruleIds = [...chosen]
    .map((id) => index.byId.get(id))
    .filter((entry): entry is IndexedRule => entry !== undefined)
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.rule.id);

  return { text: renderExcerpt(corpus, index, ruleIds, glossary), ruleIds };
}

/**
 * Append rules to an excerpt under one header. Appended rather than re-rendered,
 * so the block the model already read stays byte-identical and the addition is
 * visibly an addition.
 */
function appendRules(
  index: CorpusIndex,
  excerpt: Excerpt,
  ids: string[],
  note: string,
): Excerpt {
  const present = new Set(excerpt.ruleIds);
  const added = ids.filter((id) => {
    if (present.has(id) || !index.byId.has(id)) return false;
    present.add(id);
    return true;
  });
  if (added.length === 0) return excerpt;

  added.sort((a, b) => (index.byId.get(a)?.order ?? 0) - (index.byId.get(b)?.order ?? 0));
  const lines = [
    '',
    `ADDITIONAL RULES (${note})`,
    ...added.map((id) => index.byId.get(id)?.body ?? id),
  ];
  return { text: `${excerpt.text}\n${lines.join('\n')}`, ruleIds: [...excerpt.ruleIds, ...added] };
}

/**
 * Widen an excerpt with rules the judge asked for by name after declining. At
 * most `MAX_SECOND_PASS_RULES` ids are honoured; each brings its family, so one
 * top-level id can add a dozen rules and still count as one fetch.
 */
export function expandExcerpt(corpus: Corpus, excerpt: Excerpt, ids: string[]): Excerpt {
  const index = getIndex(corpus);
  const wanted = ids.slice(0, MAX_SECOND_PASS_RULES);
  const family = wanted.flatMap((id) => fetchFamily(index, id));
  return appendRules(index, excerpt, family, `fetched for this question: ${wanted.join(', ')}`);
}

/**
 * Widen an excerpt with a second retrieval pass. Used when a decline names a
 * topic instead of a rule id: the decline's own words become a query, and
 * whatever that finds is appended the same way a named id would be.
 */
export function mergeExcerpt(corpus: Corpus, excerpt: Excerpt, extra: Excerpt, note: string): Excerpt {
  return appendRules(getIndex(corpus), excerpt, extra.ruleIds, note);
}

/**
 * Whether the excerpt already carries what a judge naming this id was asking
 * for. A subrule is one line and the line is the answer. A top-level id is not:
 * `fetchFamily` reads "603.7" as a request for 603.7a and its siblings, because
 * the introducing sentence on its own is the least useful line in the family,
 * and an excerpt that dragged that sentence in as some other subrule's parent
 * must not read as an excerpt that answered the ask.
 */
function familyCarried(index: CorpusIndex, present: Set<string>, id: string): boolean {
  if (!present.has(id)) return false;
  if (!isTopLevelRuleId(id)) return true;
  return fetchFamily(index, id).every((member) => present.has(member));
}

/**
 * Rule ids the judge named in a decline that the corpus knows and the excerpt
 * did not carry. This is the signal that retrieval missed, and the only thing
 * that earns a second model call.
 *
 * Ids are matched in every spelling the shared scanner knows and resolved
 * through the corpus, so a decline written as "704.5(G)" fetches 704.5g rather
 * than being read as naming no rule at all.
 */
export function missingRuleIds(corpus: Corpus, excerpt: Excerpt, texts: string[]): string[] {
  const index = getIndex(corpus);
  const present = new Set(excerpt.ruleIds);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const match of (text ?? '').matchAll(ruleMentionScanner())) {
      const id = resolveRule(corpus, match[0])?.id;
      if (id === undefined || seen.has(id) || familyCarried(index, present, id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= MAX_SECOND_PASS_RULES) return out;
    }
  }
  return out;
}
