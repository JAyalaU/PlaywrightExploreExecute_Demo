import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { LiveEventProducer } from '../app/observability/live-events.js';
import { LiveImagePolicySchema } from '../app/local/contracts.js';
import { LiveImageCaptureCoordinator, type LiveImageFrame } from '../app/observability/live-images.js';
import type { ProtectedBrowserSession } from '../app/profile/index.js';

const base = { testSpecId: 'local-test', executionProfileRef: { id: 'public-test', version: '1' },
  profileFingerprint: 'a'.repeat(64) };
const approved = LiveImagePolicySchema.parse({ liveImagePolicyVersion: '1', captureApproved: true, displayApproved: true });
// A minimal JPEG marker sequence suffices for the producer's format/dimension gate.
const jpeg = Buffer.from('ffd8ffc0000b0800010001011100ffd9', 'hex');

function setup(screenshot: () => Promise<Buffer> = async () => jpeg) {
  const events = new LiveEventProducer(randomUUID(), () => undefined);
  events.begin(base);
  events.emit('exploration_started', {}, { explorationAttemptId: 'explore-test' });
  let closed = false;
  const listeners = new Set<() => void>();
  const calls: unknown[] = [];
  const page = { isClosed: () => closed, url: () => 'http://fixture.test/', context: () => ({ newCDPSession: async () => ({
    send: async (method: string, params?: unknown) => {
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: {
        pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 } };
      calls.push(params);
      return { data: (await screenshot()).toString('base64') };
    }, detach: async () => undefined,
  }) }) };
  const pages = [page];
  const session = {
    isClosed: false,
    effectiveProfile: { fingerprint: base.profileFingerprint, profile: base.executionProfileRef },
    context: { pages: () => pages },
    onClosing: (observer: () => void) => { listeners.add(observer); return () => { listeners.delete(observer); }; },
  } as unknown as ProtectedBrowserSession;
  return { events, session, page, pages, calls, closePage: () => { closed = true; },
    closeSession: () => { for (const listener of [...listeners]) listener(); } };
}

test('P4-2A closed trusted policy denies unreviewed permissions and defaults to no capture', async () => {
  expect(() => LiveImagePolicySchema.parse({ liveImagePolicyVersion: '2', captureApproved: true, displayApproved: true })).toThrow();
  expect(() => LiveImagePolicySchema.parse({ liveImagePolicyVersion: '1', captureApproved: true,
    displayApproved: true, arbitraryPath: 'C:\\secret' })).toThrow();
  const { events, session } = setup();
  let delivered = 0;
  const coordinator = new LiveImageCaptureCoordinator(undefined, events, () => { delivered++; });
  coordinator.attach(session, { kind: 'attempt', id: 'explore-test' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(coordinator.enabled).toBe(false);
  expect(delivered).toBe(0);
  coordinator.close();
  const displayDenied = new LiveImageCaptureCoordinator(
    { liveImagePolicyVersion: '1', captureApproved: true, displayApproved: false },
    events, () => { delivered++; });
  displayDenied.attach(session, { kind: 'attempt', id: 'explore-test' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(delivered).toBe(0);
  displayDenied.close();
});

test('P4-2A captures one bounded correlated JPEG from the active protected page without persistence', async () => {
  const fixture = setup();
  const frames: LiveImageFrame[] = [];
  const coordinator = new LiveImageCaptureCoordinator(approved, fixture.events, (frame) => { frames.push(frame); });
  coordinator.attach(fixture.session, { kind: 'attempt', id: 'explore-test' });
  await expect.poll(() => frames.length).toBe(1);
  expect(frames[0]).toMatchObject({ liveImageVersion: '1', streamId: fixture.events.streamId,
    frameSequence: 1, sourceEventSequence: fixture.events.sequence,
    testSpecId: base.testSpecId, profileFingerprint: base.profileFingerprint,
    owner: { kind: 'attempt', id: 'explore-test' }, mimeType: 'image/jpeg',
    width: 1, height: 1, byteCount: jpeg.length });
  expect(fixture.calls[0]).toMatchObject({ format: 'jpeg', quality: 45,
    captureBeyondViewport: false, clip: { x: 0, y: 0, width: 1280, height: 720, scale: 0.625 } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(frames).toHaveLength(1); // No second attempt inside the three-second cadence.
  fixture.closeSession();
  coordinator.close();
});

test('P4-2A skips ambiguous pages and discards late frames on protected-session close', async () => {
  const fixture = setup();
  fixture.pages.push(fixture.page);
  const frames: LiveImageFrame[] = [];
  const coordinator = new LiveImageCaptureCoordinator(approved, fixture.events, (frame) => { frames.push(frame); });
  coordinator.attach(fixture.session, { kind: 'attempt', id: 'explore-test' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(frames).toHaveLength(0);
  expect(fixture.calls).toHaveLength(0);
  fixture.closeSession();
  coordinator.close();

  let release!: (bytes: Buffer) => void;
  const pending = new Promise<Buffer>((resolve) => { release = resolve; });
  const late = setup(() => pending);
  const lateFrames: LiveImageFrame[] = [];
  const lateCoordinator = new LiveImageCaptureCoordinator(approved, late.events,
    (frame) => { lateFrames.push(frame); });
  lateCoordinator.attach(late.session, { kind: 'run', id: 'run-test' });
  await expect.poll(() => late.calls.length).toBe(1);
  late.closeSession();
  release(jpeg);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(lateFrames).toHaveLength(0);
  lateCoordinator.close();
});

test('P4-2A rejects oversized/invalid JPEG and sender failure cannot alter execution', async () => {
  const fixture = setup(async () => Buffer.alloc(128 * 1024 + 1));
  const frames: LiveImageFrame[] = [];
  const coordinator = new LiveImageCaptureCoordinator(approved, fixture.events, (frame) => { frames.push(frame); });
  coordinator.attach(fixture.session, { kind: 'attempt', id: 'explore-test' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(frames).toHaveLength(0);
  expect(coordinator.acceptedFrames).toBe(0);
  fixture.closeSession();
  coordinator.close();

  const valid = setup();
  const failingSender = new LiveImageCaptureCoordinator(approved, valid.events, () => { throw new Error('receiver closed'); });
  failingSender.attach(valid.session, { kind: 'attempt', id: 'explore-test' });
  await expect.poll(() => failingSender.acceptedFrames).toBe(1);
  valid.closeSession();
  failingSender.close();
});

test('P4-2A bounds a stalled sender without waiting on runner work or retaining a capture timer', async () => {
  const fixture = setup();
  let sends = 0;
  const coordinator = new LiveImageCaptureCoordinator(approved, fixture.events, () => {
    sends++;
    return new Promise<void>(() => undefined);
  });
  coordinator.attach(fixture.session, { kind: 'run', id: 'run-test' });
  await expect.poll(() => sends).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  expect(coordinator.acceptedFrames).toBe(1);
  fixture.closeSession();
  coordinator.close();
});

test('P4-2A never overlaps a later capture with a timed-out, never-settling CDP request', async () => {
  let pendingCaptures = 0;
  let captureCalls = 0;
  const fixture = setup(() => {
    captureCalls++;
    pendingCaptures++;
    return new Promise<Buffer>(() => undefined);
  });
  const frames: LiveImageFrame[] = [];
  const coordinator = new LiveImageCaptureCoordinator(approved, fixture.events,
    (frame) => { frames.push(frame); });
  try {
    coordinator.attach(fixture.session, { kind: 'attempt', id: 'explore-test' });
    await expect.poll(() => captureCalls).toBe(1);
    // The one-second deadline wins, but the CDP request remains pending.
    await new Promise((resolve) => setTimeout(resolve, 1_150));
    coordinator.attach(fixture.session, { kind: 'run', id: 'run-test' });
    // Cross the normal three-second cadence; neither the original session nor
    // a newly attached owner may start another capture for this workflow.
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    expect(captureCalls).toBe(1);
    expect(pendingCaptures).toBe(1);
    expect(frames).toHaveLength(0);
    expect(coordinator.acceptedFrames).toBe(0);
  } finally {
    fixture.closeSession();
    coordinator.close();
  }
});

test('P4-2A CDP-only viewport capture does not change scroll state', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('data:text/html,<title>fixture</title>');
  await page.setContent('<div style="height:2000px">top</div><p>bottom</p>');
  await page.evaluate(() => window.scrollTo(0, 500));
  expect(await page.evaluate(() => window.scrollY)).toBe(500);
  const events = new LiveEventProducer(randomUUID(), () => undefined);
  events.begin(base);
  events.emit('exploration_started', {}, { explorationAttemptId: 'explore-test' });
  const session = {
    isClosed: false,
    effectiveProfile: { fingerprint: base.profileFingerprint, profile: base.executionProfileRef },
    context: { pages: () => [page] }, onClosing: () => () => undefined,
  } as unknown as ProtectedBrowserSession;
  const frames: LiveImageFrame[] = [];
  const coordinator = new LiveImageCaptureCoordinator(approved, events, (frame) => { frames.push(frame); });
  try {
    coordinator.attach(session, { kind: 'attempt', id: 'explore-test' });
    await expect.poll(() => frames.length).toBe(1);
    expect(frames[0]).toMatchObject({ width: 800, mimeType: 'image/jpeg' });
    expect(frames[0]!.height).toBeLessThanOrEqual(600);
    expect(frames[0]!.byteCount).toBeLessThanOrEqual(128 * 1024);
    expect(await page.evaluate(() => window.scrollY)).toBe(500);
  } finally { coordinator.close(); }
});
