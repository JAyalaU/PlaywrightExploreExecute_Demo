import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { parseTrustedLocalConfiguration } from '../app/local/contracts.js';
import { LocalWorkflowError, runLocalWorkflow } from '../app/local/workflow.js';
import { IsolatedBrowser } from '../app/profile/isolated-browser.js';
import { ProfileCatalog, ProtectedContextFactory, ProtectedProxy, publicTargetGate } from '../app/profile/index.js';

const trustedConfigPath = process.env.PUBLIC_BROWSER_P3F_CONFIG;
const runtimeProofEnabled = process.env.PUBLIC_BROWSER_P3F_RUNTIME === '1' || trustedConfigPath !== undefined;
if (runtimeProofEnabled && (!trustedConfigPath?.trim() || !existsSync(trustedConfigPath))) {
  throw new Error('P3-F runtime proof was enabled but PUBLIC_BROWSER_P3F_CONFIG is missing or unreadable');
}
test.skip(!runtimeProofEnabled,
  'Opt-in exact-approved-profile G1 proof; set PUBLIC_BROWSER_P3F_RUNTIME=1 and PUBLIC_BROWSER_P3F_CONFIG');

const run = promisify(execFile);
const expectedTarget = process.env.PUBLIC_BROWSER_P3F_EXPECTED_URL;
test.describe.configure({ mode: 'serial' });

async function docker(args: string[]): Promise<string> {
  const { stdout } = await run('docker', args, { timeout: 15_000, maxBuffer: 1_048_576, windowsHide: true });
  return stdout.trim();
}

async function residualContainers(): Promise<string> {
  return docker(['ps', '-a', '--filter', 'name=public-browser-g1-', '--format', '{{.ID}}']);
}

test('G1 isolation proof loads and exercises the exact operator-approved P3-F config', async () => {
  test.setTimeout(90_000);
  const configPath = trustedConfigPath!;
  const config = parseTrustedLocalConfiguration(JSON.parse(await readFile(configPath, 'utf8')) as unknown);
  const approval = config.publicTargetApproval;
  expect(approval).toBeDefined();
  if (expectedTarget) expect(approval!.targetUrl).toBe(expectedTarget);
  const target = approval!.targetUrl;
  const reference = approval!.executionProfileRef;
  const catalog = new ProfileCatalog(config.profiles, config.networkPolicies);
  const effective = catalog.resolve(reference);
  expect(effective.fingerprint).toBe(approval!.profileFingerprint);

  const factory = new ProtectedContextFactory(catalog, undefined, publicTargetGate(approval!));
  let session: Awaited<ReturnType<typeof factory.open>> | undefined;
  let containerId: string | undefined;
  try {
    session = await factory.open(reference, effective);
    containerId = session.isolationContainerId;
    expect(containerId).toMatch(/^[a-f0-9]{64}$/);

    const inspected = JSON.parse(await docker(['inspect', containerId!])) as [{
      Mounts: unknown[];
      Config: { Env: string[] };
      HostConfig: { NetworkMode: string; PortBindings: unknown };
    }];
    expect(inspected[0]?.Mounts).toEqual([]);
    expect(inspected[0]?.HostConfig.NetworkMode).toBe('none');
    expect(Object.keys(inspected[0]?.HostConfig.PortBindings ?? {})).toHaveLength(0);
    expect(inspected[0]?.Config.Env.some((item) => /^OPENAI_API_KEY=/i.test(item))).toBe(false);

    const browserProcesses = await docker(['exec', containerId!, 'node', '-e', String.raw`
      const fs=require('node:fs'); let chrome=0;
      for (const pid of fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x))) {
        try {
          const cmd=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0')[0];
          if (!cmd.endsWith('/chrome')) continue;
          chrome++;
          const env=fs.readFileSync('/proc/'+pid+'/environ','utf8');
          if (/(?:^|\0)OPENAI_API_KEY=/i.test(env)) process.exit(78);
        } catch (error) { if (error.code !== 'ENOENT') process.exit(78); }
      }
      if (!chrome) process.exit(78); console.log('browser-process-env-clean');
    `]);
    expect(browserProcesses).toBe('browser-process-env-clean');

    const directEgress = await docker(['exec', containerId!, 'node', '-e', String.raw`
      const net=require('node:net');
      const targets=[['1.1.1.1',443],['8.8.8.8',53],['10.0.0.1',443],['169.254.169.254',80]];
      Promise.all(targets.map(([host,port])=>new Promise(resolve=>{
        const socket=net.connect({host,port,timeout:1000});
        socket.once('connect',()=>process.exit(78));
        socket.once('error',resolve);
        socket.once('timeout',()=>{socket.destroy();resolve();});
      }))).then(()=>console.log('direct-egress-denied'));
    `]);
    expect(directEgress).toBe('direct-egress-denied');

    // This controlled request proves browser control and the approved proxy path,
    // not page content or acceptance-task behavior.
    const page = await session.context.newPage();
    const response = await page.goto(target, { waitUntil: 'commit', timeout: 30_000 });
    expect(new URL(response?.url() ?? target).origin).toBe(new URL(target).origin);
    expect(response?.status()).toBeGreaterThanOrEqual(200);
    expect(response?.status()).toBeLessThan(600);
    console.log(`P3F_EXACT_PROFILE_ALLOWED_HTTPS_STATUS=${response?.status()}`);

    // The top-level approval does not grant a second host or loopback access.
    const denied = await page.goto('http://127.0.0.1:65534/p3f-unapproved', { waitUntil: 'commit' });
    expect(denied?.status()).toBe(403);
    console.log(`P3F_EXACT_PROFILE_DENIED_LOOPBACK_STATUS=${denied?.status()}`);
  } finally {
    await session?.close();
  }
  expect(containerId).toBeTruthy();
  expect(await docker(['ps', '-a', '--filter', `id=${containerId!}`, '--format', '{{.ID}}'])).toBe('');
  expect(await residualContainers()).toBe('');
  console.log(`P3F_EXACT_PROFILE=${reference.id}@${reference.version}`);
  console.log(`P3F_EXACT_PROFILE_FINGERPRINT=${effective.fingerprint}`);
});


test('G1 exact approved profile closes after a bounded browser timeout', async () => {
  const config = parseTrustedLocalConfiguration(JSON.parse(await readFile(
    trustedConfigPath!, 'utf8')) as unknown);
  const approval = config.publicTargetApproval!;
  const factory = new ProtectedContextFactory(new ProfileCatalog(config.profiles, config.networkPolicies),
    undefined, publicTargetGate(approval));
  let session: Awaited<ReturnType<typeof factory.open>> | undefined;
  let containerId: string | undefined;
  try {
    session = await factory.open(approval.executionProfileRef);
    containerId = session.isolationContainerId;
    const page = await session.context.newPage();
    const neverUrl = new URL(approval.targetUrl);
    neverUrl.searchParams.set('p3f-timeout-never', '1');
    await expect(page.waitForURL(neverUrl.href, { timeout: 25 })).rejects.toThrow();
  } finally {
    await session?.close();
  }
  expect(containerId).toMatch(/^[a-f0-9]{64}$/);
  expect(await docker(['ps', '-a', '--filter', `id=${containerId!}`, '--format', '{{.ID}}'])).toBe('');
  expect(await residualContainers()).toBe('');
});

test('G1 exact approved profile cancellation closes its protected session', async () => {
  const configPath = trustedConfigPath!;
  const source = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  const config = parseTrustedLocalConfiguration(source);
  const approval = config.publicTargetApproval!;
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'p3f-exact-profile-'));
  const controller = new AbortController();
  let decisionStarted!: () => void;
  const started = new Promise<void>((resolve) => { decisionStarted = resolve; });
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const startDeadline = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(() => reject(new Error('P3-F exact-profile cancellation setup timed out')), 60_000);
  });
  try {
    const pending = runLocalWorkflow({
      targetUrl: approval.targetUrl,
      taskText: 'Select edit in the Iuvaret1 row.',
      executionProfileRef: approval.executionProfileRef,
    }, { ...source, artifactRoot }, { provider: { apiKey: () => undefined } }, {
      signal: controller.signal,
      modelAdapters: {
        interpretationModel: { complete: async () => JSON.stringify({ kind: 'test_spec', steps: [{
          id: 's1', type: 'click', sourceText: 'Select edit in the Iuvaret1 row.', target: { description: 'edit' },
        }] }) },
        stepDecisionModel: { complete: async () => {
          decisionStarted();
          return new Promise<string>(() => undefined);
        } },
      },
    });
    await Promise.race([started, startDeadline]);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' } satisfies Partial<LocalWorkflowError>);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    await rm(artifactRoot, { recursive: true, force: true });
  }
  expect(await residualContainers()).toBe('');
});
