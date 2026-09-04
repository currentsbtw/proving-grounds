/** Standard MTG card aspect (height / width). */
export const CARD_ASPECT = 1.396;

/**
 * One card width for the whole bottom strip: the command zone, the library
 * back, the graveyard and exile top cards, and every card in hand. The strip
 * reads as one row of the player's own cards, and a hand card that was half
 * again the size of the card beside it read as a different kind of object.
 * table.css carries the same figure in `--strip-card` for the frames and empty
 * slots the DOM draws rather than a card; the two have to move together.
 */
export const STRIP_CARD_WIDTH = 105;

export function cardHeight(width: number): number {
  return Math.round(width * CARD_ASPECT);
}
