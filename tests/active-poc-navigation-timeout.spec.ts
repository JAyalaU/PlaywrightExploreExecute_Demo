import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { parseActivePocTrustedConfiguration, parseTrustedLocalConfiguration,
  ACTIVE_POC_NAVIGATION_MS } from '../app/local/contracts.js';
import { readSubprocessTrustedConfiguration } from '../app/subprocess/entry.js';
import { ProfileCatalog, approveHeadedPublicInspection, approvePublicInspection,
  inspectPublicUrl, lookupAdmittedPublicTarget } from '../app/profile/index.js';

const configFile = new URL('../config/public-challenging-dom.json', import.meta.url);
const configPath = fileURLToPath(configFile);

test('active trusted loader migrates an existing config without changing its historical read', async () => {
  const stored = parseTrustedLocalConfiguration(JSON.parse(await readFile(configFile, 'utf8')) as unknown);
  const historical = parseTrustedLocalConfiguration(await readSubprocessTrustedConfiguration(configPath));
  const active = parseTrustedLocalConfiguration(await readSubprocessTrustedConfiguration(configPath, 'active-poc'));
  expect(stored.profiles[0]!.timeoutPolicy.navigationMs).toBe(30_000);
  expect(historical.profiles[0]!.timeoutPolicy.navigationMs).toBe(30_000);
  expect(active.profiles[0]!.timeoutPolicy.navigationMs).toBe(ACTIVE_POC_NAVIGATION_MS);
  expect(active.profiles[0]!.timeoutPolicy.actionMs).toBe(stored.profiles[0]!.timeoutPolicy.actionMs);
  expect(active.profiles[0]!.timeoutPolicy.waits).toEqual(stored.profiles[0]!.timeoutPolicy.waits);
  const ref = { id: active.profiles[0]!.id, version: active.profiles[0]!.version };
  expect(new ProfileCatalog(active.profiles, active.networkPolicies).resolve(ref).fingerprint)
    .not.toBe(new ProfileCatalog(historical.profiles, historical.networkPolicies).resolve(ref).fingerprint);
});

test('active profile selection and subprocess loader compute the same migrated fingerprint', async () => {
  const active = parseActivePocTrustedConfiguration(JSON.parse(await readFile(configFile, 'utf8')) as unknown);
  const selected = active.publicTargetApproval?.executionProfileRef ??
    { id: active.profiles[0]!.id, version: active.profiles[0]!.version };
  const expected = new ProfileCatalog(active.profiles, active.networkPolicies).resolve(selected);
  const result = spawnSync(process.execPath, ['dist/profile/admission-cli.js', 'select', configPath], {
    cwd: process.cwd(), input: JSON.stringify({ admissionVersion: '1', kind: 'lookup',
      targetUrl: 'https://different.example.org/path' }), encoding: 'utf8', timeout: 5000,
  });
  expect(result.status).toBe(0);
  const response = JSON.parse(result.stdout) as { kind: string; canonicalUrl: string;
    executionProfileRef: typeof selected; profileFingerprint: string };
  expect(response.kind).toBe('approved');
  expect(response.canonicalUrl).toBe('https://different.example.org/path');
  expect(response.executionProfileRef).toEqual(selected);
  expect(response.profileFingerprint).toBe(expected.fingerprint);
});

test('new headless and headed public profiles store the 90-second navigation timeout', async () => {
  const url = 'https://www.example.org/path';
  const resolve = async () => ['93.184.215.14'];
  const inspection = await inspectPublicUrl(url, resolve);
  const headless = await approvePublicInspection(inspection, url, resolve);
  const headed = await approveHeadedPublicInspection(inspection, url, resolve);
  expect(headless.profile.timeoutPolicy.navigationMs).toBe(ACTIVE_POC_NAVIGATION_MS);
  expect(headed.profile.timeoutPolicy.navigationMs).toBe(ACTIVE_POC_NAVIGATION_MS);
  expect(headless.profile.timeoutPolicy.actionMs).toBe(10_000);
  expect(headed.profile.timeoutPolicy.waits).toEqual({ default: 10_000 });
});

test('historical approved profile remains readable at its stored 30-second timeout', async () => {
  const url = 'https://www.example.org/path';
  const resolve = async () => ['93.184.215.14'];
  const bundle = await approvePublicInspection(await inspectPublicUrl(url, resolve), url, resolve);
  const legacyProfile = { ...bundle.profile, timeoutPolicy: {
    ...bundle.profile.timeoutPolicy, navigationMs: 30_000,
  } };
  const effective = new ProfileCatalog([legacyProfile], [bundle.policy])
    .resolve(bundle.approval.executionProfileRef);
  const legacyFingerprint = createHash('sha256').update(JSON.stringify({
    profile: effective.profile, policy: effective.policy,
  })).digest('hex');
  const approval = { ...bundle.approval, profileFingerprint: legacyFingerprint };
  expect(effective.profile).toEqual(legacyProfile);
  const historical = lookupAdmittedPublicTarget(approval, effective,
    { admissionVersion: '1', kind: 'lookup', targetUrl: url });
  expect(historical.kind).toBe('approved');
  expect(effective.profile.timeoutPolicy.navigationMs).toBe(30_000);
});
