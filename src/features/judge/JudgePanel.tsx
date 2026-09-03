import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { useJudgeStore } from '../../state/judgeStore';
import type { JudgeEntry } from '../../state/judgeStore';
import { judgeErrorSentence, judgeHealth } from '../../services/judge';
import { FOCUS_DRAWER_EVENT } from '../../hooks/useHotkeys';
import type { FocusDrawerDetail } from '../../hooks/useHotkeys';
import type { JudgeHealth, JudgeRule } from '../../domain/judge';
import './judge.css';

/**
 * The judge drawer. It advises and never enforces: it reads the table as the
 * player has it, cites the rules text it was given, and declines when that text
 * does not settle the question. Nothing it says moves a card or ends a run.
 */

/** Health is a fetch, so the head has three states, not two. */
type Health = JudgeHealth | null | 'checking';

const PLACEHOLDER = 'Ask the table judge. Enter sends, Shift+Enter breaks a line.';

const UNVERIFIED_TITLE = 'Not found in the rules text';

/**
 * The head. A failure reads with the same sentence the transcript prints for it:
 * the wording for a code lives beside the code, in the service.
 */
function headLine(health: Health): string {
  if (health === 'checking') return 'Checking the judge.';
  if (health === null) return judgeErrorSentence('offline');
  // Which driver is answering, as a trailing clause. The head is already muted,
  // so it needs no styling of its own. The failure sentences below say which
  // driver they mean by what they ask for, so they do not repeat it.
  if (!health.hasKey) {
    return judgeErrorSentence(health.driver === 'claude-code' ? 'no_login' : 'no_key');
  }
  const via = health.driver === 'claude-code' ? ' · via Claude Code' : ' · via API';
  if (!health.corpusDate) return `Advisory only · no rules text loaded${via}`;
  return `Advisory only · rules effective ${health.corpusDate}${via}`;
}

/** A verified rule with text is the only kind there is anything to open. */
function isOpenable(rule: JudgeRule): boolean {
  return rule.verified && typeof rule.text === 'string' && rule.text.trim() !== '';
}

function RuleChips({ rules }: { rules: JudgeRule[] }) {
  const [open, setOpen] = useState<string[]>([]);

  if (rules.length === 0) return null;

  function toggle(id: string): void {
    setOpen((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  const shown = rules.filter((rule) => isOpenable(rule) && open.includes(rule.id));

  return (
    <>
      <div className="jd-rules">
        {rules.map((rule, i) =>
          isOpenable(rule) ? (
            <button
              key={`${rule.id}-${i}`}
              type="button"
              className="rd-chip jd-rule"
              aria-expanded={open.includes(rule.id)}
              aria-label={`Rule ${rule.id}`}
              onClick={() => toggle(rule.id)}
            >
              {rule.id}
            </button>
          ) : (
            <span
              key={`${rule.id}-${i}`}
              className={'rd-chip jd-rule' + (rule.verified ? '' : ' is-unverified')}
              title={rule.verified ? undefined : UNVERIFIED_TITLE}
            >
              {rule.id}
            </span>
          ),
        )}
      </div>

      {shown.map((rule) => (
        <p className="jd-rule-text" key={rule.id}>
          <span className="jd-rule-id">{rule.id}</span>
          {rule.text}
        </p>
      ))}
    </>
  );
}

function EntryView({ entry }: { entry: JudgeEntry }) {
  const { response, error } = entry;
  return (
    <article className="jd-entry">
      <p className="jd-q">
        <span className="jd-turn">T{entry.turn}</span>
        {entry.question}
      </p>

      {error && <p className="jd-error">{error.message}</p>}

      {response && (
        <>
          {response.status === 'decline' && (
            <div className="jd-flags">
              <span className="rd-chip">Declined</span>
            </div>
          )}
          <p className="jd-answer">{response.answer}</p>
          <p className="jd-meta">confidence {response.confidence}</p>
          <RuleChips rules={response.rules} />
          {response.caveats.length > 0 && (
            <ul className="jd-caveats">
              {response.caveats.map((caveat, i) => (
                <li key={i}>{caveat}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </article>
  );
}

export default function JudgePanel() {
  const entries = useJudgeStore((s) => s.entries);
  const pending = useJudgeStore((s) => s.pending);
  const ask = useJudgeStore((s) => s.ask);

  const [question, setQuestion] = useState('');
  const [health, setHealth] = useState<Health>('checking');
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // The head is read once, when the drawer opens. A judge that came up while the
  // drawer was shut is picked up the next time it is opened.
  useEffect(() => {
    let live = true;
    void judgeHealth().then((result) => {
      if (live) setHealth(result);
    });
    return () => {
      live = false;
    };
  }, []);

  // The J key aims at the box. The column opens the drawer and re-fires the
  // event once this panel exists, so the same listener serves both trips; the
  // note box answers the same event, hence the check on which drawer was named.
  useEffect(() => {
    function focusBox(e: Event): void {
      if ((e as CustomEvent<FocusDrawerDetail>).detail?.drawer !== 'judge') return;
      boxRef.current?.focus();
    }
    window.addEventListener(FOCUS_DRAWER_EVENT, focusBox);
    return () => window.removeEventListener(FOCUS_DRAWER_EVENT, focusBox);
  }, []);

  function submit(e?: FormEvent): void {
    e?.preventDefault();
    const text = question.trim();
    if (text === '' || pending) return;
    setQuestion('');
    void ask(text);
    // Sending from the Ask button leaves the focus on a button that is about to
    // be disabled, and a disabled focused control drops the keyboard onto the
    // table. Put the cursor back in the box either way.
    boxRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter sends, and does nothing at all while a question is out: the box
    // stays live so the next one can be written, but only one is in flight.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!pending) submit();
      return;
    }
    // Escape gives the table its keys back. The drawer closes on the next one,
    // which is the readout's own handler and not this panel's business.
    if (e.key === 'Escape') e.currentTarget.blur();
  }

  return (
    <div className="pg-judge">
      <div className="jd-head">
        <span className="rd-chip">Advisory</span>
        <p className="jd-status" role="status">
          {headLine(health)}
        </p>
      </div>

      {/* The box is never disabled. Disabling the focused control hands the keys
          back to the table, where d, t, s and u are run-changing actions — so a
          player typing through the wait would silently draw and pass turns. It
          stays live and takes the next question instead. */}
      <form className="jd-ask" onSubmit={submit}>
        <textarea
          ref={boxRef}
          className="jd-box"
          data-hotkeys="off"
          rows={3}
          value={question}
          placeholder={PLACEHOLDER}
          aria-label="Ask the table judge"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="jd-ask-foot">
          <span className="jd-pending" role="status">
            {pending ? 'Asking the judge' : ''}
          </span>
          <button type="submit" className="jd-send" disabled={pending || question.trim() === ''}>
            Ask
          </button>
        </div>
      </form>

      {entries.length === 0 ? (
        <p className="jd-empty">
          No questions yet. The judge reads the table as you have it and cites the rules.
        </p>
      ) : (
        <div className="jd-entries">
          {entries
            .slice()
            .reverse()
            .map((entry) => (
              <EntryView key={entry.id} entry={entry} />
            ))}
        </div>
      )}
    </div>
  );
}
