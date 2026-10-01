import { readFileSync } from 'node:fs';
import http from 'node:http';
import { Readable } from 'node:stream';
import { expect, test } from '@playwright/test';
import { parseTrustedLocalConfiguration } from '../app/local/contracts.js';
import { runLocalWorkflow } from '../app/local/workflow.js';
import { COLUMBIA_SAMPLE_URL, ProfileCatalog, ProtectedProxy, publicTargetGate,
  resolveApprovedAddress } from '../app/profile/index.js';
import { runSubprocessAdapter } from '../app/subprocess/entry.js';

function reviewedConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync('config/public-columbia.json', 'utf8')) as Record<string, unknown>;
}

const ref = { id: 'columbia-public-headless', version: '1' };
const request = { taskText: 'Confirm two Frank da Cruz links.', targetUrl: COLUMBIA_SAMPLE_URL,
  executionProfileRef: ref };
const models = { interpretationModel: { complete: async () => { throw new Error('Model must not start'); } },
  stepDecisionModel: { complete: async () => { throw new Error('Model must not start'); } } };

test('A approval binds the reviewed headless compartment, exact URL, fingerprint and public pins', async () => {
  const config = parseTrustedLocalConfiguration(reviewedConfig());
  const effective = new ProfileCatalog(config.profiles, config.networkPolicies).resolve(ref);
  expect(effective.fingerprint).toBe(config.publicTargetApproval?.profileFingerprint);
  expect(effective.profile).toMatchObject({ profileSchemaVersion: '3',
    presentationMode: 'headless', browserIsolation: 'docker' });
  expect(effective.policy.destinations).toEqual([{ host: 'www.columbia.edu', ports: [443],
    addresses: ['162.159.128.65', '162.159.138.64'] }]);
  await expect(publicTargetGate(config.publicTargetApproval!).authorize(effective)).resolves.toBeUndefined();
  expect(await resolveApprovedAddress(new URL(COLUMBIA_SAMPLE_URL), effective.policy,
    async () => ['162.159.138.64', '162.159.128.65'])).toBe('162.159.138.64');
});

test('A rejects missing or mismatched approval before provider or browser work', async () => {
  const config = reviewedConfig();
  const noApproval = { ...config };
  delete noApproval.publicTargetApproval;
  await expect(runLocalWorkflow(request, noApproval, { provider: { apiKey: () => undefined } },
    { modelAdapters: models })).rejects.toMatchObject({ code: 'DESTINATION_DENIED' });
  await expect(runLocalWorkflow({ ...request, targetUrl: 'https://www.columbia.edu/~fdc/other.html' },
    config, { provider: { apiKey: () => undefined } }, { modelAdapters: models }))
    .rejects.toMatchObject({ code: 'DESTINATION_DENIED' });
  await expect(runLocalWorkflow({ ...request, executionProfileRef: { ...ref, version: '2' } },
    config, { provider: { apiKey: () => undefined } }, { modelAdapters: models }))
    .rejects.toMatchObject({ code: 'PROFILE_UNAVAILABLE' });
  const response = await runSubprocessAdapter(
    Readable.from([JSON.stringify({ protocolVersion: '1', request })]),
    async () => noApproval, { provider: { apiKey: () => undefined } });
  expect(response).toEqual({ protocolVersion: '1', kind: 'bridge_error',
    code: 'DESTINATION_DENIED', cleanup: 'not_started' });
});

test('A policy rejects unapproved host, port, DNS changes and reserved results without fallback', async () => {
  const config = parseTrustedLocalConfiguration(reviewedConfig());
  const policy = new ProfileCatalog(config.profiles, config.networkPolicies).resolve(ref).policy;
  const resolver = async () => ['162.159.128.65'];
  await expect(resolveApprovedAddress(new URL('https://other.columbia.edu/'), policy, resolver))
    .rejects.toThrow('Destination denied');
  await expect(resolveApprovedAddress(new URL('https://www.columbia.edu:8443/'), policy, resolver))
    .rejects.toThrow('Destination denied');
  for (const address of ['127.0.0.1', '169.254.169.254', '162.159.128.66']) {
    await expect(resolveApprovedAddress(new URL(COLUMBIA_SAMPLE_URL), policy,
      async () => [address])).rejects.toThrow('Destination address denied');
  }
  await expect(resolveApprovedAddress(new URL(COLUMBIA_SAMPLE_URL), policy,
    async () => ['162.159.128.65', '10.0.0.1'])).rejects.toThrow('Destination address denied');
  await expect(resolveApprovedAddress(new URL(COLUMBIA_SAMPLE_URL), policy,
    async () => { throw new Error('DNS unavailable'); })).rejects.toThrow('DNS unavailable');
  expect(await resolveApprovedAddress(new URL(COLUMBIA_SAMPLE_URL), policy, resolver))
    .toBe('162.159.128.65');

  const proxy = await ProtectedProxy.start(policy);
  try {
    const address = new URL(proxy.url);
    const denied = await new Promise<number>((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: Number(address.port),
        method: 'CONNECT', path: 'www.columbia.edu:80' });
      request.on('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode ?? 0); });
      request.on('error', reject);
      request.end();
    });
    expect(denied).toBe(403);
  } finally { await proxy.close(); }
});

test('A changed or unsafe trusted profile/policy needs a new reviewed approval', () => {
  const changedPolicy = reviewedConfig();
  const policies = changedPolicy.networkPolicies as Array<Record<string, unknown>>;
  const destinations = policies[0]!.destinations as Array<Record<string, unknown>>;
  destinations[0]!.addresses = ['162.159.128.66'];
  expect(() => parseTrustedLocalConfiguration(changedPolicy)).toThrow('Public target approval');

  const unsafe = reviewedConfig();
  const unsafePolicies = unsafe.networkPolicies as Array<Record<string, unknown>>;
  const unsafeDestinations = unsafePolicies[0]!.destinations as Array<Record<string, unknown>>;
  unsafeDestinations[0]!.addresses = ['127.0.0.1'];
  const effective = new ProfileCatalog(unsafe.profiles as unknown[], unsafe.networkPolicies as unknown[]).resolve(ref);
  (unsafe.publicTargetApproval as Record<string, unknown>).profileFingerprint = effective.fingerprint;
  expect(() => parseTrustedLocalConfiguration(unsafe)).toThrow('Public target approval');

  const wider = reviewedConfig();
  const widerPolicies = wider.networkPolicies as Array<Record<string, unknown>>;
  const widerDestinations = widerPolicies[0]!.destinations as Array<Record<string, unknown>>;
  widerDestinations.push({ host: 'other.columbia.edu', ports: [443], addresses: ['162.159.128.65'] });
  const widerEffective = new ProfileCatalog(wider.profiles as unknown[], wider.networkPolicies as unknown[]).resolve(ref);
  (wider.publicTargetApproval as Record<string, unknown>).profileFingerprint = widerEffective.fingerprint;
  expect(() => parseTrustedLocalConfiguration(wider)).toThrow('Public target approval');
  expect(() => parseTrustedLocalConfiguration(reviewedConfig())).not.toThrow();
});
