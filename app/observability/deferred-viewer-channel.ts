/** Authenticated, view-only lifecycle for the active deferred workflow. No page or QA data crosses this channel. */
import net from 'node:net';
import { z } from 'zod';
import type { ProtectedBrowserSession } from '../profile/context.js';
import { ViewerGateway } from './viewer-gateway.js';

const PORT = 'PLAYWRIGHT_DEMO_DEFERRED_VIEWER_PORT';
const STREAM = 'PLAYWRIGHT_DEMO_DEFERRED_VIEWER_STREAM_ID';
const CAPABILITY = 'PLAYWRIGHT_DEMO_DEFERRED_VIEWER_CAPABILITY';
const MAX_BYTES = 2048;
const MAX_NOTICES = 64;
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

  private constructor(socket: net.Socket, streamId: string, testSpecId: string) {
    this.#socket = socket; this.#streamId = streamId; this.#testSpecId = testSpecId;
    socket.on('error', () => this.#fail());
    socket.on('close', () => this.#fail());
    socket.on('data', () => this.#fail());
  }

  /** The three launch capabilities are consumed even on a rejected handshake. */
  static async connect(testSpecId: string): Promise<DeferredViewerLifecycle> {
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
    return new DeferredViewerLifecycle(socket, streamId, testSpecId);
  }

  #fail(): void {
    this.#failed = true; this.#gateway?.close(); this.#gateway = undefined;
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
    if (this.#owner) this.#send('transition', this.#owner);
    this.#gateway?.close(); this.#gateway = undefined;
    const owner = { phase, ownerId }; this.#owner = owner;
    if (this.#failed && this.#everReady) return;
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
    this.#gateway?.close(); this.#gateway = undefined;
    this.#send('closed', owner);
  }

  close(): void {
    if (this.#closed) return;
    this.#gateway?.close(); this.#gateway = undefined;
    this.#closed = true; this.#socket.end();
  }
}
