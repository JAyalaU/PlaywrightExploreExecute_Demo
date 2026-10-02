import { expect, test } from '@playwright/test';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { ProtectedContextFactory } from '../app/profile/index.js';
import { McpExplorationSession, McpToolError } from '../app/exploration/mcp.js';
import { ActionCandidateGroundingSessionV1 } from '../app/exploration/action-candidate-grounding.js';
import { SuccessfulTraceAssemblerV5 } from '../app/exploration/trace-assembly-v5.js';
import { runAgenticLocalWorkflow } from '../app/local/agentic-workflow.js';
import { runAgenticSubprocessAdapterV2 } from '../app/subprocess/agentic-entry.js';
import { parseSubprocessResponseV2, serializeSubprocessResponseV2 } from '../app/subprocess/protocol-v2.js';
import { projectStoredWorkflowReportV2 } from '../app/subprocess/workflow-report-projection-v2.js';
import { projectStoredAgenticReportV2 } from '../app/subprocess/report-projection-v2.js';
import { DeferredWorkflowStopStoreV1 } from '../app/evidence/deferred-workflow-store.js';
import { DeferredInterpretationAttemptStoreV1 } from '../app/evidence/deferred-interpretation-attempt-store.js';
import { SuccessfulTraceV5Store } from '../app/evidence/trace-store-v5.js';
import { DeferredCompilerV4Store } from '../app/evidence/deferred-compiler-store-v4.js';
import { DeferredReplayV9Store } from '../app/evidence/deferred-replay-store-v9.js';
import { TrustedDeferredWorkflowStopV1 } from '../app/interpretation/deferred-action-production.js';
import { parseResultRecordV2 } from '../app/domain/agentic-result-v2.js';
import { ACTION_GROUNDING_RESPONSE_FORMAT, ACTION_GROUNDING_INDEPENDENT_RESPONSE_FORMAT } from '../app/interpretation/action-grounding-wire.js';
import { Readable } from 'node:stream';
import { choose } from './helpers/action-v2-fixtures.js';
import { fill, check, select, correspondence } from './helpers/deferred-v9-fixtures.js';
import type { ActionGoalV2, TestSpecV6V2 } from '../app/domain/index.js';

function pocStep(step: TestSpecV6V2['steps'][number]): unknown {
  if (step.type === 'navigate') return { id: step.id, type: step.type, url: step.url };
  if (step.type === 'verification_goal') return 'verificationVersion' in step ?
    { id: step.id, type: step.type, verificationVersion: '2', optionLabel: step.claim.optionLabel,
      expectedSelected: step.claim.expectedSelected,
      controlConstraints: step.claim.controlConstraints.map(({ kind, text }) => ({ kind, text })),
      dependsOnStepId: step.dependsOnStepId ?? null } :
    { id: step.id, type: step.type, verificationVersion: null, instruction: step.instruction,
      subject: step.subject ?? null, intent: step.intent ?? null, dependsOnStepId: step.dependsOnStepId ?? null };
  const effect = step.obligations.find((o) => o.kind === 'effect');
  const operation = step.obligations.find((o) => o.kind === 'operation');
  const argument = step.obligations.find((o) => o.kind === 'argument');
  return { id: step.id, type: step.type, effect: effect?.kind === 'effect' ? effect.effect : 'activate',
    explicitOperation: operation?.kind === 'operation' ? operation.operation : null,
    argument: argument?.kind === 'argument' ? { purpose: argument.purpose, value: argument.authoredText } : null,
    targetConstraints: step.obligations.flatMap((o) => o.kind === 'constraint' && o.subject.kind === 'target' ?
      [{ kind: o.constraint, value: o.constraint === 'context' ? 'Country' : o.authoredText,
        polarity: o.polarity }] : []), dependsOnStepId: null };
}

test.describe.configure({ mode: 'serial' });
const gate = 'PLAYWRIGHT_DEMO_DEFERRED_ACTION_GATE';
const notice = '<div role="dialog" aria-label="Notice">PRIVATE_BROWSER_TEXT</div>';
const verified = (): TestSpecV6V2['steps'][number] => {
  const text = 'Verify exactly one Notice dialog exists.';
  return { id: 'verify', type: 'verification_goal', instruction: text, sourceText: text, sourceInstructionSpan: { start: 0, end: text.length },
    subject: { role: 'dialog', accessibleName: 'Notice' }, intent: { kind: 'cardinality', comparison: 'equal', count: 1 } };
};
async function fixture(html: string, authored: TestSpecV6V2['steps'] | ((url: string) => TestSpecV6V2['steps']) = [choose()]) {
  let currentHtml = html;
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(currentHtml); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Port missing');
  const url = `http://127.0.0.1:${address.port}/`, root = await mkdtemp(path.join(tmpdir(), 'deferred-production-'));
  let offset = 0;
  const steps = structuredClone(typeof authored === 'function' ? authored(url) : authored).map((goal, i) => { if (i) offset++; goal.sourceInstructionSpan = { start: offset, end: offset + goal.sourceText.length }; offset += goal.sourceText.length; return goal; });
  const instructionAccounting = steps.flatMap((goal, i) => [
    ...(i ? [{ classification: 'neutral' as const, sourceSpan: { start: goal.sourceInstructionSpan.start - 1, end: goal.sourceInstructionSpan.start }, authoredText: ' ' }] : []),
    { classification: 'clause' as const, stepId: goal.id, sourceSpan: goal.sourceInstructionSpan, authoredText: goal.sourceText },
  ]);
  const config = { profiles: [{ id: 'desktop', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 3000, navigationMs: 5000, waits: { default: 3000 } }, networkPolicyRef: { id: 'local', version: '1' } }],
    networkPolicies: [{ id: 'local', version: '1', destinations: [{ host: '127.0.0.1', ports: [address.port], addresses: ['127.0.0.1'] }] }],
    evidencePolicy: { finalScreenshot: false, failureScreenshot: false, failureTrace: false, failureVideo: false, sensitiveBinaryApproved: false }, artifactRoot: root, retentionDays: 7 };
  const request = { taskText: steps.map(g => g.sourceText).join(' '), targetUrl: url, executionProfileRef: { id: 'desktop', version: '1' } };
  const calls: { format: string; input: unknown }[] = [];
  let overrideExtraction: ((response: unknown) => unknown) | undefined;
  let malformedPrimaryOnce = false;
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init!.body)), format = body.text.format.name as string;
    calls.push({ format, input: format === 'qa_deferred_semantic_poc_primary_v1' ? body.input : JSON.parse(body.input) });
    let response: unknown;
    if (format === 'qa_deferred_semantic_poc_primary_v1' || format === 'qa_deferred_semantic_poc_fidelity_v1') {
      response = format === 'qa_deferred_semantic_poc_primary_v1' ?
        { kind: 'extraction', steps: steps.map(pocStep) } : { verdict: 'faithful', issues: [] };
      if (overrideExtraction && format === 'qa_deferred_semantic_poc_primary_v1') response = overrideExtraction(response);
    } else if (format === 'qa_action_grounding_v5' || format === 'qa_action_grounding_source_first_v1') {
      const context = JSON.parse(body.input), goal = context.goal as ActionGoalV2;
      if (format === 'qa_action_grounding_source_first_v1') { expect(context).not.toHaveProperty('priorCandidate'); expect(context).not.toHaveProperty('lastReason'); expect(context).not.toHaveProperty('decision'); }
      const effect = goal.obligations.find(o => o.kind === 'effect');
      response = format === 'qa_action_grounding_v5' ? { decisionVersion: '5', kind: 'ground', goalId: goal.id,
        operation: effect?.kind === 'effect' && effect.effect === 'choose' ? 'select_option' : effect?.kind === 'effect' && effect.effect === 'enter_text' ? 'fill' : 'click', correspondence: correspondence(goal) } :
        { mappingExtractionVersion: '1', goalId: goal.id, correspondence: correspondence(goal) };
    } else if (format === 'agentic_verification_decision_v4') {
      const context = JSON.parse(body.input), observation = context.observations.find((o: { request: { kind: string } }) => o.request.kind === 'semantic_query');
      response = observation ? { decisionVersion: '4', kind: 'conclude', conclusion: observation.result.count === 1 ? 'satisfied' : 'unsatisfied',
        comparison: { kind: 'count', operator: 'equal', observationId: observation.observationId, expected: 1 } } :
        { decisionVersion: '4', kind: 'observe', request: { kind: 'semantic_query', query: { role: 'dialog', name: 'Notice', within: null, frame: { kind: 'main' } } } };
    } else throw new Error('Unexpected legacy provider format');
    const modelText = malformedPrimaryOnce && format === 'qa_deferred_semantic_poc_primary_v1' &&
      calls.filter(call => call.format === format).length === 1 ? '{' : JSON.stringify({ response });
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: modelText }] }] }), { status: 200 });
  };
  const oldGate = process.env[gate]; process.env[gate] = 'offline-review';
  return { root, url, config, request, calls, setHtml(value: string) { currentHtml = value; },
    malformedFirstPrimary() { malformedPrimaryOnce = true; },
    extractionOverride(value: (response: unknown) => unknown) { overrideExtraction = value; },
    run: (signal?: AbortSignal) => runAgenticSubprocessAdapterV2(Readable.from([JSON.stringify({ protocolVersion: '2', request })]),
      async () => config, { provider: { apiKey: () => 'MOCK_ONLY', fetchImpl } }, { workflowVersion: 'deferred-action-v1', ...(signal ? { signal } : {}) }),
    close: async () => { if (oldGate === undefined) delete process.env[gate]; else process.env[gate] = oldGate;
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function throughPython(f: Fixture, response: Awaited<ReturnType<Fixture['run']>>, projection: unknown) {
  const file = path.join(f.root, 'external.json'); await writeFile(file, JSON.stringify({ response, projection }));
  const code = `import sys,json;sys.path.insert(0,'src');from playwright_demo.protocol_v2 import parse_response;from playwright_demo.report_projection_v2 import parse_report_projection;v=json.load(open(sys.argv[1]));r,_=parse_response(json.dumps(v['response']).encode(),v['response']['context']['result']['executionProfileRef']);p=parse_report_projection(json.dumps(v['projection']).encode(),r);print(p['kind'])`;
  const output = await promisify(execFile)(path.resolve('.venv/Scripts/python.exe'), ['-c', code, file], { cwd: process.cwd(), encoding: 'utf8' });
  expect(output.stdout.trim()).toBe((projection as { kind: string }).kind);
}
for (const kind of ['choice', 'country', 'fill', 'checkbox', 'radio'] as const) test(`complete production ${kind} with mocked provider and fresh protected replays`, async () => {
  const goal = kind === 'choice' ? choose() : kind === 'country' ? choose('from') : kind === 'fill' ? fill() : check(kind);
  const html = kind === 'choice' ? select : kind === 'country' ? '<label for="country">Country</label>' + select.replace('<select>', '<select id="country">') + select : kind === 'fill' ? '<input>' : `<input type="${kind}">`;
  const f = await fixture(html, [goal]); try {
    const response = await f.run(); expect(response.kind, JSON.stringify(response)).toBe('typed_stop'); if (response.kind === 'bridge_error') throw new Error('Bridge');
    expect(response.context.result.terminal.status).toBe('EXECUTION_REPRODUCED'); expect(response.context.result.deferredReplay?.runnerVersion).toBe('9');
    expect(response.context.result.executionRunIds).toHaveLength(2); expect(response.context.result.deferredReplay?.executionSessionIds).toHaveLength(2);
    expect(f.calls.slice(0, 2).map(c => c.format)).toEqual(['qa_deferred_semantic_poc_primary_v1', 'qa_deferred_semantic_poc_fidelity_v1']);
    expect(f.calls[0]!.input).toBe(f.request.taskText);
    expect(f.calls[1]!.input).toMatchObject({ originalInstruction: f.request.taskText, testSpec: { steps: expect.any(Array) } });
    const projection = await projectStoredWorkflowReportV2({ reportProjectionVersion: '2', result: response }, f.config);
    expect(projection.kind).toBe('available'); expect(projection).not.toHaveProperty('authoritativeQa');
    if (kind === 'choice') {
      const result = response.context.result, store = new DeferredWorkflowStopStoreV1(f.root);
      const diagnostics = await store.readStartupDiagnostics(result.testSpecId, result.explorationAttemptId!, result.profileFingerprint);
      expect(diagnostics.map(item => [item.stage, item.status])).toEqual([
        ['session_open', 'completed'], ['root_navigation', 'completed'], ['initial_observation', 'completed'],
        ['initial_protected_state', 'completed'], ['first_grounding_decision', 'completed'],
      ]);
      expect(JSON.stringify(response)).not.toContain('startupDiagnostics');
      expect(JSON.stringify(projection)).not.toContain('startupDiagnostics');
      const file = path.join(f.root, 'deferred-startup-diagnostics-v1', result.testSpecId, 'startup.json');
      const altered = JSON.parse(await readFile(file, 'utf8'));
      altered.diagnostics[0].status = 'failed';
      await writeFile(file, JSON.stringify(altered));
      await expect(store.readStartupDiagnostics(result.testSpecId, result.explorationAttemptId!, result.profileFingerprint)).rejects.toThrow();
    }
    for (const secret of ['Option 1', 'runtime-1', 'exact text', 'PRIVATE_BROWSER_TEXT', 'sourceInstruction', 'predicate', 'actual', 'expected']) expect(JSON.stringify(projection)).not.toContain(secret);
    await throughPython(f, response, projection);
  } finally { await f.close(); }
});
for (const expectedMatches of [true, false]) test(`PoC resulting URL ${expectedMatches ? 'passes' : 'fails'} after two deterministic replays`, async () => {
  const f = await fixture('<input type="checkbox">', (url) => {
    const action = check('checkbox');
    const expected = expectedMatches ? url : `${url}wrong`;
    const clause = `Confirm it takes you to ${expected}`;
    return [action, { id: 'verify-url', type: 'verification_goal', sourceText: clause,
      instruction: clause, sourceInstructionSpan: { start: 0, end: clause.length },
      dependsOnStepId: action.id }];
  });
  try {
    const response = await f.run();
    if (response.kind === 'bridge_error') throw new Error('Bridge');
    expect(response.context.result.terminal.status).toBe(expectedMatches ? 'QA_ASSERTION_PASSED' : 'QA_ASSERTION_FAILED');
    expect(response.context.result.executionRunIds).toHaveLength(2);
    expect(response.context.result.deferredReplay?.runnerVersion).toBe('9');
    expect(f.calls.some((call) => call.format === 'agentic_verification_decision_v4')).toBe(false);
  } finally { await f.close(); }
});
test('grounding stop persists bounded authenticated private obligation diagnostic', async () => {
  const action = check('checkbox'); action.sourceText = 'Click the checkbox near Notice.';
  const f = await fixture('<input type="checkbox"><span>Notice</span>', [action]);
  f.extractionOverride((response) => {
    const draft = response as { kind: string; steps: { targetConstraints?: { kind: string; value: string; polarity: string }[] }[] };
    draft.steps[0]!.targetConstraints!.push({ kind: 'context', value: 'near Notice', polarity: 'positive' });
    return draft;
  });
  try {
    const response = await f.run();
    if (response.kind === 'bridge_error') throw new Error('Bridge');
    expect(response.context.result.deferredStage?.code).toBe('PENDING_OBLIGATIONS');
    expect(response.context.result.terminal.stage).toBe('exploration');
    const store = new DeferredWorkflowStopStoreV1(f.root);
    const accounting = await store.readPrivateAccounting(response.context.result.testSpecId);
    expect(accounting.groundingStop).toMatchObject({ diagnosticVersion: '1', stepId: 's1', operation: 'click',
      pending: [{ kind: 'constraint' }] });
    expect(accounting.groundingAttempts).toEqual([]);
    expect(JSON.stringify(response)).not.toContain('groundingStop');
    const projection = await projectStoredWorkflowReportV2({ reportProjectionVersion: '2', result: response }, f.config);
    expect(JSON.stringify(projection)).not.toContain('groundingStop');
    const file = path.join(f.root, 'deferred-workflow-stop-v1', response.context.result.testSpecId, 'terminal.json');
    const tampered = JSON.parse(await readFile(file, 'utf8'));
    tampered.accounting.groundingStop.pending[0].kind = 'effect';
    await writeFile(file, JSON.stringify(tampered));
    await expect(store.readPrivateAccounting(response.context.result.testSpecId)).rejects.toThrow();
  } finally { await f.close(); }
});
test('private startup diagnostic write failure does not change completed workflow outcome', async () => {
  const f = await fixture(select, [choose()]), original = DeferredWorkflowStopStoreV1.prototype.writeStartupDiagnostics;
  DeferredWorkflowStopStoreV1.prototype.writeStartupDiagnostics = async () => { throw new Error('PRIVATE_DIAGNOSTIC_IO'); };
  try {
    const response = await f.run(); if (response.kind === 'bridge_error') throw new Error('Bridge');
    expect(response.context.result.terminal.status).toBe('EXECUTION_REPRODUCED');
    expect(response.context.result.cleanup).toBe('verified');
    expect(JSON.stringify(response)).not.toContain('PRIVATE_DIAGNOSTIC_IO');
  } finally { DeferredWorkflowStopStoreV1.prototype.writeStartupDiagnostics = original; await f.close(); }
});
test('successful malformed-primary retry persists authenticated private attempts across restart', async () => {
  const f = await fixture(select, [choose()]); f.malformedFirstPrimary();
  try {
    const response = await f.run();
    if (response.kind === 'bridge_error') throw new Error('Bridge');
    expect(response.context.result.terminal.status).toBe('EXECUTION_REPRODUCED');
    expect(f.calls.slice(0, 3).map(call => call.format)).toEqual([
      'qa_deferred_semantic_poc_primary_v1', 'qa_deferred_semantic_poc_primary_v1',
      'qa_deferred_semantic_poc_fidelity_v1']);
    expect(f.calls[1]!.input).toBe(f.calls[0]!.input);
    const file = path.join(f.root, 'deferred-interpretation-attempt-v1',
      response.context.result.testSpecId, 'attempts.json');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    const store = new DeferredInterpretationAttemptStoreV1(f.root);
    const timing = await store.readPrivateAttempts(stored.testSpecId, stored.sourceDigest,
      stored.admissionDigest, stored.profileFingerprint);
    expect(timing.attempts?.map((item) => item.outcome)).toEqual([
      'invalid_wire', 'valid_extraction', 'valid_extraction']);
    const script = `import {registerHooks} from 'node:module';registerHooks({resolve(s,c,n){if(s.includes('@playwright/mcp')||s.includes('@modelcontextprotocol/'))throw Error('blocked');const r=n(s,c);if(r.url.includes('/exploration/'))throw Error('blocked exploration');return r;}});const {DeferredInterpretationAttemptStoreV1}=await import('./dist/evidence/deferred-interpretation-attempt-store.js');const t=await new DeferredInterpretationAttemptStoreV1(process.argv[1]).readPrivateAttempts(process.argv[2],process.argv[3],process.argv[4],process.argv[5]);console.log(JSON.stringify(t.attempts.map(x=>x.outcome)));`;
    const reopened = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, f.root,
      stored.testSpecId, stored.sourceDigest, stored.admissionDigest, stored.profileFingerprint],
    { cwd: process.cwd(), encoding: 'utf8' });
    expect(JSON.parse(reopened.stdout.trim())).toEqual(['invalid_wire', 'valid_extraction', 'valid_extraction']);
    const projection = await projectStoredWorkflowReportV2({ reportProjectionVersion: '2', result: response }, f.config);
    expect(JSON.stringify(projection)).not.toContain('invalid_wire');
    stored.timing.attempts[0].outcome = 'valid_extraction';
    await writeFile(file, JSON.stringify(stored));
    await expect(store.readPrivateAttempts(stored.testSpecId, stored.sourceDigest,
      stored.admissionDigest, stored.profileFingerprint)).rejects.toThrow();
  } finally { await f.close(); }
});
for (const mode of ['true', 'false', 'disagree', 'compiler', 'runner', 'cleanup'] as const) test(`integrated ${mode} terminal retains stage authority`, async () => {
  const f = await fixture(select + (mode === 'false' ? '' : notice), [choose(), verified()]);
  const original = ProtectedContextFactory.prototype.open; let opened = 0;
  ProtectedContextFactory.prototype.open = async function (...args) {
    const ordinal = ++opened;
    if (mode === 'compiler' && ordinal === 2 || mode === 'runner' && ordinal === 3) f.setHtml(select + select + notice);
    if (mode === 'disagree' && ordinal === 4) f.setHtml(select);
    const session = await original.apply(this, args);
    if (mode === 'cleanup' && ordinal === 3) session.closeWithFinalCheck = async () => { await session.close(); throw new Error('PRIVATE_CLEANUP'); };
    return session;
  };
  try {
    const response = await f.run(); if (response.kind === 'bridge_error') throw new Error('Bridge');
    const expected = mode === 'true' ? 'QA_ASSERTION_PASSED' : mode === 'false' ? 'QA_ASSERTION_FAILED' : mode === 'disagree' ? 'REPRODUCIBILITY_FAILED' : mode === 'compiler' ? 'COMPILATION_FAILED' : mode === 'cleanup' ? 'ENVIRONMENT_FAILED' : 'REPLAY_EXECUTION_FAILED';
    expect(response.context.result.terminal.status, JSON.stringify(response)).toBe(expected);
    expect(opened).toBe(mode === 'compiler' ? 2 : mode === 'runner' || mode === 'cleanup' ? 3 : 4);
    expect(response.kind).toBe(mode === 'true' ? 'success' : 'typed_stop');
    expect(response.context.result.cleanup).toBe(mode === 'cleanup' ? 'unverified' : 'verified');
    const projection = await projectStoredWorkflowReportV2({ reportProjectionVersion: '2', result: response }, f.config);
    expect(projection.kind).toBe(mode === 'compiler' ? 'unavailable' : 'available'); await throughPython(f, response, projection);
    if (mode === 'compiler') { expect(response.context.result.deferredStage?.code).toBe('NON_UNIQUE_MATCH'); expect(await new DeferredWorkflowStopStoreV1(f.root).readStop(response.context.result.testSpecId)).toEqual(response.context.result); }
  } finally { ProtectedContextFactory.prototype.open = original; await f.close(); }
});
test('two eligible dropdowns stop NON_UNIQUE before mutation or compile', async () => {
  const f = await fixture(select + select), original = ProtectedContextFactory.prototype.open; let opened = 0;
  ProtectedContextFactory.prototype.open = async function (...args) { opened++; return original.apply(this, args); };
  try {
    const response = await f.run(); expect(response.kind).toBe('typed_stop'); if (response.kind === 'bridge_error') throw new Error('Bridge');
    expect(response.context.result.deferredStage?.code).toBe('NON_UNIQUE'); expect(response.context.result.terminal.stage).toBe('exploration'); expect(opened).toBe(1);
    expect(response.context.result.executionRunIds).toEqual([]); expect(response.context.result).not.toHaveProperty('deferredReplay');
    expect(await new DeferredWorkflowStopStoreV1(f.root).readStop(response.context.result.testSpecId)).toEqual(response.context.result);
    const diagnostics = (await new DeferredWorkflowStopStoreV1(f.root).readPrivateAccounting(response.context.result.testSpecId)).startupDiagnostics;
    expect(diagnostics?.map(item => [item.stage, item.status])).toEqual([
      ['session_open', 'completed'], ['root_navigation', 'completed'], ['initial_observation', 'completed'],
      ['initial_protected_state', 'completed'], ['first_grounding_decision', 'stopped'],
    ]);
    expect((await new DeferredWorkflowStopStoreV1(f.root).readPrivateAccounting(response.context.result.testSpecId)).groundingStop)
      .toMatchObject({ diagnosticVersion: '1', stepId: 's1', operation: 'select_option', candidateCount: 2, pending: [] });
    await throughPython(f, response, { reportProjectionVersion: '2', kind: 'unavailable', reason: 'REPORT_UNAVAILABLE' });
  } finally { ProtectedContextFactory.prototype.open = original; await f.close(); }
});

test('private startup diagnostics identify session-open failure without public leakage', async () => {
  const f = await fixture(select), original = McpExplorationSession.open;
  McpExplorationSession.open = async () => { throw new Error('PRIVATE_OPEN_DETAIL'); };
  try {
    const response = await f.run(); if (response.kind === 'bridge_error') throw new Error('Bridge');
    expect(response.context.result.deferredStage?.code).toBe('ENVIRONMENT_STOP');
    expect(response.context.result.cleanup).toBe('not_started');
    const diagnostics = (await new DeferredWorkflowStopStoreV1(f.root).readPrivateAccounting(response.context.result.testSpecId)).startupDiagnostics;
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics?.[0]).toMatchObject({ stage: 'session_open', status: 'failed', exceptionName: 'Error' });
    expect(diagnostics?.[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(response)).not.toContain('startupDiagnostics');
    expect(JSON.stringify(response)).not.toContain('PRIVATE_OPEN_DETAIL');
  } finally { McpExplorationSession.open = original; await f.close(); }
});

test('private startup diagnostics identify root-navigation timeout with verified cleanup', async () => {
  const f = await fixture(select), original = McpExplorationSession.prototype.navigate;
  McpExplorationSession.prototype.navigate = async () => {
    throw new McpToolError('browser_navigate', 'TimeoutError: page.goto: Timeout 5000ms exceeded PRIVATE_URL');
  };
  try {
    const response = await f.run(); if (response.kind === 'bridge_error') throw new Error('Bridge');
    expect(response.context.result.deferredStage?.code).toBe('ENVIRONMENT_STOP');
    expect(response.context.result.cleanup).toBe('verified');
    const diagnostics = (await new DeferredWorkflowStopStoreV1(f.root).readPrivateAccounting(response.context.result.testSpecId)).startupDiagnostics;
    expect(diagnostics?.map(item => [item.stage, item.status])).toEqual([
      ['session_open', 'completed'], ['root_navigation', 'failed'],
    ]);
    expect(diagnostics?.[1]).toMatchObject({ exceptionName: 'McpToolError', code: 'NAVIGATION_TIMEOUT' });
    expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE_URL');
    expect(JSON.stringify(response)).not.toContain('startupDiagnostics');
    expect(JSON.stringify(response)).not.toContain('PRIVATE_URL');
  } finally { McpExplorationSession.prototype.navigate = original; await f.close(); }
});

test('private startup diagnostics distinguish first observation from protected state failure', async () => {
  const f = await fixture(select), originalState = ActionCandidateGroundingSessionV1.prototype.protectedTraceState;
  ActionCandidateGroundingSessionV1.prototype.protectedTraceState = async function (aroundObservation) {
    await aroundObservation?.(async () => { throw new Error('PRIVATE_OBSERVATION_DETAIL'); });
    return originalState.call(this);
  };
  try {
    const response = await f.run(); if (response.kind === 'bridge_error') throw new Error('Bridge');
    expect(response.context.result.cleanup).toBe('verified');
    const diagnostics = (await new DeferredWorkflowStopStoreV1(f.root).readPrivateAccounting(response.context.result.testSpecId)).startupDiagnostics;
    expect(diagnostics?.map(item => [item.stage, item.status])).toEqual([
      ['session_open', 'completed'], ['root_navigation', 'completed'], ['initial_observation', 'failed'],
      ['initial_protected_state', 'failed'],
    ]);
    expect(JSON.stringify(response)).not.toContain('PRIVATE_OBSERVATION_DETAIL');
  } finally { ActionCandidateGroundingSessionV1.prototype.protectedTraceState = originalState; await f.close(); }
});

test('private startup diagnostics retain completed observation before protected-state failure', async () => {
  const f = await fixture(select), original = SuccessfulTraceAssemblerV5.create;
  SuccessfulTraceAssemblerV5.create = async function (input) {
    await original.call(this, input);
    throw new Error('PRIVATE_STATE_DETAIL');
  };
  try {
    const response = await f.run(); if (response.kind === 'bridge_error') throw new Error('Bridge');
    const diagnostics = (await new DeferredWorkflowStopStoreV1(f.root).readPrivateAccounting(response.context.result.testSpecId)).startupDiagnostics;
    expect(diagnostics?.map(item => [item.stage, item.status])).toEqual([
      ['session_open', 'completed'], ['root_navigation', 'completed'], ['initial_observation', 'completed'],
      ['initial_protected_state', 'failed'],
    ]);
    expect(response.context.result.cleanup).toBe('verified');
    expect(JSON.stringify(response)).not.toContain('PRIVATE_STATE_DETAIL');
  } finally { SuccessfulTraceAssemblerV5.create = original; await f.close(); }
});
test('malformed extraction is durably rejected before browser creation and cannot forge stop authority', async () => {
  const f = await fixture(select); f.extractionOverride(() => ({ kind: 'extraction', steps: [] }));
  try {
    const response = await f.run(); if (response.kind === 'bridge_error') throw new Error('Bridge');
    expect(response.context.result.deferredStage?.category).toBe('structural'); expect(response.context.result.cleanup).toBe('not_started'); expect(response.context.result).not.toHaveProperty('explorationAttemptId');
    const store = new DeferredWorkflowStopStoreV1(f.root); expect(await store.readStop(response.context.result.testSpecId)).toEqual(response.context.result);
    const accounting = await store.readPrivateAccounting(response.context.result.testSpecId);
    expect(accounting.interpretationTiming).toMatchObject({ diagnosticVersion: '1', phase: 'primary',
      perCallLimitMs: 180_000, sharedLimitMs: 780_000, providerCompletedBeforeBoundary: true,
      phases: [{ phase: 'primary', providerCompletedBeforeBoundary: true }],
      attempts: [{ phase: 'primary', attempt: 1, outcome: 'invalid_structure' }] });
    expect(accounting.interpretationStructural).toMatchObject({ diagnosticVersion: '1', phase: 'primary',
      component: 'wire_normalization' });
    expect(JSON.stringify(response)).not.toContain('interpretationTiming');
    expect(JSON.stringify(response)).not.toContain('interpretationStructural');
    await expect(store.writeStop(Object.create(TrustedDeferredWorkflowStopV1.prototype))).rejects.toThrow('Untrusted');
    await throughPython(f, response, { reportProjectionVersion: '2', kind: 'unavailable', reason: 'REPORT_UNAVAILABLE' });
    const file = path.join(f.root, 'deferred-workflow-stop-v1', response.context.result.testSpecId, 'terminal.json'), data = JSON.parse(await readFile(file, 'utf8'));
    data.accounting.interpretationTiming.phaseElapsedMs += 1;
    await writeFile(file, JSON.stringify(data)); await expect(store.readPrivateAccounting(response.context.result.testSpecId)).rejects.toThrow();
    data.accounting.interpretationTiming.phaseElapsedMs -= 1;
    data.accounting.interpretationStructural.issueCode = 'OTHER_STRUCTURAL';
    await writeFile(file, JSON.stringify(data)); await expect(store.readPrivateAccounting(response.context.result.testSpecId)).rejects.toThrow();
  } finally { await f.close(); }
});
test('persisted projection restart authenticates with exploration and MCP imports blocked; historical projector stays isolated', async () => {
  const f = await fixture(select + notice, [choose(), verified()]); try {
    const response = await f.run(); expect(response.kind).toBe('success');
    const request = { reportProjectionVersion: '2', result: response }, configFile = path.join(f.root, 'config.json'), inputFile = path.join(f.root, 'request.json');
    await writeFile(configFile, JSON.stringify(f.config)); await writeFile(inputFile, JSON.stringify(request));
    const script = `import {registerHooks} from 'node:module';registerHooks({resolve(s,c,n){if(s.includes('@playwright/mcp')||s.includes('@modelcontextprotocol/'))throw Error('blocked');const r=n(s,c);if(r.url.includes('/exploration/'))throw Error('blocked exploration');return r;}});const {readFile}=await import('node:fs/promises');const {projectStoredWorkflowReportV2}=await import('./dist/subprocess/workflow-report-projection-v2.js');console.log(JSON.stringify(await projectStoredWorkflowReportV2(JSON.parse(await readFile(process.argv[1],'utf8')),JSON.parse(await readFile(process.argv[2],'utf8')))));`;
    const output = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, inputFile, configFile], { cwd: process.cwd(), encoding: 'utf8' });
    const projection = JSON.parse(output.stdout.trim()); expect(projection.authoritativeQa).toBe('QA_ASSERTION_PASSED'); await throughPython(f, response, projection);
    expect((await projectStoredAgenticReportV2(request, f.config)).kind).toBe('unavailable');
    if (response.kind !== 'bridge_error') { const altered = structuredClone(response); altered.context.result.profileFingerprint = 'a'.repeat(64);
      expect((await projectStoredWorkflowReportV2({ ...request, result: altered }, f.config)).kind).toBe('unavailable');
      expect(() => parseResultRecordV2({ ...response.context.result, workflowVersion: 'structured-action-v1' })).toThrow(); }
    const child = spawn(process.execPath, ['dist/subprocess/deferred-report-projection-cli.js', '--config', configFile], { cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let body = ''; child.stdout.on('data', chunk => { body += String(chunk); }); child.stdin.end(JSON.stringify(request)); await once(child, 'close');
    expect(JSON.parse(body).authoritativeQa).toBe('QA_ASSERTION_PASSED');
    const wire = serializeSubprocessResponseV2(response); expect(parseSubprocessResponseV2(wire.body)).toEqual(response);
  } finally { await f.close(); }
});
test('trusted selection is gated and request cannot choose or fall back to a workflow', async () => {
  const prior = process.env[gate]; delete process.env[gate];
  try {
    await expect(runAgenticLocalWorkflow({}, {}, {} as never, { workflowVersion: 'deferred-action-v1' })).rejects.toThrow('INVALID_TRUSTED_CONFIGURATION');
    const response = await runAgenticSubprocessAdapterV2(Readable.from([JSON.stringify({ protocolVersion: '2', request: { taskText: 'Select Option 1.', targetUrl: 'http://127.0.0.1/', executionProfileRef: { id: 'desktop', version: '1' }, workflowVersion: 'deferred-action-v1' } })]), async () => ({}), {} as never);
    expect(response).toEqual({ protocolVersion: '2', kind: 'bridge_error', code: 'PROTOCOL_INVALID', cleanup: 'not_started' });
  } finally { if (prior === undefined) delete process.env[gate]; else process.env[gate] = prior; }
});
for (const stage of ['trace', 'compiler', 'replay'] as const) test(`${stage} persistence failure never promotes private execution to QA`, async () => {
  const f = await fixture(select + notice, [choose(), verified()]);
  const originalTrace = SuccessfulTraceV5Store.prototype.writeSuccessfulExplorationV5;
  const originalCompiler = DeferredCompilerV4Store.prototype.writeCompilationV4;
  const originalReplay = DeferredReplayV9Store.prototype.writeReplayV1;
  const fail = async (): Promise<never> => { throw new Error('PRIVATE_IO_ERROR'); };
  if (stage === 'trace') SuccessfulTraceV5Store.prototype.writeSuccessfulExplorationV5 = fail;
  if (stage === 'compiler') DeferredCompilerV4Store.prototype.writeCompilationV4 = fail;
  if (stage === 'replay') DeferredReplayV9Store.prototype.writeReplayV1 = fail;
  try {
    const response = await f.run(); expect(response.kind).toBe('typed_stop'); if (response.kind === 'bridge_error') throw new Error('Bridge');
    const result = response.context.result; expect(result.terminal.stage).toBe('environment'); expect(result.deferredStage?.category).toBe('persistence'); expect(result.deferredStage?.code).toBe('PERSISTENCE_FAILED');
    expect(result).not.toHaveProperty('deferredReplay'); expect(result.executionRunIds).toEqual([]); expect(response.context.report.kind).toBe('unavailable');
    const accounting = await new DeferredWorkflowStopStoreV1(f.root).readPrivateAccounting(result.testSpecId);
    expect(accounting.groundingAttempts).toHaveLength(1); expect(accounting.successfulWitnesses).toHaveLength(1);
    expect(accounting.groundingAttempts[0]?.status).toBe('succeeded');
    if (stage !== 'trace') { expect(accounting.compilerAttempt?.freshActions).toHaveLength(1); expect(accounting.compilerAttempt?.freshActions[0]?.witness.execution.status).toBe('succeeded'); expect(accounting.compilerAttempt?.result.status).toBe('accepted'); }
    else expect(accounting.compilerAttempt).toBeUndefined();
    if (stage === 'replay') { expect(accounting.replay?.runs).toHaveLength(2); expect(accounting.replay?.runs.every(r => r.result.kind === 'completed')).toBe(true); }
    else expect(accounting.replay).toBeUndefined();
    await throughPython(f, response, { reportProjectionVersion: '2', kind: 'unavailable', reason: 'REPORT_UNAVAILABLE' });
  } finally { SuccessfulTraceV5Store.prototype.writeSuccessfulExplorationV5 = originalTrace; DeferredCompilerV4Store.prototype.writeCompilationV4 = originalCompiler; DeferredReplayV9Store.prototype.writeReplayV1 = originalReplay; await f.close(); }
});
test('first exploration cleanup failure remains unverified even if a later close succeeds', async () => {
  const f = await fixture(select), original = ProtectedContextFactory.prototype.open; let opened = 0;
  ProtectedContextFactory.prototype.open = async function (...args) {
    const session = await original.apply(this, args); if (++opened === 1) {
      const close = session.close.bind(session); let calls = 0;
      session.close = async () => { await close(); if (++calls === 1) throw new Error('PRIVATE_CLEANUP'); };
    } return session;
  };
  try {
    const response = await f.run(); if (response.kind === 'bridge_error') throw new Error('Bridge');
    expect(response.context.result.cleanup).toBe('unverified'); expect(response.context.result.terminal).toEqual({ stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'SESSION_CLEANUP_FAILED' }); expect(opened).toBe(1);
    const accounting = await new DeferredWorkflowStopStoreV1(f.root).readPrivateAccounting(response.context.result.testSpecId); expect(accounting.successfulWitnesses).toHaveLength(1);
  } finally { ProtectedContextFactory.prototype.open = original; await f.close(); }
});
test('cancellation after actual completed replay accounting never returns an authoritative QA envelope', async () => {
  const f = await fixture(select + notice, [choose(), verified()]), original = ProtectedContextFactory.prototype.open, controller = new AbortController(); let opened = 0;
  ProtectedContextFactory.prototype.open = async function (...args) {
    const session = await original.apply(this, args);
    if (++opened === 4) { const close = session.closeWithFinalCheck.bind(session);
      session.closeWithFinalCheck = async (...input) => { await close(...input); controller.abort(); };
    } return session;
  };
  try {
    const response = await f.run(controller.signal); expect(response).toEqual({ protocolVersion: '2', kind: 'bridge_error', code: 'CANCELLED', cleanup: 'verified' }); expect(opened).toBe(4);
    const namespace = path.join(f.root, 'deferred-replay-v9-result-v2'), jobs = await readdir(namespace), files = await readdir(path.join(namespace, jobs[0]!));
    const privatePair = JSON.parse(await readFile(path.join(namespace, jobs[0]!, files[0]!), 'utf8'));
    expect(privatePair.record.runs).toHaveLength(2); expect(privatePair.result.terminal.status).toBe('QA_ASSERTION_PASSED');
  } finally { ProtectedContextFactory.prototype.open = original; await f.close(); }
});
test('new grounding provider formats use closed strict reviewed schemas and cannot carry arbitrary executable fields', () => {
  const inspect = (schema: unknown) => {
    if (Array.isArray(schema)) { schema.forEach(inspect); return; }
    if (!schema || typeof schema !== 'object') return;
    const node = schema as Record<string, unknown>;
    expect(node).not.toHaveProperty('const'); expect(node).not.toHaveProperty('oneOf'); expect(node).not.toHaveProperty('$schema');
    if (node.type === 'object') { expect(node.additionalProperties).toBe(false); expect(node.required).toEqual(Object.keys(node.properties as object)); }
    Object.values(node).forEach(inspect);
  };
  for (const format of [ACTION_GROUNDING_RESPONSE_FORMAT, ACTION_GROUNDING_INDEPENDENT_RESPONSE_FORMAT]) { expect(format.strict).toBe(true); inspect(format.schema); }
});
