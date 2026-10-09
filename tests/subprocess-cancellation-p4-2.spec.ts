import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext } from '@playwright/test';
import { installSubprocessCancellation } from '../app/subprocess/cancellation.js';
import { ProtectedBrowserSession } from '../app/profile/local-context.js';
import type { NativeEffectiveProfile } from '../app/profile/native-profile.js';

test('P4-2 Node child catches the host graceful cancellation signal', () => {
  const controller = new AbortController();
  const remove = installSubprocessCancellation(controller);
  try {
    process.emit(process.platform === 'win32' ? 'SIGBREAK' : 'SIGTERM');
    expect(controller.signal.aborted).toBe(true);
  } finally { remove(); }
});

test('concurrent native protected closes await browser disposal', async () => {
  let finishDisposal!: () => void;
  const disposal = new Promise<void>((resolve) => { finishDisposal = resolve; });
  let contextClosed = 0;
  let browserClosed = 0;
  const session = new ProtectedBrowserSession(
    { version: () => 'test', close: async () => { browserClosed++; await disposal; } } as Browser,
    { close: async () => { contextClosed++; } } as unknown as BrowserContext,
    { fingerprint: '0'.repeat(64) } as NativeEffectiveProfile,
  );
  let observerClose: Promise<void> | undefined;
  session.onClosing(() => { observerClose = session.close(); });
  const first = session.close();
  const second = session.close();
  expect(second).toBe(first);
  let settled = false;
  void second.then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  finishDisposal();
  await Promise.all([first, second]);
  expect(observerClose).toBe(first);
  expect([contextClosed, browserClosed]).toEqual([1, 1]);
  await session.close();
  expect([contextClosed, browserClosed]).toEqual([1, 1]);
});

test('P4-2 cleanup failure propagates after context close', async () => {
  let contextClosed = false;
  const session = new ProtectedBrowserSession(
    { version: () => 'test', close: async () => { throw new Error('disposal failed'); } } as unknown as Browser,
    { close: async () => { contextClosed = true; } } as unknown as BrowserContext,
    { fingerprint: '0'.repeat(64) } as NativeEffectiveProfile,
  );
  await expect(session.close()).rejects.toThrow('Protected browser session cleanup failed');
  expect(contextClosed).toBe(true);
});
