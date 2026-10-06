/** Authenticated, view-only lifecycle for the active deferred workflow. No page or QA data crosses this channel. */
import net from 'node:net';
import { z } from 'zod';
import type { ProtectedBrowserSession } from '../profile/context.js';
import { ViewerGateway } from './viewer-gateway.js';
import { captureViewportJpeg, jpegDimensions, LIVE_IMAGE_MAX_FRAME_BYTES,
  type LiveImageCaptureLifecycleEvent,
  LIVE_IMAGE_MAX_HEIGHT, LIVE_IMAGE_MAX_WIDTH } from './live-images.js';
import { diagnosticBrowserState, diagnosticElapsed, diagnosticExceptionName,
  type DeferredBrowserDiagnosticSink, type DeferredBrowserDiagnosticV1 } from '../domain/deferred-browser-diagnostics.js';

const PORT = 'PLAYWRIGHT_DEMO_DEFERRED_VIEWER_PORT';
const STREAM = 'PLAYWRIGHT_DEMO_DEFERRED_VIEWER_STREAM_ID';
const CAPABILITY = 'PLAYWRIGHT_DEMO_DEFERRED_VIEWER_CAPABILITY';
const MAX_BYTES = 2048;
const MAX_NOTICES = 64;
const MAX_FRAME_NOTICES = 4096;
const FRAME_INTERVAL_MS = 750;
const MAX_FRAME_LINE_BYTES = 180_000;
const id = z.string().max(128).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const phases = ['exploration', 'compilation', 'replay_1', 'replay_2'] as const;
export type DeferredViewerPhase = typeof phases[number];
const base = { deferredViewerVersion: z.literal('1'), streamId: z.string().uuid(),
  sequence: z.number().int().min(1).max(MAX_NOTICES), phase: z.enum(phases), ownerId: id, testSpecId: id };
export const DeferredViewerNoticeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, kind: z.literal('ready'), port: z.number().int().min(1).max(65535),
    path: z.literal('/rfb'), connectionCapability: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.iso.datetime({ offset: true }) }),
  z.strictObject({ ...base, kind: z.literal('transition') }),
  z.strictObject({ ...base, kind: z.literal('closed') }),
  z.strictObject({ ...base, kind: z.literal('unavailable') }),
]);
export type DeferredViewerNotice = z.infer<typeof DeferredViewerNoticeSchema>;
const frameBase = { deferredViewerVersion: z.literal('2'), viewerMode: z.literal('frame_stream'),
  streamId: z.string().uuid(), sequence: z.number().int().min(1).max(MAX_FRAME_NOTICES),
  phase: z.enum(phases), ownerId: id, testSpecId: id };
/** Version 2 carries only bounded display pixels, never DOM or execution evidence. */
export const DeferredFrameNoticeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...frameBase, kind: z.literal('ready') }),
  z.strictObject({ ...frameBase, kind: z.literal('transition') }),
  z.strictObject({ ...frameBase, kind: z.literal('closed') }),
  z.strictObject({ ...frameBase, kind: z.literal('unavailable') }),
  z.strictObject({ ...frameBase, kind: z.literal('frame'), mimeType: z.literal('image/jpeg'),
    width: z.number().int().min(1).max(LIVE_IMAGE_MAX_WIDTH),
    height: z.number().int().min(1).max(LIVE_IMAGE_MAX_HEIGHT),
    byteCount: z.number().int().min(1).max(LIVE_IMAGE_MAX_FRAME_BYTES),
    imageBase64: z.string().max(Math.ceil(LIVE_IMAGE_MAX_FRAME_BYTES / 3) * 4) }),
]);
export type DeferredFrameNotice = z.infer<typeof DeferredFrameNoticeSchema>;

/** Session launch reached a browser, but viewer preflight stopped it before any task action. */
export class DeferredViewerPreflightError extends Error {
  constructor(readonly cleanup: 'verified' | 'unverified') { super('Deferred viewer preflight unavailable'); }
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export class DeferredViewerLifecycle {
  readonly #socket: net.Socket;
  readonly #streamId: string;
  readonly #testSpecId: string;
  #sequence = 0;
  #gateway: ViewerGateway | undefined;
  #owner: { phase: DeferredViewerPhase; ownerId: string } | undefined;
  #failed = false;
  #closed = false;
  #everReady = false;
  readonly #mode: 'rfb' | 'frame_stream';
  #frameTimer: ReturnType<typeof setTimeout> | undefined;
  #frameGeneration = 0;
  readonly #diagnostic: DeferredBrowserDiagnosticSink | undefined;
  #captureOrdinal = 0;
  #successfulFrames = 0;
  #lastSuccessfulFrameAt: string | undefined;
  #activeSession: ProtectedBrowserSession | undefined;

  private constructor(socket: net.Socket, streamId: string, testSpecId: string, mode: 'rfb' | 'frame_stream',
    diagnostic?: DeferredBrowserDiagnosticSink) {
    this.#socket = socket; this.#streamId = streamId; this.#testSpecId = testSpecId; this.#mode = mode;
    this.#diagnostic = diagnostic;
    socket.on('error', () => this.#fail('CHANNEL_LOST'));
    socket.on('close', () => this.#fail('CHANNEL_LOST'));
    socket.on('data', () => this.#fail('DISPLAY_LOST'));
  }

  /** The three launch capabilities are consumed even on a rejected handshake. */
  static async connect(testSpecId: string, mode: 'rfb' | 'frame_stream' = 'rfb',
    diagnostic?: DeferredBrowserDiagnosticSink): Promise<DeferredViewerLifecycle> {
    id.parse(testSpecId);
    const portText = process.env[PORT], streamId = process.env[STREAM], capability = process.env[CAPABILITY];
    delete process.env[PORT]; delete process.env[STREAM]; delete process.env[CAPABILITY];
    const port = Number(portText);
    if (!streamId || !z.string().uuid().safeParse(streamId).success ||
        !Number.isSafeInteger(port) || port < 1 || port > 65535 ||
        !capability || !/^[a-f0-9]{64}$/.test(capability)) throw new Error('Deferred viewer launch invalid');
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setNoDelay(true);
    try {
      await new Promise<void>((resolve, reject) => {
        let done = false, pending = Buffer.alloc(0);
        const finish = (error?: Error): void => {
          if (done) return;
          done = true; clearTimeout(timer);
          socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose);
          if (error) reject(error); else resolve();
        };
        const onError = (): void => finish(new Error('Deferred viewer unavailable'));
        const onClose = (): void => finish(new Error('Deferred viewer closed'));
        const onData = (bytes: Buffer): void => {
          pending = Buffer.concat([pending, bytes]);
          if (pending.length > MAX_BYTES) { finish(new Error('Deferred viewer acknowledgement too large')); return; }
          const end = pending.indexOf(10);
          if (end < 0) return;
          try {
            if (end !== pending.length - 1) throw new Error('Extra acknowledgement data');
            const answer: unknown = JSON.parse(pending.subarray(0, end).toString('utf8'));
            if (!exact(answer, ['deferredViewerVersion', 'kind', 'streamId']) ||
                answer.deferredViewerVersion !== '1' || answer.kind !== 'ready' || answer.streamId !== streamId)
              throw new Error('Invalid acknowledgement');
            finish();
          } catch { finish(new Error('Deferred viewer acknowledgement invalid')); }
        };
        const timer = setTimeout(() => finish(new Error('Deferred viewer handshake timed out')), 5000);
        socket.on('data', onData); socket.on('error', onError); socket.on('close', onClose);
        socket.once('connect', () => socket.write(JSON.stringify({
          deferredViewerVersion: '1', kind: 'hello', streamId, capability,
        }) + '\n'));
      });
    } catch (error) { socket.destroy(); throw error; }
    return new DeferredViewerLifecycle(socket, streamId, testSpecId, mode, diagnostic);
  }

  #record(session: ProtectedBrowserSession | undefined, operation: DeferredBrowserDiagnosticV1['operation'],
    outcome: DeferredBrowserDiagnosticV1['outcome'], startedAtMs = performance.now(),
    extra: Partial<DeferredBrowserDiagnosticV1> = {},
    owner = this.#owner): void {
    if (this.#mode !== 'frame_stream' || !owner || !this.#diagnostic) return;
    const endedAtMs = performance.now();
    try { this.#diagnostic({ diagnosticVersion: '1', source: 'viewer', operation,
      phase: owner.phase, ownerId: owner.ownerId, startedAtMs, endedAtMs,
      elapsedMs: diagnosticElapsed(startedAtMs, endedAtMs), outcome,
      page: 'unknown', context: 'unknown', browser: 'unknown',
      ...((session ?? this.#activeSession) ? diagnosticBrowserState((session ?? this.#activeSession)!) : {}), ...extra }); }
    catch { /* Private diagnostics cannot affect viewing or QA. */ }
  }

  #fail(reason: 'CHANNEL_LOST' | 'DISPLAY_LOST' = 'DISPLAY_LOST'): void {
    if (!this.#failed && !this.#closed) this.#record(undefined, 'channel_loss', 'failure', performance.now(), { internalReason: reason });
    this.#failed = true; this.#gateway?.close(); this.#gateway = undefined; this.#stopFrames();
  }

  #stopFrames(): void {
    this.#frameGeneration++;
    if (this.#frameTimer) clearTimeout(this.#frameTimer);
    this.#frameTimer = undefined;
  }

  #sendFrameNotice(kind: DeferredFrameNotice['kind'], owner: { phase: DeferredViewerPhase; ownerId: string },
    image?: { bytes: Buffer; width: number; height: number }): boolean {
    if (this.#failed || this.#closed || this.#sequence >= MAX_FRAME_NOTICES) { this.#fail(); return false; }
    const parsed = DeferredFrameNoticeSchema.safeParse({ deferredViewerVersion: '2', viewerMode: 'frame_stream',
      streamId: this.#streamId, sequence: ++this.#sequence, kind, phase: owner.phase,
      ownerId: owner.ownerId, testSpecId: this.#testSpecId,
      ...(kind === 'frame' && image ? { mimeType: 'image/jpeg', width: image.width, height: image.height,
        byteCount: image.bytes.length, imageBase64: image.bytes.toString('base64') } : {}) });
    if (!parsed.success) { this.#fail(); return false; }
    const line = JSON.stringify(parsed.data) + '\n';
    if (Buffer.byteLength(line) > MAX_FRAME_LINE_BYTES || this.#socket.writableLength > MAX_FRAME_LINE_BYTES) {
      this.#fail('DISPLAY_LOST'); return false;
    }
    this.#socket.write(line);
    return true;
  }

  #scheduleFrame(session: ProtectedBrowserSession, owner: { phase: DeferredViewerPhase; ownerId: string },
    generation: number, delay = FRAME_INTERVAL_MS): void {
    if (this.#failed || this.#closed || session.isClosed || generation !== this.#frameGeneration) return;
    this.#frameTimer = setTimeout(() => {
      this.#frameTimer = undefined;
      void this.#captureFrame(session, owner, generation);
    }, delay);
    this.#frameTimer.unref?.();
  }

  async #captureFrame(session: ProtectedBrowserSession, owner: { phase: DeferredViewerPhase; ownerId: string },
    generation: number): Promise<void> {
    if (generation !== this.#frameGeneration || session.isClosed || this.#failed || this.#closed) return;
    const startedAtMs = performance.now(), attemptOrdinal = ++this.#captureOrdinal;
    const successfulFramesAtAttempt = this.#successfulFrames;
    const onCaptureLifecycle = (event: LiveImageCaptureLifecycleEvent): void => {
      const atMs = performance.now();
      const details = { attemptOrdinal, successfulFrameCount: successfulFramesAtAttempt };
      switch (event.kind) {
        case 'timeout_fired':
          this.#record(session, 'capture_timeout', 'failure', atMs,
            { ...details, internalReason: 'CAPTURE_TIMEOUT' }, owner); break;
        case 'detach_requested':
          this.#record(session, 'capture_detach', 'started', atMs, details, owner); break;
        case 'detach_completed':
          this.#record(session, 'capture_detach', 'success', atMs, details, owner); break;
        case 'detach_failed':
          this.#record(session, 'capture_detach', 'failure', atMs,
            { ...details, internalReason: 'CDP_DETACH_FAILED', exceptionName: diagnosticExceptionName(event.error) }, owner);
          break;
        case 'detach_wait_expired':
          this.#record(session, 'capture_detach', 'failure', atMs,
            { ...details, internalReason: 'CDP_DETACH_TIMEOUT' }, owner); break;
        case 'capture_late_settled':
          this.#record(session, 'capture_late_settle', event.outcome ?? 'failure', atMs,
            { ...details, ...(event.error ? { exceptionName: diagnosticExceptionName(event.error) } : {}) }, owner);
          break;
        case 'late_result_discarded':
          this.#record(session, 'capture_late_discard', 'success', atMs,
            { ...details, internalReason: 'LATE_CAPTURE_DISCARDED' }, owner); break;
      }
    };
    try {
      const pages = session.context.pages().filter(page => !page.isClosed());
      if (pages.length !== 1 || pages[0]!.url() === 'about:blank') {
        this.#record(session, 'capture', 'skipped', startedAtMs, { attemptOrdinal,
          successfulFrameCount: this.#successfulFrames, internalReason: pages.length !== 1 ? 'PAGE_COUNT' : 'NOT_READY',
          ...(this.#lastSuccessfulFrameAt ? { lastSuccessfulFrameAt: this.#lastSuccessfulFrameAt } : {}) });
        this.#scheduleFrame(session, owner, generation); return;
      }
      const bytes = await captureViewportJpeg(pages[0]!, onCaptureLifecycle);
      if (generation !== this.#frameGeneration || session.isClosed || pages[0]!.isClosed()) return;
      const dimensions = jpegDimensions(bytes);
      if (!dimensions || dimensions.width > LIVE_IMAGE_MAX_WIDTH || dimensions.height > LIVE_IMAGE_MAX_HEIGHT ||
          bytes.length > LIVE_IMAGE_MAX_FRAME_BYTES) throw new Error('Deferred frame invalid');
      if (!this.#sendFrameNotice('frame', owner,
        { bytes, width: dimensions.width, height: dimensions.height })) throw new Error('Deferred frame unavailable');
      this.#successfulFrames++;
      this.#lastSuccessfulFrameAt = new Date().toISOString();
      this.#record(session, 'capture', 'success', startedAtMs, { attemptOrdinal,
        successfulFrameCount: this.#successfulFrames, lastSuccessfulFrameAt: this.#lastSuccessfulFrameAt });
      if (this.#successfulFrames === 1) this.#record(session, 'first_frame', 'success', startedAtMs,
        { attemptOrdinal, successfulFrameCount: 1, lastSuccessfulFrameAt: this.#lastSuccessfulFrameAt });
      this.#scheduleFrame(session, owner, generation);
    } catch (error) {
      if (generation !== this.#frameGeneration) return;
      const name = diagnosticExceptionName(error);
      const state = diagnosticBrowserState(session);
      const internalReason = this.#failed ? 'CHANNEL_LOST' as const :
        state.browser === 'disconnected' ? 'BROWSER_DISCONNECTED' as const :
        state.context === 'closed' ? 'CONTEXT_CLOSED' as const :
        state.page === 'closed' ? 'PAGE_CLOSED' as const :
        name === 'TimeoutError' || name === 'LiveImageCaptureTimeout' ? 'CAPTURE_TIMEOUT' as const :
        error instanceof Error && error.message === 'Deferred frame invalid' ? 'FRAME_INVALID' as const : 'CAPTURE_FAILED' as const;
      this.#record(session, 'capture', 'failure', startedAtMs, { attemptOrdinal,
        successfulFrameCount: this.#successfulFrames, ...(this.#lastSuccessfulFrameAt ? { lastSuccessfulFrameAt: this.#lastSuccessfulFrameAt } : {}),
        exceptionName: name, internalReason });
      if (generation === this.#frameGeneration && !this.#failed && !this.#closed) {
        if (this.#sendFrameNotice('unavailable', owner)) this.#record(session, 'unavailable', 'success');
        this.#stopFrames();
      }
    }
  }

  #send(kind: DeferredViewerNotice['kind'], owner: { phase: DeferredViewerPhase; ownerId: string },
    gateway?: ViewerGateway): boolean {
    if (this.#failed || this.#closed || this.#sequence >= MAX_NOTICES) { this.#fail(); return false; }
    const parsed = DeferredViewerNoticeSchema.safeParse({ deferredViewerVersion: '1', streamId: this.#streamId,
      sequence: ++this.#sequence, kind, phase: owner.phase, ownerId: owner.ownerId, testSpecId: this.#testSpecId,
      ...(kind === 'ready' && gateway ? { port: gateway.port, path: gateway.path,
        connectionCapability: gateway.capability, expiresAt: gateway.expiresAt } : {}) });
    if (!parsed.success) { this.#fail(); return false; }
    const line = JSON.stringify(parsed.data) + '\n';
    if (Buffer.byteLength(line) > MAX_BYTES || this.#socket.writableLength > 16 * 1024) { this.#fail(); return false; }
    this.#socket.write(line);
    return true;
  }

  /** Preflight is mandatory before first browser action; later observation failures do not change QA. */
  async open(session: ProtectedBrowserSession, phase: DeferredViewerPhase, ownerId: string): Promise<void> {
    id.parse(ownerId);
    const nextIndex = phases.indexOf(phase), previousIndex = this.#owner ? phases.indexOf(this.#owner.phase) : -1;
    if (nextIndex !== previousIndex + 1 || this.#closed) throw new Error('Deferred viewer phase order invalid');
    if (this.#failed) {
      if (this.#everReady) { this.#owner = { phase, ownerId }; return; }
      throw new Error('Deferred viewer unavailable');
    }
    if (this.#owner) {
      if (this.#mode === 'frame_stream') {
        if (this.#sendFrameNotice('transition', this.#owner)) this.#record(undefined, 'transition', 'success');
      }
      else this.#send('transition', this.#owner);
    }
    this.#stopFrames();
    this.#gateway?.close(); this.#gateway = undefined;
    const owner = { phase, ownerId }; this.#owner = owner;
    this.#activeSession = session;
    this.#captureOrdinal = 0; this.#successfulFrames = 0; this.#lastSuccessfulFrameAt = undefined;
    if (this.#failed && this.#everReady) return;
    if (this.#mode === 'frame_stream') {
      if (!this.#sendFrameNotice('ready', owner)) {
        if (this.#everReady) return;
        throw new Error('Deferred viewer unavailable');
      }
      this.#everReady = true;
      this.#record(session, 'ready', 'success');
      this.#record(session, 'loop_start', 'started');
      const generation = this.#frameGeneration;
      this.#scheduleFrame(session, owner, generation, 100);
      session.onClosing(() => this.closeSession(owner));
      return;
    }
    let gateway: ViewerGateway;
    try {
      gateway = await ViewerGateway.start(session, () => {
        if (this.#failed || this.#gateway !== gateway || this.#owner !== owner) return;
        try { gateway.issueReconnect(); this.#send('ready', owner, gateway); }
        catch { this.#send('unavailable', owner); gateway.close(); this.#gateway = undefined; }
      }, { sessionLifetimeMs: 1_200_000, onUnavailable: () => {
        if (this.#gateway !== gateway || this.#owner !== owner) return;
        this.#send('unavailable', owner);
        this.#gateway = undefined;
      } });
    } catch (error) {
      this.#send('unavailable', owner);
      if (this.#everReady) return;
      throw error;
    }
    if (this.#failed) { gateway.close(); if (this.#everReady) return; throw new Error('Deferred viewer unavailable'); }
    this.#gateway = gateway;
    if (!this.#send('ready', owner, gateway)) {
      if (this.#everReady) return;
      throw new Error('Deferred viewer unavailable');
    }
    this.#everReady = true;
    session.onClosing(() => this.closeSession(owner));
  }

  closeSession(owner: { phase: DeferredViewerPhase; ownerId: string }): void {
    if (this.#owner?.phase !== owner.phase || this.#owner.ownerId !== owner.ownerId) return;
    this.#stopFrames();
    this.#gateway?.close(); this.#gateway = undefined;
    if (this.#mode === 'frame_stream') {
      if (this.#sendFrameNotice('closed', owner)) this.#record(undefined, 'closed', 'success');
    }
    else this.#send('closed', owner);
  }

  close(): void {
    if (this.#closed) return;
    this.#stopFrames();
    this.#gateway?.close(); this.#gateway = undefined;
    this.#closed = true; this.#socket.end();
    this.#activeSession = undefined;
  }
}
