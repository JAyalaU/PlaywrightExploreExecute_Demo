import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { parseTrustedLocalConfiguration } from '../app/local/contracts.js';
import {
  AGENTIC_DECISION_SYSTEM_INSTRUCTION, AgenticDecisionV3Schema, runAgenticExplorationV1,
  protectedAgenticSessionOpener,
  type AgenticDecisionModelV3,
} from '../app/interpretation/index.js';
import { LocalArtifactStore } from '../app/evidence/index.js';
import { ProfileCatalog, ProtectedContextFactory, publicTargetGate } from '../app/profile/index.js';

const statusTask = '1. Go to https://the-internet.herokuapp.com/.\n' +
  '2. Locate the Status Codes link and click it.\n' +
  '3. Confirm the URL is exactly https://the-internet.herokuapp.com/status_codes.\n' +
  '4. Locate the 200 link and click it.\n' +
  '5. Confirm the URL is exactly https://the-internet.herokuapp.com/status_codes/200.\n' +
  '6. Locate the here link in the sentence ending with go here and click it.\n' +
  '7. Confirm the URL is exactly https://the-internet.herokuapp.com/status_codes.';

function sevenGoalSpec(base: string, testSpecId = `test-agentic-wp2-${randomUUID()}`,
  executionProfileRef = { id: 'wp2-release-profile', version: '1' }) {
  const root = new URL('/', base).href;
  const at = (path: string) => new URL(path, root).href;
  return { schemaVersion: '2', testSpecId, sourceInstruction: statusTask,
    executionProfileRef,
    startState: { url: 'about:blank' }, steps: [
      { id: 'step_1', type: 'navigate', sourceText: 'Go to Status Codes site', url: root },
      { id: 'step_2', type: 'click', sourceText: 'Locate the Status Codes link and click it',
        target: { description: 'link that says "Status Codes"' } },
      { id: 'step_3', type: 'assert_url', sourceText: 'Confirm status codes URL',
        expectedUrl: at('status_codes'), match: 'exact' },
      { id: 'step_4', type: 'click', sourceText: 'Locate the 200 link and click it',
        target: { description: 'link with the text: "200"' } },
      { id: 'step_5', type: 'assert_url', sourceText: 'Confirm 200 URL',
        expectedUrl: at('status_codes/200'), match: 'exact' },
      { id: 'step_6', type: 'click', sourceText: 'Locate the here link in the sentence ending with go here and click it',
        target: { description: 'here link in sentence ending with go here' } },
      { id: 'step_7', type: 'assert_url', sourceText: 'Confirm return URL',
        expectedUrl: at('status_codes'), match: 'exact' },
    ] };
}

test('WP2 release: exact Status Codes URLs are canonical with or without a trailing root slash', () => {
  for (const base of ['https://the-internet.herokuapp.com', 'https://the-internet.herokuapp.com/']) {
    const spec = sevenGoalSpec(base);
    expect(spec.steps[0]?.url).toBe('https://the-internet.herokuapp.com/');
    expect(spec.steps.filter((step) => step.type === 'assert_url').map((step) => step.expectedUrl))
      .toEqual([
        'https://the-internet.herokuapp.com/status_codes',
        'https://the-internet.herokuapp.com/status_codes/200',
        'https://the-internet.herokuapp.com/status_codes',
      ]);
  }
});

test('WP2 v2: model decisions cannot supply protected frame or wait facts', () => {
  const decision = { decisionVersion: '3', kind: 'act', ref: 'ref-link', action: 'click',
    source: 'authored', expectedEffect: 'state_changed' };
  for (const extra of [
    { frameOwnership: { kind: 'main', observationDigest: 'a'.repeat(64) } },
    { condition: { type: 'url_exact', url: 'https://example.test/' } },
    { witness: { satisfied: true } },
  ]) expect(AgenticDecisionV3Schema.safeParse({ ...decision, ...extra }).success).toBe(false);
});

function deterministicDecisionModel(): AgenticDecisionModelV3 {
  const names: Record<string, string> = {
    step_2: 'Status Codes', step_4: '200', step_6: 'here',
  };
  return { complete: async ({ context }) => {
    if (context.stage === 'evaluate') return JSON.stringify({ decisionVersion: '3', kind: 'evaluate', verdict: 'achieved' });
    const name = names[context.authoredStep.id];
    const escaped = name?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ref = escaped && new RegExp(`- link "${escaped}" \\[ref=([A-Za-z][A-Za-z0-9_-]*)\\]`)
      .exec(context.snapshot)?.[1];
    if (!ref) return JSON.stringify({ decisionVersion: '3', kind: 'inspect' });
    return JSON.stringify({ decisionVersion: '3', kind: 'act', ref, action: 'click',
      source: 'authored', expectedEffect: 'state_changed' });
  } };
}

async function fixture() {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    const route = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
    const pages: Record<string, string> = {
      '/': '<a href="/status_codes">Status Codes</a>',
      '/status_codes': '<p>Loading</p><script>setTimeout(() => { const link = document.createElement("a"); link.href = "/status_codes/200"; link.textContent = "200"; document.body.append(link); }, 900)</script>',
      '/status_codes/200': '<p>To return, go <a href="/status_codes">here</a></p>',
    };
    response.statusCode = pages[route] ? 200 : 404;
    response.end(pages[route] ?? '<p>missing</p>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  return { url: `http://127.0.0.1:${address.port}`,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

function localFactory(port: number) {
  return new ProtectedContextFactory(new ProfileCatalog([{
    id: 'wp2-release-profile', version: '1', browser: 'chromium',
    viewport: { width: 900, height: 650 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: { default: 3000 } },
    networkPolicyRef: { id: 'wp2-release-policy', version: '1' },
  }], [{ id: 'wp2-release-policy', version: '1', destinations: [{
    host: '127.0.0.1', ports: [port], addresses: ['127.0.0.1'],
  }] }]));
}

test('WP2 release: seven authored Status Codes goals form a successful trace and stop before compilation', async () => {
  const target = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp2-release-'));
  try {
    const factory = localFactory(Number(new URL(target.url).port));
    const store = new LocalArtifactStore(root);
    const spec = sevenGoalSpec(target.url, 'test-agentic-wp2-seven-goals');
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    const modelCalls: { stage: string; stepId: string }[] = [];
    const model = deterministicDecisionModel();
    let delayedNumeric = false;
    const recordingModel: AgenticDecisionModelV3 = { complete: async (request) => {
      modelCalls.push({ stage: request.context.stage, stepId: request.context.authoredStep.id });
      if (!delayedNumeric && request.context.authoredStep.id === 'step_4' &&
          request.context.stage === 'select') {
        delayedNumeric = true;
        await new Promise((resolve) => setTimeout(resolve, 1100));
      }
      return model.complete(request);
    } };
    const outcome = await runAgenticExplorationV1(factory, store, spec, recordingModel,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(outcome).toMatchObject({ kind: 'path_established', cleanup: 'verified' });
    const stored = await store.readSuccessfulExploration(spec.testSpecId, outcome.attemptId);
    const trace = stored.trace;
    expect(trace.traceVersion).toBe('2');
    if (trace.traceVersion !== '2') throw new Error('Expected v2 trace');
    expect(trace.completedOriginStepIds).toEqual(spec.steps.map((step) => step.id));
    expect(trace.successfulPath.filter((record) => record.source === 'authored')
      .map((record) => record.originStepId)).toEqual(spec.steps.map((step) => step.id));
    expect(trace.successfulPath.map((record) => record.type)).toEqual([
      'navigate', 'click', 'assert_url', 'state_observed', 'click', 'assert_url',
      'click', 'assert_url',
    ]);
    const readiness = trace.successfulPath.find((record) => record.type === 'state_observed');
    expect(readiness).toMatchObject({ originStepId: 'step_4', source: 'discoveredPrerequisite',
      condition: { type: 'target_visible', target: { description: 'link with the text: "200"' } },
      witness: { kind: 'protected_condition_check', satisfied: true } });
    for (const id of ['step_2', 'step_4', 'step_6']) {
      const action = trace.successfulPath.find((record) =>
        record.originStepId === id && record.type === 'click')!;
      const bindingId = 'bindingId' in action ? action.bindingId : undefined;
      const binding = trace.bindings.find((candidate) => candidate.bindingId === bindingId)!;
      expect(action.type).toBe('click');
      expect(action.result).toBe('completed');
      expect(action.preStateDigest).not.toBe(action.postStateDigest);
      expect(binding.selectedRef).toBeTruthy();
      expect(binding.sessionId).toBe(trace.sessionId);
      expect('frameOwnership' in binding && binding.frameOwnership.kind).toBe('main');
    }
    expect(trace.bindings.find((binding) => binding.originStepId === 'step_4')?.selectedNode)
      .toMatchObject({ role: 'link', accessibleName: '200' });
    expect(trace.successfulPath.filter((record) => record.type === 'assert_url').map((record) => record.result))
      .toEqual(['passed', 'passed', 'passed']);
    expect(modelCalls).toEqual([
      { stage: 'select', stepId: 'step_2' }, { stage: 'evaluate', stepId: 'step_2' },
      { stage: 'select', stepId: 'step_4' }, { stage: 'select', stepId: 'step_4' },
      { stage: 'evaluate', stepId: 'step_4' },
      { stage: 'select', stepId: 'step_6' }, { stage: 'evaluate', stepId: 'step_6' },
    ]);
    expect(trace.successfulPath).toHaveLength(8);
    expect(JSON.stringify(trace)).not.toMatch(/resolvedSpecId|validatedForm|QA_ASSERTION_|compilerAttemptId/);
    expect(await store.readExplorationBranchDiagnostics(spec.testSpecId, outcome.attemptId)).toEqual([]);
    await expect(store.readCompilerAttemptV1(spec.testSpecId, outcome.attemptId, 'compiler-none')).rejects.toThrow();
  } finally { await target.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP2 v2: incidental passive page change without a grounded condition stops', async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<a href="/next">Status Codes</a><script>setTimeout(() => { const marker = document.createElement("p"); marker.textContent = "ready"; document.body.append(marker); }, 120)</script>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp2-passive-'));
  try {
    const base = `http://127.0.0.1:${address.port}`;
    const factory = localFactory(address.port);
    const store = new LocalArtifactStore(root);
    const spec = { schemaVersion: '2', testSpecId: 'test-agentic-wp2-passive',
      sourceInstruction: 'Open the page and click Status Codes',
      executionProfileRef: { id: 'wp2-release-profile', version: '1' },
      startState: { url: 'about:blank' }, steps: [
        { id: 'step_1', type: 'navigate', sourceText: 'Open page', url: `${base}/` },
        { id: 'step_2', type: 'click', sourceText: 'Click Status Codes',
          target: { description: 'link that says "Status Codes"' } },
      ] };
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    let delayed = false;
    const model: AgenticDecisionModelV3 = { complete: async (request) => {
      if (!delayed && request.context.authoredStep.id === 'step_2' && request.context.stage === 'select') {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return deterministicDecisionModel().complete(request);
    } };
    const outcome = await runAgenticExplorationV1(factory, store, spec, model,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(outcome).toMatchObject({ kind: 'stopped', status: 'unsupported',
      reasonCode: 'UNSUPPORTED_OPERATION', cleanup: 'verified' });
    await expect(store.readSuccessfulExploration(spec.testSpecId, outcome.attemptId)).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('WP2 v2: newly visible authored target carries a protected passive witness', async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<p>Loading</p><script>setTimeout(() => { const link = document.createElement("a"); link.href = "/next"; link.textContent = "Status Codes"; document.body.append(link); }, 120)</script>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp2-v2-passive-'));
  try {
    const base = `http://127.0.0.1:${address.port}`;
    const factory = localFactory(address.port);
    const store = new LocalArtifactStore(root);
    const spec = { schemaVersion: '2', testSpecId: 'test-agentic-wp2-v2-passive',
      sourceInstruction: 'Open the page and click Status Codes',
      executionProfileRef: { id: 'wp2-release-profile', version: '1' },
      startState: { url: 'about:blank' }, steps: [
        { id: 'step_1', type: 'navigate', sourceText: 'Open page', url: `${base}/` },
        { id: 'step_2', type: 'click', sourceText: 'Click Status Codes',
          target: { description: 'link that says "Status Codes"' } },
      ] };
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    let delayed = false;
    const model: AgenticDecisionModelV3 = { complete: async (request) => {
      if (!delayed && request.context.authoredStep.id === 'step_2' && request.context.stage === 'select') {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return deterministicDecisionModel().complete(request);
    } };
    const outcome = await runAgenticExplorationV1(factory, store, spec, model,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(outcome).toMatchObject({ kind: 'path_established', cleanup: 'verified' });
    if (outcome.kind !== 'path_established') return;
    const trace = (await store.readSuccessfulExploration(spec.testSpecId, outcome.attemptId)).trace;
    expect(trace.traceVersion).toBe('2');
    const transition = trace.successfulPath.find((record) => record.type === 'state_observed');
    expect(transition).toMatchObject({ source: 'discoveredPrerequisite',
      prerequisiteReasonCode: 'reach_state', originStepId: 'step_2',
      condition: { type: 'target_visible', target: { description: 'link that says "Status Codes"' } },
      witness: { kind: 'protected_condition_check', satisfied: true } });
    const waitBinding = trace.bindings.find((binding) => binding.bindingId ===
      (transition && 'bindingId' in transition ? transition.bindingId : undefined));
    expect(waitBinding).toMatchObject({ operation: 'wait_for', frameOwnership: { kind: 'main' } });
    expect(trace.successfulPath.filter((record) => record.source === 'authored')
      .map((record) => record.originStepId)).toEqual(['step_1', 'step_2']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('WP2 v2: an unproven required frame yields a typed stop without a successful trace', async () => {
  const target = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp2-v2-unproven-'));
  try {
    const factory = localFactory(Number(new URL(target.url).port));
    const store = new LocalArtifactStore(root);
    const spec = sevenGoalSpec(target.url, 'test-agentic-wp2-v2-unproven');
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    const protectedOpen = protectedAgenticSessionOpener(factory);
    let delayedNumeric = false;
    const model: AgenticDecisionModelV3 = { complete: async (request) => {
      if (!delayedNumeric && request.context.authoredStep.id === 'step_4' &&
          request.context.stage === 'select') {
        delayedNumeric = true;
        await new Promise((resolve) => setTimeout(resolve, 1100));
      }
      return deterministicDecisionModel().complete(request);
    } };
    const outcome = await runAgenticExplorationV1(factory, store, spec,
      model, { workflowVersion: 'agentic-exploration-v1',
        openSession: async (source, attemptId, expected) => {
          const session = await protectedOpen(source, attemptId, expected);
          const actual = session.current.traceBinding.bind(session.current);
          session.current.traceBinding = (binding) => ({ ...actual(binding),
            frameOwnership: { kind: 'unproven', reasonCode: 'ambiguous_anchor' } });
          return session;
        } });
    expect(outcome).toMatchObject({ kind: 'stopped', status: 'unsupported',
      reasonCode: 'UNSUPPORTED_OPERATION', cleanup: 'verified' });
    await expect(store.readSuccessfulExploration(spec.testSpecId, outcome.attemptId)).rejects.toThrow();
  } finally { await target.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP2 release: ambiguous Save controls are inspected, failed choice is isolated, and a justified alternative succeeds', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp2-ambiguous-release-'));
  const pageServer = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    const route = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
    const html = route === '/status_codes'
      ? '<button onclick="this.blur()">Save</button><a href="/done">Save</a>'
      : route === '/done' ? '<p>complete</p>' : '<p>missing</p>';
    response.statusCode = route === '/status_codes' || route === '/done' ? 200 : 404;
    response.end(html);
  });
  try {
    await new Promise<void>((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
    const address = pageServer.address();
    if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
    const base = `http://127.0.0.1:${address.port}`;
    const local = localFactory(address.port);
    const localStore = new LocalArtifactStore(root);
    const localSpec = { schemaVersion: '2', testSpecId: 'test-agentic-wp2-ambiguous',
      sourceInstruction: 'Click the Save control that completes the page transition',
      executionProfileRef: { id: 'wp2-release-profile', version: '1' }, startState: { url: 'about:blank' },
      steps: [
        { id: 'step_1', type: 'navigate', sourceText: 'Open form', url: `${base}/status_codes` },
        { id: 'step_2', type: 'click', sourceText: 'Click the Save control that completes the page transition',
          target: { description: 'Save control' } },
        { id: 'step_3', type: 'assert_url', sourceText: 'Confirm completion',
          expectedUrl: `${base}/done`, match: 'exact' },
      ] };
    await localStore.createJob(localSpec, local.catalog.resolve(localSpec.executionProfileRef));
    let inspected = false, selection = 0, evaluations = 0;
    const choose: AgenticDecisionModelV3 = { complete: async ({ context }) => {
      if (context.stage === 'evaluate') return JSON.stringify({ decisionVersion: '3', kind: 'evaluate',
        verdict: ++evaluations === 1 ? 'try_alternative' : 'achieved' });
      if (!inspected) { inspected = true; return JSON.stringify({ decisionVersion: '3', kind: 'inspect', focus: 'Save' }); }
      const refs = [...context.snapshot.matchAll(/- (?:button|link) "Save" \[ref=([A-Za-z][A-Za-z0-9_-]*)\]/g)]
        .map((match) => match[1]!);
      return JSON.stringify({ decisionVersion: '3', kind: 'act', ref: refs[selection++],
        action: 'click', source: 'authored', expectedEffect: 'state_changed' });
    } };
    try {
      const outcome = await runAgenticExplorationV1(local, localStore, localSpec, choose,
        { workflowVersion: 'agentic-exploration-v1' });
      expect(outcome).toMatchObject({ kind: 'path_established', cleanup: 'verified' });
      const stored = await localStore.readSuccessfulExploration(localSpec.testSpecId, outcome.attemptId);
      expect(stored.trace.traceVersion).toBe('2');
      if (stored.trace.traceVersion !== '2') throw new Error('Expected v2 trace');
      expect(inspected).toBe(true);
      expect(selection).toBe(2);
      expect(evaluations).toBe(2);
      expect(stored.trace.successfulPath.filter((record) => record.type === 'click')).toHaveLength(1);
      expect(stored.trace.bindings.find((binding) => binding.originStepId === 'step_2')?.selectedNode.role).toBe('link');
      expect(stored.trace.bindings.every((binding) =>
        'frameOwnership' in binding && binding.frameOwnership.kind === 'main')).toBe(true);
      const branches = await localStore.readExplorationBranchDiagnostics(localSpec.testSpecId, outcome.attemptId);
      expect(branches).toHaveLength(1);
      expect(branches[0]).toMatchObject({ branchKind: 'failed_candidate', resultCode: 'no_progress' });
      expect(JSON.stringify(stored.trace)).not.toContain(branches[0]!.diagnosticId);
    } finally {
      pageServer.closeAllConnections();
      await new Promise<void>((resolve) => pageServer.close(() => resolve()));
    }
  } finally {
    pageServer.closeAllConnections();
    if (pageServer.listening) await new Promise<void>((resolve) => pageServer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

function strictDecisionSchema() {
  const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties,
    required: Object.keys(properties), additionalProperties: false });
  const literal = (value: string) => ({ type: 'string', enum: [value] });
  const decision = (kind: string, fields: Record<string, unknown>) => obj({
    decisionVersion: literal('3'), kind: literal(kind), ...fields,
  });
  return { type: 'json_schema', name: 'agentic_exploration_decision_v3', strict: true,
    schema: obj({ response: { anyOf: [
      decision('inspect', { focus: { type: ['string', 'null'] } }),
      decision('act', { ref: { type: 'string' }, action: { type: 'string', enum: ['click', 'fill', 'select_option'] },
        source: { type: 'string', enum: ['authored', 'discovered_prerequisite'] },
        prerequisiteReasonCode: { type: ['string', 'null'], enum: ['expose_target', 'reach_state', null] },
        expectedEffect: literal('state_changed') }),
      decision('observe_target', { ref: { type: 'string' }, operation: { type: 'string',
        enum: ['assert_visible', 'assert_text', 'assert_value', 'wait_for'] } }),
      decision('evaluate', { verdict: { type: 'string', enum: ['achieved', 'try_alternative', 'inspect', 'unresolved'] } }),
      decision('stop', { reason: { type: 'string', enum: ['TARGET_NOT_FOUND', 'UNSUPPORTED_OPERATION'] } }),
    ] } }),
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Provider response unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 262_144) throw new Error('Provider response exceeds bound');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function realProviderModel(apiKey: string): AgenticDecisionModelV3 {
  return { complete: async ({ systemInstruction, context, signal }) => {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-terra', reasoning: { effort: 'medium' },
        instructions: `${AGENTIC_DECISION_SYSTEM_INSTRUCTION}\nReturn JSON matching the supplied strict schema. Do not repeat page content.`,
        input: JSON.stringify(context), text: { format: strictDecisionSchema() },
        store: false, tools: [], tool_choice: 'none', max_output_tokens: 512, truncation: 'disabled' }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('REAL_PROVIDER_FAILED'); }
    const body = await boundedJson(response) as { status?: unknown; output?: unknown };
    if (body.status !== 'completed' || !Array.isArray(body.output)) throw new Error('REAL_PROVIDER_FAILED');
    const messages = body.output.filter((item) => !!item && typeof item === 'object' &&
      (item as { type?: unknown }).type === 'message');
    if (messages.length !== 1) throw new Error('REAL_PROVIDER_FAILED');
    const content = (messages[0] as { content?: unknown }).content;
    if (!Array.isArray(content) || content.length !== 1 ||
        !(content[0] && typeof content[0] === 'object' &&
          (content[0] as { type?: unknown }).type === 'output_text' &&
          typeof (content[0] as { text?: unknown }).text === 'string'))
      throw new Error('REAL_PROVIDER_FAILED');
    const parsed = JSON.parse((content[0] as { text: string }).text) as unknown;
    const envelope = parsed && typeof parsed === 'object' ? parsed as { response?: unknown } : undefined;
    const rawDecision = envelope?.response;
    if (rawDecision && typeof rawDecision === 'object' && !Array.isArray(rawDecision)) {
      const normalized = { ...(rawDecision as Record<string, unknown>) };
      if (normalized.focus === null) delete normalized.focus;
      if (normalized.prerequisiteReasonCode === null) delete normalized.prerequisiteReasonCode;
      return JSON.stringify(AgenticDecisionV3Schema.parse(normalized));
    }
    return JSON.stringify(AgenticDecisionV3Schema.parse(rawDecision));
  } };
}

const liveEnabled = process.env.AGENTIC_EXPLORATION_STATUS_CODES_LIVE === '1';
test('WP2 live: real provider solves seven Status Codes goals through the protected agentic path', async () => {
  test.skip(!liveEnabled, 'Set AGENTIC_EXPLORATION_STATUS_CODES_LIVE=1 for the operator-run proof.');
  const configPath = process.env.AGENTIC_EXPLORATION_STATUS_CODES_CONFIG;
  const artifactRoot = process.env.AGENTIC_EXPLORATION_STATUS_CODES_ARTIFACT_ROOT;
  const apiKey = process.env.OPENAI_API_KEY;
  expect(configPath).toBeTruthy();
  expect(artifactRoot).toBeTruthy();
  expect(apiKey?.trim()).toBeTruthy();
  const config = parseTrustedLocalConfiguration(JSON.parse(await readFile(configPath!, 'utf8')) as unknown);
  const approval = config.publicTargetApproval;
  if (!approval || !('admissionVersion' in approval) || approval.admissionVersion !== '1' ||
      approval.targetUrl !== 'https://the-internet.herokuapp.com/')
    throw new Error('EXACT_HEADLESS_APPROVAL_REQUIRED');
  const catalog = new ProfileCatalog(config.profiles, config.networkPolicies);
  const effective = catalog.resolve(approval!.executionProfileRef);
  expect(approval!.profileFingerprint).toBe(effective.fingerprint);
  expect(('presentationMode' in effective.profile ? effective.profile.presentationMode : 'headless')).toBe('headless');
  expect(effective.policy.destinations.map((item) => item.host)).toEqual(['the-internet.herokuapp.com']);
  const factory = new ProtectedContextFactory(catalog, undefined, publicTargetGate(approval));
  const store = new LocalArtifactStore(artifactRoot!, undefined, config.retentionDays);
  const source = sevenGoalSpec('https://the-internet.herokuapp.com/',
    `test-agentic-status-codes-${randomUUID()}`, approval!.executionProfileRef);
  expect(source.steps.filter((step) => step.type === 'assert_url').map((step) => step.expectedUrl))
    .toEqual([
      'https://the-internet.herokuapp.com/status_codes',
      'https://the-internet.herokuapp.com/status_codes/200',
      'https://the-internet.herokuapp.com/status_codes',
    ]);
  const resolved = catalog.resolve(source.executionProfileRef);
  expect(resolved.fingerprint).toBe(effective.fingerprint);
  await store.createJob(source, resolved);
  const decisionFacts: { stepId: string; stage: 'select' | 'evaluate';
    observedEffect?: 'state_changed' | 'state_unchanged'; kind: string; verdict?: string }[] = [];
  const provider = realProviderModel(apiKey!);
  const recordingProvider: AgenticDecisionModelV3 = { complete: async (request) => {
    const output = await provider.complete(request);
    const parsed = AgenticDecisionV3Schema.parse(JSON.parse(output) as unknown);
    decisionFacts.push({ stepId: request.context.authoredStep.id,
      stage: request.context.stage,
      ...(request.context.observedEffect ? { observedEffect: request.context.observedEffect } : {}),
      kind: parsed.kind,
      ...(parsed.kind === 'evaluate' ? { verdict: parsed.verdict } : {}) });
    return output;
  } };
  const outcome = await runAgenticExplorationV1(factory, store, source,
    recordingProvider, { workflowVersion: 'agentic-exploration-v1' });
  if (outcome.kind === 'stopped') {
    console.log(`AGENTIC_EXPLORATION_STOP_SAFE_EVIDENCE=${JSON.stringify({
      kind: 'agentic_exploration_stop_v1',
      testSpecId: source.testSpecId, explorationAttemptId: outcome.attemptId,
      profileFingerprint: effective.fingerprint, status: outcome.status,
      reasonCode: outcome.reasonCode, cleanup: outcome.cleanup,
      decisions: decisionFacts.slice(0, 60),
      replayLocatorCompilation: false, resolvedTestSpecProduced: false,
      deterministicReplayExecuted: false,
    })}`);
  }
  expect(outcome).toMatchObject({ kind: 'path_established', cleanup: 'verified' });
  if (outcome.kind !== 'path_established') throw new Error('AGENTIC_EXPLORATION_STOPPED');
  const stored = await store.readSuccessfulExploration(source.testSpecId, outcome.attemptId);
  const trace = stored.trace;
  expect(trace.traceVersion).toBe('2');
  if (trace.traceVersion !== '2') throw new Error('Expected v2 trace');
  expect(trace.completedOriginStepIds).toEqual(source.steps.map((step) => step.id));
  expect(trace.successfulPath.filter((record) => record.source === 'authored')
    .map((record) => record.originStepId)).toEqual(source.steps.map((step) => step.id));
  expect(trace.successfulPath.filter((record) => record.type === 'assert_url').map((record) => record.result))
    .toEqual(['passed', 'passed', 'passed']);
  const step4 = trace.successfulPath.find((record) =>
    record.originStepId === 'step_4' && record.type === 'click');
  const step4BindingId = step4 && 'bindingId' in step4 ? step4.bindingId : undefined;
  const step4Binding = trace.bindings.find((binding) => binding.bindingId === step4BindingId);
  expect(step4).toMatchObject({ type: 'click', result: 'completed' });
  expect(step4Binding?.selectedNode).toMatchObject({ role: 'link', accessibleName: '200' });
  expect(step4Binding && 'frameOwnership' in step4Binding &&
    step4Binding.frameOwnership.kind).toBe('main');
  expect(JSON.stringify(trace)).not.toMatch(/resolvedSpecId|validatedForm|compilerAttemptId|QA_ASSERTION_/);
  const safeEvidence = {
    kind: 'agentic_exploration_status_codes_v1',
    testSpecId: source.testSpecId,
    explorationAttemptId: outcome.attemptId,
    successfulTraceId: trace.successfulTraceId,
    traceVersion: trace.traceVersion,
    profile: { id: effective.profile.id, version: effective.profile.version },
    profileFingerprint: effective.fingerprint,
    authoredGoalCount: trace.completedOriginStepIds.length,
    traceRecordCount: trace.successfulPath.length,
    traceStoreKey: `${source.testSpecId}/agentic-explorations/${outcome.attemptId}.json`,
    urlAssertionResults: trace.successfulPath.filter((record) => record.type === 'assert_url').map((record) => record.result),
    numericLinkBoundAndActed: !!step4 && !!step4Binding,
    replayLocatorCompilation: false,
    resolvedTestSpecProduced: false,
    deterministicReplayExecuted: false,
    cleanup: outcome.cleanup,
  };
  console.log(`AGENTIC_EXPLORATION_SAFE_EVIDENCE=${JSON.stringify(safeEvidence)}`);
});
