/**
 * Card citations: the real card a seat is "casting" when an event fires.
 *
 * A seat has no deck (PRODUCT.md, no AI opponents). A citation is attribution
 * for one effect that just happened, chosen from this table by the event's
 * shape, the seat's available mana, the bracket and the turn. It teaches which
 * cards produce which pressure and keeps every event something that can
 * actually happen at a table: no card, no event.
 *
 * `colors` is the card's colour identity, and it is what keeps a seat honest:
 * a seat only cites cards inside the colours its archetype profile runs (see
 * `src/data/profiles.ts`), so the blue seat holds the counterspells and nobody
 * casts Swords to Plowshares out of a Grixis pile.
 *
 * `cost` is the mana the seat needs open to do it (Blasphemous Act prints 9
 * and costs about 3 against a full pod; Force of Will prints 5 and costs 0).
 * `mv` is the printed mana value, for the badge. `effect` is the card's real
 * effect in table-talk, and it is what the player resolves by hand, so it must
 * be true to the card. `zone` is where the affected cards go.
 */

import type { ManaColor } from './profiles';

export type CitationZone = 'graveyard' | 'exile' | 'hand' | 'library';

/** What a wipe sweeps. `ace` = artifacts, creatures and enchantments. */
export type CitationSweep = 'creatures' | 'nonland' | 'ace';

export type RemovalTarget = 'creature' | 'permanent' | 'artifact' | 'enchantment' | 'planeswalker';

export type CounterTarget =
  | 'any'
  | 'creature'
  | 'noncreature'
  | 'instant-sorcery'
  | 'enchantment'
  | 'legendary';

export type Punish = 'draw' | 'treasure';

/** What kind of permanent a hate piece is — i.e. which wipe sweeps clear it. */
export type CitationPermanent = 'creature' | 'artifact' | 'enchantment';

export interface Citation {
  name: string;
  /**
   * The card's real colour identity, so a seat only ever cites cards it could
   * actually be playing. Empty for a colourless card, which every seat may
   * cite. Mana symbols in rules text count, the same as deckbuilding does.
   */
  colors: ManaColor[];
  /** Printed mana value. */
  mv: number;
  /** Mana the seat needs open to do this. */
  cost: number;
  /** The card's real effect, in table-talk. */
  effect: string;
  /** Inclusive bracket range where this card is a normal sight. */
  brackets: [number, number];
  /** Earliest turn this can realistically happen (Disk has to survive a turn). */
  minTurn?: number;
  /** Latest turn this is still around (Mystic Remora's cumulative upkeep). */
  maxTurn?: number;
  /** Where the affected cards go. Wipes and removal. */
  zone?: CitationZone;
  /** Wipes: what the card sweeps. */
  sweep?: CitationSweep;
  /** Removal: what the card can target. */
  targets?: RemovalTarget[];
  /** Removal: the target's mana value must be at least this. */
  minTargetMv?: number;
  /** Removal: the card cannot target these kinds (Go for the Throat: nonartifact). */
  excludes?: RemovalTarget[];
  /** Counters: what the card can counter. */
  counters?: CounterTarget[];
  /** Pay-or-punish taxes: what the player pays to stop it. */
  pay?: number;
  /** Pay-or-punish taxes: what the seat gets if the player does not pay. */
  punish?: Punish;
  /**
   * Hate pieces: what the card is on the battlefield, and therefore which wipe
   * sweeps it away. Required on every entry in `hate` — a piece nothing can
   * sweep would stand until the seat died.
   */
  permanent?: CitationPermanent;
  /**
   * Hate pieces: the standing reminder, in second person, printed under the seat
   * for as long as the piece is out ("Your nonbasic lands are Mountains."). It
   * is what the player has to remember to honour, so it is the consequence
   * rather than the wording — `effect` still carries the card's full effect.
   */
  tell?: string;
}

/**
 * The table's own revision, bumped whenever a card is added, removed, or has a
 * field changed that the engine filters on (`colors`, `cost`, `brackets`,
 * `minTurn`, `maxTurn`, `sweep`, `targets`, `counters`).
 *
 * This is not cosmetic bookkeeping: eligibility decides whether a hazard rolls
 * at all, and the citation is drawn by indexing a filtered list, so one card
 * appearing or leaving shifts every seed's rng stream from that window onward.
 * A table edit therefore has to bump `PRESSURE.version` alongside this, the
 * same as a curve edit does — see the note there.
 *
 * Revision 2: Deadly Rollick's colour identity corrected from R to B.
 *
 * Revision 3: the `hate` table — the persistent pieces a seat leaves standing.
 * Every entry carries `permanent` (what sweeps it) and `tell` (what the player
 * has to keep honouring), because a hate piece is the one citation that does not
 * finish resolving the turn it is cast.
 */
export const CITATIONS_VERSION = 3;

export interface CitationTable {
  wipe: Citation[];
  removal: Citation[];
  counter: Citation[];
  discard: Citation[];
  sacrifice: Citation[];
  tax: Citation[];
  clock: Citation[];
  /** Standing pieces. Every entry has `permanent` and `tell`. */
  hate: Citation[];
}

export const CITATIONS: CitationTable = {
  wipe: [
    {
      name: 'Wrath of God',
      colors: ['W'],
      mv: 4,
      cost: 4,
      effect: "Destroy all creatures. They can't be regenerated.",
      brackets: [1, 4],
      zone: 'graveyard',
      sweep: 'creatures',
    },
    {
      name: 'Day of Judgment',
      colors: ['W'],
      mv: 4,
      cost: 4,
      effect: 'Destroy all creatures.',
      brackets: [1, 3],
      zone: 'graveyard',
      sweep: 'creatures',
    },
    {
      name: 'Damnation',
      colors: ['B'],
      mv: 4,
      cost: 4,
      effect: "Destroy all creatures. They can't be regenerated.",
      brackets: [2, 5],
      zone: 'graveyard',
      sweep: 'creatures',
    },
    {
      name: 'Blasphemous Act',
      colors: ['R'],
      mv: 9,
      cost: 3,
      effect: 'Deals 13 damage to each creature. Costs 1 less for each creature on the table.',
      brackets: [1, 4],
      zone: 'graveyard',
      sweep: 'creatures',
    },
    {
      name: 'Toxic Deluge',
      colors: ['B'],
      mv: 3,
      cost: 3,
      effect: 'All creatures get -X/-X until end of turn. The caster pays X life.',
      brackets: [3, 5],
      zone: 'graveyard',
      sweep: 'creatures',
    },
    {
      name: 'Vanquish the Horde',
      colors: ['W'],
      mv: 8,
      cost: 2,
      effect: 'Destroy all creatures. Costs 1 less for each creature on the table.',
      brackets: [1, 3],
      zone: 'graveyard',
      sweep: 'creatures',
    },
    {
      name: 'Sunfall',
      colors: ['W'],
      mv: 5,
      cost: 5,
      effect: 'Exile all creatures. The caster gets an Incubator token as big as the pile.',
      brackets: [2, 4],
      zone: 'exile',
      sweep: 'creatures',
    },
    {
      name: 'Cyclonic Rift',
      colors: ['U'],
      mv: 2,
      cost: 7,
      minTurn: 5,
      effect: "Overloaded: return every nonland permanent the caster doesn't control to hand.",
      brackets: [2, 5],
      zone: 'hand',
      sweep: 'nonland',
    },
    {
      name: 'Farewell',
      colors: ['W'],
      mv: 6,
      cost: 6,
      minTurn: 5,
      effect: 'Exile all artifacts, all creatures and all enchantments. Planeswalkers stay.',
      brackets: [2, 5],
      zone: 'exile',
      sweep: 'ace',
    },
    {
      name: 'Planar Cleansing',
      colors: ['W'],
      mv: 6,
      cost: 6,
      effect: 'Destroy all nonland permanents.',
      brackets: [1, 4],
      zone: 'graveyard',
      sweep: 'nonland',
    },
    {
      name: 'Hour of Revelation',
      colors: ['W'],
      mv: 6,
      cost: 6,
      effect: 'Destroy all nonland permanents.',
      brackets: [1, 4],
      zone: 'graveyard',
      sweep: 'nonland',
    },
    {
      name: "Nevinyrral's Disk",
      colors: [],
      mv: 4,
      cost: 1,
      minTurn: 5,
      effect: 'Cracked: destroy all artifacts, creatures and enchantments. Planeswalkers stay.',
      brackets: [1, 4],
      zone: 'graveyard',
      sweep: 'ace',
    },
    {
      name: 'Ruinous Ultimatum',
      colors: ['R', 'W', 'B'],
      mv: 7,
      cost: 7,
      effect: 'Destroy all nonland permanents the caster does not control.',
      brackets: [2, 4],
      zone: 'graveyard',
      sweep: 'nonland',
    },
    {
      name: 'Devastation Tide',
      colors: ['U'],
      mv: 5,
      cost: 5,
      minTurn: 5,
      effect: "Return all nonland permanents to their owners' hands.",
      brackets: [1, 3],
      zone: 'hand',
      sweep: 'nonland',
    },
  ],

  removal: [
    {
      name: 'Swords to Plowshares',
      colors: ['W'],
      mv: 1,
      cost: 1,
      effect: 'Exile target creature. Its controller gains life equal to its power.',
      brackets: [1, 5],
      zone: 'exile',
      targets: ['creature'],
    },
    {
      name: 'Path to Exile',
      colors: ['W'],
      mv: 1,
      cost: 1,
      effect: 'Exile target creature. Its controller may fetch a basic land.',
      brackets: [1, 5],
      zone: 'exile',
      targets: ['creature'],
    },
    {
      name: 'Go for the Throat',
      colors: ['B'],
      mv: 2,
      cost: 2,
      effect: 'Destroy target nonartifact creature.',
      brackets: [1, 4],
      zone: 'graveyard',
      targets: ['creature'],
      excludes: ['artifact'],
    },
    {
      name: 'Infernal Grasp',
      colors: ['B'],
      mv: 2,
      cost: 2,
      effect: 'Destroy target creature. The caster loses 2 life.',
      brackets: [1, 5],
      zone: 'graveyard',
      targets: ['creature'],
    },
    {
      name: 'Pongify',
      colors: ['U'],
      mv: 1,
      cost: 1,
      effect: 'Destroy target creature. Its controller gets a 3/3 Ape.',
      brackets: [2, 5],
      zone: 'graveyard',
      targets: ['creature'],
    },
    {
      name: 'Fateful Absence',
      colors: ['W'],
      mv: 2,
      cost: 2,
      effect: 'Destroy target creature or planeswalker. Its controller investigates.',
      brackets: [1, 4],
      zone: 'graveyard',
      targets: ['creature', 'planeswalker'],
    },
    {
      name: 'Deadly Rollick',
      colors: ['B'],
      mv: 4,
      cost: 0,
      effect: 'Exile target creature. Free with their commander out.',
      brackets: [3, 5],
      zone: 'exile',
      targets: ['creature'],
    },
    {
      name: 'Beast Within',
      colors: ['G'],
      mv: 3,
      cost: 3,
      effect: 'Destroy target permanent. Its controller gets a 3/3 Beast.',
      brackets: [1, 4],
      zone: 'graveyard',
      targets: ['permanent'],
    },
    {
      name: 'Generous Gift',
      colors: ['W'],
      mv: 3,
      cost: 3,
      effect: 'Destroy target permanent. Its controller gets a 3/3 Elephant.',
      brackets: [1, 4],
      zone: 'graveyard',
      targets: ['permanent'],
    },
    {
      name: "Assassin's Trophy",
      colors: ['B', 'G'],
      mv: 2,
      cost: 2,
      effect: 'Destroy target permanent an opponent controls. Its controller may fetch a basic land.',
      brackets: [2, 5],
      zone: 'graveyard',
      targets: ['permanent'],
    },
    {
      name: 'Vindicate',
      colors: ['W', 'B'],
      mv: 3,
      cost: 3,
      effect: 'Destroy target permanent.',
      brackets: [1, 4],
      zone: 'graveyard',
      targets: ['permanent'],
    },
    {
      name: 'Anguished Unmaking',
      colors: ['W', 'B'],
      mv: 3,
      cost: 3,
      effect: 'Exile target nonland permanent. The caster loses 3 life.',
      brackets: [2, 5],
      zone: 'exile',
      targets: ['permanent'],
    },
    {
      name: 'Chaos Warp',
      colors: ['R'],
      mv: 3,
      cost: 3,
      effect:
        "Shuffle target permanent into its owner's library. They reveal the top card and may put it onto the battlefield if it is a permanent.",
      brackets: [1, 5],
      zone: 'library',
      targets: ['permanent'],
    },
    {
      name: 'Despark',
      colors: ['W', 'B'],
      mv: 2,
      cost: 2,
      effect: 'Exile target permanent with mana value 4 or greater.',
      brackets: [2, 5],
      zone: 'exile',
      targets: ['permanent'],
      minTargetMv: 4,
    },
    {
      name: 'Cyclonic Rift',
      colors: ['U'],
      mv: 2,
      cost: 2,
      effect: "Return target nonland permanent the caster doesn't control to its owner's hand.",
      brackets: [2, 5],
      zone: 'hand',
      targets: ['permanent'],
    },
    {
      name: "Nature's Claim",
      colors: ['G'],
      mv: 1,
      cost: 1,
      effect: 'Destroy target artifact or enchantment. Its controller gains 4 life.',
      brackets: [2, 5],
      zone: 'graveyard',
      targets: ['artifact', 'enchantment'],
    },
    {
      name: 'Krosan Grip',
      colors: ['G'],
      mv: 3,
      cost: 3,
      effect: 'Destroy target artifact or enchantment. Split second.',
      brackets: [1, 4],
      zone: 'graveyard',
      targets: ['artifact', 'enchantment'],
    },
  ],

  counter: [
    {
      name: 'Counterspell',
      colors: ['U'],
      mv: 2,
      cost: 2,
      effect: 'Counter target spell.',
      brackets: [1, 5],
      counters: ['any'],
    },
    {
      name: 'Mana Drain',
      colors: ['U'],
      mv: 2,
      cost: 2,
      effect: 'Counter target spell. The caster gets that much mana next main phase.',
      brackets: [3, 5],
      counters: ['any'],
    },
    {
      name: 'Arcane Denial',
      colors: ['U'],
      mv: 2,
      cost: 2,
      effect: 'Counter target spell. You draw two cards next turn; the caster draws one.',
      brackets: [1, 4],
      counters: ['any'],
    },
    {
      name: 'Rewind',
      colors: ['U'],
      mv: 4,
      cost: 4,
      effect: 'Counter target spell. The caster untaps four lands.',
      brackets: [1, 2],
      counters: ['any'],
    },
    {
      name: 'Force of Will',
      colors: ['U'],
      mv: 5,
      cost: 0,
      effect: 'Counter target spell. Free by exiling a blue card and paying 1 life.',
      brackets: [3, 5],
      counters: ['any'],
    },
    {
      name: 'Pact of Negation',
      colors: ['U'],
      mv: 0,
      cost: 0,
      effect: 'Counter target spell. The caster pays 5 next upkeep or loses the game.',
      brackets: [4, 5],
      counters: ['any'],
    },
    {
      name: 'Essence Scatter',
      colors: ['U'],
      mv: 2,
      cost: 2,
      effect: 'Counter target creature spell.',
      brackets: [1, 3],
      counters: ['creature'],
    },
    {
      name: 'Negate',
      colors: ['U'],
      mv: 2,
      cost: 2,
      effect: 'Counter target noncreature spell.',
      brackets: [1, 4],
      counters: ['noncreature'],
    },
    {
      name: "Dovin's Veto",
      colors: ['W', 'U'],
      mv: 2,
      cost: 2,
      effect: "Counter target noncreature spell. This can't be countered.",
      brackets: [2, 5],
      counters: ['noncreature'],
    },
    {
      name: "An Offer You Can't Refuse",
      colors: ['U'],
      mv: 1,
      cost: 1,
      effect: 'Counter target noncreature spell. You get two Treasures.',
      brackets: [2, 5],
      counters: ['noncreature'],
    },
    {
      name: 'Fierce Guardianship',
      colors: ['U'],
      mv: 3,
      cost: 0,
      effect: 'Counter target noncreature spell. Free with their commander out.',
      brackets: [3, 5],
      counters: ['noncreature'],
    },
    {
      name: 'Force of Negation',
      colors: ['U'],
      mv: 3,
      cost: 0,
      effect: 'Counter target noncreature spell and exile it. Free on your turn by exiling a blue card.',
      brackets: [4, 5],
      counters: ['noncreature'],
    },
    {
      name: 'Swan Song',
      colors: ['U'],
      mv: 1,
      cost: 1,
      effect: 'Counter target enchantment, instant or sorcery spell. You get a 2/2 Bird.',
      brackets: [3, 5],
      counters: ['instant-sorcery', 'enchantment'],
    },
    {
      name: "Tale's End",
      colors: ['U'],
      mv: 2,
      cost: 2,
      effect: 'Counter target legendary spell, or an activated or triggered ability.',
      brackets: [2, 5],
      counters: ['legendary'],
    },
  ],

  discard: [
    {
      name: 'Burglar Rat',
      colors: ['B'],
      mv: 2,
      cost: 2,
      effect: 'When it enters, each opponent discards a card.',
      brackets: [1, 4],
    },
    {
      name: "Raven's Crime",
      colors: ['B'],
      mv: 1,
      cost: 1,
      effect: 'Target player discards a card. Retrace: cast it again from the graveyard by discarding a land.',
      brackets: [2, 4],
    },
    {
      name: 'Liliana of the Veil',
      colors: ['B'],
      mv: 3,
      cost: 3,
      effect: '+1: each player discards a card.',
      brackets: [3, 5],
    },
    {
      name: 'Syphon Mind',
      colors: ['B'],
      mv: 4,
      cost: 4,
      effect: 'Each other player discards a card. The caster draws a card for each one.',
      brackets: [1, 4],
    },
  ],

  sacrifice: [
    {
      name: 'Innocent Blood',
      colors: ['B'],
      mv: 1,
      cost: 1,
      effect: 'Each player sacrifices a creature.',
      brackets: [1, 5],
    },
    {
      name: 'Diabolic Edict',
      colors: ['B'],
      mv: 2,
      cost: 2,
      effect: 'Target player sacrifices a creature.',
      brackets: [1, 4],
    },
    {
      name: "Liliana's Triumph",
      colors: ['B'],
      mv: 2,
      cost: 2,
      effect: 'Each opponent sacrifices a creature.',
      brackets: [2, 5],
    },
    {
      name: 'Fleshbag Marauder',
      colors: ['B'],
      mv: 3,
      cost: 3,
      effect: 'When it enters, each player sacrifices a creature.',
      brackets: [1, 4],
    },
    {
      name: 'Plaguecrafter',
      colors: ['B'],
      mv: 3,
      cost: 3,
      effect: "When it enters, each player sacrifices a creature or planeswalker. Anyone who can't discards a card.",
      brackets: [1, 4],
    },
  ],

  tax: [
    {
      name: 'Rhystic Study',
      colors: ['U'],
      mv: 3,
      cost: 3,
      effect: 'Whenever you cast a spell, the caster draws a card unless you pay 1.',
      brackets: [2, 5],
      pay: 1,
      punish: 'draw',
    },
    {
      name: 'Esper Sentinel',
      colors: ['W'],
      mv: 1,
      cost: 1,
      effect: 'Whenever you cast your first noncreature spell each turn, the caster draws a card unless you pay X, X being its power (1 as printed).',
      brackets: [3, 5],
      pay: 1,
      punish: 'draw',
    },
    {
      name: 'Mystic Remora',
      colors: ['U'],
      mv: 1,
      cost: 1,
      maxTurn: 5,
      effect: 'Whenever you cast a noncreature spell, the caster draws a card unless you pay 4. Cumulative upkeep keeps it short-lived.',
      brackets: [4, 5],
      pay: 4,
      punish: 'draw',
    },
    {
      name: 'Smothering Tithe',
      colors: ['W'],
      mv: 4,
      cost: 4,
      effect: 'Whenever you draw a card, the caster makes a Treasure unless you pay 2.',
      brackets: [3, 5],
      pay: 2,
      punish: 'treasure',
    },
  ],

  clock: [
    {
      name: 'Craterhoof Behemoth',
      colors: ['G'],
      mv: 8,
      cost: 8,
      effect: 'Their creatures get +X/+X and trample and the board swings for lethal.',
      brackets: [1, 4],
    },
    {
      name: 'Overwhelming Stampede',
      colors: ['G'],
      mv: 5,
      cost: 5,
      effect: 'Their creatures get +X/+X and trample, X being their biggest power.',
      brackets: [1, 3],
    },
    {
      name: 'Insurrection',
      colors: ['R'],
      mv: 8,
      cost: 8,
      effect: 'They untap and take every creature on the table for one attack.',
      brackets: [1, 3],
    },
    {
      name: 'Approach of the Second Sun',
      colors: ['W'],
      mv: 7,
      cost: 7,
      effect: 'The second cast wins the game.',
      brackets: [1, 3],
    },
    {
      name: 'Triumph of the Hordes',
      colors: ['G'],
      mv: 4,
      cost: 4,
      effect: 'Their creatures get +1/+1, trample and infect: ten poison ends you.',
      brackets: [2, 4],
    },
    {
      name: 'Torment of Hailfire',
      colors: ['B'],
      mv: 2,
      cost: 12,
      effect: 'For a big X, everyone loses life, sacrifices or discards until they are out.',
      brackets: [2, 4],
    },
    {
      name: 'Exsanguinate',
      colors: ['B'],
      mv: 2,
      cost: 10,
      effect: 'Each opponent loses X life and they gain it all.',
      brackets: [2, 4],
    },
    {
      name: 'Aetherflux Reservoir',
      colors: [],
      mv: 4,
      cost: 4,
      effect: 'A long storm turn, then 50 life paid to deal 50 damage.',
      brackets: [3, 4],
    },
    {
      name: 'Expropriate',
      colors: ['U'],
      mv: 9,
      cost: 9,
      effect: 'The table votes; they take extra turns and your best permanents.',
      brackets: [3, 4],
    },
    {
      name: "Thassa's Oracle",
      colors: ['U'],
      mv: 2,
      cost: 2,
      effect: 'With Demonic Consultation or Tainted Pact: an empty library, and they win on the trigger.',
      brackets: [4, 5],
    },
    {
      name: 'Underworld Breach',
      colors: ['R'],
      mv: 2,
      cost: 2,
      effect: "With Brain Freeze and Lion's Eye Diamond: the whole graveyard recast until you are decked.",
      brackets: [4, 5],
    },
    {
      name: 'Ad Nauseam',
      colors: ['B'],
      mv: 5,
      cost: 5,
      effect: 'They draw most of their deck at instant speed and win on the spot.',
      brackets: [4, 5],
    },
    {
      name: 'Dockside Extortionist',
      colors: ['R'],
      mv: 2,
      cost: 2,
      effect: 'Treasures for every artifact and enchantment on the table, looped into a storm turn.',
      brackets: [4, 5],
    },
    {
      name: 'Kiki-Jiki, Mirror Breaker',
      colors: ['R'],
      mv: 5,
      cost: 5,
      effect: 'With Zealous Conscripts or Pestermite: infinite hasty attackers.',
      brackets: [3, 5],
    },
    {
      name: 'Food Chain',
      colors: ['G'],
      mv: 3,
      cost: 3,
      effect: 'With a creature that casts from exile: infinite mana into their commander.',
      brackets: [4, 5],
    },
  ],

  /**
   * Standing pieces. Unlike every other table here, these do not finish when the
   * window does: what the seat cast stays on the table and the player keeps
   * paying for it, which is why each one carries a `tell` short enough to sit
   * under the seat all game.
   *
   * The brackets follow the Commander bracket guidelines rather than raw power:
   * graveyard hate is a normal maindeck card from bracket 2, the taxes and the
   * "one spell a turn" pieces are an upgraded-table sight (3), and the ones that
   * turn a deck off outright — Blood Moon, Null Rod, Winter Orb, the Spheres —
   * are bracket 4 and up. Trinisphere is cEDH alone.
   */
  hate: [
    {
      name: 'Rest in Peace',
      colors: ['W'],
      mv: 2,
      cost: 2,
      effect: 'Exile all graveyards. Cards go to exile instead of a graveyard.',
      brackets: [2, 5],
      permanent: 'enchantment',
      tell: 'Your graveyard is exiled as it fills.',
    },
    {
      name: "Grafdigger's Cage",
      colors: [],
      mv: 1,
      cost: 1,
      effect:
        "Creatures can't enter the battlefield from graveyards or libraries, and nobody casts spells from either.",
      brackets: [3, 5],
      permanent: 'artifact',
      tell: 'You cast nothing out of your graveyard or library.',
    },
    {
      name: 'Torpor Orb',
      colors: [],
      mv: 2,
      cost: 2,
      effect: "Creatures entering the battlefield don't cause abilities to trigger.",
      brackets: [3, 5],
      permanent: 'artifact',
      tell: "Your creatures' enters-the-battlefield triggers do not happen.",
    },
    {
      name: 'Hushbringer',
      colors: ['W'],
      mv: 2,
      cost: 2,
      effect: "Creatures entering or dying don't cause abilities to trigger.",
      brackets: [3, 5],
      permanent: 'creature',
      tell: 'Your creatures trigger nothing when they enter and nothing when they die.',
    },
    {
      name: 'Thalia, Guardian of Thraben',
      colors: ['W'],
      mv: 2,
      cost: 2,
      effect: 'Noncreature spells cost 1 more to cast.',
      brackets: [3, 5],
      permanent: 'creature',
      tell: 'Your noncreature spells cost 1 more.',
    },
    {
      name: 'Rule of Law',
      colors: ['W'],
      mv: 3,
      cost: 3,
      effect: "Each player can't cast more than one spell each turn.",
      brackets: [3, 5],
      permanent: 'enchantment',
      tell: 'You cast one spell a turn.',
    },
    {
      name: 'Ethersworn Canonist',
      colors: ['W'],
      mv: 2,
      cost: 2,
      effect: "Each player can't cast more than one nonartifact spell each turn.",
      brackets: [3, 5],
      permanent: 'creature',
      tell: 'You cast one nonartifact spell a turn.',
    },
    {
      name: 'Archon of Emeria',
      colors: ['W'],
      mv: 3,
      cost: 3,
      effect:
        "Each player can't cast more than one spell each turn, and their nonbasic lands enter tapped.",
      brackets: [3, 5],
      permanent: 'creature',
      tell: 'You cast one spell a turn and your nonbasic lands enter tapped.',
    },
    {
      name: 'Stony Silence',
      colors: ['W'],
      mv: 2,
      cost: 2,
      effect: "Activated abilities of artifacts can't be activated.",
      brackets: [3, 5],
      permanent: 'enchantment',
      tell: 'Your mana rocks and every other artifact ability are switched off.',
    },
    {
      name: 'Collector Ouphe',
      colors: ['G'],
      mv: 2,
      cost: 2,
      effect: "Activated abilities of artifacts can't be activated.",
      brackets: [3, 5],
      permanent: 'creature',
      tell: "Your artifacts' activated abilities do not work.",
    },
    {
      name: 'Cursed Totem',
      colors: [],
      mv: 2,
      cost: 2,
      effect: "Activated abilities of creatures can't be activated.",
      brackets: [3, 5],
      permanent: 'artifact',
      tell: "Your creatures' activated abilities do not work.",
    },
    {
      name: 'Linvala, Keeper of Silence',
      colors: ['W'],
      mv: 4,
      cost: 4,
      effect: "Activated abilities of creatures your opponents control can't be activated.",
      brackets: [3, 5],
      permanent: 'creature',
      tell: 'Your creatures have no activated abilities while they hold this.',
    },
    {
      name: "Kataki, War's Wage",
      colors: ['W'],
      mv: 2,
      cost: 2,
      effect: 'Each artifact has "At the beginning of your upkeep, sacrifice this unless you pay 1."',
      brackets: [3, 5],
      permanent: 'creature',
      tell: 'You pay 1 each upkeep for every artifact you control or sacrifice it.',
    },
    {
      name: 'Aven Mindcensor',
      colors: ['W'],
      mv: 3,
      cost: 3,
      effect: 'Opponents who search a library look at only the top four cards of it.',
      brackets: [3, 5],
      permanent: 'creature',
      tell: 'When you search a library, you see only its top four cards.',
    },
    {
      name: 'Blood Moon',
      colors: ['R'],
      mv: 3,
      cost: 3,
      minTurn: 3,
      effect: 'All nonbasic lands are Mountains and lose every other type and ability.',
      brackets: [4, 5],
      permanent: 'enchantment',
      tell: 'Your nonbasic lands are Mountains.',
    },
    {
      name: 'Sphere of Resistance',
      colors: [],
      mv: 2,
      cost: 2,
      effect: 'Spells cost 1 more to cast.',
      brackets: [4, 5],
      permanent: 'artifact',
      tell: 'Every spell you cast costs 1 more.',
    },
    {
      name: 'Null Rod',
      colors: [],
      mv: 2,
      cost: 2,
      effect: "Activated abilities of artifacts can't be activated.",
      brackets: [4, 5],
      permanent: 'artifact',
      tell: 'Your mana rocks make no mana and your artifacts do nothing.',
    },
    {
      name: 'Winter Orb',
      colors: [],
      mv: 2,
      cost: 2,
      effect: 'Players untap only one land during their untap step.',
      brackets: [4, 5],
      permanent: 'artifact',
      tell: 'You untap one land a turn.',
    },
    {
      name: 'Deafening Silence',
      colors: ['W'],
      mv: 1,
      cost: 1,
      effect: "Each player can't cast more than one noncreature spell each turn.",
      brackets: [4, 5],
      permanent: 'enchantment',
      tell: 'You cast one noncreature spell a turn.',
    },
    {
      name: 'Drannith Magistrate',
      colors: ['W'],
      mv: 2,
      cost: 2,
      effect: "Opponents can't cast spells from anywhere other than their hands.",
      brackets: [4, 5],
      permanent: 'creature',
      tell: 'You cast only out of your hand — your commander stays in the command zone.',
    },
    {
      name: 'Opposition Agent',
      colors: ['B'],
      mv: 3,
      cost: 3,
      effect:
        'While an opponent searches their library, its controller does the searching and may play what they find.',
      brackets: [4, 5],
      permanent: 'creature',
      tell: 'They run your tutors and fetches, and keep whatever they find.',
    },
    {
      name: 'Trinisphere',
      colors: [],
      mv: 3,
      cost: 3,
      effect: 'Spells that would cost less than 3 cost 3 instead.',
      brackets: [5, 5],
      permanent: 'artifact',
      tell: 'Nothing you cast costs less than 3.',
    },
  ],
};
