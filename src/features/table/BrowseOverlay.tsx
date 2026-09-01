import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import type { CardInstance } from '../../domain/types';
import { CardView } from './CardView';

export interface BrowseOverlayProps {
  title: string;
  subtitle?: ReactNode;
  cards: CardInstance[];
  emptyText?: string;
  footer?: ReactNode;
  /** Per-card action row rendered under each card. */
  actions?: (card: CardInstance) => ReactNode;
  onClose: () => void;
}

/** Full-screen zone browser. Escape or backdrop click closes. */
export function BrowseOverlay({
  title,
  subtitle,
  cards,
  emptyText = 'Empty',
  footer,
  actions,
  onClose,
}: BrowseOverlayProps) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return createPortal(
    <div className="tbl-overlay" data-hotkeys="off" onPointerDown={onClose}>
      <div
        className="tbl-overlay-panel panel"
        role="dialog"
        aria-label={title}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="tbl-overlay-head">
          <h3>{title}</h3>
          <span className="muted num">{cards.length}</span>
          {subtitle && <span className="muted">{subtitle}</span>}
          <span className="tbl-mull-spacer" />
          <button type="button" onClick={onClose}>
            Close (Esc)
          </button>
        </header>

        <div className="tbl-overlay-body">
          {cards.length === 0 && <p className="tbl-overlay-empty">{emptyText}</p>}
          {cards.map((card) => (
            <div className="tbl-overlay-cell" key={card.iid}>
              <CardView card={card} width={140} />
              {actions && <div className="tbl-cell-actions">{actions(card)}</div>}
            </div>
          ))}
        </div>

        {footer && <footer className="tbl-overlay-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
