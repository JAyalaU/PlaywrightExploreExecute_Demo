import { expect, test } from '@playwright/test';
import {
  approvePublicInspection, canonicalPublicUrl, inspectPublicUrl, isPublicAddress,
  lookupAdmittedPublicTarget, AdmissionLookupResponseSchema,
  ProfileCatalog, publicTargetGate, resolveApprovedAddress,
} from '../app/profile/index.js';
import { parseTrustedLocalConfiguration } from '../app/local/contracts.js';
import { runLocalWorkflow } from '../app/local/workflow.js';

const firstUrl = 'https://www.first-public-site.org/path';
const secondUrl = 'http://www.second-public-site.org/';
const firstDns = async () => ['93.184.215.14', '2606:2800:220:1:248:1893:25c8:1946'];
const secondDns = async () => ['8.8.8.8'];
const unavailableModels = {
  interpretationModel: { complete: async () => { throw new Error('Model must not start'); } },
  stepDecisionModel: { complete: async () => { throw new Error('Model must not start'); } },
};
const noCredential = { provider: { apiKey: () => undefined } };

function configuration(bundle: Awaited<ReturnType<typeof approvePublicInspection>>) {
  return {
    profiles: [bundle.profile], networkPolicies: [bundle.policy],
    publicTargetApproval: bundle.approval,
    evidencePolicy: { finalScreenshot: false, failureScreenshot: false,
      failureTrace: false, failureVideo: false, sensitiveBinaryApproved: false },
    artifactRoot: 'jobs/admission-test', retentionDays: 7,
  };
}

test('P3-A admits two new public hosts into distinct exact immutable isolated profiles', async () => {
  const one = await approvePublicInspection(await inspectPublicUrl(firstUrl, firstDns), firstUrl, firstDns);
  const two = await approvePublicInspection(await inspectPublicUrl(secondUrl, secondDns), secondUrl, secondDns);
  for (const bundle of [one, two]) {
    const config = parseTrustedLocalConfiguration(configuration(bundle));
    const effective = new ProfileCatalog(config.profiles, config.networkPolicies)
      .resolve(bundle.approval.executionProfileRef);
    expect(bundle.approval.profileFingerprint).toBe(effective.fingerprint);
    expect(effective.profile).toMatchObject({
      profileSchemaVersion: '3', presentationMode: 'headless', browserIsolation: 'docker',
    });
    expect(effective.policy.destinations).toEqual([{
      host: bundle.approval.host, ports: [bundle.approval.port],
      addresses: bundle.approval.addresses,
    }]);
    await expect(publicTargetGate(bundle.approval).authorize(effective)).resolves.toBeUndefined();
  }
  expect(one.approval.executionProfileRef).not.toEqual(two.approval.executionProfileRef);
  expect(one.approval.profileFingerprint).not.toBe(two.approval.profileFingerprint);
});

test('P3-A denies unsafe URL and address classes before approval', async () => {
  for (const input of [
    'http://127.0.0.1/', 'http://[::1]/', 'http://localhost/', 'http://host.internal/',
    'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd',
    'https://user:secret@www.first-public-site.org/', 'https://www.first-public-site.org:8443/',
    'https://www.first-public-site.org/#fragment',
  ]) expect(() => canonicalPublicUrl(input)).toThrow();
  for (const address of [
    '127.0.0.1', '169.254.169.254', '10.1.2.3', '192.0.2.4', '198.51.100.1',
    '203.0.113.1', '100.64.0.1', '::1', 'fc00::1', 'fe80::1',
    '2001:db8::1', '::ffff:8.8.8.8', '64:ff9b::808:808',
  ]) expect(isPublicAddress(address), address).toBe(false);
  await expect(inspectPublicUrl(firstUrl, async () => ['93.184.215.14', '127.0.0.1']))
    .rejects.toMatchObject({ code: 'ADDRESS_DENIED' });
  await expect(inspectPublicUrl(firstUrl, async () => []))
    .rejects.toMatchObject({ code: 'ADDRESS_DENIED' });
});

test('P3-A changed DNS invalidates approval, and a fresh inspection yields a new versioned identity', async () => {
  const prior = await inspectPublicUrl(firstUrl, firstDns);
  await expect(approvePublicInspection(prior, firstUrl, async () => ['93.184.215.15']))
    .rejects.toMatchObject({ code: 'INSPECTION_CHANGED' });
  await expect(approvePublicInspection(prior, secondUrl, firstDns))
    .rejects.toMatchObject({ code: 'INSPECTION_CHANGED' });
  const restored = await approvePublicInspection(prior, firstUrl, firstDns);
  const changed = await approvePublicInspection(
    await inspectPublicUrl(firstUrl, async () => ['93.184.215.15']), firstUrl,
    async () => ['93.184.215.15']);
  expect(restored.approval.executionProfileRef).not.toEqual(changed.approval.executionProfileRef);
  expect(() => parseTrustedLocalConfiguration(configuration(restored))).not.toThrow();
});

test('Active PoC ignores old destination pins and exact approval URL', async () => {
  const bundle = await approvePublicInspection(await inspectPublicUrl(firstUrl, firstDns), firstUrl, firstDns);
  const config = configuration(bundle);
  const changed = structuredClone(config);
  changed.networkPolicies[0]!.destinations[0]!.addresses = ['8.8.8.8'];
  const selected = { taskText: 'Check the page', targetUrl: secondUrl,
    executionProfileRef: bundle.approval.executionProfileRef };
  const outcome = await runLocalWorkflow(selected, changed, noCredential,
    { modelAdapters: unavailableModels });
  expect(outcome.handoff.kind).toBe('stopped');
  expect(outcome.handoff.kind === 'stopped' && outcome.handoff.result.reason).toBe('MODEL_ERROR');
  const baseline = new ProfileCatalog(config.profiles, config.networkPolicies)
    .resolve(bundle.approval.executionProfileRef);
  const afterPinChange = new ProfileCatalog(changed.profiles, changed.networkPolicies)
    .resolve(bundle.approval.executionProfileRef);
  expect(afterPinChange.fingerprint).toBe(baseline.fingerprint);
});

test('P3-A versioned read-only lookup returns only a correlated approval or denial', async () => {
  const bundle = await approvePublicInspection(await inspectPublicUrl(firstUrl, firstDns), firstUrl, firstDns);
  const effective = new ProfileCatalog([bundle.profile], [bundle.policy])
    .resolve(bundle.approval.executionProfileRef);
  const request = { admissionVersion: '1', kind: 'lookup', targetUrl: firstUrl };
  const approved = lookupAdmittedPublicTarget(bundle.approval, effective, request);
  expect(approved).toEqual({
    admissionVersion: '1', kind: 'approved', canonicalUrl: firstUrl,
    executionProfileRef: bundle.approval.executionProfileRef,
    profileFingerprint: bundle.approval.profileFingerprint,
  });
  expect(AdmissionLookupResponseSchema.parse(approved)).toEqual(approved);
  expect(lookupAdmittedPublicTarget(bundle.approval, effective,
    { ...request, targetUrl: secondUrl })).toEqual({ admissionVersion: '1', kind: 'denied' });
  expect(lookupAdmittedPublicTarget(bundle.approval, effective,
    { ...request, targetUrl: 'http://127.0.0.1/' })).toEqual({ admissionVersion: '1', kind: 'denied' });
  expect(() => lookupAdmittedPublicTarget(bundle.approval, effective,
    { ...request, policy: bundle.policy })).toThrow();
  expect(() => lookupAdmittedPublicTarget(bundle.approval, effective,
    { ...request, admissionVersion: '2' })).toThrow();
  expect(() => lookupAdmittedPublicTarget({ ...bundle.approval, profileFingerprint: '0'.repeat(64) },
    effective, request)).toThrow();
});
