import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { LocalArtifactStore } from '../app/evidence/index.js';
import { compileSuccessfulTraceV1 } from '../app/exploration/index.js';
import { runAgenticExplorationV1, type AgenticDecisionModelV3 } from '../app/interpretation/index.js';
import { ProfileCatalog, ProtectedContextFactory } from '../app/profile/index.js';
import { parseResolvedTestSpec, parseResolvedTestSpecV6 } from '../app/domain/index.js';
import { executeResolvedTestSpecV6 } from '../app/runner/index.js';

async function fixture(duplicate = false, delayedNumeric = false) {
  let changedTarget: 'none' | 'role' | 'destination' = 'none';
  let removeNumeric = false;
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    const route = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
    const pages: Record<string, string> = {
      '/': changedTarget === 'role' ?
        '<button onclick="location.href=\'/status_codes\'">Status Codes</button>' :
        changedTarget === 'destination' ? '<a href="/wrong">Status Codes</a>' :
          '<a href="/status_codes">Status Codes</a>',
      '/status_codes': removeNumeric ? '<p>Loading</p>' : delayedNumeric ?
        '<p>Loading</p><script>setTimeout(() => { const link = document.createElement("a"); link.href = "/status_codes/200"; link.textContent = "200"; document.body.append(link); }, 900)</script>' :
        `<a href="/status_codes/200">200</a>${duplicate ? '<a href="/status_codes/200">200</a>' : ''}`,
      '/status_codes/200': '<p>To return, go <a href="/status_codes">here</a></p>',
    };
    response.statusCode = pages[route] ? 200 : 404;
    response.end(pages[route] ?? '<p>missing</p>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  return { url: `http://127.0.0.1:${address.port}`,
    changeTarget: () => { changedTarget = 'role'; },
    changeDestination: () => { changedTarget = 'destination'; },
    removeNumeric: () => { removeNumeric = true; },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

function factory(port: number) {
  return new ProtectedContextFactory(new ProfileCatalog([{
    id: 'wp3-profile', version: '1', browser: 'chromium',
    viewport: { width: 900, height: 650 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: { default: 3000 } },
    networkPolicyRef: { id: 'wp3-policy', version: '1' },
  }], [{ id: 'wp3-policy', version: '1', destinations: [{ host: '127.0.0.1',
    ports: [port], addresses: ['127.0.0.1'] }] }]));
}

function spec(base: string, ambiguous = false) {
  const root = new URL('/', base).href;
  const at = (route: string) => new URL(route, root).href;
  return { schemaVersion: '2', testSpecId: `test-wp3-${randomUUID()}`,
    sourceInstruction: 'Open Status Codes, click 200, return here',
    executionProfileRef: { id: 'wp3-profile', version: '1' },
    startState: { url: 'about:blank' }, steps: [
      { id: 'step_1', type: 'navigate', sourceText: 'Go to site', url: root },
      { id: 'step_2', type: 'click', sourceText: 'Click Status Codes',
        target: { description: 'link that says Status Codes' } },
      { id: 'step_3', type: 'assert_url', sourceText: 'Confirm Status Codes URL',
        expectedUrl: at('status_codes'), match: 'exact' },
      { id: 'step_4', type: 'click', sourceText: 'Click 200',
        target: { description: ambiguous ? 'link with text "200" or "201"' :
          'link with text 200' } },
      { id: 'step_5', type: 'assert_url', sourceText: 'Confirm 200 URL',
        expectedUrl: at('status_codes/200'), match: 'exact' },
      { id: 'step_6', type: 'click', sourceText: 'Click here',
        target: { description: 'here link in the sentence ending with go here' } },
      { id: 'step_7', type: 'assert_url', sourceText: 'Confirm return URL',
        expectedUrl: at('status_codes'), match: 'exact' },
    ] };
}

const model: AgenticDecisionModelV3 = { complete: async ({ context }) => {
  if (context.stage === 'evaluate') return JSON.stringify({ decisionVersion: '3', kind: 'evaluate', verdict: 'achieved' });
  const names: Record<string, string> = { step_2: 'Status Codes', step_4: '200', step_6: 'here' };
  const name = names[context.authoredStep.id];
  const ref = context.snapshot.split('\n').flatMap((line) =>
    line.includes(`- link "${name}"`) ? [/\[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(line)?.[1]] : [])
    .find((item): item is string => !!item);
  if (!ref) return JSON.stringify({ decisionVersion: '3', kind: 'inspect' });
  return JSON.stringify({ decisionVersion: '3', kind: 'act', ref, action: 'click',
    source: 'authored', expectedEffect: 'state_changed' });
} };

test('WP3 compiles real-provider-shaped Step 2, 4, and 6 identity across a fresh protected context', async () => {
  const site = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp3-'));
  try {
    const protectedFactory = factory(Number(new URL(site.url).port));
    const store = new LocalArtifactStore(root);
    const source = spec(site.url);
    await store.createJob(source, protectedFactory.catalog.resolve(source.executionProfileRef));
    let modelCalls = 0;
    const measuredModel: AgenticDecisionModelV3 = { complete: async (request) => {
      modelCalls += 1;
      return model.complete(request);
    } };
    const explored = await runAgenticExplorationV1(protectedFactory, store, source, measuredModel,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(explored.kind).toBe('path_established');
    const result = await compileSuccessfulTraceV1(protectedFactory, store, source.testSpecId, explored.attemptId);
    expect(result.kind, JSON.stringify({ reason: result.kind === 'compilation_stop' ? result.reason : undefined,
      failedChecks: result.compiler.checks.filter((item) => item.result === 'failed').map((item) =>
        ({ kind: item.kind, reason: item.reasonCode, traceRecordId: item.traceRecordId })) })).toBe('compiled');
    if (result.kind !== 'compiled') return;
    const stored = await store.readSuccessfulExploration(source.testSpecId, explored.attemptId);
    const actionIds = stored.trace.successfulPath.filter((record) => record.type === 'click')
      .map((record) => record.recordId);
    expect(result.compiler.checks.filter((item) => item.kind === 'durable_identity' &&
      actionIds.includes(item.traceRecordId)).map((item) => item.result)).toEqual([
      'passed', 'passed', 'passed',
    ]);
    expect(result.resolved.executionSteps.map((step) => step.type)).toEqual(source.steps.map((step) => step.type));
    expect(result.resolved.executionSteps.filter((step) => 'locator' in step)).toHaveLength(3);
    expect((await store.readCompiledExplorationV6(source.testSpecId, explored.attemptId,
      result.compiler.compilerAttemptId)).resolved).toEqual(result.resolved);
    const callsBeforeReplay = modelCalls;
    const run = await executeResolvedTestSpecV6(protectedFactory, source, result.resolved,
      { ...stored, compiler: result.compiler });
    expect(modelCalls).toBe(callsBeforeReplay);
    expect(run.outcomes.map((item) => item.status)).toEqual([
      'OPERATION_SUCCEEDED', 'OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED',
      'OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED', 'OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED',
    ]);
    expect(() => parseResolvedTestSpec(result.resolved, source)).toThrow();
    await expect(executeResolvedTestSpecV6(protectedFactory, source,
      { ...result.resolved, compilerAttemptId: 'compiler-forged' },
      { ...stored, compiler: result.compiler })).rejects.toThrow('linkage mismatch');
    site.changeTarget();
    const drift = await executeResolvedTestSpecV6(protectedFactory, source, result.resolved,
      { ...stored, compiler: result.compiler });
    expect(drift.outcomes[1]).toMatchObject({ status: 'LOCATOR_BINDING_FAILED', reason: 'NO_MATCH' });
    expect(drift.outcomes[2]).toMatchObject({ status: 'NOT_RUN' });
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP4A executes a compiled URL-pattern wait without deriving a later condition', async () => {
  const site = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp4a-pattern-'));
  try {
    const protectedFactory = factory(Number(new URL(site.url).port));
    const store = new LocalArtifactStore(root);
    const url = `${site.url}/`;
    const source = { schemaVersion: '2', testSpecId: `test-wp4a-pattern-${randomUUID()}`,
      sourceInstruction: 'Open and wait for approved URL pattern',
      executionProfileRef: { id: 'wp3-profile', version: '1' },
      startState: { url: 'about:blank' }, steps: [
        { id: 'step_1', type: 'navigate', sourceText: 'Open page', url },
        { id: 'step_2', type: 'wait_for', sourceText: 'Wait for the page URL',
          condition: { type: 'url_pattern', pattern: `${site.url}/*` }, timeoutPolicyRef: 'default' },
        { id: 'step_3', type: 'assert_url', sourceText: 'Confirm page URL',
          expectedUrl: url, match: 'exact' },
      ] };
    await store.createJob(source, protectedFactory.catalog.resolve(source.executionProfileRef));
    const explored = await runAgenticExplorationV1(protectedFactory, store, source, model,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(explored.kind).toBe('path_established');
    const compiled = await compileSuccessfulTraceV1(protectedFactory, store,
      source.testSpecId, explored.attemptId);
    expect(compiled.kind).toBe('compiled');
    if (compiled.kind !== 'compiled') return;
    const stored = await store.readSuccessfulExploration(source.testSpecId, explored.attemptId);
    const run = await executeResolvedTestSpecV6(protectedFactory, source, compiled.resolved,
      { ...stored, compiler: compiled.compiler });
    expect(run.outcomes.map((item) => item.status)).toEqual([
      'OPERATION_SUCCEEDED', 'OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED',
    ]);
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP3 compiles witnessed Status Codes readiness as an ordered deterministic wait', async () => {
  const site = await fixture(false, true);
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp3-readiness-'));
  try {
    const protectedFactory = factory(Number(new URL(site.url).port));
    const store = new LocalArtifactStore(root);
    const source = spec(site.url);
    await store.createJob(source, protectedFactory.catalog.resolve(source.executionProfileRef));
    let delayed = false;
    const waitingModel: AgenticDecisionModelV3 = { complete: async (request) => {
      if (!delayed && request.context.authoredStep.id === 'step_4' && request.context.stage === 'select') {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 1100));
      }
      return model.complete(request);
    } };
    const explored = await runAgenticExplorationV1(protectedFactory, store, source, waitingModel,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(explored.kind).toBe('path_established');
    const stored = await store.readSuccessfulExploration(source.testSpecId, explored.attemptId);
    expect(stored.trace.traceVersion).toBe('2');
    const passive = stored.trace.successfulPath.find((record) => record.type === 'state_observed');
    expect(passive).toMatchObject({ condition: { type: 'target_visible' },
      witness: { kind: 'protected_condition_check', satisfied: true } });
    const result = await compileSuccessfulTraceV1(protectedFactory, store, source.testSpecId, explored.attemptId);
    expect(result.kind, JSON.stringify({ reason: result.kind === 'compilation_stop' ? result.reason : undefined,
      failedChecks: result.compiler.checks.filter((item) => item.result === 'failed').map((item) =>
        ({ kind: item.kind, reason: item.reasonCode, traceRecordId: item.traceRecordId,
          recordType: stored.trace.successfulPath.find((record) => record.recordId === item.traceRecordId)?.type })) })).toBe('compiled');
    if (result.kind !== 'compiled') return;
    expect(result.resolved.executionSteps.map((step) => step.type)).toEqual([
      'navigate', 'click', 'assert_url', 'wait_for', 'click', 'assert_url', 'click', 'assert_url',
    ]);
    expect((await store.readCompiledExplorationV6(source.testSpecId, explored.attemptId,
      result.compiler.compilerAttemptId)).resolved).toEqual(result.resolved);
    const run = await executeResolvedTestSpecV6(protectedFactory, source, result.resolved,
      { ...stored, compiler: result.compiler });
    expect(run.outcomes.map((item) => item.status)).toEqual([
      'OPERATION_SUCCEEDED', 'OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED',
      'OPERATION_SUCCEEDED', 'OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED',
      'OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED',
    ]);
    site.removeNumeric();
    const unready = await executeResolvedTestSpecV6(protectedFactory, source, result.resolved,
      { ...stored, compiler: result.compiler });
    expect(unready.outcomes[3]).toMatchObject({ status: 'LOCATOR_BINDING_FAILED', reason: 'NO_MATCH' });
    expect(unready.outcomes[4]).toMatchObject({ status: 'NOT_RUN' });
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP3 re-establishes a nested frame by exact title and denies ambiguous ancestry', async () => {
  let ambiguous = false;
  const child = '<button onclick="document.body.append(document.createElement(\'p\'))">Submit</button>';
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    const frame = `<iframe title="review frame" srcdoc="${child.replaceAll('"', '&quot;')}"></iframe>`;
    response.end(frame + (ambiguous ? '<iframe title="review frame" srcdoc="<p>other</p>"></iframe>' : ''));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp3-frame-'));
  try {
    const url = `http://127.0.0.1:${address.port}/`;
    const protectedFactory = factory(address.port);
    const store = new LocalArtifactStore(root);
    const source = { schemaVersion: '2', testSpecId: `test-wp3-frame-${randomUUID()}`,
      sourceInstruction: 'Open and click Submit in the review frame',
      executionProfileRef: { id: 'wp3-profile', version: '1' },
      startState: { url: 'about:blank' }, steps: [
        { id: 'step_1', type: 'navigate', sourceText: 'Open page', url },
        { id: 'step_2', type: 'click', sourceText: 'Click the Submit button',
          target: { description: 'button with text "Submit"' } },
        { id: 'step_3', type: 'assert_url', sourceText: 'Confirm main page URL', expectedUrl: url, match: 'exact' },
      ] };
    const nestedModel: AgenticDecisionModelV3 = { complete: async ({ context }) => {
      if (context.stage === 'evaluate') return JSON.stringify({ decisionVersion: '3', kind: 'evaluate', verdict: 'achieved' });
      const ref = /- button "Submit" \[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(context.snapshot)?.[1];
      return ref ? JSON.stringify({ decisionVersion: '3', kind: 'act', ref, action: 'click',
        source: 'authored', expectedEffect: 'state_changed' }) :
        JSON.stringify({ decisionVersion: '3', kind: 'inspect' });
    } };
    await store.createJob(source, protectedFactory.catalog.resolve(source.executionProfileRef));
    const explored = await runAgenticExplorationV1(protectedFactory, store, source, nestedModel,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(explored.kind).toBe('path_established');
    const stored = await store.readSuccessfulExploration(source.testSpecId, explored.attemptId);
    expect(stored.trace.traceVersion).toBe('2');
    expect(stored.trace.bindings[0]).toMatchObject({ frameOwnership: { kind: 'nested', anchors: [
      { identity: { kind: 'title', value: 'review frame', exact: true } },
    ] } });
    const accepted = await compileSuccessfulTraceV1(protectedFactory, store, source.testSpecId, explored.attemptId);
    expect(accepted.kind).toBe('compiled');
    if (accepted.kind !== 'compiled') return;
    expect(accepted.resolved.executionSteps[1]).toMatchObject({ type: 'click', locator: {
      framePath: [{ kind: 'title', value: 'review frame', exact: true }],
    } });
    const replay = await executeResolvedTestSpecV6(protectedFactory, source, accepted.resolved,
      { ...stored, compiler: accepted.compiler });
    expect(replay.outcomes.map((item) => item.status)).toEqual([
      'OPERATION_SUCCEEDED', 'OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED',
    ]);
    const malformed = structuredClone(accepted.resolved);
    const targetStep = malformed.executionSteps[1];
    if (targetStep && 'locator' in targetStep && targetStep.locator)
      targetStep.locator.framePath = [{ kind: 'title', value: 'different frame', exact: true }];
    expect(() => parseResolvedTestSpecV6(malformed, source, stored.attempt,
      stored.trace, accepted.compiler)).toThrow('frame path differs');
    const unprovenAttempt = `explore-${randomUUID()}`;
    const unprovenTrace = `trace-${randomUUID()}`;
    await expect(store.writeSuccessfulExploration({
      attempt: { ...stored.attempt, explorationAttemptId: unprovenAttempt,
        successfulTraceId: unprovenTrace },
      trace: { ...stored.trace, explorationAttemptId: unprovenAttempt,
        successfulTraceId: unprovenTrace,
        bindings: stored.trace.bindings.map((binding) => ({ ...binding,
          explorationAttemptId: unprovenAttempt,
          frameOwnership: { kind: 'unproven', reasonCode: 'ambiguous_anchor' } })) },
    })).rejects.toThrow('unproven required frame ownership');
    ambiguous = true;
    const ambiguousReplay = await executeResolvedTestSpecV6(protectedFactory, source,
      accepted.resolved, { ...stored, compiler: accepted.compiler });
    expect(ambiguousReplay.outcomes[1]).toMatchObject({ status: 'LOCATOR_BINDING_FAILED',
      reason: 'FRAME_RESOLUTION_FAILED' });
    const rejected = await compileSuccessfulTraceV1(protectedFactory, store, source.testSpecId, explored.attemptId);
    expect(rejected).toMatchObject({ kind: 'compilation_stop', reason: 'TARGET_MISMATCH' });
    await expect(store.readCompiledExplorationV6(source.testSpecId, explored.attemptId,
      rejected.compiler.compilerAttemptId)).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('WP3 compiles a protected target-value passive witness before the authored wait', async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<label>Input <input></label><script>setTimeout(() => { document.querySelector("input").value = "Ready"; }, 900)</script>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp3-value-'));
  try {
    const url = `http://127.0.0.1:${address.port}/`;
    const protectedFactory = factory(address.port);
    const store = new LocalArtifactStore(root);
    const source = { schemaVersion: '2', testSpecId: `test-wp3-value-${randomUUID()}`,
      sourceInstruction: 'Open page and wait for Input value Ready',
      executionProfileRef: { id: 'wp3-profile', version: '1' },
      startState: { url: 'about:blank' }, steps: [
        { id: 'step_1', type: 'navigate', sourceText: 'Open page', url },
        { id: 'step_2', type: 'wait_for', sourceText: 'Wait for Input value Ready',
          condition: { type: 'target_value', target: { description: 'textbox with text "Input"' },
            expectedValue: 'Ready' }, timeoutPolicyRef: 'default' },
        { id: 'step_3', type: 'assert_url', sourceText: 'Confirm URL', expectedUrl: url, match: 'exact' },
      ] };
    let first = true;
    const valueModel: AgenticDecisionModelV3 = { complete: async ({ context }) => {
      if (first && context.authoredStep.id === 'step_2' && context.stage === 'select') {
        first = false;
        await new Promise((resolve) => setTimeout(resolve, 1100));
        return JSON.stringify({ decisionVersion: '3', kind: 'inspect' });
      }
      const ref = /- textbox "Input" \[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(context.snapshot)?.[1];
      return ref ? JSON.stringify({ decisionVersion: '3', kind: 'observe_target', ref,
        operation: 'wait_for' }) : JSON.stringify({ decisionVersion: '3', kind: 'inspect' });
    } };
    await store.createJob(source, protectedFactory.catalog.resolve(source.executionProfileRef));
    const explored = await runAgenticExplorationV1(protectedFactory, store, source, valueModel,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(explored.kind).toBe('path_established');
    const stored = await store.readSuccessfulExploration(source.testSpecId, explored.attemptId);
    expect(stored.trace.successfulPath.map((record) => record.type)).toEqual([
      'navigate', 'state_observed', 'wait_for', 'assert_url',
    ]);
    const compiled = await compileSuccessfulTraceV1(protectedFactory, store, source.testSpecId, explored.attemptId);
    expect(compiled.kind).toBe('compiled');
    if (compiled.kind === 'compiled') {
      expect(compiled.resolved.executionSteps.map((step) => step.type)).toEqual([
        'navigate', 'wait_for', 'wait_for', 'assert_url',
      ]);
      const run = await executeResolvedTestSpecV6(protectedFactory, source, compiled.resolved,
        { ...stored, compiler: compiled.compiler });
      expect(run.outcomes.map((item) => item.status)).toEqual([
        'OPERATION_SUCCEEDED', 'OPERATION_SUCCEEDED', 'OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED',
      ]);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('WP3 rejects a digest-only passive transition without creating v6', async () => {
  const site = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp3-passive-'));
  try {
    const protectedFactory = factory(Number(new URL(site.url).port));
    const store = new LocalArtifactStore(root);
    const source = spec(site.url);
    await store.createJob(source, protectedFactory.catalog.resolve(source.executionProfileRef));
    const explored = await runAgenticExplorationV1(protectedFactory, store, source, model,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(explored.kind).toBe('path_established');
    const stored = await store.readSuccessfulExploration(source.testSpecId, explored.attemptId);
    const trace = stored.trace;
    if (trace.traceVersion !== '2') throw new Error('Expected v2 trace');
    const before = trace.successfulPath[1]!;
    const passiveStateDigest = 'f'.repeat(64);
    const passive = { recordId: 'record-passive', sequence: 2, originStepId: before.originStepId,
      source: 'discoveredPrerequisite', prerequisiteReasonCode: 'reach_state',
      preStateDigest: before.preStateDigest, postStateDigest: passiveStateDigest,
      observationDigest: before.observationDigest, observedEffect: 'state_changed',
      type: 'state_observed', result: 'observed' };
    // This fixture mirrors the real eight-record shape through an immutable
    // second attempt, rather than mutating the previously persisted trace.
    const alternateAttempt = `explore-${randomUUID()}`;
    const alternateTraceId = `trace-${randomUUID()}`;
    const rewritten = trace.successfulPath.map((record, index) => ({ ...record,
      sequence: index >= 1 ? index + 2 : index + 1,
      ...(index === 1 ? { preStateDigest: passiveStateDigest } : {}) }));
    rewritten.splice(1, 0, passive as typeof rewritten[number]);
    const attempt = { ...stored.attempt, explorationAttemptId: alternateAttempt,
      successfulTraceId: alternateTraceId };
    const alternate = { ...trace, traceVersion: '1', explorationAttemptId: alternateAttempt,
      successfulTraceId: alternateTraceId, successfulPath: rewritten,
      bindings: trace.bindings.map(({ frameOwnership: _ownership, ...binding }) =>
        ({ ...binding, explorationAttemptId: alternateAttempt })) };
    await store.writeSuccessfulExploration({ attempt, trace: alternate });
    const result = await compileSuccessfulTraceV1(protectedFactory, store, source.testSpecId, alternateAttempt);
    expect(result).toMatchObject({ kind: 'compilation_stop', reason: 'UNSUPPORTED_CAPABILITY' });
    await expect(store.readCompiledExplorationV6(source.testSpecId, alternateAttempt,
      result.compiler.compilerAttemptId)).rejects.toThrow();
    expect((await store.readSuccessfulExploration(source.testSpecId, alternateAttempt)).trace)
      .toEqual(alternate);
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP3 compiles a witnessed exact-URL passive transition and keeps v1 digest-only history rejected', async () => {
  const site = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp3-url-wait-'));
  try {
    const protectedFactory = factory(Number(new URL(site.url).port));
    const store = new LocalArtifactStore(root);
    const url = `${site.url}/`;
    const source = { schemaVersion: '2', testSpecId: `test-wp3-url-${randomUUID()}`,
      sourceInstruction: 'Open page and confirm URL',
      executionProfileRef: { id: 'wp3-profile', version: '1' },
      startState: { url: 'about:blank' }, steps: [
        { id: 'step_1', type: 'navigate', sourceText: 'Open page', url },
        { id: 'step_2', type: 'assert_url', sourceText: 'Confirm URL', expectedUrl: url, match: 'exact' },
      ] };
    await store.createJob(source, protectedFactory.catalog.resolve(source.executionProfileRef));
    const explored = await runAgenticExplorationV1(protectedFactory, store, source, model,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(explored.kind).toBe('path_established');
    const stored = await store.readSuccessfulExploration(source.testSpecId, explored.attemptId);
    const original = stored.trace;
    expect(original.traceVersion).toBe('2');
    const second = original.successfulPath[1]!;
    const condition = { type: 'url_exact' as const, url };
    const observationDigest = second.observationDigest;
    const observedStateDigest = 'e'.repeat(64);
    const recordId = `record-${randomUUID()}`;
    const passive = { recordId, sequence: 2, originStepId: second.originStepId,
      source: 'discoveredPrerequisite' as const, prerequisiteReasonCode: 'reach_state' as const,
      preStateDigest: second.preStateDigest, postStateDigest: observedStateDigest,
      observationDigest, observedEffect: 'state_changed' as const,
      type: 'state_observed' as const, result: 'observed' as const,
      condition, timeoutPolicyRef: 'default',
      witness: { kind: 'protected_condition_check' as const, traceRecordId: recordId,
        timeoutPolicyRef: 'default', conditionDigest: createHash('sha256').update(JSON.stringify(condition)).digest('hex'),
        observationDigest, observedStateDigest, observedAt: original.finishedAt, satisfied: true as const },
    };
    const alternateAttempt = `explore-${randomUUID()}`;
    const alternateTraceId = `trace-${randomUUID()}`;
    const attempt = { ...stored.attempt, explorationAttemptId: alternateAttempt,
      successfulTraceId: alternateTraceId };
    const trace = { ...original, explorationAttemptId: alternateAttempt,
      successfulTraceId: alternateTraceId, finalStateDigest: observedStateDigest,
      successfulPath: [original.successfulPath[0], passive,
        { ...second, sequence: 3, preStateDigest: observedStateDigest,
          postStateDigest: observedStateDigest }] };
    await store.writeSuccessfulExploration({ attempt, trace });
    const compiled = await compileSuccessfulTraceV1(protectedFactory, store, source.testSpecId, alternateAttempt);
    expect(compiled.kind).toBe('compiled');
    if (compiled.kind !== 'compiled') return;
    expect(compiled.resolved.executionSteps.map((step) => step.type)).toEqual(['navigate', 'wait_for', 'assert_url']);
    expect(compiled.resolved.executionSteps[1]).toMatchObject({ type: 'wait_for', condition,
      timeoutPolicyRef: 'default' });
    const acceptedStored = await store.readSuccessfulExploration(source.testSpecId, alternateAttempt);
    const replay = await executeResolvedTestSpecV6(protectedFactory, source, compiled.resolved,
      { ...acceptedStored, compiler: compiled.compiler });
    expect(replay.outcomes.map((item) => item.status)).toEqual([
      'OPERATION_SUCCEEDED', 'OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED',
    ]);
    // Even a structurally linked witness cannot make an unobserved predicate
    // true in the fresh compiler context.
    const wrong = { type: 'url_exact' as const, url: `${site.url}/never` };
    const deniedAttempt = `explore-${randomUUID()}`;
    const deniedTrace = `trace-${randomUUID()}`;
    const deniedRecord = { ...passive, condition: wrong, witness: {
      ...passive.witness,
      conditionDigest: createHash('sha256').update(JSON.stringify(wrong)).digest('hex'),
    } };
    await store.writeSuccessfulExploration({
      attempt: { ...attempt, explorationAttemptId: deniedAttempt, successfulTraceId: deniedTrace },
      trace: { ...trace, explorationAttemptId: deniedAttempt, successfulTraceId: deniedTrace,
        successfulPath: [original.successfulPath[0], deniedRecord,
          { ...second, sequence: 3, preStateDigest: observedStateDigest,
            postStateDigest: observedStateDigest }] },
    });
    const denied = await compileSuccessfulTraceV1(protectedFactory, store, source.testSpecId, deniedAttempt);
    expect(denied).toMatchObject({ kind: 'compilation_stop', reason: 'POSTCONDITION_MISMATCH' });
    await expect(store.readCompiledExplorationV6(source.testSpecId, deniedAttempt,
      denied.compiler.compilerAttemptId)).rejects.toThrow();
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP3 rejects indistinguishable fresh targets instead of choosing by position', async () => {
  const site = await fixture(true);
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp3-duplicate-'));
  try {
    const protectedFactory = factory(Number(new URL(site.url).port));
    const store = new LocalArtifactStore(root);
    const source = spec(site.url);
    await store.createJob(source, protectedFactory.catalog.resolve(source.executionProfileRef));
    const explored = await runAgenticExplorationV1(protectedFactory, store, source, model,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(explored.kind).toBe('path_established');
    const result = await compileSuccessfulTraceV1(protectedFactory, store, source.testSpecId, explored.attemptId);
    expect(result).toMatchObject({ kind: 'compilation_stop', reason: 'NON_UNIQUE_MATCH' });
    const step4RecordId = (await store.readSuccessfulExploration(source.testSpecId,
      explored.attemptId)).trace.successfulPath[3]?.recordId;
    expect(result.compiler.checks.some((item) => item.kind === 'unique_match' &&
      item.traceRecordId === step4RecordId &&
      item.observedMatchCount === 2)).toBe(true);
    await expect(store.readCompiledExplorationV6(source.testSpecId, explored.attemptId,
      result.compiler.compilerAttemptId)).rejects.toThrow();
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP3 compiles the reviewed exact-cell row scope and permits multiple immutable attempts', async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<table><tbody><tr><td>Iuvaret0</td><td><a href="#edit">edit</a></td></tr>' +
      '<tr><td>Iuvaret1</td><td><a href="#edit">edit</a></td></tr></tbody></table>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp3-row-'));
  try {
    const base = `http://127.0.0.1:${address.port}/`;
    const protectedFactory = factory(address.port);
    const store = new LocalArtifactStore(root);
    const source = { schemaVersion: '2', testSpecId: `test-wp3-row-${randomUUID()}`,
      sourceInstruction: 'Open the page and click edit in the Iuvaret1 row',
      executionProfileRef: { id: 'wp3-profile', version: '1' },
      startState: { url: 'about:blank' }, steps: [
        { id: 'step_1', type: 'navigate', sourceText: 'Open page', url: base },
        { id: 'step_2', type: 'click', sourceText: 'Click edit in the Iuvaret1 row',
          target: { description: 'edit link', scope: [{ kind: 'row', description: 'row containing Iuvaret1' }] } },
        { id: 'step_3', type: 'assert_url', sourceText: 'Confirm edit URL',
          expectedUrl: `${base}#edit`, match: 'exact' },
      ] };
    const rowModel: AgenticDecisionModelV3 = { complete: async ({ context }) => {
      if (context.stage === 'evaluate') return JSON.stringify({ decisionVersion: '3', kind: 'evaluate', verdict: 'achieved' });
      const row = context.snapshot.split('\n').findIndex((line) => line.includes('cell "Iuvaret1"'));
      const line = context.snapshot.split('\n').slice(row + 1).find((entry) => entry.includes('link "edit"'));
      const ref = line && /\[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(line)?.[1];
      return ref ? JSON.stringify({ decisionVersion: '3', kind: 'act', ref, action: 'click',
        source: 'authored', expectedEffect: 'state_changed' }) :
        JSON.stringify({ decisionVersion: '3', kind: 'inspect' });
    } };
    await store.createJob(source, protectedFactory.catalog.resolve(source.executionProfileRef));
    const explored = await runAgenticExplorationV1(protectedFactory, store, source, rowModel,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(explored.kind).toBe('path_established');
    const first = await compileSuccessfulTraceV1(protectedFactory, store, source.testSpecId, explored.attemptId);
    expect(first.kind).toBe('compiled');
    if (first.kind !== 'compiled') return;
    const target = first.resolved.executionSteps[1];
    expect(target?.type).toBe('click');
    if (target?.type === 'click') expect(target.locator.validatedForm).toEqual({
      type: 'within', scope: { type: 'rowWithCell', cellName: 'Iuvaret1' },
      target: { type: 'role', role: 'link', name: 'edit', exact: true },
    });
    const stored = await store.readSuccessfulExploration(source.testSpecId, explored.attemptId);
    const replay = await executeResolvedTestSpecV6(protectedFactory, source, first.resolved,
      { ...stored, compiler: first.compiler });
    expect(replay.outcomes.map((item) => item.status)).toEqual([
      'OPERATION_SUCCEEDED', 'OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED',
    ]);
    const second = await compileSuccessfulTraceV1(protectedFactory, store, source.testSpecId, explored.attemptId);
    expect(second.kind).toBe('compiled');
    expect(second.compiler.compilerAttemptId).not.toBe(first.compiler.compilerAttemptId);
    expect((await store.readCompiledExplorationV6(source.testSpecId, explored.attemptId,
      first.compiler.compilerAttemptId)).resolved).toEqual(first.resolved);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('WP3 denies a changed semantic target even when its eventual URL is unchanged', async () => {
  const site = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp3-drift-'));
  try {
    const protectedFactory = factory(Number(new URL(site.url).port));
    const store = new LocalArtifactStore(root);
    const source = spec(site.url);
    await store.createJob(source, protectedFactory.catalog.resolve(source.executionProfileRef));
    const explored = await runAgenticExplorationV1(protectedFactory, store, source, model,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(explored.kind).toBe('path_established');
    site.changeTarget();
    const result = await compileSuccessfulTraceV1(protectedFactory, store, source.testSpecId, explored.attemptId);
    expect(result).toMatchObject({ kind: 'compilation_stop', reason: 'NON_UNIQUE_MATCH' });
    const check = result.compiler.checks.find((item) => item.kind === 'unique_match' && item.result === 'failed');
    expect(check?.observedMatchCount).toBe(0);
    await expect(store.readCompiledExplorationV6(source.testSpecId, explored.attemptId,
      result.compiler.compilerAttemptId)).rejects.toThrow();
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP3 rejects a wrong successful-prefix transition after unique target binding', async () => {
  const site = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp3-postcondition-'));
  try {
    const protectedFactory = factory(Number(new URL(site.url).port));
    const store = new LocalArtifactStore(root);
    const source = spec(site.url);
    await store.createJob(source, protectedFactory.catalog.resolve(source.executionProfileRef));
    const explored = await runAgenticExplorationV1(protectedFactory, store, source, model,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(explored.kind).toBe('path_established');
    site.changeDestination();
    const result = await compileSuccessfulTraceV1(protectedFactory, store, source.testSpecId, explored.attemptId);
    expect(result).toMatchObject({ kind: 'compilation_stop', reason: 'POSTCONDITION_MISMATCH' });
    expect(result.compiler.checks.some((item) => item.kind === 'selected_target' && item.result === 'passed')).toBe(true);
    await expect(store.readCompiledExplorationV6(source.testSpecId, explored.attemptId,
      result.compiler.compilerAttemptId)).rejects.toThrow();
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP3 does not trust or reuse exploration-only MCP references', async () => {
  const site = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp3-stale-ref-'));
  try {
    const protectedFactory = factory(Number(new URL(site.url).port));
    const store = new LocalArtifactStore(root);
    const source = spec(site.url);
    await store.createJob(source, protectedFactory.catalog.resolve(source.executionProfileRef));
    const explored = await runAgenticExplorationV1(protectedFactory, store, source, model,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(explored.kind).toBe('path_established');
    const original = await store.readSuccessfulExploration(source.testSpecId, explored.attemptId);
    const explorationAttemptId = `explore-${randomUUID()}`;
    const successfulTraceId = `trace-${randomUUID()}`;
    await store.writeSuccessfulExploration({
      attempt: { ...original.attempt, explorationAttemptId, successfulTraceId },
      trace: { ...original.trace, explorationAttemptId, successfulTraceId,
        bindings: original.trace.bindings.map((binding, index) => ({ ...binding,
          explorationAttemptId, selectedRef: `oldRef${index}`, frameId: `oldFrame${index}` })) },
    });
    const result = await compileSuccessfulTraceV1(protectedFactory, store, source.testSpecId, explorationAttemptId);
    expect(result.kind).toBe('compiled');
    if (result.kind === 'compiled') {
      expect(result.resolved.executionSteps.filter((step) => 'locator' in step)).toHaveLength(3);
      expect(JSON.stringify(result.resolved)).not.toContain('oldRef');
      expect(JSON.stringify(result.resolved)).not.toContain('oldFrame');
    }
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP3 refuses ambiguous authored role/name prose even when the chosen link works', async () => {
  const site = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp3-ambiguous-'));
  try {
    const protectedFactory = factory(Number(new URL(site.url).port));
    const store = new LocalArtifactStore(root);
    const source = spec(site.url, true);
    await store.createJob(source, protectedFactory.catalog.resolve(source.executionProfileRef));
    const explored = await runAgenticExplorationV1(protectedFactory, store, source, model,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(explored.kind).toBe('path_established');
    const result = await compileSuccessfulTraceV1(protectedFactory, store, source.testSpecId, explored.attemptId);
    expect(result).toMatchObject({ kind: 'compilation_stop', reason: 'WEAK_IDENTITY' });
    await expect(store.readCompiledExplorationV6(source.testSpecId, explored.attemptId,
      result.compiler.compilerAttemptId)).rejects.toThrow();
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP3 atomically persists v6 for a trace without unprovable target bindings', async () => {
  const site = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp3-nontarget-'));
  try {
    const protectedFactory = factory(Number(new URL(site.url).port));
    const store = new LocalArtifactStore(root);
    const source = { schemaVersion: '2', testSpecId: `test-wp3-nontarget-${randomUUID()}`,
      sourceInstruction: 'Open the public page and confirm its exact URL',
      executionProfileRef: { id: 'wp3-profile', version: '1' },
      startState: { url: 'about:blank' }, steps: [
        { id: 'step_1', type: 'navigate', sourceText: 'Go to page', url: `${site.url}/` },
        { id: 'step_2', type: 'assert_url', sourceText: 'Confirm page URL',
          expectedUrl: `${site.url}/`, match: 'exact' },
      ] };
    await store.createJob(source, protectedFactory.catalog.resolve(source.executionProfileRef));
    const explored = await runAgenticExplorationV1(protectedFactory, store, source, model,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(explored.kind).toBe('path_established');
    const result = await compileSuccessfulTraceV1(protectedFactory, store, source.testSpecId, explored.attemptId);
    expect(result.kind).toBe('compiled');
    if (result.kind !== 'compiled') return;
    expect(result.resolved.executionSteps.map((step) => step.type)).toEqual(['navigate', 'assert_url']);
    expect((await store.readCompiledExplorationV6(source.testSpecId, explored.attemptId,
      result.compiler.compilerAttemptId)).resolved).toEqual(result.resolved);
    expect(() => parseResolvedTestSpec(result.resolved, source)).toThrow();
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});
