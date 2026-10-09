import { setTimeout as delay } from 'node:timers/promises';

/** Trusted process setting; never sourced from a TestSpec, model response, or artifact. */
export const MAX_DEMO_ACTION_PAUSE_MS = 3_000;

export function parseDemoActionPauseMs(raw: string | undefined): number {
  if (raw === undefined || raw === '0') return 0;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error('Invalid PLAYWRIGHT_DEMO_ACTION_PAUSE_MS');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_DEMO_ACTION_PAUSE_MS)
    throw new Error('Invalid PLAYWRIGHT_DEMO_ACTION_PAUSE_MS');
  return value;
}

export type PresentationClock = {
  now(): number;
  wait(ms: number): Promise<void>;
};

const realClock: PresentationClock = { now: () => Date.now(), wait: ms => delay(ms) };

/** Returns elapsed presentation time so the caller can exclude it from its execution budget. */
export async function pauseAfterSuccessfulAction(ms: number,
  clock: PresentationClock = realClock): Promise<number> {
  if (ms === 0) return 0;
  const started = clock.now();
  await clock.wait(ms);
  return Math.max(0, clock.now() - started);
}
