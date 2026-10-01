import type { Page } from '@playwright/test';
import type { LiveImagePolicy } from '../local/contracts.js';
import type { ProtectedBrowserSession } from '../profile/index.js';
import type { LiveEventProducer } from './live-events.js';

export const LIVE_IMAGE_VERSION = '1' as const;
export const LIVE_IMAGE_MIN_INTERVAL_MS = 3_000;
export const LIVE_IMAGE_LIFETIME_MS = 120_000;
export const LIVE_IMAGE_CAPTURE_TIMEOUT_MS = 1_000;
export const LIVE_IMAGE_MAX_FRAMES = 32;
export const LIVE_IMAGE_MAX_WIDTH = 800;
export const LIVE_IMAGE_MAX_HEIGHT = 600;
export const LIVE_IMAGE_MAX_FRAME_BYTES = 128 * 1024;
export const LIVE_IMAGE_MAX_TOTAL_BYTES = 4 * 1024 * 1024;

export interface LiveImageFrame {
  liveImageVersion: typeof LIVE_IMAGE_VERSION;
  streamId: string;
  frameSequence: number;
  sourceEventSequence: number;
  testSpecId: string;
  executionProfileRef: { id: string; version: string };
  profileFingerprint: string;
  owner: { kind: 'attempt' | 'run'; id: string };
  capturedAt: string;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  byteCount: number;
  /** Restricted bytes; never serialize into events, results, reports, or artifacts. */
  bytes: Buffer;
}

/** A trusted, bounded sender seam. P4-2B owns the authenticated private transport. */
export type LiveImageSink = (frame: LiveImageFrame) => void | Promise<void>;

class LiveImageCaptureTimeout extends Error {}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | undefined {
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
async function captureViewportJpeg(page: Page): Promise<Buffer> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { timedOut = true; reject(new LiveImageCaptureTimeout('Live image capture timed out')); },
      LIVE_IMAGE_CAPTURE_TIMEOUT_MS);
    timer.unref?.();
  });
  const capture = (async (): Promise<Buffer> => {
    const session = await page.context().newCDPSession(page);
    try {
      if (timedOut) throw new Error('Live image capture timed out');
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
      // Detach even if the one-second deadline wins while CDP is still pending.
      void session.detach().catch(() => undefined);
    }
  })();
  try { return await Promise.race([capture, deadline]); }
  finally { if (timer) clearTimeout(timer); }
}

/** Workflow-wide, best-effort capture from only the current protected session. */
export class LiveImageCaptureCoordinator {
  readonly #events: LiveEventProducer;
  readonly #sink: LiveImageSink;
  readonly #enabled: boolean;
  #current: { session: ProtectedBrowserSession; owner: LiveImageFrame['owner']; detach: () => void } | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;
  #startedAt?: number;
  #lastAttemptAt = -Infinity;
  #accepted = 0;
  #totalBytes = 0;
  #failures = 0;
  #sending = false;
  #closed = false;

  constructor(policy: LiveImagePolicy | undefined, events: LiveEventProducer, sink: LiveImageSink) {
    this.#enabled = policy?.liveImagePolicyVersion === LIVE_IMAGE_VERSION &&
      policy.captureApproved && policy.displayApproved;
    this.#events = events;
    this.#sink = sink;
  }

  get enabled(): boolean { return this.#enabled; }
  get acceptedFrames(): number { return this.#accepted; }

  attach(session: ProtectedBrowserSession, owner: LiveImageFrame['owner']): void {
    if (!this.#enabled || this.#closed || session.isClosed || this.#failures >= 3 ||
        this.#accepted >= LIVE_IMAGE_MAX_FRAMES) return;
    if (!this.#events.context || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(owner.id)) return;
    const context = this.#events.context;
    if (session.effectiveProfile.fingerprint !== context.profileFingerprint ||
        session.effectiveProfile.profile.id !== context.executionProfileRef.id ||
        session.effectiveProfile.profile.version !== context.executionProfileRef.version) return;
    this.#detach();
    this.#startedAt ??= Date.now();
    if (Date.now() - this.#startedAt >= LIVE_IMAGE_LIFETIME_MS) return;
    const detach = session.onClosing(() => this.#detach(session));
    this.#current = { session, owner: { ...owner }, detach };
    this.#schedule();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
  }

  #detach(session?: ProtectedBrowserSession): void {
    if (session && this.#current?.session !== session) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#generation++;
    this.#current?.detach();
    this.#current = undefined;
  }

  #schedule(): void {
    if (!this.#current || this.#closed || this.#failures >= 3 ||
        this.#accepted >= LIVE_IMAGE_MAX_FRAMES ||
        Date.now() - this.#startedAt! >= LIVE_IMAGE_LIFETIME_MS) return;
    const delay = this.#sending ? LIVE_IMAGE_MIN_INTERVAL_MS
      : Math.max(100, this.#lastAttemptAt + LIVE_IMAGE_MIN_INTERVAL_MS - Date.now());
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#capture().catch(() => { this.#failures++; }).finally(() => this.#schedule());
    }, delay);
    this.#timer.unref?.();
  }

  async #capture(): Promise<void> {
    const current = this.#current;
    if (!current || this.#closed || this.#sending) return;
    const pages = current.session.context.pages().filter((page) => !page.isClosed());
    if (pages.length !== 1) return;
    const page: Page = pages[0]!;
    if (page.url() === 'about:blank') return;
    const sourceEventSequence = this.#events.sequence;
    const context = this.#events.context;
    if (!context || sourceEventSequence < 1) return;
    const generation = this.#generation;
    this.#lastAttemptAt = Date.now();
    try {
      const bytes = await captureViewportJpeg(page);
      if (generation !== this.#generation || this.#closed || page.isClosed()) return;
      const dimensions = jpegDimensions(bytes);
      if (!dimensions || dimensions.width < 1 || dimensions.height < 1 ||
          dimensions.width > LIVE_IMAGE_MAX_WIDTH || dimensions.height > LIVE_IMAGE_MAX_HEIGHT ||
          bytes.length > LIVE_IMAGE_MAX_FRAME_BYTES ||
          this.#totalBytes + bytes.length > LIVE_IMAGE_MAX_TOTAL_BYTES) {
        this.#failures++;
        return;
      }
      this.#failures = 0;
      this.#accepted++;
      this.#totalBytes += bytes.length;
      const frame: LiveImageFrame = {
        liveImageVersion: LIVE_IMAGE_VERSION, streamId: this.#events.streamId,
        frameSequence: this.#accepted, sourceEventSequence,
        testSpecId: context.testSpecId,
        executionProfileRef: { ...context.executionProfileRef },
        profileFingerprint: context.profileFingerprint,
        owner: { ...current.owner }, capturedAt: new Date().toISOString(),
        mimeType: 'image/jpeg', width: dimensions.width, height: dimensions.height,
        byteCount: bytes.length, bytes,
      };
      this.#sending = true;
      try {
        let senderTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve(this.#sink(frame)),
            new Promise<never>((_resolve, reject) => {
              senderTimer = setTimeout(() => reject(new Error('Live image sender stalled')), 1_000);
              senderTimer.unref?.();
            }),
          ]);
        } finally { if (senderTimer) clearTimeout(senderTimer); }
      } catch {
        // The sender/receiver is non-authoritative. Disable images after loss.
        this.#failures = 3;
      } finally {
        this.#sending = false;
      }
    } catch (error) {
      if (error instanceof LiveImageCaptureTimeout) {
        // Promise.race does not cancel CDP. Disable every later capture while the
        // underlying request may still be pending, including after session changes.
        this.#failures = 3;
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = undefined;
      } else if (generation === this.#generation && !this.#closed) this.#failures++;
    }
  }
}
