import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { handoffTask, type InterpretationModel, type InterpretationRequest, type StepDecisionModel } from '../app/interpretation/index.js';
import { executeAndStoreRun, LocalArtifactStore, readStoredJobReport } from '../app/evidence/index.js';
import { ProfileCatalog, ProtectedContextFactory } from '../app/profile/index.js';

async function serve(html: string) {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(html);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  return {
    url: `http://127.0.0.1:${address.port}/`, port: address.port,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

function factory(port: number): ProtectedContextFactory {
  return new ProtectedContextFactory(new ProfileCatalog([{
    id: 'm7c-desktop', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 },
    locale: 'en-US', timeoutPolicy: { actionMs: 3000, navigationMs: 3000, waits: { default: 3000 } },
    networkPolicyRef: { id: 'm7c-policy', version: '1' },
  }], [{ id: 'm7c-policy', version: '1', destinations: [{ host: '127.0.0.1', ports: [port], addresses: ['127.0.0.1'] }] }]));
}

function request(testSpecId: string, instruction: string): InterpretationRequest {
  return {
    testSpecId, sourceInstruction: instruction,
    executionProfileRef: { id: 'm7c-desktop', version: '1' },
    startState: { url: 'about:blank' },
  };
}

const noBinary = {
  finalScreenshot: false, failureScreenshot: false, failureTrace: false,
  failureVideo: false, sensitiveBinaryApproved: false,
};

test('M7-C persists interpretation, prerequisite, locator acceptance and deterministic runs', async () => {
  const fixture = await serve(`
    <button aria-label="Menu" onclick="document.getElementById('menu').hidden=false">Open</button>
    <div id="menu" role="menu" hidden><button role="menuitem">Admin</button></div>
  `);
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-m7c-success-'));
  const protectedFactory = factory(fixture.port);
  const store = new LocalArtifactStore(directory);
  const source = request('interpretations', `Go to ${fixture.url}. Select Admin from the menu. Assert the URL is ${fixture.url}.`);
  const authored = [
    { id: 's1', type: 'navigate', sourceText: `Go to ${fixture.url}`, url: fixture.url },
    { id: 's2', type: 'click', sourceText: 'Select Admin from the menu',
      target: { description: 'Admin', scope: [{ kind: 'menu', description: 'menu' }] } },
    { id: 's3', type: 'assert_url', sourceText: `Assert the URL is ${fixture.url}`,
      expectedUrl: fixture.url, match: 'exact' },
  ];
  let interpretationCalls = 0;
  let decisionCalls = 0;
  const interpret: InterpretationModel = { complete: async () => {
    interpretationCalls++;
    return JSON.stringify({ kind: 'test_spec', steps: authored });
  } };
  const decide: StepDecisionModel = { complete: async ({ context }) => {
    decisionCalls++;
    const admin = /menuitem "Admin" \[ref=(e\d+)\]/.exec(context.snapshot)?.[1];
    if (admin) return JSON.stringify({ kind: 'target', ref: admin, element: 'Admin menu item' });
    const menu = /button "Menu" \[ref=(e\d+)\]/.exec(context.snapshot)?.[1];
    return JSON.stringify(menu
      ? { kind: 'prerequisite', ref: menu, element: 'Menu button', reason: 'Expose Admin', action: 'click' }
      : { kind: 'unresolved', reason: 'TARGET_NOT_FOUND' });
  } };
  try {
    const outcome = await handoffTask(protectedFactory, store, source, interpret, decide);
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(interpretationCalls).toBe(1);
    expect(decisionCalls).toBe(2);
    expect(outcome.replay.map((run) => run.outcomes.map((result) => result.status)),
      JSON.stringify((await store.readResolved(source.testSpecId, outcome.resolvedSpecId)).executionSteps.map((step) => ({ source: step.source, type: step.type, originStepId: step.originStepId })))).toEqual([
      ['OPERATION_SUCCEEDED', 'OPERATION_SUCCEEDED', 'OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED'],
      ['OPERATION_SUCCEEDED', 'OPERATION_SUCCEEDED', 'OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED'],
    ]);
    const report = await readStoredJobReport(new LocalArtifactStore(directory), source.testSpecId);
    expect(report.interpretation?.result).toMatchObject({ phase: 'interpretation', status: 'OPERATION_SUCCEEDED' });
    expect(report.attempts).toHaveLength(1);
    expect(report.resolvedSpecs[0]?.executionSteps.map((step) => step.source)).toEqual([
      'authored', 'discoveredPrerequisite', 'authored', 'authored',
    ]);
    expect(report.resolvedSpecs[0]?.executionSteps.filter((step) => 'locator' in step)
      .every((step) => 'locator' in step && step.locator.quality.status === 'accepted')).toBe(true);
    expect(report.runs).toHaveLength(2);

    // A persisted spec remains runnable after both model-driven stages finish.
    const independent = await executeAndStoreRun(protectedFactory, store, source.testSpecId,
      outcome.resolvedSpecId, 'run-independent', noBinary);
    expect(independent.outcomes.at(-1)?.status).toBe('QA_ASSERTION_PASSED');
    expect(interpretationCalls).toBe(1);
    expect(report.runs.map((run) => run.executionRunId)).not.toContain(independent.executionRunId);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('M7-C persists ambiguity and unsupported outcomes without opening a browser or job', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-m7c-reject-'));
  const store = new LocalArtifactStore(directory);
  const protectedFactory = factory(4173);
  let stepCalls = 0;
  const unused: StepDecisionModel = { complete: async () => { stepCalls++; throw new Error('unexpected browser decision'); } };
  try {
    for (const [kind, status, reason] of [
      ['ambiguous', 'AMBIGUOUS_INSTRUCTION', 'MATERIAL_AMBIGUITY'],
      ['unsupported', 'INTERPRETATION_FAILED', 'UNSUPPORTED_REQUEST'],
    ] as const) {
      const source = request(`m7c-${kind}`, 'Select something unclear');
      const model: InterpretationModel = { complete: async () => JSON.stringify({ kind, reason: 'Cannot identify a supported target' }) };
      const outcome = await handoffTask(protectedFactory, store, source, model, unused);
      expect(outcome.kind).toBe('stopped');
      if (outcome.kind === 'stopped') expect(outcome.result).toMatchObject({ phase: 'interpretation', status, reason });
      const record = await new LocalArtifactStore(directory).readInterpretation(source.testSpecId);
      expect(record).toMatchObject({ outcome: 'rejected', result: { phase: 'interpretation', status, reason } });
      await expect(store.readJob(source.testSpecId)).rejects.toThrow();
    }
    expect(stepCalls).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('M7-C keeps locator quality failure separate from execution and retains attempt evidence', async () => {
  const fixture = await serve('<span onclick="document.body.append(\' opened\')">&#9776;</span>');
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-m7c-glyph-'));
  const store = new LocalArtifactStore(directory);
  const source = request('m7c-glyph', `Go to ${fixture.url}. Select the menu icon.`);
  const interpret: InterpretationModel = { complete: async () => JSON.stringify({ kind: 'test_spec', steps: [
    { id: 's1', type: 'navigate', sourceText: `Go to ${fixture.url}`, url: fixture.url },
    { id: 's2', type: 'click', sourceText: 'Select the menu icon', target: { description: 'menu icon' } },
  ] }) };
  const decide: StepDecisionModel = { complete: async ({ context }) => {
    const ref = /\[ref=(e\d+)\]:\s*\u2630/.exec(context.snapshot)?.[1];
    return JSON.stringify(ref ? { kind: 'target', ref, element: 'menu icon' }
      : { kind: 'unresolved', reason: 'TARGET_NOT_FOUND' });
  } };
  try {
    const outcome = await handoffTask(factory(fixture.port), store, source, interpret, decide);
    expect(outcome.kind).toBe('stopped');
    if (outcome.kind !== 'stopped') return;
    expect(outcome.result).toMatchObject({ phase: 'locator', status: 'LOCATOR_QUALITY_FAILED' });
    expect(outcome.attemptId).toBeTruthy();
    const attempt = await store.readAttempt(source.testSpecId, outcome.attemptId!);
    expect(attempt.status).toBe('unresolved');
    expect(attempt.evidenceRefs.length).toBeGreaterThan(0);
    expect(await store.listIds(source.testSpecId, 'resolved')).toEqual([]);
    expect(await store.listIds(source.testSpecId, 'runs')).toEqual([]);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('M7-C stores a typed exploration stop without a runnable spec', async () => {
  const fixture = await serve('<button>Save</button>');
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-m7c-unresolved-'));
  const store = new LocalArtifactStore(directory);
  const source = request('m7c-unresolved', `Go to ${fixture.url}. Select Save.`);
  const interpret: InterpretationModel = { complete: async () => JSON.stringify({ kind: 'test_spec', steps: [
    { id: 's1', type: 'navigate', sourceText: `Go to ${fixture.url}`, url: fixture.url },
    { id: 's2', type: 'click', sourceText: 'Select Save', target: { description: 'Save' } },
  ] }) };
  const decide: StepDecisionModel = { complete: async () =>
    JSON.stringify({ kind: 'unresolved', reason: 'INSUFFICIENT_CONTEXT' }) };
  try {
    const outcome = await handoffTask(factory(fixture.port), store, source, interpret, decide);
    expect(outcome.kind).toBe('stopped');
    if (outcome.kind !== 'stopped') return;
    expect(outcome.result).toMatchObject({ phase: 'exploration', status: 'TARGET_RESOLUTION_FAILED', reason: 'INSUFFICIENT_CONTEXT' });
    expect((await store.readAttempt(source.testSpecId, outcome.attemptId!)).status).toBe('unresolved');
    expect(await store.listIds(source.testSpecId, 'resolved')).toEqual([]);
    expect(await store.listIds(source.testSpecId, 'runs')).toEqual([]);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('M7-C preserves evaluated QA failure as a runtime result', async () => {
  const fixture = await serve('<p>Ready</p>');
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-m7c-qa-fail-'));
  const store = new LocalArtifactStore(directory);
  const source = request('m7c-qa-fail', `Go to ${fixture.url}. Assert URL is ${fixture.url}other.`);
  const interpret: InterpretationModel = { complete: async () => JSON.stringify({ kind: 'test_spec', steps: [
    { id: 's1', type: 'navigate', sourceText: `Go to ${fixture.url}`, url: fixture.url },
    { id: 's2', type: 'assert_url', sourceText: `Assert URL is ${fixture.url}other`,
      expectedUrl: `${fixture.url}other`, match: 'exact' },
  ] }) };
  const unused: StepDecisionModel = { complete: async () => { throw new Error('No target decision expected'); } };
  try {
    const outcome = await handoffTask(factory(fixture.port), store, source, interpret, unused);
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.replay.map((run) => run.outcomes.at(-1)?.status)).toEqual(['QA_ASSERTION_FAILED', 'QA_ASSERTION_FAILED']);
    const report = await readStoredJobReport(new LocalArtifactStore(directory), source.testSpecId);
    expect(report.interpretation?.result.status).toBe('OPERATION_SUCCEEDED');
    expect(report.attempts[0]?.status).toBe('resolved');
    expect(report.runs.map((run) => run.outcomes.at(-1)?.reason)).toEqual(['URL_MISMATCH', 'URL_MISMATCH']);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});
