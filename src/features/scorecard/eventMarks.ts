import type { EventType } from '../../domain/types';

/**
 * How an event class is marked wherever it is too small to carry its own name:
 * the turn-by-turn chart in the app, and the shareable PNG.
 *
 * The mana colour stays as the mnemonic, but it is never the only channel —
 * removal and resource are both black, and a marker a few pixels across cannot
 * be read by hue at all. Both consumers print the key beside the chart, so the
 * letters are never something a reader has to already know.
 *
 * The letters are deliberately not the class names' initials: BOARD WIPE,
 * REMOVAL, RESOURCE and RACE CLOCK would all be R or B, and COUNTERSPELL and
 * COMBAT would both be C.
 */
export const EVENT_MARK: Record<EventType, string> = {
  wipe: 'W',
  removal: 'R',
  resource: 'S',
  counter: 'C',
  combat: 'A',
  clock: 'K',
};

/** The key, in the reading order both charts print it in. */
export const EVENT_MARK_KEY: { type: EventType; word: string }[] = [
  { type: 'wipe', word: 'wrath' },
  { type: 'removal', word: 'removal' },
  { type: 'resource', word: 'resource' },
  { type: 'counter', word: 'counter' },
  { type: 'combat', word: 'attack' },
  { type: 'clock', word: 'clock' },
];
