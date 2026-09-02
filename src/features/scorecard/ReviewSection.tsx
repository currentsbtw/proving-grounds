import type { FindingKind, Review, ReviewFinding } from '../../engine/review';

/**
 * The run read back as a short list of what went right and wrong. It sits under
 * the verdict because the verdict names one finding and this is the rest of
 * them; the metric slots below are the figures both are cut from.
 *
 * The kind is printed as a word (MISS / GOOD / NOTE) and only then coloured, so
 * the list survives greyscale and forced colours — the same rule the seat chips
 * and the event ledger follow.
 *
 * The review itself arrives already built, from `useScorecards`, so it is
 * replayed once per run rather than once per render and it reads the same card
 * facts the scorecard was scored against. A legacy run whose facts never
 * resolved has almost nothing to count, which is `partial`: an empty list there
 * means the run could not be read, not that it was played clean.
 */

const KIND_WORD: Record<FindingKind, string> = {
  miss: 'MISS',
  good: 'GOOD',
  note: 'NOTE',
};

/** "T5", "T2-9", or nothing when the finding is about the run as a whole. */
function turnLabel(finding: ReviewFinding): string {
  const turns = finding.turns;
  if (turns.length === 0) return '';
  const first = turns[0];
  const last = turns[turns.length - 1];
  return first === last ? `T${first}` : `T${first}-${last}`;
}

export default function ReviewSection({ review, partial }: { review: Review; partial: boolean }) {
  return (
    <section className="sc-section sc-review">
      <h3 className="panel-heading">Review</h3>

      {review.findings.length === 0 ? (
        <p className="sc-empty">
          {partial
            ? 'This run was imported before card facts were stored. Too little is known about the cards to flag anything.'
            : 'Nothing to flag by the numbers.'}
        </p>
      ) : (
        <ul className="sc-review-list">
          {review.findings.map((finding) => (
            <li key={finding.id} className={`sc-review-row is-${finding.kind}`}>
              <span className="sc-review-kind">{KIND_WORD[finding.kind]}</span>
              <span className="sc-review-turn num">{turnLabel(finding)}</span>
              <span className="sc-review-body">
                <span className="sc-review-title">{finding.title}</span>
                <span className="sc-review-detail">{finding.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="sc-review-foot">{review.footer}</p>
    </section>
  );
}
