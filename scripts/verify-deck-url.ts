/**
 * Verification harness for deck links: parsing them, and turning what the two
 * sites return into entries the existing decklist parser accepts.
 *
 * The point of the whole feature is that a pasted link ends up in the same
 * place a pasted list does, so the checks are about agreement rather than about
 * the shapes in isolation:
 *
 *   A — `parseDeckUrl` over 15 inputs: both sites, with and without a scheme
 *       and a www, with a slug, a query and a hash, the Archidekt API form, and
 *       four rejects (a Scryfall card page, a Moxfield user page, a decklist
 *       line, a non-numeric Archidekt id), plus `isDeckUrl` on a two-line paste.
 *   B — `normalizeArchidekt` on a real response, recorded from
 *       `https://archidekt.com/api/decks/1/` and committed at
 *       `scripts/fixtures/archidekt-deck-1.json`: 17 cards in, 17 entries out,
 *       Thelon of Havenwood alone as the commander, nothing dropped.
 *   C — the same fixture with a Maybeboard bolted on, fabricated here rather
 *       than committed: a card whose only category is excluded from the deck is
 *       gone, a card that is also in an included category stays, and a name
 *       listed twice comes back as one entry with the copies added up. Then the
 *       quantities: a row stating 0 copies is skipped and counted, while a row
 *       stating no quantity at all is still one copy.
 *   D — `normalizeMoxfield` on both documented shapes. Read the warning on the
 *       fixtures: Moxfield's API is Cloudflare bot-gated and answers 403 to
 *       anything without a user agent they have whitelisted on request, so
 *       `scripts/fixtures/moxfield-deck-v2.json` and `-v3.json` are HAND-MADE
 *       from the documented shapes and have NEVER been checked against a live
 *       response. They prove the reader handles both shapes; they do not prove
 *       either shape is what Moxfield actually sends. Because of that, a board
 *       the reader does not know is named in the warnings rather than dropped,
 *       and the deck metadata sitting beside the v2 boards must not be mistaken
 *       for one; a row stating 0 copies is skipped here too.
 *   E — `toDecklistText` through `parseDecklist` returns the same entries it
 *       started with, for a fetched Archidekt deck and a fetched Moxfield one.
 *       This is the join: if it holds, a fetched deck is indistinguishable from
 *       a pasted one by the time it reaches Scryfall.
 *   F — `describeDeckFetchError`: a distinct sentence per failure, the two 502s
 *       differing by site, and no case left saying nothing. Status alone is not
 *       the failure — the code separates a build with no fetcher from a fetcher
 *       that is down, and a fetcher with no reader for a site from one that
 *       answered a routing error — so both halves are passed.
 *
 *   npx tsx scripts/verify-deck-url.ts
 *
 * Failures are collected rather than thrown one at a time, so a bad run reports
 * everything wrong in a single pass. The process exits non-zero if any failed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  describeDeckFetchError,
  NO_DECK_FETCHER_CODE,
  isDeckUrl,
  normalizeArchidekt,
  normalizeMoxfield,
  parseDeckUrl,
  toDecklistText,
  type DeckSite,
  type DeckUrlRef,
  type FetchedDeck,
} from '../src/domain/deckUrl.ts';
import { parseDecklist } from '../src/services/deckParser.ts';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

function fixture(file: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURE_DIR}${file}`, 'utf8')) as unknown;
}

/** A ref built by hand, for normalising a fixture without a link to parse. */
function refFor(site: DeckSite, id: string): DeckUrlRef {
  const parsed = parseDeckUrl(
    site === 'moxfield' ? `https://www.moxfield.com/decks/${id}` : `https://archidekt.com/decks/${id}`,
  );
  if (!parsed) throw new Error(`the ${site} ref for ${id} did not parse`);
  return parsed;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const failures: string[] = [];
/** Every assertion attempted, so the run reports what it actually covered. */
let checked = 0;

function check(label: string, condition: boolean, detail = ''): void {
  checked += 1;
  if (!condition) failures.push(detail ? `${label} — ${detail}` : label);
}

function checkEqual(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(label, a === b, `got ${a}, expected ${b}`);
}

function names(deck: FetchedDeck): string[] {
  return deck.entries.map((e) => e.name);
}

function copies(deck: FetchedDeck): number {
  return deck.entries.reduce((sum, e) => sum + e.qty, 0);
}

function commanders(deck: FetchedDeck): string[] {
  return deck.entries.filter((e) => e.isCommander).map((e) => e.name);
}

// ---------------------------------------------------------------------------
// A — links
// ---------------------------------------------------------------------------

const MOX_ID = 'AbCd_12EfGh';

interface UrlCase {
  input: string;
  site: DeckSite | null;
  id?: string;
}

const URL_CASES: UrlCase[] = [
  { input: `https://www.moxfield.com/decks/${MOX_ID}`, site: 'moxfield', id: MOX_ID },
  { input: `https://moxfield.com/decks/${MOX_ID}`, site: 'moxfield', id: MOX_ID },
  { input: `moxfield.com/decks/${MOX_ID}`, site: 'moxfield', id: MOX_ID },
  { input: `http://www.moxfield.com/decks/${MOX_ID}/primer`, site: 'moxfield', id: MOX_ID },
  { input: `https://www.moxfield.com/decks/${MOX_ID}?utm_source=share`, site: 'moxfield', id: MOX_ID },
  { input: `https://www.moxfield.com/decks/${MOX_ID}#comments`, site: 'moxfield', id: MOX_ID },
  { input: 'https://archidekt.com/decks/1/fun_with_fungus', site: 'archidekt', id: '1' },
  { input: 'https://www.archidekt.com/decks/123456', site: 'archidekt', id: '123456' },
  { input: 'archidekt.com/decks/123456', site: 'archidekt', id: '123456' },
  { input: 'archidekt.com/decks/123456/some-slug?tab=cards#top', site: 'archidekt', id: '123456' },
  { input: '  https://archidekt.com/decks/1/fun_with_fungus  ', site: 'archidekt', id: '1' },
  { input: 'https://archidekt.com/api/decks/1/', site: 'archidekt', id: '1' },
  // Rejects.
  { input: 'https://scryfall.com/card/tsp/227/thelon-of-havenwood', site: null },
  { input: 'https://www.moxfield.com/users/gategeek42', site: null },
  { input: '1 Sol Ring', site: null },
  { input: 'https://archidekt.com/decks/not-a-number', site: null },
];

function checkUrls(): string[] {
  const lines: string[] = [];
  for (const item of URL_CASES) {
    const ref = parseDeckUrl(item.input);
    if (item.site === null) {
      check(`rejects ${item.input}`, ref === null, `parsed as ${JSON.stringify(ref)}`);
      check(`isDeckUrl false for ${item.input}`, !isDeckUrl(item.input));
      lines.push(`reject  ${item.input}`);
      continue;
    }
    check(`parses ${item.input}`, ref !== null, 'returned null');
    if (!ref) continue;
    checkEqual(`${item.input}: site`, ref.site, item.site);
    checkEqual(`${item.input}: id`, ref.id, item.id);
    check(`isDeckUrl true for ${item.input}`, isDeckUrl(item.input));
    lines.push(`${ref.site.padEnd(9)} ${ref.id.padEnd(12)} ${ref.apiUrl}`);
  }

  // The canonical and API forms, once per site.
  const mox = parseDeckUrl(`moxfield.com/decks/${MOX_ID}`);
  checkEqual('moxfield canonicalUrl', mox?.canonicalUrl, `https://www.moxfield.com/decks/${MOX_ID}`);
  checkEqual('moxfield apiUrl', mox?.apiUrl, `https://api2.moxfield.com/v2/decks/all/${MOX_ID}`);
  const arch = parseDeckUrl('archidekt.com/decks/1/fun_with_fungus');
  checkEqual('archidekt canonicalUrl', arch?.canonicalUrl, 'https://archidekt.com/decks/1');
  checkEqual('archidekt apiUrl', arch?.apiUrl, 'https://archidekt.com/api/decks/1/');

  // A link with a list under it is a paste, not a link.
  check(
    'isDeckUrl false for a link followed by a list',
    !isDeckUrl('https://archidekt.com/decks/1\n1 Sol Ring'),
  );
  check('isDeckUrl false for empty text', !isDeckUrl('   '));

  return lines;
}

// ---------------------------------------------------------------------------
// B and C — Archidekt
// ---------------------------------------------------------------------------

const ARCH_REF = refFor('archidekt', '1');
const ARCH_JSON = fixture('archidekt-deck-1.json');

interface ArchidektDeck {
  categories: { id: number; name: string; isPremier: boolean; includedInDeck: boolean }[];
  cards: { quantity: unknown; categories: string[] | null; card: unknown }[];
}

function cloneArchidekt(): ArchidektDeck {
  return JSON.parse(JSON.stringify(ARCH_JSON)) as ArchidektDeck;
}

/** A fabricated row wearing a real row's shape, so only the field under test differs. */
function archidektRow(
  deck: ArchidektDeck,
  name: string,
  quantity: unknown,
  categories: string[] | null,
): ArchidektDeck['cards'][number] {
  const template = deck.cards[1]; // Mana Crypt, uncategorised in the real deck.
  return {
    ...(JSON.parse(JSON.stringify(template)) as ArchidektDeck['cards'][number]),
    quantity,
    categories,
    card: {
      ...(JSON.parse(JSON.stringify(template.card)) as Record<string, unknown>),
      oracleCard: { name },
    },
  };
}

/** The real fixture with a Maybeboard category and three fabricated rows. */
function archidektVariant(): unknown {
  const deck = cloneArchidekt();

  deck.categories.push(
    { id: 900001, name: 'Maybeboard', isPremier: false, includedInDeck: false },
    { id: 900002, name: 'Ramp', isPremier: false, includedInDeck: true },
  );

  // Only on the Maybeboard: gone. On the Maybeboard *and* in Ramp: kept, since
  // one included category is enough. And a second helping of a card the deck
  // already runs, which has to land on the same entry.
  deck.cards.push(
    archidektRow(deck, 'Sporecrown Thallid', 1, ['Maybeboard']),
    archidektRow(deck, 'Wayfarer’s Bauble', 1, ['Maybeboard', 'Ramp']),
    archidektRow(deck, 'Sporesower Thallid', 3, null),
  );

  return deck;
}

/**
 * The real fixture with three rows whose quantities are the interesting ones: a
 * new card the deck states 0 copies of, 0 more copies of a card it does run,
 * and a row that states no quantity at all.
 */
function archidektQuantities(): unknown {
  const deck = cloneArchidekt();
  deck.cards.push(
    archidektRow(deck, 'Thallid Omnivore', 0, null),
    archidektRow(deck, 'Mana Crypt', 0, null),
    archidektRow(deck, 'Thallid Soothsayer', undefined, null),
  );
  return deck;
}

function checkArchidekt(): string[] {
  const lines: string[] = [];
  const deck = normalizeArchidekt(ARCH_JSON, ARCH_REF);

  checkEqual('archidekt deck name', deck.name, 'Fun With Fungus');
  checkEqual('archidekt site', deck.site, 'archidekt');
  checkEqual('archidekt url', deck.url, 'https://archidekt.com/decks/1');
  checkEqual('archidekt entry count', deck.entries.length, 17);
  checkEqual('archidekt copies', copies(deck), 17);
  checkEqual('archidekt commander', commanders(deck), ['Thelon of Havenwood']);
  checkEqual('archidekt reads a clean deck with no warnings', deck.warnings, []);
  check(
    'archidekt keeps a double-faced name whole',
    names(deck).includes('Westvale Abbey // Ormendahl, Profane Prince'),
    names(deck).join(', '),
  );
  check('archidekt keeps an uncategorised card', names(deck).includes('Mana Crypt'));
  lines.push(`archidekt  "${deck.name}" — ${deck.entries.length} entries, ${copies(deck)} copies, commander ${commanders(deck).join(', ')}`);

  const variant = normalizeArchidekt(archidektVariant(), ARCH_REF);
  check(
    'a card only on the Maybeboard is excluded',
    !names(variant).includes('Sporecrown Thallid'),
    names(variant).join(', '),
  );
  check(
    'a card on the Maybeboard and in an included category is kept',
    names(variant).includes('Wayfarer’s Bauble'),
    names(variant).join(', '),
  );
  checkEqual('the variant adds one entry, not three', variant.entries.length, 18);
  const merged = variant.entries.find((e) => e.name === 'Sporesower Thallid');
  checkEqual('a repeated name merges into one entry', merged?.qty, 4);
  checkEqual(
    'the variant reports what it left behind',
    variant.warnings,
    ['Skipped 1 card in Maybeboard'],
  );
  lines.push(`  variant  ${variant.entries.length} entries — ${variant.warnings.join(' / ')}`);

  // A stated 0 is a card the deck does not run. It is skipped and counted, and
  // it never becomes the one copy a missing quantity falls back to.
  const quantities = normalizeArchidekt(archidektQuantities(), ARCH_REF);
  check(
    'a row stating 0 copies is not imported',
    !names(quantities).includes('Thallid Omnivore'),
    names(quantities).join(', '),
  );
  checkEqual(
    'a 0-copy row of a card the deck runs leaves that entry alone',
    quantities.entries.find((e) => e.name === 'Mana Crypt')?.qty,
    1,
  );
  checkEqual(
    'a row with no stated quantity still reads as one copy',
    quantities.entries.find((e) => e.name === 'Thallid Soothsayer')?.qty,
    1,
  );
  checkEqual('the 0-copy rows add no entries', quantities.entries.length, 18);
  checkEqual('the 0-copy rows add no copies', copies(quantities), 18);
  checkEqual('archidekt reports the 0-copy rows', quantities.warnings, [
    'Skipped 2 Archidekt rows listing 0 copies',
  ]);
  lines.push(`  quantities  ${quantities.entries.length} entries — ${quantities.warnings.join(' / ')}`);

  // Nonsense in, empty deck and a warning out; never a throw.
  const junk = normalizeArchidekt('not a deck', ARCH_REF);
  checkEqual('junk archidekt json yields no entries', junk.entries.length, 0);
  check('junk archidekt json warns', junk.warnings.length > 0, 'said nothing');

  return lines;
}

// ---------------------------------------------------------------------------
// D — Moxfield
// ---------------------------------------------------------------------------

const MOX_REF = refFor('moxfield', MOX_ID);

/**
 * Both fixtures describe the same deck, so both shapes have to produce the same
 * entries: commander, companion, and a mainboard of five, with the sideboard,
 * the maybeboard and (in v3) the tokens left out.
 */
const MOX_EXPECTED = [
  { name: 'Thelon of Havenwood', qty: 1, isCommander: true },
  { name: 'Lurrus of the Dream-Den', qty: 1, isCommander: false },
  { name: 'Sol Ring', qty: 1, isCommander: false },
  { name: 'Deathspore Thallid', qty: 1, isCommander: false },
  { name: 'Sporesower Thallid', qty: 2, isCommander: false },
  { name: 'Forest', qty: 12, isCommander: false },
  { name: 'Westvale Abbey // Ormendahl, Profane Prince', qty: 1, isCommander: false },
];

function checkMoxfield(): { lines: string[]; v3: FetchedDeck } {
  const lines: string[] = [];
  const v2 = normalizeMoxfield(fixture('moxfield-deck-v2.json'), MOX_REF);
  const v3 = normalizeMoxfield(fixture('moxfield-deck-v3.json'), MOX_REF);

  for (const [shape, deck] of [
    ['v2', v2],
    ['v3', v3],
  ] as const) {
    checkEqual(`moxfield ${shape} deck name`, deck.name, 'Thelon Spore Engine');
    checkEqual(`moxfield ${shape} entries`, deck.entries, MOX_EXPECTED);
    checkEqual(`moxfield ${shape} commander`, commanders(deck), ['Thelon of Havenwood']);
    checkEqual(`moxfield ${shape} copies`, copies(deck), 19);
    check(
      `moxfield ${shape} leaves the sideboard out`,
      !names(deck).includes('Pithing Needle'),
      names(deck).join(', '),
    );
    check(
      `moxfield ${shape} leaves the maybeboard out`,
      !names(deck).includes('Doubling Season'),
      names(deck).join(', '),
    );
    check(`moxfield ${shape} says what it skipped`, deck.warnings.length === 1, deck.warnings.join(' / '));
    lines.push(`moxfield ${shape}  ${deck.entries.length} entries, ${copies(deck)} copies — ${deck.warnings.join(' / ')}`);
  }

  check(
    'v3 does not import an opaque board key as a card',
    !names(v3).some((n) => /^[0-9a-f]{12,}$/i.test(n)),
    names(v3).join(', '),
  );
  checkEqual('both moxfield shapes read the same deck', v2.entries, v3.entries);

  const junk = normalizeMoxfield({ name: 'Empty' }, MOX_REF);
  checkEqual('an empty moxfield deck yields no entries', junk.entries.length, 0);
  check('an empty moxfield deck warns', junk.warnings.length > 0, 'said nothing');

  return { lines, v3 };
}

/**
 * The two things a reader written from documentation rather than from a capture
 * has to do: say so when a response carries a board it has never heard of, and
 * treat a stated 0 as a card the deck does not run.
 */
interface MoxRow {
  quantity?: unknown;
  card?: { name?: string };
}
interface MoxV3 {
  name: string;
  boards: Record<string, { count?: number; cards: Record<string, MoxRow> }>;
}

function checkMoxfieldQuirks(): string[] {
  const lines: string[] = [];

  const extra = fixture('moxfield-deck-v3.json') as MoxV3;
  extra.boards.signatureSpells = {
    count: 1,
    cards: { f01223344556677889900aab: { quantity: 1, card: { name: 'Sword of Feast and Famine' } } },
  };
  const withExtra = normalizeMoxfield(extra, MOX_REF);
  check(
    'an unknown v3 board is named in the warnings',
    withExtra.warnings.includes('Ignored Moxfield board: signatureSpells'),
    withExtra.warnings.join(' / '),
  );
  check(
    'an unknown board is not imported',
    !names(withExtra).includes('Sword of Feast and Famine'),
    names(withExtra).join(', '),
  );
  lines.push(`v3 + unknown board  ${withExtra.warnings.join(' / ')}`);

  // v2 hangs the boards off the deck beside its metadata, so a key alone cannot
  // be the test: a board is named, the user record next to it is not.
  const v2 = fixture('moxfield-deck-v2.json') as Record<string, unknown>;
  v2.signatureSpells = { 'Ancestral Recall': { quantity: 1, card: { name: 'Ancestral Recall' } } };
  v2.createdByUser = { userName: 'gategeek42', profileImageUrl: 'https://example.invalid/a.png' };
  const v2Extra = normalizeMoxfield(v2, MOX_REF);
  check(
    'an unknown v2 board is named in the warnings',
    v2Extra.warnings.includes('Ignored Moxfield board: signatureSpells'),
    v2Extra.warnings.join(' / '),
  );
  check(
    'deck metadata beside the boards is not called a board',
    !v2Extra.warnings.some((w) => w.includes('createdByUser')),
    v2Extra.warnings.join(' / '),
  );
  checkEqual('the v2 deck gains exactly one warning', v2Extra.warnings.length, 2);
  lines.push(`v2 + unknown board  ${v2Extra.warnings.join(' / ')}`);

  // A stated 0 is skipped and counted; it never lands as the one copy a missing
  // quantity falls back to.
  const zero = fixture('moxfield-deck-v3.json') as MoxV3;
  const rows = zero.boards.mainboard.cards;
  const solRing = Object.keys(rows).find((key) => rows[key].card?.name === 'Sol Ring') ?? '';
  rows[solRing].quantity = 0;
  const missing = Object.keys(rows).find((key) => rows[key].card?.name === 'Forest') ?? '';
  delete rows[missing].quantity;
  const zeroDeck = normalizeMoxfield(zero, MOX_REF);
  check(
    'a moxfield row stating 0 copies is not imported',
    !names(zeroDeck).includes('Sol Ring'),
    names(zeroDeck).join(', '),
  );
  checkEqual(
    'a moxfield row with no stated quantity reads as one copy',
    zeroDeck.entries.find((e) => e.name === 'Forest')?.qty,
    1,
  );
  checkEqual('the 0-copy row is one entry fewer', zeroDeck.entries.length, 6);
  check(
    'moxfield reports the 0-copy row',
    zeroDeck.warnings.includes('Skipped 1 Moxfield row listing 0 copies'),
    zeroDeck.warnings.join(' / '),
  );
  lines.push(`v3 + 0-copy row     ${zeroDeck.entries.length} entries — ${zeroDeck.warnings.join(' / ')}`);

  return lines;
}

// ---------------------------------------------------------------------------
// E — back through the parser
// ---------------------------------------------------------------------------

function checkRoundTrip(decks: { label: string; deck: FetchedDeck }[]): string[] {
  const lines: string[] = [];
  for (const { label, deck } of decks) {
    const text = toDecklistText(deck);
    const parsed = parseDecklist(text);
    checkEqual(`${label}: toDecklistText round-trips through parseDecklist`, parsed.entries, deck.entries);
    checkEqual(`${label}: the round trip loses nothing`, parsed.warnings, []);
    check(`${label}: the text opens with a Commander section`, text.startsWith('Commander\n'), text.slice(0, 40));
    check(`${label}: the text carries a Deck section`, text.includes('\nDeck\n'), text.slice(0, 80));
    lines.push(`${label}  ${text.split('\n').length} lines, ${parsed.entries.length} entries back`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// F — the sentences
// ---------------------------------------------------------------------------

/**
 * Status alone no longer says which failure it was: nothing answering means one
 * thing on a build that was never given a fetcher and another on a build whose
 * fetcher is down, and a 501 is either "no reader for this site" or a routing
 * error from the fetcher itself. Each pair is stated here with the code that
 * separates it.
 */
interface SentenceCase {
  status: number | null;
  code?: string;
  label: string;
}

const SENTENCE_CASES: SentenceCase[] = [
  { status: null, code: NO_DECK_FETCHER_CODE, label: 'no fetcher on this build' },
  { status: null, label: 'a configured fetcher that did not answer' },
  { status: 400, label: 'not a deck link' },
  { status: 404, label: 'private or gone' },
  { status: 429, label: 'rate limited' },
  { status: 501, code: 'no_fetcher', label: 'fetcher cannot read this site' },
  { status: 501, code: 'bad_route', label: 'fetcher answered a routing error' },
  { status: 502, label: 'upstream refused or unreachable' },
  { status: 500, label: 'anything else' },
];

function checkSentences(): string[] {
  const lines: string[] = [];
  for (const site of ['moxfield', 'archidekt'] as DeckSite[]) {
    const seen = new Map<string, string[]>();
    for (const item of SENTENCE_CASES) {
      const sentence = describeDeckFetchError(site, item.status, item.code ?? null);
      check(`${site} ${item.label}: says something`, sentence.length > 20, sentence);
      check(`${site} ${item.label}: ends in a full stop`, sentence.trim().endsWith('.'), sentence);
      seen.set(sentence, [...(seen.get(sentence) ?? []), item.label]);
      lines.push(`${site.padEnd(9)} ${String(item.status).padStart(4)} ${(item.code ?? '—').padEnd(11)} ${sentence}`);
    }
    // Two pairs read the same, and only those two: a build with no fetcher and a
    // fetcher with no reader are both "export the list instead", while a fetcher
    // that did not answer and one that answered a routing error are both "the
    // fetcher could not be reached".
    const shared = [...seen.values()].filter((group) => group.length > 1);
    checkEqual(`${site}: exactly two pairs share a sentence`, shared, [
      ['no fetcher on this build', 'fetcher cannot read this site'],
      ['a configured fetcher that did not answer', 'fetcher answered a routing error'],
    ]);
  }

  check(
    'the 502 sentences differ by site',
    describeDeckFetchError('moxfield', 502) !== describeDeckFetchError('archidekt', 502),
  );
  check(
    'the moxfield 502 names the user-agent block',
    describeDeckFetchError('moxfield', 502).includes('user agent'),
  );
  check(
    'the no-fetcher sentence tells the player to export',
    describeDeckFetchError('archidekt', null, NO_DECK_FETCHER_CODE).includes('Export'),
  );
  check(
    'the unreachable sentence blames the fetcher, not the deck',
    describeDeckFetchError('archidekt', null).includes('fetcher'),
    describeDeckFetchError('archidekt', null),
  );
  check(
    'a routing error is not reported as a missing deck',
    describeDeckFetchError('archidekt', 501, 'bad_route') !==
      describeDeckFetchError('archidekt', 404),
  );
  checkEqual(
    'a 404 reads the same on both sites',
    describeDeckFetchError('moxfield', 404),
    describeDeckFetchError('archidekt', 404),
  );

  return lines;
}

// ---------------------------------------------------------------------------

function main(): void {
  const urlLines = checkUrls();
  const archLines = checkArchidekt();
  const { lines: moxLines, v3 } = checkMoxfield();
  const quirkLines = checkMoxfieldQuirks();
  const tripLines = checkRoundTrip([
    { label: 'archidekt', deck: normalizeArchidekt(ARCH_JSON, ARCH_REF) },
    { label: 'moxfield ', deck: v3 },
  ]);
  const sentenceLines = checkSentences();

  console.log('\nverify:deck-url');
  console.log('─'.repeat(76));
  console.log('links');
  for (const line of urlLines) console.log(`  ${line}`);
  console.log('─'.repeat(76));
  console.log('normalised');
  for (const line of [...archLines, ...moxLines, ...quirkLines]) console.log(`  ${line}`);
  console.log('─'.repeat(76));
  console.log('round trip');
  for (const line of tripLines) console.log(`  ${line}`);
  console.log('─'.repeat(76));
  console.log('sentences');
  for (const line of sentenceLines) console.log(`  ${line}`);
  console.log('─'.repeat(76));

  if (failures.length > 0) {
    console.log(`${failures.length} of ${checked} check(s) FAILED:`);
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    throw new Error(`${failures.length} deck-url check(s) failed`);
  }
  console.log(`all ${checked} checks passed`);
}

main();
