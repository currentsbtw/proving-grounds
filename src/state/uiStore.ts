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
/** Which deck and seed the keep/mull drill is running on, or null for no drill. */
export interface DrillTarget {
  deckId: string;
  /** The seed hand 1 starts from. Blank means the drill picks a random one. */
  seed: string;
}

export interface UiState {
  /** Persisted run whose scorecard the centre panel shows, or null for the table. */
  selectedRunId: string | null;
  /** Second run in the A/B view, or null. Always cleared when the selection moves. */
  compareRunId: string | null;
  /**
   * The hand drill in the centre panel, or null. Like the selection, this is a
   * UI concern and not the game store's: the drill deals hands off a seed
   * without a run existing, and the store must not learn about it.
   */
  drill: DrillTarget | null;
  selectRun: (id: string | null) => void;
  setCompare: (id: string | null) => void;
  openDrill: (target: DrillTarget) => void;
  closeDrill: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  selectedRunId: null,
  compareRunId: null,
  drill: null,

  selectRun(id) {
    // A new selection invalidates the comparison — B is only meaningful next to
    // the A it was picked for. The centre panel holds one thing at a time, so
    // asking for a scorecard is also asking for the drill to stand down.
    set((state) => ({
      selectedRunId: id,
      compareRunId: null,
      drill: id === null ? state.drill : null,
    }));
  },

  openDrill(target) {
    set({ drill: target, selectedRunId: null, compareRunId: null });
  },

  closeDrill() {
    set({ drill: null });
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
  // A live run takes the centre panel, so a drill left open behind it stands
  // down rather than waiting to reappear when the run ends.
  if (now !== null) useUiStore.getState().closeDrill();
});
