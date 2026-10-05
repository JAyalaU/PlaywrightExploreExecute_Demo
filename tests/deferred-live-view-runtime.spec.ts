import { EventEmitter } from 'node:events';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext } from '@playwright/test';
import { ProfileCatalog } from '../app/profile/contracts.js';
import { ProtectedContextFactory } from '../app/profile/context.js';
import { IsolatedBrowser } from '../app/profile/isolated-browser.js';
import { ViewerGateway } from '../app/observability/viewer-gateway.js';

const profile = {
  id: 'deferred-view-fixture', version: '1', profileSchemaVersion: '3' as const,
  presentationMode: 'headless' as const, browserIsolation: 'docker' as const,
  browser: 'chromium' as const, viewport: { width: 900, height: 600 }, locale: 'en-US',
  timeoutPolicy: { actionMs: 3_000, navigationMs: 5_000, waits: { default: 3_000 } },
};
const reference = { id: profile.id, version: profile.version };

function isolatedFixture(headed: boolean) {
  let bridges = 0, closed = 0;
  const browser = { version: () => 'fixture', newContext: async () => ({
    setDefaultTimeout: () => undefined, setDefaultNavigationTimeout: () => undefined,
    close: async () => undefined,
  } as unknown as BrowserContext) } as unknown as Browser;
  const isolated = {
    browser, containerId: 'a'.repeat(64), isHeaded: headed,
    openRfbBridge: () => {
      bridges++;
      const stream = new EventEmitter();
      const child = Object.assign(new EventEmitter(), { stdout: stream, kill: () => undefined });
      setImmediate(() => stream.emit('data', Buffer.from('RFB 003.008\n')));
      return child;
    },
    close: async () => { closed++; },
  } as unknown as IsolatedBrowser;
  return { isolated, get bridges() { return bridges; }, get closed() { return closed; } };
}

test('deferred live view uses the same headed isolated session without changing profile identity', async () => {
  const catalog = new ProfileCatalog([profile], []);
  const effective = catalog.resolve(reference);
  const fixture = isolatedFixture(true);
  const original = IsolatedBrowser.open;
  const launches: unknown[][] = [];
  IsolatedBrowser.open = async (...args) => { launches.push(args); return fixture.isolated; };
  let gateway: ViewerGateway | undefined;
  try {
    const session = await new ProtectedContextFactory(catalog, undefined, undefined,
      { viewOnlyHeaded: true }).open(reference, effective);
    try {
      expect(launches).toEqual([['headed', { observationalSlowMo: false }]]);
      expect(session.effectiveProfile.fingerprint).toBe(effective.fingerprint);
      expect(session.effectiveProfile.profile).toMatchObject({
        profileSchemaVersion: '3', presentationMode: 'headless',
      });
      expect(session.isViewerHeaded).toBe(true);
      gateway = await ViewerGateway.start(session);
      expect(gateway.port).toBeGreaterThan(0);
      expect(fixture.bridges).toBe(1);
      session.onClosing(() => gateway?.close());
    } finally { await session.close(); }
    expect(session.isViewerHeaded).toBe(false);
    expect(fixture.closed).toBe(1);
    expect(() => session.openRfbBridge()).toThrow('Headed RFB session unavailable');
  } finally {
    gateway?.close(); IsolatedBrowser.open = original;
  }
});

test('disabled live view keeps the isolated headless launch and denies RFB', async () => {
  const catalog = new ProfileCatalog([profile], []);
  const fixture = isolatedFixture(false);
  const original = IsolatedBrowser.open;
  const launches: unknown[][] = [];
  IsolatedBrowser.open = async (...args) => { launches.push(args); return fixture.isolated; };
  try {
    const session = await new ProtectedContextFactory(catalog).open(reference);
    try {
      expect(launches).toEqual([['headless', { observationalSlowMo: true }]]);
      expect(session.isViewerHeaded).toBe(false);
      expect(() => session.openRfbBridge()).toThrow('Headed RFB session unavailable');
      await expect(ViewerGateway.start(session)).rejects.toThrow('Headed isolated session required');
      expect(fixture.bridges).toBe(0);
    } finally { await session.close(); }
  } finally { IsolatedBrowser.open = original; }
});

test('deferred viewer lifetime reports unavailability without closing its browser session', async () => {
  const catalog = new ProfileCatalog([profile], []);
  const fixture = isolatedFixture(true);
  const original = IsolatedBrowser.open;
  IsolatedBrowser.open = async () => fixture.isolated;
  try {
    const session = await new ProtectedContextFactory(catalog, undefined, undefined,
      { viewOnlyHeaded: true }).open(reference);
    let unavailable = 0;
    let gateway: ViewerGateway | undefined;
    try {
      let expired!: () => void;
      const expiration = new Promise<void>((resolve) => { expired = resolve; });
      gateway = await ViewerGateway.start(session, undefined, { sessionLifetimeMs: 20,
        onUnavailable: () => { unavailable++; expired(); } });
      let timer!: ReturnType<typeof setTimeout>;
      try { await Promise.race([expiration, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Viewer lifetime did not expire')), 1_000);
      })]); } finally { clearTimeout(timer); }
      expect(unavailable).toBe(1);
      expect(session.isClosed).toBe(false);
      expect(session.isViewerHeaded).toBe(true);
    } finally { gateway?.close(); await session.close(); }
  } finally { IsolatedBrowser.open = original; }
});

test('live view refuses a non-isolated profile before opening a browser', async () => {
  const local = { id: 'local-view-fixture', version: '1', browser: 'chromium' as const,
    viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 3_000, navigationMs: 5_000, waits: { default: 3_000 } } };
  const factory = new ProtectedContextFactory(new ProfileCatalog([local], []),
    undefined, undefined, { viewOnlyHeaded: true });
  await expect(factory.open({ id: local.id, version: local.version }))
    .rejects.toThrow('View-only headed presentation requires an isolated browser');
});
