import { lookup } from 'node:dns/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { parseTrustedLocalConfiguration } from '../app/local/contracts.js';
import { COLUMBIA_SAMPLE_URL, ProtectedContextFactory, ProfileCatalog, publicTargetGate } from '../app/profile/index.js';

const profileReference = { id: 'columbia-public-headless', version: '2' };
const trustedConfigurationPath = 'config/public-columbia-cloudflare-diagnostic.json';
const linkName = 'Frank da Cruz';
const expectedHref = 'https://www.columbia.edu/~fdc/';

type NavigationObservation = Readonly<{
  requestedUrl: string;
  finalUrl?: string;
  status?: number;
  outcome: 'response' | 'navigation_error' | 'not_attempted';
  errorKind?: string;
}>;

function trustedConfiguration(): ReturnType<typeof parseTrustedLocalConfiguration> {
  return parseTrustedLocalConfiguration(JSON.parse(readFileSync(trustedConfigurationPath, 'utf8')) as unknown);
}

/** Survey evidence must not retain Cloudflare's per-request challenge token. */
function safeUrl(urlText: string): string {
  const url = new URL(urlText);
  url.searchParams.delete('__cf_chl_rt_tk');
  return url.toString();
}

function errorKind(error: unknown): string {
  if (!(error instanceof Error)) return 'UNKNOWN';
  if (/NETWORK_POLICY_DENIED|Destination denied|Destination address denied/i.test(error.message)) return 'NETWORK_POLICY_DENIED';
  if (/ERR_TUNNEL_CONNECTION_FAILED/i.test(error.message)) return 'PROXY_TUNNEL_FAILED';
  if (/Timeout|timed out/i.test(error.message)) return 'TIMEOUT';
  return 'NAVIGATION_ERROR';
}

function responseObservation(requestedUrl: string, finalUrl: string, status: number | undefined): NavigationObservation {
  return { requestedUrl: safeUrl(requestedUrl), finalUrl: safeUrl(finalUrl), outcome: 'response', ...(status === undefined ? {} : { status }) };
}

function challengeState(status: number | undefined, title: string, text: string): 'none_observed' | 'http_403' | 'challenge_or_access_denied' | 'unknown' {
  const combined = `${title}\n${text}`.toLowerCase();
  if (/cloudflare|challenge|access denied/.test(combined)) return 'challenge_or_access_denied';
  if (status === 403) return 'http_403';
  if (status === undefined) return 'unknown';
  return 'none_observed';
}

/**
 * Work package B survey only. It does not call a model, invoke MCP, assert the
 * acceptance claim, or widen the reviewed public policy. Set the opt-in flag
 * only on the developer machine with the reviewed Docker G1 boundary available.
 */
test('protected Columbia survey records current accessible page and link behavior', async () => {
  test.skip(process.env.PUBLIC_BROWSER_G1_RUNTIME !== '1', 'Manual protected public-browser survey');
  test.setTimeout(120_000);

  const configuration = trustedConfiguration();
  const catalog = new ProfileCatalog(configuration.profiles, configuration.networkPolicies);
  const effective = catalog.resolve(profileReference);
  const factory = new ProtectedContextFactory(catalog, undefined, publicTargetGate(configuration.publicTargetApproval!));
  const requests = new Map<string, { resourceTypes: Set<string>; responses: Set<number>; failures: Set<string> }>();
  const session = await factory.open(profileReference, effective);

  const trackRequest = (urlText: string, resourceType: string): void => {
    const url = new URL(urlText);
    const key = `${url.protocol}//${url.host}`;
    const current = requests.get(key) ?? { resourceTypes: new Set<string>(), responses: new Set<number>(), failures: new Set<string>() };
    current.resourceTypes.add(resourceType);
    requests.set(key, current);
  };
  session.context.on('request', (request) => trackRequest(request.url(), request.resourceType()));
  session.context.on('response', (response) => {
    const url = new URL(response.url());
    requests.get(`${url.protocol}//${url.host}`)?.responses.add(response.status());
  });
  session.context.on('requestfailed', (request) => {
    const url = new URL(request.url());
    requests.get(`${url.protocol}//${url.host}`)?.failures.add(request.failure()?.errorText ?? 'unknown');
  });

  let main: NavigationObservation = { requestedUrl: COLUMBIA_SAMPLE_URL, outcome: 'not_attempted' };
  let linkCount = 0;
  let hrefs: string[] = [];
  let destinationNavigations: NavigationObservation[] = [];
  let title = '';
  let pageText = '';
  try {
    const page = await session.context.newPage();
    try {
      const response = await page.goto(COLUMBIA_SAMPLE_URL, { waitUntil: 'domcontentloaded' });
      main = responseObservation(COLUMBIA_SAMPLE_URL, page.url(), response?.status());
      title = await page.title();
      pageText = (await page.locator('body').innerText().catch(() => '')).slice(0, 4096);
      const links = page.getByRole('link', { name: linkName, exact: true });
      linkCount = await links.count();
      hrefs = await links.evaluateAll((elements) => elements.map((element) => element instanceof HTMLAnchorElement ? element.href : ''));
      for (const href of hrefs) {
        const destination = new URL(href);
        if (destination.origin !== 'https://www.columbia.edu') {
          destinationNavigations.push({ requestedUrl: safeUrl(href), outcome: 'not_attempted', errorKind: 'DESTINATION_OUTSIDE_APPROVED_POLICY' });
          continue;
        }
        const destinationPage = await session.context.newPage();
        try {
          const response = await destinationPage.goto(href, { waitUntil: 'domcontentloaded' });
          destinationNavigations.push(responseObservation(href, destinationPage.url(), response?.status()));
        } catch (error) {
          destinationNavigations.push({ requestedUrl: safeUrl(href), outcome: 'navigation_error', errorKind: errorKind(error) });
        } finally {
          await destinationPage.close();
        }
      }
    } catch (error) {
      main = { requestedUrl: safeUrl(COLUMBIA_SAMPLE_URL), outcome: 'navigation_error', errorKind: errorKind(error) };
    }
  } finally {
    await session.close();
  }

  const dnsAnswers = await lookup('www.columbia.edu', { all: true, verbatim: true })
    .then((answers) => answers.map((answer) => answer.address).sort())
    .catch(() => [] as string[]);
  const observedTraffic = [...requests.entries()].map(([origin, observation]) => ({
    origin,
    resourceTypes: [...observation.resourceTypes].sort(),
    responseStatuses: [...observation.responses].sort((a, b) => a - b),
    failureKinds: [...observation.failures].sort(),
  })).sort((left, right) => left.origin.localeCompare(right.origin));
  const safeEvidence = {
    kind: 'public_web_protected_survey_v2',
    observedAt: new Date().toISOString(),
    profile: profileReference,
    profileFingerprint: effective.fingerprint,
    policy: { id: effective.policy.id, version: effective.policy.version, destinations: effective.policy.destinations },
    main,
    challengeOrAccessState: challengeState(main.status, title, pageText),
    linkObservation: { accessibleName: linkName, count: linkCount, resolvedHrefs: hrefs, expectedHref },
    destinationNavigations,
    dnsAnswers,
    observedTraffic,
    acceptanceClaimEvaluable: main.outcome === 'response' && linkCount === 2,
  };
  const directory = path.join('jobs', 'public-columbia', 'surveys');
  await mkdir(directory, { recursive: true });
  const evidencePath = path.join(directory, `${safeEvidence.observedAt.replaceAll(/[:.]/g, '-')}.json`);
  await writeFile(evidencePath, `${JSON.stringify(safeEvidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(`PUBLIC_WEB_SURVEY_SAFE_EVIDENCE=${JSON.stringify(safeEvidence)}`);
  console.log(`PUBLIC_WEB_SURVEY_EVIDENCE_PATH=${evidencePath}`);
  expect(effective.fingerprint).toBe(configuration.publicTargetApproval?.profileFingerprint);
});
