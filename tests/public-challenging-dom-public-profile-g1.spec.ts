import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { parseTrustedLocalConfiguration } from '../app/local/contracts.js';
import { LocalWorkflowError, runLocalWorkflow } from '../app/local/workflow.js';
import { ProtectedContextFactory, ProtectedProxy, ProfileCatalog, publicTargetGate } from '../app/profile/index.js';
import { CHALLENGING_DOM_URL } from '../app/profile/public-target.js';
import { IsolatedBrowser } from '../app/profile/isolated-browser.js';

const exec = promisify(execFile);
// This is the fingerprint-bound production profile for the qualified
// replacement target. It permits only the reviewed origin.
const reference = { id: 'challenging-dom-public-headless', version: '1' };
const sentinel = 'g1-public-profile-non-secret-sentinel';
let allowedPublicConnectivity = false;

function trustedPublicConfiguration(): ReturnType<typeof parseTrustedLocalConfiguration> {
  return parseTrustedLocalConfiguration(JSON.parse(
    readFileSync('config/public-challenging-dom.json', 'utf8'),
  ) as unknown);
}

function trustedPublicConfigurationInput(artifactRoot?: string): unknown {
  const input = JSON.parse(readFileSync(
    'config/public-challenging-dom.json', 'utf8',
  )) as Record<string, unknown>;
  if (artifactRoot) input.artifactRoot = artifactRoot;
  return input;
}

async function docker(args: string[]): Promise<string> {
  const result = await exec('docker', args, { timeout: 15_000, maxBuffer: 1_048_576, windowsHide: true });
  return result.stdout.trim();
}

async function removeStaleProofContainers(): Promise<void> {
  const containers = await docker(['ps', '-a', '--filter', 'name=public-browser-g1-', '--format', '{{.ID}}']);
  const ids = containers.split(/\r?\n/).filter(Boolean);
  // A prior interrupted manual proof can leave only this test-owned prefix.
  // Remove it before the run so the session-specific disposal assertion below
  // cannot confuse an old artifact with the container it just opened.
  for (const id of ids) await docker(['rm', '-f', id]);
  if (ids.length) console.log(`G1_PUBLIC_PROFILE_SETUP_CLEANED_STALE_CONTAINERS=${ids.length}`);
  expect(await docker(['ps', '-a', '--filter', 'name=public-browser-g1-', '--format', '{{.ID}}'])).toBe('');
}

async function expectDisposed(containerId: string | undefined): Promise<void> {
  expect(containerId).toMatch(/^[a-f0-9]{64}$/);
  expect(await docker(['ps', '-a', '--filter', `id=${containerId!}`, '--format', '{{.ID}}'])).toBe('');
}

function publicFactory(): { configuration: ReturnType<typeof trustedPublicConfiguration>; factory: ProtectedContextFactory } {
  const configuration = trustedPublicConfiguration();
  const catalog = new ProfileCatalog(configuration.profiles, configuration.networkPolicies);
  return { configuration, factory: new ProtectedContextFactory(catalog, undefined,
    publicTargetGate(configuration.publicTargetApproval!)) };
}

test.beforeEach(async () => {
  if (process.env.PUBLIC_BROWSER_G1_RUNTIME === '1') await removeStaleProofContainers();
});

// The cancellation proof deliberately waits for a real active public session.
// Keep this file ordered so a blocked upstream cannot turn into a misleading
// setup timeout in that later test.
test.describe.configure({ mode: 'serial' });

/** Runtime tests own this reserved prefix. Always clear it, even after a failed assertion. */
test.afterEach(async () => {
  if (process.env.PUBLIC_BROWSER_G1_RUNTIME !== '1') return;
  await removeStaleProofContainers();
});

/** This never navigates the candidate site: it proves the exact reviewed launch boundary first. */
test('G1 replacement profile proves isolated private control, no credential sentinel, denied direct egress, and disposal', async () => {
  test.skip(process.env.PUBLIC_BROWSER_G1_RUNTIME !== '1', 'Manual Docker Desktop runtime proof');
  test.setTimeout(90_000);
  const configuration = trustedPublicConfiguration();
  const catalog = new ProfileCatalog(configuration.profiles, configuration.networkPolicies);
  const effective = catalog.resolve(reference);
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = sentinel;
  const factory = new ProtectedContextFactory(catalog, undefined, publicTargetGate(configuration.publicTargetApproval!));
  let session: Awaited<ReturnType<typeof factory.open>> | undefined;
  let containerId: string | undefined;
  try {
    session = await factory.open(reference, effective);
    expect(session.effectiveProfile.fingerprint).toBe(configuration.publicTargetApproval?.profileFingerprint);
    containerId = session.isolationContainerId;
    expect(containerId).toMatch(/^[a-f0-9]{64}$/);

    const inspect = JSON.parse(await docker(['inspect', containerId!])) as [{
      Mounts: unknown[];
      Config: { Env: string[] };
      HostConfig: { NetworkMode: string; PortBindings: unknown };
    }];
    expect(inspect[0]?.Mounts).toEqual([]);
    expect(inspect[0]?.HostConfig.NetworkMode).toBe('none');
    expect(Object.keys(inspect[0]?.HostConfig.PortBindings ?? {})).toHaveLength(0);
    expect(inspect[0]?.Config.Env.join('\n')).not.toContain(sentinel);
    expect(inspect[0]?.Config.Env.some((item) => /^OPENAI_API_KEY=/i.test(item))).toBe(false);

    const descendants = await docker(['exec', containerId!, 'node', '-e', String.raw`
      const fs=require('node:fs'); let chrome=0;
      for (const pid of fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x))) {
        try {
          const cmd=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0')[0];
          if (!cmd.endsWith('/chrome')) continue;
          chrome++;
          const env=fs.readFileSync('/proc/'+pid+'/environ','utf8');
          if (/(?:^|\0)OPENAI_API_KEY=/i.test(env) || env.includes('${sentinel}')) process.exit(78);
        } catch (error) { if (error.code !== 'ENOENT') process.exit(78); }
      }
      if (!chrome) process.exit(78); console.log('public-browser-descendants-clean');
    `]);
    expect(descendants).toBe('public-browser-descendants-clean');

    const direct = await docker(['exec', containerId!, 'node', '-e', String.raw`
      const net=require('node:net');
      const targets=[['1.1.1.1',443],['10.0.0.1',443],['169.254.169.254',80],['8.8.8.8',53]];
      Promise.all(targets.map(([host,port])=>new Promise(resolve=>{
        const socket=net.connect({host,port,timeout:1000});
        socket.once('connect',()=>process.exit(78));
        socket.once('error',resolve);
        socket.once('timeout',()=>{socket.destroy();resolve();});
      }))).then(()=>console.log('public-direct-egress-denied'));
    `]);
    expect(direct).toBe('public-direct-egress-denied');

    // The session's startup probe has already established that a browser request
    // to an unapproved loopback target is answered by the proxy with 403.
    const page = await session.context.newPage();
    const denied = await page.goto('http://127.0.0.1:65534/g1-public-denied');
    expect(denied?.status()).toBe(403);
  } finally {
    await session?.close();
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
  // This validates normal production cleanup of the exact session. The broad
  // afterEach sweep is only a failure-path safety net.
  expect(await docker(['ps', '-a', '--filter', `id=${containerId!}`, '--format', '{{.ID}}'])).toBe('');
});

test('G1 fails closed before browser launch if the authoritative proxy is unavailable', async () => {
  const configuration = trustedPublicConfiguration();
  const effective = new ProfileCatalog(configuration.profiles, configuration.networkPolicies).resolve(reference);
  const proxy = await ProtectedProxy.start(effective.policy);
  await proxy.close();
  await expect(IsolatedBrowser.open(proxy)).rejects.toThrow('Proxy is closed');
});

/**
 * This makes exactly one approved HTTPS navigation. It proves transport through
 * the reviewed proxy, not page content, link count, or the acceptance claim.
 */
test('G1 replacement profile reaches the approved host through the proxy and disposes after a controlled failure', async () => {
  test.skip(process.env.PUBLIC_BROWSER_G1_RUNTIME !== '1', 'Manual Docker Desktop runtime proof');
  test.setTimeout(90_000);
  const { configuration, factory } = publicFactory();
  const expected = factory.catalog.resolve(reference);
  let session: Awaited<ReturnType<typeof factory.open>> | undefined;
  let containerId: string | undefined;
  let controlledFailure = false;
  try {
    session = await factory.open(reference, expected);
    containerId = session.isolationContainerId;
    const response = await (await session.context.newPage()).goto(CHALLENGING_DOM_URL, { waitUntil: 'commit' });
    expect(new URL(response?.url() ?? CHALLENGING_DOM_URL).hostname).toBe('the-internet.herokuapp.com');
    // This proves CONNECT, TLS and HTTP through the approved proxy. It does
    // not inspect the table or execute the replacement acceptance scenario.
    expect(response?.status()).toBeGreaterThanOrEqual(200);
    expect(response?.status()).toBeLessThan(600);
    console.log(`G1_PUBLIC_ALLOWED_HTTPS_STATUS=the-internet.herokuapp.com:${response?.status()}`);
    allowedPublicConnectivity = true;
    throw new Error('G1_CONTROLLED_POST_CONNECT_FAILURE');
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'G1_CONTROLLED_POST_CONNECT_FAILURE') throw error;
    controlledFailure = true;
  } finally {
    await session?.close();
  }
  expect(controlledFailure).toBe(true);
  expect(await docker(['ps', '-a', '--filter', `id=${containerId!}`, '--format', '{{.ID}}'])).toBe('');
  expect(configuration.publicTargetApproval?.profileFingerprint).toBe(expected.fingerprint);
});

test('G1 replacement profile disposes after a bounded browser timeout', async () => {
  test.skip(process.env.PUBLIC_BROWSER_G1_RUNTIME !== '1', 'Manual Docker Desktop runtime proof');
  test.setTimeout(90_000);
  const { factory } = publicFactory();
  let session: Awaited<ReturnType<typeof factory.open>> | undefined;
  let containerId: string | undefined;
  try {
    session = await factory.open(reference);
    containerId = session.isolationContainerId;
    const page = await session.context.newPage();
    await expect(page.waitForURL(`${CHALLENGING_DOM_URL}?g1-timeout-never`, { timeout: 25 })).rejects.toThrow();
  } finally {
    await session?.close();
  }
  await expectDisposed(containerId);
});

/** Cancellation uses the production local-workflow cleanup path with injected models only. */
test('G1 replacement profile cancellation disposes its active protected session', async () => {
  test.skip(process.env.PUBLIC_BROWSER_G1_RUNTIME !== '1', 'Manual Docker Desktop runtime proof');
  test.skip(!allowedPublicConnectivity, 'Allowed public transport proof did not pass; cancellation setup is intentionally not attempted');
  test.setTimeout(120_000);
  const artifacts = await mkdtemp(path.join(tmpdir(), 'g1-public-cancel-'));
  const controller = new AbortController();
  let decisionStarted!: () => void;
  const started = new Promise<void>((resolve) => { decisionStarted = resolve; });
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const startDeadline = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(() => reject(new Error('G1 cancellation setup timed out')), 60_000);
  });
  try {
    const pending = runLocalWorkflow({
      targetUrl: CHALLENGING_DOM_URL,
      taskText: 'Select edit in the Iuvaret1 row.',
      executionProfileRef: reference,
    }, trustedPublicConfigurationInput(artifacts), { provider: { apiKey: () => undefined } }, {
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
    await rm(artifacts, { recursive: true, force: true });
  }
  expect(await docker(['ps', '-a', '--filter', 'name=public-browser-g1-', '--format', '{{.ID}}'])).toBe('');
});
