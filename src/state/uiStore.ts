import { create } from 'zustand';
import { useGameStore } from './gameStore';

/**
 * UI-only state: which persisted run the centre panel is showing, and which
 * other run it is being compared against. Deliberately separate from
 * `gameStore` — the game store owns the *live* run and knows nothing about the
 * scorecard's selection, so ending a run stays a game concern and "show me that
 * scorecard" stays a UI one. The bridge between the two is the subscription at
 * the bottom of this file.
 */
export interface UiState {
  /** Persisted run whose scorecard the centre panel shows, or null for the table. */
  selectedRunId: string | null;
  /** Second run in the A/B view, or null. Always cleared when the selection moves. */
  compareRunId: string | null;
  selectRun: (id: string | null) => void;
  setCompare: (id: string | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  selectedRunId: null,
  compareRunId: null,

  selectRun(id) {
    // A new selection invalidates the comparison — B is only meaningful next to
    // the A it was picked for.
    set({ selectedRunId: id, compareRunId: null });
  },

  setCompare(id) {
    set((state) => ({ compareRunId: id === state.selectedRunId ? null : id }));
  },
}));

/**
 * The run lifecycle drives the selection: finishing a run selects it, so the
 * scorecard replaces the table the moment the game ends; starting one clears the
 * selection so the table comes back.
 *
 * Nullness is compared rather than object identity — `run` is replaced on every
 * log append, and reacting to those would reset the selection hundreds of times
 * per game.
 */
useGameStore.subscribe((state, prev) => {
  const now = state.run?.id ?? null;
  const before = prev.run?.id ?? null;
  if (now === before) return;
  // `endRun` awaits the Dexie write before clearing `run`, so by the time this
  // fires the record the scorecard is about to read is already persisted.
  useUiStore.getState().selectRun(now === null ? before : null);
});
