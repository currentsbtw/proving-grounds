import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { isCutCandidate, sortCardStats } from '../../engine/cardStats';
import type { CardStat, CardStatSortKey, CardStats, SortDirection } from '../../engine/cardStats';
import { Figure } from './figures';
import { NO_VALUE, num, pct } from './verdict';

/**
 * Every card of the deck, across every run of it. The deck profile above says
 * what the deck tends to do; this says which card is doing it, which is the
 * table a brewer actually cuts from.
 *
 * It opens on the cut-candidate ordering rather than alphabetically, because the
 * question the section exists to answer is "what is not getting cast", and the
 * answer should be the first row rather than something to be found by sorting.
 * The flag next to a name is the word "low cast", not a colour: the same rule
 * the review list and the event ledger follow.
 *
 * One run is a story, so the table stays behind until there are two.
 */

interface Column {
  key: CardStatSortKey;
  label: string;
  /** Which way the first press of this header points. Counts read high-first. */
  initial: SortDirection;
  numeric: boolean;
  /** What the column means, for the header button's title. */
  hint: string;
  /** Class on the body cell. Cells drawn through `Figure` carry `num` already. */
  cellClass?: string;
  /** How one card prints in this column. */
  cell: (stat: CardStat) => ReactNode;
}

/** The name, with what a brewer needs beside it to judge the row's numbers. */
function NameCell({ stat }: { stat: CardStat }) {
  return (
    <>
      <span className="sc-cards-title">{stat.name}</span>
      <span className="sc-dim sc-cards-mv num">MV {stat.manaValue}</span>
      {stat.isCommander && <span className="sc-flag">CMDR</span>}
      {isCutCandidate(stat) && <span className="sc-flag is-cut">low cast</span>}
    </>
  );
}

/**
 * The columns, in the order they are printed. The head row and the body rows are
 * both driven from this one list — a column carries its own heading *and* its
 * own cell — because two lists that had to be kept in the same order were one
 * edit away from printing a card's "Pitched" count under "Removed".
 */
const COLUMNS: Column[] = [
  {
    key: 'name',
    label: 'Card',
    initial: 'asc',
    numeric: false,
    hint: 'Card name',
    cellClass: 'sc-cards-name',
    cell: (stat) => <NameCell stat={stat} />,
  },
  {
    key: 'drawn',
    label: 'Drawn',
    initial: 'desc',
    numeric: true,
    hint: 'Times it reached your hand from the library',
    cellClass: 'num',
    cell: (stat) => stat.drawn,
  },
  {
    key: 'cast',
    label: 'Cast',
    initial: 'desc',
    numeric: true,
    hint: 'Times you declared it cast',
    cellClass: 'num',
    cell: (stat) => stat.cast,
  },
  {
    key: 'castRate',
    label: 'Cast rate',
    initial: 'asc',
    numeric: true,
    hint: 'Cast divided by drawn',
    cell: (stat) => <Figure value={pct(stat.castRate)} />,
  },
  {
    key: 'avgFirstCastTurn',
    label: 'First cast',
    initial: 'desc',
    numeric: true,
    hint: 'Average turn of the first cast in a run',
    cell: (stat) => (
      <Figure value={stat.avgFirstCastTurn === null ? NO_VALUE : `T${num(stat.avgFirstCastTurn)}`} />
    ),
  },
  {
    key: 'stuckAtEnd',
    label: 'Stuck at end',
    initial: 'desc',
    numeric: true,
    hint: 'Runs that ended with it still in hand',
    cellClass: 'num',
    cell: (stat) => stat.stuckAtEnd,
  },
  {
    key: 'removedBySeat',
    label: 'Removed',
    initial: 'desc',
    numeric: true,
    hint: 'Times a wipe or targeted removal took it off the board',
    cellClass: 'num',
    cell: (stat) => stat.removedBySeat,
  },
  {
    key: 'discardedOrSacrificed',
    label: 'Pitched',
    initial: 'desc',
    numeric: true,
    hint: 'Times you discarded or sacrificed it to a resource attack',
    cellClass: 'num',
    cell: (stat) => stat.discardedOrSacrificed,
  },
  {
    key: 'answeredWith',
    label: 'Answered with',
    initial: 'desc',
    numeric: true,
    hint: 'Times you named it as the answer you spent',
    cellClass: 'num',
    cell: (stat) => stat.answeredWith,
  },
];

const ARIA_SORT: Record<SortDirection, 'ascending' | 'descending'> = {
  asc: 'ascending',
  desc: 'descending',
};

interface Sort {
  key: CardStatSortKey;
  direction: SortDirection;
}

const DEFAULT_SORT: Sort = { key: 'cutCandidates', direction: 'asc' };

/** Runs the tally had to leave out, said in words. */
function skippedLine(count: number): string {
  return count === 1
    ? '1 older run has no roster and is not counted.'
    : `${count} older runs have no roster and are not counted.`;
}

function HeaderCell({
  column,
  sort,
  onSort,
}: {
  column: Column;
  sort: Sort;
  onSort: (key: CardStatSortKey, initial: SortDirection) => void;
}) {
  const active = sort.key === column.key;
  return (
    <th
      scope="col"
      className={column.numeric ? 'sc-cards-numcol' : undefined}
      aria-sort={active ? ARIA_SORT[sort.direction] : 'none'}
    >
      <button
        type="button"
        className={`sc-sort${active ? ' is-active' : ''}`}
        title={column.hint}
        onClick={() => onSort(column.key, column.initial)}
      >
        {column.label}
        {/* An arrow, and only on the active column, so the header is not a row
            of decorations competing with the numbers underneath. */}
        <span aria-hidden="true" className="sc-sort-mark">
          {active ? (sort.direction === 'asc' ? '↑' : '↓') : ''}
        </span>
      </button>
    </th>
  );
}

function Row({ stat }: { stat: CardStat }) {
  return (
    <tr>
      {COLUMNS.map((column) => (
        <td key={column.key} className={column.cellClass}>
          {column.cell(stat)}
        </td>
      ))}
    </tr>
  );
}

export default function CardStatsSection({ stats }: { stats: CardStats | undefined }) {
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [showLands, setShowLands] = useState(false);

  const rows = useMemo(() => {
    if (!stats) return [];
    const pool = showLands ? stats.cards : stats.cards.filter((stat) => !stat.isLand);
    return sortCardStats(pool, sort.key, sort.direction);
  }, [stats, showLands, sort]);

  function handleSort(key: CardStatSortKey, initial: SortDirection): void {
    setSort((was) =>
      was.key === key
        ? { key, direction: was.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: initial },
    );
  }

  return (
    <section className="sc-section">
      <div className="sc-section-head">
        <h3 className="panel-heading">Cards across runs</h3>
        {stats && stats.runsScored >= 2 && (
          <label className="sc-cards-toggle">
            <input
              type="checkbox"
              checked={showLands}
              onChange={(e) => setShowLands(e.target.checked)}
            />
            show lands
          </label>
        )}
      </div>

      {!stats ? (
        <p className="sc-empty">Reading the logs…</p>
      ) : stats.runsScored < 2 ? (
        <p className="sc-empty">Play another run of this deck to compare cards.</p>
      ) : rows.length === 0 ? (
        <p className="sc-empty">
          {showLands
            ? 'These runs recorded no cards at all.'
            : 'Nothing but lands in this deck. Tick show lands to see them.'}
        </p>
      ) : (
        <>
          <div className="sc-table-wrap">
            <table className="sc-table sc-cards-table">
              <thead>
                <tr>
                  {COLUMNS.map((column) => (
                    <HeaderCell
                      key={column.key}
                      column={column}
                      sort={sort}
                      onSort={handleSort}
                    />
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((stat) => (
                  <Row key={stat.name} stat={stat} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="sc-hint">
            {sort.key === 'cutCandidates'
              ? 'Ordered by cut candidate: seen twice or more, least often cast first. Press a heading to sort by it.'
              : 'Press a heading to sort by it, twice to flip it.'}
          </p>
        </>
      )}

      {stats && stats.runsSkipped > 0 && (
        <p className="sc-dim sc-cards-skipped">{skippedLine(stats.runsSkipped)}</p>
      )}
    </section>
  );
}
