import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { LocalArtifactStore } from '../app/evidence/index.js';
import {
  AGENTIC_EXPLORATION_LIMITS, AgenticDecisionV3Schema, assertAgenticBudget,
  protectedAgenticSessionOpener, runAgenticExplorationV1,
  type AgenticDecisionModelV3,
} from '../app/interpretation/index.js';
import { ExploratoryTargetResolutionError } from '../app/exploration/index.js';
import { ProfileCatalog, ProtectedContextFactory } from '../app/profile/index.js';

async function site(html: string | ((pathname: string) => string)) {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(request.url === '/status_codes/200' ? '<p>200 status</p>' :
      typeof html === 'string' ? html : html(request.url ?? '/'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  return { url: `http://127.0.0.1:${address.port}`, port: address.port,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
function environment(port: number) {
  const factory = new ProtectedContextFactory(new ProfileCatalog([{
    id: 'wp2c-profile', version: '1', browser: 'chromium', viewport: { width: 800, height: 600 },
    locale: 'en-US', timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: { default: 3000 } },
    networkPolicyRef: { id: 'wp2c-policy', version: '1' },
  }], [{ id: 'wp2c-policy', version: '1', destinations: [{
    host: '127.0.0.1', ports: [port], addresses: ['127.0.0.1'],
  }] }]));
  return factory;
}
function source(base: string, expected = `${base}/status_codes/200`) {
  return { schemaVersion: '2', testSpecId: 'test-agentic-wp2c',
    sourceInstruction: 'Open Status Codes, click link 200, confirm URL',
    executionProfileRef: { id: 'wp2c-profile', version: '1' },
    startState: { url: 'about:blank' }, steps: [
      { id: 's1', type: 'navigate', sourceText: 'Open Status Codes', url: `${base}/status_codes` },
      { id: 's2', type: 'click', sourceText: 'Click the link with the text: "200"',
        target: { description: 'link with the text: "200"' } },
      { id: 's3', type: 'assert_url', sourceText: 'Confirm URL', expectedUrl: expected,
        match: 'exact' },
    ] };
}
function saveSource(base: string) {
  return { schemaVersion: '2', testSpecId: 'test-agentic-save',
    sourceInstruction: 'Open, click the right Save control, confirm URL',
    executionProfileRef: { id: 'wp2c-profile', version: '1' },
    startState: { url: 'about:blank' }, steps: [
      { id: 's1', type: 'navigate', sourceText: 'Open form', url: `${base}/status_codes` },
      { id: 's2', type: 'click', sourceText: 'Click the right Save control',
        target: { description: 'Save control' } },
      { id: 's3', type: 'assert_url', sourceText: 'Confirm URL', expectedUrl: `${base}/done`, match: 'exact' },
    ] };
}
function model(): AgenticDecisionModelV3 {
  return { complete: async ({ context }) => JSON.stringify(context.stage === 'select'
    ? { decisionVersion: '3', kind: 'act', ref: /link "200" \[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(context.snapshot)?.[1],
      action: 'click', source: 'authored', expectedEffect: 'state_changed' }
    : { decisionVersion: '3', kind: 'evaluate', verdict: 'achieved' }) };
}

test('WP2C clicks link 200 through current-state binding, observes effect, and stores trace without a locator or replay', async () => {
  const target = await site('<a href="/status_codes/200">200</a>');
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp2c-'));
  try {
    const factory = environment(target.port);
    const store = new LocalArtifactStore(root);
    const spec = source(target.url);
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    const outcome = await runAgenticExplorationV1(factory, store, spec, model(),
      { workflowVersion: 'agentic-exploration-v1' });
    expect(outcome).toMatchObject({ kind: 'path_established' });
    const stored = await store.readSuccessfulExploration(spec.testSpecId, outcome.attemptId);
    expect(stored.trace.successfulPath.map((record) => record.type)).toEqual(['navigate', 'click', 'assert_url']);
    expect(stored.trace.successfulPath.at(-1)).toMatchObject({ result: 'passed' });
    expect(stored.trace.bindings[0]?.selectedNode).toMatchObject({ role: 'link', accessibleName: '200' });
    expect(JSON.stringify(stored.trace)).not.toMatch(/resolvedSpecId|validatedForm|QA_ASSERTION_/);
    await expect(store.readCompilerAttemptV1(spec.testSpecId, outcome.attemptId, 'compiler-none')).rejects.toThrow();
  } finally { await target.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP2C records evaluable false assertion without an exploration QA verdict', async () => {
  const target = await site('<a href="/status_codes/200">200</a>');
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp2c-false-'));
  try {
    const factory = environment(target.port);
    const store = new LocalArtifactStore(root);
    const spec = source(target.url, `${target.url}/status_codes/404`);
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    const outcome = await runAgenticExplorationV1(factory, store, spec, model(),
      { workflowVersion: 'agentic-exploration-v1' });
    expect(outcome).toMatchObject({ kind: 'path_established' });
    const stored = await store.readSuccessfulExploration(spec.testSpecId, outcome.attemptId);
    expect(stored.trace.successfulPath.at(-1)).toMatchObject({ result: 'failed' });
    expect(JSON.stringify(stored)).not.toContain('QA_ASSERTION_FAILED');
  } finally { await target.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP2C binds a snapshot target for read-only false assertion without granting action authority', async () => {
  const target = await site('<a href="/status_codes/200">200</a>');
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp2c-target-assert-'));
  try {
    const factory = environment(target.port), store = new LocalArtifactStore(root);
    const spec = { schemaVersion: '2', testSpecId: 'test-agentic-target-assert',
      sourceInstruction: 'Open and inspect link 200',
      executionProfileRef: { id: 'wp2c-profile', version: '1' },
      startState: { url: 'about:blank' }, steps: [
        { id: 's1', type: 'navigate', sourceText: 'Open', url: `${target.url}/status_codes` },
        { id: 's2', type: 'assert_text', sourceText: 'Check link 200 text',
          target: { description: 'link with the text: "200"' }, expectedText: '201', match: 'exact' },
      ] };
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    const choose: AgenticDecisionModelV3 = { complete: async ({ context }) => JSON.stringify({
      decisionVersion: '3', kind: 'observe_target', operation: 'assert_text',
      ref: /link "200" \[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(context.snapshot)?.[1],
    }) };
    const outcome = await runAgenticExplorationV1(factory, store, spec, choose,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(outcome).toMatchObject({ kind: 'path_established' });
    const stored = await store.readSuccessfulExploration(spec.testSpecId, outcome.attemptId);
    expect(stored.trace.successfulPath.at(-1)).toMatchObject({ type: 'assert_text', result: 'failed' });
    expect(stored.trace.bindings[0]).toMatchObject({ operation: 'assert_text',
      justificationCode: 'assertion_target' });
    expect(JSON.stringify(stored)).not.toContain('QA_ASSERTION_FAILED');
  } finally { await target.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP2C decisions reject unreviewed actions and caps are fixed', () => {
  expect(AgenticDecisionV3Schema.safeParse({ decisionVersion: '3', kind: 'act', ref: 'e1',
    action: 'evaluate', source: 'authored', expectedEffect: 'state_changed' }).success).toBe(false);
  expect(AgenticDecisionV3Schema.safeParse({ decisionVersion: '3', kind: 'act', ref: 'e1',
    action: 'click', source: 'authored', expectedEffect: 'state_changed', selector: '#x' }).success).toBe(false);
  expect(AGENTIC_EXPLORATION_LIMITS).toMatchObject({ decisions: 60, actions: 40,
    snapshots: 80, candidates: 2, recoveries: 2, prerequisites: 6, elapsedMs: 120_000 });
  for (const kind of ['decisions', 'actions', 'snapshots', 'candidates',
    'recoveries', 'prerequisites'] as const) {
    expect(() => assertAgenticBudget(kind, AGENTIC_EXPLORATION_LIMITS[kind] - 1, 0)).not.toThrow();
    expect(() => assertAgenticBudget(kind, AGENTIC_EXPLORATION_LIMITS[kind], 0))
      .toThrow('BUDGET_EXHAUSTED');
  }
  expect(() => assertAgenticBudget('decisions', 0, 120_000)).toThrow('BUDGET_EXHAUSTED');
});

test('WP2C repeated inspection exhausts the decision budget with no successful trace', async () => {
  const target = await site('<a href="/status_codes/200">200</a>');
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp2c-budget-'));
  try {
    const factory = environment(target.port), store = new LocalArtifactStore(root), spec = source(target.url);
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    let calls = 0;
    const inspect: AgenticDecisionModelV3 = { complete: async () => {
      calls++;
      return JSON.stringify({ decisionVersion: '3', kind: 'inspect' });
    } };
    const outcome = await runAgenticExplorationV1(factory, store, spec, inspect,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(outcome).toMatchObject({ kind: 'stopped', status: 'path_unresolved',
      reasonCode: 'BUDGET_EXHAUSTED' });
    expect(calls).toBe(60);
    await expect(store.readSuccessfulExploration(spec.testSpecId, outcome.attemptId)).rejects.toThrow();
  } finally { await target.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP2C permits in-place retry only after an unchanged wrong Save candidate', async () => {
  const target = await site('<button onclick="this.blur()">Save</button><a href="/done">Save</a>');
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp2c-alternative-'));
  try {
    const factory = environment(target.port), store = new LocalArtifactStore(root), spec = saveSource(target.url);
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    let selection = 0, evaluation = 0;
    const choose: AgenticDecisionModelV3 = { complete: async ({ context }) => {
      if (context.stage === 'evaluate') return JSON.stringify({ decisionVersion: '3', kind: 'evaluate',
        verdict: ++evaluation === 1 ? 'try_alternative' : 'achieved' });
      const refs = [...context.snapshot.matchAll(/- (?:button|link) "Save" \[ref=([A-Za-z][A-Za-z0-9_-]*)\]/g)]
        .map((match) => match[1]!);
      return JSON.stringify({ decisionVersion: '3', kind: 'act', ref: refs[selection++]!,
        action: 'click', source: 'authored', expectedEffect: 'state_changed' });
    } };
    const outcome = await runAgenticExplorationV1(factory, store, spec, choose,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(outcome).toMatchObject({ kind: 'path_established' });
    const stored = await store.readSuccessfulExploration(spec.testSpecId, outcome.attemptId);
    expect(stored.trace.successfulPath.filter((record) => record.type === 'click')).toHaveLength(1);
    expect(stored.trace.bindings[0]?.selectedNode.role).toBe('link');
    const branches = await store.readExplorationBranchDiagnostics(spec.testSpecId, outcome.attemptId);
    expect(branches).toHaveLength(1);
    expect(branches[0]).toMatchObject({ branchKind: 'failed_candidate', resultCode: 'no_progress' });
    expect(branches[0]?.sessionId).toBe(stored.trace.sessionId);
  } finally { await target.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP2C reconstructs a known prefix in a fresh protected context after changed-state wrong Save choice', async () => {
  const target = await site('<a href="/wrong">Save</a><a href="/done">Save</a>');
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp2c-recovery-'));
  try {
    const factory = environment(target.port), store = new LocalArtifactStore(root), spec = saveSource(target.url);
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    let selection = 0, evaluation = 0;
    const choose: AgenticDecisionModelV3 = { complete: async ({ context }) => {
      if (context.stage === 'evaluate') return JSON.stringify({ decisionVersion: '3', kind: 'evaluate',
        verdict: ++evaluation === 1 ? 'try_alternative' : 'achieved' });
      const refs = [...context.snapshot.matchAll(/- link "Save" \[ref=([A-Za-z][A-Za-z0-9_-]*)\]/g)]
        .map((match) => match[1]!);
      return JSON.stringify({ decisionVersion: '3', kind: 'act', ref: refs[selection++]!,
        action: 'click', source: 'authored', expectedEffect: 'state_changed' });
    } };
    const outcome = await runAgenticExplorationV1(factory, store, spec, choose,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(outcome).toMatchObject({ kind: 'path_established' });
    const stored = await store.readSuccessfulExploration(spec.testSpecId, outcome.attemptId);
    expect(stored.trace.successfulPath.filter((record) => record.type === 'click')).toHaveLength(1);
    const branches = await store.readExplorationBranchDiagnostics(spec.testSpecId, outcome.attemptId);
    expect(branches).toHaveLength(1);
    expect(branches[0]?.sessionId).not.toBe(stored.trace.sessionId);
    expect(branches[0]?.recoveredToRecordId).toBe(stored.trace.successfulPath[0]?.recordId);
  } finally { await target.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP2C stale binding returns to observation and rebinds without locator quality work', async () => {
  const target = await site('<a href="/status_codes/200">200</a>');
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp2c-stale-'));
  try {
    const factory = environment(target.port), store = new LocalArtifactStore(root), spec = source(target.url);
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    const realOpen = protectedAgenticSessionOpener(factory);
    let staleOnce = true, selectCalls = 0;
    const opener: typeof realOpen = async (...args) => {
      const opened = await realOpen(...args);
      const bind = opened.current.bind.bind(opened.current);
      opened.current.bind = async (...bindingArgs) => {
        if (staleOnce) { staleOnce = false; throw new ExploratoryTargetResolutionError('STALE_BINDING'); }
        return bind(...bindingArgs);
      };
      return opened;
    };
    const choose: AgenticDecisionModelV3 = { complete: async ({ context }) => {
      if (context.stage === 'evaluate') return JSON.stringify({ decisionVersion: '3', kind: 'evaluate', verdict: 'achieved' });
      selectCalls++;
      return JSON.stringify({ decisionVersion: '3', kind: 'act',
        ref: /link "200" \[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(context.snapshot)?.[1],
        action: 'click', source: 'authored', expectedEffect: 'state_changed' });
    } };
    const outcome = await runAgenticExplorationV1(factory, store, spec, choose,
      { workflowVersion: 'agentic-exploration-v1', openSession: opener });
    expect(outcome).toMatchObject({ kind: 'path_established', cleanup: 'verified' });
    expect(selectCalls).toBe(2);
    const branches = await store.readExplorationBranchDiagnostics(spec.testSpecId, outcome.attemptId);
    expect(branches[0]).toMatchObject({ resultCode: 'stale_ref' });
  } finally { await target.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP2C repeated candidate without new semantic evidence stops, with no successful trace', async () => {
  const target = await site('<a href="/wrong">Save</a><a href="/done">Save</a>');
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp2c-repeat-'));
  try {
    const factory = environment(target.port), store = new LocalArtifactStore(root), spec = saveSource(target.url);
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    const choose: AgenticDecisionModelV3 = { complete: async ({ context }) =>
      JSON.stringify(context.stage === 'evaluate'
        ? { decisionVersion: '3', kind: 'evaluate', verdict: 'try_alternative' }
        : { decisionVersion: '3', kind: 'act',
          ref: /link "Save" \[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(context.snapshot)?.[1],
          action: 'click', source: 'authored', expectedEffect: 'state_changed' }) };
    const outcome = await runAgenticExplorationV1(factory, store, spec, choose,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(outcome).toMatchObject({ kind: 'stopped', status: 'path_unresolved',
      reasonCode: 'TARGET_NOT_FOUND' });
    await expect(store.readSuccessfulExploration(spec.testSpecId, outcome.attemptId)).rejects.toThrow();
  } finally { await target.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP2C preserves a justified discovered prerequisite before the authored target', async () => {
  const target = await site('<button onclick="document.getElementById(\'go\').hidden=false">Open menu</button>' +
    '<a id="go" hidden href="/done">Save</a>');
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp2c-prerequisite-'));
  try {
    const factory = environment(target.port), store = new LocalArtifactStore(root);
    const spec = { ...saveSource(target.url), testSpecId: 'test-agentic-prerequisite',
      steps: [saveSource(target.url).steps[0],
        { id: 's2', type: 'click', sourceText: 'Open menu then click Save',
          target: { description: 'Save control' } }, saveSource(target.url).steps[2]] };
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    let selected = 0;
    const choose: AgenticDecisionModelV3 = { complete: async ({ context }) => {
      if (context.stage === 'evaluate') return JSON.stringify({ decisionVersion: '3', kind: 'evaluate', verdict: 'achieved' });
      const prerequisite = selected++ === 0;
      return JSON.stringify({ decisionVersion: '3', kind: 'act',
        ref: new RegExp(`${prerequisite ? 'button "Open menu"' : 'link "Save"'} \\[ref=([A-Za-z][A-Za-z0-9_-]*)\\]`)
          .exec(context.snapshot)?.[1],
        action: 'click', source: prerequisite ? 'discovered_prerequisite' : 'authored',
        ...(prerequisite ? { prerequisiteReasonCode: 'expose_target' } : {}),
        expectedEffect: 'state_changed' });
    } };
    const outcome = await runAgenticExplorationV1(factory, store, spec, choose,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(outcome).toMatchObject({ kind: 'path_established' });
    const stored = await store.readSuccessfulExploration(spec.testSpecId, outcome.attemptId);
    expect(stored.trace.successfulPath.map((record) => [record.type, record.source]))
      .toEqual([['navigate', 'authored'], ['click', 'discoveredPrerequisite'],
        ['click', 'authored'], ['assert_url', 'authored']]);
    expect(stored.trace.successfulPath[1]?.prerequisiteReasonCode).toBe('expose_target');
  } finally { await target.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP2C stops when a fresh recovery context cannot verify the known prefix', async () => {
  let visits = 0;
  const target = await site((pathname) => pathname === '/status_codes'
    ? `<a href="/wrong">Save</a><a href="/done">Save</a><p>${++visits === 1 ? 'original' : 'changed'}</p>`
    : '<p>branch</p>');
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp2c-unsafe-recovery-'));
  try {
    const factory = environment(target.port), store = new LocalArtifactStore(root), spec = saveSource(target.url);
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    const choose: AgenticDecisionModelV3 = { complete: async ({ context }) =>
      JSON.stringify(context.stage === 'evaluate'
        ? { decisionVersion: '3', kind: 'evaluate', verdict: 'try_alternative' }
        : { decisionVersion: '3', kind: 'act',
          ref: /link "Save" \[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(context.snapshot)?.[1],
          action: 'click', source: 'authored', expectedEffect: 'state_changed' }) };
    const outcome = await runAgenticExplorationV1(factory, store, spec, choose,
      { workflowVersion: 'agentic-exploration-v1' });
    expect(outcome).toMatchObject({ kind: 'stopped', status: 'path_unresolved',
      reasonCode: 'TARGET_NOT_FOUND', cleanup: 'verified' });
    await expect(store.readSuccessfulExploration(spec.testSpecId, outcome.attemptId)).rejects.toThrow();
  } finally { await target.close(); await rm(root, { recursive: true, force: true }); }
});

test('WP2C cancellation has a typed stop and leaves no successful trace', async () => {
  const target = await site('<a href="/status_codes/200">200</a>');
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-wp2c-cancel-'));
  try {
    const factory = environment(target.port), store = new LocalArtifactStore(root), spec = source(target.url);
    await store.createJob(spec, factory.catalog.resolve(spec.executionProfileRef));
    const abort = new AbortController(); abort.abort();
    const outcome = await runAgenticExplorationV1(factory, store, spec, model(),
      { workflowVersion: 'agentic-exploration-v1', signal: abort.signal });
    expect(outcome).toMatchObject({ kind: 'stopped', status: 'cancelled', reasonCode: 'CANCELLED',
      cleanup: 'verified' });
    await expect(store.readSuccessfulExploration(spec.testSpecId, outcome.attemptId)).rejects.toThrow();
  } finally { await target.close(); await rm(root, { recursive: true, force: true }); }
});
