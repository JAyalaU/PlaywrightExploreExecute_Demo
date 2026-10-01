/** P4-G1 private image-only channel. Never used for events, results or artifacts. */
import net from 'node:net';
import { z } from 'zod';
import type { LiveImageFrame, LiveImageSink } from './live-images.js';
import type { LiveImagePolicy } from '../local/contracts.js';

const PORT = 'PLAYWRIGHT_DEMO_IMAGE_PORT';
const STREAM = 'PLAYWRIGHT_DEMO_IMAGE_STREAM_ID';
const CAPABILITY = 'PLAYWRIGHT_DEMO_IMAGE_CAPABILITY';
const MAX_HEADER = 2048;
const MAX_PENDING = 128 * 1024;
const REF = z.strictObject({ id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/),
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/) });
const HEADER = z.strictObject({ liveImageVersion: z.literal('1'), streamId: z.string().uuid(),
  kind: z.literal('frame'), frameSequence: z.number().int().min(1).max(32),
  sourceEventSequence: z.number().int().min(1).max(256),
  testSpecId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/),
  executionProfileRef: REF, profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  owner: z.strictObject({ kind: z.enum(['attempt', 'run']), id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/) }),
  capturedAt: z.string().datetime(), mimeType: z.literal('image/jpeg'),
  width: z.number().int().min(1).max(800), height: z.number().int().min(1).max(600),
  byteCount: z.number().int().min(1).max(128 * 1024) });

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export interface ImageChannel {
  sink: LiveImageSink;
  policy: (value: LiveImagePolicy | undefined) => void;
  close: () => void;
}

export async function connectImageChannel(eventStreamId: string | undefined): Promise<ImageChannel | undefined> {
  const portText = process.env[PORT];
  const streamId = process.env[STREAM];
  const capability = process.env[CAPABILITY];
  delete process.env[PORT]; delete process.env[STREAM]; delete process.env[CAPABILITY];
  if (portText === undefined && streamId === undefined && capability === undefined) return undefined;
  const port = Number(portText);
  if (!eventStreamId || eventStreamId !== streamId || !z.string().uuid().safeParse(streamId).success ||
      !Number.isSafeInteger(port) || port < 1 || port > 65535 || !capability ||
      !/^[a-f0-9]{64}$/.test(capability)) throw new Error('Invalid image channel launch configuration');

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
    const onError = (): void => finish(new Error('Image channel unavailable'));
    const onClose = (): void => finish(new Error('Image channel closed'));
    const onData = (chunk: Buffer): void => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > MAX_HEADER) { finish(new Error('Image acknowledgement too large')); return; }
      const end = pending.indexOf(10);
      if (end < 0) return;
      try {
        if (end !== pending.length - 1) throw new Error('Unexpected image channel data');
        const answer = JSON.parse(pending.subarray(0, end).toString('utf8')) as unknown;
        if (!exact(answer, ['liveImageVersion', 'kind', 'streamId']) ||
            answer.liveImageVersion !== '1' || answer.kind !== 'ready' || answer.streamId !== streamId)
          throw new Error('Invalid image acknowledgement');
        finish();
      } catch { finish(new Error('Invalid image acknowledgement')); }
    };
    const timer = setTimeout(() => finish(new Error('Image handshake timed out')), 5_000);
    socket.on('data', onData); socket.on('error', onError); socket.on('close', onClose);
    socket.once('connect', () => socket.write(JSON.stringify({ liveImageVersion: '1', kind: 'hello',
      streamId, capability }) + '\n'));
  }).catch((error) => { socket.destroy(); throw error; });

  let enabled = false;
  let failed = false;
  let closed = false;
  let sending = false;
  socket.on('error', () => { failed = true; });
  socket.on('close', () => { failed = true; });
  const state = (name: string): void => {
    if (failed || socket.destroyed || socket.writableLength > MAX_PENDING) return;
    socket.write(JSON.stringify({ liveImageVersion: '1', streamId, kind: 'state', state: name }) + '\n');
  };
  return {
    policy: (value) => {
      enabled = value?.liveImagePolicyVersion === '1' && value.captureApproved && value.displayApproved || false;
      if (!enabled) state('capture_disabled');
    },
    sink: (frame: LiveImageFrame) => {
      if (!enabled || failed || closed || sending || socket.destroyed || socket.writableLength) return;
      const { bytes, ...candidate } = frame;
      const header = HEADER.parse({ ...candidate, kind: 'frame' });
      if (header.streamId !== streamId || bytes.length !== header.byteCount) return;
      const line = Buffer.from(JSON.stringify(header) + '\n', 'utf8');
      if (line.length > MAX_HEADER || bytes.length > MAX_PENDING) return;
      sending = true;
      socket.write(line);
      socket.write(bytes, () => {
        sending = false;
        if (header.frameSequence === 32) state('limit_reached');
      });
      if (socket.writableLength > MAX_PENDING + MAX_HEADER) { failed = true; socket.destroy(); }
    },
    close: () => {
      if (closed) return;
      closed = true;
      if (enabled) state('closed');
      socket.end();
    },
  };
}
