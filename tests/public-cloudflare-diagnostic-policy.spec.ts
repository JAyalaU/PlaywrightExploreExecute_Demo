import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { parseTrustedLocalConfiguration } from '../app/local/contracts.js';
import { ProfileCatalog } from '../app/profile/contracts.js';
import { resolveApprovedAddress } from '../app/profile/network.js';
import { publicTargetGate } from '../app/profile/public-target.js';

const configPath = 'config/public-columbia-cloudflare-diagnostic.json';
const reference = { id: 'columbia-public-headless', version: '2' };
const cloudflareAnswers = [
  '2606:4700::6812:5e29', '2606:4700::6812:5f29',
  '104.18.95.41', '104.18.94.41',
];

function rawConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
}

test('diagnostic approval binds only the new isolated profile and two exact destinations', async () => {
  const config = parseTrustedLocalConfiguration(rawConfig());
  const effective = new ProfileCatalog(config.profiles, config.networkPolicies).resolve(reference);
  expect(effective.fingerprint).toBe(config.publicTargetApproval?.profileFingerprint);
  expect(effective.profile.networkPolicyRef).toEqual({ id: 'columbia-public-egress', version: '2' });
  expect(effective.policy.destinations.map((item) => `${item.host}:${item.ports.join(',')}`))
    .toEqual(['www.columbia.edu:443', 'challenges.cloudflare.com:443']);
  await expect(publicTargetGate(config.publicTargetApproval!).authorize(effective)).resolves.toBeUndefined();

  // Every DNS answer is checked; an approved IPv4 route is selected when AAAA comes first.
  expect(await resolveApprovedAddress(new URL('https://challenges.cloudflare.com/'),
    effective.policy, async () => cloudflareAnswers)).toBe('104.18.95.41');
});

test('diagnostic policy fails closed on a changed answer or unrelated host', async () => {
  const config = parseTrustedLocalConfiguration(rawConfig());
  const policy = new ProfileCatalog(config.profiles, config.networkPolicies).resolve(reference).policy;
  await expect(resolveApprovedAddress(new URL('https://challenges.cloudflare.com/'),
    policy, async () => [...cloudflareAnswers, '10.0.0.1']))
    .rejects.toThrow('Destination address denied');
  await expect(resolveApprovedAddress(new URL('https://challenges.cloudflare.com:8443/'),
    policy, async () => cloudflareAnswers)).rejects.toThrow('Destination denied');
  await expect(resolveApprovedAddress(new URL('https://other.cloudflare.com/'),
    policy, async () => cloudflareAnswers)).rejects.toThrow('Destination denied');
});

test('a policy change or approval downgrade invalidates the diagnostic configuration', () => {
  const extraHost = rawConfig();
  const policy = (extraHost.networkPolicies as Array<Record<string, unknown>>)[0]!;
  (policy.destinations as Array<unknown>).push({ host: 'other.cloudflare.com', ports: [443],
    addresses: ['104.18.94.41'] });
  (extraHost.publicTargetApproval as Record<string, unknown>).profileFingerprint =
    new ProfileCatalog(extraHost.profiles as unknown[], extraHost.networkPolicies as unknown[])
      .resolve(reference).fingerprint;
  expect(() => parseTrustedLocalConfiguration(extraHost)).toThrow('Public target approval');

  const downgraded = rawConfig();
  (downgraded.publicTargetApproval as Record<string, unknown>).approvalVersion = '1';
  expect(() => parseTrustedLocalConfiguration(downgraded)).toThrow('Public target approval');

  // The original profile is still independently loadable for a closed rollback.
  const original = JSON.parse(readFileSync('config/public-columbia.json', 'utf8')) as unknown;
  expect(() => parseTrustedLocalConfiguration(original)).not.toThrow();
});
