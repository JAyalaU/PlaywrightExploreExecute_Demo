import { expect, test } from '@playwright/test';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { inspectNativePublicUrl, approveNativeLocalWindowsInspection } from '../app/profile/native-admission.js';
import { NativeProfileCatalog } from '../app/profile/native-profile.js';
import { parseProductTrustedConfiguration } from '../app/local/product-contracts.js';
import { runAgenticLocalWorkflow } from '../app/local/agentic-workflow.js';
import { ProtectedContextFactory, ProtectedFinalCheckError } from '../app/profile/local-context.js';

const targetUrl = 'https://approved.example.org/path';
const resolve = async () => ['93.184.215.14'];
const evidencePolicy = { finalScreenshot: false, failureScreenshot: false,
  failureTrace: false, failureVideo: false, sensitiveBinaryApproved: false };

async function fixture() {
  const inspection = await inspectNativePublicUrl(targetUrl, resolve);
  const { profile, approval } = await approveNativeLocalWindowsInspection(inspection, targetUrl, 'headless', resolve);
  const config = parseProductTrustedConfiguration({ profiles: [profile],
    publicTargetApproval: approval, evidencePolicy, artifactRoot: 'offline-artifacts', retentionDays: 7 });
  return { profile, approval, config, request: { taskText: 'Check the page', targetUrl,
    executionProfileRef: approval.executionProfileRef } };
}

test('native schema-5 fingerprint follows its canonical serialized profile', async () => {
  const { profile, approval } = await fixture();
  const ref = { id: profile.id, version: profile.version };
  const nativeFingerprint = new NativeProfileCatalog([profile]).resolve(ref).fingerprint;
  expect(nativeFingerprint).toBe(approval.profileFingerprint);
  expect(new NativeProfileCatalog([profile]).resolve(ref).fingerprint).toBe(nativeFingerprint);
  expect(new NativeProfileCatalog([{ ...profile, timeoutPolicy: { ...profile.timeoutPolicy,
    actionMs: profile.timeoutPolicy.actionMs + 1 } }]).resolve(ref).fingerprint)
    .not.toBe(nativeFingerprint);
  expect(() => parseProductTrustedConfiguration({ profiles: [profile], networkPolicies: [
    { id: 'docker', version: '1', destinations: [] }], evidencePolicy,
    artifactRoot: 'offline-artifacts', retentionDays: 7 })).toThrow();
  expect(() => parseProductTrustedConfiguration({ profiles: [profile], networkPolicies: [],
    evidencePolicy, artifactRoot: 'offline-artifacts', retentionDays: 7 })).toThrow();
  for (const profileSchemaVersion of ['3', '4']) {
    expect(() => parseProductTrustedConfiguration({ profiles: [{ ...profile,
      profileSchemaVersion, browserIsolation: 'docker' }], evidencePolicy,
      artifactRoot: 'offline-artifacts', retentionDays: 7 })).toThrow();
  }
});

test('direct Node rejects missing, wrong-target, wrong-ref and wrong-fingerprint approval before launch', async () => {
  const { config, approval, request } = await fixture();
  const original = chromium.launch;
  let browserLaunchAttempts = 0;
  chromium.launch = (async () => { browserLaunchAttempts++;
    throw new Error('Browser launch must not occur'); }) as typeof chromium.launch;
  try {
    const invalid = [
      { label: 'missing approval', config: { ...config, publicTargetApproval: undefined }, request },
      { label: 'wrong target', config, request: { ...request, targetUrl: 'https://other.example.org/path' } },
      { label: 'wrong profile reference', config, request: {
        ...request, executionProfileRef: { id: 'other', version: '1' } } },
      { label: 'wrong fingerprint', config: { ...config, publicTargetApproval: {
        ...approval, profileFingerprint: '0'.repeat(64) } }, request },
    ];
    for (const item of invalid) {
      await expect(runAgenticLocalWorkflow(item.request, item.config,
        { provider: { apiKey: () => { throw new Error('Provider must not be reached'); } } }))
        .rejects.toMatchObject({ code: 'INVALID_TRUSTED_CONFIGURATION' });
      expect(browserLaunchAttempts, item.label).toBe(0);
    }
  } finally { chromium.launch = original; }
});

test('correct native approval reaches the direct Node semantic boundary without browser work', async () => {
  const { config, request } = await fixture();
  await expect(runAgenticLocalWorkflow(request, config,
    { provider: { apiKey: () => undefined } }))
    .rejects.toMatchObject({ code: 'PROVIDER_CONFIGURATION_ERROR' });
});

test('native local context opens bundled Chromium, loads auth state and verifies final cleanup', async () => {
  test.skip(process.platform !== 'win32', 'Native Windows browser boundary');
  const { profile } = await fixture();
  const native = { ...profile, authStateRef: { id: 'offline-auth', version: '1' } };
  const catalog = new NativeProfileCatalog([native]);
  const ref = { id: native.id, version: native.version };
  let authLoads = 0;
  const factory = new ProtectedContextFactory(catalog, { load: async () => {
    authLoads++;
    return { cookies: [{ name: 'offline', value: 'yes', domain: 'approved.example.org',
      path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' }], origins: [] };
  } });
  const session = await factory.open(ref, catalog.resolve(ref));
  const browser = session.context.browser();
  try {
    const page = await session.context.newPage();
    await page.goto('data:text/html,<main>Offline</main>');
    expect(await page.locator('main').textContent()).toBe('Offline');
    expect((await session.context.cookies('https://approved.example.org/'))[0]?.value).toBe('yes');
    expect(authLoads).toBe(1);
    await session.closeWithFinalCheck(async () => {
      expect(session.context.pages()).toHaveLength(1);
    });
    expect(browser?.isConnected()).toBe(false);
  } finally { await session.close(); }
  const changed = { ...catalog.resolve(ref), fingerprint: '0'.repeat(64) };
  await expect(factory.open(ref, changed)).rejects.toThrow('settings changed');
  expect(authLoads).toBe(1);
  const second = await factory.open(ref);
  try {
    await expect(second.closeWithFinalCheck(async () => {
      throw new Error('Offline final check failed');
    })).rejects.toBeInstanceOf(ProtectedFinalCheckError);
    expect(second.context.browser()?.isConnected()).toBe(false);
  } finally { await second.close().catch(() => undefined); }
});

test('native local context closes Chromium when auth-state loading fails', async () => {
  test.skip(process.platform !== 'win32', 'Native Windows browser boundary');
  const { profile } = await fixture();
  const native = { ...profile, authStateRef: { id: 'offline-auth', version: '1' } };
  const ref = { id: native.id, version: native.version };
  const original = chromium.launch;
  let launched: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  chromium.launch = (async (...args: Parameters<typeof chromium.launch>) => {
    launched = await original.call(chromium, ...args);
    return launched;
  }) as typeof chromium.launch;
  try {
    const factory = new ProtectedContextFactory(new NativeProfileCatalog([native]), {
      load: async () => { throw new Error('Offline auth unavailable'); },
    });
    await expect(factory.open(ref)).rejects.toThrow('Offline auth unavailable');
    expect(launched?.isConnected()).toBe(false);
  } finally { chromium.launch = original; await launched?.close(); }
});

test('native local context applies the profile navigation timeout', async () => {
  test.skip(process.platform !== 'win32', 'Native Windows browser boundary');
  const { profile } = await fixture();
  const timed = { ...profile, timeoutPolicy: { ...profile.timeoutPolicy, navigationMs: 400 } };
  const ref = { id: timed.id, version: timed.version };
  const factory = new ProtectedContextFactory(new NativeProfileCatalog([timed]));
  const server = createServer((_request, _response) => { /* Keep the navigation pending. */ });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback server port');
  try {
    const session = await factory.open(ref);
    try {
      const page = await session.context.newPage();
      await expect(page.goto(`http://127.0.0.1:${address.port}/pending`))
        .rejects.toMatchObject({ name: 'TimeoutError' });
    } finally { await session.close(); }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
