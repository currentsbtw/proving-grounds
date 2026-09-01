import type { Phase } from './types';

export const PHASES: Phase[] = ['untap', 'upkeep', 'draw', 'main1', 'combat', 'main2', 'end'];

export const PHASE_LABELS: Record<Phase, string> = {
  untap: 'Untap',
  upkeep: 'Upkeep',
  draw: 'Draw',
  main1: 'Main 1',
  combat: 'Combat',
  main2: 'Main 2',
  end: 'End',
};

export const FIRST_PHASE: Phase = 'untap';
export const LAST_PHASE: Phase = 'end';

export function phaseIndex(phase: Phase): number {
  return PHASES.indexOf(phase);
}

export function isLastPhase(phase: Phase): boolean {
  return phase === LAST_PHASE;
}

/** Next phase in turn order; wraps from 'end' back to 'untap'. */
export function nextPhaseOf(phase: Phase): Phase {
  const i = phaseIndex(phase);
  return PHASES[(i + 1) % PHASES.length];
}

export function prevPhaseOf(phase: Phase): Phase {
  const i = phaseIndex(phase);
  return PHASES[(i - 1 + PHASES.length) % PHASES.length];
}

export function phaseLabel(phase: Phase): string {
  return PHASE_LABELS[phase];
}
