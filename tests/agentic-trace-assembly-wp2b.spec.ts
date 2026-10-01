import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { SuccessfulTraceAssembler, type CurrentStateActionFact } from '../app/exploration/index.js';
import { LocalArtifactStore } from '../app/evidence/index.js';
import { ProfileCatalog } from '../app/profile/index.js';

const D = (value: string) => value.repeat(64);
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:01.000Z';
const URL = 'https://example.test/start';
const source = {
  schemaVersion: '2', testSpecId: 'test-wp2b', sourceInstruction: 'Open, click, fill, and check URL',
  executionProfileRef: { id: 'wp2b-profile', version: '1' }, startState: { url: 'about:blank' },
  steps: [
    { id: 's1', type: 'navigate', sourceText: 'Open', url: URL },
    { id: 's2', type: 'click', sourceText: 'Click 200', target: { description: 'link with text "200"' } },
    { id: 's3', type: 'fill', sourceText: 'Fill Name', target: { description: 'Name' }, value: 'Jorge' },
    { id: 's4', type: 'assert_url', sourceText: 'Check URL', expectedUrl: 'https://example.test/done', match: 'exact' },
  ],
} as const;
const profile = new ProfileCatalog([{
  id: 'wp2b-profile', version: '1', browser: 'chromium', viewport: { width: 800, height: 600 },
  locale: 'en-US', timeoutPolicy: { actionMs: 1000, navigationMs: 1000, waits: { default: 1000 } },
  networkPolicyRef: { id: 'wp2b-policy', version: '1' },
}], [{ id: 'wp2b-policy', version: '1', destinations: [{
  host: 'example.test', ports: [443], addresses: ['93.184.216.34'],
}] }]).resolve(source.executionProfileRef);

function action(step: 's2' | 's3', sequence: number, pre: string, post: string): CurrentStateActionFact {
  const operation = step === 's2' ? 'click' : 'fill';
  const bindingId = `binding-${step}`;
  return {
    binding: {
      bindingVersion: '1', bindingId, testSpecId: source.testSpecId,
      explorationAttemptId: 'explore-wp2b', executionProfileRef: source.executionProfileRef,
      profileFingerprint: profile.fingerprint, sessionId: 'session-wp2b', pageId: 'page-wp2b',
      frameId: 'frame-wp2b', snapshotEpoch: sequence, snapshotDigest: pre,
      selectedRef: `ref-${step}`, originStepId: step, issuedAt: T0,
      operation, selectedNode: { role: step === 's2' ? 'link' : 'textbox',
        accessibleName: step === 's2' ? '200' : 'Name' }, justificationCode: 'authored_target',
    },
    record: {
      recordId: `record-${step}`, sequence, originStepId: step, source: 'authored',
      preStateDigest: pre, postStateDigest: post, observationDigest: post,
      observedEffect: 'state_changed', bindingId, type: operation, result: 'completed',
      ...(operation === 'fill' ? { value: 'Jorge' } : {}),
    } as CurrentStateActionFact['record'],
  };
}

function assembled(assertionResult: 'passed' | 'failed' = 'failed',
  traceVersion: '1' | '2' = '1', frameKind: 'main' | 'nested' | 'unproven' = 'main') {
  const journal: CurrentStateActionFact[] = [];
  const builder = new SuccessfulTraceAssembler(source, {
    explorationAttemptId: 'explore-wp2b', profileFingerprint: profile.fingerprint,
    sessionId: 'session-wp2b', startedAt: T0, startStateDigest: D('a'), actionJournal: () => journal,
    traceVersion,
    traceBinding: (binding) => ({ ...binding,
      frameOwnership: frameKind === 'main' ?
        { kind: 'main' as const, observationDigest: binding.snapshotDigest } :
        frameKind === 'nested' ? { kind: 'nested' as const, anchors: [{
          identity: { kind: 'title' as const, value: 'Account frame', exact: true as const },
          ownerSnapshotDigest: D('a'), observedMatchCount: 1 as const,
        }] } : { kind: 'unproven' as const, reasonCode: 'ambiguous_anchor' as const },
    }),
  });
  builder.appendObservedRecord({ recordId: 'record-s1', sequence: 1, originStepId: 's1', source: 'authored',
    preStateDigest: D('a'), postStateDigest: D('b'), observationDigest: D('b'),
    observedEffect: 'state_changed', type: 'navigate', url: URL, result: 'completed' });
  const first = action('s2', 2, D('b'), D('c'));
  const second = action('s3', 3, D('c'), D('d'));
  builder.appendCurrentStateAction(first);
  builder.appendCurrentStateAction(second);
  journal.push(first, second);
  builder.appendObservedRecord({ recordId: 'record-s4', sequence: 4, originStepId: 's4', source: 'authored',
    preStateDigest: D('d'), postStateDigest: D('d'), observationDigest: D('d'),
    observedEffect: 'state_unchanged', type: 'assert_url',
    expectedUrl: 'https://example.test/done', match: 'exact', result: assertionResult });
  return { builder, journal };
}

test('WP2B v2 persists protected main and nested owners while v1 remains readable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wp2b-v2-trace-'));
  try {
    const store = new LocalArtifactStore(root);
    await store.createJob(source, profile);
    const { builder } = assembled('failed', '2', 'nested');
    const bundle = builder.finalizeV2({ finishedAt: T1 });
    expect(bundle.trace.traceVersion).toBe('2');
    expect(bundle.trace.bindings.map((binding) => binding.frameOwnership.kind))
      .toEqual(['nested', 'nested']);
    const unproven = structuredClone(bundle.trace);
    unproven.bindings[0]!.frameOwnership = { kind: 'unproven', reasonCode: 'ambiguous_anchor' };
    await expect(store.writeSuccessfulExploration({ attempt: bundle.attempt,
      trace: unproven })).rejects.toThrow('unproven');
    await store.writeSuccessfulExploration(bundle);
    const stored = await new LocalArtifactStore(root).readSuccessfulExploration(source.testSpecId,
      'explore-wp2b');
    expect(stored.trace).toEqual(bundle.trace);
    expect(stored.trace.successfulPath.at(-1)).toMatchObject({ type: 'assert_url', result: 'failed' });
    await expect(store.writeSuccessfulExploration(bundle)).rejects.toThrow();
    for (const ordinal of [1, 2]) {
      const compiler = { compilerVersion: '1', compilerAttemptId: `compiler-v2-${ordinal}`,
        successfulTraceId: bundle.trace.successfulTraceId, testSpecId: source.testSpecId,
        explorationAttemptId: 'explore-wp2b', executionProfileRef: source.executionProfileRef,
        profileFingerprint: profile.fingerprint, startedAt: '2026-01-01T00:00:02.000Z',
        finishedAt: '2026-01-01T00:00:03.000Z', checks: [{ checkId: `check-v2-${ordinal}`,
          traceRecordId: 'record-s2', kind: 'durable_identity', result: 'failed',
          reasonCode: 'WEAK_IDENTITY' }], result: { status: 'rejected', reasonCode: 'WEAK_IDENTITY' } };
      await store.writeCompilerAttemptV1(compiler);
      expect((await store.readCompilerAttemptV1(source.testSpecId, 'explore-wp2b',
        `compiler-v2-${ordinal}`)).successfulTraceId).toBe(bundle.trace.successfulTraceId);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('WP2B v2 refuses unproven required frame ownership and stores no successful trace', () => {
  const { builder } = assembled('passed', '2', 'unproven');
  expect(() => builder.finalizeV2({ finishedAt: T1 })).toThrow('unproven');
});

test('WP2B assembles ordered successful actions and an evaluable false assertion without QA classification', async () => {
  const { builder, journal } = assembled();
  const { attempt, trace } = builder.finalize({ finishedAt: T1, successfulTraceId: 'trace-wp2b' });
  expect(attempt).toMatchObject({ status: 'path_established', successfulTraceId: 'trace-wp2b' });
  expect(trace.successfulPath.map((record) => record.type)).toEqual(['navigate', 'click', 'fill', 'assert_url']);
  expect(trace.successfulPath[3]).toMatchObject({ result: 'failed' });
  expect(trace.bindings.map((binding) => binding.selectedNode.accessibleName)).toEqual(['200', 'Name']);
  expect(JSON.stringify(trace)).not.toContain('QA_ASSERTION_FAILED');
  expect(() => builder.finalize({ finishedAt: T1 })).toThrow('already finalized');
});

test('WP2B keeps a discovered prerequisite distinct from the authored goal', () => {
  const journal: CurrentStateActionFact[] = [];
  const builder = new SuccessfulTraceAssembler(source, {
    explorationAttemptId: 'explore-wp2b', profileFingerprint: profile.fingerprint,
    sessionId: 'session-wp2b', startedAt: T0, startStateDigest: D('a'), actionJournal: () => journal,
  });
  builder.appendObservedRecord({ recordId: 'record-s1', sequence: 1, originStepId: 's1', source: 'authored',
    preStateDigest: D('a'), postStateDigest: D('b'), observationDigest: D('b'),
    type: 'navigate', url: URL, result: 'completed' });
  const prerequisite = action('s2', 2, D('b'), D('c'));
  prerequisite.binding.justificationCode = 'discovered_prerequisite';
  prerequisite.record.source = 'discoveredPrerequisite';
  const click = action('s2', 3, D('c'), D('d'));
  click.binding.bindingId = 'binding-authored-s2';
  if ('bindingId' in click.record) click.record.bindingId = click.binding.bindingId;
  click.record.recordId = 'record-authored-s2';
  const fill = action('s3', 4, D('d'), D('e'));
  builder.appendCurrentStateAction(prerequisite, 'expose_target');
  builder.appendCurrentStateAction(click);
  builder.appendCurrentStateAction(fill);
  journal.push(prerequisite, click, fill);
  builder.appendObservedRecord({ recordId: 'record-s4', sequence: 5, originStepId: 's4', source: 'authored',
    preStateDigest: D('e'), postStateDigest: D('e'), observationDigest: D('e'),
    type: 'assert_url', expectedUrl: 'https://example.test/done', match: 'exact', result: 'passed' });
  const { trace } = builder.finalize({ finishedAt: T1 });
  expect(trace.successfulPath.map((record) => [record.originStepId, record.source])).toEqual([
    ['s1', 'authored'], ['s2', 'discoveredPrerequisite'], ['s2', 'authored'],
    ['s3', 'authored'], ['s4', 'authored'],
  ]);
});

test('WP2B refuses unaccounted mutations, broken owner, missing authored goal, and a later mutation', () => {
  const { builder, journal } = assembled();
  journal.pop();
  expect(() => builder.finalize({ finishedAt: T1 })).toThrow('mutation missing');
  journal.push({ ...journal[0]!, binding: { ...journal[0]!.binding, sessionId: 'session-forged' } });
  expect(() => builder.finalize({ finishedAt: T1 })).toThrow('mutation missing');
  journal.push(action('s2', 5, D('d'), D('e')));
  expect(() => builder.finalize({ finishedAt: T1 })).toThrow('mutation missing');
  const incomplete = new SuccessfulTraceAssembler(source, {
    explorationAttemptId: 'explore-wp2b', profileFingerprint: profile.fingerprint,
    sessionId: 'session-wp2b', startedAt: T0, startStateDigest: D('a'), actionJournal: () => [],
  });
  incomplete.appendObservedRecord({ recordId: 'record-s1', sequence: 1, originStepId: 's1', source: 'authored',
    preStateDigest: D('a'), postStateDigest: D('b'), observationDigest: D('b'),
    type: 'navigate', url: URL, result: 'completed' });
  expect(() => incomplete.finalize({ finishedAt: T1 })).toThrow('Successful path');
  expect(() => incomplete.appendObservedRecord({ branchKind: 'recovery' } as unknown as
    Parameters<typeof incomplete.appendObservedRecord>[0])).toThrow();
  expect(() => incomplete.appendCurrentStateAction({ ...journal[0]!, binding: {
    ...journal[0]!.binding, sessionId: 'session-other',
  } })).toThrow('binding correlation');
  expect(() => builder.appendCurrentStateAction({ ...journal[0]!, record: {
    ...journal[0]!.record, recordId: 'record-extra', sequence: 5,
  } })).toThrow('state chain');
});

test('WP2B persists trace atomically, isolates branches, and accepts multiple compiler attempts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wp2b-trace-'));
  try {
    const store = new LocalArtifactStore(root);
    await store.createJob(source, profile);
    const { builder } = assembled();
    const descriptor = await store.writeEvidence(source.testSpecId, {
      evidenceId: 'observation-s2', owner: { kind: 'attempt', id: 'explore-wp2b' },
      mediaType: 'application/json', content: { effectCode: 'state_changed' }, originStepId: 's2',
    });
    builder.attachEvidence('record-s2', [descriptor.ref]);
    const bundle = builder.finalize({ finishedAt: T1, successfulTraceId: 'trace-wp2b' });
    const branch = {
      diagnosticVersion: '1', diagnosticId: 'branch-one', testSpecId: source.testSpecId,
      explorationAttemptId: 'explore-wp2b', executionProfileRef: source.executionProfileRef,
      profileFingerprint: profile.fingerprint, sessionId: 'session-wp2b', branchOrdinal: 1,
      originStepId: 's2', snapshotDigest: D('b'), branchKind: 'recovery',
      decisionCode: 'recover', resultCode: 'recovered', recoveredToRecordId: 'record-s2',
    } as const;
    await store.writeExplorationBranchDiagnostic(branch);
    await store.writeSuccessfulExploration(bundle);
    await expect(store.writeExplorationBranchDiagnostic({ ...branch, diagnosticId: 'branch-two',
      branchOrdinal: 2 })).rejects.toThrow('closed after trace finalization');
    const restarted = new LocalArtifactStore(root);
    expect((await restarted.readSuccessfulExploration(source.testSpecId, 'explore-wp2b')).trace).toEqual(bundle.trace);
    expect(bundle.trace.successfulPath[1]?.evidenceRefs).toEqual([descriptor.ref]);
    expect(await restarted.readExplorationBranchDiagnostics(source.testSpecId, 'explore-wp2b')).toEqual([branch]);
    expect(JSON.stringify(bundle.trace)).not.toContain('recovery');
    await expect(store.writeSuccessfulExploration(bundle)).rejects.toThrow();
    for (const ordinal of [1, 2]) {
      const compiler = { compilerVersion: '1', compilerAttemptId: `compiler-${ordinal}`,
        successfulTraceId: 'trace-wp2b', testSpecId: source.testSpecId,
        explorationAttemptId: 'explore-wp2b', executionProfileRef: source.executionProfileRef,
        profileFingerprint: profile.fingerprint, startedAt: '2026-01-01T00:00:02.000Z',
        finishedAt: '2026-01-01T00:00:03.000Z', checks: [{ checkId: `check-${ordinal}`,
          traceRecordId: 'record-s2', kind: 'durable_identity', result: 'failed', reasonCode: 'WEAK_IDENTITY' }],
        result: { status: 'rejected', reasonCode: 'WEAK_IDENTITY' } };
      await store.writeCompilerAttemptV1(compiler);
      expect((await restarted.readCompilerAttemptV1(source.testSpecId, 'explore-wp2b', `compiler-${ordinal}`))
        .successfulTraceId).toBe('trace-wp2b');
    }
    const persisted = await readFile(path.join(root, source.testSpecId, 'agentic-explorations', 'explore-wp2b.json'), 'utf8');
    expect(persisted).not.toContain('branchKind');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('WP2B denies profile and branch session mismatch before trace persistence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wp2b-deny-'));
  try {
    const store = new LocalArtifactStore(root);
    await store.createJob(source, profile);
    const { builder } = assembled();
    const bundle = builder.finalize({ finishedAt: T1 });
    await expect(store.writeSuccessfulExploration({ attempt: bundle.attempt,
      trace: { ...bundle.trace, profileFingerprint: D('f') } })).rejects.toThrow();
    await store.writeExplorationBranchDiagnostic({ diagnosticVersion: '1', diagnosticId: 'branch-wrong',
      testSpecId: source.testSpecId, explorationAttemptId: 'explore-wp2b',
      executionProfileRef: source.executionProfileRef, profileFingerprint: profile.fingerprint,
      sessionId: 'session-other', branchOrdinal: 1, originStepId: 's2', snapshotDigest: D('b'),
      branchKind: 'failed_candidate', decisionCode: 'act', resultCode: 'wrong_target' });
    await expect(store.writeSuccessfulExploration(bundle)).rejects.toThrow('branch linkage');
    await expect(store.readSuccessfulExploration(source.testSpecId, 'explore-wp2b')).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
