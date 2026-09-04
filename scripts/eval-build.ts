/**
 * Builds the held-out set the advisory judge is graded against.
 *
 *   npm run eval:build                 all three steps
 *   npm run eval:build -- --refresh    ignore the caches and redo everything
 *   npm run eval:build -- --limit 5    generate only N questions (smoke run)
 *   npm run eval:build -- --dry-run    say what each model step would generate
 *
 * Three steps, deliberately separated so the expensive ones are optional:
 *
 *   1. Network, no model. Scryfall gives us the cards in `eval/cards.txt` and
 *      their Wizards-authored rulings. Those rulings are the expert answers: the
 *      only rulings source we can use is the one Wizards wrote itself.
 *   2. Model. Each ruling is turned into the table question whose correct answer
 *      it is, because a ruling states a conclusion without stating the case.
 *   3. Local, then model. A seeded sample of the Comprehensive Rules' own worked
 *      examples. `scripts/eval-run.ts` strips exactly these rules' examples from the
 *      corpus it hands the judge, so answering them is reasoning, not recall.
 *      Every other sampled example is then rewritten into a FALSE variant, so the
 *      set is half true statements and half wrong ones. Without that half, every
 *      item is a true statement asked as "confirm or correct", and a judge that
 *      agrees with everything scores 100% without reading anything.
 *
 * Step 2 and the false-variant half of step 3 are the only parts that need
 * credentials; without them each prints one line and the run still succeeds, so
 * step 1 and the sampling stay usable offline.
 *
 * Caching: step 1 skips cards already in `eval/rulings.json` -- except one it has
 * to top up: an entry missing either printed field (`manaCost === undefined ||
 * power === undefined`, the two the store gained in turn) is refetched from
 * Scryfall for the printed box alone -- cost, power, toughness and starting
 * loyalty, written on every entry and empty on a card that has none -- one card
 * call and no rulings call and no model, because a judge asked what a spell costs
 * or whether a creature survives cannot read either off a type line. Step 2 skips rulings
 * already in `eval/questions.json` or already judged unusable in
 * `eval/questions-skipped.json`, both keyed on the item id (`<oracle_id>#<n>`) so a
 * reworded ruling is still recognised. One cached question is not skipped: one
 * whose text carries a self-correction, which `eval-run` will not grade, is
 * rewritten and the new one replaces it. Step 3 keeps every false variant already in
 * `eval/cr-examples.json` whose rule is still in the sample, keyed on the rule id,
 * and generates only the ones missing. Every cache is written through a temp file
 * and renamed, and the entries a partial run never reached are merged back in, so
 * an interrupted run can only ever add. A run that cannot authenticate leaves an
 * existing `cr-examples.json` that has false variants exactly as it found it,
 * rather than replacing it with an all-true one.
 *
 * `--limit` caps how many model calls each of the two model steps makes, so a
 * smoke run costs two calls rather than a few hundred.
 *
 * A question in `eval/questions.json` marked `"handEdited": true` was corrected by
 * hand and is kept exactly as written: never regenerated, not even under `--refresh`.
 *
 * Nothing here sends anything about a player or a deck. Card names, oracle text
 * and public rulings only.
 */
import { existsSync, readFileSync } from 'node:fs';

import { z } from 'zod';

import { loadCorpus } from '../server/judge/corpus.ts';
import { ModelAuthError, ModelLimitError } from '../server/judge/model.ts';
import { createRng, shuffleInPlace } from '../src/domain/rng.ts';
import {
  CARDS_PATH,
  CR_EXAMPLES_PATH,
  QUESTIONS_PATH,
  RULINGS_PATH,
  SELF_CORRECTION,
  SKIPPED_PATH,
  flagValue,
  pool,
  readJson,
  reportStop,
  requireFlagValues,
  resolveModel,
  writeJsonAtomic,
} from './eval/lib.ts';

const SCRYFALL = 'https://api.scryfall.com';
const USER_AGENT = 'ProvingGrounds/0.1';
/** Scryfall asks for 50-100 ms between calls; 120 keeps us clear of it. */
const SCRYFALL_DELAY_MS = 120;

/** How many CR worked examples become eval items. */
const CR_EXAMPLE_COUNT = 60;
const CR_EXAMPLE_SEED = 'pg-eval-1';

export interface RulingEntry {
  publishedAt: string;
  comment: string;
}

export interface CardRulings {
  card: string;
  oracleId: string;
  typeLine: string;
  /**
   * Printed mana cost in Scryfall's form, such as `{1}{U}`. Optional because
   * entries written before this field existed do not have it; step 1 fills those
   * in from Scryfall without a model call. Empty string for a land.
   */
  manaCost?: string;
  /**
   * Printed power, toughness and starting loyalty, as Scryfall's strings so `*`
   * and `1+*` survive. Optional for the same reason as `manaCost`: entries
   * written before these fields existed do not have them and step 1 tops those
   * up from Scryfall without a model call. Empty string on a card with no such
   * box, exactly as `manaCost` is empty on a land, so that `undefined` keeps
   * meaning "written before the field existed" and nothing else. A reader skips
   * the empty ones.
   */
  power?: string;
  toughness?: string;
  loyalty?: string;
  oracleText: string;
  rulings: RulingEntry[];
}

export interface EvalQuestion {
  /** `<oracle_id>#<n>`, stable across runs so results can be diffed. */
  id: string;
  card: string;
  question: string;
  answerKey: string;
  ruling: string;
  publishedAt: string;
  source: 'wotc';
  otherCards: string[];
  /**
   * Corrected by hand because the generator got this one wrong. Set on an item,
   * it is kept as written and never regenerated, `--refresh` included.
   */
  handEdited?: true;
}

/** A ruling the generator called unusable. Recorded so it is not paid for twice. */
export interface SkippedQuestion {
  id: string;
  card: string;
  ruling: string;
  reason: string;
}

export interface CrExample {
  ruleId: string;
  example: string;
  rule: string;
  /** `false` items say something wrong on purpose; see the module comment. */
  variant: 'true' | 'false';
  /** What the judge is asked to confirm or correct. */
  statement: string;
  /** The expert answer, which for a false variant says what is wrong with it. */
  answerKey: string;
}

const args = process.argv.slice(2);
requireFlagValues(args, ['--limit', '--driver', '--model']);
const REFRESH = args.includes('--refresh');
/** Resolve the caches, print what each model step would generate, call nothing. */
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => {
  const raw = flagValue(args, '--limit');
  const n = Number(raw);
  return raw !== null && Number.isFinite(n) && n > 0 ? n : Infinity;
})();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The driver every generation call goes through, and its one credentials check.
 * Resolved once, before any step runs, so the two model steps agree about what
 * they are calling and neither pays to find out twice.
 */
const GEN = await resolveModel(args, { defaultConcurrency: 4 });

function hasCredentials(): boolean {
  return GEN.hasCredentials;
}

/** Card names from `eval/cards.txt`; `#` comments and blank lines dropped. */
function readCardNames(): string[] {
  if (!existsSync(CARDS_PATH)) throw new Error(`No card list at ${CARDS_PATH}.`);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of readFileSync(CARDS_PATH, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    names.push(line);
  }
  return names;
}

interface ScryfallFace {
  name: string;
  mana_cost?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
}
interface ScryfallCard {
  name: string;
  oracle_id?: string;
  type_line?: string;
  mana_cost?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  card_faces?: ScryfallFace[];
  rulings_uri: string;
}

/**
 * Backoff for a 429 or a 5xx. Scryfall answers 404 for a name it cannot match.
 * A 429 there means "try again after 60 seconds" whatever `Retry-After` says, so
 * the first wait is a full minute rather than the usual polite second.
 */
const RETRY_DELAYS_MS = [65_000, 65_000, 120_000];

async function scryfall<T>(url: string): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    });
    if (res.status === 404) return null;
    if (res.ok) return (await res.json()) as T;
    const retriable = res.status === 429 || res.status >= 500;
    if (!retriable || attempt >= RETRY_DELAYS_MS.length) {
      throw new Error(`${res.status} ${res.statusText} for ${url}`);
    }
    const wait = RETRY_DELAYS_MS[attempt];
    console.log(`  ${res.status} from Scryfall, retrying in ${wait / 1000}s`);
    await sleep(wait);
  }
}

/** Double-faced cards carry their text per face; flatten so the model sees both. */
function oracleTextOf(card: ScryfallCard): string {
  if (card.oracle_text) return card.oracle_text;
  if (card.card_faces) {
    return card.card_faces
      .map((face) => `${face.name}\n${face.oracle_text ?? ''}`.trim())
      .join('\n//\n');
  }
  return '';
}

/**
 * The printed cost. A split or modal double-faced card has none at the card
 * level and one per face; the front face's cost is the one a question about
 * casting it is usually about, and sending both would read as a single cost with
 * a slash in it. A land's is the empty string, which travels as such.
 */
function manaCostOf(card: ScryfallCard): string {
  return card.mana_cost ?? card.card_faces?.[0]?.mana_cost ?? '';
}

/**
 * The printed box, front face first for the same reason the cost is. Base
 * values as Scryfall's strings, so `*` and `1+*` are kept whole.
 *
 * Stored the way the cost is: written on every entry, as the empty string on a
 * card that has no such box. An instant legitimately has no power, so absence
 * cannot mean both "this card has none" and "this file predates the field" —
 * writing the empty string is what keeps `undefined` meaning only the second,
 * which is what the top-up below tests. A reader skips the empty ones, as a
 * blank in a reference line would read as a size of nothing.
 */
function boxOf(card: ScryfallCard): { power: string; toughness: string; loyalty: string } {
  const front = card.card_faces?.[0];
  return {
    power: card.power ?? front?.power ?? '',
    toughness: card.toughness ?? front?.toughness ?? '',
    loyalty: card.loyalty ?? front?.loyalty ?? '',
  };
}

async function step1Rulings(): Promise<CardRulings[]> {
  console.log('step 1: cards and rulings from Scryfall');
  const names = readCardNames();
  // Read from disk even under --refresh. `cached` drives the skip decision and is
  // empty when refreshing, but `onDisk` is what a partial write merges back into,
  // so an interrupted run never costs us a card we already paid Scryfall for.
  const onDisk = readJson<CardRulings[]>(RULINGS_PATH, []);
  const cached = REFRESH ? [] : onDisk;
  // Scryfall answers a double-faced card with its full `Front // Back` name, so
  // the cache is keyed on the front face too or those cards refetch every run.
  const byName = new Map<string, CardRulings>();
  for (const entry of cached) {
    byName.set(entry.card, entry);
    const front = entry.card.split(' // ')[0];
    if (!byName.has(front)) byName.set(front, entry);
  }

  const out: CardRulings[] = [];
  const dropped: string[] = [];
  let fetched = 0;
  let filled = 0;

  /** Everything reached this run, plus every on-disk entry it has not replaced. */
  const flush = () => {
    const written = new Set(out.map((entry) => entry.card));
    writeJsonAtomic(RULINGS_PATH, [...out, ...onDisk.filter((entry) => !written.has(entry.card))]);
  };

  // Checkpointed: a rate limit or a dropped connection halfway through must not
  // cost the cards already paid for.
  try {
    for (const name of names) {
      const hit = byName.get(name);
      if (hit) {
        // A cached entry written before `manaCost` or the printed box existed is
        // topped up rather than refetched whole: one card call, no rulings call,
        // no model. The judge cannot read a printed cost or a printed size off a
        // type line or off oracle text, and a live eval item was graded disagree
        // for guessing a cost.
        if (hit.manaCost === undefined || hit.power === undefined) {
          await sleep(SCRYFALL_DELAY_MS);
          const card = await scryfall<ScryfallCard>(
            `${SCRYFALL}/cards/named?exact=${encodeURIComponent(hit.card)}`,
          );
          // Rebuilt rather than spread, so the fields land where a freshly
          // fetched entry puts them and the two are the same shape on disk. A
          // name Scryfall will not resolve today still gets every field, as the
          // empty string, so the next run does not ask again for the same
          // nothing. A cost already on disk is kept rather than overwritten with
          // a blank when this call is the one that fails.
          const box = card ? boxOf(card) : { power: '', toughness: '', loyalty: '' };
          out.push({
            card: hit.card,
            oracleId: hit.oracleId,
            typeLine: hit.typeLine,
            manaCost: card ? manaCostOf(card) : (hit.manaCost ?? ''),
            power: box.power,
            toughness: box.toughness,
            loyalty: box.loyalty,
            oracleText: hit.oracleText,
            rulings: hit.rulings,
          });
          filled++;
          if (filled % 20 === 0) flush();
          continue;
        }
        out.push(hit);
        continue;
      }
      await sleep(SCRYFALL_DELAY_MS);
      const card = await scryfall<ScryfallCard>(
        `${SCRYFALL}/cards/named?exact=${encodeURIComponent(name)}`,
      );
      if (!card) {
        dropped.push(name);
        continue;
      }
      await sleep(SCRYFALL_DELAY_MS);
      const rulings = await scryfall<{ data: { published_at: string; comment: string; source: string }[] }>(
        card.rulings_uri,
      );
      out.push({
        card: card.name,
        oracleId: card.oracle_id ?? '',
        typeLine: card.type_line ?? '',
        manaCost: manaCostOf(card),
        ...boxOf(card),
        oracleText: oracleTextOf(card),
        rulings: (rulings?.data ?? [])
          .filter((r) => r.source === 'wotc')
          .map((r) => ({ publishedAt: r.published_at, comment: r.comment })),
      });
      fetched++;
      if (fetched % 20 === 0) flush();
    }
  } finally {
    flush();
  }

  const rulingCount = out.reduce((n, entry) => n + entry.rulings.length, 0);
  console.log(`  ${out.length} cards resolved (${fetched} newly fetched, ${cached.length} cached)`);
  if (filled > 0) console.log(`  ${filled} cached entries topped up with their printed cost and box`);
  console.log(`  ${rulingCount} Wizards rulings`);
  if (dropped.length > 0) {
    console.log(`  ${dropped.length} dropped, Scryfall could not resolve them exactly:`);
    for (const name of dropped) console.log(`    ${name}`);
  } else {
    console.log('  0 dropped');
  }
  console.log(`  wrote ${RULINGS_PATH}`);
  return out;
}

/**
 * `precondition` is the generator's working, not part of the item: it is asked
 * for before the question so the state check happens before the question is
 * written, and it is dropped rather than stored.
 */
const Generated = z.object({
  usable: z.boolean(),
  reason: z.string(),
  precondition: z.string(),
  question: z.string(),
  answerKey: z.string(),
  needsOtherCard: z.array(z.string()),
});

const GEN_PROMPT = `You turn an official Magic: the Gathering card ruling into one rules question for a Commander judge eval.

The ruling is the expert answer. Your job is to write the question whose correct answer is that ruling.

Write it as a player would ask at a table: one self-contained question, a two or three sentence scenario is fine. Name the card. Name every other card the ruling depends on. State every fact needed to answer, so a judge who has never seen the ruling can still answer from the rules. Do not hint at the answer and do not quote the ruling in the question.

The scenario must put the game in the state the ruling is about, not merely mention the same cards. Before you write the question, fill in precondition: one sentence saying what state the ruling's premise requires — stack order, zones, timing, who controls what — and confirming your scenario has it. A scenario that misses it asks something the ruling never answers: a ruling about a triggered ability resolving while a spell is still on the stack needs that trigger ABOVE that spell, and a scenario where the spell resolves first is a different question with a different answer. precondition is your working and is not stored; write "n/a" when usable is false.

Write ONE clean scenario. The question text is the finished question, not your working: no self-corrections, no restarts, no rewrites, nothing like "wait, let me redo that" or "scratch that" or a second version of the scenario after a first. If the scenario you started does not work, write the whole question again from the beginning and return only that.

answerKey restates the ruling as the direct answer to your question. Restating it verbatim is fine when it already reads as an answer.

When the answer turns on a number worked out from your scenario — a mana value, a life total, a count — work it out again term by term before you answer, and show that working in the answerKey, like "1 + 3 = 4". X in a mana cost is 0 anywhere except on the stack, so a card in a library, a hand or a graveyard has mana value counted with X as 0.

Set usable to false with reason "question contains a self-correction" if the only question you can write for this ruling would need one.

Set usable to false, and say why in reason, when the ruling is any of these: an errata or wording-change note, flavour or design commentary, a restatement of the card's own reminder text, a format legality or banning note, a note about which printings exist, or a ruling that only makes sense with an unnamed card you would have to invent. When usable is false, leave question and answerKey empty.

needsOtherCard lists the other cards you named, if any.`;

/** `stopped` is an item the stop signal reached before it was ever asked. */
type GenOutcome = { result: z.infer<typeof Generated> } | { error: string } | { stopped: true };

async function generateOne(
  card: CardRulings,
  ruling: RulingEntry,
): Promise<{ result: z.infer<typeof Generated> } | { error: string }> {
  const user = [
    `CARD: ${card.card}`,
    `TYPE: ${card.typeLine}`,
    `ORACLE TEXT:\n${card.oracleText}`,
    `RULING (${ruling.publishedAt}):\n${ruling.comment}`,
  ].join('\n\n');
  try {
    const { parsed } = await GEN.model.complete({
      system: [{ text: GEN_PROMPT }],
      user,
      schema: Generated,
      effort: 'medium',
      maxTokens: 2000,
    });
    return { result: parsed };
  } catch (err) {
    // A refusal or an unparseable answer is this item's problem and is cached as
    // such. No login, and no usage left, are the whole run's problem: they go up.
    if (err instanceof ModelAuthError || err instanceof ModelLimitError) throw err;
    return { error: (err as Error).message };
  }
}

/** `stopped` means the driver cannot answer any more calls and the run must not continue. */
async function step2Questions(cards: CardRulings[]): Promise<{ stopped: boolean }> {
  console.log('step 2: questions from rulings');
  if (!hasCredentials()) {
    console.log(`  skipped: ${GEN.missingHint}, so no questions were generated.`);
    return { stopped: false };
  }
  if (GEN.note) console.log(`  ${GEN.note}`);

  const onDiskQuestions = readJson<EvalQuestion[]>(QUESTIONS_PATH, []);
  // A hand-edited item survives everything this step does. It says what it says
  // because a person read the ruling and found the generated question wrong
  // about it, so regenerating it — because of `--refresh`, or because its text
  // trips the self-correction check — would only put the defect back.
  const handEdited = onDiskQuestions.filter((q) => q.handEdited === true);
  const cachedQuestions = REFRESH ? handEdited : onDiskQuestions;
  const cachedSkips = REFRESH ? [] : readJson<SkippedQuestion[]>(SKIPPED_PATH, []);
  if (handEdited.length > 0) {
    console.log(
      `  ${handEdited.length} hand-edited question${handEdited.length === 1 ? '' : 's'} kept as written, not regenerated: ${handEdited.map((q) => q.id).join(', ')}`,
    );
  }
  // A cached question the eval will not grade is not done. `eval-run` refuses to
  // ask a generated question that carries a self-correction, so one sitting in the
  // cache is an item permanently missing from the set unless this step asks for it
  // again. Hand-edited questions are exempt from the rewrite here and `eval-run`
  // mirrors that exemption at load, so a person's wording is never dropped by one
  // step that the other will not put back.
  const rewrite = new Set(
    cachedQuestions
      .filter((q) => q.handEdited !== true && SELF_CORRECTION.test(q.question))
      .map((q) => q.id),
  );
  if (rewrite.size > 0) {
    console.log(`  ${rewrite.size} cached question${rewrite.size === 1 ? '' : 's'} to rewrite: the text contains a self-correction`);
  }
  // Keyed on the item id, not the ruling text: the id is what results are keyed
  // on downstream, and Wizards does reword a ruling without changing what it says.
  const done = new Set(
    [...cachedQuestions.map((q) => q.id), ...cachedSkips.map((s) => s.id)].filter((id) => !rewrite.has(id)),
  );

  const jobs: { card: CardRulings; ruling: RulingEntry; id: string }[] = [];
  for (const card of cards) {
    card.rulings.forEach((ruling, n) => {
      const id = `${card.oracleId}#${n}`;
      if (done.has(id)) return;
      jobs.push({ card, ruling, id });
    });
  }
  const todo = jobs.slice(0, LIMIT === Infinity ? jobs.length : LIMIT);
  console.log(
    `  ${cachedQuestions.length} cached, ${cachedSkips.length} previously unusable, ${todo.length} to generate (of ${jobs.length} ungenerated)`,
  );
  if (DRY_RUN) {
    console.log(`  --dry-run: ${todo.length} model calls would be made here; nothing was called or written.`);
    return { stopped: false };
  }

  const skips = new Map<string, number>();
  let errors = 0;
  let notAttempted = 0;
  const fresh: EvalQuestion[] = [];
  const freshSkips: SkippedQuestion[] = [];

  // A login that turns out to be unusable, or a plan window that runs out
  // mid-batch, is caught per item rather than thrown out of the pool. Thrown, it
  // would abandon every sibling call still in flight and every answer already
  // paid for; caught, it becomes a stop signal: nothing new is started, the calls
  // already running are allowed to land, and the whole batch is written before
  // the run says why it stopped.
  let stopError: ModelAuthError | ModelLimitError | null = null;
  const results = await pool<(typeof todo)[number], GenOutcome>(todo, GEN.concurrency, async (job) => {
    if (stopError !== null) return { stopped: true };
    try {
      return await generateOne(job.card, job.ruling);
    } catch (err) {
      if (err instanceof ModelAuthError || err instanceof ModelLimitError) {
        stopError ??= err;
        return { stopped: true };
      }
      throw err;
    }
  });

  todo.forEach((job, i) => {
    const outcome = results[i];
    if ('stopped' in outcome) {
      // Never asked. Left uncached so the next run picks it up unchanged.
      notAttempted++;
      return;
    }
    if ('error' in outcome) {
      // An error is not a verdict: leave it uncached so a later run retries it.
      errors++;
      return;
    }
    const gen = outcome.result;
    if (!gen.usable || gen.question.trim() === '' || gen.answerKey.trim() === '') {
      const key = gen.reason.trim() === '' ? 'unusable' : gen.reason.trim().slice(0, 60);
      skips.set(key, (skips.get(key) ?? 0) + 1);
      freshSkips.push({
        id: job.id,
        card: job.card.card,
        ruling: job.ruling.comment,
        reason: gen.reason.trim() === '' ? 'unusable' : gen.reason.trim(),
      });
      return;
    }
    fresh.push({
      id: job.id,
      card: job.card.card,
      question: gen.question.trim(),
      answerKey: gen.answerKey.trim(),
      ruling: job.ruling.comment,
      publishedAt: job.ruling.publishedAt,
      source: 'wotc',
      otherCards: gen.needsOtherCard,
    });
  });

  // A rewritten question replaces the cached one it was asked for rather than
  // sitting beside it under the same id, and a rewrite that came back unusable
  // takes the cached one out too: it is in the skip file now, so the next run
  // reads it as done instead of paying to rewrite it again every time.
  const resolved = new Set([...fresh.map((q) => q.id), ...freshSkips.map((s) => s.id)]);
  const all = [...cachedQuestions.filter((q) => !resolved.has(q.id)), ...fresh].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const allSkips = [...cachedSkips, ...freshSkips].sort((a, b) => a.id.localeCompare(b.id));
  writeJsonAtomic(QUESTIONS_PATH, all);
  writeJsonAtomic(SKIPPED_PATH, allSkips);
  console.log(
    `  ${fresh.length} generated, ${freshSkips.length} skipped, ${errors} errored` +
      (notAttempted > 0 ? `, ${notAttempted} never asked` : ''),
  );
  for (const [reason, n] of [...skips.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${n}  ${reason}`);
  }
  console.log(`  wrote ${QUESTIONS_PATH} (${all.length} questions)`);
  console.log(`  wrote ${SKIPPED_PATH} (${allSkips.length} unusable rulings, not re-asked)`);

  // Said last, after the work is safely on disk: the sentence is what to do next,
  // and it is only honest once nothing this step finished has been thrown away.
  if (stopError !== null) {
    reportStop(GEN.driver, stopError);
    return { stopped: true };
  }
  return { stopped: false };
}

const FalseVariant = z.object({
  falseStatement: z.string(),
  whatChanged: z.string(),
});

const FALSE_PROMPT = `You write wrong answers for a Magic: the Gathering judge eval.

You are given one rule from the Comprehensive Rules and one worked example printed under it. The example is true. Rewrite it so it is false.

Change exactly one material fact or one conclusion: which player gets the effect, which object is affected, a number, a timing, or the outcome. The result must be wrong under the rule as printed, not merely vague, and not a trick of wording. Do not negate the whole sentence, do not add "not" to the conclusion and stop there, and do not introduce cards or rules the example did not mention.

Keep the same length, the same tense and the same flat rules-text tone as the original. A reader who does not know the rule must not be able to tell which of the two is the real one.

falseStatement is the rewritten example, with no "Example:" prefix.

whatChanged is one sentence, in the third person, saying what the correct statement is instead. It is read as part of the expert answer, so state the truth rather than describing your edit.`;

async function generateFalse(
  entry: { ruleId: string; rule: string; statement: string },
): Promise<{ result: z.infer<typeof FalseVariant> } | { error: string }> {
  const user = [`RULE ${entry.ruleId}\n${entry.rule}`, `EXAMPLE\n${entry.statement}`].join('\n\n');
  try {
    const { parsed } = await GEN.model.complete({
      system: [{ text: FALSE_PROMPT }],
      user,
      schema: FalseVariant,
      effort: 'medium',
      maxTokens: 2000,
    });
    return { result: parsed };
  } catch (err) {
    if (err instanceof ModelAuthError || err instanceof ModelLimitError) throw err;
    return { error: (err as Error).message };
  }
}

async function step3CrExamples() {
  console.log('step 3: Comprehensive Rules worked examples');
  const corpus = loadCorpus();
  const candidates: { ruleId: string; example: string; rule: string }[] = [];
  for (const rule of corpus.rules.values()) {
    for (const example of rule.examples) candidates.push({ ruleId: rule.id, example, rule: rule.text });
  }
  // One example per rule: eval-run holds the whole rule's examples out of the
  // corpus, so two items from one rule would share a held-out slot.
  const seenRule = new Set<string>();
  const unique = candidates.filter((item) => {
    if (seenRule.has(item.ruleId)) return false;
    seenRule.add(item.ruleId);
    return true;
  });

  const shuffled = [...unique];
  shuffleInPlace(shuffled, createRng(CR_EXAMPLE_SEED));
  const picked = shuffled.slice(0, CR_EXAMPLE_COUNT).sort((a, b) => a.ruleId.localeCompare(b.ruleId));

  const items: CrExample[] = picked.map((entry) => {
    const statement = entry.example.replace(/^Example:\s*/, '').trim();
    return { ...entry, variant: 'true', statement, answerKey: statement };
  });
  console.log(`  ${unique.length} rules carry examples; sampled ${items.length} with seed "${CR_EXAMPLE_SEED}"`);

  // A false variant is a paid model call whose input — the rule and its printed
  // example — does not change between runs, so one already on disk is reused
  // whatever index it now sits at. Keyed by rule id, because that is what the
  // variant was written against; the sample order is not part of its identity.
  // Read from disk even under --refresh: `existingFalse` drives the reuse and is
  // empty when refreshing, but the file's contents still decide whether a run
  // that cannot generate is allowed to write over it.
  const onDisk = readJson<CrExample[]>(CR_EXAMPLES_PATH, []);
  const existingFalse = new Map<string, CrExample>();
  if (!REFRESH) {
    for (const item of onDisk) {
      if (item.variant === 'false' && (item.statement ?? '').trim() !== '') existingFalse.set(item.ruleId, item);
    }
  }
  let reused = 0;
  items.forEach((item, i) => {
    const hit = existingFalse.get(item.ruleId);
    if (!hit) return;
    items[i] = { ...item, variant: 'false', statement: hit.statement, answerKey: hit.answerKey };
    reused++;
  });
  if (reused > 0) console.log(`  ${reused} false variants reused from ${CR_EXAMPLES_PATH}`);

  // Every other item by index, so which half is falsified is fixed by the seed
  // rather than by whether the generation step ran. Ones already carrying a
  // variant are not rewritten: the answer key downstream would move for nothing.
  const missing = items.map((_, i) => i).filter((i) => i % 2 === 1 && items[i].variant !== 'false');
  const todo = LIMIT === Infinity ? missing : missing.slice(0, LIMIT);
  if (todo.length < missing.length) {
    console.log(`  --limit ${LIMIT}: generating ${todo.length} of ${missing.length} missing false variants`);
  }

  /**
   * Whether there is something on disk worth more than what this run can write.
   * The file is the eval's only source of false statements, and a true-only
   * rewrite of it silently turns the CR half of the set into a free 100%, so an
   * unauthenticated run is not allowed to produce one over a file that has them.
   */
  const wouldLoseFalseVariants = onDisk.some((item) => item.variant === 'false');

  let results: ({ result: z.infer<typeof FalseVariant> } | { error: string } | { stopped: true })[] | null =
    null;
  let stopError: ModelAuthError | ModelLimitError | null = null;

  if (DRY_RUN) {
    console.log(`  --dry-run: ${todo.length} false variants would be generated; nothing was called or written.`);
    return;
  }
  if (todo.length === 0) {
    console.log(`  0 false variants to generate (${items.filter((i) => i.variant === 'false').length} already present)`);
  } else if (!hasCredentials()) {
    if (wouldLoseFalseVariants) {
      console.log(`  false variants skipped: ${GEN.missingHint}; kept the existing ${CR_EXAMPLES_PATH} unchanged.`);
      return;
    }
    console.log(
      `  false variants skipped: ${GEN.missingHint}, so all ${items.length} items are true statements.`,
    );
  } else {
    // Same stop signal as step 2: an unusable login, or a spent plan window,
    // must not cost the variants this run already generated.
    results = await pool(todo, GEN.concurrency, async (i) => {
      if (stopError !== null) return { stopped: true } as const;
      try {
        return await generateFalse(items[i]);
      } catch (err) {
        if (err instanceof ModelAuthError || err instanceof ModelLimitError) {
          stopError ??= err;
          return { stopped: true } as const;
        }
        throw err;
      }
    });
  }

  if (results !== null) {
    let made = 0;
    let errors = 0;
    todo.forEach((i, n) => {
      const outcome = results[n];
      if ('stopped' in outcome) return;
      if ('error' in outcome) {
        errors++;
        return;
      }
      const { falseStatement, whatChanged } = outcome.result;
      if (falseStatement.trim() === '' || whatChanged.trim() === '') {
        errors++;
        return;
      }
      items[i] = {
        ...items[i],
        variant: 'false',
        statement: falseStatement.trim(),
        answerKey: `${items[i].answerKey} The statement is wrong: ${whatChanged.trim()}`,
      };
      made++;
    });
    console.log(`  ${made} false variants generated, ${errors} errored (left as true statements)`);
  }

  if (stopError !== null && wouldLoseFalseVariants) {
    console.log(`  kept the existing ${CR_EXAMPLES_PATH} unchanged.`);
    reportStop(GEN.driver, stopError);
    return;
  }

  writeJsonAtomic(CR_EXAMPLES_PATH, items);
  const falseCount = items.filter((item) => item.variant === 'false').length;
  console.log(`  wrote ${CR_EXAMPLES_PATH} (${items.length - falseCount} true, ${falseCount} false)`);
  if (stopError !== null) reportStop(GEN.driver, stopError);
}

async function main() {
  const cards = await step1Rulings();
  // Step 3's model calls go through the same driver, so a login step 2 has just
  // proved unusable would only fail them all again, more expensively.
  const { stopped } = await step2Questions(cards);
  if (stopped) return;
  await step3CrExamples();
}

main().catch((err) => {
  console.error(`eval:build failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
