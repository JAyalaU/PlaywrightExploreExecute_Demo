import { randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import { test, expect } from '@playwright/test';
import { DeferredViewerLifecycle, DeferredViewerNoticeSchema } from '../app/observability/deferred-viewer-channel.js';

const keys = ['PLAYWRIGHT_DEMO_DEFERRED_VIEWER_PORT', 'PLAYWRIGHT_DEMO_DEFERRED_VIEWER_STREAM_ID',
  'PLAYWRIGHT_DEMO_DEFERRED_VIEWER_CAPABILITY'] as const;

async function listen(reply: (hello: unknown, socket: net.Socket) => void) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let pending = '';
    socket.on('data', bytes => {
      pending += bytes.toString('utf8');
      const end = pending.indexOf('\n');
      if (end < 0) return;
      socket.removeAllListeners('data');
      reply(JSON.parse(pending.slice(0, end)) as unknown, socket);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback listener');
  return { server, sockets, port: address.port };
}

test('deferred viewer authenticates the launch channel and consumes the capability', async () => {
  const streamId = randomUUID(), capability = randomBytes(32).toString('hex');
  let hello: unknown;
  const { server, sockets, port } = await listen((value, socket) => {
    hello = value;
    socket.write(JSON.stringify({ deferredViewerVersion: '1', kind: 'ready', streamId }) + '\n');
  });
  const old = keys.map(key => process.env[key]);
  try {
    process.env[keys[0]] = String(port); process.env[keys[1]] = streamId; process.env[keys[2]] = capability;
    const lifecycle = await DeferredViewerLifecycle.connect('local-test');
    expect(hello).toEqual({ deferredViewerVersion: '1', kind: 'hello', streamId, capability });
    expect(keys.map(key => process.env[key])).toEqual([undefined, undefined, undefined]);
    lifecycle.close();
  } finally {
    keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; });
    sockets.forEach(socket => socket.destroy()); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('deferred viewer rejects a mismatched acknowledgement before browser work', async () => {
  const streamId = randomUUID(), capability = randomBytes(32).toString('hex');
  const { server, sockets, port } = await listen((_value, socket) => {
    socket.write(JSON.stringify({ deferredViewerVersion: '1', kind: 'ready', streamId: randomUUID() }) + '\n');
  });
  const old = keys.map(key => process.env[key]);
  try {
    process.env[keys[0]] = String(port); process.env[keys[1]] = streamId; process.env[keys[2]] = capability;
    await expect(DeferredViewerLifecycle.connect('local-test')).rejects.toThrow('acknowledgement invalid');
    expect(keys.map(key => process.env[key])).toEqual([undefined, undefined, undefined]);
  } finally {
    keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; });
    sockets.forEach(socket => socket.destroy()); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('deferred notices have an isolated phase and view-only endpoint contract', () => {
  const base = { deferredViewerVersion: '1', streamId: randomUUID(), sequence: 1,
    phase: 'exploration', ownerId: 'exploration-1', testSpecId: 'local-test' };
  const ready = { ...base, kind: 'ready', port: 12345, path: '/rfb',
    connectionCapability: randomBytes(32).toString('hex'), expiresAt: new Date().toISOString() };
  expect(DeferredViewerNoticeSchema.parse(ready)).toEqual(ready);
  expect(DeferredViewerNoticeSchema.safeParse({ ...base, kind: 'closed', connectionCapability: ready.connectionCapability }).success).toBe(false);
  expect(DeferredViewerNoticeSchema.safeParse({ ...ready, sourceEventSequence: 1 }).success).toBe(false);
});
