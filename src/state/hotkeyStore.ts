import { create } from 'zustand';
import { getSetting, setSetting } from '../db/db';

export type ActionId =
  | 'nextPhase'
  | 'nextTurn'
  | 'draw'
  | 'shuffle'
  | 'untap'
  | 'mulligan'
  | 'preview'
  | 'castToStack'
  | 'resolveTop'
  | 'pushAbility'
  | 'focusNote'
  | 'judge'
  | 'respondOne'
  | 'respondTwo'
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
  {
    id: 'preview',
    label: 'Preview the focused card',
    note: 'only while a card has keyboard focus',
    defaultKey: 'v',
  },
  {
    id: 'castToStack',
    label: 'Cast the focused card to the stack',
    note: 'only while a card has keyboard focus',
    defaultKey: 'c',
  },
  {
    id: 'resolveTop',
    label: 'Resolve the top of the stack',
    note: 'only while the stack has an item',
    defaultKey: 'r',
  },
  { id: 'pushAbility', label: 'Add an ability to the stack', defaultKey: 'a' },
  { id: 'focusNote', label: 'Log a note', defaultKey: 'n' },
  {
    id: 'judge',
    label: 'Ask the judge',
    note: "opens the readout's Judge drawer",
    defaultKey: 'j',
  },
  {
    id: 'respondOne',
    label: 'Event: answer it',
    note: 'only while an event is waiting',
    defaultKey: '1',
  },
  {
    id: 'respondTwo',
    label: 'Event: let it resolve',
    note: 'only while an event is waiting',
    defaultKey: '2',
  },
  { id: 'help', label: 'Keyboard help', defaultKey: '?' },
];

export type Keymap = Record<ActionId, string>;

export const DEFAULT_KEYMAP: Keymap = Object.fromEntries(
  HOTKEY_ACTIONS.map((a) => [a.id, a.defaultKey]),
) as Keymap;

/** Dexie settings key the keymap persists under. */
export const KEYMAP_SETTING = 'keymap';

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

/**
 * A stored keymap, merged over the defaults without ever handing one key to two
 * actions. The stored bindings are laid down first — they are the player's own
 * choices — and an action whose default key was taken by one of them is left
 * unbound rather than silently shadowed. The help overlay shows that as a blank
 * chip, which is the truth: the action has no key until it is rebound.
 */
function sanitize(raw: unknown): Keymap {
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const map = {} as Keymap;
  const claimed = new Set<string>();

  for (const action of HOTKEY_ACTIONS) {
    const key = stored[action.id];
    if (typeof key !== 'string' || key.length === 0) continue;
    if (!isBindable(key) || claimed.has(key)) continue;
    map[action.id] = key;
    claimed.add(key);
  }

  for (const action of HOTKEY_ACTIONS) {
    if (map[action.id] !== undefined) continue;
    const fallback = DEFAULT_KEYMAP[action.id];
    if (claimed.has(fallback)) {
      map[action.id] = '';
      continue;
    }
    map[action.id] = fallback;
    claimed.add(fallback);
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
      set({ bindError: `${keyLabel(key)} is reserved. Pick another key.` });
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
      set({ bindError: `${keyLabel(key)} already runs “${label}”. Pick another key.` });
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
