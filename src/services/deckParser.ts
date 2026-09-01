/**
 * Parser for pasted plain-text decklists (Moxfield / Archidekt / EDHREC / MTGO exports).
 *
 * Handles:
 *   1 Sol Ring
 *   1x Sol Ring
 *   4 Lightning Bolt (2X2) 117
 *   Sol Ring *CMDR*
 *   // comments, # comments, blank lines
 *   Commander: / Deck / Sideboard: / Maybeboard section headers
 */

export interface ParsedEntry {
  name: string;
  qty: number;
  isCommander: boolean;
}

export interface ParseResult {
  entries: ParsedEntry[];
  warnings: string[];
}

type SectionKind = 'commander' | 'deck' | 'ignore';

const COMMANDER_HEADERS = ['commander', 'commanders', 'command zone', 'commander zone'];

const IGNORED_HEADERS = [
  'sideboard',
  'side board',
  'maybeboard',
  'maybe board',
  'maybe',
  'considering',
  'wishlist',
  'wish list',
  'tokens',
  'token',
  'acquire',
  'purchase',
  'purchase list',
];

const DECK_HEADERS = [
  'deck',
  'decklist',
  'mainboard',
  'main board',
  'main deck',
  'maindeck',
  'main',
  'library',
  'creature',
  'creatures',
  'instant',
  'instants',
  'sorcery',
  'sorceries',
  'artifact',
  'artifacts',
  'enchantment',
  'enchantments',
  'planeswalker',
  'planeswalkers',
  'battle',
  'battles',
  'land',
  'lands',
  'spell',
  'spells',
  'other',
  'others',
  'companion',
];

/** `Ramp (10)` / `Creatures (34):` — a bare label with a parenthesized count is a section header. */
const COUNTED_HEADER_RE = /^([^(]+?)\s*\(\s*\d+\s*\)\s*:?$/;

function headerKind(label: string): SectionKind | null {
  const key = label.trim().replace(/:$/, '').trim().toLowerCase();
  if (!key) return null;
  if (COMMANDER_HEADERS.includes(key)) return 'commander';
  if (IGNORED_HEADERS.includes(key)) return 'ignore';
  if (DECK_HEADERS.includes(key)) return 'deck';
  return null;
}

/** Detects a section header line; returns null for card lines. */
function detectSection(line: string): { kind: SectionKind; label: string } | null {
  const direct = headerKind(line);
  if (direct) return { kind: direct, label: line.replace(/:$/, '').trim() };

  const counted = COUNTED_HEADER_RE.exec(line);
  if (counted) {
    const label = counted[1].trim();
    const kind = headerKind(label);
    if (kind) return { kind, label };
    // User-defined Archidekt category, e.g. "Ramp (10)" — keep collecting into the deck.
    if (!/^\d/.test(label)) return { kind: 'deck', label };
  }

  return null;
}

/** Strips markers, category tags, and set/collector suffixes. Returns the bare card name. */
function cleanName(raw: string): { name: string; isCommander: boolean } {
  let text = raw;
  let isCommander = false;

  // *CMDR* marker anywhere on the line (also *Commander*).
  if (/\*\s*(cmdr|commander)\s*\*/i.test(text)) {
    isCommander = true;
  }

  // Drop all *...* markers (*CMDR*, *F* foil, *E* etched).
  text = text.replace(/\*[^*]*\*/g, ' ');
  // Moxfield buy markers ^Buy,#hex^ and Archidekt [Category] tags.
  text = text.replace(/\^[^^]*\^/g, ' ');
  text = text.replace(/\[[^\]]*\]/g, ' ');
  // Set / collector suffix: cut at the first " (" and everything after it.
  text = text.replace(/\s+\([^)]*\).*$/, '');
  // Trailing bare collector number left by exports without parens.
  text = text.replace(/\s+#\S+\s*$/, '');

  return { name: text.replace(/\s+/g, ' ').trim(), isCommander };
}

export function parseDecklist(input: string): ParseResult {
  const warnings: string[] = [];
  const order: string[] = [];
  const byKey = new Map<string, ParsedEntry>();

  let section: SectionKind = 'deck';
  let ignoredCards = 0;
  const ignoredSections = new Set<string>();

  const lines = input.split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    if (line.startsWith('//') || line.startsWith('#')) return;

    // MTGO-style sideboard prefix.
    if (/^sb:/i.test(line)) {
      ignoredCards++;
      ignoredSections.add('Sideboard');
      return;
    }

    const header = detectSection(line);
    if (header) {
      section = header.kind;
      if (header.kind === 'ignore') ignoredSections.add(header.label);
      return;
    }

    const body = line.replace(/^[-*•]\s+/, '');
    const match = /^(?:(\d+)\s*[xX]?\s+)?(.+)$/.exec(body);
    if (!match) {
      warnings.push(`Line ${index + 1}: could not read "${line}"`);
      return;
    }

    const qty = match[1] ? Number.parseInt(match[1], 10) : 1;
    const { name, isCommander: marked } = cleanName(match[2]);

    if (!name) {
      warnings.push(`Line ${index + 1}: could not read "${line}"`);
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      warnings.push(`Line ${index + 1}: ignored quantity in "${line}"`);
      return;
    }

    if (section === 'ignore') {
      ignoredCards += qty;
      return;
    }

    const key = name.toLowerCase();
    const isCommander = marked || section === 'commander';
    const existing = byKey.get(key);
    if (existing) {
      existing.qty += qty;
      existing.isCommander = existing.isCommander || isCommander;
    } else {
      byKey.set(key, { name, qty, isCommander });
      order.push(key);
    }
  });

  if (ignoredCards > 0) {
    const where = [...ignoredSections].join(', ') || 'sideboard';
    warnings.push(`Skipped ${ignoredCards} card${ignoredCards === 1 ? '' : 's'} in ${where}`);
  }

  const entries = order.map((key) => byKey.get(key)).filter((e): e is ParsedEntry => Boolean(e));
  if (entries.length === 0) warnings.push('No cards found in the pasted list');

  return { entries, warnings };
}
