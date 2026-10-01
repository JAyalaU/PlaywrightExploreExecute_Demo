import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { parseSuccessfulExplorationTraceV2, parseSuccessfulExplorationTraceV3,
  TrustedObservationResultV1Schema, type ProtectedTraceObservationSourceV3,
  type TrustedObservationResultV1 } from '../app/domain/index.js';
import type { SuccessfulVerificationStrategyV1 } from '../app/interpretation/verification-strategy.js';

const D = (digit: string) => digit.repeat(64);
const t0 = '2026-01-01T00:00:00.000Z';
const t1 = '2026-01-01T00:00:01.000Z';
const t2 = '2026-01-01T00:00:02.000Z';
const t3 = '2026-01-01T00:00:03.000Z';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const profile = { id: 'profile', version: '1' };
const owner = { testSpecId: 'spec', explorationAttemptId: 'attempt', executionProfileRef: profile,
  profileFingerprint: D('a') };
const query = { kind: 'semantic_query' as const, query: { role: 'dialog' as const,
  frame: { kind: 'main' as const } } };

function observation(observationId: string, count: number, stateDigest: string,
  stateEpoch: number, mutationEpoch: number, observedAt: string): TrustedObservationResultV1 {
  const data = { observationVersion: '1' as const, observationId, ...owner,
    sessionId: 'session', pageId: 'page', stateEpoch, mutationEpoch, stateDigest, observedAt,
    request: query, frame: { kind: 'main' as const, snapshotDigest: D('b') },
    status: 'complete' as const, result: { kind: 'matches' as const, count, complete: true as const } };
  return TrustedObservationResultV1Schema.parse({ ...data, witnessDigest: hash(data) });
}

function fixture() {
  const g1 = { id: 'step1', type: 'verification_goal', sourceText: 'Confirm the modal exists.',
    instruction: 'Confirm the modal exists.', subject: { role: 'dialog' },
    intent: { kind: 'presence', expected: 'present' } };
  const action = { id: 'step2', type: 'navigate', sourceText: 'Go to https://example.com/next.',
    url: 'https://example.com/next' };
  const g3 = { id: 'step3', type: 'verification_goal', sourceText: 'Make sure the modal disappears.',
    instruction: 'Make sure the modal disappears.', subject: { role: 'dialog' },
    intent: { kind: 'temporal', transition: 'disappears' }, dependsOnStepId: 'step2' };
  const source = { schemaVersion: '4', testSpecId: 'spec',
    sourceInstruction: [g1.sourceText, action.sourceText, g3.sourceText].join(' '),
    executionProfileRef: profile, startState: { url: 'https://example.com/' },
    steps: [g1, action, g3] };
  const attempt = { attemptVersion: '3', ...owner, status: 'path_established',
    successfulTraceId: 'trace', startedAt: t0, finishedAt: t3 };
  // WP2 page-state hashes are intentionally distinct from action-path hashes.
  const present = observation('present', 1, D('9'), 0, 0, t1);
  const absent = observation('absent', 0, D('8'), 1, 1, t2);
  const cmp1 = { kind: 'count', observationId: 'present', operator: 'greater_than', expected: 0 };
  const cmp3 = { kind: 'transition', earlierObservationId: 'present', laterObservationId: 'absent',
    operator: 'disappears' };
  const compact = (record: TrustedObservationResultV1) => {
    if (record.status !== 'complete') throw new Error('Invalid fixture');
    return { observationId: record.observationId, request: record.request, result: record.result,
      witnessDigest: record.witnessDigest, sessionId: record.sessionId, pageId: record.pageId,
      stateEpoch: record.stateEpoch, mutationEpoch: record.mutationEpoch,
      stateDigest: record.stateDigest, observedAt: record.observedAt, frame: record.frame };
  };
  function strategy(goalStepId: string, ids: string[], records: TrustedObservationResultV1[],
    comparison: object, actionOrdinal: number): SuccessfulVerificationStrategyV1 {
    const data = { strategyVersion: '1', goalStepId, observationIds: ids,
      observations: records.map(compact), comparison, evaluated: true, conclusion: 'satisfied',
      testSpecId: 'spec', explorationAttemptId: 'attempt', sessionId: 'session', pageId: 'page',
      actionOrdinal };
    return { ...data, strategyDigest: hash(data) } as SuccessfulVerificationStrategyV1;
  }
  const strategies = new Map([['step1', strategy('step1', ['present'], [present], cmp1, 0)],
    ['step3', strategy('step3', ['present', 'absent'], [present, absent], cmp3, 1)]]);
  const captured = new Map([['present', { record: present, actionOrdinal: 0, pathPosition: 0,
    pathStateDigest: D('1') }],
    ['absent', { record: absent, actionOrdinal: 1, pathPosition: 2,
      pathStateDigest: D('2') }]]);
  const protectedSource: ProtectedTraceObservationSourceV3 = {
    readObservation: (id, goalId) => {
      const entry = captured.get(id);
      return entry && { ...entry, currentAtCapture: true,
        currentAtGoal: id === 'absent' || goalId === 'step1' };
    },
    readStrategy: (goalId) => strategies.get(goalId),
  };
  const trace = { traceVersion: '3', successfulTraceId: 'trace', ...owner,
    sessionId: 'session', startStateDigest: D('1'), finalStateDigest: D('2'),
    startedAt: t0, finishedAt: t3, bindings: [], completedOriginStepIds: ['step1', 'step2', 'step3'],
    successfulPath: [
      { type: 'verification_goal', recordId: 'r1', sequence: 1, source: 'authored',
        originStepId: 'step1', goalStepId: 'step1', goalDigest: hash(g1),
        preStateDigest: D('1'), postStateDigest: D('1'), strategyDigest: strategies.get('step1')!.strategyDigest,
        actionOrdinal: 0, observationIds: ['present'], observations: [present], comparison: cmp1,
        evaluated: true, conclusion: 'satisfied' },
      { type: 'navigate', recordId: 'r2', sequence: 2, source: 'authored', originStepId: 'step2',
        preStateDigest: D('1'), postStateDigest: D('2'), observationDigest: D('b'),
        observedEffect: 'state_changed', url: 'https://example.com/next', result: 'completed' },
      { type: 'verification_goal', recordId: 'r3', sequence: 3, source: 'authored',
        originStepId: 'step3', goalStepId: 'step3', goalDigest: hash(g3),
        preStateDigest: D('2'), postStateDigest: D('2'), strategyDigest: strategies.get('step3')!.strategyDigest,
        actionOrdinal: 1, observationIds: ['present', 'absent'], observations: [present, absent],
        comparison: cmp3, evaluated: true, conclusion: 'satisfied', temporal: {
          earlierObservationId: 'present', laterObservationId: 'absent', transitionRecordIds: ['r2'] } },
    ] };
  return { source, attempt, trace, protectedSource, strategies, captured };
}

test('v3 preserves authored action/goal order and a grounded temporal strategy', () => {
  const run = fixture();
  expect(parseSuccessfulExplorationTraceV3(run.trace, run.source, run.attempt,
    run.protectedSource).successfulPath.map((record) => record.originStepId))
    .toEqual(['step1', 'step2', 'step3']);
});

test('path-state attestation is independent of WP2 digest and cannot be forged', () => {
  const run = fixture();
  expect(run.captured.get('present')?.record.stateDigest).not.toBe(run.trace.startStateDigest);
  expect(parseSuccessfulExplorationTraceV3(run.trace, run.source, run.attempt,
    run.protectedSource).traceVersion).toBe('3');
  run.captured.get('present')!.pathStateDigest = D('f');
  expect(() => parseSuccessfulExplorationTraceV3(run.trace, run.source, run.attempt,
    run.protectedSource)).toThrow(/capture is outside/);
});

test('navigation before a goal changes state without changing WP3A action ordinal', () => {
  const run = fixture();
  const navigate = { id: 'step0', type: 'navigate',
    sourceText: 'Go to https://example.com/start.', url: 'https://example.com/start' };
  run.source.steps.unshift(navigate);
  run.source.sourceInstruction = `${navigate.sourceText} ${run.source.sourceInstruction}`;
  run.source.startState.url = 'https://example.com/start';
  run.trace.startStateDigest = D('0');
  run.trace.completedOriginStepIds.unshift('step0');
  run.trace.successfulPath.unshift({ type: 'navigate', recordId: 'r0', sequence: 1,
    source: 'authored', originStepId: 'step0', preStateDigest: D('0'),
    postStateDigest: D('1'), observationDigest: D('b'), observedEffect: 'state_changed',
    url: 'https://example.com/start', result: 'completed' });
  for (const record of run.trace.successfulPath.slice(1)) record.sequence += 1;
  run.captured.get('present')!.pathPosition = 1;
  run.captured.get('absent')!.pathPosition = 3;
  const parsed = parseSuccessfulExplorationTraceV3(run.trace, run.source, run.attempt,
    run.protectedSource);
  expect(parsed.successfulPath.map((record) => record.originStepId))
    .toEqual(['step0', 'step1', 'step2', 'step3']);
  expect(parsed.successfulPath[1]).toMatchObject({ type: 'verification_goal', actionOrdinal: 0 });
});

test('evaluated unsatisfied is successful exploration content, not QA failure', () => {
  const run = fixture();
  const record = run.trace.successfulPath[0] as Record<string, unknown>;
  const sourceGoal = run.source.steps[0] as Record<string, unknown>;
  sourceGoal.sourceText = 'Confirm the modal does not exist.';
  sourceGoal.instruction = sourceGoal.sourceText;
  sourceGoal.intent = { kind: 'presence', expected: 'absent' };
  run.source.sourceInstruction = [sourceGoal.sourceText, run.source.steps[1]!.sourceText,
    run.source.steps[2]!.sourceText].join(' ');
  const comparison = { kind: 'count', observationId: 'present', operator: 'equal', expected: 0 };
  const data = { ...run.strategies.get('step1')!, comparison, evaluated: false,
    conclusion: 'unsatisfied' as const };
  const { strategyDigest: _old, ...digestData } = data;
  run.strategies.set('step1', { ...digestData, strategyDigest: hash(digestData) } as SuccessfulVerificationStrategyV1);
  record.comparison = comparison; record.evaluated = false; record.conclusion = 'unsatisfied';
  record.goalDigest = hash(sourceGoal);
  record.strategyDigest = run.strategies.get('step1')!.strategyDigest;
  expect(parseSuccessfulExplorationTraceV3(run.trace, run.source, run.attempt,
    run.protectedSource).successfulPath[0]).toMatchObject({ conclusion: 'unsatisfied', evaluated: false });
});

test('v3 fails closed on missing protected source, forged ID, tampered value and stale current evidence', () => {
  const mutations: Array<(run: ReturnType<typeof fixture>) => void> = [
    (run) => { (run.trace.successfulPath[0] as Record<string, unknown>).observationIds = ['forged']; },
    (run) => { const item = (run.trace.successfulPath[0] as Record<string, unknown>);
      item.observations = [{ ...run.captured.get('present')!.record,
        result: { kind: 'matches', count: 0, complete: true } }]; },
    (run) => { run.protectedSource.readObservation = () => undefined; },
    (run) => { const read = run.protectedSource.readObservation.bind(run.protectedSource);
      run.protectedSource.readObservation = (id, goalId) => {
        const found = read(id, goalId); return found && { ...found, currentAtGoal: false }; }; },
  ];
  for (const mutate of mutations) {
    const run = fixture(); mutate(run);
    expect(() => parseSuccessfulExplorationTraceV3(run.trace, run.source, run.attempt,
      run.protectedSource)).toThrow();
  }
  const run = fixture();
  expect(() => parseSuccessfulExplorationTraceV3(run.trace, run.source, run.attempt,
    undefined as unknown as ProtectedTraceObservationSourceV3)).toThrow();
});

test('v3 rejects broken step accounting, source linkage, comparison and conclusion', () => {
  const mutations: Array<(run: ReturnType<typeof fixture>) => void> = [
    (run) => { run.trace.completedOriginStepIds.reverse(); },
    (run) => { run.trace.successfulPath.splice(1, 1); },
    (run) => { (run.trace.successfulPath[1] as Record<string, unknown>).sequence = 1; },
    (run) => { (run.trace.successfulPath[1] as Record<string, unknown>).recordId = 'r1'; },
    (run) => { (run.trace.successfulPath[0] as Record<string, unknown>).goalDigest = D('e'); },
    (run) => { (run.trace.successfulPath[0] as Record<string, unknown>).evaluated = false; },
    (run) => { (run.trace.successfulPath[0] as Record<string, unknown>).conclusion = 'unsupported'; },
    (run) => { (run.trace.successfulPath[2] as Record<string, unknown>).comparison =
      { kind: 'count', observationId: 'absent', operator: 'equal', expected: 0 }; },
  ];
  for (const mutate of mutations) {
    const run = fixture(); mutate(run);
    expect(() => parseSuccessfulExplorationTraceV3(run.trace, run.source, run.attempt,
      run.protectedSource)).toThrow();
  }
});

test('a journal and trace agreeing on a false claim still cannot override the observed result', () => {
  const run = fixture();
  const record = run.trace.successfulPath[0] as Record<string, unknown>;
  const original = run.strategies.get('step1')!;
  const data = { ...original, evaluated: false, conclusion: 'unsatisfied' as const };
  const { strategyDigest: _old, ...digestData } = data;
  run.strategies.set('step1', { ...digestData, strategyDigest: hash(digestData) } as SuccessfulVerificationStrategyV1);
  record.evaluated = false; record.conclusion = 'unsatisfied';
  record.strategyDigest = run.strategies.get('step1')!.strategyDigest;
  expect(() => parseSuccessfulExplorationTraceV3(run.trace, run.source, run.attempt,
    run.protectedSource)).toThrow(/disagrees with trusted observations/);
});

test('query error and an unproven authored scope cannot be copied into successful evidence', () => {
  const errorRun = fixture();
  const first = errorRun.trace.successfulPath[0] as Record<string, unknown>;
  first.observations = [{ ...errorRun.captured.get('present')!.record,
    status: 'error', reason: 'QUERY_UNEVALUABLE', result: undefined }];
  expect(() => parseSuccessfulExplorationTraceV3(errorRun.trace, errorRun.source,
    errorRun.attempt, errorRun.protectedSource)).toThrow();

  const scopeRun = fixture();
  const goal = scopeRun.source.steps[0] as Record<string, unknown>;
  goal.sourceText = 'Confirm the modal in the dialog exists.';
  goal.instruction = goal.sourceText;
  goal.subject = { role: 'dialog', scope: [{ kind: 'dialog', description: 'dialog' }] };
  scopeRun.source.sourceInstruction = [goal.sourceText, scopeRun.source.steps[1]!.sourceText,
    scopeRun.source.steps[2]!.sourceText].join(' ');
  (scopeRun.trace.successfulPath[0] as Record<string, unknown>).goalDigest = hash(goal);
  expect(() => parseSuccessfulExplorationTraceV3(scopeRun.trace, scopeRun.source,
    scopeRun.attempt, scopeRun.protectedSource)).toThrow(/scope is not proven/);
});

test('v3 independently rejects unhinted subject redirection and a wrong scoped name', () => {
  const unhinted = fixture();
  const plainGoal = unhinted.source.steps[0] as Record<string, unknown>;
  plainGoal.sourceText = 'Confirm the Delete button exists.';
  plainGoal.instruction = plainGoal.sourceText;
  delete plainGoal.subject;
  unhinted.source.sourceInstruction = [plainGoal.sourceText, unhinted.source.steps[1]!.sourceText,
    unhinted.source.steps[2]!.sourceText].join(' ');
  (unhinted.trace.successfulPath[0] as Record<string, unknown>).goalDigest = hash(plainGoal);
  expect(() => parseSuccessfulExplorationTraceV3(unhinted.trace, unhinted.source,
    unhinted.attempt, unhinted.protectedSource)).toThrow(/role is not authored/);

  const scoped = fixture();
  const goal = scoped.source.steps[0] as Record<string, unknown>;
  goal.sourceText = 'Confirm the modal in the Settings dialog exists.';
  goal.instruction = goal.sourceText;
  goal.subject = { role: 'dialog', scope: [{ kind: 'dialog', description: 'Settings' }] };
  scoped.source.sourceInstruction = [goal.sourceText, scoped.source.steps[1]!.sourceText,
    scoped.source.steps[2]!.sourceText].join(' ');
  (scoped.trace.successfulPath[0] as Record<string, unknown>).goalDigest = hash(goal);
  const original = scoped.captured.get('present')!.record;
  const wrong = { ...original, request: { kind: 'semantic_query' as const,
    query: { role: 'dialog' as const, frame: { kind: 'main' as const },
      within: [{ kind: 'dialog' as const, name: 'Other' }] } }, witnessDigest: D('c') };
  scoped.captured.set('present', { record: wrong, actionOrdinal: 0, pathPosition: 0,
    pathStateDigest: D('1') });
  for (const index of [0, 2]) {
    const record = scoped.trace.successfulPath[index] as Record<string, unknown>;
    const observations = record.observations as TrustedObservationResultV1[];
    observations[0] = wrong;
    const stepId = index === 0 ? 'step1' : 'step3';
    const existing = scoped.strategies.get(stepId)!;
    const replaced = existing.observations.map((item, i) => i === 0 ?
      { ...item, request: wrong.request, witnessDigest: wrong.witnessDigest } : item);
    const { strategyDigest: _old, ...data } = existing;
    const revised = { ...data, observations: replaced };
    const next = { ...revised, strategyDigest: hash(revised) } as SuccessfulVerificationStrategyV1;
    scoped.strategies.set(stepId, next);
    record.strategyDigest = next.strategyDigest;
  }
  expect(() => parseSuccessfulExplorationTraceV3(scoped.trace, scoped.source,
    scoped.attempt, scoped.protectedSource)).toThrow(/scope name or order differs/);
});

test('temporal history requires an actual ordered transition and exact frame/scope proof', () => {
  const mutations: Array<(run: ReturnType<typeof fixture>) => void> = [
    (run) => { (run.trace.successfulPath[2] as Record<string, unknown>).temporal = {
      earlierObservationId: 'present', laterObservationId: 'absent', transitionRecordIds: ['wrong'] }; },
    (run) => { const original = run.protectedSource.readObservation.bind(run.protectedSource);
      run.protectedSource.readObservation = (id, goalId) => {
        const found = original(id, goalId); return found && { ...found, actionOrdinal: 1 }; }; },
    (run) => { const item = (run.trace.successfulPath[2] as Record<string, unknown>);
      item.temporal = undefined; },
    (run) => { const item = (run.trace.successfulPath[2] as Record<string, unknown>);
      const observations = item.observations as TrustedObservationResultV1[];
      observations[1] = { ...observations[1]!, frame: { kind: 'unresolved' } }; },
  ];
  for (const mutate of mutations) {
    const run = fixture(); mutate(run);
    expect(() => parseSuccessfulExplorationTraceV3(run.trace, run.source, run.attempt,
      run.protectedSource)).toThrow();
  }
});

test('v2 remains independently readable; v3 is never silently accepted as v2', () => {
  const source = { schemaVersion: '2', testSpecId: 'spec', sourceInstruction: 'Go to https://example.com/.',
    executionProfileRef: profile, startState: { url: 'https://example.com/' },
    steps: [{ id: 'step1', type: 'navigate', sourceText: 'Go to https://example.com/.',
      url: 'https://example.com/' }] };
  const attempt = { attemptVersion: '3', ...owner, status: 'path_established',
    successfulTraceId: 'trace', startedAt: t0, finishedAt: t3 };
  const trace = { traceVersion: '2', successfulTraceId: 'trace', ...owner, sessionId: 'session',
    startStateDigest: D('1'), finalStateDigest: D('2'), startedAt: t0, finishedAt: t3,
    bindings: [], completedOriginStepIds: ['step1'], successfulPath: [{ type: 'navigate',
      recordId: 'r1', sequence: 1, originStepId: 'step1', source: 'authored',
      preStateDigest: D('1'), postStateDigest: D('2'), observationDigest: D('b'),
      url: 'https://example.com/', result: 'completed' }] };
  expect(parseSuccessfulExplorationTraceV2(trace, source, attempt).traceVersion).toBe('2');
  expect(() => parseSuccessfulExplorationTraceV2({ ...trace, traceVersion: '3' }, source,
    attempt)).toThrow();
});
