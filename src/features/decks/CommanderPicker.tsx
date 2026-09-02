import { useMemo, useState } from 'react';
import type { CardData } from '../../domain/types';

const MAX_COMMANDERS = 2;

export interface CommanderPickerProps {
  options: CardData[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

function isLegendary(card: CardData): boolean {
  return /legendary/i.test(card.typeLine);
}

/** Searchable 1–2 commander selector over the resolved card list. */
export function CommanderPicker({ options, selectedIds, onChange }: CommanderPickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const byId = useMemo(() => new Map(options.map((c) => [c.scryfallId, c])), [options]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = options.filter((c) => !selectedIds.includes(c.scryfallId));
    const filtered = q ? pool.filter((c) => c.name.toLowerCase().includes(q)) : pool;
    const ranked = [...filtered].sort((a, b) => {
      const legend = Number(isLegendary(b)) - Number(isLegendary(a));
      if (legend !== 0) return legend;
      return a.name.localeCompare(b.name);
    });
    return ranked.slice(0, 40);
  }, [options, selectedIds, query]);

  const full = selectedIds.length >= MAX_COMMANDERS;

  function add(id: string) {
    if (full || selectedIds.includes(id)) return;
    onChange([...selectedIds, id]);
    setQuery('');
    setOpen(false);
  }

  function remove(id: string) {
    onChange(selectedIds.filter((x) => x !== id));
  }

  return (
    <div className="dk-field">
      <span className="dk-label">Commanders ({selectedIds.length}/2)</span>

      {selectedIds.length === 0 && (
        <span className="dk-warn">No commander detected. Pick one below.</span>
      )}

      {selectedIds.map((id) => (
        <span className="dk-chip" key={id}>
          <span>{byId.get(id)?.name ?? id}</span>
          <button
            type="button"
            className="dk-chip-x"
            onClick={() => remove(id)}
            aria-label={`Remove ${byId.get(id)?.name ?? 'commander'}`}
          >
            <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false">
              <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1.2" fill="none" />
            </svg>
          </button>
        </span>
      ))}

      <div className="dk-picker">
        <input
          className="dk-input"
          type="text"
          value={query}
          disabled={full}
          placeholder={full ? 'Two commanders selected' : 'Search deck for a commander'}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        />
        {open && !full && matches.length > 0 && (
          <div className="dk-picker-list" role="listbox">
            {matches.map((card) => (
              <button
                type="button"
                key={card.scryfallId}
                className="dk-picker-item"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(card.scryfallId)}
              >
                {card.name}
                <span className="dk-picker-type">{card.typeLine}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
