/**
 * Wall-clock durations, printed the one way the app prints them: `m:ss`.
 *
 * Shared by the player bar's shot-clock reading and by the review's over-clock
 * finding, because a player who watched the bar tick to `2:18` has to read
 * `2:18` back in the debrief; two formatters would eventually disagree about
 * where the minute rolls over.
 */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}
