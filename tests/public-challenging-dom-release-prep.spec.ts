import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { parseTrustedLocalConfiguration } from '../app/local/contracts.js';
import {
  ProtectedContextFactory, ProfileCatalog, type EffectiveProfile, type ExternalTargetGate,
} from '../app/profile/index.js';

const targetUrl = 'https://the-internet.herokuapp.com/challenging_dom';
const expectedUrl = 'https://the-internet.herokuapp.com/challenging_dom#edit';
const rowText = 'Iuvaret1';
const profileReference = { id: 'challenging-dom-qualification-headless', version: '1' };
const configurationPath = 'config/public-challenging-dom-qualification.json';
const reviewedAddresses = ['3.209.172.72', '23.22.130.173', '54.243.238.66', '107.22.57.98'];

type Traffic = { resourceTypes: Set<string>; responses: Set<number>; failures: Set<string> };

function trustedConfiguration(): ReturnType<typeof parseTrustedLocalConfiguration> {
  return parseTrustedLocalConfiguration(JSON.parse(readFileSync(configurationPath, 'utf8')) as unknown);
}

/** This gate deliberately preserves the candidate's survey-only authority. */
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
        throw new Error('Replacement release preparation does not match its reviewed survey profile and policy');
      }
    },
  };
}

function safeUrl(value: string): string {
  const url = new URL(value);
  url.search = '';
  return url.toString();
}

/**
 * Release preparation only. This confirms the expected public-site interaction
 * before a separate production approval and real-model acceptance gate exist.
 */
test('protected challenging-dom release preparation confirms the scoped edit destination', async () => {
  test.skip(process.env.PUBLIC_BROWSER_G1_RUNTIME !== '1', 'Manual isolated replacement release preparation');
  test.setTimeout(120_000);

  const configuration = trustedConfiguration();
  const catalog = new ProfileCatalog(configuration.profiles, configuration.networkPolicies);
  const effective = catalog.resolve(profileReference);
  const factory = new ProtectedContextFactory(catalog, undefined, qualificationGate(effective));
  const traffic = new Map<string, Traffic>();
  const session = await factory.open(profileReference, effective);
  let main: { requestedUrl: string; finalUrl?: string; status?: number; errorKind?: string } = { requestedUrl: targetUrl };
  let targetRowCount = 0;
  let editCountInTargetRow = 0;
  let resolvedHref = '';
  let observedUrl = '';
  try {
    session.context.on('request', (request) => {
      const url = new URL(request.url());
      const key = `${url.protocol}//${url.host}`;
      const current = traffic.get(key) ?? { resourceTypes: new Set<string>(), responses: new Set<number>(), failures: new Set<string>() };
      current.resourceTypes.add(request.resourceType());
      traffic.set(key, current);
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
    const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    main = { requestedUrl: targetUrl, finalUrl: safeUrl(page.url()), ...(response ? { status: response.status() } : {}) };
    const targetRow = page.getByRole('row').filter({ hasText: rowText });
    targetRowCount = await targetRow.count();
    const edit = targetRow.getByRole('link', { name: 'edit', exact: true });
    editCountInTargetRow = await edit.count();
    if (targetRowCount === 1 && editCountInTargetRow === 1) {
      resolvedHref = await edit.evaluate((element) => element instanceof HTMLAnchorElement ? element.href : '');
      await edit.click();
      await page.waitForURL(/#edit$/, { timeout: 10_000 });
      observedUrl = safeUrl(page.url());
    }
  } catch (error) {
    main = { requestedUrl: targetUrl, errorKind: error instanceof Error ? error.message.slice(0, 240) : 'UNKNOWN' };
  } finally {
    await session.close();
  }

  const observedTraffic = [...traffic.entries()].map(([origin, observation]) => ({
    origin,
    resourceTypes: [...observation.resourceTypes].sort(),
    responseStatuses: [...observation.responses].sort((left, right) => left - right),
    failureKinds: [...observation.failures].sort(),
  })).sort((left, right) => left.origin.localeCompare(right.origin));
  const evidence = {
    kind: 'public_target_release_preparation_v1',
    observedAt: new Date().toISOString(),
    targetUrl,
    profile: profileReference,
    profileFingerprint: effective.fingerprint,
    policy: { id: effective.policy.id, version: effective.policy.version, destinations: effective.policy.destinations },
    main,
    scopedTarget: { rowText, targetRowCount, editCountInTargetRow, resolvedHref },
    interaction: { expectedUrl, observedUrl, expectedDestinationConfirmed: observedUrl === expectedUrl },
    observedTraffic,
  };
  const directory = path.join('jobs', 'public-target-qualification', 'release-preparation');
  await mkdir(directory, { recursive: true });
  const evidencePath = path.join(directory, `${evidence.observedAt.replaceAll(/[:.]/g, '-')}.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(`PUBLIC_WEB_REPLACEMENT_RELEASE_PREP_SAFE_EVIDENCE=${JSON.stringify(evidence)}`);
  console.log(`PUBLIC_WEB_REPLACEMENT_RELEASE_PREP_EVIDENCE_PATH=${evidencePath}`);

  expect(evidence.interaction.expectedDestinationConfirmed).toBe(true);
});
