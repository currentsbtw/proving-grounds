/**
 * Loads and indexes the Comprehensive Rules text that grounds the advisory
 * judge. Pure: reads one file, returns data, holds no state and talks to no
 * network. `scripts/judge-corpus.ts` fetches the file; the eval harness loads
 * the same corpus with examples held out.
 *
 * The corpus is the judge's only authority. Everything the model cites is
 * checked back against the `rules` map before it reaches the player, so the
 * index has to be complete rather than clever.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CorpusRule {
  /** Normalised id, no trailing period: `903.9`, `903.9a`, `704.5aa`. */
  id: string;
  /** The rule's own line, id included, as printed. */
  text: string;
  /** `Example:` lines printed under this rule. */
  examples: string[];
}

export interface Corpus {
  /** The whole document, BOM and CRLF stripped, held-out examples removed. */
  text: string;
  /** The document's own line 3, e.g. `August 7, 2026`. */
  effectiveDate: string;
  rules: Map<string, CorpusRule>;
  /** Glossary term to definition. Terms are printed as they appear. */
  glossary: Map<string, string>;
  /**
   * Rules whose examples were cut from `text`. `rules[].examples` still carries
   * them, because the eval harness builds its held-out questions from exactly
   * those lines; anything that re-renders a rule (retrieval) has to consult this
   * set or it would print the held-out example straight back into the prompt.
   */
  excludedExampleRules: Set<string>;
}

export interface LoadCorpusOptions {
  /** Rule ids whose `Example:` lines are cut from `text`, for eval held-outs. */
  excludeExampleRules?: Set<string>;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where `npm run judge:corpus` writes the file. Gitignored, never committed. */
export const CORPUS_PATH = path.join(here, 'corpus', 'cr.txt');

/**
 * The one rule-id grammar. Everything that recognises an id -- the line parser
 * below, `resolveRule`, and all of retrieval -- is built from these two pieces,
 * because three near-copies of the same pattern is how `704.5aa` came to be
 * indexed in one place and invisible in another.
 *
 * The letter run has to allow two: rule 704.5's subrules run past `z`, and
 * against a one-letter pattern `704.5aa` matched nothing at all, so it was
 * absent from the index and any citation of it came back unverified.
 */
const RULE_ID_STEM = String.raw`\d{3}\.\d+`;
const RULE_ID_SUFFIX = '[a-z]{1,2}';
/** The printed form of an id: `903.9`, `903.9a`, `704.5aa`. */
export const RULE_ID_SOURCE = `${RULE_ID_STEM}(?:${RULE_ID_SUFFIX})?`;

const RULE_ID_EXACT = new RegExp(`^${RULE_ID_SOURCE}$`);
const RULE_ID_PARTS = new RegExp(`^(${RULE_ID_STEM})${RULE_ID_SUFFIX}$`);

/** Is this string already a printed rule id? */
export function isRuleId(id: string): boolean {
  return RULE_ID_EXACT.test(id);
}

/** `903.9` for `903.9a`; null for a top-level rule or anything that is not an id. */
export function ruleParentId(id: string): string | null {
  const match = RULE_ID_PARTS.exec(id);
  return match ? match[1] : null;
}

/** True for `903.9`, false for `903.9a` and for anything that is not an id. */
export function isTopLevelRuleId(id: string): boolean {
  return isRuleId(id) && ruleParentId(id) === null;
}

/**
 * A fresh scanner for ids inside prose, in every spelling that reaches us: bare
 * (`704.5g`), prefixed (`rule 704.5g`, `CR 704.5g`), parenthesised (`704.5(g)`)
 * and shouted (`704.5G`). Feed each match to `resolveRule`, which normalises it
 * and is the only thing that decides whether the corpus actually has it.
 *
 * A new RegExp per call on purpose: a `g` flag carries `lastIndex`, and a shared
 * one silently skips matches when two scans interleave.
 */
export function ruleMentionScanner(): RegExp {
  return new RegExp(
    String.raw`\b(?:(?:cr|rules?)\s+)?${RULE_ID_STEM}(?:\([a-z]\)|${RULE_ID_SUFFIX}\b|\b)`,
    'gi',
  );
}

/** A numbered rule line: `903.9. ...`, `903.9a ...`, `704.5aa ...`. */
const RULE_LINE = new RegExp(`^(${RULE_ID_SOURCE})\\.?\\s`);
const EFFECTIVE_DATE = /^These rules are effective as of (.+?)\.\s*$/m;

export function corpusExists(file: string = CORPUS_PATH): boolean {
  return existsSync(file);
}

/**
 * Rule ids arrive from the model spelled several ways. Reduce them all to the
 * printed subrule form (`903.9a`), which is how the index is keyed.
 */
export function normaliseRuleId(raw: string): string {
  let id = raw.trim().toLowerCase();
  id = id.replace(/^(?:cr|rules?)\s+/, '');
  id = id.replace(/\s*\(([a-z])\)$/, '$1');
  id = id.replace(/\.$/, '');
  return id;
}

export function parseCorpus(raw: string, opts: LoadCorpusOptions = {}): Corpus {
  const normalised = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = normalised.split('\n');

  const dateMatch = EFFECTIVE_DATE.exec(normalised);
  if (!dateMatch) throw new Error('Corpus has no "effective as of" line; it is probably not the CR text.');
  const effectiveDate = dateMatch[1];

  const rules = new Map<string, CorpusRule>();
  /** Line index to the rule that owns the example printed there. */
  const exampleOwner = new Map<number, string>();
  let current: CorpusRule | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = RULE_LINE.exec(line);
    if (match) {
      current = { id: match[1], text: line.trim(), examples: [] };
      // Later printings of an id win; the CR never repeats one.
      rules.set(current.id, current);
      continue;
    }
    if (current && line.startsWith('Example:')) {
      current.examples.push(line.trim());
      exampleOwner.set(i, current.id);
    }
  }

  // The first `Glossary` and `Credits` lines are the table of contents; the
  // real sections are the second pair.
  const headings = (name: string) =>
    lines.reduce<number[]>((acc, line, i) => (line.trim() === name ? [...acc, i] : acc), []);
  const glossaryStarts = headings('Glossary');
  const creditsStarts = headings('Credits');
  const glossary = new Map<string, string>();
  if (glossaryStarts.length >= 2) {
    const start = glossaryStarts[1] + 1;
    const end = creditsStarts.find((i) => i > start) ?? lines.length;
    let block: string[] = [];
    const flush = () => {
      if (block.length >= 2) glossary.set(block[0].trim(), block.slice(1).join(' ').trim());
      block = [];
    };
    for (let i = start; i < end; i++) {
      const line = lines[i];
      if (line.trim() === '') flush();
      else block.push(line);
    }
    flush();
  }

  const exclude = opts.excludeExampleRules;
  const text =
    exclude && exclude.size > 0
      ? lines.filter((_, i) => !exclude.has(exampleOwner.get(i) ?? '')).join('\n')
      : normalised;

  return {
    text,
    effectiveDate,
    rules,
    glossary,
    excludedExampleRules: new Set(exclude ?? []),
  };
}

export function loadCorpus(opts: LoadCorpusOptions = {}, file: string = CORPUS_PATH): Corpus {
  if (!existsSync(file)) {
    throw new Error(`No Comprehensive Rules text at ${file}. Run npm run judge:corpus first.`);
  }
  return parseCorpus(readFileSync(file, 'utf8'), opts);
}

/**
 * Look a cited id up in the corpus. Accepts `903.9a`, `903.9(a)`, `rule 903.9a`,
 * `CR 903.9a` and a trailing period. Returns null for anything unknown, which is
 * what makes an unverifiable citation visible instead of quietly plausible.
 */
export function resolveRule(corpus: Corpus, id: string): CorpusRule | null {
  const key = normaliseRuleId(id);
  if (!isRuleId(key)) return null;
  return corpus.rules.get(key) ?? null;
}
