/** Six fresh local-Windows sessions; only production frame-stream viewing differs. */
if (process.env.PLAYWRIGHT_DEMO_FRAME_AB !== '1') {
  throw new Error('Set PLAYWRIGHT_DEMO_FRAME_AB=1 to run this protected experiment');
}

const net = await import('node:net');
const { randomBytes, randomUUID } = await import('node:crypto');
const { loadProjectEnv } = await import('../dist/local/project-env.js');
loadProjectEnv();
const { readSubprocessTrustedConfiguration } = await import('../dist/subprocess/entry.js');
const { selectActivePocBrowserProfile } = await import('../dist/local/contracts.js');
const { ProfileCatalog, ProtectedContextFactory } = await import('../dist/profile/index.js');
const { DeferredViewerLifecycle } = await import('../dist/observability/deferred-viewer-channel.js');

const root = 'https://the-internet.herokuapp.com/';
const destination = 'https://the-internet.herokuapp.com/dropdown';
const configPath = process.env.PLAYWRIGHT_DEMO_TRUSTED_CONFIG;
if (!configPath) throw new Error('Trusted configuration path required');
const trusted = await readSubprocessTrustedConfiguration(configPath, 'active-poc');
if (trusted.publicTargetApproval?.targetUrl !== root) throw new Error('Root approval mismatch');
const selected = selectActivePocBrowserProfile(trusted, 'local-windows');
const catalog = new ProfileCatalog(selected.config.profiles, selected.config.networkPolicies);
const effective = catalog.resolve(selected.reference);
if (effective.fingerprint !== selected.fingerprint ||
    effective.profile.browserIsolation !== 'local-windows' ||
    effective.profile.timeoutPolicy.navigationMs !== 90_000) throw new Error('Local profile mismatch');
process.env.PLAYWRIGHT_DEMO_BROWSER_BACKEND = 'local-windows';
const factory = new ProtectedContextFactory(catalog, undefined, undefined, { viewOnlyHeaded: false });
const order = ['OFF', 'ON', 'ON', 'OFF', 'OFF', 'ON'];

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? `${url.origin}${url.pathname}` : url.protocol;
  } catch { return 'unavailable'; }
}
function safeFailure(error) {
  const message = error instanceof Error ? error.message : '';
  if (/timeout/i.test(message)) return 'TIMEOUT';
  if (/ERR_NAME_NOT_RESOLVED|ERR_DNS/i.test(message)) return 'DNS';
  if (/ERR_CERT|ERR_SSL|ERR_TLS/i.test(message)) return 'TLS';
  if (/ERR_CONNECTION|ERR_PROXY|ERR_TUNNEL/i.test(message)) return 'CONNECTION';
  if (/Target closed|Browser closed|crash/i.test(message)) return 'BROWSER_CLOSED';
  return 'OTHER_BROWSER_FAILURE';
}
function overlaps(event, interval) {
  return !!interval && event.startedAtMs <= interval.end && event.endedAtMs >= interval.start;
}

/** A loopback protocol sink: authenticate the lifecycle, count notices, discard pixels. */
async function openDiscardSink() {
  const streamId = randomUUID(), capability = randomBytes(32).toString('hex');
  const counts = { ready: 0, frame: 0, unavailable: 0, closed: 0, other: 0 };
  const sockets = new Set();
  let wireFailure = null;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => { wireFailure ??= 'SOCKET'; });
    let pending = '', greeted = false;
    socket.on('data', bytes => {
      pending += bytes.toString('utf8');
      if (pending.length > 400_000) { wireFailure = 'FRAME_BOUND'; socket.destroy(); return; }
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (!greeted) {
            if (message.deferredViewerVersion !== '1' || message.kind !== 'hello' ||
                message.streamId !== streamId || message.capability !== capability)
              throw new Error('HANDSHAKE');
            greeted = true;
            socket.write(JSON.stringify({ deferredViewerVersion: '1', kind: 'ready', streamId }) + '\n');
          } else {
            // The frame's base64 string exists only for this parse and is never retained.
            if (Object.hasOwn(counts, message.kind)) counts[message.kind]++;
            else counts.other++;
          }
        } catch { wireFailure = 'PROTOCOL'; socket.destroy(); return; }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback sink unavailable');
  process.env.PLAYWRIGHT_DEMO_DEFERRED_VIEWER_PORT = String(address.port);
  process.env.PLAYWRIGHT_DEMO_DEFERRED_VIEWER_STREAM_ID = streamId;
  process.env.PLAYWRIGHT_DEMO_DEFERRED_VIEWER_CAPABILITY = capability;
  return { counts, get wireFailure() { return wireFailure; }, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}

async function sample(page, kind) {
  const result = {
    finalUrl: safeUrl(page.url()), readyState: null, anchorCount: null,
    linkRoleCount: null, dropdownCount: null, nativeSelectCount: null,
    comboboxRoleCount: null, listboxRoleCount: null, sampleFailure: null,
  };
  if (page.isClosed()) { result.sampleFailure = 'PAGE_CLOSED'; return result; }
  try {
    const dom = await page.evaluate(() => ({ readyState: document.readyState,
      anchors: document.querySelectorAll('a').length,
      selects: document.querySelectorAll('select').length }));
    result.readyState = dom.readyState;
    result.anchorCount = dom.anchors;
    result.nativeSelectCount = dom.selects;
    if (kind === 'root') {
      result.linkRoleCount = await page.getByRole('link').count();
      result.dropdownCount = await page.getByRole('link', { name: 'Dropdown', exact: true }).count();
    } else {
      result.comboboxRoleCount = await page.getByRole('combobox').count();
      result.listboxRoleCount = await page.getByRole('listbox').count();
    }
  } catch (error) { result.sampleFailure = safeFailure(error); }
  result.finalUrl = safeUrl(page.url());
  return result;
}

async function runOne(mode, sequence) {
  const row = { sequence, mode, playwrightVersion: null, browserVersion: null,
    root: null, click: null, destination: null,
    capture: { attempts: 0, success: 0, failure: 0, skipped: 0,
      timeouts: 0, detachStarted: 0, detachSuccess: 0, detachFailure: 0,
      firstFrame: false, overlapRoot: 0, overlapRootSample: 0, overlapClick: 0,
      overlapDestinationSample: 0, overlapClickToDestinationSample: 0,
      reasons: {}, notices: null, wireFailure: null },
    openFailure: null, cleanup: 'not_started' };
  const events = [];
  const diagnostic = event => {
    if (events.length < 512 && event.source === 'viewer') events.push({
      operation: event.operation, outcome: event.outcome, startedAtMs: event.startedAtMs,
      endedAtMs: event.endedAtMs, internalReason: event.internalReason ?? null,
    });
  };
  let sink, viewer, session;
  const ownerId = `frame-ab-${sequence}`;
  const navResponses = [];
  let dclCount = 0, loadCount = 0, mainNavCount = 0;
  let rootInterval, rootSampleInterval, clickInterval, destinationSampleInterval;
  try {
    if (mode === 'ON') {
      sink = await openDiscardSink();
      viewer = await DeferredViewerLifecycle.connect('frame-ab-test', 'frame_stream', diagnostic);
    }
    session = await factory.open(selected.reference, effective, { observationOwner: { kind: 'attempt', id: ownerId } });
    row.playwrightVersion = session.versions.playwright;
    row.browserVersion = session.versions.browser;
    if (viewer) await viewer.open(session, 'exploration', ownerId);
    const page = await session.context.newPage();
    page.on('domcontentloaded', () => { dclCount++; });
    page.on('load', () => { loadCount++; });
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) mainNavCount++; });
    page.on('response', response => {
      try {
        const request = response.request();
        if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
        if (navResponses.length < 8) navResponses.push({ url: safeUrl(response.url()), status: response.status(),
          redirects: (() => { let count = 0, prior = request; while ((prior = prior.redirectedFrom())) count++; return count; })() });
      } catch { /* Only main-document responses are counted. */ }
    });
    const rootStart = performance.now();
    row.root = { startUtc: new Date().toISOString(), navigationMs: null, navigationSucceeded: false,
      failureCategory: null, responseReceived: false, httpStatus: null, statusClass: null,
      redirects: null, dclAtReturn: false, loadAtReturn: false, mainNavAtReturn: 0, inventory: null };
    try { await page.goto(root, { waitUntil: 'domcontentloaded', timeout: effective.profile.timeoutPolicy.navigationMs });
      row.root.navigationSucceeded = true; }
    catch (error) { row.root.failureCategory = safeFailure(error); }
    const rootEnd = performance.now(); rootInterval = { start: rootStart, end: rootEnd };
    row.root.navigationMs = Math.round(rootEnd - rootStart);
    row.root.dclAtReturn = dclCount > 0; row.root.loadAtReturn = loadCount > 0;
    row.root.mainNavAtReturn = mainNavCount;
    const rootResponse = navResponses.findLast(item => item.url === root);
    if (rootResponse) {
      row.root.responseReceived = true; row.root.httpStatus = rootResponse.status;
      row.root.statusClass = `${Math.floor(rootResponse.status / 100)}xx`;
      row.root.redirects = rootResponse.redirects;
    }
    const rootSampleStart = performance.now();
    row.root.inventory = await sample(page, 'root');
    rootSampleInterval = { start: rootSampleStart, end: performance.now() };
    row.root.sampleMs = Math.round(rootSampleInterval.end - rootSampleStart);
    if (row.root.inventory.dropdownCount === 1) {
      const clickStart = performance.now();
      row.click = { elapsedMs: null, succeeded: false, failureCategory: null,
        dclAtReturn: false, loadAtReturn: false, mainNavAtReturn: null };
      const beforeDcl = dclCount, beforeLoad = loadCount;
      try { await page.getByRole('link', { name: 'Dropdown', exact: true })
        .click({ timeout: effective.profile.timeoutPolicy.actionMs }); row.click.succeeded = true; }
      catch (error) { row.click.failureCategory = safeFailure(error); }
      const clickEnd = performance.now(); clickInterval = { start: clickStart, end: clickEnd };
      row.click.elapsedMs = Math.round(clickEnd - clickStart);
      row.click.dclAtReturn = dclCount > beforeDcl;
      row.click.loadAtReturn = loadCount > beforeLoad;
      row.click.mainNavAtReturn = mainNavCount;
      const destinationSampleStart = performance.now();
      row.destination = { responseReceived: false, httpStatus: null, statusClass: null,
        redirects: null, inventory: await sample(page, 'destination') };
      destinationSampleInterval = { start: destinationSampleStart, end: performance.now() };
      row.destination.sampleMs = Math.round(destinationSampleInterval.end - destinationSampleStart);
      const destinationResponse = navResponses.findLast(item => item.url === destination);
      if (destinationResponse) {
        row.destination.responseReceived = true;
        row.destination.httpStatus = destinationResponse.status;
        row.destination.statusClass = `${Math.floor(destinationResponse.status / 100)}xx`;
        row.destination.redirects = destinationResponse.redirects;
      }
    }
  } catch (error) { row.openFailure = safeFailure(error); }
  finally {
    if (session) {
      try { await session.close(); row.cleanup = 'verified'; }
      catch { row.cleanup = 'unverified'; }
    }
    viewer?.close();
    if (sink) {
      row.capture.notices = { ...sink.counts };
      row.capture.wireFailure = sink.wireFailure;
      await sink.close();
    }
  }
  for (const event of events) {
    if (event.operation === 'capture') {
      row.capture.attempts++;
      if (event.outcome === 'success') row.capture.success++;
      else if (event.outcome === 'failure') row.capture.failure++;
      else if (event.outcome === 'skipped') row.capture.skipped++;
      // A skipped attempt never enters CDP capture; count only real captures
      // when correlating potential protocol contention with browser work.
      if (event.outcome === 'success' || event.outcome === 'failure') {
        if (overlaps(event, rootInterval)) row.capture.overlapRoot++;
        if (overlaps(event, rootSampleInterval)) row.capture.overlapRootSample++;
        if (overlaps(event, clickInterval)) row.capture.overlapClick++;
        if (overlaps(event, destinationSampleInterval)) row.capture.overlapDestinationSample++;
        if (clickInterval && destinationSampleInterval && overlaps(event,
          { start: clickInterval.start, end: destinationSampleInterval.end }))
          row.capture.overlapClickToDestinationSample++;
      }
      if (event.internalReason) row.capture.reasons[event.internalReason] =
        (row.capture.reasons[event.internalReason] ?? 0) + 1;
    } else if (event.operation === 'capture_timeout') row.capture.timeouts++;
    else if (event.operation === 'capture_detach') {
      if (event.outcome === 'started') row.capture.detachStarted++;
      else if (event.outcome === 'success') row.capture.detachSuccess++;
      else if (event.outcome === 'failure') row.capture.detachFailure++;
    } else if (event.operation === 'first_frame' && event.outcome === 'success') row.capture.firstFrame = true;
  }
  row.capture.eventLimitReached = events.length === 512;
  return row;
}

for (const [index, mode] of order.entries()) {
  const row = await runOne(mode, index + 1);
  process.stdout.write(`${JSON.stringify(row)}\n`);
}
