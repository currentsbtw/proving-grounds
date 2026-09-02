/** Standard MTG card aspect (height / width). */
export const CARD_ASPECT = 1.396;

export function cardHeight(width: number): number {
  return Math.round(width * CARD_ASPECT);
}
