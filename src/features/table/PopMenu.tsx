import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

export interface PopMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
}

/**
 * A cursor-anchored menu rendered into document.body (so it escapes any
 * transformed drag ancestor). Closes on outside pointerdown or Escape.
 */
export function PopMenu({ x, y, onClose, children }: PopMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    function onPointerDown(e: PointerEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="tbl-menu"
      data-hotkeys="off"
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItemProps {
  onSelect: () => void;
  children: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  accent?: boolean;
}

export function MenuItem({ onSelect, children, hint, disabled, accent }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`tbl-menu-item${accent ? ' is-accent' : ''}`}
      disabled={disabled}
      onClick={onSelect}
    >
      <span>{children}</span>
      {hint !== undefined && <span className="tbl-menu-hint">{hint}</span>}
    </button>
  );
}

export function MenuSep() {
  return <div className="tbl-menu-sep" />;
}

export function MenuHead({ children }: { children: ReactNode }) {
  return <div className="tbl-menu-head">{children}</div>;
}

export function MenuTitle({ children }: { children: ReactNode }) {
  return <div className="tbl-menu-title">{children}</div>;
}

/** window.prompt wrapper for the "N" asks. Returns null when cancelled/invalid. */
export function askNumber(label: string, fallback = 1): number | null {
  const raw = window.prompt(label, String(fallback));
  if (raw === null) return null;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}
