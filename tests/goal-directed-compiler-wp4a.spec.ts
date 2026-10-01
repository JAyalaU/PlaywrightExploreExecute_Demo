import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { assertionFromStrategyV1, CompilerAttemptV2Schema,
  DeterministicVerificationAssertionV1Schema, parseCompilerAttemptV2,
  parseResolvedTestSpecV7, ResolvedTestSpecV6Schema, ResolvedTestSpecV7Schema,
  TrustedObservationResultV1Schema,
  type ProtectedTraceObservationSourceV3, type SuccessfulVerificationRecordV3,
  type TrustedObservationResultV1 } from '../app/domain/index.js';
import type { SuccessfulVerificationStrategyV1 } from '../app/interpretation/verification-strategy.js';

const D = (value: string) => value.repeat(64);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const t0 = '2026-01-01T00:00:00.000Z';
const t1 = '2026-01-01T00:00:01.000Z';
const t2 = '2026-01-01T00:00:02.000Z';
const t3 = '2026-01-01T00:00:03.000Z';
const t4 = '2026-01-01T00:00:04.000Z';
const owner = { testSpecId: 'spec', explorationAttemptId: 'attempt',
  executionProfileRef: { id: 'profile', version: '1' }, profileFingerprint: D('a') };
const query = { role: 'button' as const, name: 'Delete', frame: { kind: 'main' as const } };
const copy = <T>(value: T): T => structuredClone(value);

function fixture(observedCount = 0) {
  const clause = 'Confirm the Delete button does not exist.';
  const goal = { id: 'goal', type: 'verification_goal', sourceText: clause,
    instruction: clause, subject: { role: 'button', accessibleName: 'Delete' },
    intent: { kind: 'presence', expected: 'absent' } };
  const source = { schemaVersion: '4', testSpecId: 'spec', sourceInstruction: clause,
    executionProfileRef: owner.executionProfileRef, startState: { url: 'https://example.com/' },
    steps: [goal] };
  const attempt = { attemptVersion: '3', ...owner, status: 'path_established',
    successfulTraceId: 'trace', startedAt: t0, finishedAt: t2 };
  const fact = { observationVersion: '1', observationId: 'obs', ...owner,
    sessionId: 'session', pageId: 'page', stateEpoch: 0, mutationEpoch: 0,
    stateDigest: D('b'), observedAt: t1,
    request: { kind: 'semantic_query', query },
    frame: { kind: 'main', snapshotDigest: D('c') },
    status: 'complete', result: { kind: 'matches', count: observedCount, complete: true } };
  const observation: TrustedObservationResultV1 = TrustedObservationResultV1Schema.parse(
    { ...fact, witnessDigest: hash(fact) });
  const comparison = { kind: 'count', observationId: 'obs', operator: 'equal', expected: 0 };
  const compact = { observationId: 'obs', request: observation.request,
    result: observation.status === 'complete' ? observation.result : undefined,
    witnessDigest: observation.witnessDigest, sessionId: observation.sessionId,
    pageId: observation.pageId, stateEpoch: observation.stateEpoch,
    mutationEpoch: observation.mutationEpoch, stateDigest: observation.stateDigest,
    observedAt: observation.observedAt, frame: observation.frame };
  const strategyData = { strategyVersion: '1', goalStepId: 'goal',
    observationIds: ['obs'], observations: [compact], comparison, evaluated: observedCount === 0,
    conclusion: observedCount === 0 ? 'satisfied' : 'unsatisfied',
    testSpecId: 'spec', explorationAttemptId: 'attempt',
    sessionId: 'session', pageId: 'page', actionOrdinal: 0 };
  const strategy = { ...strategyData, strategyDigest: hash(strategyData) } as SuccessfulVerificationStrategyV1;
  const record = { type: 'verification_goal', recordId: 'record', sequence: 1,
    source: 'authored', originStepId: 'goal', goalStepId: 'goal', goalDigest: hash(goal),
    preStateDigest: D('1'), postStateDigest: D('1'), strategyDigest: strategy.strategyDigest,
    actionOrdinal: 0, observationIds: ['obs'], observations: [observation],
    comparison, evaluated: observedCount === 0,
    conclusion: observedCount === 0 ? 'satisfied' : 'unsatisfied' } as SuccessfulVerificationRecordV3;
  const trace = { traceVersion: '3', successfulTraceId: 'trace', ...owner,
    sessionId: 'session', startStateDigest: D('1'), finalStateDigest: D('1'),
    startedAt: t0, finishedAt: t2, bindings: [], completedOriginStepIds: ['goal'],
    successfulPath: [record] };
  const protectedSource: ProtectedTraceObservationSourceV3 = {
    readObservation: (id, goalId) => id === 'obs' && goalId === 'goal' ? {
      record: observation, actionOrdinal: 0, pathPosition: 0, pathStateDigest: D('1'),
      currentAtCapture: true, currentAtGoal: true } : undefined,
    readStrategy: (id) => id === 'goal' ? strategy : undefined,
  };
  const assertion = assertionFromStrategyV1(record)!;
  const checks = [
    { checkId: 'profile', traceRecordId: 'record', kind: 'profile_equivalence', result: 'passed', reasonCode: 'NONE' },
    { checkId: 'ordered', traceRecordId: 'record', kind: 'ordered_postcondition', result: 'passed', reasonCode: 'NONE' },
    { checkId: 'strategy', traceRecordId: 'record', kind: 'strategy_correspondence', result: 'passed', reasonCode: 'NONE' },
    { checkId: 'fresh', traceRecordId: 'record', kind: 'fresh_observation', result: 'passed', reasonCode: 'NONE' },
    { checkId: 'representation', traceRecordId: 'record', kind: 'deterministic_representation',
      result: 'passed', reasonCode: 'NONE', candidateDigest: hash(assertion) },
  ];
  const compiler = { compilerVersion: '2', compilerAttemptId: 'compiler', ...owner,
    successfulTraceId: 'trace', startedAt: t3, finishedAt: t4, freshSessionId: 'fresh',
    strategyLinks: [{ traceRecordId: 'record', goalStepId: 'goal',
      strategyDigest: strategy.strategyDigest, observationIds: ['obs'], assertionStepId: 'exec' }],
    checks, result: { status: 'accepted', resolvedSpecId: 'resolved' } };
  const resolved = { schemaVersion: '7', sourceSchemaVersion: '4', resolvedSpecId: 'resolved',
    ...owner, successfulTraceId: 'trace', compilerAttemptId: 'compiler',
    runtimeVersions: { playwright: '1', mcp: '1', runner: '7', compiler: '2' },
    executionSteps: [{ id: 'exec', traceRecordId: 'record', originStepId: 'goal',
      source: 'authored', type: 'verification_goal', goalStepId: 'goal', assertion }] };
  return { source, attempt, trace, protectedSource, record, compiler, resolved, assertion };
}

test('count zero compiles from a trusted absence strategy with source and trace linkage', () => {
  const run = fixture();
  expect(parseCompilerAttemptV2(run.compiler, run.source, run.attempt, run.trace,
    run.protectedSource).result.status).toBe('accepted');
  expect(parseResolvedTestSpecV7(run.resolved, run.source, run.attempt, run.trace,
    run.protectedSource, run.compiler).executionSteps[0]).toMatchObject({
    assertion: { kind: 'semantic_count', operator: 'equal', expected: 0,
      query: { role: 'button', name: 'Delete' } } });
  expect(ResolvedTestSpecV6Schema.safeParse(run.resolved).success).toBe(false);
});

test('an observed false condition validates and keeps the authored assertion without QA classification', () => {
  const run = fixture(1);
  expect(parseCompilerAttemptV2(run.compiler, run.source, run.attempt,
    run.trace, run.protectedSource).result.status).toBe('accepted');
  const parsed = parseResolvedTestSpecV7(run.resolved, run.source, run.attempt,
    run.trace, run.protectedSource, run.compiler);
  expect(run.record.conclusion).toBe('unsatisfied');
  expect(parsed.executionSteps[0]).toMatchObject({ assertion: {
    kind: 'semantic_count', operator: 'equal', expected: 0 } });
  expect(JSON.stringify(parsed)).not.toContain('QA_ASSERTION_FAILED');
});

test('temporal strategy is typed compilation unsupported and cannot become final absence', () => {
  const run = fixture();
  const record = run.trace.successfulPath[0] as SuccessfulVerificationRecordV3;
  record.comparison = { kind: 'transition', earlierObservationId: 'earlier',
    laterObservationId: 'obs', operator: 'disappears' };
  expect(assertionFromStrategyV1(record)).toBeUndefined();
  const rejected = { ...run.compiler,
    strategyLinks: [{ ...run.compiler.strategyLinks[0], assertionStepId: undefined }],
    checks: [{ checkId: 'unsupported', traceRecordId: 'record',
      kind: 'deterministic_representation', result: 'failed',
      reasonCode: 'UNSUPPORTED_TEMPORAL_REPLAY' }],
    result: { status: 'rejected', reasonCode: 'UNSUPPORTED_TEMPORAL_REPLAY',
      failedTraceRecordId: 'record' } };
  expect(CompilerAttemptV2Schema.safeParse(rejected).success).toBe(true);
  expect(ResolvedTestSpecV7Schema.safeParse({ ...run.resolved,
    executionSteps: [{ ...run.resolved.executionSteps[0], assertion: undefined }] }).success).toBe(false);
});

