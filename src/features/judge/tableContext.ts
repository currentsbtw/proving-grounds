import { cardName, cardsInZone, commanderTax } from '../../state/gameStore';
import type { GameState } from '../../state/gameStore';
import type { CardInstance, ZoneId } from '../../domain/types';
import type {
  JudgeCardContext,
  JudgeSeatContext,
  JudgeTableContext,
  JudgeZone,
} from '../../domain/judge';

/** One item of the manual stack tray as the snapshot carries it. */
type StackContext = NonNullable<JudgeTableContext['stack']>[number];

/**
 * The table as a judge can read it: what the player says is where, plus the
 * numbers on the readout. Built once per question, never per render.
 *
 * Two fences the shape of this file enforces. The library is never sent, in any
 * form — a judge that can see the top card is a judge that can answer questions
 * the player has not earned the answer to. And the graveyard and exile travel as
 * names only: they are usually the longest zones on the table and their oracle
 * text almost never settles a rules question, so the tokens go to the zones that
 * do.
 *
 * A cast spell is described once: it travels as a tray item carrying its own
 * type line and oracle text, and is left out of `cards` entirely, so the model
 * never has to work out that two entries are the same object.
 */

/** Zones that travel, in the order they are written into the snapshot. */
const ZONES: JudgeZone[] = ['battlefield', 'hand', 'command', 'graveyard', 'exile'];

/** Zones whose cards carry their oracle text. */
const WITH_ORACLE = new Set<JudgeZone>(['battlefield', 'hand', 'command']);

/** Type line for an instance: a token carries its own, a real card uses the cache. */
function typeLineOf(state: GameState, card: CardInstance): string {
  if (card.isToken) return card.tokenSpec?.typeLine ?? 'Creature — Token';
  if (card.scryfallId) return state.cardData[card.scryfallId]?.typeLine ?? '';
  return '';
}

/**
 * Printed mana cost from the card cache, in Scryfall's `{1}{U}` form. Tokens
 * have none, and a land's is the empty string, which is left out rather than
 * sent as a blank field.
 */
function manaCostOf(state: GameState, card: CardInstance): string {
  if (card.isToken || !card.scryfallId) return '';
  return state.cardData[card.scryfallId]?.manaCost ?? '';
}

/**
 * The printed box: power, toughness and starting loyalty as Scryfall's strings,
 * so `*` and `1+*` survive. Base values only — counters travel separately and
 * the judge is the one who adds them up.
 *
 * A token reads its own spec the way `typeLineOf` does, since a token has no
 * cached card and its size is the whole of what it is. Loyalty comes from the
 * cache alone: a token spec has no field for one. Every part is absent rather
 * than blank when the card has no box.
 */
function boxOf(
  state: GameState,
  card: CardInstance,
): { power?: string; toughness?: string; loyalty?: string } {
  if (card.isToken) {
    const spec = card.tokenSpec;
    return { power: spec?.power, toughness: spec?.toughness };
  }
  const data = card.scryfallId ? state.cardData[card.scryfallId] : undefined;
  return { power: data?.power, toughness: data?.toughness, loyalty: data?.loyalty };
}

/** Oracle text from the card cache. Tokens have none. */
function oracleOf(state: GameState, card: CardInstance): string {
  if (card.isToken || !card.scryfallId) return '';
  return state.cardData[card.scryfallId]?.oracleText ?? '';
}

/** Counters worth sending: a zeroed kind is bookkeeping residue, not a fact. */
function countersOf(card: CardInstance): Record<string, number> | undefined {
  let any = false;
  const out: Record<string, number> = {};
  for (const [kind, n] of Object.entries(card.counters)) {
    if (n === 0) continue;
    out[kind] = n;
    any = true;
  }
  return any ? out : undefined;
}

function toCardContext(
  state: GameState,
  card: CardInstance,
  zone: JudgeZone,
): JudgeCardContext {
  const entry: JudgeCardContext = { name: cardName(state, card.iid), zone };
  if (card.tapped) entry.tapped = true;
  const counters = countersOf(card);
  if (counters) entry.counters = counters;
  if (card.isCommander) entry.isCommander = true;
  if (card.isToken) entry.isToken = true;

  const typeLine = typeLineOf(state, card);
  if (typeLine) entry.typeLine = typeLine;
  const manaCost = manaCostOf(state, card);
  if (manaCost) entry.manaCost = manaCost;
  const box = boxOf(state, card);
  if (box.power !== undefined) entry.power = box.power;
  if (box.toughness !== undefined) entry.toughness = box.toughness;
  if (box.loyalty !== undefined) entry.loyalty = box.loyalty;

  if (WITH_ORACLE.has(zone)) {
    const oracle = oracleOf(state, card);
    if (oracle) entry.oracleText = oracle;
  }
  return entry;
}

/**
 * The tax standing on the commander. With two commanders the higher of the two
 * is sent: the snapshot carries one figure, and the one that changes what a
 * cast costs is the larger.
 */
function commanderTaxOf(state: GameState): number | undefined {
  let tax: number | undefined;
  for (const card of Object.values(state.cards)) {
    if (!card.isCommander || !card.scryfallId) continue;
    const own = commanderTax(state, card.scryfallId);
    tax = tax === undefined ? own : Math.max(tax, own);
  }
  return tax;
}

/**
 * Seats, each carrying the hate pieces standing on its side of the table. The
 * store keeps only pieces that have resolved and are still out, so this is a
 * filter and nothing more. A piece travels as its citation's one-line effect
 * rather than as oracle text: the card is not in the player's deck, so there is
 * nothing in `state.cardData` to look up.
 */
function toSeatContext(state: GameState): JudgeSeatContext[] {
  return state.seats.map((seat) => {
    const entry: JudgeSeatContext = {
      id: seat.id,
      life: seat.life,
      eliminated: seat.eliminated,
      threat: seat.threat,
      silhouette: {
        creatures: seat.silhouette.creatures,
        power: seat.silhouette.power,
        artifacts: seat.silhouette.artifacts,
        openMana: seat.silhouette.openMana,
      },
    };
    // A dead seat sends none, the same floor the readout keeps: the store
    // retires a seat's pieces as it dies, and a piece travelling under a seat
    // that is out would be a fact about the table that is no longer true.
    if (seat.eliminated) return entry;
    const hate = state.hazards
      .filter((hazard) => hazard.seatId === seat.id)
      .map((hazard) => ({
        name: hazard.card.name,
        effect: hazard.card.effect,
        ...(hazard.card.permanent ? { permanent: hazard.card.permanent } : {}),
        sinceTurn: hazard.spawnedTurn,
      }));
    if (hate.length > 0) entry.hate = hate;
    return entry;
  });
}

/** A compact, library-free snapshot of the run for one question. */
export function buildTableContext(state: GameState): JudgeTableContext {
  const cards: JudgeCardContext[] = [];
  for (const zone of ZONES) {
    for (const card of cardsInZone(state, zone as ZoneId)) {
      cards.push(toCardContext(state, card, zone));
    }
  }

  const table: JudgeTableContext = {
    turn: state.turn,
    phase: state.phase,
    life: state.playerLife,
    cards,
    seats: toSeatContext(state),
  };

  const tax = commanderTaxOf(state);
  if (tax !== undefined) table.commanderTax = tax;

  // The tray is already bottom first, so the top of the stack is the last item.
  // A spell item is the one kind with a card behind it, and it carries that
  // card's whole reading here — text and the facts standing on the instance —
  // because the zone sweep above no longer writes it out. A commander on the
  // stack is the case that changes an answer most often, so it travels with the
  // same three flags a card in a zone would have carried. Abilities and counters
  // are the player's own words: kind and label are all there is to send.
  if (state.stack.length > 0) {
    table.stack = state.stack.map((item) => {
      const out: StackContext = { kind: item.kind, label: item.label };
      const card = item.kind === 'spell' && item.iid ? state.cards[item.iid] : undefined;
      if (card) {
        const typeLine = typeLineOf(state, card);
        if (typeLine) out.typeLine = typeLine;
        const manaCost = manaCostOf(state, card);
        if (manaCost) out.manaCost = manaCost;
        const box = boxOf(state, card);
        if (box.power !== undefined) out.power = box.power;
        if (box.toughness !== undefined) out.toughness = box.toughness;
        if (box.loyalty !== undefined) out.loyalty = box.loyalty;
        const oracle = oracleOf(state, card);
        if (oracle) out.oracleText = oracle;
        if (card.isCommander) out.isCommander = true;
        if (card.tapped) out.tapped = true;
        const counters = countersOf(card);
        if (counters) out.counters = counters;
      }
      return out;
    });
  }

  const event = state.activeEvent;
  if (event) {
    table.activeEvent = {
      seat: event.seatId,
      type: event.type,
      prompt: event.prompt,
      ...(event.card ? { card: { name: event.card.name, effect: event.card.effect } } : {}),
    };
  }

  return table;
}
