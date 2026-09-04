/**
 * Advisory judge contract, shared by the client panel, the local proxy
 * (`server/`) and the eval harness (`scripts/eval-*.ts`). This file is the
 * interface; nothing in it talks to the network.
 *
 * The judge advises and never enforces: it reads what the player says is on the
 * table and answers a rules question with Comprehensive Rules citations, or it
 * declines. Resolution stays with the player (no-rules-engine fence, PRODUCT.md).
 */

export type JudgeZone = 'battlefield' | 'hand' | 'stack' | 'command' | 'graveyard' | 'exile';

/** One card as the player has it, in a shape the judge can read as text. */
export interface JudgeCardContext {
  name: string;
  zone: JudgeZone;
  tapped?: boolean;
  counters?: Record<string, number>;
  isCommander?: boolean;
  isToken?: boolean;
  typeLine?: string;
  /**
   * Printed mana cost in Scryfall's form, such as `{1}{U}`. Sent wherever the
   * type line is, because a question about what a spell costs -- the tax, a cost
   * increase, a colour requirement -- cannot be answered from the type line and
   * the oracle text, and a judge given neither will reconstruct the cost from
   * memory and get it wrong. Absent on lands and tokens, which have no cost.
   */
  manaCost?: string;
  /**
   * Printed power and toughness as Scryfall writes them, so `*` and `1+*` travel
   * as themselves rather than as a number they are not. These are the BASE
   * values off the card: the snapshot already sends counters, and the judge is
   * the one who works out what the creature is right now. Sent together with the
   * type line and for the same reason -- "does my 3/3 survive this?" cannot be
   * answered from a type line, and a judge given neither reconstructs the box
   * from memory. Absent on anything with no printed box.
   */
  power?: string;
  toughness?: string;
  /**
   * Printed starting loyalty, again as Scryfall's string. A planeswalker enters
   * with this many counters, so it is the base value and not a count of what is
   * on the card now, which travels in `counters` like every other counter.
   * Absent on everything that is not a planeswalker.
   */
  loyalty?: string;
  /** Sent for battlefield, hand and command cards; omitted for graveyard and exile. A cast spell travels as a stack item instead. */
  oracleText?: string;
}

export interface JudgeSeatContext {
  id: 'A' | 'B' | 'C';
  life: number;
  eliminated: boolean;
  threat: number;
  silhouette: { creatures: number; power: number; artifacts: number; openMana: number };
  /**
   * Hate pieces standing on this seat's side of the table: Rest in Peace, Blood
   * Moon, Thalia, Torpor Orb and the rest. They are real permanents the player
   * is honouring by hand, and a question answered as though they were not there
   * is answered about a different table -- "can I cast Reanimate?" has one
   * answer under Rest in Peace and another without it.
   *
   * `effect` rather than oracle text because a hate piece is not in the player's
   * deck, so `state.cardData` has nothing cached for it; the citation's one-line
   * effect is the whole of what can be said about the card, and it is what the
   * player is honouring anyway. `permanent` is the sweep category the citation
   * tags the card with -- which wipe clears it, not a type line, so an artifact
   * creature is tagged `creature` -- and `sinceTurn` is the player turn it
   * landed on.
   *
   * Omitted, not empty, when a seat has none. The store drops a piece on named
   * removal, on a wrath wide enough to sweep it, and on the seat's elimination,
   * so this list is exactly what is standing right now.
   */
  hate?: { name: string; effect: string; permanent?: string; sinceTurn: number }[];
}

/** Compact snapshot of the run, built client-side. The library is never sent. */
export interface JudgeTableContext {
  turn: number;
  phase: string;
  life: number;
  commanderTax?: number;
  cards: JudgeCardContext[];
  /**
   * Manual stack tray, top last. A spell item carries its card's own text here
   * and is NOT repeated in `cards`, so the model reads each object once.
   */
  stack?: {
    kind: string;
    label: string;
    typeLine?: string;
    /**
     * Printed mana cost, same form and same reason as `JudgeCardContext.manaCost`.
     * A cast spell only ever travels here, so without it the one object whose
     * cost a question is most likely to be about is the one object that carries
     * none. Absent on abilities and triggers, which have no printed cost.
     */
    manaCost?: string;
    /**
     * Printed power, toughness and starting loyalty, same strings and same
     * reason as on `JudgeCardContext`. A cast spell only ever travels here, so a
     * question about the creature or planeswalker that is about to resolve --
     * what it enters as, what it enters with -- has nowhere else to read them.
     */
    power?: string;
    toughness?: string;
    loyalty?: string;
    oracleText?: string;
    isCommander?: boolean;
    tapped?: boolean;
    counters?: Record<string, number>;
  }[];
  activeEvent?: {
    seat: string;
    type: string;
    prompt: string;
    card?: { name: string; effect: string };
  };
  seats: JudgeSeatContext[];
}

/**
 * The printed box as text, for every renderer that writes a card out: `3/3`, a
 * Tarmogoyf's star over `1+*`, `starting loyalty 4`. Lives here rather than in
 * a renderer because three of them write cards -- the table snapshot's cards
 * and its stack tray (`server/judge/core.ts`) and the eval harness's reference
 * block (`scripts/eval-run.ts`) -- and a judge that reads one wording on the
 * table and another in the reference block is reading two different formats.
 *
 * Base values off the card, never a current size: the counters follow in the
 * status words, and working out what the permanent is right now is the judge's
 * job rather than the renderer's.
 *
 * Power and toughness print together or not at all: half a box is not a fact a
 * question can be answered from, and Scryfall never prints one without the
 * other. `'0'` is a real power, so this tests the string and not its number.
 *
 * Loyalty carries the word `starting` and the P/T box does not, because the two
 * read differently against the counters printed after them. `3/3 | 2 +1/+1
 * counters` is a sum the judge is meant to do. Loyalty counters are not added
 * to a printed loyalty -- they ARE the walker's loyalty -- so a bare `loyalty 3
 * | 5 loyalty counters` invites the answer 8. The label says which number is
 * the base one and cannot be summed with what follows it.
 */
export function printedParts(object: {
  power?: string;
  toughness?: string;
  loyalty?: string;
}): string[] {
  const parts: string[] = [];
  if (object.power && object.toughness) parts.push(`${object.power}/${object.toughness}`);
  if (object.loyalty) parts.push(`starting loyalty ${object.loyalty}`);
  return parts;
}

export interface JudgeRequest {
  question: string;
  table?: JudgeTableContext;
}

/** A cited rule. `verified` is true when the id exists in the loaded corpus. */
export interface JudgeRule {
  /** Comprehensive Rules id such as `903.9a` or `704.5g`. */
  id: string;
  /** The rule's text from the corpus, when verified. */
  text?: string;
  verified: boolean;
}

export interface JudgeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface JudgeResponse {
  /** `decline` when the rules text or the given facts do not settle the question. */
  status: 'answer' | 'decline';
  /** Plain text, answer first, then why. No markdown. */
  answer: string;
  rules: JudgeRule[];
  confidence: 'high' | 'medium' | 'low';
  caveats: string[];
  model: string;
  driver?: JudgeDriver;
  grounding?: JudgeGrounding;
  /** The corpus's own "effective as of" date, e.g. `August 7, 2026`. */
  corpusDate: string;
  usage?: JudgeUsage;
}

export type JudgeErrorCode =
  | 'offline'
  /** The api driver has no credentials. */
  | 'no_key'
  /** The claude-code driver's CLI is not logged in (run `claude /login` once). */
  | 'no_login'
  /**
   * Credentials are fine and there is nothing left to spend: a Claude plan's
   * session window is used up, or the API is rate limiting. Nothing to fix, and
   * nothing to retry until the time the proxy's message names.
   */
  | 'limit'
  | 'no_corpus'
  | 'upstream'
  | 'bad_request';

/** How the proxy reaches the model. Same judge, same prompt, different bill. */
export type JudgeDriver = 'api' | 'claude-code';
/** How much of the Comprehensive Rules the model reads per question. */
export type JudgeGrounding = 'full' | 'retrieval';

export interface JudgeError {
  error: string;
  code: JudgeErrorCode;
}

/** GET /api/judge/health */
export interface JudgeHealth {
  ok: boolean;
  hasKey: boolean;
  corpusDate: string | null;
  model: string;
  driver: JudgeDriver;
  grounding: JudgeGrounding;
}

export const JUDGE_ENDPOINT = '/api/judge';
export const JUDGE_HEALTH_ENDPOINT = '/api/judge/health';
/** Port the local proxy listens on; Vite proxies `/api` here during `npm run dev`. */
export const JUDGE_PORT = 5174;
