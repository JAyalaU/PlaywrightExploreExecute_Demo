import { createHash } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CurrentStateExploration, McpExplorationSession, SuccessfulTraceAssemblerV3,
  TrustedObservationSessionV1, compileSuccessfulTraceV1, compileSuccessfulTraceV3 } from '../app/exploration/index.js';
import { LocalArtifactStore } from '../app/evidence/index.js';
import { GoalDirectedVerificationControllerV1, type AgenticVerificationModelV4,
  type SuccessfulVerificationStrategyV1, type VerificationDecisionContextV4 } from '../app/interpretation/verification-strategy.js';
import { ProfileCatalog, ProtectedContextFactory } from '../app/profile/index.js';
import { executeResolvedTestSpecV7, executeResolvedTestSpecV6 } from '../app/runner/index.js';
import { parseProtectedTraceCaptureBundleV3 } from '../app/exploration/trace-assembly-v3.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const query = (name: string) => ({ kind: 'semantic_query', query: {
  role: 'button', name, frame: { kind: 'main' },
} });
const observe = (name: string) => ({ decisionVersion: '4', kind: 'observe', request: query(name) });
const count = (ctx: VerificationDecisionContextV4, operator: string, expected: number,
  conclusion: string) => ({ decisionVersion: '4', kind: 'conclude', conclusion,
    comparison: { kind: 'count', observationId: ctx.observations.at(-1)!.observationId,
      operator, expected } });
function scripted(decisions: ((ctx: VerificationDecisionContextV4) => object)[]): AgenticVerificationModelV4 {
  let index = 0;
  return { complete: async ({ context }) => JSON.stringify(decisions[index++]?.(context) ??
    { decisionVersion: '4', kind: 'conclude', conclusion: 'unresolved' }) };
}

async function fixture(falseGoal = false, temporal = false,
  linkVariant?: 'authored_accessible_name' | 'mismatched_source') {
  let freshMode: 'normal' | 'preexisting_delete' | 'duplicate_add' | 'hidden_delete' |
    'changed_link' | 'disabled_add' | 'nested_frame' | 'frame_drift' |
    'scope_drift' = 'normal';
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(request.url === '/frame' ?
      `<iframe title="${freshMode === 'frame_drift' ? 'Changed' : 'Payment'}" src="/inner"></iframe>` :
      request.url === '/inner' ?
        `<div role="dialog" aria-label="${freshMode === 'scope_drift' ? 'Changed' : 'Actions'}"><button>Delete</button></div>` :
      request.url === '/properties' ?
        '<input aria-label="Name" value="Alice"><button>Save</button>' :
      request.url === '/elements' ?
      temporal ? '<div role="dialog" aria-label="Confirm"><button onclick="this.closest(\'div\').remove()">Close</button></div>' :
        `<button${freshMode === 'disabled_add' ? ' disabled' : ''} onclick="document.body.insertAdjacentHTML('beforeend', '<button${freshMode === 'hidden_delete' ? ' hidden' : ''}>Delete</button>')">Add Element</button>${freshMode === 'duplicate_add' ? '<button>Add Element</button>' : ''}${freshMode === 'preexisting_delete' ? '<button>Delete</button>' : ''}` :
      freshMode === 'changed_link' ? '<button onclick="location.href=\'/elements\'">Add/Remove Elements</button>' :
        '<a href="/elements">Add/Remove Elements</a>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const url = `http://127.0.0.1:${address.port}/`;
  const goal = (id: string, clause: string, name: string, expected: 'present' | 'absent') => ({
    id, type: 'verification_goal', sourceText: clause, instruction: clause,
    subject: { role: 'button', accessibleName: name },
    intent: { kind: 'presence', expected },
  });
  const finalClause = falseGoal ? 'Verify there are exactly two Delete button elements.' :
    'Confirm a button with the text "Delete" exists.';
  const linkClause = linkVariant === 'mismatched_source' ?
    'Locate the link that says Another Link and click it.' :
    linkVariant === 'authored_accessible_name' ?
      'Locate the link that says Add/Remove Elements and click it.' :
      'Click the Add/Remove Elements link.';
  const linkDescription = linkVariant ? 'link with accessible name "Add/Remove Elements"' :
    'Add/Remove Elements link';
  const steps = temporal ? [
    { id: 'go', type: 'navigate', sourceText: `Go to ${url}.`, url },
    { id: 'link', type: 'click', sourceText: linkClause,
      target: { description: linkDescription } },
    { id: 'modal-present', type: 'verification_goal',
      sourceText: 'Confirm the Confirm dialog exists.',
      instruction: 'Confirm the Confirm dialog exists.',
      subject: { role: 'dialog', accessibleName: 'Confirm' },
      intent: { kind: 'presence', expected: 'present' } },
    { id: 'close-action', type: 'click', sourceText: 'Click the Close button.',
      target: { description: 'Close button' } },
    { id: 'modal-disappears', type: 'verification_goal',
      sourceText: 'Make sure the Confirm dialog disappears.',
      instruction: 'Make sure the Confirm dialog disappears.',
      subject: { role: 'dialog', accessibleName: 'Confirm' },
      intent: { kind: 'temporal', transition: 'disappears' },
      dependsOnStepId: 'close-action' },
  ] : [
    { id: 'go', type: 'navigate', sourceText: `Go to ${url}.`, url },
    { id: 'link', type: 'click', sourceText: linkClause,
      target: { description: linkDescription } },
    goal('add-goal', 'Confirm the Add Element button exists.', 'Add Element', 'present'),
    goal('absent-goal', 'Confirm a button with the text "Delete" does not exist.', 'Delete', 'absent'),
    { id: 'add-action', type: 'click', sourceText: linkVariant ?
      'Click the "Add Element" button.' : 'Click the Add Element button.',
      target: { description: linkVariant ? 'button with accessible name "Add Element"' :
        'Add Element button' } },
    falseGoal ? { id: 'present-goal', type: 'verification_goal', sourceText: finalClause,
      instruction: finalClause, subject: { role: 'button', accessibleName: 'Delete' },
      intent: { kind: 'cardinality', comparison: 'equal', count: 2 } } :
      goal('present-goal', finalClause, 'Delete', 'present'),
  ];
  const source = { schemaVersion: '4', testSpecId: 'test-trace-v3-assembly',
    sourceInstruction: steps.map((step) => step.sourceText).join(' '),
    executionProfileRef: { id: 'v3-profile', version: '1' },
    startState: { url },
    steps };
  const factory = new ProtectedContextFactory(new ProfileCatalog([{
    id: 'v3-profile', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 },
    locale: 'en-US', timeoutPolicy: { actionMs: 5000, navigationMs: 5000,
      waits: { default: 3000 } }, networkPolicyRef: { id: 'v3-policy', version: '1' },
  }], [{ id: 'v3-policy', version: '1', destinations: [{ host: '127.0.0.1',
    ports: [address.port], addresses: ['127.0.0.1'] }] }]));
  const profile = factory.catalog.resolve(source.executionProfileRef);
  const session = await McpExplorationSession.open(factory, source.executionProfileRef,
    profile, 'attempt-v3');
  await session.navigate(url);
  const current = new CurrentStateExploration(session, source, 'attempt-v3');
  const observations = new TrustedObservationSessionV1(session, current);
  const root = await mkdtemp(path.join(tmpdir(), 'trace-v3-assembly-'));
  const close = async () => { await session.close(); server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true }); };
  return { source, profile, session, current, observations, root, url, close,
    setFreshMode: (mode: typeof freshMode) => { freshMode = mode; } };
}

type FailureMode = 'unresolved' | 'unsupported' | 'missing' | 'duplicate' | 'out_of_order' |
  'stale_zero' | 'cancelled' | 'budget_exhausted';
async function assembled(falseGoal = false, mode?: FailureMode,
  linkVariant?: 'authored_accessible_name' | 'mismatched_source') {
  const run = await fixture(falseGoal, false, linkVariant);
  const store = new LocalArtifactStore(run.root);
  try {
    await store.createJob(run.source, run.profile);
    const start = await run.current.observe();
    const abort = new AbortController();
    const firstDecisions: ((ctx: VerificationDecisionContextV4) => object)[] =
      mode === 'out_of_order' ? [
        () => observe('Delete'), (ctx) => count(ctx, 'equal', 0, 'satisfied'),
        () => observe('Add Element'), (ctx) => count(ctx, 'greater_than', 0, 'satisfied'),
      ] : [
        () => observe('Add Element'), (ctx) => count(ctx, 'greater_than', 0, 'satisfied'),
        () => observe('Delete'), (ctx) => count(ctx, 'equal', 0, 'satisfied'),
      ];
    const lastDecisions: ((ctx: VerificationDecisionContextV4) => object)[] =
      mode === 'unresolved' || mode === 'unsupported' ?
        [() => ({ decisionVersion: '4', kind: 'conclude', conclusion: mode })] : [
          () => observe('Delete'), (ctx) => count(ctx, falseGoal ? 'equal' : 'greater_than',
            falseGoal ? 2 : 0, falseGoal ? 'unsatisfied' : 'satisfied'),
        ];
    const model = scripted([...firstDecisions, ...lastDecisions]);
    let controller: GoalDirectedVerificationControllerV1 | undefined;
    const forgedStrategies: SuccessfulVerificationStrategyV1[] = [];
    let completion: 'running' | 'budget_exhausted' = 'running';
    const builder = new SuccessfulTraceAssemblerV3(run.source, {
      current: run.current, observations: run.observations,
      strategyJournal: () => [...(controller?.successfulStrategies ?? []), ...forgedStrategies],
      startedAt: new Date().toISOString(), startStateDigest: start.stateDigest,
      profileFingerprint: run.profile.fingerprint, signal: abort.signal,
      completionState: () => completion,
    });
    await run.session.navigate(run.url); run.current.invalidate();
    let view = await run.current.observe();
    await builder.appendObservedRecord({ type: 'navigate', recordId: 'record-go', sequence: 1,
      source: 'authored', originStepId: 'go', preStateDigest: start.stateDigest,
      postStateDigest: view.stateDigest, observationDigest: view.snapshotDigest,
      url: run.url, result: 'completed' });
    const link = /link "Add\/Remove Elements" \[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(view.snapshot)?.[1];
    expect(link).toBeTruthy();
    await run.current.act(await run.current.bind('link', 'click', link!));
    builder.appendCurrentStateAction(run.current.successfulActions.at(-1)!);
    controller = new GoalDirectedVerificationControllerV1(run.observations, run.current, model);
    for (const ordinal of mode === 'out_of_order' ? [3, 2] : [2, 3]) {
      const goal = run.source.steps[ordinal]!;
      expect((await controller.evaluate(goal, ordinal)).conclusion).toBe('satisfied');
      await builder.appendVerificationGoal(goal.id);
    }
    const oldZero = controller.successfulStrategies.find((strategy) =>
      strategy.goalStepId === 'absent-goal')!.observationIds[0]!;
    view = await run.current.observe();
    const add = /button "Add Element" \[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(view.snapshot)?.[1];
    expect(add).toBeTruthy();
    const action = await run.current.act(await run.current.bind('add-action', 'click', add!));
    builder.appendCurrentStateAction(run.current.successfulActions.at(-1)!);
    controller.noteSuccessfulAction(action);
    expect(await run.observations.currentEvidence(run.observations.protectedRecord(oldZero))).toBeUndefined();
    if (mode === 'stale_zero') {
      const previous = controller.successfulStrategies.find((strategy) =>
        strategy.goalStepId === 'absent-goal')!;
      const data = { ...previous, goalStepId: 'present-goal', actionOrdinal: 2,
        comparison: { kind: 'count' as const, observationId: oldZero,
          operator: 'greater_than' as const, expected: 0 },
        evaluated: false, conclusion: 'unsatisfied' as const };
      const { strategyDigest: _old, ...digestData } = data;
      forgedStrategies.push({ ...digestData, strategyDigest: hash(digestData) });
      await builder.appendVerificationGoal('present-goal');
      throw new Error('Stale zero-match strategy was incorrectly accepted');
    }
    const result = await controller.evaluate(run.source.steps[5]!, 5);
    if (mode === 'unresolved' || mode === 'unsupported') {
      expect(result.conclusion).toBe(mode);
      await builder.appendVerificationGoal('present-goal');
      throw new Error('Non-evaluated goal was incorrectly accepted');
    }
    expect(result.conclusion).toBe(falseGoal ? 'unsatisfied' : 'satisfied');
    if (mode !== 'missing') await builder.appendVerificationGoal('present-goal');
    if (mode === 'duplicate') {
      await builder.appendVerificationGoal('present-goal');
      throw new Error('Duplicate goal was incorrectly accepted');
    }
    if (mode === 'cancelled') abort.abort();
    if (mode === 'budget_exhausted') completion = 'budget_exhausted';
    const output = builder.finalize({ finishedAt: new Date().toISOString() });
    return { run, store, output, builder, abort, controller, oldZero };
  } catch (error) { await run.close(); throw error; }
}

test('v3 assembles Add/Remove actions and goals, persists immutable trace, and reads it back', async () => {
  const { run, store, output, oldZero } = await assembled();
  try {
    const artifact = output.protectedArtifact();
    expect(artifact.trace.successfulPath.map((entry) => entry.originStepId)).toEqual([
      'go', 'link', 'add-goal', 'absent-goal', 'add-action', 'present-goal',
    ]);
    const goals = artifact.trace.successfulPath.filter((entry) => entry.type === 'verification_goal');
    expect(goals.map((goal) => goal.conclusion)).toEqual(['satisfied', 'satisfied', 'satisfied']);
    expect(goals[1]?.observations[0]).toMatchObject({ status: 'complete',
      result: { kind: 'matches', count: 0 } });
    expect(goals[2]?.observations[0]).toMatchObject({ status: 'complete',
      result: { kind: 'matches', count: 1 } });
    expect(goals[1]?.observationIds).toContain(oldZero);
    expect(goals[2]?.observationIds).not.toContain(oldZero);
    await store.writeSuccessfulExplorationV3(output);
    const readback = await new LocalArtifactStore(run.root).readSuccessfulExplorationV3(
      run.source.testSpecId, 'attempt-v3');
    expect(readback.trace).toEqual(artifact.trace);
    await expect(store.writeSuccessfulExplorationV3(output)).rejects.toThrow();
    await expect(store.readSuccessfulExploration(run.source.testSpecId, 'attempt-v3')).rejects.toThrow();
  } finally { await run.close(); }
});

test('WP4B fresh compiler maps Add/Remove verification strategies to immutable v7 assertions', async () => {
  const { run, store, output } = await assembled();
  try {
    await store.writeSuccessfulExplorationV3(output);
    const factory = new ProtectedContextFactory(new ProfileCatalog([run.profile.profile],
      [run.profile.policy]));
    const result = await compileSuccessfulTraceV3(factory, store, run.source.testSpecId, 'attempt-v3');
    expect(result.kind, result.kind === 'compiled' ? '' : JSON.stringify(result.compiler.checks.filter(
      (check) => check.result === 'failed'))).toBe('compiled');
    if (result.kind !== 'compiled') return;
    expect(result.resolved.executionSteps.map((step) => step.type)).toEqual([
      'navigate', 'click', 'verification_goal', 'verification_goal', 'click', 'verification_goal',
    ]);
    expect(result.resolved.executionSteps.filter((step) => step.type === 'verification_goal')
      .map((step) => step.assertion)).toMatchObject([
        { kind: 'semantic_count', query: { role: 'button', name: 'Add Element' },
          operator: 'greater_than', expected: 0 },
        { kind: 'semantic_count', query: { role: 'button', name: 'Delete' },
          operator: 'equal', expected: 0 },
        { kind: 'semantic_count', query: { role: 'button', name: 'Delete' },
          operator: 'greater_than', expected: 0 },
      ]);
    expect((await store.readCompiledExplorationV7(run.source.testSpecId, 'attempt-v3',
      result.compiler.compilerAttemptId)).resolved).toEqual(result.resolved);
    await expect(store.readCompiledExplorationV6(run.source.testSpecId, 'attempt-v3',
      result.compiler.compilerAttemptId)).rejects.toThrow();
    await expect(compileSuccessfulTraceV1(factory, store, run.source.testSpecId,
      'attempt-v3')).rejects.toThrow();
    expect(JSON.stringify(result)).not.toContain('QA_ASSERTION_');
    await expect(store.writeCompiledExplorationV7({ compiler: result.compiler,
      resolved: result.resolved })).rejects.toThrow();
    const artifactFile = path.join(run.root, run.source.testSpecId,
      'agentic-compiler-attempts-v2', result.compiler.successfulTraceId,
      `${result.compiler.compilerAttemptId}.json`);
    const tampered = JSON.parse(await readFile(artifactFile, 'utf8')) as Record<string, any>;
    tampered.resolved.executionSteps[3].assertion.expected = 1;
    await writeFile(artifactFile, JSON.stringify(tampered));
    await expect(store.readCompiledExplorationV7(run.source.testSpecId, 'attempt-v3',
      result.compiler.compilerAttemptId)).rejects.toThrow();
  } finally { await run.close(); }
});

test('WP4B accepts the live authored link phrase only when its accessible-name target agrees', async () => {
  const accepted = await assembled(false, undefined, 'authored_accessible_name');
  try {
    await accepted.store.writeSuccessfulExplorationV3(accepted.output);
    const factory = new ProtectedContextFactory(new ProfileCatalog([accepted.run.profile.profile],
      [accepted.run.profile.policy]));
    const result = await compileSuccessfulTraceV3(factory, accepted.store,
      accepted.run.source.testSpecId, 'attempt-v3');
    expect(result.kind, result.kind === 'compiled' ? '' : result.reason).toBe('compiled');
    if (result.kind === 'compiled') expect(result.resolved.executionSteps[1]?.type).toBe('click');
  } finally { await accepted.run.close(); }

  const mismatched = await assembled(false, undefined, 'mismatched_source');
  try {
    await mismatched.store.writeSuccessfulExplorationV3(mismatched.output);
    const factory = new ProtectedContextFactory(new ProfileCatalog([mismatched.run.profile.profile],
      [mismatched.run.profile.policy]));
    const result = await compileSuccessfulTraceV3(factory, mismatched.store,
      mismatched.run.source.testSpecId, 'attempt-v3');
    expect(result.kind).toBe('compilation_stop');
    if (result.kind !== 'compiled') expect(result.reason).toBe('UNPROVEN_IDENTITY');
  } finally { await mismatched.run.close(); }
});

test('WP5A executes accepted Add/Remove v7 in a fresh protected run and rejects v6 dispatch', async () => {
  const { run, store, output } = await assembled();
  try {
    await store.writeSuccessfulExplorationV3(output);
    const factory = new ProtectedContextFactory(new ProfileCatalog([run.profile.profile],
      [run.profile.policy]));
    const compiled = await compileSuccessfulTraceV3(factory, store, run.source.testSpecId, 'attempt-v3');
    expect(compiled.kind).toBe('compiled');
    if (compiled.kind !== 'compiled') return;
    const artifact = output.protectedArtifact();
    const proof = parseProtectedTraceCaptureBundleV3(artifact.capture, artifact.trace);
    const provenance = { attempt: artifact.attempt, trace: artifact.trace,
      protectedSource: proof.source, compiler: compiled.compiler };
    const replay = await executeResolvedTestSpecV7(factory, run.source, compiled.resolved, provenance);
    expect(replay.outcomes.map((result) => result.status)).toEqual([
      'OPERATION_SUCCEEDED', 'OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED',
      'QA_ASSERTION_PASSED', 'OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED',
    ]);
    await expect(executeResolvedTestSpecV6(factory, run.source, compiled.resolved,
      provenance as unknown as Parameters<typeof executeResolvedTestSpecV6>[3])).rejects.toThrow();
    await expect(executeResolvedTestSpecV7(factory, run.source,
      { ...compiled.resolved, executionSteps: compiled.resolved.executionSteps.map((step) =>
        step.type === 'verification_goal' && step.goalStepId === 'absent-goal' ?
          { ...step, assertion: { ...step.assertion, expected: 1 } } : step) },
      provenance)).rejects.toThrow();
  } finally { await run.close(); }
});

test('WP5A evaluated false count is a deterministic failed assertion, never an automation stop', async () => {
  const { run, store, output } = await assembled();
  try {
    await store.writeSuccessfulExplorationV3(output);
    const factory = new ProtectedContextFactory(new ProfileCatalog([run.profile.profile],
      [run.profile.policy]));
    const compiled = await compileSuccessfulTraceV3(factory, store, run.source.testSpecId, 'attempt-v3');
    expect(compiled.kind).toBe('compiled');
    if (compiled.kind !== 'compiled') return;
    run.setFreshMode('preexisting_delete');
    const artifact = output.protectedArtifact();
    const proof = parseProtectedTraceCaptureBundleV3(artifact.capture, artifact.trace);
    const replay = await executeResolvedTestSpecV7(factory, run.source, compiled.resolved,
      { attempt: artifact.attempt, trace: artifact.trace, protectedSource: proof.source,
        compiler: compiled.compiler });
    expect(replay.outcomes[3]).toMatchObject({ status: 'QA_ASSERTION_FAILED',
      reason: 'VERIFICATION_FALSE' });
    expect(replay.outcomes[4]).toMatchObject({ status: 'NOT_RUN' });
  } finally { await run.close(); }
});

test('WP4B pre-open failure creates no compiler attempt with a fabricated session ID', async () => {
  const { run, store, output } = await assembled();
  try {
    await store.writeSuccessfulExplorationV3(output);
    const failingFactory = { open: async () => { throw new Error('Protected browser unavailable'); } } as
      unknown as ProtectedContextFactory;
    await expect(compileSuccessfulTraceV3(failingFactory, store, run.source.testSpecId,
      'attempt-v3')).rejects.toThrow('Fresh protected v3 compiler context was unavailable');
    const directory = path.join(run.root, run.source.testSpecId, 'agentic-compiler-attempts-v2');
    expect(await readdir(directory).catch((error: NodeJS.ErrnoException) =>
      error.code === 'ENOENT' ? [] : Promise.reject(error))).toEqual([]);
  } finally { await run.close(); }
});

test('WP4B preserves an evaluated-false cardinality predicate without a QA verdict', async () => {
  const { run, store, output } = await assembled(true);
  try {
    await store.writeSuccessfulExplorationV3(output);
    const factory = new ProtectedContextFactory(new ProfileCatalog([run.profile.profile],
      [run.profile.policy]));
    const result = await compileSuccessfulTraceV3(factory, store, run.source.testSpecId, 'attempt-v3');
    expect(result.kind).toBe('compiled');
    if (result.kind !== 'compiled') return;
    expect(result.resolved.executionSteps.at(-1)).toMatchObject({ type: 'verification_goal',
      assertion: { kind: 'semantic_count', operator: 'equal', expected: 2 } });
    expect(JSON.stringify(result)).not.toContain('QA_ASSERTION_');
  } finally { await run.close(); }
});

test('WP4B detects fresh count drift, unique-target ambiguity, and changed action identity', async () => {
  for (const [mode, reason] of [
    ['preexisting_delete', 'POSTCONDITION_MISMATCH'],
    ['duplicate_add', 'NON_UNIQUE_MATCH'],
    ['changed_link', 'TARGET_MISMATCH'],
  ] as const) {
    const { run, store, output } = await assembled();
    try {
      await store.writeSuccessfulExplorationV3(output);
      run.setFreshMode(mode);
      const factory = new ProtectedContextFactory(new ProfileCatalog([run.profile.profile],
        [run.profile.policy]));
      const result = await compileSuccessfulTraceV3(factory, store, run.source.testSpecId, 'attempt-v3');
      expect(result.kind, mode).toBe('compilation_stop');
      if (result.kind === 'compiled') continue;
      expect(result.reason, mode).toBe(reason);
      expect(result.compiler.result.status).toBe('rejected');
      expect(await store.readCompilerAttemptV2(run.source.testSpecId, 'attempt-v3',
        result.compiler.compilerAttemptId)).toEqual(result.compiler);
      expect(JSON.stringify(result)).not.toContain('QA_ASSERTION_');
    } finally { await run.close(); }
  }
});

test('WP4B complete count still proves presence when fresh Delete is hidden', async () => {
  const { run, store, output } = await assembled();
  try {
    await store.writeSuccessfulExplorationV3(output);
    run.setFreshMode('hidden_delete');
    const factory = new ProtectedContextFactory(new ProfileCatalog([run.profile.profile],
      [run.profile.policy]));
    const result = await compileSuccessfulTraceV3(factory, store, run.source.testSpecId, 'attempt-v3');
    expect(result.kind).toBe('compiled');
    if (result.kind !== 'compiled') return;
    expect(result.resolved.executionSteps.at(-1)).toMatchObject({ type: 'verification_goal',
      assertion: { kind: 'semantic_count', query: { role: 'button', name: 'Delete' },
        operator: 'greater_than', expected: 0 } });
  } finally { await run.close(); }
});

test('WP4B fresh unique-property read compiles disabled state and fails closed on ambiguity', async () => {
  const run = await fixture();
  try {
    run.setFreshMode('disabled_add');
    const pageUrl = new URL('/elements', run.url).href;
    const clause = 'Verify the Add Element button is disabled.';
    const source = { schemaVersion: '4', testSpecId: 'test-v7-disabled',
      sourceInstruction: clause, executionProfileRef: run.source.executionProfileRef,
      startState: { url: pageUrl }, steps: [{ id: 'disabled-goal', type: 'verification_goal',
        sourceText: clause, instruction: clause,
        subject: { role: 'button', accessibleName: 'Add Element' },
        intent: { kind: 'property', property: 'enabled', expected: false } }] };
    const store = new LocalArtifactStore(run.root);
    await store.createJob(source, run.profile);
    await run.session.navigate(pageUrl);
    const current = new CurrentStateExploration(run.session, source, 'attempt-disabled');
    const observations = new TrustedObservationSessionV1(run.session, current);
    const start = await current.observe();
    const model = scripted([
      () => ({ decisionVersion: '4', kind: 'observe', request: { kind: 'target_property',
        query: { role: 'button', name: 'Add Element', frame: { kind: 'main' } },
        property: 'enabled' } }),
      (ctx) => ({ decisionVersion: '4', kind: 'conclude', conclusion: 'satisfied',
        comparison: { kind: 'boolean', observationId: ctx.observations.at(-1)!.observationId,
          property: 'enabled', expected: false } }),
    ]);
    const controller = new GoalDirectedVerificationControllerV1(observations, current, model);
    const builder = new SuccessfulTraceAssemblerV3(source, {
      current, observations, strategyJournal: () => controller.successfulStrategies,
      startedAt: new Date().toISOString(), startStateDigest: start.stateDigest,
      profileFingerprint: run.profile.fingerprint, signal: new AbortController().signal,
      completionState: () => 'running',
    });
    expect((await controller.evaluate(source.steps[0]!, 0)).conclusion).toBe('satisfied');
    await builder.appendVerificationGoal('disabled-goal');
    await store.writeSuccessfulExplorationV3(builder.finalize({ finishedAt: new Date().toISOString() }));
    const factory = new ProtectedContextFactory(new ProfileCatalog([run.profile.profile],
      [run.profile.policy]));
    const accepted = await compileSuccessfulTraceV3(factory, store, source.testSpecId, 'attempt-disabled');
    expect(accepted.kind).toBe('compiled');
    if (accepted.kind === 'compiled')
      expect(accepted.resolved.executionSteps[0]).toMatchObject({
        assertion: { kind: 'unique_boolean_property', property: 'enabled', expected: false },
      });
    run.setFreshMode('duplicate_add');
    const ambiguous = await compileSuccessfulTraceV3(factory, store, source.testSpecId, 'attempt-disabled');
    expect(ambiguous.kind).toBe('compilation_stop');
    if (ambiguous.kind !== 'compiled') expect(ambiguous.reason).toBe('NON_UNIQUE_MATCH');
  } finally { await run.close(); }
});

test('WP4B distinguishes complete nested-frame zero from frame reconstruction failure', async () => {
  const run = await fixture();
  try {
    run.setFreshMode('nested_frame');
    const pageUrl = new URL('/frame', run.url).href;
    const clause = 'Confirm the Remove button does not exist in the Payment frame inside the Actions dialog.';
    const source = { schemaVersion: '4', testSpecId: 'test-v7-frame-zero',
      sourceInstruction: clause, executionProfileRef: run.source.executionProfileRef,
      startState: { url: pageUrl }, steps: [{ id: 'frame-goal', type: 'verification_goal',
        sourceText: clause, instruction: clause,
        subject: { role: 'button', accessibleName: 'Remove',
          scope: [{ kind: 'frame', description: 'Payment' },
            { kind: 'dialog', description: 'Actions' }] },
        intent: { kind: 'presence', expected: 'absent' } }] };
    const store = new LocalArtifactStore(run.root);
    await store.createJob(source, run.profile);
    await run.session.navigate(pageUrl);
    const current = new CurrentStateExploration(run.session, source, 'attempt-frame');
    const observations = new TrustedObservationSessionV1(run.session, current);
    const start = await current.observe();
    const request = { kind: 'semantic_query', query: { role: 'button', name: 'Remove',
      frame: { kind: 'nested', anchors: [{ kind: 'title', value: 'Payment', exact: true }] },
      within: [{ kind: 'dialog', name: 'Actions' }] } };
    const controller = new GoalDirectedVerificationControllerV1(observations, current,
      scripted([
        () => ({ decisionVersion: '4', kind: 'observe', request }),
        (ctx) => ({ decisionVersion: '4', kind: 'conclude', conclusion: 'satisfied',
          comparison: { kind: 'count', observationId: ctx.observations.at(-1)!.observationId,
            operator: 'equal', expected: 0 } }),
      ]));
    const builder = new SuccessfulTraceAssemblerV3(source, {
      current, observations, strategyJournal: () => controller.successfulStrategies,
      startedAt: new Date().toISOString(), startStateDigest: start.stateDigest,
      profileFingerprint: run.profile.fingerprint, signal: new AbortController().signal,
      completionState: () => 'running',
    });
    expect((await controller.evaluate(source.steps[0]!, 0)).conclusion).toBe('satisfied');
    await builder.appendVerificationGoal('frame-goal');
    await store.writeSuccessfulExplorationV3(builder.finalize({ finishedAt: new Date().toISOString() }));
    const factory = new ProtectedContextFactory(new ProfileCatalog([run.profile.profile],
      [run.profile.policy]));
    const accepted = await compileSuccessfulTraceV3(factory, store, source.testSpecId, 'attempt-frame');
    expect(accepted.kind).toBe('compiled');
    if (accepted.kind === 'compiled') expect(accepted.resolved.executionSteps[0]).toMatchObject({
      assertion: { kind: 'semantic_count', operator: 'equal', expected: 0,
        query: { frame: { kind: 'nested', anchors: [{ value: 'Payment' }] } } },
    });
    run.setFreshMode('frame_drift');
    const drift = await compileSuccessfulTraceV3(factory, store, source.testSpecId, 'attempt-frame');
    expect(drift.kind).toBe('compilation_stop');
    if (drift.kind !== 'compiled') expect(drift.reason).toBe('UNPROVEN_IDENTITY');
    run.setFreshMode('scope_drift');
    const scopeDrift = await compileSuccessfulTraceV3(factory, store, source.testSpecId, 'attempt-frame');
    expect(scopeDrift.kind).toBe('compilation_stop');
    if (scopeDrift.kind !== 'compiled') expect(scopeDrift.reason).toBe('UNPROVEN_IDENTITY');
  } finally { await run.close(); }
});

test('WP4B reconstructs fresh unique value, text, and URL observations', async () => {
  const run = await fixture();
  try {
    const pageUrl = new URL('/properties', run.url).href;
    const clauses = [
      'Verify the Name textbox value is Alice.',
      'Verify the Save button text is Save.',
      `Verify the URL is ${pageUrl}.`,
    ];
    const source = { schemaVersion: '4', testSpecId: 'test-v7-values',
      sourceInstruction: clauses.join(' '), executionProfileRef: run.source.executionProfileRef,
      startState: { url: pageUrl }, steps: [
        { id: 'value-goal', type: 'verification_goal', sourceText: clauses[0], instruction: clauses[0],
          subject: { role: 'textbox', accessibleName: 'Name' } },
        { id: 'text-goal', type: 'verification_goal', sourceText: clauses[1], instruction: clauses[1],
          subject: { role: 'button', accessibleName: 'Save' } },
        { id: 'url-goal', type: 'verification_goal', sourceText: clauses[2], instruction: clauses[2] },
      ] };
    const store = new LocalArtifactStore(run.root);
    await store.createJob(source, run.profile);
    await run.session.navigate(pageUrl);
    const current = new CurrentStateExploration(run.session, source, 'attempt-values');
    const observations = new TrustedObservationSessionV1(run.session, current);
    const start = await current.observe();
    const plans = [
      { request: { kind: 'target_property', query: { role: 'textbox', name: 'Name',
        frame: { kind: 'main' } }, property: 'value' }, property: 'value', expected: 'Alice' },
      { request: { kind: 'target_property', query: { role: 'button', name: 'Save',
        frame: { kind: 'main' } }, property: 'text' }, property: 'text', expected: 'Save' },
      { request: { kind: 'current_url' }, property: 'url', expected: pageUrl },
    ];
    const decisions = plans.flatMap((plan) => [
      () => ({ decisionVersion: '4', kind: 'observe', request: plan.request }),
      (ctx: VerificationDecisionContextV4) => ({ decisionVersion: '4', kind: 'conclude',
        conclusion: 'satisfied', comparison: { kind: 'string',
          observationId: ctx.observations.at(-1)!.observationId,
          property: plan.property, operator: 'equal', expected: plan.expected } }),
    ]);
    const controller = new GoalDirectedVerificationControllerV1(observations, current,
      scripted(decisions));
    const builder = new SuccessfulTraceAssemblerV3(source, {
      current, observations, strategyJournal: () => controller.successfulStrategies,
      startedAt: new Date().toISOString(), startStateDigest: start.stateDigest,
      profileFingerprint: run.profile.fingerprint, signal: new AbortController().signal,
      completionState: () => 'running',
    });
    for (const [ordinal, step] of source.steps.entries()) {
      expect((await controller.evaluate(step, ordinal)).conclusion).toBe('satisfied');
      await builder.appendVerificationGoal(step.id);
    }
    await store.writeSuccessfulExplorationV3(builder.finalize({ finishedAt: new Date().toISOString() }));
    const factory = new ProtectedContextFactory(new ProfileCatalog([run.profile.profile],
      [run.profile.policy]));
    const result = await compileSuccessfulTraceV3(factory, store, source.testSpecId, 'attempt-values');
    expect(result.kind, result.kind === 'compiled' ? '' : JSON.stringify(result.compiler.checks.filter(
      (check) => check.result === 'failed'))).toBe('compiled');
    if (result.kind === 'compiled') expect(result.resolved.executionSteps.map((step) =>
      step.type === 'verification_goal' ? step.assertion.kind : step.type)).toEqual([
      'unique_string_property', 'unique_string_property', 'url',
    ]);
  } finally { await run.close(); }
});

test('evaluated false goal persists as exploration evidence without QA failure', async () => {
  const { run, store, output } = await assembled(true);
  try {
    await store.writeSuccessfulExplorationV3(output);
    const readback = await store.readSuccessfulExplorationV3(run.source.testSpecId, 'attempt-v3');
    expect(readback.trace.successfulPath.at(-1)).toMatchObject({ type: 'verification_goal',
      conclusion: 'unsatisfied', evaluated: false });
    expect(JSON.stringify(readback)).not.toContain('QA_ASSERTION_FAILED');
  } finally { await run.close(); }
});

test('stored v3 capture digest and witness tampering fail readback', async () => {
  const { run, store, output } = await assembled();
  try {
    await store.writeSuccessfulExplorationV3(output);
    const file = path.join(run.root, run.source.testSpecId, 'agentic-explorations-v3', 'attempt-v3.json');
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, any>;
    raw.capture.observations[0].record.witnessDigest = 'f'.repeat(64);
    await writeFile(file, JSON.stringify(raw));
    await expect(store.readSuccessfulExplorationV3(run.source.testSpecId, 'attempt-v3'))
      .rejects.toThrow('digest mismatch');
    raw.captureDigest = hash(raw.capture);
    await writeFile(file, JSON.stringify(raw));
    await expect(store.readSuccessfulExplorationV3(run.source.testSpecId, 'attempt-v3'))
      .rejects.toThrow('witness mismatch');
    raw.capture = output.protectedArtifact().capture;
    raw.capture.sessionId = 'session-forged';
    raw.captureDigest = hash(raw.capture);
    await writeFile(file, JSON.stringify(raw));
    await expect(store.readSuccessfulExplorationV3(run.source.testSpecId, 'attempt-v3'))
      .rejects.toThrow('ownership mismatch');
  } finally { await run.close(); }
});

test('readback rejects observation owner, page, frame, and state provenance changes', async () => {
  const { run, store, output } = await assembled();
  try {
    await store.writeSuccessfulExplorationV3(output);
    const file = path.join(run.root, run.source.testSpecId, 'agentic-explorations-v3', 'attempt-v3.json');
    const pristine = JSON.parse(await readFile(file, 'utf8')) as Record<string, any>;
    const mutations: Array<(record: Record<string, any>) => void> = [
      (record) => { record.explorationAttemptId = 'attempt-forged'; },
      (record) => { record.sessionId = 'session-forged'; },
      (record) => { record.pageId = 'page-forged'; },
      (record) => { record.frame = { kind: 'unresolved' }; },
      (record) => { record.stateEpoch += 1; },
      (record) => { record.mutationEpoch += 1; },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(pristine);
      mutate(candidate.capture.observations[0].record);
      candidate.captureDigest = hash(candidate.capture);
      await writeFile(file, JSON.stringify(candidate));
      await expect(store.readSuccessfulExplorationV3(run.source.testSpecId, 'attempt-v3'))
        .rejects.toThrow();
    }
  } finally { await run.close(); }
});

test('temporal present, action, absent strategy persists ordered historical evidence', async () => {
  const run = await fixture(false, true);
  try {
    const store = new LocalArtifactStore(run.root);
    await store.createJob(run.source, run.profile);
    const start = await run.current.observe();
    let controller: GoalDirectedVerificationControllerV1 | undefined;
    const builder = new SuccessfulTraceAssemblerV3(run.source, {
      current: run.current, observations: run.observations,
      strategyJournal: () => controller?.successfulStrategies ?? [],
      startedAt: new Date().toISOString(), startStateDigest: start.stateDigest,
      profileFingerprint: run.profile.fingerprint, signal: new AbortController().signal,
      completionState: () => 'running',
    });
    await run.session.navigate(run.url); run.current.invalidate();
    let view = await run.current.observe();
    await builder.appendObservedRecord({ type: 'navigate', recordId: 'record-go', sequence: 1,
      source: 'authored', originStepId: 'go', preStateDigest: start.stateDigest,
      postStateDigest: view.stateDigest, observationDigest: view.snapshotDigest,
      url: run.url, result: 'completed' });
    const link = /link "Add\/Remove Elements" \[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(view.snapshot)?.[1];
    await run.current.act(await run.current.bind('link', 'click', link!));
    builder.appendCurrentStateAction(run.current.successfulActions.at(-1)!);
    let earlierId = '';
    controller = new GoalDirectedVerificationControllerV1(run.observations, run.current,
      scripted([
        () => ({ decisionVersion: '4', kind: 'observe', request: { kind: 'semantic_query',
          query: { role: 'dialog', name: 'Confirm', frame: { kind: 'main' } } } }),
        (ctx) => { earlierId = ctx.observations.at(-1)!.observationId;
          return count(ctx, 'greater_than', 0, 'satisfied'); },
        () => ({ decisionVersion: '4', kind: 'observe', request: { kind: 'semantic_query',
          query: { role: 'dialog', name: 'Confirm', frame: { kind: 'main' } } } }),
        (ctx) => ({ decisionVersion: '4', kind: 'conclude', conclusion: 'satisfied',
          comparison: { kind: 'transition', earlierObservationId: earlierId,
            laterObservationId: ctx.observations.at(-1)!.observationId,
            operator: 'disappears' } }),
      ]));
    expect((await controller.evaluate(run.source.steps[2]!, 2)).conclusion).toBe('satisfied');
    await builder.appendVerificationGoal('modal-present');
    view = await run.current.observe();
    const close = /button "Close" \[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(view.snapshot)?.[1];
    const action = await run.current.act(await run.current.bind('close-action', 'click', close!));
    builder.appendCurrentStateAction(run.current.successfulActions.at(-1)!);
    controller.noteSuccessfulAction(action);
    expect((await controller.evaluate(run.source.steps[4]!, 4)).conclusion).toBe('satisfied');
    const record = await builder.appendVerificationGoal('modal-disappears');
    expect(record.temporal?.earlierObservationId).toBe(earlierId);
    expect(record.temporal?.transitionRecordIds).toEqual([action.recordId]);
    const output = builder.finalize({ finishedAt: new Date().toISOString() });
    await store.writeSuccessfulExplorationV3(output);
    const persisted = await store.readSuccessfulExplorationV3(run.source.testSpecId, 'attempt-v3');
    expect(persisted.trace.successfulPath.at(-1)).toMatchObject({ type: 'verification_goal',
      conclusion: 'satisfied', temporal: { transitionRecordIds: [action.recordId] } });
    expect(await run.observations.currentEvidence(run.observations.protectedRecord(earlierId)))
      .toBeUndefined();
    const factory = new ProtectedContextFactory(new ProfileCatalog([run.profile.profile],
      [run.profile.policy]));
    const compilation = await compileSuccessfulTraceV3(factory, store, run.source.testSpecId, 'attempt-v3');
    expect(compilation.kind).toBe('compilation_unsupported');
    if (compilation.kind !== 'compiled') {
      expect(compilation.reason).toBe('UNSUPPORTED_TEMPORAL_REPLAY');
      expect(await store.readCompilerAttemptV2(run.source.testSpecId, 'attempt-v3',
        compilation.compiler.compilerAttemptId)).toEqual(compilation.compiler);
    }
  } finally { await run.close(); }
});

test('missing or unresolved goals and cancellation cannot finalize a v3 path', async () => {
  const run = await fixture();
  try {
    const start = await run.current.observe();
    const abort = new AbortController();
    let completion: 'running' | 'budget_exhausted' = 'running';
    const builder = new SuccessfulTraceAssemblerV3(run.source, {
      current: run.current, observations: run.observations,
      strategyJournal: () => [], startedAt: new Date().toISOString(),
      startStateDigest: start.stateDigest, profileFingerprint: run.profile.fingerprint,
      signal: abort.signal, completionState: () => completion,
    });
    await expect(builder.appendVerificationGoal('add-goal')).rejects.toThrow('lacks one successful strategy');
    expect(() => builder.finalize({ finishedAt: new Date().toISOString() })).toThrow();
    completion = 'budget_exhausted';
    expect(() => builder.finalize({ finishedAt: new Date().toISOString() }))
      .toThrow('budget-exhausted');
    completion = 'running';
    abort.abort();
    expect(() => builder.finalize({ finishedAt: new Date().toISOString() }))
      .toThrow('Cancelled');
  } finally { await run.close(); }
});

test('assembly rejects stale, incomplete, duplicate, and out-of-order goal paths', async () => {
  const cases: { mode: FailureMode; expected: RegExp }[] = [
    { mode: 'stale_zero', expected: /stale/ },
    { mode: 'unresolved', expected: /lacks one successful strategy/ },
    { mode: 'unsupported', expected: /lacks one successful strategy/ },
    { mode: 'missing', expected: /not fully represented/ },
    { mode: 'duplicate', expected: /Goal cannot be appended/ },
    { mode: 'out_of_order', expected: /authored order/ },
    { mode: 'cancelled', expected: /Cancelled/ },
    { mode: 'budget_exhausted', expected: /budget-exhausted/ },
  ];
  for (const item of cases)
    await expect(assembled(false, item.mode), item.mode).rejects.toThrow(item.expected);
});
