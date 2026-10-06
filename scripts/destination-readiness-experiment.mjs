/** Bounded destination readiness probe; no workflow, provider, viewer, or retries. */
if (process.env.PLAYWRIGHT_DEMO_DESTINATION_READINESS !== '1') {
  throw new Error('Set PLAYWRIGHT_DEMO_DESTINATION_READINESS=1 to run this protected experiment');
}

const { randomUUID } = await import('node:crypto');
const { loadProjectEnv } = await import('../dist/local/project-env.js');
loadProjectEnv();
const { readSubprocessTrustedConfiguration } = await import('../dist/subprocess/entry.js');
const { selectActivePocBrowserProfile } = await import('../dist/local/contracts.js');
const { ProfileCatalog, ProtectedContextFactory } = await import('../dist/profile/index.js');

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
process.env.PLAYWRIGHT_DEMO_LIVE_VIEW = '0';
const factory = new ProtectedContextFactory(catalog, undefined, undefined, { viewOnlyHeaded: false });

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

async function runOne(sequence) {
  const row = { sequence, playwrightVersion: null, browserVersion: null,
    root: null, click: null, destination: null, openFailure: null, cleanup: 'not_started' };
  let session;
  try {
    session = await factory.open(selected.reference, effective);
    row.playwrightVersion = session.versions.playwright;
    row.browserVersion = session.versions.browser;
    const page = await session.context.newPage();
    // Navigation commits create opaque generation markers. Event listeners are
    // attached before root navigation; they do not read or alter page content.
    let currentGeneration = null, generationNumber = 0;
    const generations = new Map();
    const mainResponses = [];
    page.on('framenavigated', frame => {
      if (frame !== page.mainFrame()) return;
      currentGeneration = `generation-${++generationNumber}-${randomUUID()}`;
      generations.set(currentGeneration, { dcl: false, load: false });
    });
    page.on('domcontentloaded', () => {
      const state = generations.get(currentGeneration);
      if (state) state.dcl = true;
    });
    page.on('load', () => {
      const state = generations.get(currentGeneration);
      if (state) state.load = true;
    });
    page.on('response', response => {
      try {
        const request = response.request();
        if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
        if (mainResponses.length < 8) {
          let cursor = request, redirects = 0;
          while ((cursor = cursor.redirectedFrom())) redirects++;
          mainResponses.push({ url: safeUrl(response.url()), status: response.status(), redirects });
        }
      } catch { /* Only owned main-document responses count. */ }
    });
    const sample = async (referenceGeneration) => {
      const generationBefore = currentGeneration;
      const lifecycle = generations.get(generationBefore);
      const result = { generation: generationBefore,
        sameGeneration: generationBefore === referenceGeneration,
        dclObserved: lifecycle?.dcl ?? false, loadObserved: lifecycle?.load ?? false,
        finalUrl: safeUrl(page.url()), readyState: null, nativeSelectCount: null,
        comboboxRoleCount: null, sampleFailure: null, stableDuringSample: null };
      if (page.isClosed()) { result.sampleFailure = 'PAGE_CLOSED'; return result; }
      try {
        const dom = await page.evaluate(() => ({ readyState: document.readyState,
          selectCount: document.querySelectorAll('select').length }));
        result.readyState = dom.readyState;
        result.nativeSelectCount = dom.selectCount;
        result.comboboxRoleCount = await page.getByRole('combobox').count();
      } catch (error) { result.sampleFailure = safeFailure(error); }
      result.stableDuringSample = currentGeneration === generationBefore;
      result.finalUrl = safeUrl(page.url());
      return result;
    };

    const rootStart = performance.now();
    row.root = { navigationMs: null, navigationSucceeded: false, failureCategory: null,
      responseReceived: false, httpStatus: null, statusClass: null, redirects: null,
      finalUrl: null, readyState: null, dropdownCount: null, sampleFailure: null };
    try { await page.goto(root, { waitUntil: 'domcontentloaded',
      timeout: effective.profile.timeoutPolicy.navigationMs }); row.root.navigationSucceeded = true; }
    catch (error) { row.root.failureCategory = safeFailure(error); }
    row.root.navigationMs = Math.round(performance.now() - rootStart);
    row.root.finalUrl = safeUrl(page.url());
    const rootResponse = mainResponses.findLast(item => item.url === root);
    if (rootResponse) {
      row.root.responseReceived = true; row.root.httpStatus = rootResponse.status;
      row.root.statusClass = `${Math.floor(rootResponse.status / 100)}xx`;
      row.root.redirects = rootResponse.redirects;
    }
    if (!page.isClosed()) {
      try {
        row.root.readyState = await page.evaluate(() => document.readyState);
        row.root.dropdownCount = await page.getByRole('link', { name: 'Dropdown', exact: true }).count();
      } catch (error) { row.root.sampleFailure = safeFailure(error); }
    }
    if (!row.root.navigationSucceeded || row.root.statusClass !== '2xx' ||
        row.root.dropdownCount !== 1 || row.root.finalUrl !== root) return row;

    const responseOffset = mainResponses.length;
    const clickStart = performance.now();
    row.click = { elapsedMs: null, succeeded: false, failureCategory: null,
      returnUrl: null, returnGeneration: null };
    try { await page.getByRole('link', { name: 'Dropdown', exact: true })
      .click({ timeout: effective.profile.timeoutPolicy.actionMs }); row.click.succeeded = true; }
    catch (error) { row.click.failureCategory = safeFailure(error); }
    row.click.elapsedMs = Math.round(performance.now() - clickStart);
    row.click.returnUrl = safeUrl(page.url());
    row.click.returnGeneration = currentGeneration;
    const destinationResponse = mainResponses.slice(responseOffset)
      .find(item => item.url === destination);
    row.destination = { responseReceived: !!destinationResponse,
      httpStatus: destinationResponse?.status ?? null,
      statusClass: destinationResponse ? `${Math.floor(destinationResponse.status / 100)}xx` : null,
      redirects: destinationResponse?.redirects ?? null,
      immediate: null, domContentLoaded: null, load: null,
      replacementObserved: false, generationAtEnd: null };
    // The immediate sample deliberately has no readiness wait. Later waits use
    // Playwright's load-state API, which also resolves when an event fired before
    // the wait was registered.
    const immediateStart = performance.now();
    row.destination.immediate = await sample(row.click.returnGeneration);
    row.destination.immediate.sampleMs = Math.round(performance.now() - immediateStart);
    const referenceGeneration = row.destination.immediate.generation;
    const generationNumberAtImmediate = generationNumber;
    if (row.destination.immediate.finalUrl === destination) {
      for (const [field, state] of [['domContentLoaded', 'domcontentloaded'], ['load', 'load']]) {
        const started = performance.now();
        const boundary = { waitCompleted: false, waitFailure: null, waitMs: null, sample: null };
        row.destination[field] = boundary;
        try { await page.waitForLoadState(state, { timeout: effective.profile.timeoutPolicy.navigationMs });
          boundary.waitCompleted = true; }
        catch (error) { boundary.waitFailure = safeFailure(error); }
        boundary.waitMs = Math.round(performance.now() - started);
        if (boundary.waitCompleted) boundary.sample = await sample(referenceGeneration);
      }
    }
    const laterDestinationResponse = mainResponses.slice(responseOffset)
      .find(item => item.url === destination);
    if (laterDestinationResponse) {
      row.destination.responseReceived = true;
      row.destination.httpStatus = laterDestinationResponse.status;
      row.destination.statusClass = `${Math.floor(laterDestinationResponse.status / 100)}xx`;
      row.destination.redirects = laterDestinationResponse.redirects;
    }
    row.destination.generationAtEnd = currentGeneration;
    row.destination.replacementObserved = generationNumber > generationNumberAtImmediate ||
      row.destination.immediate.sameGeneration === false ||
      row.destination.immediate.stableDuringSample === false ||
      row.destination.domContentLoaded?.sample?.sameGeneration === false ||
      row.destination.load?.sample?.sameGeneration === false;
    return row;
  } catch (error) { row.openFailure = safeFailure(error); return row; }
  finally {
    if (session) {
      try { await session.close(); row.cleanup = 'verified'; }
      catch { row.cleanup = 'unverified'; }
    }
  }
}

for (let sequence = 1; sequence <= 6; sequence++) {
  process.stdout.write(`${JSON.stringify(await runOne(sequence))}\n`);
}
