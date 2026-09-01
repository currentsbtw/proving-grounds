import type { DeckProfile, EventLedgerRow, Scorecard, TurnRow } from '../../engine/scorecard';

/** Pixel size of the shareable card. 2:1 so it posts cleanly to Discord/Twitter. */
export const SHARE_IMAGE_WIDTH = 1200;
export const SHARE_IMAGE_HEIGHT = 600;

export interface ShareImageOptions {
  /** Optional aggregate to print the deck's tags under the header. */
  profile?: DeckProfile;
}

/**
 * The share card is drawn, not screenshotted. A DOM-to-image pass would drag in
 * a library, need the run detail view to be mounted, and produce something that
 * changes shape every time the UI does; a canvas draw is ~500 lines that run
 * offline, depend on nothing, and put the same 1200×600 receipt on the clipboard
 * whether the scorecard came from the run that just ended or from the archive.
 *
 * Everything below is laid out in *logical* pixels (1200×600). The backing store
 * is twice that and the context is scaled once, up front, so the whole file can
 * speak in the coordinates the design was drawn in and still come out crisp on a
 * retina display.
 */

// ---------------------------------------------------------------------------
// Palette — mirrors src/styles/tokens.css
// ---------------------------------------------------------------------------
// The canvas cannot read CSS custom properties (there is no element to resolve
// them against in a worker), so the tokens are duplicated here. If tokens.css
// moves, this moves with it.

const C = {
  ground: '#17181c',
  surface: '#1f2127',
  raised: '#262932',
  line: '#33353c',
  ink: '#e8e6e1',
  muted: '#a0a3aa',
  accent: '#c9a85c',
  danger: '#e58a76',
  ok: '#8fc49e',
  manaW: '#e5d9a5',
  manaU: '#8fc1e8',
  manaB: '#bba9c9',
  manaR: '#e58a76',
  manaG: '#8fc49e',
} as const;

/** Event class → accent, matching the dock stripe in `pressure.css`. */
const EVENT_COLOR: Record<string, string> = {
  wipe: C.manaW,
  removal: C.manaB,
  resource: C.manaB,
  counter: C.manaU,
  combat: C.manaR,
  clock: C.manaG,
};

const BODY_FONT = `system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const DEVICE_SCALE = 2;

const CARD_X = 24;
const CARD_Y = 24;
const CARD_W = SHARE_IMAGE_WIDTH - CARD_X * 2;
const CARD_H = SHARE_IMAGE_HEIGHT - CARD_Y * 2;
const CARD_RADIUS = 16;

/** Left and right content edges inside the card. */
const L = CARD_X + 32;
const R = CARD_X + CARD_W - 32;
const CONTENT_W = R - L;

const TILE_Y = 172;
const TILE_H = 100;
const TILE_GAP = 12;
const TILE_COUNT = 6;
const TILE_W = (CONTENT_W - TILE_GAP * (TILE_COUNT - 1)) / TILE_COUNT;

/** Event dots live above the bars, in their own band. */
const DOT_BAND_BOTTOM = 320;
const DOT_SPACING = 10;
const MAX_DOTS = 3;

const PLOT_TOP = 330;
const AXIS_Y = 500;
const PLOT_H = AXIS_Y - PLOT_TOP;
const TURN_LABEL_Y = 516;

const STRIP_Y = 536;
const STRIP_H = 22;

// ---------------------------------------------------------------------------
// Canvas plumbing
// ---------------------------------------------------------------------------

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface RenderTarget {
  ctx: Ctx2D;
  toBlob: () => Promise<Blob>;
}

/**
 * An `OffscreenCanvas` where there is one — it works in a worker and never
 * touches the document — and a detached `<canvas>` everywhere else.
 */
function acquireTarget(width: number, height: number): RenderTarget {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d') as Ctx2D | null;
    if (!ctx) throw new Error('renderScorecardPng: no 2D context on the OffscreenCanvas');
    return { ctx, toBlob: () => canvas.convertToBlob({ type: 'image/png' }) };
  }

  if (typeof document === 'undefined') {
    throw new Error('renderScorecardPng: no canvas implementation available');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('renderScorecardPng: no 2D context on the canvas element');
  return {
    ctx,
    toBlob: () =>
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('renderScorecardPng: toBlob gave nothing'))),
          'image/png',
        );
      }),
  };
}

/**
 * Marcellus is loaded from Google Fonts by `index.html`, which means it may not
 * have arrived — and a canvas asked for a font it does not have silently draws
 * the browser default, which is not a serif. Ask first, and name Georgia when
 * the answer is no, so the card is always *some* deliberate serif.
 */
function displayFont(): string {
  try {
    if (typeof document !== 'undefined' && document.fonts?.check('20px Marcellus')) {
      return `'Marcellus', Georgia, 'Times New Roman', serif`;
    }
  } catch {
    // `check` throws on a malformed font shorthand in some engines; fall through.
  }
  return `Georgia, 'Times New Roman', serif`;
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

/** `#rrggbb` at a fraction of opacity, for chip fills and gridlines. */
function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function finite(value: number | null | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Letter spacing via the context property where it exists. Assigning to a
 * context that has never heard of it is harmless, and the widths below add the
 * tracking back by hand rather than trusting `measureText` to have applied it.
 */
function setTracking(ctx: Ctx2D, px: number): void {
  (ctx as unknown as { letterSpacing?: string }).letterSpacing = `${px}px`;
}

function measure(ctx: Ctx2D, text: string, tracking = 0): number {
  const metrics = ctx.measureText(text);
  const width = finite(metrics?.width);
  return width + tracking * Math.max(0, text.length - 1);
}

/** The longest prefix of `text` that fits, with an ellipsis when it had to cut. */
function fit(ctx: Ctx2D, text: string, maxWidth: number, tracking = 0): string {
  if (measure(ctx, text, tracking) <= maxWidth) return text;
  let cut = text.length;
  while (cut > 1) {
    cut -= 1;
    const candidate = `${text.slice(0, cut).trimEnd()}…`;
    if (measure(ctx, candidate, tracking) <= maxWidth) return candidate;
  }
  return '…';
}

interface TextStyle {
  size: number;
  color: string;
  display?: boolean;
  tracking?: number;
  align?: CanvasTextAlign;
  maxWidth?: number;
}

/** One text run. Returns the width drawn, so callers can flow chips after it. */
function text(ctx: Ctx2D, value: string, x: number, y: number, style: TextStyle): number {
  const tracking = style.tracking ?? 0;
  ctx.font = `${style.size}px ${style.display ? displayFont() : BODY_FONT}`;
  ctx.fillStyle = style.color;
  ctx.textAlign = style.align ?? 'left';
  ctx.textBaseline = 'alphabetic';
  setTracking(ctx, 0);
  const shown = style.maxWidth === undefined ? value : fit(ctx, value, style.maxWidth, tracking);
  const width = measure(ctx, shown, tracking);
  setTracking(ctx, tracking);
  ctx.fillText(shown, x, y);
  setTracking(ctx, 0);
  return width;
}

/** A rounded-rect path built from primitives — no dependence on `roundRect`. */
function roundedPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

interface BoxStyle {
  fill?: string;
  stroke?: string;
  lineWidth?: number;
  radius?: number;
}

function box(ctx: Ctx2D, x: number, y: number, w: number, h: number, style: BoxStyle): void {
  roundedPath(ctx, x, y, w, h, style.radius ?? 6);
  if (style.fill) {
    ctx.fillStyle = style.fill;
    ctx.fill();
  }
  if (style.stroke) {
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.lineWidth ?? 1;
    ctx.stroke();
  }
}

function line(ctx: Ctx2D, x1: number, y1: number, x2: number, y2: number, color: string, width = 1): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function dot(ctx: Ctx2D, x: number, y: number, r: number, color: string): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Reading the scorecard
// ---------------------------------------------------------------------------

interface Verdict {
  word: string;
  color: string;
}

function verdictOf(card: Scorecard): Verdict {
  switch (card.result) {
    case 'win':
      return { word: 'WIN', color: C.ok };
    case 'loss':
      return { word: 'LOSS', color: C.danger };
    case 'concede':
      return { word: 'CONCEDE', color: C.danger };
    default:
      return { word: 'UNFINISHED', color: C.muted };
  }
}

interface Tile {
  label: string;
  value: string;
  sub: string;
}

function wipeTile(card: Scorecard): Tile {
  const wipes = card.wipes ?? [];
  if (wipes.length === 0) return { label: 'WIPE RECOVERY', value: 'no wipe', sub: 'none faced' };

  const landed = wipes.filter((w) => !w.negated);
  if (landed.length === 0) {
    return { label: 'WIPE RECOVERY', value: '0', sub: `${wipes.length} negated` };
  }
  const first = landed[0];
  const turns = first.turnsToRecover;
  return {
    label: 'WIPE RECOVERY',
    value: turns === null ? 'never' : `${turns}`,
    sub: `${wipes.length} faced · T${first.turn}`,
  };
}

function clockTile(card: Scorecard): Tile {
  const clock = card.clock;
  if (!clock?.faced) return { label: 'CLOCK', value: 'none', sub: 'no race' };
  const value = clock.beatClock ? 'beaten' : clock.outcome === 'expired' ? 'lost' : 'standing';
  return { label: 'CLOCK', value, sub: clock.outcome ?? 'unresolved' };
}

function tilesFor(card: Scorecard): Tile[] {
  const firstCast = card.deployment?.firstCommanderCastTurn ?? null;
  const answers = card.answers?.total ?? { offered: 0, responded: 0, resolved: 0, unresolved: 0 };
  const terminal = answers.responded + answers.resolved;
  const rate = card.answers?.rate ?? null;
  const seats = card.seats ?? [];
  const damage = seats.reduce((sum, seat) => sum + finite(seat.damageDealt), 0);
  const eliminated = seats.filter((seat) => seat.eliminatedTurn !== null).length;

  return [
    {
      label: 'DEPLOY MV/TURN',
      value: finite(card.deployment?.avgMvPerTurn).toFixed(1),
      sub: firstCast === null ? 'cmdr never cast' : `cmdr T${firstCast}`,
    },
    wipeTile(card),
    {
      label: 'CMDR DOWNTIME',
      value: `${finite(card.commander?.downtimeTurns)}`,
      sub: `${finite(card.commander?.removals)} removals`,
    },
    {
      label: 'ANSWER RATE',
      value: rate === null ? '—' : `${Math.round(rate * 100)}%`,
      sub: `${answers.responded}/${terminal} terminal`,
    },
    {
      label: 'DAMAGE DEALT',
      value: `${damage}`,
      sub: `${eliminated} seat${eliminated === 1 ? '' : 's'} out`,
    },
    clockTile(card),
  ];
}

function formatDate(stamp: number | null): string {
  if (!stamp || !Number.isFinite(stamp)) return 'undated';
  try {
    return new Date(stamp).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return 'undated';
  }
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function drawHeader(ctx: Ctx2D, card: Scorecard): void {
  const verdict = verdictOf(card);

  // The chip is measured first: the deck name gets whatever is left over.
  ctx.font = `26px ${displayFont()}`;
  const chipTracking = 3;
  const wordWidth = measure(ctx, verdict.word, chipTracking);
  const chipW = wordWidth + 44;
  const chipH = 48;
  const chipX = R - chipW;
  const chipY = 44;

  box(ctx, chipX, chipY, chipW, chipH, {
    fill: alpha(verdict.color, 0.14),
    stroke: alpha(verdict.color, 0.55),
    radius: 14,
  });
  text(ctx, verdict.word, chipX + chipW / 2, chipY + 32, {
    size: 26,
    color: verdict.color,
    display: true,
    tracking: chipTracking,
    align: 'center',
  });

  const nameWidth = chipX - 24 - L;

  text(ctx, 'PROVING GROUNDS', L, 66, {
    size: 12,
    color: C.accent,
    display: true,
    tracking: 4.5,
  });
  text(ctx, card.deckName || 'Untitled deck', L, 106, {
    size: 34,
    color: C.ink,
    display: true,
    maxWidth: nameWidth,
  });

  const meta = [
    `Bracket ${finite(card.bracket)}`,
    `Seed ${card.seed || '—'}`,
    `T${finite(card.turns)}`,
    formatDate(card.endedAt ?? card.startedAt),
  ];
  if (card.partial) meta.push('partial');
  text(ctx, meta.join('  ·  '), L, 132, {
    size: 13,
    color: C.muted,
    tracking: 0.4,
    maxWidth: nameWidth,
  });

  line(ctx, L, 152, R, 152, C.line);
}

function drawTiles(ctx: Ctx2D, card: Scorecard): void {
  const tiles = tilesFor(card);
  tiles.forEach((tile, i) => {
    const x = L + i * (TILE_W + TILE_GAP);
    box(ctx, x, TILE_Y, TILE_W, TILE_H, { fill: C.raised, stroke: C.line, radius: 8 });

    const inner = TILE_W - 24;
    text(ctx, tile.label, x + 12, TILE_Y + 24, {
      size: 9.5,
      color: C.muted,
      tracking: 1.4,
      maxWidth: inner,
    });
    // A word like "standing" cannot be shown at the numeral size; drop a step
    // rather than ellipsing a five-letter verdict into nonsense.
    text(ctx, tile.value, x + 12, TILE_Y + 62, {
      size: tile.value.length > 4 ? 22 : 30,
      color: C.ink,
      display: true,
      maxWidth: inner,
    });
    text(ctx, tile.sub, x + 12, TILE_Y + 84, {
      size: 11,
      color: C.muted,
      maxWidth: inner,
    });
  });
}

function drawTimeline(ctx: Ctx2D, card: Scorecard): void {
  const rows: TurnRow[] = card.timeline ?? [];

  line(ctx, L, AXIS_Y, R, AXIS_Y, C.line);

  if (rows.length === 0) {
    text(ctx, 'No turns recorded', L + CONTENT_W / 2, PLOT_TOP + PLOT_H / 2, {
      size: 15,
      color: C.muted,
      tracking: 2,
      align: 'center',
    });
    return;
  }

  const typeById = new Map<string, string>();
  for (const event of card.events ?? ([] as EventLedgerRow[])) typeById.set(event.eventId, event.type);

  const maxMv = Math.max(1, ...rows.map((row) => finite(row.mvDeployed)));
  const maxBoard = Math.max(1, ...rows.map((row) => finite(row.boardValueEnd)));
  const colW = CONTENT_W / rows.length;
  const barW = Math.max(2, Math.min(colW * 0.56, 34));
  const centerOf = (index: number): number => L + colW * (index + 0.5);

  // Wipes first, so their dashed rules sit behind the bars they explain.
  ctx.save();
  ctx.setLineDash([4, 4]);
  for (const wipe of card.wipes ?? []) {
    const index = Math.round(finite(wipe.turn)) - 1;
    if (index < 0 || index >= rows.length) continue;
    line(ctx, centerOf(index), PLOT_TOP - 8, centerOf(index), AXIS_Y, alpha(C.manaW, wipe.negated ? 0.3 : 0.6));
  }
  ctx.restore();
  ctx.setLineDash([]);

  // Bars: mana value committed to the board on that turn. A turn that deployed
  // nothing still gets a stub sitting on the axis — the gap is the point, and an
  // absent column reads as a missing turn rather than as a turn spent doing
  // nothing.
  for (let i = 0; i < rows.length; i++) {
    const value = Math.max(0, finite(rows[i].mvDeployed));
    const scaled = (value / maxMv) * PLOT_H;
    const height = Math.max(scaled, 2);
    box(ctx, centerOf(i) - barW / 2, AXIS_Y - height, barW, height, {
      fill: alpha(C.accent, scaled > 0 ? 0.85 : 0.25),
      radius: Math.min(3, barW / 2),
    });
  }

  // Board value: what all that deployment actually left standing.
  ctx.beginPath();
  rows.forEach((row, i) => {
    const y = AXIS_Y - (Math.max(0, finite(row.boardValueEnd)) / maxBoard) * PLOT_H;
    if (i === 0) ctx.moveTo(centerOf(i), y);
    else ctx.lineTo(centerOf(i), y);
  });
  ctx.strokeStyle = C.ok;
  ctx.lineWidth = 1.75;
  ctx.stroke();
  if (rows.length === 1) {
    dot(ctx, centerOf(0), AXIS_Y - (finite(rows[0].boardValueEnd) / maxBoard) * PLOT_H, 3, C.ok);
  }

  // Event dots, newest nearest the bars.
  rows.forEach((row, i) => {
    const ids = row.eventIds ?? [];
    for (let d = 0; d < Math.min(ids.length, MAX_DOTS); d++) {
      const type = typeById.get(ids[d]) ?? 'combat';
      dot(ctx, centerOf(i), DOT_BAND_BOTTOM - d * DOT_SPACING, 3.5, EVENT_COLOR[type] ?? C.muted);
    }
    if (ids.length > MAX_DOTS) {
      text(ctx, `+${ids.length - MAX_DOTS}`, centerOf(i), DOT_BAND_BOTTOM - MAX_DOTS * DOT_SPACING - 2, {
        size: 8.5,
        color: C.muted,
        align: 'center',
      });
    }
  });

  // Turn numbers, thinned out so a 30-turn game does not become a smear.
  const step = Math.max(1, Math.ceil(rows.length / 24));
  rows.forEach((row, i) => {
    const isEdge = i === 0 || i === rows.length - 1;
    if (!isEdge && i % step !== 0) return;
    text(ctx, `${finite(row.turn, i + 1)}`, centerOf(i), TURN_LABEL_Y, {
      size: 10,
      color: C.muted,
      align: 'center',
    });
  });
}

function drawStrip(ctx: Ctx2D, options?: ShareImageOptions): void {
  const footer = 'unofficial fan content';
  ctx.font = `10px ${BODY_FONT}`;
  const footerWidth = measure(ctx, footer, 1.2);
  text(ctx, footer, R, STRIP_Y + 15, {
    size: 10,
    color: alpha(C.muted, 0.7),
    tracking: 1.2,
    align: 'right',
  });

  const tags = options?.profile?.tags ?? [];
  const limit = R - footerWidth - 24;
  let x = L;
  for (const tag of tags) {
    ctx.font = `11px ${BODY_FONT}`;
    const width = measure(ctx, tag, 0.6) + 20;
    if (x + width > limit) break;
    box(ctx, x, STRIP_Y, width, STRIP_H, {
      fill: alpha(C.accent, 0.1),
      stroke: alpha(C.accent, 0.35),
      radius: 11,
    });
    text(ctx, tag, x + 10, STRIP_Y + 15, { size: 11, color: C.accent, tracking: 0.6 });
    x += width + 6;
  }
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

/**
 * Render a run's scorecard as a PNG blob using a 2D canvas. No external
 * libraries: the app is local-first and must build offline.
 */
export async function renderScorecardPng(
  card: Scorecard,
  options?: ShareImageOptions,
): Promise<Blob> {
  const target = acquireTarget(SHARE_IMAGE_WIDTH * DEVICE_SCALE, SHARE_IMAGE_HEIGHT * DEVICE_SCALE);
  const ctx = target.ctx;

  // One scale, then everything below is in logical pixels.
  ctx.scale(DEVICE_SCALE, DEVICE_SCALE);

  ctx.fillStyle = C.ground;
  ctx.fillRect(0, 0, SHARE_IMAGE_WIDTH, SHARE_IMAGE_HEIGHT);

  box(ctx, CARD_X, CARD_Y, CARD_W, CARD_H, {
    fill: C.surface,
    stroke: C.line,
    radius: CARD_RADIUS,
  });

  drawHeader(ctx, card);
  drawTiles(ctx, card);
  drawTimeline(ctx, card);
  drawStrip(ctx, options);

  return target.toBlob();
}
