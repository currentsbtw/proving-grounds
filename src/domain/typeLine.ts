/**
 * Type-line reading, front face only.
 *
 * Scryfall prints a two-faced card's type line as both faces joined by ` // `:
 * an Adventure creature reads `Creature — Faerie Rogue // Instant — Adventure`,
 * a modal double-faced land reads `Sorcery // Land`. Testing the whole string
 * makes both of those simultaneously a creature, an instant and a land, which is
 * how an Adventure creature ended up in the graveyard off the stack tray and an
 * MDFC spell was refused as a land.
 *
 * The face the player casts from hand is the front one, so every classification
 * the table makes — is this a land, does this resolve to the graveyard, does it
 * count as a creature — is made on the text before the first separator. This is
 * deliberately not a rules engine: it is the same glance a player takes at the
 * top line of the card.
 *
 * These helpers are shared by the live store and by the two log replayers
 * (`scorecard.ts`, `review.ts`) so that a run scores the way it played.
 */

/** The printed type line of a card's front face. Single-faced lines pass through. */
export function frontFaceTypeLine(typeLine: string): string {
  const cut = typeLine.indexOf(' // ');
  return (cut === -1 ? typeLine : typeLine.slice(0, cut)).trim();
}

export function isLandTypeLine(typeLine: string): boolean {
  return /\bLand\b/i.test(frontFaceTypeLine(typeLine));
}

export function isInstantOrSorceryTypeLine(typeLine: string): boolean {
  return /\b(?:Instant|Sorcery)\b/i.test(frontFaceTypeLine(typeLine));
}

export function isCreatureTypeLine(typeLine: string): boolean {
  return /\bCreature\b/i.test(frontFaceTypeLine(typeLine));
}
