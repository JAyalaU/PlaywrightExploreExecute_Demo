import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { parseTestSpec } from '../app/domain/index.js';
import { LocalArtifactStore } from '../app/evidence/index.js';
import { McpExplorationSession } from '../app/exploration/index.js';
import { runAgenticLocalWorkflow } from '../app/local/agentic-workflow.js';
import { finalizeAgenticOutcomeV2, runStructuredActionProductionV1,
  runGoalDirectedProductionV1, type AgenticDecisionModelV3,
  type AgenticVerificationModelV4 } from '../app/interpretation/index.js';
import { ProfileCatalog, ProtectedContextFactory } from '../app/profile/index.js';
import type { ExecutionRun } from '../app/runner/index.js';
import { envelopeForAgenticTerminalV2 } from '../app/subprocess/protocol-v2.js';
import { projectStoredAgenticReportV2 } from '../app/subprocess/report-projection-v2.js';

function action(id: string, clause: string, name: string, role: 'link' | 'button') {
  const nameStart = clause.indexOf(name);
  const roleStart = clause.indexOf(role, nameStart + name.length);
  return { id, type: 'click', sourceText: clause, target: { description: name },
    actionTargetIntent: { intentVersion: '1', sourceStepId: id, operation: 'click',
      role: { kind: 'explicit', value: role, sourceSpan: { start: roleStart, end: roleStart + role.length } },
      accessibleName: name, exact: true,
      nameSourceSpan: { start: nameStart, end: nameStart + name.length } } };
}
function goal(id: string, clause: string, name: string, expected: 'present' | 'absent') {
  return { id, type: 'verification_goal', sourceText: clause, instruction: clause,
    subject: { role: 'button', accessibleName: name }, intent: { kind: 'presence', expected } };
}
type HookStore = LocalArtifactStore & { afterRun?: (ordinal: number) => void;
  afterTrace?: () => void;
  afterCompilation?: () => void };
function withHooks(root: string): HookStore {
  const store = new LocalArtifactStore(root) as HookStore;
  let runs = 0;
  const traced = store.writeSuccessfulExplorationV4.bind(store);
  store.writeSuccessfulExplorationV4 = async (input) => {
    const value = await traced(input); store.afterTrace?.(); return value;
  };
  const compiled = store.writeCompiledExplorationV8.bind(store);
  store.writeCompiledExplorationV8 = async (input) => {
    const value = await compiled(input); store.afterCompilation?.(); return value;
  };
  const written = store.writeAgenticRunV8.bind(store);
  store.writeAgenticRunV8 = async (testSpecId: string, attemptId: string,
    compilerId: string, run: ExecutionRun) => {
    const value = await written(testSpecId, attemptId, compilerId, run);
    store.afterRun?.(++runs); return value;
  };
  return store;
}
async function setup(falseGoal = false) {
  let mode: 'normal' | 'preexisting_delete' | 'duplicate_add' = 'normal';
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(request.url === '/elements' ?
      `<button onclick="document.body.insertAdjacentHTML('beforeend', '<button>Delete</button>')">Add Element</button>` +
      (mode === 'preexisting_delete' ? '<button>Delete</button>' : '') +
      (mode === 'duplicate_add' ? '<button>Add Element</button>' : '') :
      '<a href="/elements">Add/Remove Elements</a>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  const url = `http://127.0.0.1:${address.port}/`;
  const finalClause = falseGoal ? 'Verify there are exactly two Delete button elements.' :
    'Confirm a button with the text "Delete" exists.';
  const steps = [
    { id: 'go', type: 'navigate', sourceText: `Go to ${url}.`, url },
    action('link', 'Click the Add/Remove Elements link.', 'Add/Remove Elements', 'link'),
    goal('add-goal', 'Confirm the Add Element button exists.', 'Add Element', 'present'),
    goal('absent-goal', 'Confirm a button with the text "Delete" does not exist.', 'Delete', 'absent'),
    action('add-action', 'Click the Add Element button.', 'Add Element', 'button'),
    falseGoal ? { id: 'present-goal', type: 'verification_goal', sourceText: finalClause,
      instruction: finalClause, subject: { role: 'button', accessibleName: 'Delete' },
      intent: { kind: 'cardinality', comparison: 'equal', count: 2 } } :
      goal('present-goal', finalClause, 'Delete', 'present'),
  ];
  const source = { schemaVersion: '5', testSpecId: `structured-wp4b-${randomUUID()}`,
    sourceInstruction: steps.map((step) => step.sourceText).join(' '),
    executionProfileRef: { id: 'structured-wp4b', version: '1' }, startState: { url }, steps };
  const config = { profiles: [{ id: 'structured-wp4b', version: '1', browser: 'chromium',
    viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: { default: 3000 } },
    networkPolicyRef: { id: 'structured-policy', version: '1' } }],
    networkPolicies: [{ id: 'structured-policy', version: '1', destinations: [{
      host: '127.0.0.1', ports: [address.port], addresses: ['127.0.0.1'] }] }],
    evidencePolicy: { finalScreenshot: false, failureScreenshot: false,
      failureTrace: false, failureVideo: false, sensitiveBinaryApproved: false },
    artifactRoot: await mkdtemp(path.join(tmpdir(), 'structured-wp4b-')), retentionDays: 7 };
  const factory = new ProtectedContextFactory(new ProfileCatalog(config.profiles as never,
    config.networkPolicies as never));
  const store = withHooks(config.artifactRoot);
  await store.createJob(source, factory.catalog.resolve(source.executionProfileRef));
  return { source, config, factory, store, setMode: (value: typeof mode) => { mode = value; },
    close: async () => { server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(config.artifactRoot, { recursive: true, force: true }); } };
}
const actionModel: AgenticDecisionModelV3 = { complete: async ({ context }) => {
  if (context.stage === 'evaluate') return JSON.stringify({ decisionVersion: '3', kind: 'evaluate', verdict: 'achieved' });
  const name = context.authoredStep.id === 'link' ? 'Add/Remove Elements' : 'Add Element';
  const role = context.authoredStep.id === 'link' ? 'link' : 'button';
  const line = context.snapshot.split('\n').find((item) => item.includes(`- ${role} "${name}"`));
  const ref = line && /\[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(line)?.[1];
  return JSON.stringify(ref ? { decisionVersion: '3', kind: 'act', ref, action: 'click',
    source: 'authored', expectedEffect: 'state_changed' } : { decisionVersion: '3', kind: 'inspect' });
} };
const verificationModel: AgenticVerificationModelV4 = { complete: async ({ context }) => {
  const name = context.goal.id === 'add-goal' ? 'Add Element' : 'Delete';
  if (!context.observations.length) return JSON.stringify({ decisionVersion: '4', kind: 'observe',
    request: { kind: 'semantic_query', query: { role: 'button', name, frame: { kind: 'main' } } } });
  const { operator, expected } = context.goal.id === 'absent-goal' ? { operator: 'equal', expected: 0 } :
    context.goal.intent?.kind === 'cardinality' ? { operator: 'equal', expected: 2 } :
      { operator: 'greater_than', expected: 0 };
  const observation = context.observations.at(-1)!;
  const count = observation.status === 'complete' && observation.result.kind === 'matches' ?
    observation.result.count : -1;
  const evaluated = operator === 'equal' ? count === expected : count > expected;
  return JSON.stringify({ decisionVersion: '4', kind: 'conclude',
    conclusion: evaluated ? 'satisfied' : 'unsatisfied', comparison: { kind: 'count',
      observationId: observation.observationId, operator, expected } });
} };

for (const falseGoal of [false, true]) test(`structured Add/Remove ${falseGoal ? 'false' : 'true'} uses two fresh v8 replays`, async () => {
  const run = await setup(falseGoal);
  const sessions: { isClosed: boolean; context: object }[] = [];
  const originalOpen = run.factory.open.bind(run.factory);
  run.factory.open = async (...args) => { const session = await originalOpen(...args);
    sessions.push(session); return session; };
  try {
    const outcome = await runStructuredActionProductionV1(run.factory, run.store, run.source,
      actionModel, verificationModel, { workflowVersion: 'structured-action-v1' });
    expect(outcome.kind, JSON.stringify(outcome)).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.resolved.schemaVersion).toBe('8');
    expect(outcome.replay[0].executionRunId).not.toBe(outcome.replay[1].executionRunId);
    expect(sessions).toHaveLength(4);
    expect(new Set(sessions).size).toBe(4);
    expect(new Set(sessions.map((session) => session.context)).size).toBe(4);
    expect(sessions.every((session) => session.isClosed)).toBe(true);
    const trace = (await run.store.readSuccessfulExplorationV4(run.source.testSpecId, outcome.attemptId)).trace;
    expect(trace.successfulPath.map((item) => item.originStepId)).toEqual(
      ['go', 'link', 'add-goal', 'absent-goal', 'add-action', 'present-goal']);
    expect(trace.actionIdentityProofs).toHaveLength(2);
    expect(trace.actionIdentityProofs.map((proof) => proof.selectedWitness.selectedAccessibleName))
      .toEqual(['Add/Remove Elements', 'Add Element']);
    const goals = trace.successfulPath.filter((item) => item.type === 'verification_goal');
    expect(goals[1]?.observations[0]).toMatchObject({ status: 'complete',
      result: { kind: 'matches', count: 0, complete: true } });
    expect(goals[2]?.observations[0]).toMatchObject({ status: 'complete',
      result: { kind: 'matches', count: 1, complete: true } });
    const result = await finalizeAgenticOutcomeV2(run.store, parseTestSpec(run.source), outcome,
      'structured-action-v1');
    expect(result.terminal.status).toBe(falseGoal ? 'QA_ASSERTION_FAILED' : 'QA_ASSERTION_PASSED');
    const projection = await projectStoredAgenticReportV2({ reportProjectionVersion: '2',
      result: envelopeForAgenticTerminalV2(result, true) }, run.config);
    expect(projection.kind).toBe('available');
    if (projection.kind === 'available') expect(projection.authoritativeQa).toBe(result.terminal.status);
  } finally { await run.close(); }
});

test('v5 cannot route into v4 goal-directed production or compiler fallback', async () => {
  const run = await setup();
  try {
    await expect(runGoalDirectedProductionV1(run.factory, run.store, run.source,
      actionModel, verificationModel, { workflowVersion: 'goal-directed-v1' }))
      .rejects.toThrow('requires TestSpec v4');
    await expect(runStructuredActionProductionV1(run.factory, run.store, run.source,
      actionModel, verificationModel,
      { workflowVersion: 'goal-directed-v1' as 'structured-action-v1' }))
      .rejects.toThrow('Structured workflow version required');
  } finally { await run.close(); }
});

test('replay disagreement and matching automation stop remain non-QA', async () => {
  for (const [mode, expected] of [['preexisting_delete', 'reproducibility'],
    ['duplicate_add', 'replay']] as const) {
    const run = await setup();
    try {
      run.store.afterRun = (ordinal) => { if (ordinal === 1) run.setMode(mode); };
      if (mode === 'duplicate_add') run.store.afterCompilation = () => run.setMode(mode);
      const outcome = await runStructuredActionProductionV1(run.factory, run.store, run.source,
        actionModel, verificationModel, { workflowVersion: 'structured-action-v1' });
      expect(outcome.kind).toBe('stopped');
      if (outcome.kind !== 'stopped') continue;
      const result = await finalizeAgenticOutcomeV2(run.store, parseTestSpec(run.source), outcome,
        'structured-action-v1');
      expect(result.terminal.stage).toBe(expected);
      expect(result.terminal.status).not.toMatch(/^QA_/);
    } finally { await run.close(); }
  }
});

test('structured local selector produces TestSpec v5 and no cross-version fallback', async () => {
  const run = await setup();
  try {
    const response = await runAgenticLocalWorkflow({ taskText: run.source.sourceInstruction,
      targetUrl: run.source.startState.url, executionProfileRef: run.source.executionProfileRef },
    run.config, { provider: { apiKey: () => undefined } }, {
      workflowVersion: 'structured-action-v1', interpretationModel: { complete: async () =>
        JSON.stringify({ kind: 'test_spec', steps: run.source.steps }) },
      decisionModel: actionModel, verificationModel,
    });
    expect(response.kind).toBe('success');
    if (response.kind === 'success') expect(response.context.result).toMatchObject({
      workflowVersion: 'structured-action-v1', terminal: { stage: 'qa', status: 'QA_ASSERTION_PASSED' },
    });
  } finally { await run.close(); }
});

function sixStepStructuredWire(url: string) {
  const clauses = [
    `Go to ${url}.`,
    'Locate the link that says Add/Remove Elements and click it.',
    'Locate the button with the text "Add Element". Confirm it exists.',
    'Confirm a button with the text "Delete" does not exist.',
    'Click the "Add Element" button.',
    'Confirm a button with the text "Delete" exists.',
  ];
  const goalWire = (id: string, sourceText: string, accessibleName: string,
    expected: 'present' | 'absent') => ({ id, type: 'verification_goal', sourceText,
    instruction: sourceText, subject: { role: 'button', accessibleName, scope: null },
    intent: { kind: 'presence', expected }, dependsOnStepId: null });
  const actionWire = (id: string, sourceText: string, accessibleName: string,
    role: 'link' | 'button') => ({ id, type: 'click', sourceText,
    target: { description: accessibleName, scope: null },
    actionTargetIntent: { intentVersion: '1', sourceStepId: id, operation: 'click',
      role: { kind: 'explicit', value: role, sourceText: role }, accessibleName,
      exact: true, nameSourceText: accessibleName, scope: null } });
  const wire = { response: { kind: 'test_spec', steps: [
    { id: 'go', type: 'navigate', sourceText: clauses[0], url },
    actionWire('link', clauses[1]!, 'Add/Remove Elements', 'link'),
    goalWire('add-goal', clauses[2]!, 'Add Element', 'present'),
    goalWire('absent-goal', clauses[3]!, 'Delete', 'absent'),
    actionWire('add-action', clauses[4]!, 'Add Element', 'button'),
    goalWire('present-goal', clauses[5]!, 'Delete', 'present'),
  ] } };
  return { clauses, wire, taskText: clauses.map((clause, index) =>
    `${index + 1}. ${clause}`).join('\n') };
}



test('exact authored public task reaches accepted v5 through default routing before browser startup', async () => {
  const run = await setup();
  const publicUrl = 'https://the-internet.herokuapp.com/';
  const { clauses, wire, taskText } = sixStepStructuredWire(publicUrl);
  const originalCreateJob = LocalArtifactStore.prototype.createJob;
  const accepted: ReturnType<typeof parseTestSpec>[] = [];
  const selectedFormats: string[] = [];
  LocalArtifactStore.prototype.createJob = async function (sourceInput) {
    accepted.push(parseTestSpec(sourceInput));
    throw new Error('STOP_AFTER_ACCEPTED_INTERPRETATION');
  };
  try {
    await expect(runAgenticLocalWorkflow({ taskText,
      // Admission stays on the loopback fixture; createJob is intercepted before any browser opens.
      targetUrl: run.source.startState.url,
      executionProfileRef: run.source.executionProfileRef }, run.config,
    { provider: { apiKey: () => 'non-secret-test-sentinel', fetchImpl: (async (_endpoint, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string;
        text: { format: { name: string } } };
      expect(body.input).toBe(taskText);
      selectedFormats.push(body.text.format.name);
      return new Response(JSON.stringify({ status: 'completed', error: null, incomplete_details: null,
        output: [{ type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text: JSON.stringify(wire) }] }] }), { status: 200 });
    }) as typeof fetch } },
    { workflowVersion: 'structured-action-v1', decisionModel: actionModel,
      verificationModel })).rejects.toThrow('STOP_AFTER_ACCEPTED_INTERPRETATION');
    expect(selectedFormats).toEqual(['qa_structured_action_interpretation_v3']);
    expect(accepted).toHaveLength(1);
    const source = accepted[0]!;
    expect(source.schemaVersion).toBe('5');
    expect(source.sourceInstruction).toBe(taskText);
    expect(source.steps.map((step) => step.sourceText)).toEqual(clauses);
    expect(source.steps.map((step) => step.type)).toEqual([
      'navigate', 'click', 'verification_goal', 'verification_goal', 'click', 'verification_goal']);
    expect(source.steps.filter((step) => step.type === 'click').map((step) =>
      step.actionTargetIntent?.accessibleName)).toEqual(['Add/Remove Elements', 'Add Element']);
    expect(source.steps[3]).toMatchObject({ type: 'verification_goal', intent: {
      kind: 'presence', expected: 'absent' } });
  } finally { LocalArtifactStore.prototype.createJob = originalCreateJob; await run.close(); }
});

test('default adapter selection is version-specific in source and built dist with no fallback', async () => {
  const run = await setup();
  try {
    for (const implementation of [runAgenticLocalWorkflow]) {
      for (const workflowVersion of ['structured-action-v1', 'goal-directed-v1',
        'agentic-exploration-v1'] as const) {
        const selectedFormats: string[] = [];
        const response = await implementation({ taskText: 'Click Save or Delete.',
          targetUrl: run.source.startState.url,
          executionProfileRef: run.source.executionProfileRef }, run.config,
        { provider: { apiKey: () => 'non-secret-test-sentinel', fetchImpl: (async (_endpoint, init) => {
          const body = JSON.parse(String(init?.body)) as { text: { format: { name: string } } };
          selectedFormats.push(body.text.format.name);
          return new Response(JSON.stringify({ status: 'completed', error: null, incomplete_details: null,
            output: [{ type: 'message', status: 'completed', role: 'assistant',
              content: [{ type: 'output_text', text: JSON.stringify({ response: {
                kind: 'ambiguous', reason: 'Target is ambiguous' } }) }] }] }), { status: 200 });
        }) as typeof fetch } },
        { workflowVersion, decisionModel: actionModel,
          ...(workflowVersion === 'agentic-exploration-v1' ? {} : { verificationModel }) });
        expect(selectedFormats).toEqual([workflowVersion === 'structured-action-v1'
          ? 'qa_structured_action_interpretation_v3' : 'qa_agentic_interpretation_v2']);
        expect(response).toMatchObject({ kind: 'typed_stop', context: { result: {
          workflowVersion, terminal: { stage: 'interpretation', status: 'AMBIGUOUS_INSTRUCTION' },
          cleanup: 'not_started' } } });
      }
    }
    // Production launches built code in its own process. Source and dist have separate
    // module identities and must not register Playwright singleton engines together.
    const script = `const {runAgenticLocalWorkflow}=await import('./dist/local/agentic-workflow.js');const observations=[];
      for(const workflowVersion of ['structured-action-v1','goal-directed-v1','agentic-exploration-v1']){
        const formats=[];const response=await runAgenticLocalWorkflow(${JSON.stringify({ taskText: 'Click Save or Delete.',
          targetUrl: run.source.startState.url, executionProfileRef: run.source.executionProfileRef })},${JSON.stringify(run.config)},
          {provider:{apiKey:()=> 'non-secret-test-sentinel',fetchImpl:async(_endpoint,init)=>{const body=JSON.parse(String(init.body));formats.push(body.text.format.name);
            return new Response(JSON.stringify({status:'completed',error:null,incomplete_details:null,output:[{type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:JSON.stringify({response:{kind:'ambiguous',reason:'Target is ambiguous'}})}]}]}),{status:200});}}},{workflowVersion});
        observations.push({formats,kind:response.kind,workflowVersion:response.context.result.workflowVersion,terminal:response.context.result.terminal,cleanup:response.context.result.cleanup});
      }console.log(JSON.stringify(observations));`;
    const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 });
    expect(JSON.parse(child.stdout.trim())).toEqual(['structured-action-v1', 'goal-directed-v1', 'agentic-exploration-v1'].map(workflowVersion => ({
      formats: [workflowVersion === 'structured-action-v1' ? 'qa_structured_action_interpretation_v3' : 'qa_agentic_interpretation_v2'],
      kind: 'typed_stop', workflowVersion, terminal: { stage: 'interpretation', status: 'AMBIGUOUS_INSTRUCTION', reason: 'MATERIAL_AMBIGUITY' }, cleanup: 'not_started',
    })));
  } finally { await run.close(); }
});

test('structured replay never invokes MCP or models after accepted compilation', async () => {
  const run = await setup();
  const original = McpExplorationSession.open;
  let compiled = false, calls = 0;
  try {
    run.store.afterCompilation = () => { compiled = true; McpExplorationSession.open =
      (async () => { calls++; throw new Error('MCP below v8'); }) as typeof McpExplorationSession.open; };
    const actionProbe: AgenticDecisionModelV3 = { complete: async (input) => {
      if (compiled) throw new Error('Action model below v8'); return actionModel.complete(input);
    } };
    const verificationProbe: AgenticVerificationModelV4 = { complete: async (input) => {
      if (compiled) throw new Error('Verification model below v8'); return verificationModel.complete(input);
    } };
    const outcome = await runStructuredActionProductionV1(run.factory, run.store, run.source,
      actionProbe, verificationProbe, { workflowVersion: 'structured-action-v1' });
    expect(outcome.kind).toBe('executed');
    expect(calls).toBe(0);
  } finally { McpExplorationSession.open = original; await run.close(); }
});

test('exploration failure stops before trace, compiler, and replay', async () => {
  const run = await setup();
  try {
    const unresolved: AgenticVerificationModelV4 = { complete: async () =>
      JSON.stringify({ decisionVersion: '4', kind: 'conclude', conclusion: 'unresolved' }) };
    const outcome = await runStructuredActionProductionV1(run.factory, run.store, run.source,
      actionModel, unresolved, { workflowVersion: 'structured-action-v1' });
    expect(outcome).toMatchObject({ kind: 'stopped', stage: 'exploration' });
    if (outcome.kind !== 'stopped') return;
    expect(outcome).not.toHaveProperty('compilerAttemptId');
    await expect(run.store.readSuccessfulExplorationV4(run.source.testSpecId,
      outcome.attemptId)).rejects.toThrow();
    const result = await finalizeAgenticOutcomeV2(run.store, parseTestSpec(run.source), outcome,
      'structured-action-v1');
    expect(result.terminal.stage).toBe('exploration');
  } finally { await run.close(); }
});

test('structured compilation failure has no v8 or historical compiler fallback', async () => {
  const run = await setup();
  try {
    run.store.afterTrace = () => run.setMode('duplicate_add');
    const outcome = await runStructuredActionProductionV1(run.factory, run.store, run.source,
      actionModel, verificationModel, { workflowVersion: 'structured-action-v1' });
    expect(outcome).toMatchObject({ kind: 'stopped', stage: 'compilation' });
    if (outcome.kind !== 'stopped') return;
    expect(outcome.resolvedSpecId).toBeUndefined();
    expect(outcome.replay).toBeUndefined();
    await expect(run.store.readCompiledExplorationV7(run.source.testSpecId,
      outcome.attemptId, outcome.compilerAttemptId!)).rejects.toThrow();
    const result = await finalizeAgenticOutcomeV2(run.store, parseTestSpec(run.source), outcome,
      'structured-action-v1');
    expect(result.terminal.stage).toBe('compilation');
    const projection = await projectStoredAgenticReportV2({ reportProjectionVersion: '2',
      result: envelopeForAgenticTerminalV2(result, true) }, run.config);
    expect(projection.kind).toBe('available');
    if (projection.kind === 'available') expect(projection.authoritativeQa).toBeUndefined();
  } finally { await run.close(); }
});

test('v8 finalization rejects tampered source or resolved provenance', async () => {
  const run = await setup();
  try {
    const outcome = await runStructuredActionProductionV1(run.factory, run.store, run.source,
      actionModel, verificationModel, { workflowVersion: 'structured-action-v1' });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    const altered = { ...outcome, resolved: { ...outcome.resolved,
      successfulTraceId: 'trace-forged' } };
    await expect(finalizeAgenticOutcomeV2(run.store, parseTestSpec(run.source), altered,
      'structured-action-v1')).rejects.toThrow();
    await expect(finalizeAgenticOutcomeV2(run.store, parseTestSpec(run.source), outcome,
      'goal-directed-v1')).rejects.toThrow();
  } finally { await run.close(); }
});
