import type { Frame, Page } from '@playwright/test';
import type { ProtectedBrowserSession } from '../profile/context.js';
import { DeferredRunnerStopV9Schema } from '../domain/deferred-action-runner.js';
import { diagnosticBrowserUrl, diagnosticElapsed, diagnosticExceptionName,
  type DeferredBrowserDiagnosticSink, type DeferredBrowserDiagnosticV1 } from '../domain/deferred-browser-diagnostics.js';

type Operation = Extract<DeferredBrowserDiagnosticV1['operation'],
  'pre_action_ownership' | 'rich_after_url' | 'frame_enumeration' | 'frame_content' |
  'runner_v9_state' | 'execution_entry_ownership'>;
type Category = NonNullable<DeferredBrowserDiagnosticV1['runnerExceptionCategory']>;

/** Message inspection is local to this closed classifier; messages never enter a diagnostic. */
export function classifyRunnerV9ReadError(error: unknown, state: {
  page: DeferredBrowserDiagnosticV1['page']; context: DeferredBrowserDiagnosticV1['context'];
  browser: DeferredBrowserDiagnosticV1['browser']; frameState?: DeferredBrowserDiagnosticV1['frameState'];
}): Category {
  if (state.context === 'closed') return 'CONTEXT_CLOSED';
  if (state.browser === 'disconnected') return 'BROWSER_DISCONNECTED';
  if (state.page === 'closed') return 'PAGE_CLOSED';
  if (state.frameState === 'detached') return 'FRAME_DETACHED';
  const name = error instanceof Error ? error.name : '';
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : '';
  if (name === 'TimeoutError' || /(?:^|\b)Timeout \d+ms exceeded|timed out/i.test(message)) return 'PLAYWRIGHT_TIMEOUT';
  if (/execution context was destroyed|cannot find context with specified id/i.test(message)) return 'EXECUTION_CONTEXT_DESTROYED';
  if (/navigation|navigating|document was replaced/i.test(message)) return 'NAVIGATION_INTERRUPTED';
  if (/frame was detached|frame has been detached/i.test(message)) return 'FRAME_DETACHED';
  if (/browser has been closed|target closed/i.test(message)) return 'PAGE_CLOSED';
  if (/protocol error|session closed|connection closed/i.test(message) || /^(?:ERR_PROTOCOL|PROTOCOL_ERROR)$/.test(code)) return 'PROTOCOL_ERROR';
  if (/locator\.textContent|frame\.content|runner_v9_state/i.test(message)) return 'STATE_READ_API_FAILURE';
  return 'UNKNOWN_PLAYWRIGHT_ERROR';
}

/** Best-effort, private observation of the existing runner operations. Never grants run authority. */
export class RunnerV9PreactionDiagnostics {
  readonly #frameIds = new WeakMap<Frame, string>();
  #nextFrameId = 0;
  constructor(readonly session: ProtectedBrowserSession, readonly page: Page, readonly ownerId: string,
    readonly phase: 'replay_1' | 'replay_2', readonly sink?: DeferredBrowserDiagnosticSink) {}

  frameId(frame: Frame): string {
    let id = this.#frameIds.get(frame);
    if (!id) { id = `runner-frame-${++this.#nextFrameId}`; this.#frameIds.set(frame, id); }
    return id;
  }

  mainFrameId(): string | undefined { try { return this.frameId(this.page.mainFrame()); } catch { return undefined; } }

  #state(frame?: Frame) {
    try {
      const context = this.session.context, pages = context.pages(), browser = context.browser();
      const state = { page: this.page.isClosed() ? 'closed' as const : 'open' as const,
        context: this.session.isClosed ? 'closed' as const : 'open' as const,
        browser: !browser ? 'absent' as const : browser.isConnected() ? 'connected' as const : 'disconnected' as const,
        pageCount: Math.min(pages.length, 1_000_000), ownedPagePresent: pages.includes(this.page),
        ...(diagnosticBrowserUrl(frame ? frame.url() : this.page.url()) ?
          { currentUrl: diagnosticBrowserUrl(frame ? frame.url() : this.page.url()) } : {}),
        ...(frame ? { frameState: frame.isDetached() ? 'detached' as const : 'attached' as const } : {}) };
      return state;
    } catch { return { page: 'unknown' as const, context: 'unknown' as const, browser: 'unknown' as const }; }
  }

  #emit(operation: Operation, stepId: string, start: number, outcome: DeferredBrowserDiagnosticV1['outcome'],
    frame?: Frame, extra: Partial<DeferredBrowserDiagnosticV1> = {}, error?: unknown) {
    if (!this.sink) return;
    try {
      const end = performance.now(), state = this.#state(frame);
      this.sink({ diagnosticVersion: '1', source: 'runner', operation, phase: this.phase, ownerId: this.ownerId,
        stepId, startedAtMs: start, endedAtMs: end, elapsedMs: diagnosticElapsed(start, end), outcome,
        ...state, ...(frame ? { frameId: this.frameId(frame) } : {}), ...extra,
        ...(error === undefined ? {} : {
          exceptionName: diagnosticExceptionName(error),
          runnerExceptionCategory: classifyRunnerV9ReadError(error, state),
          playwrightTimeout: classifyRunnerV9ReadError(error, state) === 'PLAYWRIGHT_TIMEOUT',
          ...(error && typeof error === 'object' && 'reason' in error &&
            DeferredRunnerStopV9Schema.safeParse(error.reason).success ?
            { runnerStopCode: error.reason as DeferredBrowserDiagnosticV1['runnerStopCode'] } : {}),
        }) });
    } catch { /* Diagnostics cannot affect replay. */ }
  }

  sync<T>(operation: Operation, stepId: string, work: () => T, frame?: Frame,
    extra?: Partial<DeferredBrowserDiagnosticV1>): T {
    if (!this.sink) return work();
    const started = performance.now(); this.#emit(operation, stepId, started, 'started', frame, extra);
    try { const value = work(); this.#emit(operation, stepId, started, 'success', frame, extra); return value; }
    catch (error) { this.#emit(operation, stepId, started, 'failure', frame, extra, error); throw error; }
  }

  frames(stepId: string): Frame[] {
    if (!this.sink) return this.page.frames();
    const started = performance.now(); this.#emit('frame_enumeration', stepId, started, 'started');
    try {
      const frames = this.page.frames();
      let mainFrameId: string | undefined, frameState: 'attached' | 'detached' | 'unknown' = 'unknown';
      try { const main = this.page.mainFrame(); mainFrameId = this.frameId(main);
        frameState = main.isDetached() ? 'detached' : 'attached'; } catch { /* Observation only. */ }
      this.#emit('frame_enumeration', stepId, started, 'success', undefined,
        { frameCount: frames.length, ...(mainFrameId ? { mainFrameId } : {}), frameState });
      return frames;
    } catch (error) { this.#emit('frame_enumeration', stepId, started, 'failure', undefined, {}, error); throw error; }
  }

  async async<T>(operation: Operation, stepId: string, work: () => Promise<T>, frame?: Frame,
    extra?: Partial<DeferredBrowserDiagnosticV1>): Promise<T> {
    if (!this.sink) return work();
    const started = performance.now(); this.#emit(operation, stepId, started, 'started', frame, extra);
    try { const value = await work(); this.#emit(operation, stepId, started, 'success', frame, extra); return value; }
    catch (error) { this.#emit(operation, stepId, started, 'failure', frame, extra, error); throw error; }
  }
}
