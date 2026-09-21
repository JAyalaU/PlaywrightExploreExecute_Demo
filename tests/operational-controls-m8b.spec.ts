import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { LocalArtifactStore, EvidenceRedactor } from '../app/evidence/index.js';
import { ProfileCatalog, ProtectedContextFactory, ProtectedProxy } from '../app/profile/index.js';
import { makeTestSpec } from './fixtures/domain.js';

function fixture(port: number, auth = false) {
  const profile = {
    id: 'desktop', version: '1', browser: 'chromium' as const,
    viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 3000, navigationMs: 3000, waits: { default: 3000 } },
    networkPolicyRef: { id: 'local', version: '1' },
    ...(auth ? { authStateRef: { id: 'protected-user', version: '1' } } : {}),
  };
  const policy = { id: 'local', version: '1', destinations: [{ host: '127.0.0.1', ports: [port], addresses: ['127.0.0.1'] }] };
  const catalog = new ProfileCatalog([profile], [policy]);
  return { catalog, effective: catalog.resolve({ id: 'desktop', version: '1' }) };
}

test('M8-B keeps external destinations behind a review gate before opening a browser or loading auth', async () => {
  const profile = {
    id: 'desktop', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 3000, navigationMs: 3000, waits: { default: 3000 } },
    networkPolicyRef: { id: 'external', version: '1' }, authStateRef: { id: 'protected-user', version: '1' },
  };
  const policy = { id: 'external', version: '1', destinations: [{ host: 'example.test', ports: [443], addresses: ['203.0.113.1'] }] };
  const catalog = new ProfileCatalog([profile], [policy]);
  const reference = { id: 'desktop', version: '1' };
  let authLoads = 0;
  const authProvider = { load: async () => { authLoads++; return { cookies: [], origins: [] }; } };
  await expect(new ProtectedContextFactory(catalog, authProvider).open(reference))
    .rejects.toThrow('security-review approval');
  let reviews = 0;
  const rejectingGate = { authorize: async () => { reviews++; throw new Error('Security review denied'); } };
  await expect(new ProtectedContextFactory(catalog, authProvider, rejectingGate).open(reference))
    .rejects.toThrow('Security review denied');
  expect(reviews).toBe(1);
  expect(authLoads).toBe(0);
});

test('M8-B has no direct-network fallback after the protected proxy closes', async () => {
  let hits = 0;
  const server = createServer((_request, response) => { hits++; response.end('ok'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  const { catalog } = fixture(address.port);
  const originalStart = ProtectedProxy.start;
  let protectedProxy: ProtectedProxy | undefined;
  ProtectedProxy.start = async (policy) => {
    protectedProxy = await originalStart(policy);
    return protectedProxy;
  };
  try {
    const session = await new ProtectedContextFactory(catalog).open({ id: 'desktop', version: '1' });
    try {
      const proxy = protectedProxy;
      if (!proxy) throw new Error('Protected proxy was not created');
      await proxy.close();
      const page = await session.context.newPage();
      await expect(page.goto(`http://127.0.0.1:${address.port}/`, { timeout: 3000 })).rejects.toThrow();
      expect(hits).toBe(0);
    } finally {
      await session.close();
      await session.close();
    }
  } finally {
    ProtectedProxy.start = originalStart;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('M8-B closes the proxy when protected auth loading fails', async () => {
  const { catalog } = fixture(43137, true);
  const originalStart = ProtectedProxy.start;
  let protectedProxy: ProtectedProxy | undefined;
  ProtectedProxy.start = async (policy) => {
    protectedProxy = await originalStart(policy);
    return protectedProxy;
  };
  try {
    const factory = new ProtectedContextFactory(catalog, { load: async () => { throw new Error('Protected auth state unavailable'); } });
    await expect(factory.open({ id: 'desktop', version: '1' })).rejects.toThrow('Protected auth state unavailable');
    const proxy = protectedProxy;
    if (!proxy) throw new Error('Protected proxy was not created');
    expect(() => proxy.url).toThrow('Proxy is closed');
  } finally { ProtectedProxy.start = originalStart; }
});

test('M8-B retains protected references, gates binary reads, and prunes only expired artifacts', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-m8b-artifacts-'));
  try {
    const { effective } = fixture(43138, true);
    const source = makeTestSpec();
    const shortStore = new LocalArtifactStore(directory, new EvidenceRedactor(['private-cookie']), 1);
    await shortStore.createJob(source, effective);
    const metadata = await shortStore.writeEvidence(source.testSpecId, {
      evidenceId: 'metadata', owner: { kind: 'run', id: 'runm8b' }, mediaType: 'application/json',
      content: { cookie: 'private-cookie', message: 'safe' },
    });
    const binary = await shortStore.writeEvidence(source.testSpecId, {
      evidenceId: 'screenshot', owner: { kind: 'run', id: 'runm8b' }, mediaType: 'image/png',
      content: Buffer.from('private-pixels'), allowSensitiveBinary: true,
    });
    const job = await shortStore.readJob(source.testSpecId);
    expect(job.profile.profile.authStateRef).toEqual({ id: 'protected-user', version: '1' });
    expect(JSON.stringify(job)).not.toContain('private-cookie');
    expect((await shortStore.readEvidenceContent(source.testSpecId, metadata.ref)).toString())
      .not.toContain('private-cookie');
    await expect(shortStore.readEvidenceContent(source.testSpecId, binary.ref))
      .rejects.toThrow('Restricted evidence access denied');
    const allowedStore = new LocalArtifactStore(directory, new EvidenceRedactor(), 1,
      { authorize: async (descriptor) => { expect(descriptor.sensitivity).toBe('restricted'); } });
    expect(Buffer.from(await allowedStore.readEvidenceContent(source.testSpecId, binary.ref)).toString())
      .toBe('private-pixels');
    const restrictedFile = path.join(directory, source.testSpecId, ...binary.ref.split('/'));
    if (process.platform !== 'win32') expect((await stat(restrictedFile)).mode & 0o077).toBe(0);
    const persisted = await readFile(path.join(directory, source.testSpecId, 'profile.json'), 'utf8');
    expect(persisted).toContain('protected-user');
    expect(persisted).not.toContain('private-cookie');

    await shortStore.writeInterpretation({
      schemaVersion: '2', testSpecId: 'rejectedm8b', sourceInstruction: 'unclear',
      executionProfileRef: source.executionProfileRef, startState: source.startState,
      outcome: 'rejected', result: {
        phase: 'interpretation', status: 'AMBIGUOUS_INSTRUCTION', testSpecId: 'rejectedm8b',
        retryable: false, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), evidenceRefs: [],
      },
    });
    const later = { ...source, testSpecId: 'freshm8b' };
    await new LocalArtifactStore(directory, new EvidenceRedactor(), 7).createJob(later, effective);
    const future = new Date(Date.now() + 2 * 86_400_000);
    expect(await shortStore.pruneExpired(future)).toEqual({ jobs: [source.testSpecId], interpretations: ['rejectedm8b'] });
    await expect(shortStore.readJob(source.testSpecId)).rejects.toThrow();
    expect((await shortStore.readJob(later.testSpecId)).source.testSpecId).toBe('freshm8b');
    expect(await shortStore.pruneExpired(future)).toEqual({ jobs: [], interpretations: [] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('M8-B rejects an exposed artifact root on permission-aware hosts', async () => {
  test.skip(process.platform === 'win32', 'Windows requires deployment ACL enforcement');
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-m8b-open-root-'));
  try {
    await chmod(directory, 0o755);
    const { effective } = fixture(43139);
    await expect(new LocalArtifactStore(directory).createJob(makeTestSpec(), effective))
      .rejects.toThrow('private directory');
  } finally {
    await chmod(directory, 0o700);
    await rm(directory, { recursive: true, force: true });
  }
});
