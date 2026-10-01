import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { parseTestSpec } from '../app/domain/index.js';
import { LocalArtifactStore } from '../app/evidence/index.js';
import { McpExplorationSession } from '../app/exploration/index.js';
import { runAgenticLocalWorkflow } from '../app/local/agentic-workflow.js';
import { ModelCompletionFailure } from '../app/interpretation/model-failure.js';
import type { ExecutionRun } from '../app/runner/index.js';
import { finalizeAgenticOutcomeV2, runAgenticExplorationV1, runAgenticProductionV1,
  runGoalDirectedProductionV1,
  type AgenticDecisionModelV3, type AgenticVerificationModelV4 } from '../app/interpretation/index.js';
import { ProfileCatalog, ProtectedContextFactory } from '../app/profile/index.js';
import { envelopeForAgenticTerminalV2 } from '../app/subprocess/protocol-v2.js';
import { projectStoredAgenticReportV2 } from '../app/subprocess/report-projection-v2.js';

async function setup(falseGoal = false, temporal = false) {
  let pageMode: 'normal' | 'preexisting_delete' | 'duplicate_add' = 'normal';
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(request.url === '/elements' ?
      (temporal ? '<div role="dialog" aria-label="Confirm"><button onclick="this.closest(\'div\').remove()">Close</button></div>' :
      `<button onclick="document.body.insertAdjacentHTML('beforeend', '<button>Delete</button>')">Add Element</button>`) +
      (pageMode === 'preexisting_delete' ? '<button>Delete</button>' : '') +
      (pageMode === 'duplicate_add' ? '<button>Add Element</button>' : '') :
      '<a href="/elements">Add/Remove Elements</a>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const url = `http://127.0.0.1:${address.port}/`;
  const lastClause = falseGoal ? 'Verify there are exactly two Delete button elements.' :
    'Confirm a button with the text "Delete" exists.';
  const goal = (id: string, clause: string, name: string, expected: 'present' | 'absent') => ({
    id, type: 'verification_goal', sourceText: clause, instruction: clause,
    subject: { role: 'button', accessibleName: name }, intent: { kind: 'presence', expected },
  });
  const steps = temporal ? [
    { id: 'go', type: 'navigate', sourceText: `Go to ${url}.`, url },
    { id: 'link', type: 'click', sourceText: 'Click the Add/Remove Elements link.',
      target: { description: 'Add/Remove Elements link' } },
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
      intent: { kind: 'temporal', transition: 'disappears' }, dependsOnStepId: 'close-action' },
  ] : [
    { id: 'go', type: 'navigate', sourceText: `Go to ${url}.`, url },
    { id: 'link', type: 'click', sourceText: 'Click the Add/Remove Elements link.',
      target: { description: 'Add/Remove Elements link' } },
    goal('add-goal', 'Confirm the Add Element button exists.', 'Add Element', 'present'),
    goal('absent-goal', 'Confirm a button with the text "Delete" does not exist.', 'Delete', 'absent'),
    { id: 'add-action', type: 'click', sourceText: 'Click the Add Element button.',
      target: { description: 'Add Element button' } },
    falseGoal ? { id: 'present-goal', type: 'verification_goal', sourceText: lastClause,
      instruction: lastClause, subject: { role: 'button', accessibleName: 'Delete' },
      intent: { kind: 'cardinality', comparison: 'equal', count: 2 } } :
      goal('present-goal', lastClause, 'Delete', 'present'),
  ];
  const source = { schemaVersion: '4', testSpecId: `test-wp5b-${randomUUID()}`,
    sourceInstruction: steps.map((step) => step.sourceText).join(' '),
    executionProfileRef: { id: 'wp5b-profile', version: '1' }, startState: { url }, steps };
  const config = { profiles: [{ id: 'wp5b-profile', version: '1', browser: 'chromium',
    viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: { default: 3000 } },
    networkPolicyRef: { id: 'wp5b-policy', version: '1' } }],
    networkPolicies: [{ id: 'wp5b-policy', version: '1', destinations: [{
      host: '127.0.0.1', ports: [address.port], addresses: ['127.0.0.1'] }] }],
    evidencePolicy: { finalScreenshot: false, failureScreenshot: false,
      failureTrace: false, failureVideo: false, sensitiveBinaryApproved: false },
    artifactRoot: await mkdtemp(path.join(tmpdir(), 'wp5b-')), retentionDays: 7 };
  const factory = new ProtectedContextFactory(new ProfileCatalog(config.profiles as never,
    config.networkPolicies as never));
  const store = new HookStore(config.artifactRoot);
  await store.createJob(source, factory.catalog.resolve(source.executionProfileRef));
  return { source, config, factory, store,
    setPageMode: (mode: typeof pageMode) => { pageMode = mode; }, close: async () => {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(config.artifactRoot, { recursive: true, force: true });
  } };
}

class HookStore extends LocalArtifactStore {
  afterRun?: (ordinal: number) => void;
  afterCompilation?: () => void;
  #runs = 0;
  override async writeCompiledExplorationV7(input: { compiler: unknown; resolved: unknown }) {
    const result = await super.writeCompiledExplorationV7(input);
    this.afterCompilation?.();
    return result;
  }
  override async writeAgenticRunV7(testSpecId: string, attemptId: string,
    compilerId: string, run: ExecutionRun) {
    const result = await super.writeAgenticRunV7(testSpecId, attemptId, compilerId, run);
    this.afterRun?.(++this.#runs);
    return result;
  }
}

const seen: string[] = [];
const actionModel: AgenticDecisionModelV3 = { complete: async ({ context }) => {
  seen.push(`action:${context.authoredStep.id}:${context.stage}`);
  if (context.stage === 'evaluate') return JSON.stringify({ decisionVersion: '3', kind: 'evaluate', verdict: 'achieved' });
  const name = context.authoredStep.id === 'link' ? 'Add/Remove Elements' :
    context.authoredStep.id === 'close-action' ? 'Close' : 'Add Element';
  const role = context.authoredStep.id === 'link' ? 'link' : 'button';
  const line = context.snapshot.split('\n').find((item) => item.includes(`- ${role} "${name}"`));
  const ref = line && /\[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(line)?.[1];
  return JSON.stringify(ref ? { decisionVersion: '3', kind: 'act', ref,
    action: 'click', source: 'authored', expectedEffect: 'state_changed' } :
    { decisionVersion: '3', kind: 'inspect' });
} };
const verificationModel: AgenticVerificationModelV4 = { complete: async ({ context }) => {
  seen.push(`verification:${context.goal.id}:${context.decisionsUsed}`);
  const name = context.goal.id === 'add-goal' ? 'Add Element' :
    context.goal.id.startsWith('modal-') ? 'Confirm' : 'Delete';
  const role = context.goal.id.startsWith('modal-') ? 'dialog' : 'button';
  if (!context.observations.length) return JSON.stringify({ decisionVersion: '4', kind: 'observe',
    request: { kind: 'semantic_query', query: { role, name, frame: { kind: 'main' } } } });
  if (context.goal.id === 'modal-disappears') return JSON.stringify({ decisionVersion: '4',
    kind: 'conclude', conclusion: 'satisfied', comparison: { kind: 'transition',
      earlierObservationId: context.priorObservations.at(-1)!.observation.observationId,
      laterObservationId: context.observations.at(-1)!.observationId,
      operator: 'disappears' } });
  const comparison = context.goal.id === 'absent-goal' ? { operator: 'equal', expected: 0 } :
    context.goal.intent?.kind === 'cardinality' ? { operator: 'equal', expected: 2 } :
      { operator: 'greater_than', expected: 0 };
  const last = context.observations.at(-1)!;
  const count = last.status === 'complete' ? last.result : undefined;
  const evaluated = count?.kind === 'matches' && (comparison.operator === 'equal' ?
    count.count === comparison.expected : count.count > comparison.expected);
  return JSON.stringify({ decisionVersion: '4', kind: 'conclude',
    conclusion: evaluated ? 'satisfied' : 'unsatisfied',
    comparison: { kind: 'count', observationId: context.observations.at(-1)!.observationId,
      ...comparison } });
} };

for (const falseGoal of [false, true]) test(`goal-directed Add/Remove ${falseGoal ? 'false' : 'true'} reaches two-run QA`, async () => {
  seen.length = 0;
  const run = await setup(falseGoal);
  try {
    const outcome = await runGoalDirectedProductionV1(run.factory, run.store, run.source,
      actionModel, verificationModel, { workflowVersion: 'goal-directed-v1' });
    expect(outcome.kind, JSON.stringify({ outcome, seen })).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.resolved.schemaVersion).toBe('7');
    expect(outcome.replay[0].executionRunId).not.toBe(outcome.replay[1].executionRunId);
    const trace = (await run.store.readSuccessfulExplorationV3(run.source.testSpecId, outcome.attemptId)).trace;
    expect(trace.successfulPath.map((item) => item.originStepId)).toEqual(
      ['go', 'link', 'add-goal', 'absent-goal', 'add-action', 'present-goal']);
    const goals = trace.successfulPath.filter((item) => item.type === 'verification_goal');
    expect(goals[1]?.observations[0]).toMatchObject({ status: 'complete',
      result: { kind: 'matches', count: 0, complete: true } });
    expect(goals[2]?.observations[0]).toMatchObject({ status: 'complete',
      result: { kind: 'matches', count: 1, complete: true } });
    expect(goals[2]?.observationIds[0]).not.toBe(goals[1]?.observationIds[0]);
    expect(outcome.resolved.executionSteps.filter((item) => item.type === 'verification_goal')
      .map((item) => item.assertion)).toMatchObject([
        { kind: 'semantic_count', operator: 'greater_than', expected: 0 },
        { kind: 'semantic_count', operator: 'equal', expected: 0 },
        { kind: 'semantic_count', operator: falseGoal ? 'equal' : 'greater_than', expected: falseGoal ? 2 : 0 },
      ]);
    const result = await finalizeAgenticOutcomeV2(run.store, parseTestSpec(run.source), outcome, 'goal-directed-v1');
    expect(result.terminal.status).toBe(falseGoal ? 'QA_ASSERTION_FAILED' : 'QA_ASSERTION_PASSED');
    const projected = await projectStoredAgenticReportV2({ reportProjectionVersion: '2',
      result: envelopeForAgenticTerminalV2(result, true) }, run.config);
    expect(projected.kind).toBe('available');
    if (projected.kind === 'available') expect(projected.authoritativeQa).toBe(result.terminal.status);
  } finally { await run.close(); }
});

test('pass/fail and completed/automation replay disagreement remain non-QA', async () => {
  for (const mode of ['preexisting_delete', 'duplicate_add'] as const) {
    const run = await setup();
    try {
      run.store.afterRun = (ordinal) => { if (ordinal === 1) run.setPageMode(mode); };
      const outcome = await runGoalDirectedProductionV1(run.factory, run.store, run.source,
        actionModel, verificationModel, { workflowVersion: 'goal-directed-v1' });
      expect(outcome).toMatchObject({ kind: 'stopped', stage: 'replay',
        reasonCode: 'REPLAY_OUTCOMES_DISAGREE' });
      if (outcome.kind !== 'stopped') continue;
      expect(outcome.replay).toHaveLength(2);
      const terminal = await finalizeAgenticOutcomeV2(run.store, parseTestSpec(run.source),
        outcome, 'goal-directed-v1');
      expect(terminal.terminal).toEqual({ stage: 'reproducibility',
        status: 'REPRODUCIBILITY_FAILED', reason: 'REPLAY_OUTCOMES_DISAGREE' });
      const projection = await projectStoredAgenticReportV2({ reportProjectionVersion: '2',
        result: envelopeForAgenticTerminalV2(terminal, true) }, run.config);
      expect(projection.kind).toBe('available');
      if (projection.kind === 'available') expect(projection.authoritativeQa).toBeUndefined();
    } finally { await run.close(); }
  }
});

test('matching v7 automation stops stay non-QA and every protected context closes', async () => {
  const run = await setup();
  const sessions: { isClosed: boolean }[] = [];
  const originalOpen = run.factory.open.bind(run.factory);
  run.factory.open = async (...args) => {
    const session = await originalOpen(...args);
    sessions.push(session);
    return session;
  };
  try {
    run.store.afterCompilation = () => run.setPageMode('duplicate_add');
    const outcome = await runGoalDirectedProductionV1(run.factory, run.store, run.source,
      actionModel, verificationModel, { workflowVersion: 'goal-directed-v1' });
    expect(outcome).toMatchObject({ kind: 'stopped', stage: 'replay' });
    if (outcome.kind !== 'stopped') return;
    expect(outcome.replay).toHaveLength(2);
    const terminal = await finalizeAgenticOutcomeV2(run.store, parseTestSpec(run.source),
      outcome, 'goal-directed-v1');
    expect(terminal.terminal.stage).toBe('replay');
    expect(terminal.terminal.status).not.toMatch(/^QA_/);
    expect(sessions).toHaveLength(4);
    expect(new Set(sessions).size).toBe(4);
    expect(sessions.every((session) => session.isClosed)).toBe(true);
  } finally { await run.close(); }
});

test('unresolved verification stops before trace, compiler or replay', async () => {
  const run = await setup();
  try {
    const unresolved: AgenticVerificationModelV4 = { complete: async () => JSON.stringify({
      decisionVersion: '4', kind: 'conclude', conclusion: 'unresolved',
    }) };
    const outcome = await runGoalDirectedProductionV1(run.factory, run.store, run.source,
      actionModel, unresolved, { workflowVersion: 'goal-directed-v1' });
    expect(outcome).toMatchObject({ kind: 'stopped', stage: 'exploration' });
    if (outcome.kind !== 'stopped') return;
    expect(outcome).not.toHaveProperty('replay');
    await expect(run.store.readSuccessfulExplorationV3(run.source.testSpecId,
      outcome.attemptId)).rejects.toThrow();
    const terminal = await finalizeAgenticOutcomeV2(run.store, parseTestSpec(run.source),
      outcome, 'goal-directed-v1');
    expect(terminal.terminal.stage).toBe('exploration');
  } finally { await run.close(); }
});

test('verification provider failure remains an environment stop with no trace or QA', async () => {
  const run = await setup();
  try {
    const failure: AgenticVerificationModelV4 = { complete: async () => {
      throw new ModelCompletionFailure('PROVIDER_ERROR');
    } };
    const outcome = await runGoalDirectedProductionV1(run.factory, run.store, run.source,
      actionModel, failure, { workflowVersion: 'goal-directed-v1' });
    expect(outcome).toMatchObject({ kind: 'stopped', stage: 'exploration',
      reasonCode: 'PROVIDER_ERROR', outcome: { boundary: 'environment' } });
    if (outcome.kind !== 'stopped') return;
    const result = await finalizeAgenticOutcomeV2(run.store, parseTestSpec(run.source),
      outcome, 'goal-directed-v1');
    expect(result.terminal).toEqual({ stage: 'environment', status: 'ENVIRONMENT_FAILED',
      reason: 'PROVIDER_ERROR' });
    expect(result.successfulTraceId).toBeUndefined();
  } finally { await run.close(); }
});

test('temporal strategy is successful exploration but compilation unsupported without replay or QA', async () => {
  const run = await setup(false, true);
  try {
    const outcome = await runGoalDirectedProductionV1(run.factory, run.store, run.source,
      actionModel, verificationModel, { workflowVersion: 'goal-directed-v1' });
    expect(outcome, JSON.stringify({ outcome, seen })).toMatchObject({ kind: 'stopped',
      stage: 'compilation' });
    if (outcome.kind !== 'stopped') return;
    expect(outcome.outcome).toMatchObject({ boundary: 'compilation', status: 'unsupported' });
    expect(outcome).not.toHaveProperty('replay');
    const trace = (await run.store.readSuccessfulExplorationV3(run.source.testSpecId,
      outcome.attemptId)).trace;
    expect(trace.successfulPath.at(-1)).toMatchObject({ type: 'verification_goal',
      comparison: { kind: 'transition', operator: 'disappears' }, conclusion: 'satisfied' });
    const terminal = await finalizeAgenticOutcomeV2(run.store, parseTestSpec(run.source),
      outcome, 'goal-directed-v1');
    expect(terminal.terminal).toEqual({ stage: 'compilation', status: 'COMPILATION_UNSUPPORTED',
      reason: 'UNSUPPORTED_CAPABILITY' });
    const projection = await projectStoredAgenticReportV2({ reportProjectionVersion: '2',
      result: envelopeForAgenticTerminalV2(terminal, true) }, run.config);
    expect(projection.kind).toBe('available');
    if (projection.kind === 'available') expect(projection.authoritativeQa).toBeUndefined();
  } finally { await run.close(); }
});

test('workflow and artifact versions are explicit and never enter the v6 store', async () => {
  const run = await setup();
  try {
    await expect(runAgenticExplorationV1(run.factory, run.store, run.source,
      actionModel, { workflowVersion: 'agentic-exploration-v1' }))
      .rejects.toThrow('requires TestSpec v2 or v3');
    await expect(runAgenticProductionV1(run.factory, run.store, run.source,
      actionModel, { workflowVersion: 'agentic-exploration-v1' }))
      .rejects.toThrow('requires TestSpec v2 or v3');
    await expect(runGoalDirectedProductionV1(run.factory, run.store, run.source,
      actionModel, verificationModel, { workflowVersion: 'agentic-exploration-v1' as 'goal-directed-v1' }))
      .rejects.toThrow('Goal-directed workflow version required');
    const outcome = await runGoalDirectedProductionV1(run.factory, run.store, run.source,
      actionModel, verificationModel, { workflowVersion: 'goal-directed-v1' });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    await expect(run.store.readSuccessfulExploration(run.source.testSpecId,
      outcome.attemptId)).rejects.toThrow();
    await expect(run.store.readCompiledExplorationV6(run.source.testSpecId,
      outcome.attemptId, outcome.compilerAttemptId)).rejects.toThrow();
    await expect(finalizeAgenticOutcomeV2(run.store, parseTestSpec(run.source),
      outcome, 'agentic-exploration-v1')).rejects.toThrow();
  } finally { await run.close(); }
});

test('finalization rejects a tampered v3/v7 provenance link', async () => {
  const run = await setup();
  try {
    const outcome = await runGoalDirectedProductionV1(run.factory, run.store, run.source,
      actionModel, verificationModel, { workflowVersion: 'goal-directed-v1' });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    const changed = { ...outcome, resolved: { ...outcome.resolved,
      successfulTraceId: 'trace-forged' } };
    await expect(finalizeAgenticOutcomeV2(run.store, parseTestSpec(run.source),
      changed, 'goal-directed-v1')).rejects.toThrow();
  } finally { await run.close(); }
});

test('accepted v7 replays never invoke MCP after compilation', async () => {
  const run = await setup();
  const original = McpExplorationSession.open;
  let calls = 0;
  let compiled = false;
  const actionProbe: AgenticDecisionModelV3 = { complete: async (input) => {
    if (compiled) throw new Error('Action model called below accepted v7');
    return actionModel.complete(input);
  } };
  const verificationProbe: AgenticVerificationModelV4 = { complete: async (input) => {
    if (compiled) throw new Error('Verification model called below accepted v7');
    return verificationModel.complete(input);
  } };
  try {
    run.store.afterCompilation = () => {
      compiled = true;
      McpExplorationSession.open = (async () => {
        calls++; throw new Error('MCP called below accepted v7');
      }) as typeof McpExplorationSession.open;
    };
    const outcome = await runGoalDirectedProductionV1(run.factory, run.store, run.source,
      actionProbe, verificationProbe, { workflowVersion: 'goal-directed-v1' });
    expect(outcome.kind).toBe('executed');
    expect(compiled).toBe(true);
    expect(calls).toBe(0);
  } finally {
    McpExplorationSession.open = original;
    await run.close();
  }
});

test('trusted local selector interprets VerificationGoals and completes goal-directed v7', async () => {
  const run = await setup();
  try {
    const response = await runAgenticLocalWorkflow({ taskText: run.source.sourceInstruction,
      targetUrl: run.source.startState.url,
      executionProfileRef: run.source.executionProfileRef }, run.config,
    { provider: { apiKey: () => undefined } }, {
      workflowVersion: 'goal-directed-v1',
      interpretationModel: { complete: async () => JSON.stringify({
        kind: 'test_spec', steps: run.source.steps,
      }) }, decisionModel: actionModel, verificationModel,
    });
    expect(response.kind).toBe('success');
    if (response.kind !== 'success') return;
    expect(response.context.result).toMatchObject({ workflowVersion: 'goal-directed-v1',
      terminal: { stage: 'qa', status: 'QA_ASSERTION_PASSED' } });
    expect(response.context.report.kind).toBe('available');
  } finally { await run.close(); }
});
