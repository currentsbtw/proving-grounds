import { create } from 'zustand';
import { getSetting, setSetting } from '../db/db';

export type ActionId =
  | 'nextPhase'
  | 'nextTurn'
  | 'draw'
  | 'shuffle'
  | 'untap'
  | 'mulligan'
  | 'focusNote'
  | 'help';

export interface HotkeyAction {
  id: ActionId;
  label: string;
  /** Extra qualifier shown under the label in the help overlay. */
  note?: string;
  defaultKey: string;
}

/** Every binding, in the order the help overlay lists them. */
export const HOTKEY_ACTIONS: readonly HotkeyAction[] = [
  { id: 'nextPhase', label: 'Next phase', defaultKey: 'Space' },
  { id: 'nextTurn', label: 'Next turn', defaultKey: 't' },
  { id: 'draw', label: 'Draw a card', defaultKey: 'd' },
  { id: 'shuffle', label: 'Shuffle library', defaultKey: 's' },
  { id: 'untap', label: 'Untap all', defaultKey: 'u' },
  {
    id: 'mulligan',
    label: 'Take a mulligan',
    note: 'only while the opening hand is undecided',
    defaultKey: 'm',
  },
  { id: 'focusNote', label: 'Jump to the note box', defaultKey: 'n' },
  { id: 'help', label: 'Show this help', defaultKey: '?' },
];

export type Keymap = Record<ActionId, string>;

export const DEFAULT_KEYMAP: Keymap = Object.fromEntries(
  HOTKEY_ACTIONS.map((a) => [a.id, a.defaultKey]),
) as Keymap;

/** Dexie settings key the keymap persists under. */
export const KEYMAP_SETTING = 'keymap';

const ACTION_IDS = new Set<string>(HOTKEY_ACTIONS.map((a) => a.id));

/** Keys we refuse to bind: they carry meaning the app should not steal. */
const UNBINDABLE = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'CapsLock',
  'Tab',
  'Escape',
  'ContextMenu',
  'Dead',
]);

/**
 * Canonical token for a key press. Space gets a readable name; printable keys
 * are lower-cased so Shift+D and D bind the same way; everything else keeps its
 * `KeyboardEvent.key` spelling ('ArrowUp', 'Enter', …).
 */
export function normalizeKey(e: KeyboardEvent): string {
  if (e.key === ' ' || e.key === 'Spacebar') return 'Space';
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

/** Chip text for a canonical token. */
export function keyLabel(token: string): string {
  if (token === 'Space') return 'Space';
  return token.length === 1 ? token.toUpperCase() : token;
}

export function isBindable(token: string): boolean {
  return token.length > 0 && !UNBINDABLE.has(token);
}

/** Which action a key press triggers, or null. */
export function actionForKey(keymap: Keymap, token: string): ActionId | null {
  for (const action of HOTKEY_ACTIONS) {
    if (keymap[action.id] === token) return action.id;
  }
  return null;
}

function sanitize(raw: unknown): Keymap {
  const map: Keymap = { ...DEFAULT_KEYMAP };
  if (!raw || typeof raw !== 'object') return map;
  for (const [id, key] of Object.entries(raw as Record<string, unknown>)) {
    if (!ACTION_IDS.has(id)) continue;
    if (typeof key !== 'string' || key.length === 0) continue;
    if (!isBindable(key)) continue;
    map[id as ActionId] = key;
  }
  return map;
}

function persist(map: Keymap): void {
  void setSetting(KEYMAP_SETTING, map).catch((err) => {
    console.error('Failed to persist keymap', err);
  });
}

export interface HotkeyState {
  keymap: Keymap;
  /** True once the stored keymap has been read back (or failed to read). */
  loaded: boolean;
  helpOpen: boolean;
  /** Action currently waiting for a key press, or null. */
  binding: ActionId | null;
  bindError: string | null;

  loadKeymap: () => Promise<void>;
  /** Returns false (and sets bindError) when the key is taken or unbindable. */
  bind: (action: ActionId, key: string) => boolean;
  resetKeymap: () => void;
  setHelpOpen: (open: boolean) => void;
  toggleHelp: () => void;
  startBinding: (action: ActionId) => void;
  cancelBinding: () => void;
}

/**
 * Keyboard bindings plus the help overlay's UI state. Separate from the game
 * store on purpose: nothing here belongs in the run log.
 */
export const useHotkeyStore = create<HotkeyState>((set, get) => ({
  keymap: DEFAULT_KEYMAP,
  loaded: false,
  helpOpen: false,
  binding: null,
  bindError: null,

  async loadKeymap() {
    try {
      const stored = await getSetting<unknown>(KEYMAP_SETTING);
      set({ keymap: sanitize(stored), loaded: true });
    } catch (err) {
      console.error('Failed to load keymap', err);
      set({ loaded: true });
    }
  },

  bind(action, key) {
    if (!isBindable(key)) {
      set({ bindError: `${keyLabel(key)} can’t be bound.` });
      return false;
    }
    const { keymap } = get();
    if (keymap[action] === key) {
      set({ binding: null, bindError: null });
      return true;
    }
    const taken = actionForKey(keymap, key);
    if (taken) {
      const label = HOTKEY_ACTIONS.find((a) => a.id === taken)?.label ?? taken;
      set({ bindError: `${keyLabel(key)} is already “${label}”.` });
      return false;
    }
    const next: Keymap = { ...keymap, [action]: key };
    set({ keymap: next, binding: null, bindError: null });
    persist(next);
    return true;
  },

  resetKeymap() {
    set({ keymap: DEFAULT_KEYMAP, binding: null, bindError: null });
    persist(DEFAULT_KEYMAP);
  },

  setHelpOpen(open) {
    set({ helpOpen: open, binding: null, bindError: null });
  },

  toggleHelp() {
    get().setHelpOpen(!get().helpOpen);
  },

  startBinding(action) {
    set({ binding: action, bindError: null });
  },

  cancelBinding() {
    set({ binding: null, bindError: null });
  },
}));
