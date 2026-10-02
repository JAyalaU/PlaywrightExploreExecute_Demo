import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  handoffTask,
  type InterpretationModel,
  type InterpretationRequest,
  type StepDecisionModel,
} from '../app/interpretation/index.js';
import { LocalArtifactStore, readStoredJobReport } from '../app/evidence/index.js';
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
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function serveSequence(first: string, later: string) {
  let hits = 0;
  return serveFromHandler((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(++hits === 1 ? first : later);
  });
}

async function serveFromHandler(handler: http.RequestListener) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  return {
    url: `http://127.0.0.1:${address.port}/`, port: address.port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function factory(port: number, viewportWidth = 900): ProtectedContextFactory {
  return new ProtectedContextFactory(new ProfileCatalog([{
    id: 'm8-desktop', version: '1', browser: 'chromium', viewport: { width: viewportWidth, height: 600 },
    locale: 'en-US', timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: { default: 3000 } },
    networkPolicyRef: { id: 'm8-policy', version: '1' },
  }], [{ id: 'm8-policy', version: '1', destinations: [{ host: '127.0.0.1', ports: [port], addresses: ['127.0.0.1'] }] }]));
}

function request(testSpecId: string, sourceInstruction: string): InterpretationRequest {
  return {
    testSpecId, sourceInstruction,
    executionProfileRef: { id: 'm8-desktop', version: '1' }, startState: { url: 'about:blank' },
  };
}

const noBinary = {
  finalScreenshot: false, failureScreenshot: false, failureTrace: false,
  failureVideo: false, sensitiveBinaryApproved: false,
};

function ref(snapshot: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}[^\\n]*\\[ref=([A-Za-z0-9_-]+)\\]`, 'i').exec(snapshot)?.[1]
    ?? new RegExp(`\\[ref=([A-Za-z0-9_-]+)\\][^\\n]*${escaped}`, 'i').exec(snapshot)?.[1];
}

test('M8-A runs the complete vocabulary through interpretation, MCP resolution, accepted replay, and stored evidence', async () => {
  const fixture = await serve(`
    <label>Name <input aria-label="Name"></label>
    <label>Role <select aria-label="Role"><option>User</option><option>Admin</option></select></label>
    <button aria-label="Menu" onclick="document.getElementById('menu').hidden=false">Open menu</button>
    <div id="menu" role="menu" hidden><button role="menuitem" onclick="document.getElementById('status').textContent='Admin selected'">Admin</button></div>
    <p id="status" role="status" aria-label="Selection status">Waiting</p>
  `);
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-m8-system-'));
  const protectedFactory = factory(fixture.port);
  const store = new LocalArtifactStore(directory);
  const instruction = [
    `Go to ${fixture.url}.`, 'Fill Name with Jorge.', 'Select Admin for Role.',
    'Select Admin from the menu.', 'Wait for selection status to appear.',
    'Wait until Role is Admin.', `Wait for URL ${fixture.url}.`,
    'Assert selection status is visible.', 'Assert selection status text is exact.',
    'Assert Role is Admin.', `Assert URL is ${fixture.url}.`,
  ].join(' ');
  const source = request('m8-system', instruction);
  const authored = [
    { id: 's1', type: 'navigate', sourceText: `Go to ${fixture.url}.`, url: fixture.url },
    { id: 's2', type: 'fill', sourceText: 'Fill Name with Jorge.', target: { description: 'Name' }, value: 'Jorge' },
    { id: 's3', type: 'select_option', sourceText: 'Select Admin for Role.', target: { description: 'Role' }, value: 'Admin' },
    { id: 's4', type: 'click', sourceText: 'Select Admin from the menu.', target: { description: 'Admin', scope: [{ kind: 'menu', description: 'menu' }] } },
    { id: 's5', type: 'wait_for', sourceText: 'Wait for selection status to appear.', condition: { type: 'target_visible', target: { description: 'Selection status' } }, timeoutPolicyRef: 'default' },
    { id: 's6', type: 'wait_for', sourceText: 'Wait until Role is Admin.', condition: { type: 'target_value', target: { description: 'Role' }, expectedValue: 'Admin' }, timeoutPolicyRef: 'default' },
    { id: 's7', type: 'wait_for', sourceText: `Wait for URL ${fixture.url}.`, condition: { type: 'url_exact', url: fixture.url }, timeoutPolicyRef: 'default' },
    { id: 's8', type: 'assert_visible', sourceText: 'Assert selection status is visible.', target: { description: 'Selection status' } },
    { id: 's9', type: 'assert_text', sourceText: 'Assert selection status text is exact.', target: { description: 'Selection status' }, expectedText: 'Admin selected', match: 'exact' },
    { id: 's10', type: 'assert_value', sourceText: 'Assert Role is Admin.', target: { description: 'Role' }, expectedValue: 'Admin' },
    { id: 's11', type: 'assert_url', sourceText: `Assert URL is ${fixture.url}.`, expectedUrl: fixture.url, match: 'exact' },
  ];
  const interpreter: InterpretationModel = { complete: async () => JSON.stringify({ kind: 'test_spec', steps: authored }) };
  const decisionModel: StepDecisionModel = { complete: async ({ context }) => {
    const { authoredStep: step, snapshot } = context;
    if (step.id === 's4') {
      const admin = ref(snapshot, 'Admin');
      if (admin && /menuitem "Admin"/i.test(snapshot)) return JSON.stringify({ kind: 'target', ref: admin, element: 'Admin menu item' });
      const menu = ref(snapshot, 'Menu');
      return JSON.stringify(menu
        ? { kind: 'prerequisite', ref: menu, element: 'Menu button', reason: 'Expose Admin menu item', action: 'click' }
        : { kind: 'unresolved', reason: 'TARGET_NOT_FOUND' });
    }
    const label = step.id === 's2' ? 'Name' : step.id === 's3' || step.id === 's6' || step.id === 's10' ? 'Role' : 'Selection status';
    const chosen = ref(snapshot, label);
    return JSON.stringify(chosen
      ? { kind: 'target', ref: chosen, element: label }
      : { kind: 'unresolved', reason: 'TARGET_NOT_FOUND' });
  } };
  try {
    const outcome = await handoffTask(protectedFactory, store, source, interpreter, decisionModel, { evidencePolicy: noBinary });
    expect(outcome.kind, outcome.kind === 'stopped' ? `${outcome.result.status}: ${outcome.result.reason}` : '').toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.replay).toHaveLength(2);
    expect(outcome.replay[0].executionRunId).not.toBe(outcome.replay[1].executionRunId);
    for (const run of outcome.replay) {
      expect(run.outcomes.every((item) => item.status === 'OPERATION_SUCCEEDED' || item.status === 'QA_ASSERTION_PASSED')).toBe(true);
    }
    const report = await readStoredJobReport(store, source.testSpecId);
    expect(report.interpretation?.result.status).toBe('OPERATION_SUCCEEDED');
    expect(report.attempts[0]?.status).toBe('resolved');
    expect(report.runs).toHaveLength(2);
    expect(report.resolvedSpecs[0]?.executionSteps.some((step) => step.source === 'discoveredPrerequisite')).toBe(true);

    // A profile with the same ref but altered effective settings cannot replay this accepted spec.
    await expect((await import('../app/evidence/index.js')).executeAndStoreRun(
      factory(fixture.port, 1000), store, source.testSpecId, outcome.resolvedSpecId, 'm8-profile-mismatch', noBinary,
      { expectedProfile: outcome.replay[0].effectiveProfile },
    )).rejects.toThrow('new profile version');
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('M8-A keeps frame replay declarative and records a denied navigation as a typed exploration failure', async () => {
  const fixture = await serve('<iframe title="payment frame" srcdoc="<button>Submit</button>"></iframe>');
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-m8-frame-'));
  const store = new LocalArtifactStore(directory);
  const source = request('m8-frame', `Go to ${fixture.url}. Select Submit in payment frame.`);
  const interpreter: InterpretationModel = { complete: async () => JSON.stringify({ kind: 'test_spec', steps: [
    { id: 's1', type: 'navigate', sourceText: `Go to ${fixture.url}.`, url: fixture.url },
    { id: 's2', type: 'click', sourceText: 'Select Submit in payment frame.', target: { description: 'Submit', scope: [{ kind: 'frame', description: 'payment frame' }] } },
  ] }) };
  const decisionModel: StepDecisionModel = { complete: async ({ context }) => {
    const chosen = ref(context.snapshot, 'Submit');
    return JSON.stringify(chosen ? { kind: 'target', ref: chosen, element: 'Submit in payment frame' }
      : { kind: 'unresolved', reason: 'TARGET_NOT_FOUND' });
  } };
  try {
    const outcome = await handoffTask(factory(fixture.port), store, source, interpreter, decisionModel, { evidencePolicy: noBinary });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    const resolved = (await readStoredJobReport(store, source.testSpecId)).resolvedSpecs[0];
    expect(resolved?.executionSteps[1] && 'locator' in resolved.executionSteps[1] && resolved.executionSteps[1].locator.validatedForm.type).toBe('frame');
    expect(outcome.replay.flatMap((run) => run.outcomes).every((item) => item.status === 'OPERATION_SUCCEEDED')).toBe(true);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('M8-A retains a real navigation failure as MCP evidence rather than a QA assertion', async () => {
  const allowedPort = 6553;
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-m8-denied-'));
  const store = new LocalArtifactStore(directory);
  const deniedUrl = 'http://127.0.0.1:6554/';
  const source = request('m8-network-denied', `Go to ${deniedUrl}.`);
  const interpreter: InterpretationModel = { complete: async () => JSON.stringify({ kind: 'test_spec', steps: [
    { id: 's1', type: 'navigate', sourceText: `Go to ${deniedUrl}.`, url: deniedUrl },
  ] }) };
  const unused: StepDecisionModel = { complete: async () => { throw new Error('No target decision expected'); } };
  try {
    const outcome = await handoffTask(factory(allowedPort), store, source, interpreter, unused, { evidencePolicy: noBinary });
    expect(outcome.kind).toBe('stopped');
    if (outcome.kind !== 'stopped') return;
    expect(outcome.result).toMatchObject({ phase: 'exploration', status: 'MCP_EXPLORATION_FAILED' });
    expect(outcome.result.reason).not.toContain('NETWORK_POLICY_DENIED');
    const attempt = await store.readAttempt(source.testSpecId, outcome.attemptId!);
    expect(attempt.status).toBe('unresolved');
    expect(attempt.evidenceRefs.length).toBeGreaterThan(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('M8-A retains Scenario 8 quality evidence without accepting its glyph locator', async () => {
  const fixture = await serve('<span onclick="document.body.append(\' opened\')">&#9776;</span>');
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-m8-glyph-'));
  const store = new LocalArtifactStore(directory);
  const source = request('m8-glyph', `Go to ${fixture.url}. Select the menu icon.`);
  const interpreter: InterpretationModel = { complete: async () => JSON.stringify({ kind: 'test_spec', steps: [
    { id: 's1', type: 'navigate', sourceText: `Go to ${fixture.url}.`, url: fixture.url },
    { id: 's2', type: 'click', sourceText: 'Select the menu icon.', target: { description: 'menu icon' } },
  ] }) };
  const decisionModel: StepDecisionModel = { complete: async ({ context }) => {
    const chosen = ref(context.snapshot, '☰');
    return JSON.stringify(chosen ? { kind: 'target', ref: chosen, element: 'menu icon' }
      : { kind: 'unresolved', reason: 'TARGET_NOT_FOUND' });
  } };
  try {
    const outcome = await handoffTask(factory(fixture.port), store, source, interpreter, decisionModel, { evidencePolicy: noBinary });
    expect(outcome.kind).toBe('stopped');
    if (outcome.kind !== 'stopped') return;
    expect(outcome.result).toMatchObject({ phase: 'locator', status: 'LOCATOR_QUALITY_FAILED' });
    expect((await store.readAttempt(source.testSpecId, outcome.attemptId!)).evidenceRefs.length).toBeGreaterThan(0);
    expect(await store.listIds(source.testSpecId, 'resolved')).toEqual([]);
    expect(await store.listIds(source.testSpecId, 'runs')).toEqual([]);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('M8-A classifies a changed prerequisite locator as binding failure without a hidden re-exploration', async () => {
  const fixture = await serveSequence(
    '<button aria-label="Menu" onclick="document.getElementById(\'admin\').hidden=false">Open</button><button id="admin" hidden>Admin</button>',
    '<button aria-label="Options" onclick="document.getElementById(\'admin\').hidden=false">Open</button><button id="admin" hidden>Admin</button>',
  );
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-m8-stale-'));
  const store = new LocalArtifactStore(directory);
  const source = request('m8-stale', `Go to ${fixture.url}. Select Admin from Menu.`);
  const interpreter: InterpretationModel = { complete: async () => JSON.stringify({ kind: 'test_spec', steps: [
    { id: 's1', type: 'navigate', sourceText: `Go to ${fixture.url}.`, url: fixture.url },
    { id: 's2', type: 'click', sourceText: 'Select Admin from Menu.', target: { description: 'Admin', scope: [{ kind: 'menu', description: 'Menu' }] } },
  ] }) };
  let decisionCalls = 0;
  const decisionModel: StepDecisionModel = { complete: async ({ context }) => {
    decisionCalls++;
    const admin = ref(context.snapshot, 'Admin');
    if (admin && /button "Admin"/i.test(context.snapshot)) return JSON.stringify({ kind: 'target', ref: admin, element: 'Admin' });
    const menu = ref(context.snapshot, 'Menu');
    return JSON.stringify(menu
      ? { kind: 'prerequisite', ref: menu, element: 'Menu', reason: 'Expose Admin', action: 'click' }
      : { kind: 'unresolved', reason: 'TARGET_NOT_FOUND' });
  } };
  try {
    const outcome = await handoffTask(factory(fixture.port), store, source, interpreter, decisionModel, { evidencePolicy: noBinary });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(decisionCalls).toBe(2);
    expect(outcome.replay.map((run) => run.outcomes.map((item) => [item.status, item.reason]))).toEqual([
      [['OPERATION_SUCCEEDED', undefined], ['LOCATOR_BINDING_FAILED', 'NO_MATCH'], ['NOT_RUN', 'DEPENDENCY_FAILED']],
      [['OPERATION_SUCCEEDED', undefined], ['LOCATOR_BINDING_FAILED', 'NO_MATCH'], ['NOT_RUN', 'DEPENDENCY_FAILED']],
    ]);
    expect(decisionCalls).toBe(2);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});
