import net from 'node:net';
import { z } from 'zod';
import { LiveEventProducer, MAX_EVENT_FRAME_BYTES, type LiveEvent } from './live-events.js';

const PORT = 'PLAYWRIGHT_DEMO_EVENT_PORT';
const STREAM = 'PLAYWRIGHT_DEMO_EVENT_STREAM_ID';
const CAPABILITY = 'PLAYWRIGHT_DEMO_EVENT_CAPABILITY';
const MAX_QUEUE = 32;
const MAX_QUEUE_BYTES = 64 * 1024;

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Trusted launch-only side channel. No page, model, or task data enters this module. */
export async function connectEventChannel(): Promise<{ producer: LiveEventProducer; flush: () => Promise<void>; close: () => void } | undefined> {
  const portText = process.env[PORT];
  const streamId = process.env[STREAM];
  const capability = process.env[CAPABILITY];
  delete process.env[PORT]; delete process.env[STREAM]; delete process.env[CAPABILITY];
  if (portText === undefined && streamId === undefined && capability === undefined) return undefined;
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 ||
      !streamId || !z.string().uuid().safeParse(streamId).success || !capability ||
      !/^[a-f0-9]{64}$/.test(capability)) throw new Error('Invalid event channel launch configuration');

  const socket = net.connect({ host: '127.0.0.1', port });
  socket.setNoDelay(true);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let pending = Buffer.alloc(0);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose);
      if (error) reject(error); else resolve();
    };
    const onError = (): void => finish(new Error('Event channel unavailable'));
    const onClose = (): void => finish(new Error('Event channel closed'));
    const onData = (chunk: Buffer): void => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > MAX_EVENT_FRAME_BYTES) { finish(new Error('Event channel acknowledgement too large')); return; }
      const end = pending.indexOf(10);
      if (end < 0) return;
      try {
        if (end !== pending.length - 1) throw new Error('Unexpected event channel data');
        const answer = JSON.parse(pending.subarray(0, end).toString('utf8')) as unknown;
        if (!exactObject(answer, ['eventStreamVersion', 'kind', 'streamId']) ||
            answer.eventStreamVersion !== '1' || answer.kind !== 'ready' || answer.streamId !== streamId)
          throw new Error('Invalid event channel acknowledgement');
        finish();
      } catch { finish(new Error('Invalid event channel acknowledgement')); }
    };
    const timer = setTimeout(() => finish(new Error('Event channel handshake timed out')), 5000);
    socket.on('data', onData); socket.on('error', onError); socket.on('close', onClose);
    socket.once('connect', () => {
      const hello = JSON.stringify({ eventStreamVersion: '1', kind: 'hello', streamId, capability }) + '\n';
      if (Buffer.byteLength(hello) > MAX_EVENT_FRAME_BYTES) { finish(new Error('Event channel hello too large')); return; }
      socket.write(hello);
    });
  }).catch((error) => { socket.destroy(); throw error; });

  // The capability has already been removed from the process environment. The
  // private socket is the only remaining transport, and cannot affect QA.
  let failed = false;
  let queued = 0;
  let queuedBytes = 0;
  socket.on('error', () => { failed = true; });
  socket.on('close', () => { failed = true; });
  const producer = new LiveEventProducer(streamId, (event: LiveEvent) => {
    if (failed) return;
    const bytes = Buffer.from(JSON.stringify(event) + '\n', 'utf8');
    if (bytes.length > MAX_EVENT_FRAME_BYTES || queued >= MAX_QUEUE || queuedBytes + bytes.length > MAX_QUEUE_BYTES) {
      failed = true; socket.destroy(); return;
    }
    queued++; queuedBytes += bytes.length;
    socket.write(bytes, () => { queued--; queuedBytes -= bytes.length; });
    if (socket.writableLength > MAX_QUEUE_BYTES) { failed = true; socket.destroy(); }
  });
  return {
    producer,
    flush: async () => {
      if (failed || socket.destroyed || socket.writableLength === 0) return;
      await Promise.race([
        new Promise<void>((resolve) => socket.once('drain', resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ]);
    },
    close: () => socket.end(),
  };
}
