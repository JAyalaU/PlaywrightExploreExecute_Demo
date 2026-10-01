import { createHash } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { test, expect } from '@playwright/test';
import {
  NetworkPolicySchema, ProfileCatalog, ProtectedContextFactory, ProtectedProxy,
  assertEquivalentEffectiveProfile, resolveApprovedAddress,
} from '../app/profile/index.js';

function policy(port: number, version = '1') {
  return { id: 'fixture-policy', version, destinations: [{ host: '127.0.0.1', ports: [port], addresses: ['127.0.0.1'] }] };
}

function profile(port: number, extras: Record<string, unknown> = {}) {
  return {
    id: 'desktop', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 },
    locale: 'en-US', timezoneId: 'UTC', colorScheme: 'dark',
    timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: { default: 3000 } },
    networkPolicyRef: { id: 'fixture-policy', version: '1' }, ...extras,
  };
}

async function fixtureServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port');
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    server,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

test('M3-A resolves immutable profile versions and refuses mismatch or unavailable dependencies', () => {
  const input = profile(4173);
  const registry = new ProfileCatalog([input], [policy(4173)]);
  const original = registry.resolve({ id: 'desktop', version: '1' });
  input.viewport.width = 1200;
  const same = registry.resolve({ id: 'desktop', version: '1' });
  expect(same.profile.viewport.width).toBe(900);
  expect(() => { same.profile.viewport.width = 1100; }).toThrow();
  assertEquivalentEffectiveProfile(original, same);
  expect(() => registry.resolve({ id: 'desktop', version: '2' })).toThrow('Unavailable execution profile');
  expect(() => new ProfileCatalog([profile(4173)], []).resolve({ id: 'desktop', version: '1' })).toThrow('Unavailable network policy');
  expect(() => new ProfileCatalog([profile(4173), profile(4173)], [policy(4173)])).toThrow('Duplicate execution profile');
  const changed = new ProfileCatalog([profile(4173, { viewport: { width: 1200, height: 600 } })], [policy(4173)]).resolve({ id: 'desktop', version: '1' });
  expect(() => assertEquivalentEffectiveProfile(original, changed)).toThrow('new profile version');
  const policyChanged = new ProfileCatalog([profile(4173)], [policy(5000)]).resolve({ id: 'desktop', version: '1' });
  expect(() => assertEquivalentEffectiveProfile(original, policyChanged)).toThrow('new profile version');
});

test('M3-B rejects DNS address changes and invalid policy forms before socket connection', async () => {
  const rules = NetworkPolicySchema.parse({ id: 'p', version: '1', destinations: [{ host: 'example.test', ports: [443], addresses: ['93.184.215.14'] }] });
  expect(await resolveApprovedAddress(new URL('https://example.test/'), rules, async () => ['93.184.215.14'])).toBe('93.184.215.14');
  await expect(resolveApprovedAddress(new URL('https://example.test/'), rules, async () => ['127.0.0.1'])).rejects.toThrow('Destination address denied');
  await expect(resolveApprovedAddress(new URL('https://other.test/'), rules, async () => ['93.184.215.14'])).rejects.toThrow('Destination denied');
  expect(() => NetworkPolicySchema.parse({ id: 'p', version: '1', destinations: [{ host: '*.example.test', ports: [443], addresses: ['127.0.0.1'] }] })).toThrow();
});

test('M3-B browser proxy governs navigation, redirects, frames, subresources, fetch, WebSockets, and download requests', async () => {
  let deniedHits = 0;
  const denied = await fixtureServer((_req, res) => { deniedHits++; res.end('unexpected'); });
  let allowedHits = 0;
  const allowed = await fixtureServer((req, res) => {
    allowedHits++;
    if (req.url === '/redirect') { res.writeHead(302, { location: `${denied.url}/secret` }); res.end(); return; }
    if (req.url === '/download') { res.writeHead(200, { 'content-disposition': 'attachment; filename="secret.txt"' }); res.end('secret'); return; }
    if (req.url === '/script.js') { res.setHeader('content-type', 'application/javascript'); res.end('window.scriptLoaded = true'); return; }
    if (req.url === '/data') { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); return; }
    if (req.url === '/frame') { res.end('frame reached'); return; }
    res.setHeader('content-type', 'text/html');
    res.end(`<script src="${allowed.url}/script.js"></script><iframe src="${denied.url}/frame"></iframe><img src="${denied.url}/image"><a id="download" href="${denied.url}/download">Download</a>`);
  });
  allowed.server.on('upgrade', (req, socket) => {
    allowedHits++;
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(Buffer.from([0x81, 0x02, 0x4f, 0x4b]));
    setTimeout(() => socket.destroy(), 100).unref();
  });
  const factory = new ProtectedContextFactory(new ProfileCatalog([profile(allowed.port)], [policy(allowed.port)]));
  const session = await factory.open({ id: 'desktop', version: '1' });
  try {
    const deniedResponses: number[] = [];
    session.context.on('response', (response) => {
      if (response.url().startsWith(denied.url)) deniedResponses.push(response.status());
    });
    const page = await session.context.newPage();
    await page.goto(allowed.url);
    expect(await page.evaluate(() => (window as Window & { scriptLoaded?: boolean }).scriptLoaded)).toBe(true);
    expect(await page.evaluate(() => fetch('/data').then((response) => response.json()))).toEqual({ ok: true });
    expect((await page.goto(`${denied.url}/secret`))?.status()).toBe(403);
    expect((await page.goto(`${allowed.url}/redirect`))?.status()).toBe(403);
    await page.goto(allowed.url);
    await page.evaluate((url) => fetch(url, { mode: 'no-cors' }).then(() => undefined), `${denied.url}/api`);
    await page.locator('#download').click({ timeout: 3000 });
    await page.waitForTimeout(100);
    const wsValue = await page.evaluate((url) => new Promise<string>((resolve) => {
      const timeout = setTimeout(() => resolve('timeout'), 3000);
      const ws = new WebSocket(url); ws.onmessage = (event) => { clearTimeout(timeout); resolve(String(event.data)); ws.close(); }; ws.onerror = () => { clearTimeout(timeout); resolve('error'); };
    }), `ws://127.0.0.1:${allowed.port}/ws`);
    expect(wsValue).toBe('OK');
    await page.evaluate((url) => { (window as Window & { blockedSocket?: WebSocket }).blockedSocket = new WebSocket(url); }, `ws://127.0.0.1:${denied.port}/ws`);
    await page.waitForTimeout(500);
    expect(allowedHits).toBeGreaterThan(3);
    expect(deniedResponses.length).toBeGreaterThanOrEqual(5);
    expect(deniedResponses.every((status) => status === 403)).toBe(true);
    expect(deniedHits).toBe(0);
  } finally {
    await session.close(); await allowed.close(); await denied.close();
  }
});

test('M3-B CONNECT tunnels require an approved address and port', async () => {
  const allowed = await fixtureServer((_req, res) => res.end('ok'));
  const proxy = await ProtectedProxy.start(NetworkPolicySchema.parse(policy(allowed.port)));
  try {
    const proxyPort = new URL(proxy.url).port;
    const connect = (port: number) => new Promise<number>((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: Number(proxyPort), method: 'CONNECT', path: `127.0.0.1:${port}` });
      request.on('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode ?? 0); });
      request.on('error', reject);
      request.end();
    });
    expect(await connect(allowed.port)).toBe(200);
    expect(await connect(allowed.port + 1)).toBe(403);
    const upgradeStatus = await new Promise<number>((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: Number(proxyPort), method: 'GET', path: `http://127.0.0.1:${allowed.port + 1}/ws`, headers: { connection: 'Upgrade', upgrade: 'websocket' } });
      request.on('response', (response) => { resolve(response.statusCode ?? 0); response.resume(); });
      request.on('error', reject);
      request.end();
    });
    expect(upgradeStatus).toBe(403);
  } finally { await proxy.close(); await allowed.close(); }
});

test('M3-B accepts an explicit default HTTPS CONNECT port without widening authority', async () => {
  const proxy = await ProtectedProxy.start(NetworkPolicySchema.parse(policy(443)));
  try {
    const connect = (authority: string) => new Promise<number>((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: Number(new URL(proxy.url).port),
        method: 'CONNECT', path: authority });
      request.on('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode ?? 0); });
      request.on('error', reject);
      request.end();
    });
    // A local listener on 443 yields 200; otherwise the authorized socket
    // attempt yields 502. Neither is an authority/policy rejection.
    expect([200, 502]).toContain(await connect('127.0.0.1:443'));
    expect(await connect('127.0.0.1:0443')).toBe(403);
    expect(await connect('127.0.0.1:444')).toBe(403);
  } finally { await proxy.close(); }
});

test('M3-C creates isolated disposable contexts and keeps auth contents external', async () => {
  const server = await fixtureServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<body>${req.headers.cookie ?? ''}</body>`); });
  const definition = profile(server.port, { authStateRef: { id: 'fixture-user', version: '1' } });
  const catalog = new ProfileCatalog([definition], [policy(server.port)]);
  const reference = { id: 'desktop', version: '1' };
  await expect(new ProtectedContextFactory(catalog).open(reference)).rejects.toThrow('auth-state provider');
  let loads = 0;
  const factory = new ProtectedContextFactory(catalog, { load: async () => {
    loads++;
    return { cookies: [{ name: 'sid', value: 'private-token', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] };
  } });
  const first = await factory.open(reference);
  try {
    const page = await first.context.newPage();
    await page.goto(server.url);
    expect(await page.locator('body').innerText()).toContain('sid=private-token');
    await page.evaluate(() => localStorage.setItem('state', 'first-run'));
    expect(await page.evaluate(() => [innerWidth, innerHeight])).toEqual([900, 600]);
    expect(first.versions.browser).toMatch(/^\d+/);
    expect(JSON.stringify(first.effectiveProfile)).not.toContain('private-token');
  } finally { await first.close(); }
  const second = await factory.open(reference, first.effectiveProfile);
  try {
    const page = await second.context.newPage();
    await page.goto(server.url);
    expect(await page.evaluate(() => localStorage.getItem('state'))).toBeNull();
    expect(loads).toBe(2);
  } finally { await second.close(); await second.close(); await server.close(); }
});
