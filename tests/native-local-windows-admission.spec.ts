import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { approveNativeLocalWindowsInspection, inspectNativePublicUrl } from '../app/profile/native-admission.js';
import { LocalWindowsExecutionProfileSchema, NativeProfileCatalog } from '../app/profile/native-profile.js';
import { parseProductTrustedConfiguration, selectNativeLocalWindowsProductProfile } from '../app/local/product-contracts.js';

const targetUrl = 'https://native-profile.example.org/path';
const resolve = async () => ['93.184.215.14'];
const evidencePolicy = { finalScreenshot: false, failureScreenshot: false,
  failureTrace: false, failureVideo: false, sensitiveBinaryApproved: false };

async function nativeConfig() {
  const inspection = await inspectNativePublicUrl(targetUrl, resolve);
  const approved = await approveNativeLocalWindowsInspection(inspection, targetUrl, 'headless', resolve);
  const config = parseProductTrustedConfiguration({
    profiles: [approved.profile], publicTargetApproval: approved.approval,
    evidencePolicy, artifactRoot: 'native-test-artifacts', retentionDays: 7,
  });
  return { ...approved, config };
}

test('native schema-5 config selects its approved profile directly without Docker policy', async () => {
  const { profile, approval, config } = await nativeConfig();
  const native = LocalWindowsExecutionProfileSchema.parse(profile);
  expect(native.profileSchemaVersion).toBe('5');
  expect(native.browserIsolation).toBe('local-windows');
  expect(native.browserRuntime).toBe('playwright-chromium-windows');
  expect('networkPolicyRef' in profile).toBe(false);
  expect('networkPolicies' in config).toBe(false);
  const selected = selectNativeLocalWindowsProductProfile(config);
  expect(selected.config).toBe(config);
  expect(selected.config.profiles).toHaveLength(1);
  expect(selected.reference).toEqual(approval.executionProfileRef);
  expect(selected.fingerprint).toBe(approval.profileFingerprint);
  expect(selected.config.profiles[0]?.timeoutPolicy.navigationMs).toBe(profile.timeoutPolicy.navigationMs);
  expect(new NativeProfileCatalog(config.profiles).resolve(selected.reference).fingerprint)
    .toBe(approval.profileFingerprint);
});

test('native target approval binds the exact profile and rejects altered fingerprint', async () => {
  const { config } = await nativeConfig();
  const approval = config.publicTargetApproval!;
  const changedProfile = { ...config.profiles[0]!, timeoutPolicy: {
    ...config.profiles[0]!.timeoutPolicy, navigationMs: 91_000,
  } };
  expect(() => selectNativeLocalWindowsProductProfile({ ...config, profiles: [changedProfile] }))
    .toThrow();
  expect(() => selectNativeLocalWindowsProductProfile({ ...config, publicTargetApproval: {
    ...approval, profileFingerprint: '0'.repeat(64),
  } })).toThrow();
  expect(() => selectNativeLocalWindowsProductProfile({ ...config, publicTargetApproval: {
    ...approval, executionProfileRef: { id: 'other', version: '1' },
  } })).toThrow();
});

test('native headed approval is separate and uses schema-5 headed profile', async () => {
  const inspection = await inspectNativePublicUrl(targetUrl, resolve);
  const { profile, approval } = await approveNativeLocalWindowsInspection(inspection, targetUrl, 'headed', resolve);
  const native = LocalWindowsExecutionProfileSchema.parse(profile);
  expect(native.profileSchemaVersion).toBe('5');
  expect(native.presentationMode).toBe('headed');
  expect(approval.admissionVersion).toBe('2');
  const config = parseProductTrustedConfiguration({
    profiles: [profile], publicTargetApproval: approval, evidencePolicy,
    artifactRoot: 'native-test-artifacts', retentionDays: 7,
  });
  expect(selectNativeLocalWindowsProductProfile(config).fingerprint)
    .toBe(approval.profileFingerprint);
});

test('native approval rejects changed DNS inspection without contacting a site', async () => {
  const inspection = await inspectNativePublicUrl(targetUrl, resolve);
  await expect(approveNativeLocalWindowsInspection(inspection, targetUrl, 'headless',
    async () => ['93.184.215.15'])).rejects.toMatchObject({
      code: 'INSPECTION_CHANGED',
    });
});

test('admission CLI selects native schema-5 and denies an unapproved target', async () => {
  const { config, approval } = await nativeConfig();
  const directory = mkdtempSync(join(tmpdir(), 'native-admission-'));
  try {
    const configPath = join(directory, 'trusted.json');
    writeFileSync(configPath, JSON.stringify(config));
    const run = (url: string, selectors: { workflow?: string; backend?: string } = {}) => {
      const env = { ...process.env };
      delete env.PLAYWRIGHT_DEMO_WORKFLOW_VERSION;
      delete env.PLAYWRIGHT_DEMO_BROWSER_BACKEND;
      if (selectors.workflow !== undefined) env.PLAYWRIGHT_DEMO_WORKFLOW_VERSION = selectors.workflow;
      if (selectors.backend !== undefined) env.PLAYWRIGHT_DEMO_BROWSER_BACKEND = selectors.backend;
      return spawnSync(process.execPath, ['dist/profile/admission-cli.js', 'select', configPath], {
        cwd: process.cwd(), encoding: 'utf8',
        input: JSON.stringify({ admissionVersion: '1', kind: 'lookup', targetUrl: url }),
        env,
      });
    };
    const accepted = run(targetUrl);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toEqual({
      admissionVersion: '1', kind: 'approved', canonicalUrl: targetUrl,
      executionProfileRef: approval.executionProfileRef,
      profileFingerprint: approval.profileFingerprint,
    });
    const pythonEnv: NodeJS.ProcessEnv = { ...process.env, PYTHONPATH: join(process.cwd(), 'src') };
    delete pythonEnv.PLAYWRIGHT_DEMO_WORKFLOW_VERSION;
    delete pythonEnv.PLAYWRIGHT_DEMO_BROWSER_BACKEND;
    const python = spawnSync('.venv/Scripts/python.exe', ['-c', [
      'import json,os,sys',
      'from playwright_demo.public_admission import lookup_public_admission',
      'result=lookup_public_admission(sys.argv[1],node_entry=sys.argv[2],config_path=sys.argv[3],selection_only=True,environment=os.environ)',
      'print(json.dumps(result))',
    ].join('\n'), targetUrl, join(process.cwd(), 'dist/profile/admission-cli.js'), configPath], {
      cwd: process.cwd(), encoding: 'utf8',
      env: pythonEnv,
    });
    expect(python.status, python.stderr).toBe(0);
    expect(JSON.parse(python.stdout)).toEqual(JSON.parse(accepted.stdout));
    const denied = run('https://other.example.org/');
    expect(denied.status, denied.stderr).toBe(0);
    expect(JSON.parse(denied.stdout)).toEqual({ admissionVersion: '1', kind: 'denied' });
    for (const selectors of [{ backend: 'docker-isolated' }, { workflow: 'deferred-action-v1' }]) {
      const stale = run(targetUrl, selectors);
      expect(stale.status).not.toBe(0);
      expect(stale.stdout).toBe('');
    }
    writeFileSync(configPath, JSON.stringify({ ...config, publicTargetApproval: undefined }));
    const missingApproval = run(targetUrl);
    expect(missingApproval.status, missingApproval.stderr).toBe(0);
    expect(JSON.parse(missingApproval.stdout)).toEqual({ admissionVersion: '1', kind: 'denied' });
    writeFileSync(configPath, JSON.stringify({ ...config, publicTargetApproval: {
      ...approval, profileFingerprint: '0'.repeat(64),
    } }));
    const mismatched = run(targetUrl);
    expect(mismatched.status).not.toBe(0);
    expect(mismatched.stdout).toBe('');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
