/**
 * Keyword glossary: what a Magic keyword does, said the way a table would say
 * it, plus the Comprehensive Rules section to look it up in.
 *
 * The trainer prints real oracle text and real card effects at a player who is
 * learning to read a board under pressure, and the thing that stops that read
 * is a word they half-know. So every entry is two beats: what the keyword does,
 * then the one thing players get wrong about it — indestructible still dying to
 * −X/−X, hexproof doing nothing against a wipe, exile not being the graveyard.
 * Reminder text alone would not earn its screen space; the gotcha does.
 *
 * `cr` is the real rules section, `701.x` for keyword actions and `702.x` for
 * keyword abilities, so a player who wants the letter of it knows where to
 * look. That is also why ability words (landfall, constellation) and the
 * predefined tokens (Treasure, Food) are absent: they live outside 701/702, and
 * an entry that cites a number it cannot back up is worse than no entry.
 */

export interface KeywordEntry {
  /** The printed term, capitalised the way a card prints it. */
  term: string;
  /** One or two sentences: what it does, then the gotcha. */
  text: string;
  /** Comprehensive Rules section — 701.x keyword actions, 702.x keyword abilities. */
  cr: string;
}

export const KEYWORDS: readonly KeywordEntry[] = [
  /* Evergreen ------------------------------------------------------------ */
  {
    term: 'Deathtouch',
    text: 'Any nonzero damage this deals to a creature is enough to destroy it. It works by making the damage lethal, so an indestructible creature still shrugs it off.',
    cr: '702.2',
  },
  {
    term: 'Defender',
    text: "This creature can't attack. It can still block, still tap for abilities, and can still be turned into an attacker by an effect that removes defender.",
    cr: '702.3',
  },
  {
    term: 'Double strike',
    text: 'Deals its combat damage twice: once in the first-strike step, then again in the normal one. A blocker that dies to the first hit never deals damage back.',
    cr: '702.4',
  },
  {
    term: 'Enchant',
    text: 'Names what this Aura may be attached to, and you must choose a legal target as you cast it. If nothing legal is left when it resolves the Aura is countered, and one already on the battlefield with an illegal target is put into the graveyard.',
    cr: '702.5',
  },
  {
    term: 'Equip',
    text: 'Pay the cost to attach this Equipment to a creature you control. Sorcery speed only, and the Equipment stays on the battlefield when that creature leaves — it does not follow it.',
    cr: '702.6',
  },
  {
    term: 'First strike',
    text: 'Deals its combat damage in a separate step before creatures without it. Whatever it kills there never deals damage back, unless that creature also has first or double strike.',
    cr: '702.7',
  },
  {
    term: 'Flash',
    text: 'You may cast this any time you could cast an instant. It changes nothing else: a creature cast this way still cannot attack the turn it arrives unless it has haste.',
    cr: '702.8',
  },
  {
    term: 'Flying',
    text: 'This creature can be blocked only by creatures with flying or reach. It can still block anything, ground creatures included.',
    cr: '702.9',
  },
  {
    term: 'Haste',
    text: 'This creature can attack and use its tap abilities the turn it comes under your control. That summoning-sick restriction is the only thing haste removes.',
    cr: '702.10',
  },
  {
    term: 'Hexproof',
    text: "Your opponents can't target this with spells or abilities; you still can. It does nothing against a board wipe, an edict, or anything else that never targets.",
    cr: '702.11',
  },
  {
    term: 'Indestructible',
    text: 'Damage and the word "destroy" don\'t kill it. It still dies to −X/−X or a toughness set to 0, and it can still be sacrificed, exiled, or bounced.',
    cr: '702.12',
  },
  {
    term: 'Lifelink',
    text: 'Damage this deals also gains you that much life. It happens as part of the damage rather than as a trigger, so nobody gets a chance to respond in between.',
    cr: '702.15',
  },
  {
    term: 'Menace',
    text: "This creature can't be blocked except by two or more creatures. One blocker is never enough, however large it is.",
    cr: '702.111',
  },
  {
    term: 'Protection',
    text: 'From a given quality, this cannot be Damaged, Enchanted or Equipped, Blocked, or Targeted by anything with that quality — DEBT. It does not stop a sacrifice, a −X/−X, or a wipe that never targets it.',
    cr: '702.16',
  },
  {
    term: 'Reach',
    text: 'This creature can block creatures with flying. It gains nothing on offense.',
    cr: '702.17',
  },
  {
    term: 'Trample',
    text: 'Assign lethal damage to the blockers and the rest hits the defending player. Lethal counts damage already marked and deathtouch, so a deathtouch trampler need only assign 1 to each blocker.',
    cr: '702.19',
  },
  {
    term: 'Vigilance',
    text: "Attacking doesn't tap this creature, so it can attack and still block. It does not untap a creature that is already tapped.",
    cr: '702.20',
  },
  {
    term: 'Ward',
    text: "Whenever an opponent targets this, their spell or ability is countered unless they pay the ward cost. It's a trigger, so it can be responded to, and it does nothing against effects that never target.",
    cr: '702.21',
  },
  {
    term: 'Shroud',
    text: 'This cannot be the target of any spell or ability at all, including your own. That is the difference from hexproof: shroud locks you out too.',
    cr: '702.18',
  },

  /* Keyword actions ------------------------------------------------------ */
  {
    term: 'Exile',
    text: 'Puts a card into the exile zone, face up unless the effect says otherwise. Exile is not the graveyard: it dodges regeneration, most recursion, and anything that cares about a card hitting the yard.',
    cr: '701.13',
  },
  {
    term: 'Sacrifice',
    text: "Move a permanent you control to its owner's graveyard. You can only sacrifice what you control, it cannot be prevented or responded to once it's a cost, and indestructible does not help.",
    cr: '701.21',
  },
  {
    term: 'Fight',
    text: 'Each creature deals damage equal to its power to the other. Both have to still be on the battlefield when it resolves, or no damage is dealt at all.',
    cr: '701.14',
  },
  {
    term: 'Goad',
    text: 'Until your next turn that creature attacks each combat if able, and must attack someone other than you if it can. If you are its only legal option, it still comes at you.',
    cr: '701.15',
  },
  {
    term: 'Mill',
    text: 'Put that many cards from the top of your library into your graveyard. It is neither a draw nor damage, so nothing that stops either one stops this.',
    cr: '701.17',
  },
  {
    term: 'Scry',
    text: 'Look at that many cards from the top of your library, put any number of them on the bottom, and the rest back on top in any order. You do not draw them.',
    cr: '701.22',
  },
  {
    term: 'Surveil',
    text: 'Look at that many cards from the top and put any number into your graveyard, the rest back on top in any order. Unlike scry, what you skip goes to the yard — which is usually the point.',
    cr: '701.25',
  },
  {
    term: 'Proliferate',
    text: 'Choose any number of permanents and players that have counters on them and give each one more of every kind it already has. It can only add counters that are already there — never a new kind.',
    cr: '701.34',
  },
  {
    term: 'Populate',
    text: "Create a token that's a copy of a creature token you control. Creature tokens only, and only ones already on your battlefield.",
    cr: '701.36',
  },
  {
    term: 'Investigate',
    text: 'Create a Clue: a colorless artifact token with "{2}, Sacrifice this artifact: Draw a card." Investigating draws nothing by itself; the card costs {2} later.',
    cr: '701.16',
  },
  {
    term: 'Connive',
    text: 'Draw a card, then discard a card; if the discard was a nonland card, put a +1/+1 counter on the conniving creature. Pitch a land and you get no counter.',
    cr: '701.50',
  },
  {
    term: 'Adapt',
    text: 'If this creature has no +1/+1 counters, put that many on it; if it already has one, nothing happens. Anything that grew it earlier switches adapt off.',
    cr: '701.46',
  },
  {
    term: 'Amass',
    text: 'Put that many +1/+1 counters on an Army you control, first creating a 0/0 Army token if you have none. The counters always pile onto one Army; you never end up with two.',
    cr: '701.47',
  },
  {
    term: 'Cloak',
    text: 'Put a card onto the battlefield face down as a 2/2 creature with ward {2}. You may turn it face up any time for its mana cost if it is a creature card — the same shell disguise uses, done to a card rather than cast by you.',
    cr: '701.58',
  },

  /* Cost and cast keywords ----------------------------------------------- */
  {
    term: 'Cascade',
    text: 'When you cast this, exile cards from the top of your library until you hit a nonland card with a lesser mana value, then you may cast that one for free. The rest go on the bottom in a random order, and the free spell resolves before the spell that cascaded.',
    cr: '702.85',
  },
  {
    term: 'Convoke',
    text: 'Tap any creature you control to pay {1} or one mana of its color toward this spell. Tapping for convoke is a cost, not a tap ability, so a creature that just arrived can help.',
    cr: '702.51',
  },
  {
    term: 'Cycling',
    text: 'Pay the cycling cost and discard this card to draw a card. It is an activated ability from your hand, not a spell, so the card is never cast and counterspells cannot touch it.',
    cr: '702.29',
  },
  {
    term: 'Flashback',
    text: 'Cast this from your graveyard for its flashback cost. It exiles itself as it leaves the stack, so you get exactly one extra use.',
    cr: '702.34',
  },
  {
    term: 'Kicker',
    text: 'An optional extra cost you may pay as you cast the spell. The choice is locked in at cast time, not on resolution, and the kicked effect is part of that same spell.',
    cr: '702.33',
  },
  {
    term: 'Affinity',
    text: 'This spell costs {1} less to cast for each of the named thing you have. It only reduces the generic part of the cost — never the colored pips.',
    cr: '702.41',
  },
  {
    term: 'Storm',
    text: 'When you cast this, copy it once for each spell cast before it this turn. The copies are put on the stack rather than cast, so nothing that triggers on casting sees them.',
    cr: '702.40',
  },
  {
    term: 'Delve',
    text: 'Exile cards from your graveyard as you cast this; each one pays for {1}. It pays generic mana only, and those cards are gone for good.',
    cr: '702.66',
  },
  {
    term: 'Dredge',
    text: 'Instead of drawing a card, you may mill that many cards and return this from your graveyard to your hand. It replaces the draw, so you never actually drew — anything keyed to drawing does not trigger.',
    cr: '702.52',
  },
  {
    term: 'Escape',
    text: 'Cast this from your graveyard for its escape cost, which includes exiling other cards from your graveyard. Those cards are a cost, so they are exiled even if the spell is countered.',
    cr: '702.138',
  },
  {
    term: 'Foretell',
    text: 'Pay {2} to exile this face down from your hand, then cast it later for its foretell cost. Foretelling is sorcery speed, and the card cannot be cast this way until a turn after it was hidden.',
    cr: '702.143',
  },
  {
    term: 'Overload',
    text: 'Cast it for the overload cost and every "target" on the card becomes "each." With no targets it cannot be fizzled by a single hexproof or protected permanent.',
    cr: '702.96',
  },
  {
    term: 'Unearth',
    text: 'Pay the cost to return this from your graveyard to the battlefield with haste; it is exiled at the beginning of the next end step. Sorcery speed only, and it leaves for good at end of turn.',
    cr: '702.84',
  },
  {
    term: 'Blitz',
    text: 'Cast it for its blitz cost: it gains haste and draws you a card when it dies, but you sacrifice it at the next end step. It is an alternative cost, so you never pay the printed mana cost as well.',
    cr: '702.152',
  },
  {
    term: 'Casualty',
    text: 'As an additional cost you may sacrifice a creature with power N or greater to copy the spell. The sacrifice happens as you cast, before anyone can respond, and the copy may choose new targets.',
    cr: '702.153',
  },
  {
    term: 'Bargain',
    text: 'As an additional cost you may sacrifice an artifact, enchantment, or token to make the spell better. Any token counts, which is what makes bargaining cheap.',
    cr: '702.166',
  },
  {
    term: 'Craft',
    text: 'Pay the cost and exile this permanent along with the listed materials to return it transformed. Sorcery speed only, and the materials may come from the battlefield or from your graveyard.',
    cr: '702.167',
  },
  {
    term: 'Disguise',
    text: 'Cast this face down for {3} as a 2/2 with ward {2}, then turn it face up any time by paying its disguise cost. Turning it up is a special action, not a spell or ability, so it cannot be responded to.',
    cr: '702.168',
  },
  {
    term: 'Gift',
    text: 'You may promise an opponent the listed gift as an additional cost; if you do, they receive it and your spell does something better. The opponent gets their half first.',
    cr: '702.174',
  },
  {
    term: 'Offspring',
    text: 'Pay the extra offspring cost as you cast it and a copy of it enters alongside as a 1/1 token. The copy is 1/1 no matter how large the original is.',
    cr: '702.175',
  },
  {
    term: 'Impending',
    text: 'Cast it cheaply for its impending cost and it enters with that many time counters, and is not a creature while any remain. One counter comes off at the beginning of each of your end steps.',
    cr: '702.176',
  },
  {
    term: 'Mutate',
    text: 'Cast it for its mutate cost onto a non-Human creature you own, merging the two into one creature that keeps every ability of both. It is a single permanent, so one removal spell takes the whole pile.',
    cr: '702.140',
  },
  {
    term: 'Split second',
    text: "While this is on the stack, players can't cast spells or activate abilities that aren't mana abilities. Triggers still trigger and still resolve normally.",
    cr: '702.61',
  },

  /* Combat and board keywords -------------------------------------------- */
  {
    term: 'Annihilator',
    text: 'Whenever this attacks, the defending player sacrifices that many permanents. It happens as it attacks, before blockers are declared, and the defender chooses what to lose.',
    cr: '702.86',
  },
  {
    term: 'Prowess',
    text: 'Whenever you cast a noncreature spell, this gets +1/+1 until end of turn. It triggers on casting, so it grows even if that spell is countered.',
    cr: '702.108',
  },
  {
    term: 'Exploit',
    text: 'When this enters, you may sacrifice a creature — including this one. The payoff is a second trigger that only happens if a creature was actually exploited.',
    cr: '702.110',
  },
  {
    term: 'Extort',
    text: 'Whenever you cast a spell you may pay {W/B}: each opponent loses 1 life and you gain that much. Against a full pod that is 3 life a spell, and each instance of extort triggers separately.',
    cr: '702.101',
  },
  {
    term: 'Undying',
    text: 'When it dies, it returns to the battlefield with a +1/+1 counter — unless it already had one. Once that counter is on it, the next death is permanent.',
    cr: '702.93',
  },
  {
    term: 'Persist',
    text: 'When it dies, it returns to the battlefield with a −1/−1 counter — unless it already had one. Anything that removes the counter turns it back into a loop.',
    cr: '702.79',
  },
  {
    term: 'Myriad',
    text: 'When this attacks, you may create a tapped attacking copy of it for each other opponent. Those copies are exiled at end of combat, so their attack triggers and damage are the whole payoff.',
    cr: '702.116',
  },
  {
    term: 'Melee',
    text: 'When this attacks, it gets +1/+1 until end of turn for each opponent you attacked with a creature this combat. You have to spread the attack across players to grow it.',
    cr: '702.121',
  },
  {
    term: 'Cipher',
    text: 'As it resolves you may exile it encoded on a creature you control, and that creature casts a free copy whenever it deals combat damage to a player. The card sits in exile, so killing the creature does not return it.',
    cr: '702.99',
  },
  {
    term: 'Infect',
    text: 'Damage to players is dealt as poison counters and damage to creatures as −1/−1 counters. Ten poison eliminates a player, and infect damage never reduces life totals.',
    cr: '702.90',
  },
  {
    term: 'Toxic',
    text: 'Combat damage this deals to a player also gives them that many poison counters. Unlike infect, the damage still takes life as normal.',
    cr: '702.164',
  },
  {
    term: 'Wither',
    text: 'Damage this deals to creatures is dealt as −1/−1 counters instead. The counters stay after the turn ends, and indestructible does not stop them.',
    cr: '702.80',
  },
  {
    term: 'Phasing',
    text: "A phased-out permanent is treated as though it doesn't exist, and it phases back in at its controller's untap step. It never leaves the battlefield, so Auras stay attached and nothing triggers on it leaving or entering.",
    cr: '702.26',
  },
  {
    term: 'Riot',
    text: 'As this enters, choose a +1/+1 counter or haste. The choice is made on the battlefield, not while casting.',
    cr: '702.136',
  },
  {
    term: 'Mentor',
    text: 'When this attacks, put a +1/+1 counter on an attacking creature with lesser power. The other creature has to be attacking already, and has to be strictly smaller.',
    cr: '702.134',
  },
  {
    term: 'Training',
    text: 'When this attacks alongside a creature with greater power, put a +1/+1 counter on it. Both must be attacking, and the partner has to be strictly bigger.',
    cr: '702.149',
  },
  {
    term: 'Backup',
    text: "When this enters, put that many +1/+1 counters on a target creature; if that is another creature, it also gains this card's other abilities until end of turn. Aim it at itself and you just keep the counters.",
    cr: '702.165',
  },
  {
    term: 'Boast',
    text: 'Activate this only if the creature attacked this turn, and only once each turn. It is an activated ability, so opponents get to respond to it.',
    cr: '702.142',
  },
  {
    term: 'Disturb',
    text: 'Cast the back face from your graveyard for its disturb cost. That permanent is exiled instead of dying, so you get one trip only.',
    cr: '702.146',
  },
  {
    term: 'Decayed',
    text: "It can't block, and it's sacrificed after it attacks. One attack, and never a defender.",
    cr: '702.147',
  },
  {
    term: 'Daybound',
    text: 'While it is day this creature is on its front face; if the active player casts no spells during their turn, it becomes night and every daybound permanent transforms. Day and night are a game-wide state, so they all flip together.',
    cr: '702.145',
  },
  {
    term: 'Nightbound',
    text: 'The night-side counterpart of daybound: it becomes day again if the active player casts two or more spells in a turn, and every nightbound permanent transforms at once.',
    cr: '702.145',
  },
  {
    term: 'Station',
    text: "Tap another untapped creature you control to put charge counters on this equal to that creature's power. Sorcery speed, and the creature you tap may be one that just arrived.",
    cr: '702.184',
  },
  {
    term: 'Partner',
    text: 'You may run two commanders if both have partner. Both count toward your color identity, and each keeps its own commander tax and its own commander damage.',
    cr: '702.124',
  },
];

/**
 * Terms keyed by lowercase, because every lookup site — the tokenizer, a future
 * search box — has the word as the player wrote it rather than as the card
 * prints it.
 */
export const KEYWORDS_BY_TERM: ReadonlyMap<string, KeywordEntry> = new Map(
  KEYWORDS.map((entry) => [entry.term.toLowerCase(), entry]),
);

/** Case-insensitive glossary lookup. */
export function lookupKeyword(term: string): KeywordEntry | undefined {
  return KEYWORDS_BY_TERM.get(term.toLowerCase());
}
