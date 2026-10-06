import { expect, test, type Page } from '@playwright/test';
import { captureViewportJpeg, jpegDimensions, type LiveImageCaptureLifecycleEvent } from
  '../app/observability/live-images.js';

const jpeg = Buffer.from('ffd8ffc0000b0800010001011100ffd9', 'hex');

function delayedCapture(detachImpl: () => Promise<void> = async () => undefined) {
  let resolve!: (value: { data: string }) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<{ data: string }>((yes, no) => { resolve = yes; reject = no; });
  const events: { event: LiveImageCaptureLifecycleEvent; at: number }[] = [];
  let detachCalls = 0, screenshotCalls = 0;
  const page = { context: () => ({ newCDPSession: async () => ({
    send: async (method: string) => {
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: {
        pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
      screenshotCalls++;
      return pending;
    },
    detach: async () => { detachCalls++; await detachImpl(); },
  }) }) } as unknown as Page;
  return { page, events, resolve, reject,
    get detachCalls() { return detachCalls; }, get screenshotCalls() { return screenshotCalls; } };
}

test('normal local CDP JPEG capture remains bounded and browser state is readable', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.setContent('<main><button>Ready</button></main>');
  const bytes = await captureViewportJpeg(page);
  expect(jpegDimensions(bytes)).toEqual({ width: 800, height: 600 });
  expect(bytes.length).toBeLessThanOrEqual(128 * 1024);
  expect(await page.locator('body').ariaSnapshot({ mode: 'ai', timeout: 3000 })).toContain('Ready');
});

test('timeout requests and completes owned CDP detach before returning; late JPEG is discarded', async () => {
  const fixture = delayedCapture();
  let published = 0;
  const begun = performance.now();
  await expect(captureViewportJpeg(fixture.page, event => {
    fixture.events.push({ event, at: performance.now() });
  }).then(() => { published++; })).rejects.toMatchObject({ name: 'Error', message: 'Live image capture timed out' });
  expect(fixture.screenshotCalls).toBe(1);
  expect(fixture.detachCalls).toBe(1);
  const names = fixture.events.map(entry => entry.event.kind);
  expect(names).toEqual(expect.arrayContaining(['timeout_fired', 'detach_requested', 'detach_completed']));
  const timeoutAt = fixture.events.find(entry => entry.event.kind === 'timeout_fired')!.at;
  const detachedAt = fixture.events.find(entry => entry.event.kind === 'detach_completed')!.at;
  expect(timeoutAt - begun).toBeGreaterThanOrEqual(900);
  expect(detachedAt - timeoutAt).toBeLessThan(500);
  fixture.resolve({ data: jpeg.toString('base64') });
  await expect.poll(() => fixture.events.some(entry => entry.event.kind === 'late_result_discarded')).toBe(true);
  expect(fixture.events.find(entry => entry.event.kind === 'capture_late_settled')?.event.outcome).toBe('success');
  expect(published).toBe(0);
  expect(fixture.detachCalls).toBe(1);
});

test('late CDP rejection is consumed after timeout and cannot publish a frame', async () => {
  const fixture = delayedCapture();
  const unhandled: unknown[] = [];
  const listener = (error: unknown): void => { unhandled.push(error); };
  process.on('unhandledRejection', listener);
  try {
    await expect(captureViewportJpeg(fixture.page, event => {
      fixture.events.push({ event, at: performance.now() });
    })).rejects.toMatchObject({ message: 'Live image capture timed out' });
    fixture.reject(new Error('private delayed CDP rejection'));
    await expect.poll(() => fixture.events.some(entry => entry.event.kind === 'late_result_discarded')).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
    expect(fixture.events.find(entry => entry.event.kind === 'capture_late_settled')?.event.outcome).toBe('failure');
    expect(fixture.detachCalls).toBe(1);
  } finally { process.off('unhandledRejection', listener); }
});

test('unresponsive CDP detach is accounted for without indefinitely holding viewer shutdown', async () => {
  const fixture = delayedCapture(() => new Promise<void>(() => undefined));
  const startedAt = performance.now();
  await expect(captureViewportJpeg(fixture.page, event => {
    fixture.events.push({ event, at: performance.now() });
  })).rejects.toMatchObject({ message: 'Live image capture timed out' });
  expect(performance.now() - startedAt).toBeLessThan(3_000);
  expect(fixture.detachCalls).toBe(1);
  expect(fixture.events.some(entry => entry.event.kind === 'detach_wait_expired')).toBe(true);
  fixture.reject(new Error('late rejected capture'));
  await expect.poll(() => fixture.events.some(entry => entry.event.kind === 'late_result_discarded')).toBe(true);
});
