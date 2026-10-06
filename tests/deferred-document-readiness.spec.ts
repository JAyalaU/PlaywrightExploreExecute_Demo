import http from 'node:http';
import { once } from 'node:events';
import { chromium, expect, test } from '@playwright/test';
import { ProtectedBrowserSession, ProfileCatalog } from '../app/profile/index.js';
import { DeferredBrowserDiagnosticCollector } from '../app/domain/deferred-browser-diagnostics.js';
import { DeferredDocumentReadinessTracker } from '../app/exploration/deferred-document-readiness.js';
import { CommittedDocumentReadiness } from
  '../app/browser-action/committed-document-readiness.js';

type Handler = (request: http.IncomingMessage, response: http.ServerResponse) => void;
async function fixture(handler: Handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Port unavailable');
  const base = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const profile = new ProfileCatalog([{ id: 'readiness', version: '1', browser: 'chromium',
    viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 3000, navigationMs: 5000, waits: { default: 3000 } },
    networkPolicyRef: { id: 'fixture', version: '1' } }],
  [{ id: 'fixture', version: '1', destinations: [{ host: '127.0.0.1', ports: [address.port], addresses: ['127.0.0.1'] }] }])
    .resolve({ id: 'readiness', version: '1' });
  const session = new ProtectedBrowserSession(browser, context, profile);
  const diagnostics = new DeferredBrowserDiagnosticCollector();
  const ids = new WeakMap<object, string>(); let ordinal = 0;
  const tracker = new DeferredDocumentReadinessTracker(session, 'exploration-readiness', diagnostics.record,
    object => { let id = ids.get(object); if (!id) { id = `owner-${++ordinal}`; ids.set(object, id); } return id; });
  // Match production: the session-owned tracker sees page creation and the first root request.
  const page = await context.newPage();
  const close = async () => {
    tracker.dispose(); await session.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  const boundary = async (name: 'before_click' | 'after_click' | 'url_observation' | 'before_candidate_query') => {
    const completed = () => diagnostics.snapshot().filter(event => event.operation === 'document_readiness' &&
      event.outcome !== 'started');
    const before = completed().length;
    tracker.probe(name, name === 'before_candidate_query' ? 'step4' : 'step2');
    await expect.poll(() => completed().length).toBe(before + 1);
    return completed().at(-1)!;
  };
  return { server, base, page, session, tracker, diagnostics, boundary, close };
}

test('committed document reports response, lifecycle, select presence and stable generation', async () => {
  const f = await fixture((_request, response) => { response.setHeader('content-type', 'text/html');
    response.end('<select><option>Private Option</option></select>'); });
  try {
    const before = await f.boundary('before_click');
    await f.page.goto(`${f.base}/dropdown`);
    const after = await f.boundary('after_click');
    const observed = await f.boundary('url_observation');
    const query = await f.boundary('before_candidate_query');
    expect(before.documentGenerationId).not.toBe(after.documentGenerationId);
    expect(after).toMatchObject({ documentReadyState: 'complete', domContentLoadedObserved: true,
      loadObserved: true, mainResponseObserved: true, mainResponseStatusClass: '2xx',
      navigationCommitted: true, navigationFailed: false, redirectCount: 0 });
    expect(query.documentGenerationId).toBe(observed.documentGenerationId);
    const navigation = f.diagnostics.snapshot().filter(event => event.operation === 'main_document_navigation' &&
      event.currentUrl === `${f.base}/dropdown`);
    const started = navigation.find(event => event.outcome === 'started');
    const committed = navigation.find(event => event.outcome === 'success' && event.navigationCommitted);
    const response = f.diagnostics.snapshot().find(event => event.operation === 'main_document_response' &&
      event.currentUrl === `${f.base}/dropdown`);
    expect(started).toMatchObject({ ownerId: 'exploration-readiness', pageId: query.pageId,
      mainFrameId: query.mainFrameId, navigationCommitted: false });
    expect(committed).toMatchObject({ pageId: query.pageId, mainFrameId: query.mainFrameId,
      documentGenerationId: query.documentGenerationId, navigationCommitted: true });
    expect(response).toMatchObject({ documentGenerationId: query.documentGenerationId,
      mainResponseObserved: true, mainResponseStatusClass: '2xx' });
    expect(started!.documentGenerationId).toBe(query.documentGenerationId);
    expect(started!.startedAtMs).toBeLessThanOrEqual(committed!.startedAtMs);
    expect(response!.startedAtMs).toBeLessThanOrEqual(query.startedAtMs);
    expect(query.documentReplacedSinceUrlObservation).toBe(false);
    expect(await f.page.getByRole('combobox').count()).toBe(1);
    expect(JSON.stringify(f.diagnostics.snapshot())).not.toContain('Private Option');
    expect(JSON.stringify(f.diagnostics.snapshot())).not.toContain('<select>');
  } finally { await f.close(); }
});

test('URL can commit while document is loading before DOMContentLoaded; diagnostics do not wait', async () => {
  let releaseScript: (() => void) | undefined;
  const f = await fixture((request, response) => {
    if (request.url === '/slow.js') { releaseScript = () => { if (response.writableEnded || response.destroyed) return;
      response.setHeader('content-type', 'text/javascript'); response.end('window.loaded = true'); }; return; }
    response.setHeader('content-type', 'text/html');
    response.end('<script src="/slow.js"></script><select><option>Private Option</option></select>');
  });
  try {
    await f.page.goto(`${f.base}/dropdown`, { waitUntil: 'commit' });
    const loading = await f.boundary('before_candidate_query');
    expect(loading).toMatchObject({ documentReadyState: 'loading', domContentLoadedObserved: false,
      loadObserved: false, navigationCommitted: true, mainResponseStatusClass: '2xx' });
    releaseScript?.();
    await f.page.waitForLoadState('load');
    expect((await f.boundary('before_candidate_query')).documentReadyState).toBe('complete');
  } finally { releaseScript?.(); await f.close(); }
});

test('committed DCL wait skips an uncommitted page and an already-ready generation', async () => {
  const f = await fixture((_request, response) => { response.setHeader('content-type', 'text/html');
    response.end('<select></select>'); });
  const readiness = new CommittedDocumentReadiness(f.session);
  try {
    const noCommit = await readiness.wait(f.page, 5000);
    expect(noCommit).toMatchObject({ waitRequired: false, domContentLoadedReached: false });
    await f.page.goto(`${f.base}/dropdown`, { waitUntil: 'domcontentloaded' });
    const reached = await readiness.wait(f.page, 5000);
    expect(reached).toMatchObject({ waitRequired: false, domContentLoadedReached: true });
    expect(reached.generationId).toMatch(/^document-/);
  } finally { readiness.dispose(); await f.close(); }
});

test('committed DCL wait holds one generation until a blocking script finishes', async () => {
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
    expect(await f.page.locator('select').count()).toBe(1);
  } finally { releaseScript?.(); readiness.dispose(); await f.close(); }
});

test('committed DCL wait stops on timeout and same-page document replacement', async () => {
  const slow = new Set<http.ServerResponse>();
  const f = await fixture((request, response) => {
    if (request.url === '/slow.js') { slow.add(response); return; }
    response.setHeader('content-type', 'text/html');
    response.end(request.url === '/ready' ? '<select></select>' : '<script src="/slow.js"></script><select></select>');
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
    expect(observed).toMatchObject({
      waitRequired: false, domContentLoadedReached: true });
    readiness.assertCurrentGeneration(f.page, observed);
    await f.page.goto(`${f.base}/ready`, { waitUntil: 'domcontentloaded' });
    expect(() => readiness.assertCurrentGeneration(f.page, observed)).toThrow(
      expect.objectContaining({ reason: 'DOCUMENT_REPLACED' }));
  } finally {
    for (const response of slow) if (!response.writableEnded && !response.destroyed) response.end('');
    readiness.dispose(); await f.close();
  }
});

test('committed DCL wait stops if its owned page closes', async () => {
  const f = await fixture((_request, response) => { response.setHeader('content-type', 'text/html');
    response.end('<script src="/slow.js"></script><select></select>'); });
  const readiness = new CommittedDocumentReadiness(f.session);
  try {
    await f.page.goto(`${f.base}/loading`, { waitUntil: 'commit' });
    const pending = readiness.wait(f.page, 5000);
    const rejection = expect(pending).rejects.toMatchObject({ reason: 'PAGE_CLOSED' });
    await f.page.close();
    await rejection;
    await expect(readiness.waitForCurrentPage(5, () => { throw new Error('diagnostic sink failed'); }))
      .rejects.toMatchObject({ reason: 'PAGE_NOT_OWNED' });
  } finally { readiness.dispose(); await f.close(); }
});

for (const closing of ['context', 'browser'] as const)
  test(`committed DCL wait stops when its ${closing} closes`, async () => {
    const slow = new Set<http.ServerResponse>();
    const f = await fixture((request, response) => {
      if (request.url === '/slow.js') { slow.add(response); return; }
      response.setHeader('content-type', 'text/html');
      response.end('<script src="/slow.js"></script><select></select>');
    });
    const readiness = new CommittedDocumentReadiness(f.session);
    try {
      await f.page.goto(`${f.base}/loading`, { waitUntil: 'commit' });
      const pending = readiness.wait(f.page, 5000);
      const rejection = expect(pending).rejects.toMatchObject({ reason: closing === 'context' ?
        'CONTEXT_CLOSED' : 'PAGE_CLOSED' });
      if (closing === 'context') await f.session.close();
      else await f.session.context.browser()?.close();
      await rejection;
    } finally {
      for (const response of slow) if (!response.writableEnded && !response.destroyed) response.end('');
      readiness.dispose(); await f.close();
    }
  });

test('DOMContentLoaded may precede control insertion without changing enumeration policy', async () => {
  const f = await fixture((_request, response) => { response.setHeader('content-type', 'text/html');
    response.end('<script>window.insertControl=()=>document.body.appendChild(document.createElement("select"))</script>'); });
  try {
    await f.page.goto(`${f.base}/dropdown`);
    const first = await f.boundary('before_candidate_query');
    expect(first.domContentLoadedObserved).toBe(true);
    expect(await f.page.locator('select').count()).toBe(0);
    await f.page.evaluate(() => (globalThis as unknown as { insertControl(): void }).insertControl());
    const second = await f.boundary('before_candidate_query');
    expect(second.documentGenerationId).toBe(first.documentGenerationId);
    expect(second.domContentLoadedObserved).toBe(true);
    expect(await f.page.locator('select').count()).toBe(1);
  } finally { await f.close(); }
});

for (const code of [200, 404, 503]) test(`${code} main response is classified without changing an absent control`, async () => {
  const f = await fixture((_request, response) => { response.statusCode = code;
    response.setHeader('content-type', 'text/html'); response.end('<main>Private page</main>'); });
  try {
    await f.page.goto(`${f.base}/dropdown`);
    const read = await f.boundary('before_candidate_query');
    expect(read.mainResponseStatusClass).toBe(code === 200 ? '2xx' : code === 404 ? '4xx' : '5xx');
    expect(read.navigationCommitted).toBe(true);
    expect(read.domContentLoadedObserved).toBe(true);
    expect(f.diagnostics.snapshot().some(event => event.operation === 'main_document_response' &&
      event.documentGenerationId === read.documentGenerationId &&
      event.mainResponseStatusClass === read.mainResponseStatusClass)).toBe(true);
    expect(await f.page.locator('select').count()).toBe(0);
    expect(await f.page.getByRole('combobox').count()).toBe(0);
    expect(JSON.stringify(f.diagnostics.snapshot())).not.toContain('Private page');
  } finally { await f.close(); }
});

test('redirect count and final response apply to committed destination', async () => {
  const f = await fixture((request, response) => {
    if (request.url === '/start') { response.writeHead(302, { location: '/dropdown' }); response.end(); return; }
    response.setHeader('content-type', 'text/html'); response.end('<select></select>');
  });
  try {
    await f.page.goto(`${f.base}/start`);
    const read = await f.boundary('url_observation');
    expect(read).toMatchObject({ redirectCount: 1, mainResponseStatusClass: '2xx',
      navigationCommitted: true, currentUrl: `${f.base}/dropdown` });
    expect(f.diagnostics.snapshot().some(event => event.operation === 'main_document_navigation' &&
      event.outcome === 'started' && event.redirectCount === 1 &&
      event.documentGenerationId === read.documentGenerationId)).toBe(true);
  } finally { await f.close(); }
});

test('same URL can replace the document between observation and candidate query', async () => {
  const f = await fixture((_request, response) => { response.setHeader('content-type', 'text/html');
    response.end('<select></select>'); });
  try {
    await f.page.goto(`${f.base}/dropdown`);
    const observed = await f.boundary('url_observation');
    await f.page.reload();
    const queried = await f.boundary('before_candidate_query');
    expect(queried.currentUrl).toBe(observed.currentUrl);
    expect(queried.documentGenerationId).not.toBe(observed.documentGenerationId);
    expect(queried.documentReplacedSinceUrlObservation).toBe(true);
  } finally { await f.close(); }
});

test('replacement of the owned page is also reported as a changed document', async () => {
  const f = await fixture((_request, response) => { response.setHeader('content-type', 'text/html');
    response.end('<select></select>'); });
  try {
    await f.page.goto(`${f.base}/dropdown`);
    const observed = await f.boundary('url_observation');
    await f.page.close();
    const replacement = await f.session.context.newPage();
    await replacement.goto(`${f.base}/dropdown`);
    const queried = await f.boundary('before_candidate_query');
    expect(queried.currentUrl).toBe(observed.currentUrl);
    expect(queried.pageId).not.toBe(observed.pageId);
    expect(queried.documentReplacedSinceUrlObservation).toBe(true);
  } finally { await f.close(); }
});

test('main navigation failure is closed and browser outcome is unchanged', async () => {
  const f = await fixture((request, response) => {
    if (request.url === '/broken') { response.destroy(); return; }
    response.setHeader('content-type', 'text/html'); response.end('<select></select>');
  });
  try {
    await f.page.goto(`${f.base}/ready`);
    const prior = await f.boundary('url_observation');
    await expect(f.page.goto(`${f.base}/broken`)).rejects.toThrow();
    const failed = await f.boundary('before_candidate_query');
    expect(failed.navigationFailed).toBe(true);
    expect(failed.navigationFailureCategory).toMatch(/^(ABORTED|NETWORK|TIMEOUT|OTHER|UNKNOWN)$/);
    expect(failed.documentGenerationId).toBe(prior.documentGenerationId);
    expect(f.diagnostics.snapshot().some(event => event.operation === 'main_document_navigation' &&
      event.outcome === 'failure' && event.navigationFailed)).toBe(true);
    expect(JSON.stringify(f.diagnostics.snapshot())).not.toContain('ERR_');
  } finally { await f.close(); }
});

test('failed root followed by an error-document style replacement gets a new generation without altering goto failure', async () => {
  const f = await fixture((request, response) => {
    if (request.url === '/broken') { response.destroy(); return; }
    response.setHeader('content-type', 'text/html'); response.end('<main>Private page</main>');
  });
  try {
    await expect(f.page.goto(`${f.base}/broken`)).rejects.toThrow();
    const failure = f.diagnostics.snapshot().find(event => event.operation === 'main_document_navigation' &&
      event.outcome === 'failure');
    expect(failure?.navigationFailed).toBe(true);
    // Let Chromium's error document commit before a recovery navigation; this is a
    // test-side event assertion, not a production wait or changed navigation policy.
    await expect.poll(() => f.page.url()).toContain('chrome-error:');
    const browserError = await f.boundary('before_candidate_query');
    expect(browserError.currentUrl).toBe('chrome-error:');
    await f.page.goto(`${f.base}/recovery`);
    const query = await f.boundary('before_candidate_query');
    expect(query.documentGenerationId).not.toBe(failure?.documentGenerationId);
    expect(query).toMatchObject({ navigationCommitted: true, mainResponseStatusClass: '2xx',
      domContentLoadedObserved: true, loadObserved: true });
    expect(JSON.stringify(f.diagnostics.snapshot())).not.toContain('Private page');
  } finally { await f.close(); }
});
