/**
 * Downloads the current Comprehensive Rules text for the advisory judge.
 *
 *   npm run judge:corpus
 *
 * The file is gitignored: it is a ~1 MB Wizards document that changes on their
 * schedule, not ours, so it is fetched rather than vendored. Academy Ruins keeps
 * a redirect to whatever the latest official TXT is; when that redirect points
 * at a URL Wizards has not published yet (it has), the pinned fallback is used.
 *
 * A download that parses to fewer than 3000 rules is rejected rather than
 * written: a truncated or wrong file would silently gut every citation check.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CORPUS_PATH, parseCorpus } from '../server/judge/corpus.ts';

const PRIMARY = 'https://api.academyruins.com/link/cr';
const FALLBACK = 'https://media.wizards.com/2026/downloads/MagicCompRules%2020260819.txt';
const MIN_RULES = 3000;
const USER_AGENT = 'ProvingGrounds/0.1';
/**
 * Wizards reissues the CR every set, roughly every three months. Past this the
 * file we just wrote is probably the pinned fallback rather than the current
 * document, which is a thing that has to be loud: a silently stale corpus makes
 * every citation check answer about rules that have moved on. A warning and not
 * a failure, because an old corpus still beats no corpus.
 */
const STALE_AFTER_DAYS = 120;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${res.url}`);
  const text = await res.text();
  if (text.length < 100_000) throw new Error(`Body from ${res.url} is only ${text.length} bytes.`);
  return text;
}

async function main() {
  let text: string;
  try {
    text = await fetchText(PRIMARY);
    console.log(`Fetched from ${PRIMARY}`);
  } catch (err) {
    console.log(`Primary failed (${(err as Error).message}); using the pinned fallback.`);
    text = await fetchText(FALLBACK);
    console.log(`Fetched from ${FALLBACK}`);
  }

  const corpus = parseCorpus(text);
  if (corpus.rules.size < MIN_RULES) {
    throw new Error(
      `Refusing to write: parsed only ${corpus.rules.size} rules, expected at least ${MIN_RULES}.`,
    );
  }

  mkdirSync(path.dirname(CORPUS_PATH), { recursive: true });
  writeFileSync(CORPUS_PATH, text, 'utf8');
  const kb = Math.round(Buffer.byteLength(text, 'utf8') / 1024);
  console.log(
    `Wrote ${CORPUS_PATH} (${kb} KB), effective ${corpus.effectiveDate}, ${corpus.rules.size} rules, ${corpus.glossary.size} glossary terms.`,
  );
  warnIfStale(corpus.effectiveDate);
}

/** Loud, repeated, and impossible to read as routine output. */
function warnIfStale(effectiveDate: string) {
  const effective = new Date(effectiveDate);
  if (Number.isNaN(effective.getTime())) {
    console.log(`WARNING: could not read "${effectiveDate}" as a date, so its age is unknown.`);
    return;
  }
  const days = Math.floor((Date.now() - effective.getTime()) / 86_400_000);
  if (days <= STALE_AFTER_DAYS) return;
  console.log('');
  console.log('*'.repeat(72));
  console.log(`WARNING: this corpus is ${days} days old (effective ${effectiveDate}).`);
  console.log(`Anything past ${STALE_AFTER_DAYS} days is very likely the pinned fallback rather than`);
  console.log('the current rules. Check the FALLBACK url in scripts/judge-corpus.ts against');
  console.log('the latest Comprehensive Rules release before trusting a citation.');
  console.log('*'.repeat(72));
}

main().catch((err) => {
  console.error(`judge:corpus failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
