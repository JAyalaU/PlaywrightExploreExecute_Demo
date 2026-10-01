/** Opt-in credential-free Docker proof for the P4-3B gateway boundary. */
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { test, expect } from '@playwright/test';
import { ProfileCatalog } from '../app/profile/contracts.js';
import { ProtectedContextFactory } from '../app/profile/context.js';
import { ViewerGateway } from '../app/observability/viewer-gateway.js';
import { approveHeadedPublicInspection, inspectPublicUrl } from '../app/profile/admission.js';
import { publicTargetGate } from '../app/profile/public-target.js';

const RUNTIME = process.env.PUBLIC_BROWSER_P4_3B_RUNTIME === '1';
const profile = {
  id: 'p4-viewer-fixture', version: '1', profileSchemaVersion: '4',
  presentationMode: 'headed', browserIsolation: 'docker', browser: 'chromium',
  viewport: { width: 1280, height: 800 }, locale: 'en-US',
  timeoutPolicy: { actionMs: 10_000, navigationMs: 10_000, waits: { default: 10_000 } },
  networkPolicyRef: { id: 'p4-viewer-policy', version: '1' },
};
const policy = { id: 'p4-viewer-policy', version: '1', destinations: [
  { host: '127.0.0.1', ports: [18764], addresses: ['127.0.0.1'] },
] };

function request(port: number, token: string, origin = 'http://127.0.0.1:8501'): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let result = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Viewer response timed out')); }, 5000);
    socket.once('connect', () => socket.write(
      `GET /rfb HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nSec-WebSocket-Protocol: binary, viewer.${token}\r\n\r\n`));
    socket.on('data', (chunk) => {
      result += chunk.toString('latin1');
      if (result.includes('\r\n\r\n')) {
        clearTimeout(timer); socket.destroy(); resolve(result.split('\r\n')[0]!);
      }
    });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    socket.once('close', () => { clearTimeout(timer); if (!result) resolve('closed'); });
  });
}

test('P4-3B headed gateway serves pinned assets, denies stale/cross-origin clients, and disposes', async ({ page }) => {
  test.skip(!RUNTIME, 'Requires built headed Docker image and explicit runtime opt-in');
  const catalog = new ProfileCatalog([profile], [policy]);
  const session = await new ProtectedContextFactory(catalog).open({ id: profile.id, version: profile.version });
  const container = session.isolationContainerId;
  let gateway: ViewerGateway | undefined;
  let viewerPage: http.Server | undefined;
  try {
    expect(container).toMatch(/^[a-f0-9]{64}$/);
    gateway = await ViewerGateway.start(session);
    session.onClosing(() => gateway?.close());
    const asset = await fetch(`http://127.0.0.1:${gateway.port}/core/rfb.js`, {
      headers: { Origin: 'http://127.0.0.1:8501' },
    });
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('no-store');
    expect((await asset.text()).length).toBeGreaterThan(1000);
    expect((await fetch(`http://127.0.0.1:${gateway.port}/core/rfb.js`)).status).toBe(403);
    expect(await request(gateway.port, '0'.repeat(64))).toContain('403');
    expect(await request(gateway.port, gateway.capability, 'http://evil.example')).toContain('403');
    const used = gateway.capability;
    const gatewayPort = gateway.port;
    viewerPage = http.createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<div id="screen" style="width:800px;height:600px"></div><script type="module">
        import RFB from 'http://127.0.0.1:${gatewayPort}/core/rfb.js';
        const socket = new WebSocket('ws://127.0.0.1:${gatewayPort}/rfb',
          ['binary', 'viewer.${used}']);
        const rfb = new RFB(document.getElementById('screen'), socket);
        rfb.viewOnly = true;
        rfb.addEventListener('connect', () => { window.rfbConnected = true; });
        rfb.addEventListener('disconnect', () => { window.rfbDisconnected = true; });
      </script>`);
    });
    await new Promise<void>((resolve, reject) => viewerPage!.listen(8501, '127.0.0.1', (error?: Error) =>
      error ? reject(error) : resolve()));
    const viewerStart = Date.now();
    await page.goto('http://127.0.0.1:8501/');
    await page.waitForFunction(() => (window as unknown as { rfbConnected?: boolean }).rfbConnected === true,
      undefined, { timeout: 10_000 });
    console.log(`P4_3B_VIEWER_CONNECT_MS=${Date.now() - viewerStart}`);
    expect(await request(gateway.port, used)).toContain('403');
    const protectedPage = await session.context.newPage();
    await protectedPage.goto('data:text/html,<body style="background:rgb(255,0,0)"><main>Headed fixture</main></body>');
    expect(await protectedPage.locator('main').textContent()).toBe('Headed fixture');
    expect(await page.locator('#screen canvas').count()).toBeGreaterThan(0);
    await page.waitForFunction(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('#screen canvas');
      if (!canvas || canvas.width < 500 || canvas.height < 300) return false;
      const pixels = canvas.getContext('2d');
      return !!pixels && [
        [0.25, 0.35], [0.5, 0.35], [0.75, 0.35],
        [0.25, 0.65], [0.5, 0.65], [0.75, 0.65],
      ].every(([x, y]) => {
        const pixel = pixels.getImageData(
          Math.floor(canvas.width * x!), Math.floor(canvas.height * y!), 1, 1).data;
        return pixel[0]! > 200 && pixel[1]! < 80 && pixel[2]! < 80;
      });
    }, undefined, { timeout: 10_000 });
    await page.close();
    let reconnect: { capability: string; expiresAt: string } | undefined;
    for (let attempt = 0; attempt < 40 && !reconnect; attempt += 1) {
      try { reconnect = gateway.issueReconnect(); }
      catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
    }
    expect(reconnect).toBeDefined();
    expect(reconnect!.capability).not.toBe(used);
    expect(await request(gateway.port, used)).toContain('403');
  } finally {
    await page.close();
    if (viewerPage) await new Promise<void>((resolve) => viewerPage!.close(() => resolve()));
    gateway?.close();
    await session.close();
  }
  if (container) {
    const remaining = execFileSync('docker', ['ps', '-a', '--filter', `id=${container}`,
      '--format', '{{.ID}}'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    expect(remaining.trim()).toBe('');
  }
});

test('P4-3B exact headed public approval retains proxy-only transport and disposal', async () => {
  test.skip(!RUNTIME, 'Requires built headed Docker image and explicit runtime opt-in');
  test.setTimeout(90_000);
  const url = 'https://the-internet.herokuapp.com/challenging_dom';
  const pins = ['3.209.172.72', '23.22.130.173', '54.243.238.66', '107.22.57.98'];
  const resolver = async (): Promise<string[]> => pins;
  const inspected = await inspectPublicUrl(url, resolver);
  const { profile: headed, policy: egress, approval } = await approveHeadedPublicInspection(inspected, url, resolver);
  const catalog = new ProfileCatalog([headed], [egress]);
  const session = await new ProtectedContextFactory(catalog, undefined, publicTargetGate(approval))
    .open(approval.executionProfileRef);
  const container = session.isolationContainerId;
  try {
    const page = await session.context.newPage();
    const response = await page.goto(url, { waitUntil: 'commit', timeout: 30_000 });
    expect(response?.status()).toBe(200);
    expect(session.effectiveProfile.fingerprint).toBe(approval.profileFingerprint);
    const denied = await page.goto('http://127.0.0.1:19999/denied', { timeout: 5000 });
    expect(denied?.status()).toBe(403);
  } finally { await session.close(); }
  if (container) expect(execFileSync('docker', ['ps', '-a', '--filter', `id=${container}`,
    '--format', '{{.ID}}'], { encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim()).toBe('');
});
