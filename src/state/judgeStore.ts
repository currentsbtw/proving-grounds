import { create } from 'zustand';
import { useGameStore } from './gameStore';
import { buildTableContext } from '../features/judge/tableContext';
import { JudgeServiceError, askJudge, judgeErrorSentence } from '../services/judge';
import type { JudgeErrorCode, JudgeResponse } from '../domain/judge';

/**
 * The judge drawer's transcript. Deliberately outside the game store: a question
 * is not a table action, nothing here is replayed by a seed, and none of it ever
 * reaches the run log. Asking the judge changes nothing about the run.
 */

/** One question and whatever came back for it. */
export interface JudgeEntry {
  /** React key. Monotonic within the session; never persisted. */
  id: string;
  question: string;
  /** Wall clock, for ordering only. */
  askedAt: number;
  /** The turn the question was asked on, so an old answer reads as old. */
  turn: number;
  response?: JudgeResponse;
  error?: { code: JudgeErrorCode; message: string };
}

/** How much of the transcript the drawer keeps. Older questions fall off the top. */
const MAX_ENTRIES = 30;

let nextId = 0;

export interface JudgeState {
  /** Oldest first. The panel renders them the other way up. */
  entries: JudgeEntry[];
  pending: boolean;
  /** Snapshot the table, ask, and append whatever came back. */
  ask: (question: string) => Promise<void>;
  clear: () => void;
}

export const useJudgeStore = create<JudgeState>((set, get) => ({
  entries: [],
  pending: false,

  async ask(question) {
    const text = question.trim();
    if (text === '' || get().pending) return;

    // One snapshot, taken before the await: the answer is about the table as it
    // stood when the question was asked, not as it stands when it comes back.
    const game = useGameStore.getState();
    // The run the question was asked in. An answer that lands after the player
    // has started or ended a run belongs to a table that no longer exists, so it
    // is dropped rather than appended under the new run's turn stamp.
    const runId = game.run?.id ?? null;
    const entry: JudgeEntry = {
      id: `jd-${++nextId}`,
      question: text,
      askedAt: Date.now(),
      turn: game.turn,
    };
    const table = game.run ? buildTableContext(game) : undefined;

    set({ pending: true });
    try {
      entry.response = await askJudge({ question: text, table });
    } catch (err) {
      const code: JudgeErrorCode = err instanceof JudgeServiceError ? err.code : 'upstream';
      const message =
        err instanceof JudgeServiceError ? err.message : judgeErrorSentence('upstream');
      entry.error = { code, message };
    } finally {
      const stillSameRun = (useGameStore.getState().run?.id ?? null) === runId;
      set((s) => ({
        pending: false,
        entries: stillSameRun ? [...s.entries, entry].slice(-MAX_ENTRIES) : s.entries,
      }));
    }
  },

  clear() {
    // An in-flight ask cannot be recalled, so the flag it left behind is reset
    // here; its answer drops itself on the run-id check above.
    set({ entries: [], pending: false });
  },
}));

/**
 * A transcript belongs to the table it was asked about. Starting or ending a run
 * empties it, on the same run-id comparison `uiStore` uses — `run` is replaced on
 * every log append, so object identity would clear the drawer hundreds of times
 * a game.
 */
useGameStore.subscribe((state, prev) => {
  if ((state.run?.id ?? null) === (prev.run?.id ?? null)) return;
  useJudgeStore.getState().clear();
});
