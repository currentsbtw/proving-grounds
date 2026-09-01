import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { CollisionDetection, DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { useCallback, useMemo, useState } from 'react';
import type { CardInstance, ZoneId } from '../../domain/types';
import { byArrival, canMulligan, commanderTax, useGameStore } from '../../state/gameStore';
import { keyLabel, useHotkeyStore } from '../../state/hotkeyStore';
import CounterTell from '../pressure/CounterTell';
import PressureLayer from '../pressure/PressureLayer';
import { Battlefield } from './Battlefield';
import { BrowseOverlay } from './BrowseOverlay';
import { CardMenuProvider } from './CardMenu';
import { CardView } from './CardView';
import { Hand } from './Hand';
import { MulliganBar } from './MulliganBar';
import { askNumber, MenuHead, MenuItem, MenuSep, MenuTitle, PopMenu } from './PopMenu';
import { CommandZone, LibraryStack, ZoneStack } from './ZoneStack';
import './table.css';

type OpenZone = Extract<ZoneId, 'graveyard' | 'exile' | 'command'>;

type OverlayState =
  | { kind: 'zone'; zone: OpenZone }
  | { kind: 'search' }
  | { kind: 'reveal'; iids: string[] };

type ZoneBuckets = Record<Exclude<ZoneId, 'library'>, CardInstance[]>;

const DROP_ZONES: Record<string, { zone: ZoneId; position?: 'top' | 'bottom' }> = {
  battlefield: { zone: 'battlefield' },
  hand: { zone: 'hand' },
  graveyard: { zone: 'graveyard' },
  exile: { zone: 'exile' },
  command: { zone: 'command' },
  'library-top': { zone: 'library', position: 'top' },
  'library-bottom': { zone: 'library', position: 'bottom' },
};

/** Pointer-first collision so the small library drop strips win over the battlefield. */
const collisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : rectIntersection(args);
};

function CastButton({ card, onDone }: { card: CardInstance; onDone: () => void }) {
  const tax = useGameStore((s) => (card.scryfallId ? commanderTax(s, card.scryfallId) : 0));
  const castCommander = useGameStore((s) => s.castCommander);
  if (card.zone !== 'command') return <span className="muted">on the battlefield</span>;
  return (
    <button
      type="button"
      onClick={() => {
        castCommander(card.iid);
        onDone();
      }}
    >
      Cast · tax {tax}
    </button>
  );
}

function TableSurface() {
  const cards = useGameStore((s) => s.cards);
  const libraryOrder = useGameStore((s) => s.libraryOrder);
  const mulliganCount = useGameStore((s) => s.mulliganCount);
  const showMulligan = useGameStore(canMulligan);

  const moveCard = useGameStore((s) => s.moveCard);
  const drawCards = useGameStore((s) => s.drawCards);
  const shuffleLibrary = useGameStore((s) => s.shuffleLibrary);
  const millCards = useGameStore((s) => s.millCards);
  const revealTop = useGameStore((s) => s.revealTop);
  const takeMulligan = useGameStore((s) => s.takeMulligan);
  const resolveMulligan = useGameStore((s) => s.resolveMulligan);
  const keymap = useHotkeyStore((s) => s.keymap);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<OverlayState | null>(null);
  const [libMenu, setLibMenu] = useState<{ x: number; y: number } | null>(null);
  // Which mulligan the bottoming UI belongs to. Deriving `bottoming` from it
  // means a mulligan taken from anywhere — button or hotkey — resets the
  // choice, with no effect needed.
  const [bottomingFor, setBottomingFor] = useState<number | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const bottoming = bottomingFor === mulliganCount;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const zones = useMemo<ZoneBuckets>(() => {
    const buckets: ZoneBuckets = {
      battlefield: [],
      hand: [],
      graveyard: [],
      exile: [],
      command: [],
    };
    for (const card of Object.values(cards)) {
      if (card.zone !== 'library') buckets[card.zone].push(card);
    }
    // Arrival order, so the graveyard / exile previews show the newest card last.
    for (const bucket of Object.values(buckets)) bucket.sort(byArrival);
    return buckets;
  }, [cards]);

  const library = useMemo(
    () => libraryOrder.map((iid) => cards[iid]).filter(Boolean),
    [libraryOrder, cards],
  );

  // Derived so a chosen card that leaves the hand drops out of the selection.
  const selection = useMemo(
    () => selected.filter((iid) => cards[iid]?.zone === 'hand'),
    [selected, cards],
  );

  const closeOverlay = useCallback(() => {
    if (overlay?.kind === 'search') shuffleLibrary();
    setOverlay(null);
  }, [overlay, shuffleLibrary]);

  const closeLibMenu = useCallback(() => setLibMenu(null), []);

  function onDragStart(e: DragStartEvent): void {
    setActiveId(String(e.active.id));
  }

  function onDragEnd(e: DragEndEvent): void {
    setActiveId(null);
    if (!e.over) return;
    const target = DROP_ZONES[String(e.over.id)];
    if (!target) return;
    moveCard(String(e.active.id), target.zone, target.position);
  }

  function toggleSelected(iid: string): void {
    setSelected((prev) =>
      prev.includes(iid) ? prev.filter((x) => x !== iid) : [...prev, iid],
    );
  }

  function runLibraryAction(fn: () => void): () => void {
    return () => {
      fn();
      setLibMenu(null);
    };
  }

  const activeCard = activeId ? cards[activeId] : undefined;
  const revealed =
    overlay?.kind === 'reveal' ? overlay.iids.map((iid) => cards[iid]).filter(Boolean) : [];

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <section
        className={`pg-table tbl-root${activeId ? ' tbl-dragging' : ''}`}
        aria-label="Table"
      >
        <PressureLayer />

        <Battlefield cards={zones.battlefield} />

        <div className="tbl-strip">
          <div className="tbl-stack-group">
            <CommandZone
              cards={zones.command}
              onOpen={() => setOverlay({ kind: 'zone', zone: 'command' })}
            />
            <LibraryStack
              count={library.length}
              onOpenMenu={(x, y) => setLibMenu({ x, y })}
            />
          </div>

          <div className="tbl-hand-col">
            <div className="tbl-hand-head">
              <span>Hand</span>
              <span className="tbl-hand-n">{zones.hand.length}</span>
              <CounterTell />
              <span className="tbl-mull-spacer" />
              <span className="muted tbl-hand-tip">
                double-click to play · drag to any zone · right-click for options
              </span>
            </div>

            {showMulligan && (
              <MulliganBar
                mulliganCount={mulliganCount}
                selecting={bottoming}
                selectedCount={selection.length}
                onMulligan={() => {
                  setBottomingFor(null);
                  setSelected([]);
                  takeMulligan();
                }}
                onKeep={() => resolveMulligan([])}
                onStartBottoming={() => {
                  setSelected([]);
                  setBottomingFor(mulliganCount);
                }}
                onCancelBottoming={() => {
                  setBottomingFor(null);
                  setSelected([]);
                }}
                onConfirmBottoming={() => {
                  resolveMulligan(selection);
                  setBottomingFor(null);
                  setSelected([]);
                }}
              />
            )}

            <Hand
              cards={zones.hand}
              selecting={showMulligan && bottoming}
              selected={selection}
              onToggleSelect={toggleSelected}
            />
          </div>

          <div className="tbl-stack-group">
            <ZoneStack
              zone="graveyard"
              label="Graveyard"
              cards={zones.graveyard}
              onOpen={() => setOverlay({ kind: 'zone', zone: 'graveyard' })}
            />
            <ZoneStack
              zone="exile"
              label="Exile"
              cards={zones.exile}
              onOpen={() => setOverlay({ kind: 'zone', zone: 'exile' })}
            />
          </div>
        </div>
      </section>

      {libMenu && (
        <PopMenu x={libMenu.x} y={libMenu.y} onClose={closeLibMenu}>
          <MenuTitle>Library · {library.length} cards</MenuTitle>
          <MenuItem
            accent
            onSelect={runLibraryAction(() => drawCards(1))}
            hint={keyLabel(keymap.draw)}
          >
            Draw 1
          </MenuItem>
          <MenuItem
            onSelect={runLibraryAction(() => {
              const n = askNumber('Draw how many cards?', 2);
              if (n) drawCards(n);
            })}
          >
            Draw N…
          </MenuItem>
          <MenuItem onSelect={runLibraryAction(shuffleLibrary)} hint={keyLabel(keymap.shuffle)}>
            Shuffle
          </MenuItem>
          <MenuSep />
          <MenuHead>Look</MenuHead>
          <MenuItem
            onSelect={runLibraryAction(() => {
              const n = askNumber('Look at the top how many cards?', 3);
              if (!n) return;
              const cardsSeen = revealTop(n);
              setOverlay({ kind: 'reveal', iids: cardsSeen.map((c) => c.iid) });
            })}
          >
            Look at top N…
          </MenuItem>
          <MenuItem
            onSelect={runLibraryAction(() => {
              const n = askNumber('Mill how many cards?', 1);
              if (n) millCards(n);
            })}
          >
            Mill N…
          </MenuItem>
          <MenuItem onSelect={runLibraryAction(() => setOverlay({ kind: 'search' }))}>
            Search library…
          </MenuItem>
        </PopMenu>
      )}

      {overlay?.kind === 'zone' && (
        <BrowseOverlay
          title={
            overlay.zone === 'graveyard'
              ? 'Graveyard'
              : overlay.zone === 'exile'
                ? 'Exile'
                : 'Command zone'
          }
          cards={zones[overlay.zone]}
          emptyText="Nothing here yet."
          onClose={closeOverlay}
          actions={
            overlay.zone === 'command'
              ? (card) => <CastButton card={card} onDone={closeOverlay} />
              : (card) => (
                  <>
                    <button type="button" onClick={() => moveCard(card.iid, 'hand')}>
                      To hand
                    </button>
                    <button type="button" onClick={() => moveCard(card.iid, 'battlefield')}>
                      To battlefield
                    </button>
                  </>
                )
          }
          footer="Right-click any card for the full move and counter menu."
        />
      )}

      {overlay?.kind === 'search' && (
        <BrowseOverlay
          title="Search library"
          subtitle="top of library first"
          cards={library}
          emptyText="Library is empty."
          onClose={closeOverlay}
          actions={(card) => (
            <button type="button" onClick={() => moveCard(card.iid, 'hand')}>
              To hand
            </button>
          )}
          footer="Closing this search shuffles the library."
        />
      )}

      {overlay?.kind === 'reveal' && (
        <BrowseOverlay
          title={`Top ${overlay.iids.length} of library`}
          cards={revealed}
          emptyText="Library is empty."
          onClose={closeOverlay}
          actions={(card) =>
            card.zone === 'library' ? (
              <button type="button" onClick={() => moveCard(card.iid, 'hand')}>
                Draw
              </button>
            ) : (
              <span className="muted">in {card.zone}</span>
            )
          }
          footer="Looking does not reorder your library — cards left behind stay in order."
        />
      )}

      <DragOverlay dropAnimation={null}>
        {activeCard ? (
          <CardView
            card={activeCard}
            width={activeCard.zone === 'hand' ? 120 : activeCard.zone === 'battlefield' ? 140 : 80}
            lifted
            menu={false}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

export function TablePanel() {
  const runId = useGameStore((s) => s.run?.id ?? null);

  if (!runId) {
    return (
      <section className="pg-table tbl-root is-empty" aria-label="Table">
        <div className="tbl-empty-hint">
          <h2>The table is empty</h2>
          <p className="muted">Import a deck and start a run.</p>
        </div>
      </section>
    );
  }

  // Keyed by run so a fresh run remounts with clean local UI state.
  return (
    <CardMenuProvider>
      <TableSurface key={runId} />
    </CardMenuProvider>
  );
}

export default TablePanel;
