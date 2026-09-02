import { useEffect, useRef, useState } from 'react';
import { useGameStore } from '../../../state/gameStore';
import type { RunResult } from '../../../domain/types';

const CONFIRM_MS = 3000;
const COPIED_MS = 1200;

const OPTIONS: { result: RunResult; label: string; cls: string }[] = [
  { result: 'win', label: 'Win', cls: 'is-win' },
  { result: 'loss', label: 'Loss', cls: 'is-loss' },
  { result: 'concede', label: 'Concede', cls: 'is-concede' },
];

/** The confirm button says the word it is about to write into the log. */
const RESULT_WORD: Partial<Record<RunResult, string>> = {
  win: 'Win',
  loss: 'Loss',
  concede: 'Concede',
};

/** The question, and the same sentence as the confirm button's accessible name. */
const CONFIRM_ASK: Partial<Record<RunResult, string>> = {
  win: 'End the run as a win?',
  loss: 'End the run as a loss?',
  concede: 'Concede and end the run?',
};

const CONFIRM_DO: Partial<Record<RunResult, string>> = {
  win: 'End the run as a win',
  loss: 'End the run as a loss',
  concede: 'Concede and end the run',
};

/** Footer: Win / Loss / Concede with a 3s inline confirm, plus click-to-copy seed. */
export default function EndRunControls() {
  const endRun = useGameStore((s) => s.endRun);
  const seed = useGameStore((s) => s.run?.seed) ?? '';

  const [pending, setPending] = useState<RunResult | null>(null);
  const [copied, setCopied] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  function arm(result: RunResult): void {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setPending(result);
    confirmTimer.current = setTimeout(() => setPending(null), CONFIRM_MS);
  }

  function cancel(): void {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = null;
    setPending(null);
  }

  function commit(result: RunResult): void {
    cancel();
    void endRun(result);
  }

  function copySeed(): void {
    if (!seed) return;
    const done = () => {
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), COPIED_MS);
    };
    navigator.clipboard?.writeText(seed).then(done, () => undefined);
  }

  return (
    <div className="hud-endrun">
      {pending ? (
        <span className="hud-confirm">
          {CONFIRM_ASK[pending] ?? 'End the run?'}
          <button
            type="button"
            className="is-yes"
            aria-label={CONFIRM_DO[pending] ?? 'End the run'}
            onClick={() => commit(pending)}
          >
            {RESULT_WORD[pending] ?? 'End run'}
          </button>
          <button type="button" className="is-no" onClick={cancel}>
            Keep playing
          </button>
        </span>
      ) : (
        OPTIONS.map((opt) => (
          <button
            key={opt.result}
            type="button"
            className={opt.cls}
            onClick={() => arm(opt.result)}
          >
            {opt.label}
          </button>
        ))
      )}

      <span className="hud-endrun-spacer" />

      <button
        type="button"
        className="hud-seed"
        title="Copy run seed"
        aria-label={copied ? `Run seed ${seed} copied` : `Copy run seed ${seed}`}
        onClick={copySeed}
      >
        {copied ? 'copied' : `seed ${seed}`}
      </button>
    </div>
  );
}
