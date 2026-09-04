import { useCallback, useEffect, useMemo, useState } from 'react';
import { randomSeed } from '../../domain/rng';
import { getDeck } from '../../db/db';
import { dealHands, handStats } from '../../engine/drill';
import { resolveDeckCards } from '../decks/startDeckRun';
import { CardView } from '../table/CardView';
import { STRIP_CARD_WIDTH } from '../table/cardGeometry';
import { useUiStore } from '../../state/uiStore';
import type { CardData, CardInstance, Deck } from '../../domain/types';
import './drill.css';

/**
 * The keep/mull drill: fifty opening hands off one list, with no run behind
 * them and no pressure in front of them.
 *
 * It counts and stops. There is no verdict on a call and no "you should have
 * kept": the app measures the deck, the player judges the hand (PRODUCT.md
 * principle 5). What the tally buys is the reading a single hand cannot give —
 * how often this list keeps at two lands, and what a kept hand has looked like.
 *
 * The hands are the ones a real run with this seed would deal, so a hand worth
 * keeping can be started for real: same seed, that many mulligans, same seven
 * cards. `dealHands` owns that promise and `npm run verify:drill` pins it.
 *
 * The store is never touched. The cards below are `CardInstance`s built here
 * for the sake of `CardView`, and the run this drill is about does not exist.
 */

const HAND_SIZE = 7;

/** Land counts the tally reports on. Every hand has one; most have two or three. */
const LAND_COUNTS = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * The session's calls. Deliberately component state and nothing else: it is gone
 * on reload, and whether a drill history is worth keeping — and what it would
 * mean across deck edits — is a later decision, not one to make by accident in
 * a Dexie table.
 */
interface Tally {
  kept: number;
  mulled: number;
  /** Lands summed over kept and over mulled hands, for the two averages. */
  keptLands: number;
  mulledLands: number;
  /** Per land count 0-7: hands seen at it, and hands kept at it. */
  seenByLands: number[];
  keptByLands: number[];
}

const EMPTY_TALLY: Tally = {
  kept: 0,
  mulled: 0,
  keptLands: 0,
  mulledLands: 0,
  seenByLands: LAND_COUNTS.map(() => 0),
  keptByLands: LAND_COUNTS.map(() => 0),
};

function record(tally: Tally, call: 'keep' | 'mull', lands: number): Tally {
  const bump = (list: number[], at: number): number[] =>
    list.map((n, i) => (i === at ? n + 1 : n));
  const seenByLands = bump(tally.seenByLands, lands);
  return call === 'keep'
    ? {
        ...tally,
        kept: tally.kept + 1,
        keptLands: tally.keptLands + lands,
        seenByLands,
        keptByLands: bump(tally.keptByLands, lands),
      }
    : {
        ...tally,
        mulled: tally.mulled + 1,
        mulledLands: tally.mulledLands + lands,
        seenByLands,
      };
}

/** A mean printed to one decimal, or an em dash where there is nothing to mean. */
function mean(total: number, count: number): string {
  return count === 0 ? '—' : (total / count).toFixed(1);
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Printed label over its figure — the readout's unit, as the deck rail draws it. */
function Slot({ label, value }: { label: string; value: string }) {
  return (
    <div className="dr-slot">
      <span className="panel-heading">{label}</span>
      <span className="dr-slot-value num">{value}</span>
    </div>
  );
}

export default function HandDrill() {
  const drill = useUiStore((s) => s.drill);
  const closeDrill = useUiStore((s) => s.closeDrill);
  const deckId = drill?.deckId ?? null;

  const [deck, setDeck] = useState<Deck | null>(null);
  const [cardData, setCardData] = useState<Record<string, CardData>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  // The rail's seed field is the starting point; blank there means the drill
  // picks its own, exactly as starting a run with a blank seed does.
  const [seed, setSeed] = useState(() => drill?.seed.trim() || randomSeed());
  const [handNo, setHandNo] = useState(1);
  const [tally, setTally] = useState<Tally>(EMPTY_TALLY);

  // The rail already resolved this deck before opening the drill, so this is a
  // cache read rather than a fetch; it is done again here because the resolved
  // cards belong to the panel that prints them, not to the button that opened it.
  useEffect(() => {
    if (!deckId) return;
    let live = true;
    void (async () => {
      try {
        const found = await getDeck(deckId);
        if (!found) throw new Error('That deck is gone. Import it again to drill it.');
        const cards = await resolveDeckCards(found);
        if (!live) return;
        setDeck(found);
        setCardData(cards);
      } catch (err: unknown) {
        if (!live) return;
        setLoadError(err instanceof Error ? err.message : 'Could not read that deck.');
      }
    })();
    return () => {
      live = false;
    };
  }, [deckId]);

  // The library `startRun` would build: every card expanded by quantity, in deck
  // order, commanders left out because they never join the library.
  const cardIds = useMemo(
    () => (deck ? deck.cards.flatMap((ref) => Array<string>(ref.qty).fill(ref.scryfallId)) : []),
    [deck],
  );

  const activeSeed = seed.trim();
  // Hand k is the run's opening seven after k-1 mulligans, so every hand up to
  // this one is dealt to get here. A hundred hands off a hundred-card list is a
  // hundred shuffles — cheaper than the render it feeds.
  const hand = useMemo(() => {
    if (cardIds.length === 0 || activeSeed === '') return [];
    const dealt = dealHands({ cardIds, seed: activeSeed, hands: handNo });
    return dealt[dealt.length - 1] ?? [];
  }, [cardIds, activeSeed, handNo]);

  const handCards = useMemo(
    () => hand.map((id) => cardData[id]).filter((c): c is CardData => Boolean(c)),
    [hand, cardData],
  );

  const instances = useMemo<CardInstance[]>(
    () =>
      hand.map((scryfallId, i) => ({
        iid: `drill-${handNo}-${i}`,
        scryfallId,
        zone: 'hand' as const,
        tapped: false,
        faceDown: false,
        counters: {},
        isCommander: false,
        isToken: false,
        movedAt: i,
      })),
    [hand, handNo],
  );

  const stats = useMemo(() => handStats(handCards), [handCards]);
  const ready = handCards.length === HAND_SIZE;

  const call = useCallback(
    (choice: 'keep' | 'mull') => {
      if (!ready) return;
      setTally((current) => record(current, choice, stats.lands));
      setHandNo((n) => n + 1);
    },
    [ready, stats.lands],
  );

  // Scoped to this panel rather than added to the global keymap: K and M mean
  // something here and nothing anywhere else, and the drill is never mounted
  // while a run is live.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        return;
      }
      const key = e.key.toLowerCase();
      if (key !== 'k' && key !== 'm') return;
      e.preventDefault();
      call(key === 'k' ? 'keep' : 'mull');
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [call]);

  function takeNextSeed(): void {
    setSeed(randomSeed());
    setHandNo(1);
  }

  const seen = tally.kept + tally.mulled;

  return (
    <section className="pg-table dr-root" aria-label="Hand drill">
      <div className="dr-head">
        <h2 className="panel-heading">Hand drill</h2>
        {/* The rail's own deck-name rule: same object, same setting, wherever
            it is printed. */}
        <span className="dk-deck-name">{deck?.name ?? '…'}</span>
        <span className="dr-head-spacer" />
        <button type="button" className="dk-btn-quiet" onClick={closeDrill}>
          Close
        </button>
      </div>

      {loadError && <p className="dk-error">{loadError}</p>}

      <div className="dr-controls">
        <label className="dr-seed-field">
          <span className="panel-heading">Seed</span>
          <input
            className="dr-seed"
            type="text"
            value={seed}
            placeholder="seed"
            onChange={(e) => {
              setSeed(e.target.value);
              setHandNo(1);
            }}
          />
        </label>
        <button type="button" className="dk-btn-quiet" onClick={takeNextSeed}>
          Next seed
        </button>
        <span className="dr-head-spacer" />
        <Slot label="Hand" value={String(handNo)} />
      </div>

      {activeSeed === '' ? (
        <p className="dk-empty">No seed. Type one, or take the next.</p>
      ) : !ready ? (
        <p className="dk-empty">{loadError ? 'Nothing to deal.' : 'Dealing…'}</p>
      ) : (
        <>
          <div className="dr-hand">
            {instances.map((card) => (
              <CardView
                key={card.iid}
                card={card}
                data={cardData[card.scryfallId ?? '']}
                width={STRIP_CARD_WIDTH}
                menu={false}
              />
            ))}
          </div>

          <p className="dr-count num">
            {stats.lands} {plural(stats.lands, 'land', 'lands')}
            {stats.cheapest === null
              ? ' · no spells'
              : ` · cheapest MV ${stats.cheapest}` +
                ` · ${stats.spellsAtOrBelow[3]} ${plural(stats.spellsAtOrBelow[3], 'spell', 'spells')} at MV<=3` +
                ` · avg MV ${stats.avgMv.toFixed(1)}`}
          </p>

          <div className="dr-calls">
            <button type="button" className="dr-call" onClick={() => call('keep')}>
              Keep<span className="rd-key">K</span>
            </button>
            <button type="button" className="dr-call" onClick={() => call('mull')}>
              Mull<span className="rd-key">M</span>
            </button>
          </div>
        </>
      )}

      <div className="dr-tally">
        <h3 className="panel-heading">This session</h3>
        <div className="dr-slots">
          <Slot label="Seen" value={String(seen)} />
          <Slot label="Kept" value={String(tally.kept)} />
          <Slot label="Mulled" value={String(tally.mulled)} />
          <Slot label="Lands kept" value={mean(tally.keptLands, tally.kept)} />
          <Slot label="Lands mulled" value={mean(tally.mulledLands, tally.mulled)} />
        </div>

        <table className="dr-table">
          <caption className="panel-heading">Keep rate by lands</caption>
          <thead>
            <tr>
              <th scope="col">Lands</th>
              <th scope="col">Seen</th>
              <th scope="col">Kept</th>
              <th scope="col">Rate</th>
            </tr>
          </thead>
          <tbody>
            {LAND_COUNTS.map((lands) => {
              const at = tally.seenByLands[lands];
              const keptAt = tally.keptByLands[lands];
              return (
                <tr key={lands}>
                  <th scope="row" className="num">
                    {lands}
                  </th>
                  <td className="num">{at}</td>
                  <td className="num">{keptAt}</td>
                  <td className="num">{at === 0 ? '—' : `${Math.round((keptAt / at) * 100)}%`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="dr-note">Counts only. The call is yours.</p>
      </div>
    </section>
  );
}
