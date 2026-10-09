import type { Page } from '@playwright/test';

export const LIVE_IMAGE_CAPTURE_TIMEOUT_MS = 1_000;
export const LIVE_IMAGE_MAX_WIDTH = 800;
export const LIVE_IMAGE_MAX_HEIGHT = 600;
export const LIVE_IMAGE_MAX_FRAME_BYTES = 128 * 1024;

class LiveImageCaptureTimeout extends Error {}

export type LiveImageCaptureLifecycleEvent = {
  kind: 'timeout_fired' | 'detach_requested' | 'detach_completed' | 'detach_failed' |
    'detach_wait_expired' | 'capture_late_settled' | 'late_result_discarded';
  outcome?: 'success' | 'failure';
  error?: unknown;
};
export type LiveImageCaptureLifecycleSink = (event: LiveImageCaptureLifecycleEvent) => void;

export function jpegDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 6 || bytes.readUInt16BE(0) !== 0xffd8 ||
      bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return undefined;
  let position = 2;
  while (position + 4 <= bytes.length) {
    if (bytes[position++] !== 0xff) return undefined;
    while (bytes[position] === 0xff) position++;
    const marker = bytes[position++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (position + 2 > bytes.length) return undefined;
    const length = bytes.readUInt16BE(position);
    if (length < 2 || position + length > bytes.length) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 7) return undefined;
      return { height: bytes.readUInt16BE(position + 3), width: bytes.readUInt16BE(position + 5) };
    }
    position += length;
  }
  return undefined;
}

/** Chrome's viewport capture uses CDP directly: no page script, scrolling, or runner step. */
export async function captureViewportJpeg(page: Page, onLifecycle?: LiveImageCaptureLifecycleSink): Promise<Buffer> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let session: Awaited<ReturnType<ReturnType<Page['context']>['newCDPSession']>> | undefined;
  let detach: Promise<boolean> | undefined;
  const report = (event: LiveImageCaptureLifecycleEvent): void => {
    try { onLifecycle?.(event); } catch { /* Observation cannot affect browser execution. */ }
  };
  const detachOwnedSession = (): Promise<boolean> | undefined => {
    if (!session) return undefined;
    if (!detach) {
      report({ kind: 'detach_requested' });
      const ownedSession = session;
      detach = Promise.resolve().then(() => ownedSession.detach()).then(() => {
        report({ kind: 'detach_completed' }); return true;
      }, error => {
        report({ kind: 'detach_failed', error }); return false;
      });
    }
    return detach;
  };
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      report({ kind: 'timeout_fired' });
      void detachOwnedSession();
      reject(new LiveImageCaptureTimeout('Live image capture timed out'));
    },
      LIVE_IMAGE_CAPTURE_TIMEOUT_MS);
    timer.unref?.();
  });
  const capture = (async (): Promise<Buffer> => {
    session = await page.context().newCDPSession(page);
    try {
      if (timedOut) throw new LiveImageCaptureTimeout('Live image capture timed out');
      const metrics = await session.send('Page.getLayoutMetrics');
      const viewport = metrics.cssVisualViewport;
      if (!viewport || !Number.isFinite(viewport.clientWidth) || !Number.isFinite(viewport.clientHeight) ||
          viewport.clientWidth < 1 || viewport.clientHeight < 1) throw new Error('Viewport unavailable');
      const scale = Math.min(1, LIVE_IMAGE_MAX_WIDTH / viewport.clientWidth,
        LIVE_IMAGE_MAX_HEIGHT / viewport.clientHeight);
      const screenshot = await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 45,
        fromSurface: true, captureBeyondViewport: false,
        clip: { x: viewport.pageX, y: viewport.pageY,
          width: viewport.clientWidth, height: viewport.clientHeight, scale } });
      if (screenshot.data.length > Math.ceil(LIVE_IMAGE_MAX_FRAME_BYTES / 3) * 4 + 4) {
        throw new Error('Live image exceeds frame budget');
      }
      return Buffer.from(screenshot.data, 'base64');
    } finally {
      // A session created after the deadline is detached as soon as it arrives.
      void detachOwnedSession();
    }
  })();
  // Consume a late CDP result; it must never reach a frame sender after timeout.
  void capture.then(() => {
    if (timedOut) {
      report({ kind: 'capture_late_settled', outcome: 'success' });
      report({ kind: 'late_result_discarded' });
    }
  }, error => {
    if (timedOut) {
      report({ kind: 'capture_late_settled', outcome: 'failure', error });
      report({ kind: 'late_result_discarded' });
    }
  });
  try { return await Promise.race([capture, deadline]); }
  catch (error) {
    if (error instanceof LiveImageCaptureTimeout && timedOut) {
      // Detach is Playwright's per-attempt CDP cancellation mechanism. Bound the
      // wait so browser/session cleanup never hangs behind an unresponsive CDP.
      const cleanup = detachOwnedSession();
      if (cleanup) {
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([cleanup, new Promise<void>(resolve => {
            cleanupTimer = setTimeout(() => {
              report({ kind: 'detach_wait_expired' }); resolve();
            }, LIVE_IMAGE_CAPTURE_TIMEOUT_MS);
            cleanupTimer.unref?.();
          })]);
        } finally { if (cleanupTimer) clearTimeout(cleanupTimer); }
      }
    }
    throw error;
  }
  finally { if (timer) clearTimeout(timer); }
}
