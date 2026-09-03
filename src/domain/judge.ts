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
  /** Sent for battlefield, hand and command cards; omitted for graveyard and exile. A cast spell travels as a stack item instead. */
  oracleText?: string;
}

export interface JudgeSeatContext {
  id: 'A' | 'B' | 'C';
  life: number;
  eliminated: boolean;
  threat: number;
  silhouette: { creatures: number; power: number; artifacts: number; openMana: number };
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
