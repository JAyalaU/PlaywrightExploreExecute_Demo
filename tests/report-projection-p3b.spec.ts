import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { LocalArtifactStore } from '../app/evidence/index.js';
import { ProfileCatalog } from '../app/profile/index.js';
import { projectStoredReport, ReportProjectionResponseSchema } from '../app/subprocess/report-projection.js';

const profile = {
  id: 'p3b-headless', version: '1', browser: 'chromium' as const,
  viewport: { width: 800, height: 600 }, locale: 'en-US',
  timeoutPolicy: { actionMs: 100, navigationMs: 1000, waits: { default: 100 } },
  networkPolicyRef: { id: 'p3b-policy', version: '1' },
};
const policy = { id: 'p3b-policy', version: '1',
  destinations: [{ host: 'example.com', ports: [443], addresses: ['93.184.215.14'] }] };
const effective = new ProfileCatalog([profile], [policy]).resolve({ id: profile.id, version: profile.version });
const time = '2026-01-01T00:00:00.000Z';

async function job(root: string, privateReason?: string) {
  const store = new LocalArtifactStore(root);
  const source = {
    schemaVersion: '2', testSpecId: 'projectiontest', sourceInstruction: 'Check the URL',
    executionProfileRef: { id: profile.id, version: profile.version },
    startState: { url: 'https://example.com/' },
    steps: [{ id: 's1', type: 'assert_url', sourceText: 'Check the URL',
      expectedUrl: 'https://example.com/', match: 'exact' }],
  };
  await store.createJob(source, effective);
  const derivation = await store.writeEvidence(source.testSpecId, {
    evidenceId: 'derive', owner: { kind: 'attempt', id: 'attemptp3b' },
    mediaType: 'application/json', content: { observation: 'https://example.com/' },
    originStepId: 's1', executionStepId: 'x1',
  });
  await store.writeAttempt({
    schemaVersion: '2', testSpecId: source.testSpecId, explorationAttemptId: 'attemptp3b',
    executionProfileRef: source.executionProfileRef, profileFingerprint: effective.fingerprint,
    runtimeVersions: { node: '24', playwright: '1.63', browser: 'fixture', mcp: 'fixture' },
    status: 'resolved', startedAt: time, finishedAt: time, results: [], evidenceRefs: [derivation.ref],
  });
  await store.writeResolved({
    schemaVersion: '2', resolvedSpecId: 'resolvedp3b', testSpecId: source.testSpecId,
    explorationAttemptId: 'attemptp3b', executionProfileRef: source.executionProfileRef,
    runtimeVersions: { playwright: '1.63', mcp: 'fixture', runner: '1' },
    executionSteps: [{ id: 'x1', originStepId: 's1', source: 'authored', type: 'assert_url',
      expectedUrl: 'https://example.com/', match: 'exact', derivationEvidenceRef: derivation.ref }],
  });
  for (const id of ['runone', 'runtwo']) {
    const image = await store.writeEvidence(source.testSpecId, {
      evidenceId: `image${id}`, owner: { kind: 'run', id }, mediaType: 'image/png',
      content: new Uint8Array([1, 2, 3]), allowSensitiveBinary: true,
      originStepId: 's1', executionStepId: 'x1',
    });
    await store.writeRun(source.testSpecId, 'resolvedp3b', {
      executionRunId: id, effectiveProfile: effective,
      versions: { node: '24', playwright: '1.63', browser: 'fixture' },
      outcomes: [{ phase: 'execution', status: 'QA_ASSERTION_PASSED',
        testSpecId: source.testSpecId, resolvedSpecId: 'resolvedp3b',
        explorationAttemptId: 'attemptp3b', executionRunId: id,
        executionProfileRef: source.executionProfileRef,
        originStepId: 's1', executionStepId: 'x1',
        ...(privateReason ? { reason: privateReason } : {}),
        expected: 'https://example.com/', actual: 'https://example.com/',
        retryable: false, startedAt: time, finishedAt: time, evidenceRefs: [image.ref],
      }],
    });
  }
  const result = {
    protocolVersion: '1', kind: 'success',
    context: { testSpecId: source.testSpecId, executionProfileRef: source.executionProfileRef,
      profileFingerprint: effective.fingerprint, presentationMode: 'headless',
      observation: { state: 'no_intervention', autonomousEligible: true, eventIds: [] },
      progress: { stage: 'replayed', explorationAttemptId: 'attemptp3b',
        resolvedSpecId: 'resolvedp3b', executionRunIds: ['runone', 'runtwo'] },
      report: { kind: 'available', testSpecId: source.testSpecId } },
    terminal: { phase: 'execution', status: 'QA_ASSERTION_PASSED',
      ...(privateReason ? { reason: 'REDACTED_REASON' } : {}) },
  };
  const config = { profiles: [profile], networkPolicies: [policy], artifactRoot: root, retentionDays: 7,
    evidencePolicy: { finalScreenshot: true, failureScreenshot: false, failureTrace: false,
      failureVideo: false, sensitiveBinaryApproved: true } };
  return { result, config };
}

test('P3-B projects correlated QA metadata without page strings, paths, hashes or image bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'p3b-projection-'));
  try {
    const { result, config } = await job(root);
    const projected = await projectStoredReport({ reportProjectionVersion: '1', result }, config);
    expect(ReportProjectionResponseSchema.safeParse(projected).success).toBe(true);
    expect(projected.kind).toBe('available');
    if (projected.kind !== 'available') return;
    expect(projected.executionRunIds).toEqual(['runone', 'runtwo']);
    expect(projected.outcomes).toHaveLength(2);
    expect(projected.outcomes[0]).toMatchObject({ assertionType: 'assert_url',
      status: 'QA_ASSERTION_PASSED', expected: { state: 'withheld' }, actual: { state: 'withheld' } });
    expect(projected.screenshot).toBe('stored_restricted');
    expect(projected.evidence).toHaveLength(3);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('https://example.com/');
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain('content.png');
    expect(serialized).not.toContain('sha256');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('P3-B producer redacts an unreviewed stored reason without changing QA status', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'p3b-reason-'));
  try {
    const { result, config } = await job(root, 'private provider diagnostic');
    const projected = await projectStoredReport({ reportProjectionVersion: '1', result }, config);
    expect(projected.kind).toBe('available');
    if (projected.kind !== 'available') return;
    expect(projected.terminal).toMatchObject({ status: 'QA_ASSERTION_PASSED', reason: 'REDACTED_REASON' });
    expect(projected.outcomes.every((item) => item.reason === 'REDACTED_REASON')).toBe(true);
    expect(JSON.stringify(projected)).not.toContain('private provider diagnostic');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('P3-B rejects mismatched correlation and oversized artifacts before reconstruction', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'p3b-denial-'));
  try {
    const { result, config } = await job(root);
    const mismatched = structuredClone(result);
    mismatched.context.profileFingerprint = 'a'.repeat(64);
    expect(await projectStoredReport({ reportProjectionVersion: '1', result: mismatched }, config))
      .toMatchObject({ kind: 'unavailable', reason: 'CORRELATION_MISMATCH' });
    await writeFile(path.join(root, 'projectiontest', 'oversized.bin'), Buffer.alloc(16 * 1_048_576));
    expect(await projectStoredReport({ reportProjectionVersion: '1', result }, config))
      .toMatchObject({ kind: 'unavailable', reason: 'REPORT_TOO_LARGE' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('P3-B projection schema rejects unreviewed outcome vocabulary and display strings', () => {
  const base = {
    reportProjectionVersion: '1', kind: 'available', testSpecId: 'testp3b',
    executionProfileRef: { id: 'p3b', version: '1' }, profileFingerprint: 'a'.repeat(64),
    executionRunIds: [], terminal: { phase: 'execution', status: 'QA_ASSERTION_PASSED' },
    observation: 'no_intervention', screenshot: 'not_captured', evidence: [],
    outcomes: [{ phase: 'execution', status: 'QA_ASSERTION_PASSED',
      expected: { state: 'displayable', value: true }, actual: { state: 'withheld' } }],
  };
  expect(ReportProjectionResponseSchema.safeParse(base).success).toBe(true);
  for (const change of [
    { phase: 'private page text' },
    { status: 'PRIVATE_STATUS' },
    { reason: 'private provider diagnostic' },
    { expected: { state: 'displayable', value: 'private page text' } },
  ]) {
    expect(ReportProjectionResponseSchema.safeParse({ ...base,
      outcomes: [{ ...base.outcomes[0], ...change }] }).success).toBe(false);
  }
  expect(ReportProjectionResponseSchema.safeParse({ ...base,
    terminal: { ...base.terminal, reason: 'private provider diagnostic' } }).success).toBe(false);
});
