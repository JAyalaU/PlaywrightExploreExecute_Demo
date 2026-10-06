import { expect, test, type Frame, type Page } from '@playwright/test';
import { DeferredBrowserDiagnosticCollector, DeferredBrowserDiagnosticV1Schema } from
  '../app/domain/deferred-browser-diagnostics.js';
import { RunnerV9PreactionDiagnostics, classifyRunnerV9ReadError } from
  '../app/runner/deferred-v9-diagnostics.js';
import type { ProtectedBrowserSession } from '../app/profile/context.js';

function fixture() {
  const collector = new DeferredBrowserDiagnosticCollector();
  const frame = { url: () => 'https://example.test/dropdown?secret=hidden#fragment',
    isDetached: () => false } as unknown as Frame;
  const page = { frames: () => [frame], mainFrame: () => frame, isClosed: () => false,
    url: frame.url } as unknown as Page;
  const browser = { isConnected: () => true };
  const context = { pages: () => [page], browser: () => browser };
  const session = { context, isClosed: false } as unknown as ProtectedBrowserSession;
  const observer = new RunnerV9PreactionDiagnostics(session, page, 'run-test', 'replay_1', collector.record);
  return { collector, frame, page, browser, context, session, observer };
}

test('successful ownership, state enclosure, frame enumeration and reads remain separate bounded events', async () => {
  const f = fixture();
  f.observer.sync('pre_action_ownership', 'step_4', () => undefined);
  await f.observer.async('rich_after_url', 'step_4', async () => {
    const frames = f.observer.frames('step_4');
    await f.observer.async('frame_content', 'step_4', async () => '<private>secret</private>', frames[0]);
    await f.observer.async('runner_v9_state', 'step_4', async () => 'private body text', frames[0]);
  });
  f.observer.sync('execution_entry_ownership', 'step_4', () => undefined);
  const events = f.collector.snapshot();
  for (const operation of ['pre_action_ownership', 'rich_after_url', 'frame_enumeration',
    'frame_content', 'runner_v9_state', 'execution_entry_ownership'])
    expect(events.filter(e => e.operation === operation).map(e => e.outcome)).toEqual(['started', 'success']);
  expect(events.find(e => e.operation === 'frame_enumeration' && e.outcome === 'success'))
    .toMatchObject({ frameCount: 1, mainFrameId: 'runner-frame-1', ownerId: 'run-test', phase: 'replay_1',
      currentUrl: 'https://example.test/dropdown' });
  expect(events.every(e => e.pageCount === 1 && e.ownedPagePresent === true && e.context === 'open' &&
    e.browser === 'connected' && e.startedAtMs <= e.endedAtMs && e.elapsedMs >= 0)).toBe(true);
  const serialized = JSON.stringify(events);
  expect(serialized).not.toMatch(/private|secret|fragment|<private>|body text/);
  events.forEach(e => expect(DeferredBrowserDiagnosticV1Schema.safeParse(e).success).toBe(true));
});

test('frame content and state read failures identify their own operation without storing text', async () => {
  const f = fixture();
  const privateError = new Error('frame.content: secret markup unavailable');
  await expect(f.observer.async('frame_content', 'step_4', async () => { throw privateError; }, f.frame))
    .rejects.toBe(privateError);
  await expect(f.observer.async('runner_v9_state', 'step_4', async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    const error = new Error('locator.textContent: Timeout 3000ms exceeded; private body');
    error.name = 'TimeoutError'; throw error;
  }, f.frame)).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(f.collector.snapshot().filter(e => e.outcome === 'failure')).toMatchObject([
    { operation: 'frame_content', runnerExceptionCategory: 'STATE_READ_API_FAILURE' },
    { operation: 'runner_v9_state', runnerExceptionCategory: 'PLAYWRIGHT_TIMEOUT', playwrightTimeout: true },
  ]);
  expect(JSON.stringify(f.collector.snapshot())).not.toMatch(/secret|private body|markup unavailable/);
});

test('closed and transport categories use safe state and closed classifications', async () => {
  const base = { page: 'open' as const, context: 'open' as const, browser: 'connected' as const,
    frameState: 'attached' as const };
  const examples = [
    [{ ...base, page: 'closed' as const }, new Error('private'), 'PAGE_CLOSED'],
    [{ ...base, context: 'closed' as const }, new Error('private'), 'CONTEXT_CLOSED'],
    [{ ...base, browser: 'disconnected' as const }, new Error('private'), 'BROWSER_DISCONNECTED'],
    [{ ...base, frameState: 'detached' as const }, new Error('private'), 'FRAME_DETACHED'],
    [base, new Error('Execution context was destroyed'), 'EXECUTION_CONTEXT_DESTROYED'],
    [base, new Error('Navigation interrupted the read'), 'NAVIGATION_INTERRUPTED'],
    [base, new Error('Protocol error while reading'), 'PROTOCOL_ERROR'],
    [base, new Error('locator.textContent: API failed'), 'STATE_READ_API_FAILURE'],
    [base, new Error('entirely private unknown error'), 'UNKNOWN_PLAYWRIGHT_ERROR'],
  ] as const;
  for (const [state, error, category] of examples) expect(classifyRunnerV9ReadError(error, state)).toBe(category);
});

test('page, context, browser and detached-frame failures produce distinct private records', async () => {
  for (const [kind, expected] of [
    ['page', 'PAGE_CLOSED'], ['context', 'CONTEXT_CLOSED'],
    ['browser', 'BROWSER_DISCONNECTED'], ['frame', 'FRAME_DETACHED'],
  ] as const) {
    const f = fixture();
    if (kind === 'page') f.page.isClosed = () => true;
    if (kind === 'context') (f.session as { isClosed: boolean }).isClosed = true;
    if (kind === 'browser') f.browser.isConnected = () => false;
    if (kind === 'frame') f.frame.isDetached = () => true;
    await expect(f.observer.async('runner_v9_state', 'step_4', async () => {
      throw new Error('private state read failure');
    }, f.frame)).rejects.toThrow();
    expect(f.collector.snapshot().at(-1)?.runnerExceptionCategory).toBe(expected);
    expect(JSON.stringify(f.collector.snapshot())).not.toContain('private state read failure');
  }
});

test('execution-entry ownership failure retains the original thrown object and safe runner stop', () => {
  const f = fixture();
  const stop = Object.assign(new Error('private ownership detail'), { reason: 'ENVIRONMENT_FAILURE' });
  expect(() => f.observer.sync('execution_entry_ownership', 'step_4', () => { throw stop; })).toThrow(stop);
  expect(f.collector.snapshot().at(-1)).toMatchObject({ operation: 'execution_entry_ownership', outcome: 'failure',
    runnerStopCode: 'ENVIRONMENT_FAILURE', page: 'open', context: 'open', browser: 'connected' });
  expect(JSON.stringify(f.collector.snapshot())).not.toContain('private ownership detail');
});
