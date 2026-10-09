import { randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import { expect, test } from '@playwright/test';
import { NativeProfileCatalog } from '../app/profile/native-profile.js';
import { ProtectedContextFactory } from '../app/profile/local-context.js';
import { LocalFrameNoticeSchema, LocalFrameViewerLifecycle, type LocalFrameNotice } from
  '../app/observability/local-frame-channel.js';
import { DeferredBrowserDiagnosticCollector } from '../app/domain/deferred-browser-diagnostics.js';

test.describe.configure({ mode: 'serial' });

const keys = ['PLAYWRIGHT_DEMO_DEFERRED_VIEWER_PORT',
  'PLAYWRIGHT_DEMO_DEFERRED_VIEWER_STREAM_ID', 'PLAYWRIGHT_DEMO_DEFERRED_VIEWER_CAPABILITY'] as const;
const profile = { id: 'local-frame-fixture', version: '1', profileSchemaVersion: '5' as const,
  browserIsolation: 'local-windows' as const, browserRuntime: 'playwright-chromium-windows' as const,
  browser: 'chromium' as const, presentationMode: 'headless' as const,
  viewport: { width: 900, height: 600 }, locale: 'en-US',
  timeoutPolicy: { actionMs: 3000, navigationMs: 5000, waits: { default: 3000 } } };
const ref = { id: profile.id, version: profile.version };

async function channelFixture() {
  const streamId = randomUUID(), capability = randomBytes(32).toString('hex');
  const notices: LocalFrameNotice[] = [];
  let error: unknown;
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let pending = '', greeted = false;
    socket.on('data', bytes => {
      pending += bytes.toString('utf8');
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const value: unknown = JSON.parse(line);
          if (!greeted) {
            expect(value).toEqual({ deferredViewerVersion: '1', kind: 'hello', streamId, capability });
            greeted = true;
            socket.write(JSON.stringify({ deferredViewerVersion: '1', kind: 'ready', streamId }) + '\n');
          } else notices.push(LocalFrameNoticeSchema.parse(value));
        } catch (caught) { error = caught; socket.destroy(); }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback address');
  process.env.PLAYWRIGHT_DEMO_DEFERRED_VIEWER_PORT = String(address.port);
  process.env.PLAYWRIGHT_DEMO_DEFERRED_VIEWER_STREAM_ID = streamId;
  process.env.PLAYWRIGHT_DEMO_DEFERRED_VIEWER_CAPABILITY = capability;
  return { notices, get error() { return error; }, close: async () => {
    sockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Deferred frame notice not observed');
}

test('local frame stream uses owned pages, clears phase ownership and never opens Docker or RFB', async () => {
  test.skip(process.platform !== 'win32', 'Windows process boundary');
  const old = keys.map(key => process.env[key]);
  const wire = await channelFixture();
  const diagnostics = new DeferredBrowserDiagnosticCollector();
  let lifecycle: LocalFrameViewerLifecycle | undefined;
  const sessions: Awaited<ReturnType<ProtectedContextFactory['open']>>[] = [];
  try {
    lifecycle = await LocalFrameViewerLifecycle.connect('local-test', diagnostics.record);
    const factory = new ProtectedContextFactory(new NativeProfileCatalog([profile]));
    const first = await factory.open(ref); sessions.push(first);
    await lifecycle.open(first, 'exploration', 'exploration-one');
    await until(() => diagnostics.snapshot().some(event => event.operation === 'capture' &&
      event.outcome === 'skipped' && event.internalReason === 'PAGE_COUNT'));
    const firstPage = await first.context.newPage();
    await until(() => diagnostics.snapshot().some(event => event.operation === 'capture' &&
      event.outcome === 'skipped' && event.internalReason === 'NOT_READY'));
    await firstPage.goto('data:text/html,<title>exploration</title><h1>exploration</h1>');
    await until(() => wire.notices.some(notice => notice.kind === 'frame'));
    const firstFrame = wire.notices.find(notice => notice.kind === 'frame');
    expect(firstFrame).toMatchObject({ ownerId: 'exploration-one', phase: 'exploration', mimeType: 'image/jpeg' });
    if (firstFrame?.kind !== 'frame') throw new Error('Missing frame');
    expect(Buffer.from(firstFrame.imageBase64, 'base64').length).toBe(firstFrame.byteCount);
    expect(firstFrame.byteCount).toBeLessThanOrEqual(128 * 1024);
    let releaseNavigation!: () => void;
    const navigationBlocked = new Promise<void>(resolve => { releaseNavigation = resolve; });
    await firstPage.route('https://fixture.invalid/next', async route => {
      await navigationBlocked;
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<main>Next document</main>' });
    });
    const navigation = firstPage.goto('https://fixture.invalid/next');
    await until(() => diagnostics.snapshot().some(event => event.operation === 'capture' &&
      event.outcome === 'skipped' && event.internalReason === 'NAVIGATION_IN_PROGRESS'));
    const priorFrames = wire.notices.filter(notice => notice.kind === 'frame').length;
    releaseNavigation(); await navigation;
    await until(() => wire.notices.filter(notice => notice.kind === 'frame').length > priorFrames);
    expect(wire.notices.some(notice => notice.kind === 'unavailable')).toBe(false);
    await first.close();
    const second = await factory.open(ref); sessions.push(second);
    await lifecycle.open(second, 'compilation', 'compiler-one');
    const secondPage = await second.context.newPage();
    await secondPage.goto('data:text/html,<title>compilation</title><h1>compilation</h1>');
    await until(() => wire.notices.some(notice => notice.kind === 'frame' && notice.phase === 'compilation'));
    expect(second.context.browser()).not.toBe(first.context.browser());
    await second.close();
    lifecycle.close();
    await until(() => wire.notices.some(notice => notice.kind === 'closed' && notice.phase === 'compilation'));
    expect(wire.error).toBeUndefined();
    expect(wire.notices.filter(notice => notice.kind !== 'frame').map(notice =>
      [notice.kind, notice.phase, notice.ownerId])).toEqual([
      ['ready', 'exploration', 'exploration-one'], ['closed', 'exploration', 'exploration-one'],
      ['transition', 'exploration', 'exploration-one'], ['ready', 'compilation', 'compiler-one'],
      ['closed', 'compilation', 'compiler-one'],
    ]);
    expect(wire.notices.every(notice => !('path' in notice) && !('port' in notice))).toBe(true);
    expect(sessions.every(session => session.context.browser()?.isConnected() === false)).toBe(true);
    const events = diagnostics.snapshot();
    expect(events.some(event => event.operation === 'ready' && event.phase === 'exploration')).toBe(true);
    expect(events.some(event => event.operation === 'first_frame' && event.phase === 'exploration')).toBe(true);
    expect(events.some(event => event.operation === 'capture' && event.outcome === 'success' &&
      event.successfulFrameCount === 1 && event.lastSuccessfulFrameAt)).toBe(true);
    expect(events.some(event => event.operation === 'transition' && event.phase === 'exploration')).toBe(true);
    expect(events.every(event => event.startedAtMs <= event.endedAtMs && event.elapsedMs >= 0)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('imageBase64');
    expect(JSON.stringify(events)).not.toContain('exploration</h1>');
  } finally {
    lifecycle?.close();
    await Promise.allSettled(sessions.map(session => session.close()));
    await wire.close();
    keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; });
  }
});

test('capture failure marks only the local viewer unavailable while its browser stays usable', async () => {
  test.skip(process.platform !== 'win32', 'Windows process boundary');
  const old = keys.map(key => process.env[key]);
  const wire = await channelFixture();
  const diagnostics = new DeferredBrowserDiagnosticCollector();
  let lifecycle: LocalFrameViewerLifecycle | undefined;
  let session: Awaited<ReturnType<ProtectedContextFactory['open']>> | undefined;
  try {
    lifecycle = await LocalFrameViewerLifecycle.connect('local-test', diagnostics.record);
    session = await new ProtectedContextFactory(new NativeProfileCatalog([profile])).open(ref);
    await lifecycle.open(session, 'exploration', 'exploration-one');
    const page = await session.context.newPage();
    await page.goto('data:text/html,<title>capture-fails</title>');
    session.context.newCDPSession = async () => { throw new Error('Capture unavailable'); };
    await until(() => wire.notices.some(notice => notice.kind === 'unavailable'));
    expect(wire.notices.some(notice => notice.kind === 'frame')).toBe(false);
    expect(session.context.browser()?.isConnected()).toBe(true);
    expect(await page.title()).toBe('capture-fails');
    expect(diagnostics.snapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'capture', outcome: 'failure', internalReason: 'CAPTURE_FAILED',
        page: 'open', context: 'open', browser: 'connected' }),
      expect.objectContaining({ operation: 'unavailable', outcome: 'success' }),
    ]));
    expect(diagnostics.snapshot().some(event => event.operation === 'channel_loss')).toBe(false);
  } finally {
    lifecycle?.close(); await session?.close(); await wire.close();
    keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; });
  }
});

test('timed-out local frame detaches, discards late pixels, and recovers on the next cadence', async () => {
  test.skip(process.platform !== 'win32', 'Windows process boundary');
  const old = keys.map(key => process.env[key]);
  const wire = await channelFixture();
  const diagnostics = new DeferredBrowserDiagnosticCollector();
  let lifecycle: LocalFrameViewerLifecycle | undefined;
  let session: Awaited<ReturnType<ProtectedContextFactory['open']>> | undefined;
  let resolveScreenshot!: (value: { data: string }) => void;
  const screenshot = new Promise<{ data: string }>(resolve => { resolveScreenshot = resolve; });
  let sessionsCreated = 0, detachCalls = 0;
  try {
    lifecycle = await LocalFrameViewerLifecycle.connect('local-test', diagnostics.record);
    session = await new ProtectedContextFactory(new NativeProfileCatalog([profile])).open(ref);
    await lifecycle.open(session, 'exploration', 'exploration-one');
    const page = await session.context.newPage();
    await page.goto('data:text/html,<main><button>Ready</button></main>');
    const activeSession = session;
    const originalNewCDPSession = activeSession.context.newCDPSession.bind(activeSession.context);
    activeSession.context.newCDPSession = async () => {
      sessionsCreated++;
      if (sessionsCreated > 1) return originalNewCDPSession(page);
      return { send: async (method: string) => method === 'Page.getLayoutMetrics' ? {
        cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
      } : screenshot, detach: async () => { detachCalls++; } } as
        Awaited<ReturnType<typeof activeSession.context.newCDPSession>>;
    };
    await until(() => sessionsCreated === 1);
    let releaseNavigation!: () => void;
    const navigationBlocked = new Promise<void>(resolve => { releaseNavigation = resolve; });
    await page.route('https://fixture.invalid/destination', async route => {
      await navigationBlocked;
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<main>Destination</main>' });
    });
    const navigation = page.goto('https://fixture.invalid/destination');
    await until(() => diagnostics.snapshot().some(event => event.operation === 'capture_timeout'));
    await until(() => diagnostics.snapshot().some(event => event.operation === 'capture' &&
      event.internalReason === 'CAPTURE_TIMEOUT'));
    expect(sessionsCreated).toBe(1);
    expect(detachCalls).toBe(1);
    expect(wire.notices.some(notice => notice.kind === 'frame')).toBe(false);
    const events = diagnostics.snapshot();
    const timeout = events.find(event => event.operation === 'capture_timeout');
    const request = events.find(event => event.operation === 'capture_detach' && event.outcome === 'started');
    const complete = events.find(event => event.operation === 'capture_detach' && event.outcome === 'success');
    expect(timeout).toMatchObject({ internalReason: 'CAPTURE_TIMEOUT', ownerId: 'exploration-one' });
    expect(request?.startedAtMs).toBeGreaterThanOrEqual(timeout!.startedAtMs);
    expect(complete?.startedAtMs).toBeGreaterThanOrEqual(request!.startedAtMs);
    expect(events.some(event => event.operation === 'unavailable')).toBe(false);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'capture',
      outcome: 'failure', internalReason: 'CAPTURE_TIMEOUT', page: 'open', browser: 'connected' })]));
    resolveScreenshot({ data: Buffer.from('ffd8ffd9', 'hex').toString('base64') });
    await until(() => diagnostics.snapshot().some(event => event.operation === 'capture_late_discard'));
    expect(wire.notices.some(notice => notice.kind === 'frame')).toBe(false);
    releaseNavigation();
    await navigation;
    await until(() => wire.notices.some(notice => notice.kind === 'frame'));
    expect(await page.locator('body').ariaSnapshot({ mode: 'ai', timeout: 3000 })).toContain('Destination');
    const late = diagnostics.snapshot();
    expect(late).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'capture_late_settle', outcome: 'success', ownerId: 'exploration-one' }),
      expect.objectContaining({ operation: 'capture_late_discard', internalReason: 'LATE_CAPTURE_DISCARDED' }),
    ]));
    expect(wire.notices.some(notice => notice.kind === 'unavailable')).toBe(false);
    lifecycle.close();
    await new Promise(resolve => setTimeout(resolve, 850));
    expect(sessionsCreated).toBeGreaterThan(1);
    expect(JSON.stringify(late)).not.toContain('imageBase64');
    expect(JSON.stringify(late)).not.toContain('<button>');
  } finally {
    lifecycle?.close(); await session?.close(); await wire.close();
    keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; });
  }
});

test('private diagnostics distinguish channel loss from screenshot failure', async () => {
  test.skip(process.platform !== 'win32', 'Windows process boundary');
  const old = keys.map(key => process.env[key]);
  const wire = await channelFixture();
  const diagnostics = new DeferredBrowserDiagnosticCollector();
  let lifecycle: LocalFrameViewerLifecycle | undefined;
  let session: Awaited<ReturnType<ProtectedContextFactory['open']>> | undefined;
  try {
    lifecycle = await LocalFrameViewerLifecycle.connect('local-test', diagnostics.record);
    session = await new ProtectedContextFactory(new NativeProfileCatalog([profile])).open(ref);
    await lifecycle.open(session, 'exploration', 'exploration-one');
    await session.context.newPage();
    await wire.close();
    await until(() => diagnostics.snapshot().some(event => event.operation === 'channel_loss'));
    expect(diagnostics.snapshot().find(event => event.operation === 'channel_loss'))
      .toMatchObject({ internalReason: 'CHANNEL_LOST' });
    expect(diagnostics.snapshot().some(event => event.operation === 'capture' && event.outcome === 'failure')).toBe(false);
    expect(session.context.browser()?.isConnected()).toBe(true);
  } finally {
    lifecycle?.close(); await session?.close();
    keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; });
  }
});

test('document replacement during capture skips stale pixels and later captures the new page', async () => {
  test.skip(process.platform !== 'win32', 'Windows process boundary');
  const old = keys.map(key => process.env[key]);
  const wire = await channelFixture(), diagnostics = new DeferredBrowserDiagnosticCollector();
  let lifecycle: LocalFrameViewerLifecycle | undefined;
  let session: Awaited<ReturnType<ProtectedContextFactory['open']>> | undefined;
  try {
    lifecycle = await LocalFrameViewerLifecycle.connect('local-test', diagnostics.record);
    session = await new ProtectedContextFactory(new NativeProfileCatalog([profile])).open(ref);
    await lifecycle.open(session, 'exploration', 'exploration-one');
    const page = await session.context.newPage();
    await page.goto('data:text/html,<main>First document</main>');
    const activeSession = session;
    const original = activeSession.context.newCDPSession.bind(activeSession.context);
    let first = true, rejectCapture!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => { rejectCapture = reject; });
    activeSession.context.newCDPSession = async () => {
      if (!first) return original(page);
      first = false;
      return { send: async (method: string) => method === 'Page.getLayoutMetrics' ? {
        cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
      } : pending, detach: async () => undefined } as
        Awaited<ReturnType<typeof activeSession.context.newCDPSession>>;
    };
    await until(() => !first);
    await page.goto('data:text/html,<main>Replacement document</main>');
    rejectCapture(new Error('Execution context was destroyed during navigation'));
    await until(() => diagnostics.snapshot().some(event => event.operation === 'capture' &&
      event.outcome === 'failure'));
    expect(wire.notices.some(notice => notice.kind === 'unavailable')).toBe(false);
    await until(() => wire.notices.some(notice => notice.kind === 'frame'));
    expect(await page.locator('body').ariaSnapshot({ mode: 'ai' })).toContain('Replacement document');
    expect(wire.notices.filter(notice => notice.kind === 'frame')).toHaveLength(1);
  } finally {
    lifecycle?.close(); await session?.close(); await wire.close();
    keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; });
  }
});

for (const ending of ['browser', 'context'] as const) {
  test(`${ending} closure remains a terminal local viewer failure`, async () => {
    test.skip(process.platform !== 'win32', 'Windows process boundary');
    const old = keys.map(key => process.env[key]);
    const wire = await channelFixture(), diagnostics = new DeferredBrowserDiagnosticCollector();
    let lifecycle: LocalFrameViewerLifecycle | undefined;
    let session: Awaited<ReturnType<ProtectedContextFactory['open']>> | undefined;
    try {
      lifecycle = await LocalFrameViewerLifecycle.connect('local-test', diagnostics.record);
      session = await new ProtectedContextFactory(new NativeProfileCatalog([profile])).open(ref);
      await lifecycle.open(session, 'exploration', 'exploration-one');
      await session.context.newPage();
      if (ending === 'browser') await session.context.browser()!.close();
      else await session.context.close();
      await until(() => wire.notices.some(notice => notice.kind === 'unavailable'));
      expect(diagnostics.snapshot().some(event => event.operation === 'capture' &&
        event.internalReason === (ending === 'browser' ? 'BROWSER_DISCONNECTED' : 'CONTEXT_CLOSED'))).toBe(true);
    } finally {
      lifecycle?.close(); await session?.close(); await wire.close();
      keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; });
    }
  });
}

test('owner transition discards a late prior-owner frame', async () => {
  test.skip(process.platform !== 'win32', 'Windows process boundary');
  const old = keys.map(key => process.env[key]);
  const wire = await channelFixture(), diagnostics = new DeferredBrowserDiagnosticCollector();
  let lifecycle: LocalFrameViewerLifecycle | undefined;
  const sessions: Awaited<ReturnType<ProtectedContextFactory['open']>>[] = [];
  try {
    lifecycle = await LocalFrameViewerLifecycle.connect('local-test', diagnostics.record);
    const factory = new ProtectedContextFactory(new NativeProfileCatalog([profile]));
    const first = await factory.open(ref); sessions.push(first);
    await lifecycle.open(first, 'exploration', 'exploration-one');
    const page = await first.context.newPage();
    await page.goto('data:text/html,<main>First</main>');
    let resolveOld!: (value: { data: string }) => void, entered = false;
    const oldCapture = new Promise<{ data: string }>(resolve => { resolveOld = resolve; });
    first.context.newCDPSession = async () => ({ send: async (method: string) => {
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: {
        pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
      entered = true; return oldCapture;
    }, detach: async () => undefined }) as Awaited<ReturnType<typeof first.context.newCDPSession>>;
    await until(() => entered);
    await first.close();
    const second = await factory.open(ref); sessions.push(second);
    await lifecycle.open(second, 'compilation', 'compiler-one');
    const secondPage = await second.context.newPage();
    await secondPage.goto('data:text/html,<main>Second</main>');
    resolveOld({ data: Buffer.from('ffd8ffc0000b0800010001011100ffd9', 'hex').toString('base64') });
    await until(() => wire.notices.some(notice => notice.kind === 'frame' && notice.phase === 'compilation'));
    expect(wire.notices.some(notice => notice.kind === 'frame' && notice.phase === 'exploration')).toBe(false);
    expect(wire.notices.some(notice => notice.kind === 'unavailable')).toBe(false);
  } finally {
    lifecycle?.close(); await Promise.allSettled(sessions.map(session => session.close())); await wire.close();
    keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; });
  }
});
