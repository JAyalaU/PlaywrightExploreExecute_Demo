import { expect, test } from '@playwright/test';
import type { Frame } from '@playwright/test';
import type { ProtectedBrowserSession } from '../app/profile/context.js';
import { classifyProtectedAriaFailure, readProtectedAriaState } from '../app/exploration/protected-aria-state.js';

function fixture(options: { pageClosed?: boolean; contextClosed?: boolean; disconnected?: boolean;
  detached?: boolean; failure?: Error } = {}) {
  const calls: { selector: string[]; snapshot: unknown[] } = { selector: [], snapshot: [] };
  const frame = { isDetached: () => !!options.detached, page: () => ({ isClosed: () => !!options.pageClosed }),
    locator: (selector: string) => { calls.selector.push(selector); return { ariaSnapshot: async (input: unknown) => {
      calls.snapshot.push(input);
      if (options.failure) throw options.failure;
      return '- heading "Ready"';
    } }; } } as unknown as Frame;
  const session = { isClosed: !!options.contextClosed,
    context: { browser: () => ({ isConnected: () => !options.disconnected }) } } as unknown as ProtectedBrowserSession;
  return { frame, session, calls };
}

function failure(message: string, name = 'Error', code?: string) {
  const error = new Error(message) as Error & { code?: string };
  error.name = name;
  if (code) error.code = code;
  return error;
}

test('protected ARIA helper preserves the exact body call and successful result', async () => {
  const f = fixture();
  const reports: unknown[] = [];
  expect(await readProtectedAriaState(f.frame, f.session, report => reports.push(report))).toBe('- heading "Ready"');
  expect(f.calls).toEqual({ selector: ['body'], snapshot: [{ mode: 'ai', timeout: 3000 }] });
  expect(reports).toEqual([]);
});

for (const [title, options, expected, timedOut] of [
  ['timeout', { failure: failure('Timeout 3000ms exceeded; secret=token', 'TimeoutError') }, 'PLAYWRIGHT_TIMEOUT', true],
  ['target closed', { failure: failure('Target page, context or browser has been closed; secret=token', 'TargetClosedError') }, 'TARGET_CLOSED', false],
  ['page closed', { pageClosed: true, failure: failure('secret=token') }, 'PAGE_CLOSED', false],
  ['context closed', { contextClosed: true, failure: failure('secret=token') }, 'CONTEXT_CLOSED', false],
  ['browser disconnected', { disconnected: true, failure: failure('secret=token') }, 'BROWSER_DISCONNECTED', false],
  ['frame detached', { detached: true, failure: failure('secret=token') }, 'FRAME_DETACHED', false],
  ['execution context destroyed', { failure: failure('Execution context was destroyed, most likely because of a navigation; secret=token') }, 'EXECUTION_CONTEXT_DESTROYED', false],
  ['navigation interrupted', { failure: failure('Navigation interrupted by another navigation; secret=token') }, 'NAVIGATION_INTERRUPTED', false],
  ['protocol error', { failure: failure('secret=token', 'ProtocolError', 'PROTOCOL_ERROR') }, 'PROTOCOL_ERROR', false],
  ['ARIA API failure', { failure: failure('locator.ariaSnapshot: unsupported operation; secret=token') }, 'ARIA_SNAPSHOT_API_FAILURE', false],
  ['unknown error', { failure: failure('secret=token') }, 'UNKNOWN_PLAYWRIGHT_ERROR', false],
] as const) {
  test(`protected ARIA read classifies ${title} without changing its failure`, async () => {
    const f = fixture(options);
    const reports: unknown[] = [];
    await expect(readProtectedAriaState(f.frame, f.session, report => reports.push(report)))
      .rejects.toBe(options.failure);
    expect(f.calls).toEqual({ selector: ['body'], snapshot: [{ mode: 'ai', timeout: 3000 }] });
    expect(reports).toMatchObject([{ ariaFailureCategory: expected, playwrightTimeout: timedOut }]);
    expect(JSON.stringify(reports)).not.toContain('secret=token');
  });
}

test('classifier handles a structured timeout code without persisting raw text', () => {
  const f = fixture();
  const classified = classifyProtectedAriaFailure(failure('secret=token', 'Error', 'ETIMEDOUT'), f.frame, f.session);
  expect(classified).toMatchObject({ ariaFailureCategory: 'PLAYWRIGHT_TIMEOUT', playwrightTimeout: true });
  expect(JSON.stringify(classified)).not.toContain('secret=token');
});
