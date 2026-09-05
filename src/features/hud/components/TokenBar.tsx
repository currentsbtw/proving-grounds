import { useState } from 'react';
import { useGameStore } from '../../../state/gameStore';
import type { TokenSpec } from '../../../domain/types';
import { findTokenFace } from '../../../services/scryfall';

/**
 * How long a face lookup is allowed to hang before it is abandoned. It gates
 * nothing — the token is already on the battlefield by the time the request goes
 * out — it only stops a dead connection from holding a request open for ever.
 */
const FACE_TIMEOUT_MS = 3000;

interface Preset {
  label: string;
  spec: TokenSpec;
}

const PRESETS: Preset[] = [
  {
    label: 'Treasure',
    spec: { name: 'Treasure', colors: [], typeLine: 'Token Artifact — Treasure' },
  },
  {
    label: 'Clue',
    spec: { name: 'Clue', colors: [], typeLine: 'Token Artifact — Clue' },
  },
  {
    label: 'Food',
    spec: { name: 'Food', colors: [], typeLine: 'Token Artifact — Food' },
  },
  {
    label: '1/1 Soldier',
    spec: {
      name: 'Soldier',
      power: '1',
      toughness: '1',
      colors: ['W'],
      typeLine: 'Token Creature — Soldier',
    },
  },
  {
    label: '1/1 Spirit (flying)',
    spec: {
      name: 'Spirit (flying)',
      power: '1',
      toughness: '1',
      colors: ['W'],
      typeLine: 'Token Creature — Spirit',
    },
  },
  {
    label: '2/2 Zombie',
    spec: {
      name: 'Zombie',
      power: '2',
      toughness: '2',
      colors: ['B'],
      typeLine: 'Token Creature — Zombie',
    },
  },
];

function clampCount(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(99, Math.max(1, Math.floor(n)));
}

/** Preset token buttons with an ×N multiplier, plus an inline custom-token form. */
export default function TokenBar() {
  const createToken = useGameStore((s) => s.createToken);
  const setTokenFace = useGameStore((s) => s.setTokenFace);

  const [countText, setCountText] = useState('1');
  const [showCustom, setShowCustom] = useState(false);
  const [name, setName] = useState('');
  const [power, setPower] = useState('');
  const [toughness, setToughness] = useState('');
  const [customCount, setCustomCount] = useState('1');

  /**
   * Creates the token now and asks Scryfall for its face afterwards. The click is
   * the player's, so `createToken` runs synchronously with the plain spec — same
   * state change, same log entry as if there were no lookup at all. The face is a
   * later, cosmetic patch onto those instances; a miss, an error, an abort or a
   * timeout simply leaves the text frame the table has always drawn.
   */
  function create(spec: TokenSpec, n: number): void {
    const iids = createToken(spec, n);
    if (iids.length === 0) return;

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), FACE_TIMEOUT_MS);
    void findTokenFace(spec, abort.signal)
      .then((face) => {
        if (face) setTokenFace(iids, face);
      })
      .catch(() => {
        // `findTokenFace` answers null rather than throwing; belt and braces.
      })
      .finally(() => clearTimeout(timer));
  }

  function makePreset(spec: TokenSpec): void {
    const n = clampCount(Number(countText));
    setCountText('1');
    create(spec, n);
  }

  function submitCustom(): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    const p = power.trim();
    const t = toughness.trim();
    const hasBody = p !== '' && t !== '';
    const spec: TokenSpec = hasBody
      ? {
          name: trimmed,
          power: p,
          toughness: t,
          typeLine: `Token Creature — ${trimmed}`,
        }
      : { name: trimmed, typeLine: 'Token' };
    const n = clampCount(Number(customCount));
    create(spec, n);
    setName('');
    setPower('');
    setToughness('');
    setCustomCount('1');
    setShowCustom(false);
  }

  return (
    <div className="pg-hud-block">
      <label className="hud-token-count" data-hotkeys="off">
        ×
        <input
          type="number"
          min={1}
          max={99}
          value={countText}
          aria-label="Number of tokens for the next preset"
          onChange={(e) => setCountText(e.target.value)}
        />
      </label>

      <div className="hud-token-presets">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            title={preset.spec.typeLine}
            onClick={() => makePreset(preset.spec)}
          >
            {preset.label}
          </button>
        ))}
        <button type="button" aria-expanded={showCustom} onClick={() => setShowCustom((v) => !v)}>
          Custom…
        </button>
      </div>

      {showCustom && (
        <div className="hud-token-form" data-hotkeys="off">
          <span className="hud-token-form-labels">name · power · toughness · count</span>
          <input
            type="text"
            value={name}
            placeholder="e.g. Beast"
            aria-label="Custom token name"
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCustom();
              if (e.key === 'Escape') setShowCustom(false);
            }}
          />
          <input
            type="text"
            value={power}
            placeholder="P"
            aria-label="Custom token power"
            onChange={(e) => setPower(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCustom();
            }}
          />
          <input
            type="text"
            value={toughness}
            placeholder="T"
            aria-label="Custom token toughness"
            onChange={(e) => setToughness(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCustom();
            }}
          />
          <input
            type="number"
            min={1}
            max={99}
            value={customCount}
            aria-label="Custom token count"
            onChange={(e) => setCustomCount(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCustom();
            }}
          />
          <div className="hud-token-form-actions">
            <button type="button" onClick={() => setShowCustom(false)}>
              Cancel
            </button>
            <button
              type="button"
              disabled={name.trim() === ''}
              onClick={submitCustom}
            >
              Create
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
