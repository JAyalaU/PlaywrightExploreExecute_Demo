import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  ExecutionProfileSchema, LocalWindowsExecutionProfileSchema, ProfileCatalog, ProtectedContextFactory,
  ProtectedFinalCheckError, parseTrustedBrowserBackend,
} from '../app/profile/index.js';
import { IsolatedBrowser } from '../app/profile/isolated-browser.js';

const reference = { id: 'windows-fixture', version: '1' };
const common = {
  ...reference,
  browser: 'chromium' as const,
  viewport: { width: 900, height: 600 },
  locale: 'en-US',
  timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: { default: 3000 } },
};
const localProfile = {
  ...common,
  profileSchemaVersion: '5' as const,
  presentationMode: 'headless' as const,
  browserIsolation: 'local-windows' as const,
  browserRuntime: 'playwright-chromium-windows' as const,
};
const dockerV3 = {
  ...common, profileSchemaVersion: '3' as const,
  presentationMode: 'headless' as const, browserIsolation: 'docker' as const,
};
const dockerV4 = {
  ...common, profileSchemaVersion: '4' as const,
  presentationMode: 'headed' as const, browserIsolation: 'docker' as const,
};

function factory(profile: unknown, backend?: string): ProtectedContextFactory {
  const previous = process.env.PLAYWRIGHT_DEMO_BROWSER_BACKEND;
  try {
    if (backend === undefined) delete process.env.PLAYWRIGHT_DEMO_BROWSER_BACKEND;
    else process.env.PLAYWRIGHT_DEMO_BROWSER_BACKEND = backend;
    return new ProtectedContextFactory(new ProfileCatalog([profile]));
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_DEMO_BROWSER_BACKEND;
    else process.env.PLAYWRIGHT_DEMO_BROWSER_BACKEND = previous;
  }
}

async function forbidDocker<T>(run: () => Promise<T>): Promise<T> {
  const original = IsolatedBrowser.open;
  IsolatedBrowser.open = async () => { throw new Error('Docker path reached'); };
  try { return await run(); }
  finally { IsolatedBrowser.open = original; }
}

test('versioned Windows profile parses without Docker authority; Docker v3/v4 fingerprints stay unchanged', () => {
  expect(ExecutionProfileSchema.parse(localProfile)).toEqual(localProfile);
  expect(LocalWindowsExecutionProfileSchema.parse({ ...localProfile, presentationMode: 'headed' }).presentationMode).toBe('headed');
  expect(() => ExecutionProfileSchema.parse({ ...localProfile, networkPolicyRef: reference })).toThrow();
  expect(ExecutionProfileSchema.parse(dockerV3)).toEqual(dockerV3);
  expect(ExecutionProfileSchema.parse(dockerV4)).toEqual(dockerV4);
  for (const historical of [dockerV3, dockerV4]) {
    const resolved = new ProfileCatalog([historical]).resolve(reference);
    expect(resolved.profile).toEqual(historical);
    expect(resolved.fingerprint).toBe(createHash('sha256').update(JSON.stringify(historical)).digest('hex'));
  }
  expect(new ProfileCatalog([localProfile]).resolve(reference).fingerprint)
    .not.toBe(new ProfileCatalog([dockerV3]).resolve(reference).fingerprint);
});

test('trusted backend selection is closed and captured from operator environment', () => {
  expect(parseTrustedBrowserBackend(undefined)).toBe('docker-isolated');
  expect(parseTrustedBrowserBackend('local-windows')).toBe('local-windows');
  expect(() => parseTrustedBrowserBackend('task-selected')).toThrow('Unsupported trusted browser backend');
  const selected = factory(localProfile, 'local-windows');
  expect(selected.browserBackend).toBe('local-windows');
  expect(factory(dockerV3).browserBackend).toBe('docker-isolated');
  expect(() => factory(localProfile, 'untrusted-value')).toThrow('Unsupported trusted browser backend');
});

test('backend/profile mismatch rejects before either browser launch path', async () => {
  await forbidDocker(async () => {
    await expect(factory(dockerV3, 'local-windows').open(reference)).rejects.toThrow('backend and execution profile mismatch');
    await expect(factory(localProfile).open(reference)).rejects.toThrow('backend and execution profile mismatch');
    await expect(factory(common, 'local-windows').open(reference)).rejects.toThrow('backend and execution profile mismatch');
  });
});

test('absent selection still dispatches a Docker profile to the existing isolated browser', async () => {
  const original = IsolatedBrowser.open;
  let calls = 0;
  IsolatedBrowser.open = async () => { calls++; throw new Error('Docker dispatch intercepted'); };
  try {
    await expect(factory(dockerV3).open(reference)).rejects.toThrow('Docker dispatch intercepted');
    expect(calls).toBe(1);
  } finally { IsolatedBrowser.open = original; }
});

test('local backend owns distinct usable Chromium browsers and contexts, then closes both without Docker', async () => {
  test.skip(process.platform !== 'win32', 'Windows process boundary');
  await forbidDocker(async () => {
    const selected = factory(localProfile, 'local-windows');
    const first = await selected.open(reference);
    const firstBrowser = first.context.browser();
    let second: Awaited<ReturnType<typeof selected.open>> | undefined;
    let secondBrowser: ReturnType<typeof first.context.browser> = null;
    try {
      second = await selected.open(reference, first.effectiveProfile);
      secondBrowser = second.context.browser();
      expect(firstBrowser).toBeTruthy();
      expect(secondBrowser).toBeTruthy();
      expect(firstBrowser).not.toBe(secondBrowser);
      expect(first.context).not.toBe(second.context);
      expect(firstBrowser?.isConnected()).toBe(true);
      expect(secondBrowser?.isConnected()).toBe(true);
      expect(first.isolationContainerId).toBeUndefined();
      expect(first.isViewerHeaded).toBe(false);
      const page = await first.context.newPage();
      await page.goto('data:text/html,<title>local fixture</title><p>ready</p>');
      expect(await page.locator('p').innerText()).toBe('ready');
      expect(await page.evaluate(() => [innerWidth, innerHeight])).toEqual([900, 600]);
      expect(first.versions.browser).toMatch(/^\d+/);
    } finally {
      await first.close();
      await second?.close();
    }
    expect(firstBrowser?.isConnected()).toBe(false);
    expect(secondBrowser?.isConnected()).toBe(false);
    await expect(first.context.newPage()).rejects.toThrow();
    await first.close();
  });
});

test('local close hook and failed final check still close the owned browser', async () => {
  test.skip(process.platform !== 'win32', 'Windows process boundary');
  await forbidDocker(async () => {
    const session = await factory(localProfile, 'local-windows').open(reference);
    const browser = session.context.browser();
    let called = 0;
    session.onClosing(() => { called++; });
    await expect(session.closeWithFinalCheck(async () => { throw new Error('final read failed'); }))
      .rejects.toBeInstanceOf(ProtectedFinalCheckError);
    expect(called).toBe(1);
    expect(browser?.isConnected()).toBe(false);
  });
});
