import type { Scorecard } from '../../engine/scorecard';
import type { DeckProfile } from '../../engine/scorecard';

/** Pixel size of the shareable card. 2:1 so it posts cleanly to Discord/Twitter. */
export const SHARE_IMAGE_WIDTH = 1200;
export const SHARE_IMAGE_HEIGHT = 600;

export interface ShareImageOptions {
  /** Optional aggregate to print the deck's tags under the header. */
  profile?: DeckProfile;
}

/**
 * Render a run's scorecard as a PNG blob using a 2D canvas. No external
 * libraries: the app is local-first and must build offline.
 */
export async function renderScorecardPng(
  _card: Scorecard,
  _options?: ShareImageOptions,
): Promise<Blob> {
  throw new Error('renderScorecardPng: not implemented yet');
}
