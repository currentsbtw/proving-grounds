import { NO_VALUE } from './verdict';

/**
 * A figure, or the muted "n/a" that says there was nothing to measure.
 *
 * Every printed number on the scorecard goes through this — the metric slots,
 * the deck profile, the card table — because "no value" has to look the same
 * wherever it lands: `is-na` is what makes it recede instead of sitting at the
 * weight of a real reading beside it. The string and the styling that says the
 * string is not a number are one decision, so they are made in one place rather
 * than left to each caller to remember.
 *
 * `className` is the caller's own slot class (`sc-tile-value` and the like);
 * `num` and `is-na` are added here.
 */
export function Figure({ value, className }: { value: string; className?: string }) {
  const classes = ['num', className, value === NO_VALUE ? 'is-na' : ''].filter(Boolean).join(' ');
  return <span className={classes}>{value}</span>;
}
