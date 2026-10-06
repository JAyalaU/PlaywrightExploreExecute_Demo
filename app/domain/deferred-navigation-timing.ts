/** Volatile, bounded instrumentation for local navigation tests and spikes. */
export type DeferredNavigationTimingEvent = {
  phase: 'exploration' | 'compilation' | 'replay_1' | 'replay_2';
  boundary: 'request_start' | 'domcontentloaded' | 'fresh_target_ready' | 'authored_action_start';
  elapsedMs: number;
};
export type DeferredNavigationTimingObserver = (event: DeferredNavigationTimingEvent) => void;

export function navigationTiming(observer: DeferredNavigationTimingObserver | undefined,
  phase: DeferredNavigationTimingEvent['phase'], boundary: DeferredNavigationTimingEvent['boundary'],
  origin: number, measuredElapsedMs?: number): void {
  if (!observer) return;
  try { observer({ phase, boundary, elapsedMs: Math.min(120_000, Math.max(0,
    Math.round(measuredElapsedMs ?? performance.now() - origin))) }); }
  catch { /* Timing cannot change execution or QA. */ }
}
