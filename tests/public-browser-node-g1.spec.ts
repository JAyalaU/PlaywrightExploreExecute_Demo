import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { McpExplorationSession } from '../app/exploration/mcp.js';
import { runLocalWorkflow } from '../app/local/workflow.js';
import { ProfileCatalog, ProtectedContextFactory } from '../app/profile/index.js';
import { replayTwice } from '../app/runner/run.js';

const run = promisify(execFile);
const ref = { id: 'g1-isolated-fixture', version: '2' };

async function docker(args: string[]): Promise<string> {
  const result = await run('docker', args, { timeout: 15_000, maxBuffer: 1_048_576, windowsHide: true });
  return result.stdout.trim();
}

function catalog(port: number, isolated: boolean): ProfileCatalog {
  return new ProfileCatalog([{
    ...isolated ? { profileSchemaVersion: '3', presentationMode: 'headless', browserIsolation: 'docker' } : {},
    id: ref.id, version: isolated ? ref.version : '1',
    browser: 'chromium', viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 7000, navigationMs: 7000, waits: { default: 5000 } },
    networkPolicyRef: { id: 'g1-fixture-policy', version: '1' },
  }], [{ id: 'g1-fixture-policy', version: '1',
    destinations: [{ host: '127.0.0.1', ports: [port], addresses: ['127.0.0.1'] }] }]);
}

async function fixture() {
  const server = http.createServer((request, response) => {
    if (request.url === '/slow') return;
    response.setHeader('content-type', 'text/html');
    response.end('<button>Save</button><p>Fixture reached through approved proxy</p>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
  return { url: `http://127.0.0.1:${address.port}/`, port: address.port,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test('G1 public profile version is isolated and prior profile fingerprints retain their meaning', async () => {
  const original = catalog(4173, false).resolve({ id: ref.id, version: '1' });
  const isolated = catalog(4173, true).resolve(ref);
  expect(original.fingerprint).not.toBe(isolated.fingerprint);
  expect(original.profile).not.toHaveProperty('browserIsolation');
  expect(isolated.profile).toMatchObject({ profileSchemaVersion: '3', browserIsolation: 'docker', presentationMode: 'headless' });
  const external = new ProfileCatalog([{
    id: 'external-legacy', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: { default: 5000 } },
    networkPolicyRef: { id: 'external-policy', version: '1' },
  }], [{ id: 'external-policy', version: '1',
    destinations: [{ host: 'public.example', ports: [443], addresses: ['93.184.215.14'] }] }]);
  const factory = new ProtectedContextFactory(external, undefined, { authorize: async () => {} });
  await expect(factory.open({ id: 'external-legacy', version: '1' }))
    .rejects.toThrow('isolated public browser profile');
});

test('G1 cancellation disposes an active isolated exploration browser', async () => {
  test.skip(process.env.PUBLIC_BROWSER_G1_RUNTIME !== '1', 'Manual Docker Desktop runtime proof');
  test.setTimeout(60_000);
  const served = await fixture();
  const artifacts = await mkdtemp(path.join(tmpdir(), 'g1-cancel-'));
  const controller = new AbortController();
  let decisionStarted!: () => void;
  const started = new Promise<void>((resolve) => { decisionStarted = resolve; });
  const configuration = {
    profiles: [{ ...ref, profileSchemaVersion: '3', presentationMode: 'headless', browserIsolation: 'docker',
      browser: 'chromium', viewport: { width: 900, height: 600 }, locale: 'en-US',
      timeoutPolicy: { actionMs: 7000, navigationMs: 7000, waits: { default: 5000 } },
      networkPolicyRef: { id: 'g1-fixture-policy', version: '1' } }],
    networkPolicies: [{ id: 'g1-fixture-policy', version: '1',
      destinations: [{ host: '127.0.0.1', ports: [served.port], addresses: ['127.0.0.1'] }] }],
    evidencePolicy: { finalScreenshot: false, failureScreenshot: false, failureTrace: false,
      failureVideo: false, sensitiveBinaryApproved: false },
    artifactRoot: artifacts, retentionDays: 1,
  };
  try {
    const pending = runLocalWorkflow({ targetUrl: served.url, taskText: 'Select Save.', executionProfileRef: ref },
      configuration, { provider: { apiKey: () => undefined } }, {
        signal: controller.signal,
        modelAdapters: {
          interpretationModel: { complete: async () => JSON.stringify({ kind: 'test_spec', steps: [
            { id: 's1', type: 'click', sourceText: 'Select Save.', target: { description: 'Save' } },
          ] }) },
          stepDecisionModel: { complete: async () => {
            decisionStarted();
            return new Promise<string>(() => undefined);
          } },
        },
      });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await docker(['ps', '-a', '--filter', 'name=public-browser-g1-', '--format', '{{.ID}}'])).toBe('');
  } finally {
    await served.close();
    await rm(artifacts, { recursive: true, force: true });
  }
});

test('G1 Docker runtime proves private control, existing proxy, descendant isolation and disposal', async () => {
  test.skip(process.env.PUBLIC_BROWSER_G1_RUNTIME !== '1', 'Manual Docker Desktop runtime proof');
  test.setTimeout(180_000);
  const served = await fixture();
  const profileCatalog = catalog(served.port, true);
  class TrackingFactory extends ProtectedContextFactory {
    readonly ids: string[] = [];
    override async open(...args: Parameters<ProtectedContextFactory['open']>) {
      const session = await super.open(...args);
      if (session.isolationContainerId) this.ids.push(session.isolationContainerId);
      return session;
    }
  }
  const factory = new TrackingFactory(profileCatalog);
  let session: Awaited<ReturnType<typeof factory.open>> | undefined;
  try {
    console.log('G1_NODE_PROOF_STAGE=opening');
    session = await factory.open(ref);
    console.log('G1_NODE_PROOF_STAGE=opened');
    const id = session.isolationContainerId;
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    const inspect = JSON.parse(await docker(['inspect', id!])) as [{ Mounts: unknown[]; Config: { Env: string[] }; HostConfig: { NetworkMode: string; PortBindings: unknown } }];
    expect(inspect[0]?.Mounts).toEqual([]);
    expect(inspect[0]?.HostConfig.NetworkMode).toBe('none');
    expect(Object.keys(inspect[0]?.HostConfig.PortBindings ?? {})).toHaveLength(0);
    expect(inspect[0]?.Config.Env.some((value) => /^OPENAI_API_KEY=/i.test(value))).toBe(false);
    console.log('G1_NODE_PROOF_STAGE=inspected');
    const processProof = await docker(['exec', id!, 'node', '-e', String.raw`
      const fs=require('node:fs');
      const pids=fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x)); let found=0;
      for(const pid of pids){
        try {
          const cmd=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0')[0];
          if(!cmd.endsWith('/chrome'))continue;
          found++;
          const env=fs.readFileSync('/proc/'+pid+'/environ','utf8');
          if(/(?:^|\0)OPENAI_API_KEY=/i.test(env))process.exit(78);
        } catch(error) { if(error.code!=='ENOENT')process.exit(78); }
      }
      if(!found)process.exit(78); console.log('browser-descendants-clean');
    `]);
    expect(processProof).toBe('browser-descendants-clean');
    console.log('G1_NODE_PROOF_STAGE=descendants');
    const direct = await docker(['exec', id!, 'node', '-e', String.raw`
      const net=require('node:net');
      const targets=[['1.1.1.1',443],['10.0.0.1',443],['169.254.169.254',80],['8.8.8.8',53]];
      Promise.all(targets.map(([host,port])=>new Promise(resolve=>{
        const s=net.connect({host,port,timeout:1000});
        s.once('connect',()=>process.exit(78)); s.once('error',resolve);
        s.once('timeout',()=>{s.destroy();resolve()});
      }))).then(()=>console.log('direct-denied'));
    `]);
    expect(direct).toBe('direct-denied');
    console.log('G1_NODE_PROOF_STAGE=direct-denied');
    const page = await session.context.newPage();
    expect((await page.goto(served.url))?.status()).toBe(200);
    expect(await page.getByRole('button', { name: 'Save' }).count()).toBe(1);
    expect((await page.goto('http://127.0.0.1:4444/denied'))?.status()).toBe(403);
    await expect(page.goto(`${served.url}slow`, { timeout: 250 })).rejects.toThrow();
    await session.close(); session = undefined;
    console.log('G1_NODE_PROOF_STAGE=initial-disposed');
    expect(await docker(['ps', '-a', '--filter', `id=${id}`, '--format', '{{.ID}}'])).toBe('');

    const mcp = await McpExplorationSession.open(factory, ref, profileCatalog.resolve(ref));
    try {
      await mcp.navigate(served.url);
      expect(await mcp.snapshot()).toContain('Save');
    } finally { await mcp.close(); }
    console.log('G1_NODE_PROOF_STAGE=mcp-disposed');

    const source = {
      schemaVersion: '2', testSpecId: 'g1-controlled', sourceInstruction: 'Open the local fixture and check its URL',
      executionProfileRef: ref, startState: { url: served.url },
      steps: [{ id: 'step1', type: 'assert_url', sourceText: 'Check the URL', expectedUrl: served.url, match: 'exact' }],
    };
    const resolved = {
      schemaVersion: '2', resolvedSpecId: 'g1-resolved', testSpecId: 'g1-controlled',
      explorationAttemptId: 'g1-attempt', executionProfileRef: ref,
      runtimeVersions: { playwright: '1.63.0', mcp: '0.0.82', runner: '1' },
      executionSteps: [{ id: 'x1', originStepId: 'step1', source: 'authored', type: 'assert_url',
        expectedUrl: served.url, match: 'exact', derivationEvidenceRef: 'g1-proof' }],
    };
    const replay = await replayTwice(factory, source, resolved);
    console.log('G1_NODE_PROOF_STAGE=replayed');
    expect(replay.map((item) => item.outcomes.at(-1)?.status)).toEqual(['QA_ASSERTION_PASSED', 'QA_ASSERTION_PASSED']);
    expect(replay[0].executionRunId).not.toBe(replay[1].executionRunId);
    expect(replay[0].effectiveProfile.fingerprint).toBe(replay[1].effectiveProfile.fingerprint);
    expect(factory.ids).toHaveLength(4);
    for (const container of factory.ids) expect(await docker(['ps', '-a', '--filter', `id=${container}`, '--format', '{{.ID}}'])).toBe('');
  } finally {
    await session?.close();
    await served.close();
  }
});
