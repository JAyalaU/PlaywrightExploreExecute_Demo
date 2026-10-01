/** Separate P4-G2 authenticated lifecycle channel; never carries RFB or page bytes. */
import net from 'node:net';
import { z } from 'zod';
import type { ProtectedBrowserSession } from '../profile/context.js';
import type { LiveViewerPolicy } from '../local/contracts.js';
import type { LiveEventProducer } from './live-events.js';
import { ViewerGateway } from './viewer-gateway.js';

const PORT = 'PLAYWRIGHT_DEMO_VIEWER_PORT';
const STREAM = 'PLAYWRIGHT_DEMO_VIEWER_STREAM_ID';
const CAPABILITY = 'PLAYWRIGHT_DEMO_VIEWER_CAPABILITY';
const MAX_NOTICE_BYTES = 2048;
const MAX_NOTICES = 32;
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/);
const profile = z.strictObject({ id, version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/) });
const owner = z.strictObject({ kind: z.enum(['attempt', 'run']), id });
const base = {
  liveViewerVersion: z.literal('1'), streamId: z.string().uuid(),
  sequence: z.number().int().min(1).max(MAX_NOTICES),
  sourceEventSequence: z.number().int().min(1).max(256),
  testSpecId: id, executionProfileRef: profile,
  profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/), owner,
};
export const ViewerNoticeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, kind: z.literal('ready'),
    port: z.number().int().min(1).max(65535), path: z.literal('/rfb'),
    connectionCapability: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.string().datetime({ offset: true }) }),
  z.strictObject({ ...base, kind: z.literal('transition') }),
  z.strictObject({ ...base, kind: z.literal('closed') }),
  z.strictObject({ ...base, kind: z.literal('unavailable') }),
]);
export type ViewerNotice = z.infer<typeof ViewerNoticeSchema>;

function exactly(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export class ViewerLifecycle {
  readonly #socket: net.Socket;
  readonly #events: LiveEventProducer;
  #policy = false;
  #sequence = 0;
  #gateway: ViewerGateway | undefined;
  #owner: { kind: 'attempt' | 'run'; id: string } | undefined;
  #ownerEventSequence = 0;
  #failed = false;
  #closed = false;

  private constructor(socket: net.Socket, events: LiveEventProducer) {
    this.#socket = socket; this.#events = events;
    socket.on('error', () => { this.#failed = true; this.#gateway?.close(); });
    socket.on('close', () => { this.#failed = true; this.#gateway?.close(); });
  }

  static async connect(events: LiveEventProducer | undefined): Promise<ViewerLifecycle | undefined> {
    const portText = process.env[PORT], streamId = process.env[STREAM];
    const capability = process.env[CAPABILITY];
    delete process.env[PORT]; delete process.env[STREAM]; delete process.env[CAPABILITY];
    if (portText === undefined && streamId === undefined && capability === undefined) return undefined;
    const port = Number(portText);
    if (!events || events.streamId !== streamId || !Number.isSafeInteger(port) || port < 1 || port > 65535 ||
        !capability || !/^[a-f0-9]{64}$/.test(capability)) throw new Error('Invalid viewer channel launch');
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setNoDelay(true);
    await new Promise<void>((resolve, reject) => {
      let finished = false, pending = Buffer.alloc(0);
      const finish = (error?: Error): void => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose);
        if (error) reject(error); else resolve();
      };
      const onError = (): void => finish(new Error('Viewer lifecycle unavailable'));
      const onClose = (): void => finish(new Error('Viewer lifecycle closed'));
      const onData = (bytes: Buffer): void => {
        pending = Buffer.concat([pending, bytes]);
        if (pending.length > MAX_NOTICE_BYTES) { finish(new Error('Viewer acknowledgement too large')); return; }
        const end = pending.indexOf(10);
        if (end < 0) return;
        try {
          if (end !== pending.length - 1) throw new Error('Viewer acknowledgement extra data');
          const answer = JSON.parse(pending.subarray(0, end).toString('utf8')) as unknown;
          if (!exactly(answer, ['liveViewerVersion', 'kind', 'streamId']) ||
              answer.liveViewerVersion !== '1' || answer.kind !== 'ready' || answer.streamId !== streamId)
            throw new Error('Viewer acknowledgement invalid');
          finish();
        } catch { finish(new Error('Viewer acknowledgement invalid')); }
      };
      const timer = setTimeout(() => finish(new Error('Viewer lifecycle handshake timed out')), 5000);
      socket.on('data', onData); socket.on('error', onError); socket.on('close', onClose);
      socket.once('connect', () => socket.write(JSON.stringify({
        liveViewerVersion: '1', kind: 'hello', streamId, capability,
      }) + '\n'));
    }).catch((error) => { socket.destroy(); throw error; });
    return new ViewerLifecycle(socket, events);
  }

  policy(value: LiveViewerPolicy | undefined): void {
    this.#policy = value?.liveViewerPolicyVersion === '1' && value.displayApproved || false;
  }

  get approved(): boolean { return this.#policy && !this.#failed && !this.#closed; }

  #send(kind: ViewerNotice['kind'], ownerValue: { kind: 'attempt' | 'run'; id: string },
    gateway?: ViewerGateway, sourceEventSequence = this.#ownerEventSequence): void {
    const context = this.#events.context;
    if (!context || !this.approved || this.#sequence >= MAX_NOTICES || sourceEventSequence < 1) {
      this.#failed = true; this.#gateway?.close(); return;
    }
    const candidate = {
      liveViewerVersion: '1', streamId: this.#events.streamId,
      sequence: ++this.#sequence, sourceEventSequence,
      testSpecId: context.testSpecId,
      executionProfileRef: context.executionProfileRef,
      profileFingerprint: context.profileFingerprint,
      owner: ownerValue, kind,
      ...(gateway && kind === 'ready' ? {
        port: gateway.port, path: gateway.path,
        connectionCapability: gateway.capability, expiresAt: gateway.expiresAt,
      } : {}),
    };
    const parsed = ViewerNoticeSchema.safeParse(candidate);
    if (!parsed.success) { this.#failed = true; this.#gateway?.close(); return; }
    const line = JSON.stringify(parsed.data) + '\n';
    if (Buffer.byteLength(line) > MAX_NOTICE_BYTES || this.#socket.writableLength > 16 * 1024) {
      this.#failed = true; this.#gateway?.close(); return;
    }
    this.#socket.write(line);
  }

  async open(session: ProtectedBrowserSession, current: { kind: 'attempt' | 'run'; id: string }): Promise<void> {
    if (!this.approved) throw new Error('Headed viewer not approved or channel unavailable');
    if (this.#owner) this.#send('transition', this.#owner);
    this.#gateway?.close(); this.#gateway = undefined;
    this.#owner = current;
    this.#ownerEventSequence = this.#events.sequence;
    const gateway = await ViewerGateway.start(session, () => {
      if (!this.approved || this.#gateway !== gateway || !this.#owner) return;
      try {
        gateway.issueReconnect();
        this.#send('ready', this.#owner, gateway);
      } catch { this.#send('unavailable', this.#owner); gateway.close(); }
    });
    if (!this.approved) { gateway.close(); throw new Error('Viewer lifecycle unavailable'); }
    this.#gateway = gateway;
    this.#send('ready', current, gateway);
    if (!this.approved) throw new Error('Viewer lifecycle unavailable');
    session.onClosing(() => this.closeSession(current));
  }

  closeSession(current: { kind: 'attempt' | 'run'; id: string }): void {
    if (!this.#owner || this.#owner.kind !== current.kind || this.#owner.id !== current.id) return;
    this.#gateway?.close(); this.#gateway = undefined;
    this.#send('closed', current);
  }

  close(): void {
    if (this.#closed) return;
    this.#gateway?.close(); this.#gateway = undefined;
    this.#closed = true; this.#socket.end();
  }
}
