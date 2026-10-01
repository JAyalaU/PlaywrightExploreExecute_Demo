import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { parseTrustedLocalConfiguration } from '../app/local/contracts.js';
import { runLocalWorkflow } from '../app/local/workflow.js';
import {
  CHALLENGING_DOM_URL, ProfileCatalog, publicTargetGate, resolveApprovedAddress,
} from '../app/profile/index.js';

const configurationPath = 'config/public-challenging-dom.json';
const reference = { id: 'challenging-dom-public-headless', version: '1' };
const reviewedAddresses = ['3.209.172.72', '23.22.130.173', '54.243.238.66', '107.22.57.98'];
const expectedFingerprint = 'd3e82850b7aed8ad0825de676b52f983658edb7d0ec3b4bf4852812d1c5b3a42';

function rawConfiguration(): Record<string, unknown> {
  return JSON.parse(readFileSync(configurationPath, 'utf8')) as Record<string, unknown>;
}

test('replacement approval binds the exact production target, isolated profile, and reviewed pins', async () => {
  const configuration = parseTrustedLocalConfiguration(rawConfiguration());
  const effective = new ProfileCatalog(configuration.profiles, configuration.networkPolicies).resolve(reference);
  expect(configuration.publicTargetApproval).toEqual({
    approvalVersion: '3', targetUrl: CHALLENGING_DOM_URL,
    executionProfileRef: reference, profileFingerprint: expectedFingerprint,
  });
  expect(effective.fingerprint).toBe(expectedFingerprint);
  expect(effective.profile).toMatchObject({ profileSchemaVersion: '3', presentationMode: 'headless',
    browserIsolation: 'docker', networkPolicyRef: { id: 'challenging-dom-public-egress', version: '1' } });
  expect(effective.policy.destinations).toEqual([{
    host: 'the-internet.herokuapp.com', ports: [443], addresses: reviewedAddresses,
  }]);
  await expect(publicTargetGate(configuration.publicTargetApproval!).authorize(effective)).resolves.toBeUndefined();
});

test('replacement policy permits only the reviewed target authority and exact DNS set', async () => {
  const configuration = parseTrustedLocalConfiguration(rawConfiguration());
  const policy = new ProfileCatalog(configuration.profiles, configuration.networkPolicies).resolve(reference).policy;
  expect(await resolveApprovedAddress(new URL(CHALLENGING_DOM_URL), policy,
    async () => [...reviewedAddresses].reverse())).toBe('107.22.57.98');

  await expect(resolveApprovedAddress(new URL('https://298279967.log.optimizely.com/'), policy,
    async () => reviewedAddresses)).rejects.toThrow('Destination denied');
  await expect(resolveApprovedAddress(new URL('https://the-internet.herokuapp.com:8443/challenging_dom'), policy,
    async () => reviewedAddresses)).rejects.toThrow('Destination denied');
  await expect(resolveApprovedAddress(new URL(CHALLENGING_DOM_URL), policy,
    async () => [...reviewedAddresses, '10.0.0.1'])).rejects.toThrow('Destination address denied');
  await expect(resolveApprovedAddress(new URL(CHALLENGING_DOM_URL), policy,
    async () => ['3.209.172.73'])).rejects.toThrow('Destination address denied');
});

test('replacement approval fails closed for absent approval, another path, or changed authority', async () => {
  const models = {
    interpretationModel: { complete: async () => { throw new Error('Model must not start'); } },
    stepDecisionModel: { complete: async () => { throw new Error('Model must not start'); } },
  };
  const request = { taskText: 'Select edit in the Iuvaret1 row and assert the exact URL.',
    targetUrl: CHALLENGING_DOM_URL, executionProfileRef: reference };
  const noApproval = rawConfiguration();
  delete noApproval.publicTargetApproval;
  await expect(runLocalWorkflow(request, noApproval, { provider: { apiKey: () => undefined } },
    { modelAdapters: models })).rejects.toMatchObject({ code: 'DESTINATION_DENIED' });
  await expect(runLocalWorkflow({ ...request,
    targetUrl: 'https://the-internet.herokuapp.com/challenging_dom/other' }, rawConfiguration(),
  { provider: { apiKey: () => undefined } }, { modelAdapters: models }))
    .rejects.toMatchObject({ code: 'DESTINATION_DENIED' });

  const widened = rawConfiguration();
  const policies = widened.networkPolicies as Array<Record<string, unknown>>;
  const destinations = policies[0]!.destinations as Array<Record<string, unknown>>;
  destinations.push({ host: '298279967.log.optimizely.com', ports: [443], addresses: ['18.211.21.0'] });
  const widenedEffective = new ProfileCatalog(widened.profiles as unknown[], widened.networkPolicies as unknown[])
    .resolve(reference);
  (widened.publicTargetApproval as Record<string, unknown>).profileFingerprint = widenedEffective.fingerprint;
  expect(() => parseTrustedLocalConfiguration(widened)).toThrow('Public target approval');
});

test('survey-only qualification configuration remains unapproved and independently versioned', () => {
  const qualification = parseTrustedLocalConfiguration(JSON.parse(
    readFileSync('config/public-challenging-dom-qualification.json', 'utf8')) as unknown);
  expect(qualification.publicTargetApproval).toBeUndefined();
  expect(qualification.profiles[0]).toMatchObject({ id: 'challenging-dom-qualification-headless', version: '1' });
  expect(qualification.networkPolicies[0]).toMatchObject({ id: 'challenging-dom-qualification-egress', version: '1' });
});
