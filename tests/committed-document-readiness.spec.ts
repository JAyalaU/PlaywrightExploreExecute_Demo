import http from 'node:http';
import { once } from 'node:events';
import { chromium, expect, test } from '@playwright/test';
import { ProtectedBrowserSession } from '../app/profile/local-context.js';
import { NativeProfileCatalog } from '../app/profile/native-profile.js';
import { CommittedDocumentReadiness } from '../app/browser-action/committed-document-readiness.js';

type Handler = (request: http.IncomingMessage, response: http.ServerResponse) => void;
async function fixture(handler: Handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Port unavailable');
  const base = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const profile = new NativeProfileCatalog([{ id: 'readiness', version: '1', browser: 'chromium',
    viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 3000, navigationMs: 5000, waits: { default: 3000 } },
    profileSchemaVersion: '5', presentationMode: 'headless', browserIsolation: 'local-windows',
    browserRuntime: 'playwright-chromium-windows' }])
    .resolve({ id: 'readiness', version: '1' });
  const session = new ProtectedBrowserSession(browser, context, profile);
  const page = await context.newPage();
  const close = async () => { await session.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); };
  return { base, page, session, close };
}

test('committed readiness distinguishes an uncommitted page from a completed document', async () => {
  const f = await fixture((_request, response) => { response.setHeader('content-type', 'text/html');
    response.end('<select></select>'); });
  const readiness = new CommittedDocumentReadiness(f.session);
  try {
    expect(await readiness.wait(f.page, 5000)).toMatchObject({ waitRequired: false, domContentLoadedReached: false });
    await f.page.goto(`${f.base}/dropdown`, { waitUntil: 'domcontentloaded' });
    const reached = await readiness.wait(f.page, 5000);
    expect(reached).toMatchObject({ waitRequired: false, domContentLoadedReached: true });
    expect(reached.generationId).toMatch(/^document-/);
  } finally { readiness.dispose(); await f.close(); }
});

test('committed readiness waits for a blocking script before permitting the current generation', async () => {
  let releaseScript: (() => void) | undefined;
  const f = await fixture((request, response) => {
    if (request.url === '/slow.js') { releaseScript = () => response.end('window.ready = true'); return; }
    response.setHeader('content-type', 'text/html');
    response.end('<script src="/slow.js"></script><select></select>');
  });
  const readiness = new CommittedDocumentReadiness(f.session);
  try {
    await f.page.goto(`${f.base}/dropdown`, { waitUntil: 'commit' });
    const pending = readiness.wait(f.page, 5000);
    let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
    await expect.poll(() => !!releaseScript).toBe(true);
    expect(settled).toBe(false);
    releaseScript?.();
    expect(await pending).toMatchObject({ waitRequired: true, domContentLoadedReached: true });
  } finally { releaseScript?.(); readiness.dispose(); await f.close(); }
});

test('committed readiness rejects a timed-out or replaced document', async () => {
  const slow = new Set<http.ServerResponse>();
  const f = await fixture((request, response) => {
    if (request.url === '/slow.js') { slow.add(response); return; }
    response.setHeader('content-type', 'text/html');
    response.end(request.url === '/ready' ? '<select></select>' : '<script src="/slow.js"></script>');
  });
  const readiness = new CommittedDocumentReadiness(f.session);
  try {
    await f.page.goto(`${f.base}/loading`, { waitUntil: 'commit' });
    await expect(readiness.wait(f.page, 30)).rejects.toMatchObject({ reason: 'TIMEOUT' });
    const pending = readiness.wait(f.page, 5000);
    const rejection = expect(pending).rejects.toMatchObject({ reason: 'DOCUMENT_REPLACED' });
    await f.page.goto(`${f.base}/ready`, { waitUntil: 'domcontentloaded' });
    await rejection;
    const observed = await readiness.wait(f.page, 5000);
    readiness.assertCurrentGeneration(f.page, observed);
    await f.page.reload({ waitUntil: 'domcontentloaded' });
    expect(() => readiness.assertCurrentGeneration(f.page, observed)).toThrow(
      expect.objectContaining({ reason: 'DOCUMENT_REPLACED' }));
  } finally {
    for (const response of slow) if (!response.writableEnded && !response.destroyed) response.end('');
    readiness.dispose(); await f.close();
  }
});
