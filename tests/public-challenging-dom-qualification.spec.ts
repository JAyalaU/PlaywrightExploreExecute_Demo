import { lookup } from 'node:dns/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { parseTrustedLocalConfiguration } from '../app/local/contracts.js';
import {
  ProtectedContextFactory, ProfileCatalog, type EffectiveProfile, type ExternalTargetGate,
} from '../app/profile/index.js';

const targetUrl = 'https://the-internet.herokuapp.com/challenging_dom';
const profileReference = { id: 'challenging-dom-qualification-headless', version: '1' };
const configurationPath = 'config/public-challenging-dom-qualification.json';
const reviewedAddresses = ['3.209.172.72', '23.22.130.173', '54.243.238.66', '107.22.57.98'];

type Traffic = { resourceTypes: Set<string>; responses: Set<number>; failures: Set<string> };

function trustedConfiguration(): ReturnType<typeof parseTrustedLocalConfiguration> {
  return parseTrustedLocalConfiguration(JSON.parse(readFileSync(configurationPath, 'utf8')) as unknown);
}

/** Survey-only gate: this candidate is not a production target approval. */
function qualificationGate(expected: EffectiveProfile): ExternalTargetGate {
  return {
    authorize: async (effective) => {
      const rule = effective.policy.destinations[0];
      if (effective.fingerprint !== expected.fingerprint ||
          effective.profile.id !== profileReference.id || effective.profile.version !== profileReference.version ||
          effective.policy.id !== 'challenging-dom-qualification-egress' || effective.policy.version !== '1' ||
          effective.policy.destinations.length !== 1 || rule?.host !== 'the-internet.herokuapp.com' ||
          rule.ports.length !== 1 || rule.ports[0] !== 443 ||
          rule.addresses.length !== reviewedAddresses.length ||
          !reviewedAddresses.every((address) => rule.addresses.includes(address))) {
        throw new Error('Candidate survey target approval does not match its reviewed profile and policy');
      }
    },
  };
}

function safeUrl(value: string): string {
  const url = new URL(value);
  // Do not retain query material from a public target in normal survey evidence.
  url.search = '';
  url.hash = '';
  return url.toString();
}

test('candidate qualification configuration is isolated, exact-pinned, and not a production approval', async () => {
  const configuration = trustedConfiguration();
  const effective = new ProfileCatalog(configuration.profiles, configuration.networkPolicies).resolve(profileReference);
  expect(configuration.publicTargetApproval).toBeUndefined();
  expect(effective.profile).toMatchObject({ profileSchemaVersion: '3', presentationMode: 'headless', browserIsolation: 'docker' });
  expect(effective.policy.destinations).toEqual([{
    host: 'the-internet.herokuapp.com', ports: [443], addresses: reviewedAddresses,
  }]);
  await expect(qualificationGate(effective).authorize(effective)).resolves.toBeUndefined();
});

/**
 * Candidate qualification only. It does not invoke a model or MCP, write a
 * ResolvedTestSpec, claim deterministic acceptance, or promote the target to
 * a production approval. Docker proof is intentionally opt-in.
 */
test('protected challenging-dom qualification records usability and scoped-target evidence', async () => {
  test.skip(process.env.PUBLIC_BROWSER_G1_RUNTIME !== '1', 'Manual isolated public-target qualification');
  test.setTimeout(120_000);

  const configuration = trustedConfiguration();
  const catalog = new ProfileCatalog(configuration.profiles, configuration.networkPolicies);
  const effective = catalog.resolve(profileReference);
  const factory = new ProtectedContextFactory(catalog, undefined, qualificationGate(effective));
  const traffic = new Map<string, Traffic>();
  const session = await factory.open(profileReference, effective);
  let main: { requestedUrl: string; finalUrl?: string; status?: number; errorKind?: string } = { requestedUrl: targetUrl };
  let title = '';
  let tableCount = 0;
  let bodyRowCount = 0;
  let editCount = 0;
  let deleteCount = 0;
  let rowSamples: string[] = [];
  try {
    session.context.on('request', (request) => {
      const url = new URL(request.url());
      const key = `${url.protocol}//${url.host}`;
      const observed = traffic.get(key) ?? { resourceTypes: new Set(), responses: new Set(), failures: new Set() };
      observed.resourceTypes.add(request.resourceType());
      traffic.set(key, observed);
    });
    session.context.on('response', (response) => {
      const url = new URL(response.url());
      traffic.get(`${url.protocol}//${url.host}`)?.responses.add(response.status());
    });
    session.context.on('requestfailed', (request) => {
      const url = new URL(request.url());
      traffic.get(`${url.protocol}//${url.host}`)?.failures.add(request.failure()?.errorText ?? 'unknown');
    });
    const page = await session.context.newPage();
    try {
      const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      main = {
        requestedUrl: targetUrl,
        finalUrl: safeUrl(page.url()),
        ...(response?.status() === undefined ? {} : { status: response.status() }),
      };
      title = await page.title();
      tableCount = await page.locator('table').count();
      const rows = page.locator('table tbody tr');
      bodyRowCount = await rows.count();
      editCount = await page.getByRole('link', { name: 'edit', exact: true }).count();
      deleteCount = await page.getByRole('link', { name: 'delete', exact: true }).count();
      rowSamples = await rows.evaluateAll((elements) => elements.slice(0, 3)
        .map((element) => (element.textContent ?? '').replaceAll(/\s+/g, ' ').trim()).filter(Boolean));
    } catch (error) {
      main = { requestedUrl: targetUrl, errorKind: error instanceof Error ? error.message.slice(0, 240) : 'UNKNOWN' };
    }
  } finally {
    await session.close();
  }

  const dnsAnswers = await lookup('the-internet.herokuapp.com', { all: true, verbatim: true })
    .then((answers) => answers.map((answer) => answer.address).sort())
    .catch(() => [] as string[]);
  const observedTraffic = [...traffic.entries()].map(([origin, observation]) => ({
    origin,
    resourceTypes: [...observation.resourceTypes].sort(),
    responseStatuses: [...observation.responses].sort((a, b) => a - b),
    failureKinds: [...observation.failures].sort(),
  })).sort((left, right) => left.origin.localeCompare(right.origin));
  const candidateSuitable = main.status !== undefined && main.status >= 200 && main.status < 400 &&
    tableCount >= 1 && bodyRowCount >= 2 && editCount >= 2 && deleteCount >= 2 && rowSamples.length >= 2;
  const evidence = {
    kind: 'public_target_qualification_survey_v1',
    observedAt: new Date().toISOString(),
    targetUrl,
    profile: profileReference,
    profileFingerprint: effective.fingerprint,
    policy: { id: effective.policy.id, version: effective.policy.version, destinations: effective.policy.destinations },
    main,
    title,
    tableObservation: { tableCount, bodyRowCount, editCount, deleteCount, rowSamples },
    dnsAnswers,
    observedTraffic,
    candidateSuitable,
  };
  const directory = path.join('jobs', 'public-target-qualification', 'surveys');
  await mkdir(directory, { recursive: true });
  const evidencePath = path.join(directory, `${evidence.observedAt.replaceAll(/[:.]/g, '-')}.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(`PUBLIC_WEB_REPLACEMENT_SURVEY_SAFE_EVIDENCE=${JSON.stringify(evidence)}`);
  console.log(`PUBLIC_WEB_REPLACEMENT_SURVEY_EVIDENCE_PATH=${evidencePath}`);
  expect('browserIsolation' in effective.profile && effective.profile.browserIsolation).toBe('docker');
});
