import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext } from '@playwright/test';
import { installSubprocessCancellation } from '../app/subprocess/cancellation.js';
import { ProtectedBrowserSession } from '../app/profile/context.js';
import type { EffectiveProfile } from '../app/profile/contracts.js';
import type { ProtectedProxy } from '../app/profile/network.js';
import type { IsolatedBrowser } from '../app/profile/isolated-browser.js';

test('P4-2 Node child catches the host graceful cancellation signal', () => {
  const controller = new AbortController();
  const remove = installSubprocessCancellation(controller);
  try {
    process.emit(process.platform === 'win32' ? 'SIGBREAK' : 'SIGTERM');
    expect(controller.signal.aborted).toBe(true);
  } finally { remove(); }
});

test('P4-2 concurrent protected closes both await isolated disposal', async () => {
  let finishDisposal!: () => void;
  const disposal = new Promise<void>((resolve) => { finishDisposal = resolve; });
  let contextClosed = 0;
  let isolatedClosed = 0;
  let proxyClosed = 0;
  const session = new ProtectedBrowserSession(
    { version: () => 'test' } as Browser,
    { close: async () => { contextClosed++; } } as unknown as BrowserContext,
    { close: async () => { proxyClosed++; } } as unknown as ProtectedProxy,
    { fingerprint: '0'.repeat(64) } as EffectiveProfile,
    { close: async () => { isolatedClosed++; await disposal; } } as unknown as IsolatedBrowser,
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
  expect([contextClosed, isolatedClosed, proxyClosed]).toEqual([1, 1, 1]);
  await session.close();
  expect([contextClosed, isolatedClosed, proxyClosed]).toEqual([1, 1, 1]);
});

test('P4-2 cleanup failure propagates after proxy close', async () => {
  let proxyClosed = false;
  const session = new ProtectedBrowserSession(
    { version: () => 'test' } as Browser,
    { close: async () => undefined } as unknown as BrowserContext,
    { close: async () => { proxyClosed = true; } } as unknown as ProtectedProxy,
    { fingerprint: '0'.repeat(64) } as EffectiveProfile,
    { close: async () => { throw new Error('disposal failed'); } } as unknown as IsolatedBrowser,
  );
  await expect(session.close()).rejects.toThrow('Protected browser session cleanup failed');
  expect(proxyClosed).toBe(true);
});
