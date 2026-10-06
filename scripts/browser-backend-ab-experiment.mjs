/** One read-only root navigation per fresh protected session, alternating real backends. */
if (process.env.PLAYWRIGHT_DEMO_BROWSER_AB !== '1') {
  throw new Error('Set PLAYWRIGHT_DEMO_BROWSER_AB=1 to run the protected experiment');
}

const { loadProjectEnv } = await import('../dist/local/project-env.js');
loadProjectEnv();
const { readSubprocessTrustedConfiguration } = await import('../dist/subprocess/entry.js');
const { selectActivePocBrowserProfile } = await import('../dist/local/contracts.js');
const { ProfileCatalog, ProtectedContextFactory, profilePresentationMode } =
  await import('../dist/profile/index.js');

const root = 'https://the-internet.herokuapp.com/';
const configPath = process.env.PLAYWRIGHT_DEMO_TRUSTED_CONFIG;
if (!configPath) throw new Error('Trusted configuration path is required');
const trusted = await readSubprocessTrustedConfiguration(configPath, 'active-poc');
if (trusted.publicTargetApproval?.targetUrl !== root) {
  throw new Error('Trusted public approval does not match the experiment root');
}

const order = [
  'docker-isolated', 'local-windows', 'local-windows',
  'docker-isolated', 'docker-isolated', 'local-windows',
];
const navigationOptions = { waitUntil: 'domcontentloaded', timeout: 90_000 };

function safeUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? `${parsed.origin}${parsed.pathname}` : parsed.protocol;
  } catch { return 'unavailable'; }
}

function failureCategory(error) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : '';
  if (/timeout/i.test(message)) return 'TIMEOUT';
  if (/ERR_NAME_NOT_RESOLVED|ERR_DNS/i.test(message)) return 'DNS';
  if (/ERR_CERT|ERR_SSL|ERR_TLS/i.test(message)) return 'TLS';
  if (/ERR_CONNECTION|ERR_PROXY|ERR_TUNNEL/i.test(message)) return 'CONNECTION';
  if (/Target closed|Browser closed|crash/i.test(message)) return 'BROWSER_CLOSED';
  if (/Docker|container|isolated browser/i.test(message)) return 'DOCKER_LAUNCH';
  return 'OTHER_BROWSER_FAILURE';
}

async function runOne(backend, sequence) {
  // The factory reads this trusted process setting in its constructor. Sessions
  // are sequential, so no browser can observe the other arm's backend value.
  process.env.PLAYWRIGHT_DEMO_BROWSER_BACKEND = backend;
  const selected = selectActivePocBrowserProfile(trusted, backend);
  const catalog = new ProfileCatalog(selected.config.profiles, selected.config.networkPolicies);
  const effective = catalog.resolve(selected.reference);
  if (effective.fingerprint !== selected.fingerprint) throw new Error('Profile fingerprint drift');
  if (effective.profile.timeoutPolicy.navigationMs !== navigationOptions.timeout) {
    throw new Error('Active navigation ceiling changed');
  }
  const factory = new ProtectedContextFactory(catalog, undefined, undefined, { viewOnlyHeaded: false });
  const row = {
    sequence, backend, hostOs: process.platform,
    browserRuntimeOs: backend === 'docker-isolated' ? 'linux-container' : 'windows-host',
    profileSchema: effective.profile.profileSchemaVersion ?? 'legacy',
    physicalMode: null, playwrightVersion: null, browserVersion: null,
    navigationStartUtc: null, responseReceived: false, httpStatus: null,
    statusClass: null, finalUrl: null, redirectCount: null,
    navigationMs: null, navigationSucceeded: false, failureCategory: null,
    readyState: null, domContentLoadedOccurred: false, loadOccurred: false,
    anchorCount: null, linkRoleCount: null, dropdownCount: null,
    nativeSelectCount: null, mainFrameNavigationCount: 0,
    chromiumErrorDocument: null, cleanup: 'not_started',
  };
  let session;
  try {
    session = await factory.open(selected.reference, effective);
    row.playwrightVersion = session.versions.playwright;
    row.browserVersion = session.versions.browser;
    row.physicalMode = backend === 'docker-isolated'
      ? (session.isViewerHeaded ? 'headed' : 'headless')
      : profilePresentationMode(effective.profile);
    const page = await session.context.newPage();
    let domContentLoadedOccurred = false, loadOccurred = false;
    page.on('domcontentloaded', () => { domContentLoadedOccurred = true; });
    page.on('load', () => { loadOccurred = true; });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) row.mainFrameNavigationCount++;
    });
    page.on('response', (response) => {
      try {
        const request = response.request();
        if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
        row.responseReceived = true;
        row.httpStatus = response.status();
        row.statusClass = `${Math.floor(response.status() / 100)}xx`;
        let cursor = request, redirects = 0;
        while ((cursor = cursor.redirectedFrom())) redirects++;
        row.redirectCount = redirects;
      } catch { /* Only an owned main-document response counts. */ }
    });
    row.navigationStartUtc = new Date().toISOString();
    const start = performance.now();
    let response;
    try {
      response = await page.goto(root, navigationOptions);
      row.navigationSucceeded = true;
    } catch (error) { row.failureCategory = failureCategory(error); }
    row.navigationMs = Math.round(performance.now() - start);
    row.domContentLoadedOccurred = domContentLoadedOccurred;
    row.loadOccurred = loadOccurred;
    row.finalUrl = safeUrl(page.url());
    if (response && !row.responseReceived) {
      row.responseReceived = true;
      row.httpStatus = response.status();
      row.statusClass = `${Math.floor(response.status() / 100)}xx`;
      let request = response.request();
      let redirects = 0;
      while ((request = request.redirectedFrom())) redirects++;
      row.redirectCount = redirects;
    }
    // One immediate post-navigation sampling point, with no readiness wait,
    // retry, reload, screenshot, page text, or candidate inventory.
    if (!page.isClosed()) {
      try {
        const documentState = await page.evaluate(() => ({
          readyState: document.readyState,
          chromiumErrorDocument: document.documentURI.startsWith('chrome-error://'),
          anchorCount: document.querySelectorAll('a').length,
          nativeSelectCount: document.querySelectorAll('select').length,
        }));
        row.readyState = documentState.readyState;
        row.chromiumErrorDocument = documentState.chromiumErrorDocument;
        row.anchorCount = documentState.anchorCount;
        row.nativeSelectCount = documentState.nativeSelectCount;
        row.linkRoleCount = await page.getByRole('link').count();
        row.dropdownCount = await page.getByRole('link', { name: 'Dropdown', exact: true }).count();
      } catch (error) {
        row.failureCategory ??= failureCategory(error);
      }
    }
  } catch (error) { row.failureCategory ??= failureCategory(error); }
  finally {
    if (session) {
      try { await session.close(); row.cleanup = 'verified'; }
      catch { row.cleanup = 'unverified'; }
    }
  }
  return row;
}

const rows = [];
for (const [index, backend] of order.entries()) {
  rows.push(await runOne(backend, index + 1));
}
for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
if (rows.some((row) => row.cleanup !== 'verified' || !row.navigationSucceeded)) process.exitCode = 1;
