import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { parseResolvedTestSpec, parseTestSpec, type ResultRecord } from '../app/domain/index.js';
import { executeAndStoreRun, EvidenceRedactor, LocalArtifactStore, readStoredJobReport } from '../app/evidence/index.js';
import { acceptGeneratedLocator } from '../app/locator/index.js';
import { ProfileCatalog, ProtectedContextFactory } from '../app/profile/index.js';

async function fixtureServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

function browser(port: number) {
  const catalog = new ProfileCatalog([{
    id: 'desktop', version: '1', browser: 'chromium', viewport: { width: 800, height: 600 },
    locale: 'en-US', timeoutPolicy: { actionMs: 150, navigationMs: 3000, waits: { default: 150 } },
    networkPolicyRef: { id: 'fixture-policy', version: '1' },
  }], [{ id: 'fixture-policy', version: '1', destinations: [{ host: '127.0.0.1', ports: [port], addresses: ['127.0.0.1'] }] }]);
  return { factory: new ProtectedContextFactory(catalog), profile: catalog.resolve({ id: 'desktop', version: '1' }) };
}

async function preparedJob(store: LocalArtifactStore, baseUrl: string, profile: ReturnType<typeof browser>['profile']) {
  const source = parseTestSpec({
    schemaVersion: '2', testSpecId: 'testm5', sourceInstruction: 'Open the page and verify Save is visible',
    executionProfileRef: { id: 'desktop', version: '1' }, startState: { url: 'about:blank' },
    steps: [
      { id: 's1', type: 'navigate', url: `${baseUrl}/page`, sourceText: 'Open the page' },
      { id: 's2', type: 'assert_visible', target: { description: 'Save' }, sourceText: 'Verify Save is visible' },
    ],
  });
  await store.createJob(source, profile);
  const e1 = await store.writeEvidence(source.testSpecId, {
    evidenceId: 'derive1', owner: { kind: 'attempt', id: 'explorem5' }, mediaType: 'application/json',
    content: { observed: 'Navigation requested' }, originStepId: 's1', executionStepId: 'x1',
  });
  const e2 = await store.writeEvidence(source.testSpecId, {
    evidenceId: 'derive2', owner: { kind: 'attempt', id: 'explorem5' }, mediaType: 'application/json',
    content: { observed: 'Save button' }, originStepId: 's2', executionStepId: 'x2', locatorId: 'locsave',
  });
  await store.writeAttempt({
    schemaVersion: '2', testSpecId: source.testSpecId, explorationAttemptId: 'explorem5',
    executionProfileRef: source.executionProfileRef, profileFingerprint: profile.fingerprint,
    runtimeVersions: { node: process.version, playwright: '1.63.0', browser: 'fixture', mcp: 'fixture' },
    status: 'resolved',
    startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z',
    results: [], evidenceRefs: [e1.ref, e2.ref],
  });
  const resolved = parseResolvedTestSpec({
    schemaVersion: '2', resolvedSpecId: 'resolvedm5', testSpecId: source.testSpecId,
    explorationAttemptId: 'explorem5', executionProfileRef: source.executionProfileRef,
    runtimeVersions: { playwright: '1.63.0', mcp: 'fixture', runner: '1' },
    executionSteps: [
      { id: 'x1', originStepId: 's1', source: 'authored', type: 'navigate', url: `${baseUrl}/page`, derivationEvidenceRef: e1.ref },
      { id: 'x2', originStepId: 's2', source: 'authored', type: 'assert_visible',
        locatorId: 'locsave', targetDescription: 'Save',
        locator: acceptGeneratedLocator("getByRole('button', { name: 'Save' })", {
          matchCount: 1, observedTargetMatches: true, role: 'button', accessibleName: 'Save',
        }), derivationEvidenceRef: e2.ref },
    ],
  }, source);
  await store.writeResolved(resolved);
  return { source, resolved, e1, e2 };
}

test('M5-A survives restart and rejects duplicate IDs, broken links, and unsafe contract literals', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-m5-store-'));
  try {
    const { profile } = browser(41300);
    const store = new LocalArtifactStore(directory, new EvidenceRedactor(['never-persist-me']));
    const { source, resolved, e1 } = await preparedJob(store, 'http://127.0.0.1:41300', profile);
    await expect(store.createJob(source, profile)).rejects.toThrow();
    await expect(store.writeAttempt({
      schemaVersion: '2', testSpecId: source.testSpecId, explorationAttemptId: 'explorem5',
      executionProfileRef: source.executionProfileRef, profileFingerprint: profile.fingerprint,
      runtimeVersions: { node: process.version, playwright: '1.63.0', browser: 'fixture', mcp: 'fixture' },
      status: 'resolved',
      startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', results: [], evidenceRefs: [],
    })).rejects.toThrow();
    await expect(store.writeResolved(resolved)).rejects.toThrow('already has a resolved artifact');
    await expect(store.writeEvidence(source.testSpecId, {
      evidenceId: 'derive1', owner: { kind: 'attempt', id: 'explorem5' }, mediaType: 'application/json', content: {},
    })).rejects.toThrow();
    await expect(store.writeEvidence(source.testSpecId, {
      evidenceId: 'binary', owner: { kind: 'run', id: 'runm5' }, mediaType: 'image/png', content: new Uint8Array([1]),
    })).rejects.toThrow('approval');
    const restarted = new LocalArtifactStore(directory);
    expect((await restarted.readJob(source.testSpecId)).source).toEqual(source);
    expect((await restarted.readEvidence(source.testSpecId, e1.ref)).owner.id).toBe('explorem5');
    expect((await restarted.readResolved(source.testSpecId, resolved.resolvedSpecId)).resolvedSpecId).toBe('resolvedm5');
    const pending = await readdir(path.join(directory, source.testSpecId, 'attempts'));
    expect(pending.every((name) => !name.startsWith('.pending-'))).toBe(true);
    expect((await readdir(directory)).every((name) => !name.startsWith('.pending-'))).toBe(true);
    const unsafe = { ...source, testSpecId: 'unsafe', sourceInstruction: 'never-persist-me' };
    await expect(store.createJob(unsafe, profile)).rejects.toThrow('sensitive literal');
    await writeFile(path.join(directory, source.testSpecId, ...e1.ref.split('/')), 'altered evidence');
    await expect(readStoredJobReport(restarted, source.testSpecId)).rejects.toThrow('integrity');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('M5-B/C captures a failed run and rebuilds its typed report without a browser', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-m5-capture-'));
  const server = await fixtureServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<html><body><button>Other</button><script>history.replaceState({}, "", "/page?token=secret-url-value")</script></body></html>');
  });
  try {
    const { factory, profile } = browser(server.port);
    const store = new LocalArtifactStore(directory, new EvidenceRedactor(['secret-url-value']));
    const { source, resolved } = await preparedJob(store, server.url, profile);
    const run = await executeAndStoreRun(factory, store, source.testSpecId, resolved.resolvedSpecId, 'runm5', {
      finalScreenshot: true, failureScreenshot: true, failureTrace: true, failureVideo: true,
      sensitiveBinaryApproved: true,
    });
    expect(run.outcomes.map((outcome) => outcome.status)).toEqual(['OPERATION_SUCCEEDED', 'QA_ASSERTION_FAILED']);
    expect(run.outcomes[1]).toMatchObject({ reason: 'NO_MATCH', executionStepId: 'x2', locatorId: 'locsave' });
    const restarted = new LocalArtifactStore(directory);
    const report = await readStoredJobReport(restarted, source.testSpecId);
    expect(report.attempts).toHaveLength(1);
    expect(report.resolvedSpecs).toHaveLength(1);
    expect(report.runs).toHaveLength(1);
    expect(report.byOriginStep[1]?.executionSteps[0]?.outcomes[0]?.status).toBe('QA_ASSERTION_FAILED');
    expect(report.evidence.map((item) => item.mediaType)).toEqual(expect.arrayContaining([
      'application/json', 'image/png', 'application/zip', 'video/webm',
    ]));
    expect(report.evidence.filter((item) => item.mediaType === 'application/zip' || item.mediaType === 'video/webm')
      .every((item) => item.sensitivity === 'restricted')).toBe(true);
    const runMetadata = report.evidence.filter((item) => item.owner.kind === 'run' && item.mediaType === 'application/json');
    expect(runMetadata).toHaveLength(2);
    for (const descriptor of runMetadata) {
      const storedMetadata = await readFile(path.join(directory, source.testSpecId, ...descriptor.ref.split('/')), 'utf8');
      expect(storedMetadata).not.toContain('secret-url-value');
    }
    await expect(restarted.writeRun(source.testSpecId, resolved.resolvedSpecId, run)).rejects.toThrow();
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('M5-B captures only redacted metadata when browser binaries are disabled', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-m5-success-'));
  const server = await fixtureServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<html><body><button>Save</button></body></html>');
  });
  try {
    const { factory, profile } = browser(server.port);
    const store = new LocalArtifactStore(directory);
    const { source, resolved } = await preparedJob(store, server.url, profile);
    const run = await executeAndStoreRun(factory, store, source.testSpecId, resolved.resolvedSpecId, 'runpass', {
      finalScreenshot: false, failureScreenshot: false, failureTrace: false, failureVideo: false,
      sensitiveBinaryApproved: false,
    });
    expect(run.outcomes.map((item) => item.status)).toEqual(['OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED']);
    const report = await readStoredJobReport(new LocalArtifactStore(directory), source.testSpecId);
    expect(report.evidence.filter((item) => item.owner.kind === 'run').map((item) => item.mediaType))
      .toEqual(['application/json', 'application/json']);
    expect(report.runs[0]?.outcomes[1]?.status).toBe('QA_ASSERTION_PASSED');
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('M5-C preserves binding failures and rejects cross-run evidence links', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-m5-report-'));
  try {
    const { profile } = browser(41301);
    const store = new LocalArtifactStore(directory);
    const { source, resolved } = await preparedJob(store, 'http://127.0.0.1:41301', profile);
    const now = new Date().toISOString();
    const result = (stepId: string, originStepId: string, status: ResultRecord['status'], locatorId?: string): ResultRecord => ({
      phase: 'execution', status, testSpecId: source.testSpecId, resolvedSpecId: resolved.resolvedSpecId,
      explorationAttemptId: resolved.explorationAttemptId, executionRunId: 'runbinding',
      executionProfileRef: source.executionProfileRef, originStepId, executionStepId: stepId,
      ...(locatorId ? { locatorId } : {}), reason: status === 'LOCATOR_BINDING_FAILED' ? 'NO_MATCH' : undefined,
      retryable: false, startedAt: now, finishedAt: now, evidenceRefs: [],
    } as ResultRecord);
    const effectiveRun = { executionRunId: 'runbinding', effectiveProfile: profile,
      versions: { node: process.version, playwright: '1.63.0', browser: 'fixture' },
      outcomes: [result('x1', 's1', 'OPERATION_SUCCEEDED'), result('x2', 's2', 'LOCATOR_BINDING_FAILED', 'locsave')],
    };
    await store.writeRun(source.testSpecId, resolved.resolvedSpecId, effectiveRun);
    const report = await readStoredJobReport(new LocalArtifactStore(directory), source.testSpecId);
    expect(report.runs[0]?.outcomes[1]).toMatchObject({ status: 'LOCATOR_BINDING_FAILED', reason: 'NO_MATCH' });
    const foreign = await store.writeEvidence(source.testSpecId, {
      evidenceId: 'foreign', owner: { kind: 'run', id: 'otherrun' }, mediaType: 'application/json', content: {},
    });
    const invalid = { ...effectiveRun, executionRunId: 'runother', outcomes: effectiveRun.outcomes.map((outcome) => ({
      ...outcome, executionRunId: 'runother', evidenceRefs: outcome.executionStepId === 'x2' ? [foreign.ref] : [],
    })) };
    await expect(store.writeRun(source.testSpecId, resolved.resolvedSpecId, invalid)).rejects.toThrow('correlation');
    expect(await store.listIds(source.testSpecId, 'runs')).toEqual(['runbinding']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
