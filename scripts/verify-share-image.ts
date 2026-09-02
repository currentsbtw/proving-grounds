/**
 * Verification harness for the shareable scorecard PNG.
 *
 * `renderScorecardPng` is pure drawing code, and drawing code is exactly the
 * kind of thing that "compiles" forever while quietly putting the deck name off
 * the right-hand edge. Node has no canvas, so this script supplies one: a
 * recording stub whose every method is a no-op that remembers it was called, and
 * whose `convertToBlob` hands back an empty PNG blob. Nothing is rasterised —
 * what is checked is the *instruction stream*: what text was drawn, at what
 * coordinate, in what font, and how many marks the chart put on the page.
 *
 *   npx tsx scripts/verify-share-image.ts [seed]
 *
 * The scorecard it draws is a real one. The store is driven headlessly through a
 * scripted game exactly the way `scripts/verify-scorecard.ts` does it (that
 * script exports nothing, so the minimal deck-and-game part is reproduced here
 * rather than imported), and the log that game produces is scored by the real
 * scoring engine. A synthetic scorecard would prove the renderer survives the
 * shape of the type; this proves it survives a game.
 *
 * Failures are collected rather than thrown one at a time, so a bad run reports
 * everything wrong in one pass. The process exits non-zero if any check failed.
 */
import { cardsInZone, isLandCard, manaValueOf, useGameStore } from '../src/state/gameStore.ts';
import { scoreRun } from '../src/engine/scorecard.ts';
import type { Scorecard } from '../src/engine/scorecard.ts';
import {
  renderScorecardPng,
  SHARE_IMAGE_HEIGHT,
  SHARE_IMAGE_WIDTH,
} from '../src/features/scorecard/shareImage.ts';
import type { CardData, Deck, RunRecord } from '../src/domain/types.ts';

const SEED = process.argv[2] ?? 'scorecard-verify';
const TURNS = 10;
const BRACKET = 4;
const DECK_NAME = 'Scorecard Verification';

/** The renderer's own device scale — the stub asserts against backing pixels. */
const DEVICE_SCALE = 2;

// ---------------------------------------------------------------------------
// A synthetic 99 + 1 deck (the minimum from verify-scorecard.ts)
// ---------------------------------------------------------------------------

function card(scryfallId: string, name: string, manaValue: number, typeLine: string): CardData {
  return {
    scryfallId,
    name,
    manaCost: manaValue > 0 ? `{${manaValue}}` : '',
    manaValue,
    typeLine,
    oracleText: '',
    colorIdentity: ['G'],
    layout: 'normal',
  };
}

const COMMANDER = card('cmd-warlord', 'Proving Ground Warlord', 5, 'Legendary Creature — Human Warrior');

const DECK_CARDS: { data: CardData; qty: number }[] = [
  { data: card('land-forest', 'Training Forest', 0, 'Basic Land — Forest'), qty: 14 },
  { data: card('land-plain', 'Training Plain', 0, 'Basic Land — Plains'), qty: 12 },
  { data: card('land-gate', 'Proving Gate', 0, 'Land'), qty: 10 },
  { data: card('cr-scout', 'Grounds Scout', 1, 'Creature — Human Scout'), qty: 9 },
  { data: card('cr-warden', 'Grounds Warden', 2, 'Creature — Human Soldier'), qty: 9 },
  { data: card('cr-ranger', 'Grounds Ranger', 3, 'Creature — Elf Ranger'), qty: 9 },
  { data: card('cr-sentinel', 'Grounds Sentinel', 4, 'Creature — Giant Soldier'), qty: 8 },
  { data: card('cr-behemoth', 'Grounds Behemoth', 5, 'Creature — Beast'), qty: 6 },
  { data: card('cr-colossus', 'Grounds Colossus', 6, 'Creature — Golem'), qty: 6 },
  { data: card('cr-titan', 'Grounds Titan', 7, 'Creature — Giant'), qty: 4 },
  { data: card('art-signet', 'Grounds Signet', 2, 'Artifact'), qty: 6 },
  { data: card('art-altar', 'Grounds Altar', 3, 'Artifact'), qty: 6 },
];

const CARD_DATA: Record<string, CardData> = { [COMMANDER.scryfallId]: COMMANDER };
for (const { data } of DECK_CARDS) CARD_DATA[data.scryfallId] = data;

const DECK: Deck = {
  id: 'verify-deck',
  name: DECK_NAME,
  commanderIds: [COMMANDER.scryfallId],
  cards: DECK_CARDS.map(({ data, qty }) => ({ scryfallId: data.scryfallId, qty })),
  bracket: BRACKET as Deck['bracket'],
  createdAt: 0,
  updatedAt: 0,
};

// ---------------------------------------------------------------------------
// The scripted game
// ---------------------------------------------------------------------------

const store = () => useGameStore.getState();

let capturedRun: RunRecord | null = null;
useGameStore.subscribe((state) => {
  if (state.run) capturedRun = state.run;
});

/**
 * Read the capture through a call. The subscription assigns to it from inside a
 * closure, which the compiler's flow analysis cannot see, so a direct read
 * narrows to `null` and every use of it looks unreachable.
 */
function lastCapturedRun(): RunRecord | null {
  return capturedRun;
}

/**
 * `endRun` persists through Dexie, which has no IndexedDB to talk to in Node.
 * The store catches the failure and the log entry that matters is appended
 * first; this only keeps the expected complaint from burying the output.
 */
const passthroughError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('Failed to persist run')) return;
  passthroughError(...args);
};

/** Answer the first wrath, eat the rest. Enough to put both kinds on the card. */
function drainEvents(state: { wipesSeen: number }): void {
  for (let guard = 0; guard < 50; guard++) {
    const event = store().activeEvent;
    if (!event) return;
    if (event.type === 'wipe') {
      state.wipesSeen += 1;
      if (state.wipesSeen === 1) store().respondToActiveEvent('held a counterspell');
      else store().resolveActiveEvent();
      continue;
    }
    store().resolveActiveEvent();
  }
  throw new Error('drainEvents did not converge');
}

function playScriptedRun(seed: string): RunRecord {
  capturedRun = null;
  const policy = { wipesSeen: 0 };

  store().startRun(DECK, CARD_DATA, seed);
  store().resolveMulligan([]);

  for (let turn = 1; turn <= TURNS; turn++) {
    if (!store().run) break;
    drainEvents(policy);
    if (store().clock) {
      store().declareInteraction();
      drainEvents(policy);
    }
    if (turn > 1) store().drawCards(3);

    const land = cardsInZone(store(), 'hand').find((c) => isLandCard(store(), c));
    if (land) store().moveCard(land.iid, 'battlefield');

    for (let i = 0; i < 2; i++) {
      const state = store();
      const spells = cardsInZone(state, 'hand')
        .filter((c) => !isLandCard(state, c))
        .sort((a, b) => manaValueOf(state, b) - manaValueOf(state, a));
      if (spells.length === 0) break;
      store().moveCard(spells[0].iid, 'battlefield');
      drainEvents(policy);
    }

    if (turn >= 4) {
      const commander = cardsInZone(store(), 'command').find((c) => c.isCommander);
      if (commander) {
        store().castCommander(commander.iid);
        drainEvents(policy);
      }
    }
    if (turn >= 6) store().adjustLife('A', -9);
    if (turn >= 7) store().dealCommanderDamage('B', 4);

    drainEvents(policy);
    if (turn < TURNS && store().run) store().nextTurn();
  }

  void store().endRun('win');
  const finished = lastCapturedRun();
  if (!finished) throw new Error('no run was captured off the store subscription');
  return { ...finished, endedAt: Date.now(), result: 'win' };
}

// ---------------------------------------------------------------------------
// The recording canvas
// ---------------------------------------------------------------------------

interface DrawnText {
  text: string;
  /** Coordinates as the renderer passed them (its own logical space). */
  x: number;
  y: number;
  /** The same point in backing-store pixels, after the recorded transform. */
  backingX: number;
  backingY: number;
  font: string;
  align: string;
  tracking: number;
  method: 'fillText' | 'strokeText';
}

interface Shape {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface Recording {
  calls: string[];
  texts: DrawnText[];
  filled: Shape[];
  stroked: Shape[];
  blobs: number;
}

/** Rough but font-size-aware, so truncation and overflow are actually exercised. */
const CHAR_WIDTH_RATIO = 0.55;

function fontSizeOf(font: string): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(font);
  return match ? Number(match[1]) : 10;
}

function trackingOf(letterSpacing: string): number {
  const match = /(-?\d+(?:\.\d+)?)px/.exec(letterSpacing);
  return match ? Number(match[1]) : 0;
}

/**
 * A 2D context that draws nothing. Every method is a no-op that records its
 * name; the handful that the renderer reads back from (`measureText`) or that
 * change coordinates (`scale`, `translate`, `save`, `restore`) are the only ones
 * with behaviour, and path calls accumulate a bounding box so a `fill()` can be
 * recognised as a bar without the stub knowing what a bar is.
 */
function createRecordingContext(recording: Recording): unknown {
  const props: Record<string, unknown> = {
    font: '10px sans-serif',
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    textAlign: 'start',
    textBaseline: 'alphabetic',
    letterSpacing: '0px',
  };

  let transform = { sx: 1, sy: 1, tx: 0, ty: 0 };
  const stack: (typeof transform)[] = [];
  let points: [number, number][] = [];

  const push = (x: number, y: number): void => {
    if (Number.isFinite(x) && Number.isFinite(y)) points.push([x, y]);
  };

  const bounds = (): Shape | null => {
    if (points.length === 0) return null;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    return {
      left: Math.min(...xs),
      right: Math.max(...xs),
      top: Math.min(...ys),
      bottom: Math.max(...ys),
    };
  };

  const drawText = (method: 'fillText' | 'strokeText', value: unknown, x: number, y: number): void => {
    recording.texts.push({
      text: String(value),
      x,
      y,
      backingX: transform.tx + x * transform.sx,
      backingY: transform.ty + y * transform.sy,
      font: String(props.font),
      align: String(props.textAlign),
      tracking: trackingOf(String(props.letterSpacing)),
      method,
    });
  };

  const handlers: Record<string, (...args: never[]) => unknown> = {
    save: () => {
      stack.push({ ...transform });
    },
    restore: () => {
      transform = stack.pop() ?? transform;
    },
    scale: ((sx: number, sy: number) => {
      transform = { ...transform, sx: transform.sx * sx, sy: transform.sy * sy };
    }) as (...args: never[]) => unknown,
    translate: ((tx: number, ty: number) => {
      transform = {
        ...transform,
        tx: transform.tx + tx * transform.sx,
        ty: transform.ty + ty * transform.sy,
      };
    }) as (...args: never[]) => unknown,
    beginPath: () => {
      points = [];
    },
    moveTo: ((x: number, y: number) => push(x, y)) as (...args: never[]) => unknown,
    lineTo: ((x: number, y: number) => push(x, y)) as (...args: never[]) => unknown,
    quadraticCurveTo: ((cx: number, cy: number, x: number, y: number) => {
      push(cx, cy);
      push(x, y);
    }) as (...args: never[]) => unknown,
    arc: ((x: number, y: number, r: number) => {
      push(x - r, y - r);
      push(x + r, y + r);
    }) as (...args: never[]) => unknown,
    closePath: () => undefined,
    fill: () => {
      const shape = bounds();
      if (shape) recording.filled.push(shape);
    },
    stroke: () => {
      const shape = bounds();
      if (shape) recording.stroked.push(shape);
    },
    fillRect: ((x: number, y: number, w: number, h: number) => {
      recording.filled.push({ left: x, right: x + w, top: y, bottom: y + h });
    }) as (...args: never[]) => unknown,
    fillText: ((value: unknown, x: number, y: number) => drawText('fillText', value, x, y)) as (
      ...args: never[]
    ) => unknown,
    strokeText: ((value: unknown, x: number, y: number) => drawText('strokeText', value, x, y)) as (
      ...args: never[]
    ) => unknown,
    measureText: ((value: unknown) => {
      const size = fontSizeOf(String(props.font));
      return { width: String(value).length * size * CHAR_WIDTH_RATIO };
    }) as (...args: never[]) => unknown,
  };

  return new Proxy(
    {},
    {
      get(_target, key: string | symbol) {
        if (typeof key !== 'string') return undefined;
        if (key in handlers) {
          return (...args: unknown[]) => {
            recording.calls.push(key);
            return (handlers[key] as (...a: unknown[]) => unknown)(...args);
          };
        }
        if (key in props) return props[key];
        // Anything the renderer reaches for that is not modelled: a no-op that
        // still shows up in the call log.
        return (...args: unknown[]) => {
          recording.calls.push(`${key}(${args.length})`);
          return undefined;
        };
      },
      set(_target, key: string | symbol, value: unknown) {
        if (typeof key === 'string') props[key] = value;
        return true;
      },
    },
  );
}

/** Install the fake `OffscreenCanvas` and hand back what it recorded. */
function installCanvas(): Recording {
  const recording: Recording = { calls: [], texts: [], filled: [], stroked: [], blobs: 0 };

  class FakeOffscreenCanvas {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
    getContext(kind: string): unknown {
      return kind === '2d' ? createRecordingContext(recording) : null;
    }
    convertToBlob(): Promise<Blob> {
      recording.blobs += 1;
      return Promise.resolve(new Blob([], { type: 'image/png' }));
    }
  }

  (globalThis as Record<string, unknown>).OffscreenCanvas = FakeOffscreenCanvas;
  return recording;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const failures: string[] = [];

function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures.push(detail ? `${label} — ${detail}` : label);
}

/** The width the stub would have measured for a drawn run, tracking included. */
function widthOf(drawn: DrawnText): number {
  const size = fontSizeOf(drawn.font);
  return drawn.text.length * size * CHAR_WIDTH_RATIO + drawn.tracking * Math.max(0, drawn.text.length - 1);
}

/** Where a drawn run actually starts and ends, honouring `textAlign`. */
function extentOf(drawn: DrawnText): { left: number; right: number } {
  const width = widthOf(drawn);
  if (drawn.align === 'right' || drawn.align === 'end') return { left: drawn.x - width, right: drawn.x };
  if (drawn.align === 'center') return { left: drawn.x - width / 2, right: drawn.x + width / 2 };
  return { left: drawn.x, right: drawn.x + width };
}

/** A degenerate scorecard: no turns, no events, nothing to divide by. */
function emptyScorecard(): Scorecard {
  return {
    version: 1,
    runId: 'empty-run',
    deckId: 'empty-deck',
    deckName: '',
    seed: '',
    bracket: 1,
    pressureVersion: null,
    startedAt: 0,
    endedAt: null,
    result: null,
    turns: 0,
    partial: false,
    timeline: [],
    deployment: {
      firstCommanderCastTurn: null,
      cumulativeMv: [],
      avgMvPerTurn: 0,
      landsByTurn: [],
    },
    wipes: [],
    commander: {
      firstCastTurn: null,
      casts: 0,
      removals: 0,
      downtimeTurns: 0,
      totalTaxPaid: 0,
      counteredCasts: 0,
    },
    answers: {
      byType: {
        wipe: { offered: 0, responded: 0, resolved: 0, unresolved: 0 },
        removal: { offered: 0, responded: 0, resolved: 0, unresolved: 0 },
        counter: { offered: 0, responded: 0, resolved: 0, unresolved: 0 },
        combat: { offered: 0, responded: 0, resolved: 0, unresolved: 0 },
        clock: { offered: 0, responded: 0, resolved: 0, unresolved: 0 },
        resource: { offered: 0, responded: 0, resolved: 0, unresolved: 0 },
      },
      total: { offered: 0, responded: 0, resolved: 0, unresolved: 0 },
      rate: null,
    },
    seats: [
      { seatId: 'A', damageDealt: 0, commanderDamageDealt: 0, eliminatedTurn: null, eliminationReason: null },
      { seatId: 'B', damageDealt: 0, commanderDamageDealt: 0, eliminatedTurn: null, eliminationReason: null },
      { seatId: 'C', damageDealt: 0, commanderDamageDealt: 0, eliminatedTurn: null, eliminationReason: null },
    ],
    clock: { faced: false, spawnedTurn: null, deadlineTurn: null, outcome: null, beatClock: false },
    keep: { mulligans: 0, keptHandSize: 0, landsInKeptHand: 0, landsInOpeningSeven: 0 },
    events: [],
  };
}

/** Every drawn run stays inside the card, in backing pixels and in extent. */
function checkNoOverflow(prefix: string, recording: Recording): void {
  const maxX = SHARE_IMAGE_WIDTH * DEVICE_SCALE;
  const maxY = SHARE_IMAGE_HEIGHT * DEVICE_SCALE;
  const offPage = recording.texts.filter(
    (t) => t.backingX < 0 || t.backingY < 0 || t.backingX > maxX || t.backingY > maxY,
  );
  check(
    `${prefix}: every text anchor is inside the image`,
    offPage.length === 0,
    offPage.map((t) => `"${t.text}" at ${t.backingX}/${t.backingY} backing px`).join('; '),
  );

  // Anchors inside the frame are not enough — a long left-aligned run anchored
  // at x=56 can still run off the right edge. Measure the whole run.
  const RIGHT_EDGE = 1144;
  const LEFT_EDGE = 56;
  const spilling = recording.texts.filter((t) => {
    const { left, right } = extentOf(t);
    return right > RIGHT_EDGE + 2 || left < LEFT_EDGE - 2;
  });
  check(
    `${prefix}: no text run spills past the card's content edges`,
    spilling.length === 0,
    spilling
      .map((t) => `"${t.text}" spans ${extentOf(t).left.toFixed(0)}–${extentOf(t).right.toFixed(0)}`)
      .join('; '),
  );
}

async function main(): Promise<void> {
  const record = playScriptedRun(SEED);
  const scorecard = scoreRun(record);

  // --- the real scorecard ---------------------------------------------------
  const recording = installCanvas();
  const blob = await renderScorecardPng(scorecard, {
    profile: {
      deckId: scorecard.deckId,
      runs: 4,
      wins: 2,
      losses: 1,
      concedes: 1,
      winRate: 0.5,
      avgTurns: 10,
      avgFirstCommanderCast: 4,
      avgMvPerTurn: 4.2,
      wipesFaced: 3,
      avgTurnsToRecover: 2,
      unrecoveredWipeRate: 0.25,
      avgCommanderDowntime: 2,
      answerRate: 0.4,
      clocksFaced: 2,
      clocksBeaten: 1,
      mulliganRate: 0.25,
      avgLandsInKeep: 3,
      tags: ['fast', 'interactive', 'brittle to wraths'],
    },
  });

  check('a PNG blob comes back', blob instanceof Blob, `got ${typeof blob}`);
  check('the blob is a PNG', blob.type === 'image/png', blob.type);
  check('convertToBlob was called exactly once', recording.blobs === 1, `${recording.blobs}`);
  check('the renderer scaled for device pixels', recording.calls.includes('scale'));

  // --- the words that have to be on it --------------------------------------
  const drawn = recording.texts.map((t) => t.text);
  check('the deck name is drawn', drawn.includes(DECK_NAME), `drew: ${drawn.slice(0, 6).join(' | ')}`);
  check('the result word is drawn', drawn.includes('WIN'), `result was ${scorecard.result}`);
  check('the wordmark is drawn', drawn.includes('PROVING GROUNDS'));
  check(
    'the meta line names the bracket, seed and turn count',
    drawn.some((t) => t.includes(`Bracket ${BRACKET}`) && t.includes(SEED) && t.includes(`T${scorecard.turns}`)),
    drawn.find((t) => t.startsWith('Bracket')) ?? '(no meta line)',
  );
  check(
    'all six stat tiles are labelled',
    ['DEPLOY MV/TURN', 'WIPE RECOVERY', 'CMDR DOWNTIME', 'ANSWER RATE', 'DAMAGE DEALT', 'CLOCK'].every((l) =>
      drawn.includes(l),
    ),
  );
  check(
    'the full Fan Content line is drawn',
    drawn.some(
      (t) =>
        t.startsWith('Unofficial Fan Content permitted under the Wizards of the Coast') &&
        t.endsWith('Not approved or endorsed by Wizards.'),
    ),
    drawn.find((t) => t.startsWith('Unofficial')) ?? '(no legal line)',
  );
  check(
    'the profile tags are drawn as chips',
    ['fast', 'interactive'].every((tag) => drawn.includes(tag)),
  );

  // --- the type contract ----------------------------------------------------
  // OWN-WORLD: one grotesk for every word and every figure, and the display
  // face confined to the wordmark. The receipt is the only artefact that leaves
  // the app, so it is the one most able to stop looking like it.
  const displayRuns = recording.texts.filter((t) => /Marcellus|Georgia/.test(t.font));
  check(
    'the display face is used for the wordmark and nothing else',
    displayRuns.length === 1 && displayRuns[0].text === 'PROVING GROUNDS',
    displayRuns.map((t) => `"${t.text}" in ${t.font}`).join('; ') || '(no display run at all)',
  );
  const strayFonts = recording.texts.filter(
    (t) => !/IBM Plex Sans/.test(t.font) && !/Marcellus|Georgia/.test(t.font),
  );
  check(
    'every other run is set in the app grotesk',
    strayFonts.length === 0,
    strayFonts.map((t) => `"${t.text}" in ${t.font}`).join('; '),
  );
  check(
    'no run is set below 9px',
    recording.texts.every((t) => fontSizeOf(t.font) >= 9),
    recording.texts
      .filter((t) => fontSizeOf(t.font) < 9)
      .map((t) => `"${t.text}" at ${fontSizeOf(t.font)}px`)
      .join('; '),
  );

  // --- the chart ------------------------------------------------------------
  // A bar is a filled path sitting on the axis: bottom at the axis line, inside
  // the plot band, and narrow. The stub does not know what a bar is — only what
  // one looks like — so this catches a chart that silently drew nothing.
  const AXIS_Y = 486;
  const bars = recording.filled.filter(
    (s) => Math.abs(s.bottom - AXIS_Y) < 0.6 && s.top >= 328 && s.right - s.left <= 40 && s.left >= 56,
  );
  check(
    `the chart draws at least one bar per turn (${scorecard.turns})`,
    bars.length >= scorecard.turns,
    `${bars.length} bars for ${scorecard.turns} turns`,
  );
  check(
    'every bar sits inside the content width',
    bars.every((s) => s.left >= 55 && s.right <= 1145),
  );
  // Events are marked with the class letter, not a coloured dot: the receipt
  // goes to Discord, where hue is not a channel every reader has.
  const MARKS = new Set(['W', 'R', 'S', 'C', 'A', 'K']);
  const eventMarks = recording.texts.filter(
    (t) => MARKS.has(t.text) && t.y > 285 && t.y < 330 && t.align === 'center',
  );
  check(
    'events are marked above the columns by class letter',
    scorecard.events.length === 0 || eventMarks.length > 0,
    `${eventMarks.length} marks for ${scorecard.events.length} events`,
  );
  check(
    'the marker key names every class',
    ['wrath', 'removal', 'resource', 'counter', 'attack', 'clock'].every((w) => drawn.includes(w)),
    drawn.filter((t) => ['wrath', 'removal', 'clock'].includes(t)).join(', ') || '(no key drawn)',
  );
  check(
    'the turn axis is labelled',
    drawn.includes('1') && drawn.includes(String(scorecard.turns)),
  );

  checkNoOverflow('scored run', recording);

  // --- a deck name nobody should have typed ---------------------------------
  const longName = 'The Everlasting Provisional Grounds of the Interminably Verbose Brewmaster, Redux';
  const longRecording = installCanvas();
  await renderScorecardPng({ ...scorecard, deckName: longName });
  const nameRun = longRecording.texts.find((t) => t.text.startsWith('The Everlasting'));
  check('a long deck name is still drawn', nameRun !== undefined);
  check(
    'a long deck name is truncated with an ellipsis',
    nameRun !== undefined && nameRun.text.endsWith('…') && nameRun.text.length < longName.length,
    nameRun?.text ?? '(nothing drawn)',
  );
  checkNoOverflow('long deck name', longRecording);

  // --- the degenerate run ---------------------------------------------------
  const emptyRecording = installCanvas();
  let threw = '';
  try {
    await renderScorecardPng(emptyScorecard());
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  check('a run with no turns and no events renders without throwing', threw === '', threw);
  check('the empty run still produced a blob', emptyRecording.blobs === 1);
  check(
    'the empty run says so rather than drawing a blank chart',
    emptyRecording.texts.some((t) => t.text === 'No turns recorded'),
  );
  check(
    'the empty run has an UNFINISHED verdict',
    emptyRecording.texts.some((t) => t.text === 'UNFINISHED'),
  );
  const emptyBars = emptyRecording.filled.filter(
    (s) => Math.abs(s.bottom - AXIS_Y) < 0.6 && s.top >= 328 && s.right - s.left <= 40,
  );
  check('the empty run draws no bars', emptyBars.length === 0, `${emptyBars.length}`);
  checkNoOverflow('empty run', emptyRecording);

  // --- a one-turn run, where every average wants to divide by nothing -------
  const oneTurn: Scorecard = {
    ...emptyScorecard(),
    deckName: 'One Turn Wonder',
    result: 'concede',
    turns: 1,
    seed: 'solo',
    timeline: [
      {
        turn: 1,
        mvDeployed: 0,
        landsPlayed: 1,
        cardsDrawn: 0,
        boardValueEnd: 0,
        playerLifeEnd: 40,
        damageBySeat: { A: 0, B: 0, C: 0 },
        eventIds: [],
      },
    ],
  };
  const oneRecording = installCanvas();
  let oneThrew = '';
  try {
    await renderScorecardPng(oneTurn);
  } catch (error) {
    oneThrew = error instanceof Error ? error.message : String(error);
  }
  check('a one-turn run renders without throwing', oneThrew === '', oneThrew);
  check(
    'a one-turn run still draws its column',
    oneRecording.filled.some((s) => Math.abs(s.bottom - AXIS_Y) < 0.6 && s.right - s.left <= 40),
  );
  checkNoOverflow('one-turn run', oneRecording);

  // --- summary --------------------------------------------------------------
  const summary = [
    `seed                ${SEED} (bracket ${BRACKET}, ${scorecard.turns} turns)`,
    `image               ${SHARE_IMAGE_WIDTH}×${SHARE_IMAGE_HEIGHT} logical, ${DEVICE_SCALE}× backing`,
    `canvas calls        ${recording.calls.length}`,
    `text runs           ${recording.texts.length}`,
    `bars                ${bars.length}, event marks ${eventMarks.length}`,
    `events / wipes      ${scorecard.events.length} / ${scorecard.wipes.length}`,
    `widest text run     ${Math.max(...recording.texts.map((t) => extentOf(t).right)).toFixed(0)}px (edge 1144)`,
  ];

  console.log('\nverify:share-image');
  console.log('─'.repeat(72));
  for (const entry of summary) console.log(entry);
  console.log('─'.repeat(72));

  if (failures.length > 0) {
    console.log(`${failures.length} check(s) FAILED:`);
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    throw new Error(`${failures.length} share-image check(s) failed`);
  }
  console.log('all checks passed');
}

await main();
