import type { LogEntry } from '../../domain/types';
import { useGameStore } from '../../state/gameStore';
import { EVENT_LABEL } from './pressureUi';

const EMPTY: LogEntry[] = [];

/** How many fronts the margin keeps. Older ones live in the log drawer. */
const KEPT = 6;

/** One front that has already passed: the turn it landed, its class, its end. */
interface Passed {
  seq: number;
  turn: number;
  word: string;
  outcome: string;
}

/**
 * How the entry ended its event, or null if the entry did not end one.
 *
 * Two entries end an event, and both carry the machine-readable event payload:
 * a `respond` entry with `responded: true` is an event the player answered, and
 * an `event` entry with `resolved: true` is one that was let through. Anything
 * without an `eventType` — a removed hate piece, a declared clock with no
 * warning card — is not a front and is left to the drawer.
 */
function outcomeOf(entry: LogEntry): string | null {
  if (typeof entry.payload.eventType !== 'string') return null;
  if (entry.payload.responded === true) return 'answered';
  if (entry.payload.resolved === true) return 'resolved';
  return null;
}

/**
 * The run's spent weather, read off the log and never written back to it. The
 * class comes from `eventType` and the turn from `eventTurn`, which is the turn
 * the event arrived in front of the player rather than the turn the answer
 * landed on.
 */
function readPassed(log: LogEntry[]): Passed[] {
  const passed: Passed[] = [];
  for (let i = log.length - 1; i >= 0 && passed.length < KEPT; i -= 1) {
    const entry = log[i];
    const outcome = outcomeOf(entry);
    if (!outcome) continue;

    // Read by a string rather than by a known `EventType`: an old run may carry
    // a class this build no longer names, and the margin prints what it finds
    // rather than dropping the line.
    const type = entry.payload.eventType as string;
    const turn = entry.payload.eventTurn;
    passed.push({
      seq: entry.seq,
      turn: typeof turn === 'number' ? turn : entry.turn,
      word: (EVENT_LABEL as Record<string, string | undefined>)[type] ?? type.toUpperCase(),
      outcome,
    });
  }
  // Read backwards, printed forwards: newest at the bottom, the way the log runs.
  return passed.reverse();
}

/**
 * The last answer, kept so the strip is derived once per event rather than once
 * per store tick. Every tap, draw and card move appends to the log, and each of
 * those handed the strip a new array to walk the tail of; almost none of them
 * change a word in it.
 *
 * The log is append-only within a run, so a scan that already reached index
 * `len` only has to look at what has arrived since — and only an entry that ends
 * an event can move the strip. When the tail no longer matches what was there
 * (a new run, a loaded run), the walk starts over.
 */
let memo: { len: number; tailSeq: number | null; passed: Passed[] } | null = null;

function passedOf(log: LogEntry[]): Passed[] {
  const tailSeq = log.length > 0 ? log[log.length - 1].seq : null;

  if (memo && log.length >= memo.len && (memo.len === 0 || log[memo.len - 1]?.seq === memo.tailSeq)) {
    let ended = false;
    for (let i = memo.len; i < log.length; i += 1) {
      if (outcomeOf(log[i])) {
        ended = true;
        break;
      }
    }
    if (!ended) {
      memo = { len: log.length, tailSeq, passed: memo.passed };
      return memo.passed;
    }
  }

  const passed = readPassed(log);
  memo = { len: log.length, tailSeq, passed };
  return passed;
}

/**
 * The spent weather strip in the board's left margin: the fronts this run has
 * already been through, struck through in rain grey.
 *
 * Decorative — the log drawer is the accessible record of the same events, in
 * full — so the strip is hidden from assistive tech rather than repeating it.
 */
export default function SpentWeather() {
  // Selected as the derived list rather than as the log: `passedOf` hands back
  // the same array until an event actually ends, so the store's other traffic
  // does not re-render the strip at all.
  const passed = useGameStore((s) => passedOf(s.run?.log ?? EMPTY));

  if (passed.length === 0) return null;

  return (
    <div className="pgw" aria-hidden="true">
      <span className="panel-heading pgw-label">passed</span>
      <ul className="pgw-list">
        {passed.map((row) => (
          <li className="pgw-row" key={row.seq}>
            T{row.turn} · {row.word} · {row.outcome}
          </li>
        ))}
      </ul>
    </div>
  );
}
