/**
 * Verification harness for token faces: the Scryfall search a `TokenSpec` turns
 * into, and the entry a response hands back.
 *
 * A token is not a card the app caches — it has no `CardData`, no oracle text
 * and no Dexie row — so the only thing standing between a preset button and a
 * real printed face is the query string. That is what these checks read:
 *
 *   A — `tokenSearchQuery` over the six token-bar presets and two custom specs.
 *       Every query is `t:token` plus the terms the spec justifies: the name in
 *       quotes, `pow=`/`tou=` only for a spec with a body, a single `c:` term
 *       only for a spec that names colours (the artifact presets carry
 *       `colors: []` and must add nothing), and `o:` for a preset whose name
 *       carries a parenthetical ability, which Scryfall has no card named after.
 *   B — `pickTokenFace` over hand-made response bodies: the first entry with an
 *       image wins, an entry with only a front-face image is read through it,
 *       a body of nothing but imageless entries is a miss, and a malformed body
 *       is a miss rather than a throw.
 *   C — LIVE=1 only: one real search for the 2/2 black Zombie, which must come
 *       back with a Scryfall id and a normal image URL.
 *
 *   npx tsx scripts/verify-token-face.ts
 *   LIVE=1 npx tsx scripts/verify-token-face.ts
 *
 * The presets are transcribed from `src/features/hud/components/TokenBar.tsx`
 * rather than imported: the bar is a React component wired to the store, and
 * this script is about the strings, not the button.
 *
 * Failures are collected rather than thrown one at a time, so a bad run reports
 * everything wrong in a single pass. The process exits non-zero if any failed.
 */
import type { TokenSpec } from '../src/domain/types.ts';
import { findTokenFace, pickTokenFace, tokenSearchQuery } from '../src/services/scryfall.ts';

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

// ---------------------------------------------------------------------------
// A — the query a spec becomes
// ---------------------------------------------------------------------------

interface QueryCase {
  label: string;
  spec: TokenSpec;
  /** Terms the query must carry, in order. */
  has: string[];
  /** Terms the query must not carry at all. */
  hasNot?: string[];
}

const QUERY_CASES: QueryCase[] = [
  {
    label: 'Treasure',
    spec: { name: 'Treasure', colors: [], typeLine: 'Token Artifact — Treasure' },
    has: ['t:token', 'name:"Treasure"'],
    hasNot: ['pow=', 'tou=', 'c:', 'o:'],
  },
  {
    label: 'Clue',
    spec: { name: 'Clue', colors: [], typeLine: 'Token Artifact — Clue' },
    has: ['t:token', 'name:"Clue"'],
    hasNot: ['pow=', 'tou=', 'c:', 'o:'],
  },
  {
    label: 'Food',
    spec: { name: 'Food', colors: [], typeLine: 'Token Artifact — Food' },
    has: ['t:token', 'name:"Food"'],
    hasNot: ['pow=', 'tou=', 'c:', 'o:'],
  },
  {
    label: '1/1 Soldier',
    spec: {
      name: 'Soldier',
      power: '1',
      toughness: '1',
      colors: ['W'],
      typeLine: 'Token Creature — Soldier',
    },
    has: ['t:token', 'name:"Soldier"', 'pow=1', 'tou=1', 'c:w'],
    hasNot: ['o:'],
  },
  {
    label: '1/1 Spirit (flying)',
    spec: {
      name: 'Spirit (flying)',
      power: '1',
      toughness: '1',
      colors: ['W'],
      typeLine: 'Token Creature — Spirit',
    },
    has: ['t:token', 'name:"Spirit"', 'pow=1', 'tou=1', 'c:w', 'o:flying'],
    hasNot: ['(flying)'],
  },
  {
    label: '2/2 Zombie',
    spec: {
      name: 'Zombie',
      power: '2',
      toughness: '2',
      colors: ['B'],
      typeLine: 'Token Creature — Zombie',
    },
    has: ['t:token', 'name:"Zombie"', 'pow=2', 'tou=2', 'c:b'],
    hasNot: ['o:'],
  },
  // The custom form: a name and a body, no colours at all.
  {
    label: 'custom 3/3 Beast',
    spec: { name: 'Beast', power: '3', toughness: '3', typeLine: 'Token Creature — Beast' },
    has: ['t:token', 'name:"Beast"', 'pow=3', 'tou=3'],
    hasNot: ['c:', 'o:'],
  },
  // The custom form with no body at all: name only.
  {
    label: 'custom bodyless',
    spec: { name: 'Emblem', typeLine: 'Token' },
    has: ['t:token', 'name:"Emblem"'],
    hasNot: ['pow=', 'tou=', 'c:', 'o:'],
  },
];

/** A colourless spec that does name a colour: `c:c`, not a dropped term. */
const COLORLESS_SPEC: TokenSpec = {
  name: 'Eldrazi Scion',
  power: '1',
  toughness: '1',
  colors: ['C'],
  typeLine: 'Token Creature — Eldrazi Scion',
};

function checkQueries(): string[] {
  const lines: string[] = [];

  for (const c of QUERY_CASES) {
    const q = tokenSearchQuery(c.spec);
    for (const term of c.has) {
      check(`${c.label}: has ${term}`, q.includes(term), q);
    }
    for (const term of c.hasNot ?? []) {
      check(`${c.label}: no ${term}`, !q.includes(term), q);
    }
    // Ordering is not incidental: the terms read the way a player would write
    // the search, and a reordering would be a silent change to every query.
    const expected = [...c.has].join(' ');
    if (c.has.length > 1) checkEqual(`${c.label}: whole query`, q, expected);
    lines.push(`${c.label.padEnd(20)} ${q}`);
  }

  const colorless = tokenSearchQuery(COLORLESS_SPEC);
  checkEqual('colourless: whole query', colorless, 't:token name:"Eldrazi Scion" pow=1 tou=1 c:c');
  lines.push(`${'colourless'.padEnd(20)} ${colorless}`);

  // A quote in a custom name would end the `name:` term early.
  const quoted = tokenSearchQuery({ name: 'The "Real" Beast' });
  check('a quoted name cannot break out of name:', !quoted.includes('"Real"'), quoted);
  checkEqual('a quoted name is scrubbed', quoted, 't:token name:"The Real Beast"');
  lines.push(`${'quoted name'.padEnd(20)} ${quoted}`);

  return lines;
}

// ---------------------------------------------------------------------------
// B — the entry a response hands back
// ---------------------------------------------------------------------------

const IMG = 'https://cards.scryfall.io/normal/front/a/b/abc.jpg';
const IMG2 = 'https://cards.scryfall.io/normal/front/c/d/cde.jpg';

function checkPicker(): string[] {
  const lines: string[] = [];

  const firstWithImage = pickTokenFace({
    data: [
      { id: 'no-image', name: 'Zombie' },
      { id: 'has-image', name: 'Zombie', image_uris: { normal: IMG } },
      { id: 'later', name: 'Zombie', image_uris: { normal: IMG2 } },
    ],
  });
  checkEqual('first entry with an image wins', firstWithImage, {
    scryfallId: 'has-image',
    imageNormal: IMG,
  });
  lines.push(`three entries, first imageless → ${firstWithImage?.scryfallId}`);

  const frontFace = pickTokenFace({
    data: [{ id: 'dfc', name: 'Token // Token', card_faces: [{ image_uris: { normal: IMG } }] }],
  });
  checkEqual('a face-only printing is read through its front face', frontFace, {
    scryfallId: 'dfc',
    imageNormal: IMG,
  });
  lines.push(`front-face image only  → ${frontFace?.scryfallId}`);

  checkEqual(
    'nothing with an image is a miss',
    pickTokenFace({ data: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }),
    null,
  );
  checkEqual('an empty list is a miss', pickTokenFace({ data: [] }), null);
  checkEqual('a body with no data is a miss', pickTokenFace({ object: 'error' }), null);
  checkEqual('null is a miss', pickTokenFace(null), null);
  checkEqual('an entry with no id is skipped', pickTokenFace({ data: [{ image_uris: { normal: IMG } }] }), null);
  lines.push('imageless list, empty list, error body, null, id-less entry → null');

  return lines;
}

// ---------------------------------------------------------------------------
// C — one live search, opt-in
// ---------------------------------------------------------------------------

async function checkLive(): Promise<string[]> {
  const spec: TokenSpec = {
    name: 'Zombie',
    power: '2',
    toughness: '2',
    colors: ['B'],
    typeLine: 'Token Creature — Zombie',
  };
  const face = await findTokenFace(spec);
  check('live zombie: found a face', face !== null, 'got null');
  if (!face) return ['live  2/2 Zombie FAILED — no face came back'];
  check('live zombie: has an id', face.scryfallId.length > 0, face.scryfallId);
  check(
    'live zombie: image is a Scryfall card image',
    face.imageNormal.startsWith('https://cards.scryfall.io/'),
    face.imageNormal,
  );
  // The second call must not reach the network at all.
  const again = await findTokenFace(spec);
  checkEqual('live zombie: cached on the second call', again, face);
  return [`live  2/2 Zombie → ${face.scryfallId}`, `      ${face.imageNormal}`];
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const queryLines = checkQueries();
  const pickerLines = checkPicker();
  const liveLines = process.env.LIVE === '1' ? await checkLive() : [];

  console.log('\nverify:token-face');
  console.log('─'.repeat(76));
  console.log('queries');
  for (const line of queryLines) console.log(`  ${line}`);
  console.log('─'.repeat(76));
  console.log('picker');
  for (const line of pickerLines) console.log(`  ${line}`);
  console.log('─'.repeat(76));
  if (liveLines.length > 0) {
    console.log('live (LIVE=1)');
    for (const line of liveLines) console.log(`  ${line}`);
  } else {
    console.log('live  skipped — set LIVE=1 to search Scryfall for the 2/2 Zombie for real');
  }
  console.log('─'.repeat(76));

  if (failures.length > 0) {
    console.log(`${failures.length} of ${checked} check(s) FAILED:`);
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    throw new Error(`${failures.length} token-face check(s) failed`);
  }
  console.log(`all ${checked} checks passed`);
}

await main();
