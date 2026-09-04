/**
 * Seat archetype profiles: what kind of deck each opponent seat is piloting.
 *
 * A seat still has no decklist and no abilities (PRODUCT.md, no AI opponents).
 * A profile is three things and nothing more: a label the readout prints, a
 * colour identity the citation table is filtered against, and a set of
 * multipliers over dials that already existed in `src/data/pressure.ts`. It
 * buys the table three *different* opponents instead of three copies of the
 * same average pod — the control seat holds the wraths and the counterspells,
 * the aggro seat turns creatures sideways, the stax seat taxes — without any of
 * them ever holding a card.
 *
 * The colour identity is the part a player will check. A seat that cites
 * Counterspell has blue in it; a seat that cites Swords to Plowshares has
 * white. Colourless cards (Nevinyrral's Disk, Aetherflux Reservoir) are legal
 * for every seat, which is what an empty `colors` array on a citation means.
 *
 * Tuning: these numbers are read by the pressure engine and were fitted with
 * `npm run probe:pressure 1000` alongside the curves in `src/data/pressure.ts`.
 * They are part of the same tuning surface, so changing one of them bumps
 * `PRESSURE.version` rather than carrying a version of its own.
 */

export type ManaColor = 'W' | 'U' | 'B' | 'R' | 'G';

export type SeatProfileId =
  | 'aggro'
  | 'control'
  | 'midrange'
  | 'combo'
  | 'stax'
  | 'tokens'
  /**
   * The fallback, never dealt to a seat. See `PROFILES.neutral` — it exists so
   * an unprofiled seat has a profile object to read instead of borrowing one
   * archetype's numbers.
   */
  | 'neutral';

/** Every colour, for callers that have no seat to filter against. */
export const ALL_COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

export interface SeatProfile {
  id: SeatProfileId;
  /** Printed on the seat frame. Title case, one word. */
  label: string;
  /** One line of table-talk, shown as the chip's tooltip. */
  blurb: string;
  /**
   * The seat's colour identity, two or three colours. A citation is only
   * available to this seat when every colour on the card is in here.
   */
  colors: ManaColor[];
  /** Multiplies the per-window hazard probability for each event type. */
  hazardMult: Record<'wipe' | 'removal' | 'combat' | 'resource' | 'clock' | 'hate', number>;
  /** Multiplies the chance this seat is the one holding up a counterspell. */
  counterArmMult: number;
  /** Multiplies the threat this seat gains per opponent window. */
  threatGrowthMult: number;
  /** Multiplies the board this seat grows: how many bodies, and how big. */
  silhouette: { creaturesMult: number; powerMult: number };
  /**
   * Overrides `PRESSURE.resource.weights` for the discard/sacrifice/tax roll.
   * Only a seat whose resource attacks have a shape of their own needs one.
   */
  resourceWeights?: { discard: number; sacrifice: number; tax: number };
}

/**
 * The archetypes a seat can actually be dealt, in a fixed order so
 * `drawProfiles` is a seeded shuffle of a stable list rather than of whatever
 * order an object literal happened to be written in.
 *
 * `neutral` is deliberately absent: it is the shape of "no profile at all", not
 * an opponent, and dealing it would put a seat at the table with no identity to
 * read off the frame.
 */
export const PROFILE_IDS: SeatProfileId[] = [
  'aggro',
  'control',
  'midrange',
  'combo',
  'stax',
  'tokens',
];

/**
 * The table. Multipliers sit around 1.0 on average across the six dealt
 * profiles, because the bracket curves in `src/data/pressure.ts` are still what
 * says how much pressure a bracket produces overall — a profile only says which
 * seat it comes from. Where a mean is deliberately off 1.0 it is compensating
 * for who gets picked: the wipe caster is the seat with the least to lose, so
 * the two profiles that grow the smallest boards hold the wrath more often than
 * a flat average would suggest.
 *
 * A multiplier above 1.0 is worth as much as one below it, which was not true
 * before `PRESSURE.version` 5: a profile now scales its hazard's *capped*
 * chance, so 1.6x still reads as 1.6x in the turns where the bracket's own ramp
 * has reached its ceiling. The probe's `archetypeGap` row is what holds that
 * open — see `scripts/probe-pressure.ts`.
 *
 * `neutral` is last and is not one of the six: every multiplier there is 1.0 by
 * definition, so it is not part of the average and is never dealt.
 */
export const PROFILES: Record<SeatProfileId, SeatProfile> = {
  aggro: {
    id: 'aggro',
    label: 'Aggro',
    blurb: 'Hits face early, light on answers.',
    // Mardu: the beatdown colours, and every burn-shaped wrath it does run.
    colors: ['R', 'W', 'B'],
    // Hate at 0.3: the beatdown seat would rather spend two mana on a body than
    // on a piece that only slows the table down, itself included.
    hazardMult: { wipe: 0.5, removal: 0.85, combat: 1.6, resource: 0.5, clock: 0.8, hate: 0.3 },
    counterArmMult: 0.2,
    threatGrowthMult: 1.1,
    silhouette: { creaturesMult: 1.0, powerMult: 1.5 },
  },

  control: {
    id: 'control',
    label: 'Control',
    blurb: 'Holds up answers, wraths when it has to.',
    // Esper: the wrath and counterspell seat.
    colors: ['W', 'U', 'B'],
    // Combat at 0.4 rather than 0.5: with the version-5 clamp the archetype gap
    // is measured rather than assumed (`archetypeGap` in the probe), and the
    // control seat was still turning creatures sideways more than half as often
    // as the aggro seat at bracket 4, where both curves sit near their ceiling.
    // A seat that would rather hold up its mana attacks less than that.
    hazardMult: { wipe: 2.0, removal: 1.6, combat: 0.4, resource: 0.8, clock: 0.8, hate: 0.9 },
    counterArmMult: 1.5,
    threatGrowthMult: 0.9,
    silhouette: { creaturesMult: 1.0, powerMult: 1.0 },
  },

  midrange: {
    id: 'midrange',
    label: 'Midrange',
    blurb: 'Good cards, no plan you can dodge.',
    // Sultai: the baseline seat. Its multipliers are the closest to flat of the
    // six, but they are not flat — that is what `neutral` is for.
    colors: ['B', 'G', 'U'],
    hazardMult: { wipe: 1.15, removal: 1.05, combat: 1.05, resource: 1.0, clock: 0.9, hate: 0.7 },
    counterArmMult: 0.85,
    threatGrowthMult: 1.0,
    silhouette: { creaturesMult: 1.0, powerMult: 1.0 },
  },

  combo: {
    id: 'combo',
    label: 'Combo',
    blurb: 'Ignores the board, wins out of nowhere.',
    // Grixis: tutors, rituals and the two-card kill.
    colors: ['U', 'B', 'R'],
    hazardMult: { wipe: 0.7, removal: 0.9, combat: 0.45, resource: 0.8, clock: 1.5, hate: 0.8 },
    counterArmMult: 1.15,
    threatGrowthMult: 1.0,
    silhouette: { creaturesMult: 1.0, powerMult: 1.0 },
  },

  stax: {
    id: 'stax',
    label: 'Stax',
    blurb: 'Taxes everything, wins slowly and on purpose.',
    // Esper again, pointed the other way: the pieces, not the wraths.
    colors: ['W', 'B', 'U'],
    // Hate at 2.5, the largest multiplier in the table and deliberately so: the
    // standing piece *is* the stax deck, the same way the tax is. A pod with the
    // stax seat still in it plays a different game from one without.
    hazardMult: { wipe: 1.05, removal: 1.1, combat: 0.6, resource: 2.0, clock: 0.7, hate: 2.5 },
    counterArmMult: 0.7,
    threatGrowthMult: 1.0,
    silhouette: { creaturesMult: 1.0, powerMult: 1.0 },
    // A stax seat strips and edicts as an afterthought; the tax is the deck.
    resourceWeights: { discard: 0.25, sacrifice: 0.2, tax: 0.55 },
  },

  tokens: {
    id: 'tokens',
    label: 'Tokens',
    blurb: 'Wide board, small bodies, one bad wrath away from nothing.',
    // Selesnya: the widest board at the table and the least behind it.
    colors: ['G', 'W'],
    hazardMult: { wipe: 0.85, removal: 0.8, combat: 1.4, resource: 1.0, clock: 0.9, hate: 0.5 },
    counterArmMult: 0.3,
    threatGrowthMult: 1.0,
    silhouette: { creaturesMult: 1.6, powerMult: 0.8 },
  },

  /**
   * Not an archetype: the identity of a seat that has none. Every multiplier is
   * exactly 1.0 and every colour is legal, so a caller that assigns no profiles
   * gets the engine it had before profiles existed, to the roll. It is kept out
   * of `PROFILE_IDS` so `drawProfiles` can never deal it — a real seat always
   * has a real archetype, and only the fallback path reads this.
   *
   * Borrowing `midrange` for the job was the bug this replaces: midrange is a
   * seat with opinions (it wraths 15% more often and holds up counterspells
   * 15% less), and an unprofiled seat quietly inherited them.
   */
  neutral: {
    id: 'neutral',
    label: 'Pod',
    blurb: 'No archetype read on this seat.',
    colors: [...ALL_COLORS],
    hazardMult: { wipe: 1.0, removal: 1.0, combat: 1.0, resource: 1.0, clock: 1.0, hate: 1.0 },
    counterArmMult: 1.0,
    threatGrowthMult: 1.0,
    silhouette: { creaturesMult: 1.0, powerMult: 1.0 },
  },
};

/** The profile's colours as spaced letters, for a tooltip or a label. */
export function colorLetters(colors: readonly ManaColor[]): string {
  return colors.length === 0 ? 'colourless' : colors.join(' ');
}
