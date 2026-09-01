import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ZoneId } from '../../domain/types';
import { cardName, commanderTax, useGameStore } from '../../state/gameStore';
import { MenuHead, MenuItem, MenuSep, MenuTitle, PopMenu } from './PopMenu';

type OpenCardMenu = (iid: string, x: number, y: number) => void;

const CardMenuContext = createContext<OpenCardMenu>(() => {});

/** Opens the shared card context menu at viewport coordinates. */
export function useCardMenu(): OpenCardMenu {
  return useContext(CardMenuContext);
}

interface MenuTarget {
  iid: string;
  x: number;
  y: number;
}

interface ZoneEntry {
  zone: ZoneId;
  label: string;
  position?: 'top' | 'bottom';
  tapped?: boolean;
}

const ZONE_ENTRIES: ZoneEntry[] = [
  { zone: 'hand', label: 'Hand' },
  { zone: 'battlefield', label: 'Battlefield (untapped)' },
  { zone: 'battlefield', label: 'To battlefield tapped', tapped: true },
  { zone: 'graveyard', label: 'Graveyard' },
  { zone: 'exile', label: 'Exile' },
  { zone: 'command', label: 'Command zone' },
  { zone: 'library', label: 'Top of library', position: 'top' },
  { zone: 'library', label: 'Bottom of library', position: 'bottom' },
];

const PLUS = '+1/+1';

function CardMenuBody({ iid, x, y, onClose }: MenuTarget & { onClose: () => void }) {
  const card = useGameStore((s) => s.cards[iid]);
  const name = useGameStore((s) => (s.cards[iid] ? cardName(s, iid) : ''));
  const tax = useGameStore((s) => {
    const c = s.cards[iid];
    return c?.scryfallId ? commanderTax(s, c.scryfallId) : 0;
  });
  const moveCard = useGameStore((s) => s.moveCard);
  const addCounter = useGameStore((s) => s.addCounter);
  const castCommander = useGameStore((s) => s.castCommander);
  const toggleTapped = useGameStore((s) => s.toggleTapped);

  /** null = the "Custom counter…" row; a string = the inline name input is open. */
  const [custom, setCustom] = useState<string | null>(null);

  useEffect(() => {
    if (!card) onClose();
  }, [card, onClose]);

  if (!card) return null;

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const zoneEntries = ZONE_ENTRIES.filter((e) => e.zone !== card.zone);
  const plus = card.counters[PLUS] ?? 0;
  const loyalty = card.counters.loyalty ?? 0;

  return (
    <PopMenu x={x} y={y} onClose={onClose}>
      <MenuTitle>{name}</MenuTitle>

      {card.isCommander && card.zone === 'command' && (
        <>
          <MenuItem accent onSelect={run(() => castCommander(iid))} hint={`+${tax}`}>
            Cast commander (tax: {tax})
          </MenuItem>
          <MenuSep />
        </>
      )}

      {card.zone === 'battlefield' && (
        <MenuItem onSelect={run(() => toggleTapped(iid))}>
          {card.tapped ? 'Untap' : 'Tap'}
        </MenuItem>
      )}

      <MenuHead>Move to</MenuHead>
      {zoneEntries.map((entry) => (
        <MenuItem
          key={entry.label}
          onSelect={run(() =>
            moveCard(iid, entry.zone, { position: entry.position, tapped: entry.tapped }),
          )}
        >
          {entry.label}
        </MenuItem>
      ))}

      <MenuSep />
      <MenuHead>Counters</MenuHead>
      <MenuItem onSelect={run(() => addCounter(iid, PLUS, 1))}>Add +1/+1</MenuItem>
      <MenuItem disabled={plus === 0} onSelect={run(() => addCounter(iid, PLUS, -1))} hint={plus || undefined}>
        Remove +1/+1
      </MenuItem>
      <MenuItem onSelect={run(() => addCounter(iid, 'loyalty', 1))}>Add loyalty</MenuItem>
      <MenuItem
        disabled={loyalty === 0}
        onSelect={run(() => addCounter(iid, 'loyalty', -1))}
        hint={loyalty || undefined}
      >
        Remove loyalty
      </MenuItem>
      <MenuItem onSelect={run(() => addCounter(iid, 'charge', 1))}>Add charge counter</MenuItem>

      {custom === null ? (
        <MenuItem onSelect={() => setCustom('')}>Custom counter…</MenuItem>
      ) : (
        <form
          className="tbl-menu-form"
          onSubmit={(e) => {
            e.preventDefault();
            const kind = custom.trim();
            if (kind) addCounter(iid, kind, 1);
            onClose();
          }}
        >
          <input
            type="text"
            autoFocus
            value={custom}
            placeholder="Counter name… ↵"
            aria-label="Custom counter name"
            onChange={(e) => setCustom(e.target.value)}
          />
          <button type="submit" disabled={custom.trim() === ''}>
            Add
          </button>
        </form>
      )}
    </PopMenu>
  );
}

export function CardMenuProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<MenuTarget | null>(null);
  const open = useCallback<OpenCardMenu>((iid, x, y) => setTarget({ iid, x, y }), []);
  const close = useCallback(() => setTarget(null), []);

  return (
    <CardMenuContext.Provider value={open}>
      {children}
      {target && <CardMenuBody key={target.iid} {...target} onClose={close} />}
    </CardMenuContext.Provider>
  );
}
