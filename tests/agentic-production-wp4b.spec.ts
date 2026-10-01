import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { expect, test } from '@playwright/test';
import { parseTestSpec } from '../app/domain/index.js';
import { LocalArtifactStore } from '../app/evidence/index.js';
import type { ExecutionRun } from '../app/runner/index.js';
import { createOpenAIAgenticDecisionModel, runAgenticProductionV1,
  finalizeAgenticOutcomeV2,
  type AgenticDecisionModelV3 } from '../app/interpretation/index.js';
import { ModelCompletionFailure } from '../app/interpretation/model-failure.js';
import { envelopeForAgenticTerminalV2 } from '../app/subprocess/protocol-v2.js';
import { projectStoredAgenticReportV2 } from '../app/subprocess/report-projection-v2.js';
import { ProfileCatalog, ProtectedContextFactory } from '../app/profile/index.js';

async function fixture() {
  let duplicate = false;
  let numericAvailable = true;
  const server = http.createServer((request, response) => {
    const route = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
    const pages: Record<string, string> = {
      '/': '<a href="/status_codes">Status Codes</a>',
      '/status_codes': numericAvailable ? `<a href="/status_codes/200">200</a>${duplicate ? '<a href="/status_codes/200">200</a>' : ''}` : '<p>200 unavailable</p>',
      '/status_codes/200': '<p>To return, go <a href="/status_codes">here</a></p>',
    };
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.statusCode = pages[route] ? 200 : 404;
    response.end(pages[route] ?? '<p>missing</p>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  const url = `http://127.0.0.1:${address.port}/`;
  return { url, port: address.port, duplicate: () => { duplicate = true; },
    removeNumeric: () => { numericAvailable = false; },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())); } };
}

function source(url: string, assertFalse = false) {
  const at = (route: string) => new URL(route, url).href;
  return { schemaVersion: '2', testSpecId: `test-wp4b-${randomUUID()}`,
    sourceInstruction: 'Open Status Codes, click 200, return here',
    executionProfileRef: { id: 'wp4b-profile', version: '1' }, startState: { url: 'about:blank' }, steps: [
      { id: 'step_1', type: 'navigate', sourceText: 'Go to site', url },
      { id: 'step_2', type: 'click', sourceText: 'Click Status Codes',
        target: { description: 'link that says "Status Codes"' } },
      { id: 'step_3', type: 'assert_url', sourceText: 'Confirm Status Codes URL',
        expectedUrl: at('status_codes'), match: 'exact' },
      { id: 'step_4', type: 'click', sourceText: 'Click 200',
        target: { description: 'link with the text: "200"' } },
      { id: 'step_5', type: 'assert_url', sourceText: 'Confirm 200 URL',
        expectedUrl: at('status_codes/200'), match: 'exact' },
      { id: 'step_6', type: 'click', sourceText: 'Click here',
        target: { description: 'here link in sentence ending with go here' } },
      { id: 'step_7', type: 'assert_url', sourceText: 'Confirm return URL',
        expectedUrl: at('status_codes'), match: 'exact' },
      ...(assertFalse ? [{ id: 'step_8', type: 'assert_url', sourceText: 'Observe an evaluable false URL predicate',
        expectedUrl: at('wrong'), match: 'exact' }] : []),
    ] };
}

const model: AgenticDecisionModelV3 = { complete: async ({ context }) => {
  if (context.stage === 'evaluate') return JSON.stringify({ decisionVersion: '3', kind: 'evaluate', verdict: 'achieved' });
  const name = ({ step_2: 'Status Codes', step_4: '200', step_6: 'here' } as Record<string, string>)[context.authoredStep.id];
  const ref = context.snapshot.split('\n').flatMap((line) => line.includes(`- link "${name}"`)
    ? [/\[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(line)?.[1]] : [])
    .find((value): value is string => !!value);
  if (!ref) return JSON.stringify({ decisionVersion: '3', kind: 'inspect' });
  return JSON.stringify({ decisionVersion: '3', kind: 'act', ref, action: 'click',
    source: 'authored', expectedEffect: 'state_changed' });
} };

class HookStore extends LocalArtifactStore {
  afterCompilation?: () => void;
  afterRun?: (ordinal: number) => void;
  failSecondRun = false;
  #runs = 0;

  override async writeCompiledExplorationV6(input: { compiler: unknown; resolved: unknown }) {
    const saved = await super.writeCompiledExplorationV6(input);
    this.afterCompilation?.();
    return saved;
  }

  override async writeAgenticRunV6(testSpecId: string, attemptId: string,
    compilerId: string, run: ExecutionRun) {
    if (this.failSecondRun && this.#runs === 1) throw new Error('Injected second-run storage failure');
    const saved = await super.writeAgenticRunV6(testSpecId, attemptId, compilerId, run);
    this.#runs += 1;
    this.afterRun?.(this.#runs);
    return saved;
  }
}

async function setup(port: number) {
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp4b-'));
  const factory = new ProtectedContextFactory(new ProfileCatalog([{
    id: 'wp4b-profile', version: '1', browser: 'chromium', viewport: { width: 900, height: 650 },
    locale: 'en-US', timeoutPolicy: { actionMs: 4000, navigationMs: 4000, waits: { default: 3000 } },
    networkPolicyRef: { id: 'wp4b-policy', version: '1' },
  }], [{ id: 'wp4b-policy', version: '1', destinations: [{ host: '127.0.0.1',
    ports: [port], addresses: ['127.0.0.1'] }] }]));
  return { root, factory, store: new HookStore(root) };
}

test('WP4B private path compiles seven goals then persists two independent v6 replays', async () => {
  const site = await fixture();
  const { root, factory, store } = await setup(site.port);
  try {
    const spec = source(site.url);
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    const result = await runAgenticProductionV1(factory, store, spec, model,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(result.kind).toBe('executed');
    if (result.kind !== 'executed') throw new Error(JSON.stringify(result));
    expect(result.qa).toBe('QA_ASSERTION_PASSED');
    expect(result.resolved.schemaVersion).toBe('6');
    expect(result.replay[0].executionRunId).not.toBe(result.replay[1].executionRunId);
    expect(result.replay.every((run) => run.effectiveProfile.fingerprint === result.resolved.profileFingerprint)).toBe(true);
    expect(result.replay.flatMap((run) => run.outcomes).filter((record) => record.status === 'QA_ASSERTION_PASSED')).toHaveLength(6);
    expect(result.resolved.executionSteps.some((step) => step.originStepId === 'step_4' &&
      step.type === 'click' && step.locator.validatedForm.type === 'role' &&
      step.locator.validatedForm.name === '200')).toBe(true);
    const stored = await store.readSuccessfulExploration(spec.testSpecId, result.attemptId);
    expect(stored.trace.traceVersion).toBe('2');
    expect((await store.readRun(spec.testSpecId, result.replay[0].executionRunId)).resolvedSpecId).toBe(result.resolved.resolvedSpecId);
    expect((await store.readRun(spec.testSpecId, result.replay[1].executionRunId)).resolvedSpecId).toBe(result.resolved.resolvedSpecId);
    const external = await finalizeAgenticOutcomeV2(store, parseTestSpec(spec), result);
    expect(external.terminal).toEqual({ stage: 'qa', status: 'QA_ASSERTION_PASSED' });
    const envelope = envelopeForAgenticTerminalV2(external, true);
    expect(envelope.kind).toBe('success');
    const effective = factory.catalog.resolve(spec.executionProfileRef);
    const projection = await projectStoredAgenticReportV2({ reportProjectionVersion: '2', result: envelope }, {
      profiles: [effective.profile], networkPolicies: [effective.policy], artifactRoot: root, retentionDays: 7,
      evidencePolicy: { finalScreenshot: false, failureScreenshot: false, failureTrace: false,
        failureVideo: false, sensitiveBinaryApproved: false },
    });
    expect(projection.kind).toBe('available');
    if (projection.kind === 'available') {
      expect(projection.authoritativeQa).toBe('QA_ASSERTION_PASSED');
      expect(projection.replays.map((run) => run.state)).toEqual(['completed_pass', 'completed_pass']);
      const safe = JSON.stringify(projection);
      expect(safe).not.toContain('rawMcpExpression');
      expect(safe).not.toContain('validatedForm');
      expect(safe).not.toContain('branchKind');
      expect(safe).not.toContain('http://127.0.0.1:');
    }
    const forged = structuredClone(envelope);
    if (forged.kind === 'bridge_error') throw new Error('Expected agentic result');
    forged.context.result.profileFingerprint = 'b'.repeat(64);
    expect(await projectStoredAgenticReportV2({ reportProjectionVersion: '2', result: forged }, {
      profiles: [effective.profile], networkPolicies: [effective.policy], artifactRoot: root, retentionDays: 7,
      evidencePolicy: { finalScreenshot: false, failureScreenshot: false, failureTrace: false,
        failureVideo: false, sensitiveBinaryApproved: false },
    })).toMatchObject({ kind: 'unavailable', reason: 'CORRELATION_MISMATCH' });
    const compiledPath = path.join(root, spec.testSpecId, 'agentic-compiler-attempts',
      result.successfulTraceId, `${result.compilerAttemptId}.json`);
    const compiled = JSON.parse(await readFile(compiledPath, 'utf8')) as {
      compiler: unknown; resolved: Record<string, unknown> };
    compiled.resolved.profileFingerprint = 'c'.repeat(64);
    await writeFile(compiledPath, JSON.stringify(compiled));
    expect((await projectStoredAgenticReportV2({ reportProjectionVersion: '2', result: envelope }, {
      profiles: [effective.profile], networkPolicies: [effective.policy], artifactRoot: root, retentionDays: 7,
      evidencePolicy: { finalScreenshot: false, failureScreenshot: false, failureTrace: false,
        failureVideo: false, sensitiveBinaryApproved: false },
    })).kind).toBe('unavailable');
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP4B preserves the first persisted replay when the second run cannot complete', async () => {
  const site = await fixture();
  const { root, factory, store } = await setup(site.port);
  store.failSecondRun = true;
  try {
    const spec = source(site.url);
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    const result = await runAgenticProductionV1(factory, store, spec, model,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(result).toMatchObject({ kind: 'stopped', stage: 'replay', cleanup: 'unverified',
      outcome: { boundary: 'environment', status: 'unavailable' } });
    if (result.kind !== 'stopped') throw new Error('Expected non-QA stop');
    expect(result.replay).toHaveLength(1);
    const terminal = await finalizeAgenticOutcomeV2(store, parseTestSpec(spec), result);
    expect(terminal.executionRunIds).toHaveLength(1);
    expect(terminal.terminal).toEqual({ stage: 'environment', status: 'ENVIRONMENT_FAILED',
      reason: 'SESSION_CLEANUP_FAILED' });
    expect(terminal).not.toHaveProperty('qa');
    const effective = factory.catalog.resolve(spec.executionProfileRef);
    const projection = await projectStoredAgenticReportV2({ reportProjectionVersion: '2',
      result: envelopeForAgenticTerminalV2(terminal, true) }, {
      profiles: [effective.profile], networkPolicies: [effective.policy], artifactRoot: root, retentionDays: 7,
      evidencePolicy: { finalScreenshot: false, failureScreenshot: false, failureTrace: false,
        failureVideo: false, sensitiveBinaryApproved: false },
    });
    expect(projection).toMatchObject({ kind: 'available', cleanup: 'unverified',
      executionRunIds: terminal.executionRunIds });
    if (projection.kind === 'available') expect(projection.authoritativeQa).toBeUndefined();
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP4B compilation rejection persists no v6 replay or QA verdict', async () => {
  const site = await fixture();
  const { root, factory, store } = await setup(site.port);
  site.duplicate();
  try {
    const spec = source(site.url);
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    const result = await runAgenticProductionV1(factory, store, spec, model,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(result).toMatchObject({ kind: 'stopped', stage: 'compilation',
      outcome: { boundary: 'compilation' } });
    const external = await finalizeAgenticOutcomeV2(store, parseTestSpec(spec), result);
    expect(external.terminal.stage).toBe('compilation');
    expect(external.resolvedSpecId).toBeUndefined();
    const envelope = envelopeForAgenticTerminalV2(external, true);
    const effective = factory.catalog.resolve(spec.executionProfileRef);
    const projection = await projectStoredAgenticReportV2({ reportProjectionVersion: '2', result: envelope }, {
      profiles: [effective.profile], networkPolicies: [effective.policy], artifactRoot: root, retentionDays: 7,
      evidencePolicy: { finalScreenshot: false, failureScreenshot: false, failureTrace: false,
        failureVideo: false, sensitiveBinaryApproved: false },
    });
    expect(projection).toMatchObject({ kind: 'available',
      stages: { compilation: { status: 'stopped' } } });
    expect(await store.listIds(spec.testSpecId, 'runs')).toHaveLength(0);
    expect(await store.listIds(spec.testSpecId, 'attempts')).toHaveLength(0);
    expect(await store.listIds(spec.testSpecId, 'resolved')).toHaveLength(0);
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP4B exploration stop never compiles, replays, or falls back to legacy', async () => {
  const site = await fixture();
  const { root, factory, store } = await setup(site.port);
  try {
    const spec = source(site.url);
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    const stopModel: AgenticDecisionModelV3 = { complete: async () => JSON.stringify({
      decisionVersion: '3', kind: 'stop', reason: 'TARGET_NOT_FOUND',
    }) };
    const result = await runAgenticProductionV1(factory, store, spec, stopModel,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(result).toMatchObject({ kind: 'stopped', stage: 'exploration',
      outcome: { boundary: 'exploration' } });
    expect(await store.listIds(spec.testSpecId, 'runs')).toHaveLength(0);
    expect(await store.listIds(spec.testSpecId, 'attempts')).toHaveLength(0);
    expect(await store.listIds(spec.testSpecId, 'resolved')).toHaveLength(0);
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP4B typed provider failure remains an environment terminal', async () => {
  const site = await fixture();
  const { root, factory, store } = await setup(site.port);
  try {
    const spec = source(site.url);
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    const brokenModel: AgenticDecisionModelV3 = { complete: async () => {
      throw new ModelCompletionFailure('PROVIDER_ERROR');
    } };
    const result = await runAgenticProductionV1(factory, store, spec, brokenModel,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(result).toMatchObject({ kind: 'stopped', stage: 'exploration',
      reasonCode: 'PROVIDER_ERROR', outcome: { boundary: 'environment', status: 'unavailable' } });
    const external = await finalizeAgenticOutcomeV2(store, parseTestSpec(spec), result);
    expect(external.terminal).toEqual({ stage: 'environment', status: 'ENVIRONMENT_FAILED',
      reason: 'PROVIDER_ERROR' });
    expect(external.executionRunIds).toEqual([]);
    expect(envelopeForAgenticTerminalV2(external, false)).toMatchObject({
      kind: 'typed_stop', stopKind: 'environment_stop', context: { report: { kind: 'unavailable' } },
    });
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP4B replay binding failure remains automation, not QA', async () => {
  const site = await fixture();
  const { root, factory, store } = await setup(site.port);
  store.afterCompilation = site.removeNumeric;
  try {
    const spec = source(site.url);
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    const result = await runAgenticProductionV1(factory, store, spec, model,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(result).toMatchObject({ kind: 'stopped', stage: 'replay',
      outcome: { boundary: 'replay', status: 'execution_failed' } });
    if (result.kind !== 'stopped' || !result.replay) throw new Error('Missing replay pair');
    expect(result.replay).toHaveLength(2);
    expect(result.replay.every((run) => run.outcomes.some((item) => item.status === 'LOCATOR_BINDING_FAILED'))).toBe(true);
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP4B replay disagreement stops without selecting either QA result', async () => {
  const site = await fixture();
  const { root, factory, store } = await setup(site.port);
  store.afterRun = (ordinal) => { if (ordinal === 1) site.removeNumeric(); };
  try {
    const spec = source(site.url);
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    const result = await runAgenticProductionV1(factory, store, spec, model,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(result).toMatchObject({ kind: 'stopped', stage: 'replay',
      outcome: { boundary: 'replay', status: 'not_reproduced' } });
    if (result.kind !== 'stopped' || !result.replay) throw new Error('Missing replay pair');
    expect(result.replay[0]?.outcomes.some((item) => item.status === 'QA_ASSERTION_PASSED')).toBe(true);
    expect(result.replay[1]?.outcomes.some((item) => item.status === 'LOCATOR_BINDING_FAILED')).toBe(true);
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP4B observed false assertion becomes QA failure only after two replay assertions', async () => {
  const site = await fixture();
  const { root, factory, store } = await setup(site.port);
  try {
    const spec = source(site.url, true);
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    const result = await runAgenticProductionV1(factory, store, spec, model,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(result, JSON.stringify(result.kind === 'stopped' ? {
      stage: result.stage, reasonCode: result.reasonCode, outcome: result.outcome,
    } : { kind: result.kind, qa: result.qa })).toMatchObject({ kind: 'executed', qa: 'QA_ASSERTION_FAILED' });
    if (result.kind !== 'executed') throw new Error(JSON.stringify(result));
    const { trace } = await store.readSuccessfulExploration(spec.testSpecId, result.attemptId);
    expect(trace.successfulPath.find((record) => record.originStepId === 'step_8')).toMatchObject({
      type: 'assert_url', result: 'failed',
    });
    expect(result.replay.every((run) => run.outcomes.some((item) =>
      item.originStepId === 'step_8' && item.status === 'QA_ASSERTION_FAILED'))).toBe(true);
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP4B refuses a workflow-version switch before opening a browser', async () => {
  const site = await fixture();
  const { root, factory, store } = await setup(site.port);
  try {
    const spec = source(site.url);
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    await expect(runAgenticProductionV1(factory, store, spec, model,
      { workflowVersion: 'legacy' as 'agentic-exploration-v1' })).rejects.toThrow('Agentic workflow version required');
    expect(await store.listIds(spec.testSpecId, 'runs')).toHaveLength(0);
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP4B provider adapter uses closed M7-v3 wire and rejects extra fields', async () => {
  const spec = parseTestSpec(source('http://127.0.0.1:3000/'));
  const seen: unknown[] = [];
  const responses = [
    { response: { decisionVersion: '3', kind: 'inspect', focus: null } },
    { response: { decisionVersion: '3', kind: 'act', ref: 'e1', action: 'click',
      source: 'authored', prerequisiteReasonCode: null, expectedEffect: 'state_changed',
      rawPageText: 'restricted' } },
  ];
  const provider = createOpenAIAgenticDecisionModel({ apiKey: () => 'test-secret',
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seen.push(body);
      const response = responses.shift();
      return new Response(JSON.stringify({ status: 'completed', error: null,
        incomplete_details: null, output: [{ type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text: JSON.stringify(response) }] }] }), { status: 200 });
    }) as typeof fetch });
  const request = { systemInstruction: 'closed agentic instruction',
    context: { decisionVersion: '3' as const, authoredStep: spec.steps[1]!,
      stage: 'select' as const, snapshot: '- link "Status Codes" [ref=e1]',
      currentUrl: 'http://127.0.0.1:3000/', candidateOrdinal: 0, prerequisiteCount: 0 },
    signal: new AbortController().signal };
  expect(JSON.parse(await provider.complete(request))).toEqual({ decisionVersion: '3', kind: 'inspect' });
  await expect(provider.complete(request)).rejects.toMatchObject({ code: 'PROVIDER_OUTPUT_INVALID' });
  expect(seen).toHaveLength(2);
  expect((seen[0] as Record<string, unknown>).text).toMatchObject({
    format: { name: 'agentic_exploration_decision_v3' },
  });
  expect(JSON.stringify(seen)).not.toContain('test-secret');
});
