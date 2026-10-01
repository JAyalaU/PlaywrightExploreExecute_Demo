import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CurrentStateExploration, McpExplorationSession, SuccessfulTraceAssemblerV4,
  TrustedObservationSessionV1, compileSuccessfulTraceV4 } from '../app/exploration/index.js';
import { AcceptedResolvedTestSpecV8, LocalArtifactStore } from '../app/evidence/index.js';
import { ProfileCatalog, ProtectedContextFactory } from '../app/profile/index.js';
import { GoalDirectedVerificationControllerV1, type AgenticVerificationModelV4 } from
  '../app/interpretation/verification-strategy.js';
import { executeResolvedTestSpecV6, executeResolvedTestSpecV7,
  executeResolvedTestSpecV8 } from '../app/runner/index.js';

const action = (id: string, clause: string, name: string, role: 'link' | 'button' | undefined) => {
  const nameStart = clause.indexOf(name);
  const roleLiteral = role === 'link' && clause.toLowerCase().includes('hyperlink') ?
    'hyperlink' : role;
  const roleStart = roleLiteral ? clause.toLowerCase().indexOf(roleLiteral) : -1;
  return { id, type: 'click', sourceText: clause, target: { description: name },
    actionTargetIntent: { intentVersion: '1', sourceStepId: id, operation: 'click',
      role: role ? { kind: 'explicit', value: role,
        sourceSpan: { start: roleStart, end: roleStart + roleLiteral!.length } } :
        { kind: 'unspecified' },
      accessibleName: name, exact: true,
      nameSourceSpan: { start: nameStart, end: nameStart + name.length } } };
};
const goal = (id: string, clause: string, name: string, expected: 'present' | 'absent') =>
  ({ id, type: 'verification_goal', sourceText: clause, instruction: clause,
    subject: { role: 'button', accessibleName: name }, intent: { kind: 'presence', expected } });
const ref = (snapshot: string, role: string, name: string) => {
  const found = [...snapshot.matchAll(/(link|button) "([^"]+)" \[ref=([A-Za-z][A-Za-z0-9_-]*)\]/g)]
    .find((match) => match[1] === role && match[2] === name);
  if (!found) throw new Error(`Missing ${role}/${name} in current snapshot`);
  return found[3]!;
};

async function site(initial: (route: string) => string) {
  let render = initial;
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(render(request.url ?? '/'));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  const url = `http://127.0.0.1:${address.port}/`;
  const factory = new ProtectedContextFactory(new ProfileCatalog([{
    id: 'identity-wp4a', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 },
    locale: 'en-US', timeoutPolicy: { actionMs: 1500, navigationMs: 3000,
      waits: { default: 1500 } }, networkPolicyRef: { id: 'identity-policy', version: '1' },
  }], [{ id: 'identity-policy', version: '1', destinations: [{ host: '127.0.0.1',
    ports: [address.port], addresses: ['127.0.0.1'] }] }]));
  return { url, factory, change: (next: typeof render) => { render = next; },
    close: async () => { server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done())); } };
}

const addRemove = (route: string) => route === '/elements' ?
  `<button onclick="document.body.insertAdjacentHTML('beforeend', '<button>Delete</button>')">Add Element</button>` :
  '<a href="/elements">Add/Remove Elements</a>';

async function compiledAddRemove(linkClause = 'Click the Add/Remove Elements link.',
  linkRole?: 'link') {
  const structuredRole = arguments.length < 2 &&
    linkClause === 'Click the Add/Remove Elements link.' ? 'link' : linkRole;
  const fixture = await site(addRemove);
  const root = await mkdtemp(path.join(tmpdir(), 'identity-wp4a-'));
  const steps = [
    { id: 'go', type: 'navigate', sourceText: `Go to ${fixture.url}.`, url: fixture.url },
    action('link', linkClause, 'Add/Remove Elements', structuredRole),
    goal('add-goal', 'Confirm Add Element button exists.', 'Add Element', 'present'),
    goal('absence', 'Confirm Delete button does not exist.', 'Delete', 'absent'),
    action('add', 'Click the Add Element button.', 'Add Element', 'button'),
    goal('presence', 'Confirm Delete button exists.', 'Delete', 'present'),
  ];
  const source = { schemaVersion: '5', testSpecId: 'identity-add-remove-v8',
    sourceInstruction: steps.map((step) => step.sourceText).join(' '),
    executionProfileRef: { id: 'identity-wp4a', version: '1' },
    startState: { url: fixture.url }, steps };
  const profile = fixture.factory.catalog.resolve(source.executionProfileRef);
  const mcp = await McpExplorationSession.open(fixture.factory,
    source.executionProfileRef, profile, 'attempt-identity-v8');
  try {
    await mcp.navigate(fixture.url);
    const current = new CurrentStateExploration(mcp, source, 'attempt-identity-v8');
    const store = new LocalArtifactStore(root);
    await store.createJob(source, profile);
    const start = await current.observe();
    const observations = new TrustedObservationSessionV1(mcp, current);
    const predicates = [
      { name: 'Add Element', operator: 'greater_than', expected: 0 },
      { name: 'Delete', operator: 'equal', expected: 0 },
      { name: 'Delete', operator: 'greater_than', expected: 0 },
    ];
    let decision = 0;
    const model: AgenticVerificationModelV4 = { complete: async ({ context }) => {
      const selected = predicates[Math.floor(decision / 2)]!;
      const next = decision++ % 2 === 0 ? { decisionVersion: '4', kind: 'observe',
        request: { kind: 'semantic_query', query: { role: 'button', name: selected.name,
          frame: { kind: 'main' } } } } : { decisionVersion: '4', kind: 'conclude',
            conclusion: 'satisfied', comparison: { kind: 'count',
              observationId: context.observations.at(-1)!.observationId,
              operator: selected.operator, expected: selected.expected } };
      return JSON.stringify(next);
    } };
    const controller = new GoalDirectedVerificationControllerV1(observations, current, model);
    const assembler = new SuccessfulTraceAssemblerV4(source, { current, observations,
      strategyJournal: () => controller.successfulStrategies,
      startedAt: new Date().toISOString(), startStateDigest: start.stateDigest,
      profileFingerprint: profile.fingerprint, signal: new AbortController().signal,
      completionState: () => 'running' });
    await mcp.navigate(fixture.url); current.invalidate();
    let view = await current.observe();
    await assembler.appendObservedRecord({ type: 'navigate', recordId: 'record-go', sequence: 1,
      source: 'authored', originStepId: 'go', preStateDigest: start.stateDigest,
      postStateDigest: view.stateDigest, observationDigest: view.snapshotDigest,
      url: fixture.url, result: 'completed' });
    await current.act(await current.bind('link', 'click',
      ref(view.snapshot, 'link', 'Add/Remove Elements')));
    assembler.appendCurrentStateAction(current.successfulActions.at(-1)!);
    controller.noteSuccessfulAction(current.successfulActions.at(-1)!.record);
    for (const index of [2, 3]) {
      expect((await controller.evaluate(steps[index]!, index)).conclusion).toBe('satisfied');
      await assembler.appendVerificationGoal(steps[index]!.id);
    }
    view = await current.observe();
    await current.act(await current.bind('add', 'click', ref(view.snapshot, 'button', 'Add Element')));
    assembler.appendCurrentStateAction(current.successfulActions.at(-1)!);
    controller.noteSuccessfulAction(current.successfulActions.at(-1)!.record);
    expect((await controller.evaluate(steps[5]!, 5)).conclusion).toBe('satisfied');
    await assembler.appendVerificationGoal('presence');
    const assembled = assembler.finalize({ finishedAt: new Date().toISOString() });
    await store.writeSuccessfulExplorationV4(assembled);
    const output = await compileSuccessfulTraceV4(fixture.factory, store, source.testSpecId,
      assembled.protectedArtifact().attempt.explorationAttemptId);
    expect(output.kind).toBe('compiled');
    if (output.kind !== 'compiled') throw new Error('Fixture did not compile');
    const proof = await store.readSuccessfulExplorationV4Proof(source.testSpecId,
      assembled.protectedArtifact().attempt.explorationAttemptId);
    const accepted = await AcceptedResolvedTestSpecV8.fromStore(store, source.testSpecId,
      assembled.protectedArtifact().attempt.explorationAttemptId,
      output.compiler.compilerAttemptId);
    return { fixture, root, source, resolved: output.resolved, accepted, provenance: {
      attempt: assembled.protectedArtifact().attempt,
      trace: assembled.protectedArtifact().trace, protectedSource: proof,
      compiler: output.compiler },
      close: async () => { await fixture.close(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) {
    await fixture.close(); await rm(root, { recursive: true, force: true });
    throw error;
  } finally { await mcp.close(); }
}

test('v8 execution modules have no authored-identity phrase parser or model/MCP dependency', async () => {
  const implementation = (await Promise.all(['run.ts', 'locator.ts', 'verification-v7.ts']
    .map((name) => readFile(new URL(`../app/runner/${name}`, import.meta.url), 'utf8')))).join('\n');
  for (const name of ['authoredIdentity', 'authoredActionIdentityV3',
    'parseAuthoredRoleNameIdentity', 'formFor'])
    expect(implementation).not.toMatch(new RegExp(`\\b${name}\\s*\\(`));
  expect(implementation).not.toMatch(/from ['"]\.\.\/interpretation\//);
  expect(implementation).not.toMatch(/from ['"]\.\.\/exploration\/mcp/);
});

test('v8 false complete count is an evaluated assertion failure, not automation failure', async () => {
  const compiled = await compiledAddRemove();
  try {
    compiled.fixture.change((route) => route === '/elements' ?
      '<button>Add Element</button><button hidden>Delete</button>' : addRemove(route));
    const run = await executeResolvedTestSpecV8(compiled.fixture.factory, compiled.accepted);
    expect(run.outcomes[3]).toMatchObject({ status: 'QA_ASSERTION_FAILED' });
    expect(run.outcomes[4]).toMatchObject({ status: 'NOT_RUN', reason: 'DEPENDENCY_FAILED' });
  } finally { await compiled.close(); }
});

test('v8 wrong action identity is non-QA, with no phrase-based fallback', async () => {
  for (const changed of [
    '<button>Add/Remove Elements</button>',
    '<a href="/elements">Wrong</a>',
    '<a href="/elements">Add/Remove Elements</a><a href="/elements">Add/Remove Elements</a>',
  ]) {
    const compiled = await compiledAddRemove();
    try {
      compiled.fixture.change((route) => route === '/elements' ? addRemove(route) : changed);
      const run = await executeResolvedTestSpecV8(compiled.fixture.factory, compiled.accepted);
      expect(run.outcomes[1]?.status).toBe('LOCATOR_BINDING_FAILED');
      expect(run.outcomes.some((entry) => entry.status === 'QA_ASSERTION_FAILED')).toBe(false);
    } finally { await compiled.close(); }
  }
});

test('v8 prerequisite executes from its own identity and cannot stand in for authored target', async () => {
  const fixture = await site(() =>
    '<button onclick="document.getElementById(\'target\').hidden=false">Open</button>' +
    '<a id="target" href="#done" hidden>Add/Remove Elements</a>');
  const root = await mkdtemp(path.join(tmpdir(), 'identity-wp4a-prerequisite-'));
  const clause = 'Click the Add/Remove Elements link.';
  const source = { schemaVersion: '5', testSpecId: 'identity-prerequisite-v8',
    sourceInstruction: clause, executionProfileRef: { id: 'identity-wp4a', version: '1' },
    startState: { url: fixture.url }, steps: [action('link', clause, 'Add/Remove Elements', 'link')] };
  const profile = fixture.factory.catalog.resolve(source.executionProfileRef);
  const mcp = await McpExplorationSession.open(fixture.factory,
    source.executionProfileRef, profile, 'attempt-prerequisite-v8');
  try {
    await mcp.navigate(fixture.url);
    const current = new CurrentStateExploration(mcp, source, 'attempt-prerequisite-v8');
    const start = await current.observe();
    const observations = new TrustedObservationSessionV1(mcp, current);
    const assembler = new SuccessfulTraceAssemblerV4(source, { current, observations,
      strategyJournal: () => [], startedAt: new Date().toISOString(),
      startStateDigest: start.stateDigest, profileFingerprint: profile.fingerprint,
      signal: new AbortController().signal, completionState: () => 'running' });
    await current.act(await current.bind('link', 'click', ref(start.snapshot, 'button', 'Open'),
      'discovered_prerequisite'));
    assembler.appendCurrentStateAction(current.successfulActions.at(-1)!, 'expose_target');
    const exposed = await current.observe();
    await current.act(await current.bind('link', 'click',
      ref(exposed.snapshot, 'link', 'Add/Remove Elements')));
    assembler.appendCurrentStateAction(current.successfulActions.at(-1)!);
    const assembled = assembler.finalize({ finishedAt: new Date().toISOString() });
    const store = new LocalArtifactStore(root);
    await store.createJob(source, profile);
    await store.writeSuccessfulExplorationV4(assembled);
    const compiled = await compileSuccessfulTraceV4(fixture.factory, store, source.testSpecId,
      assembled.protectedArtifact().attempt.explorationAttemptId);
    expect(compiled.kind).toBe('compiled');
    if (compiled.kind !== 'compiled') throw new Error('Prerequisite fixture did not compile');
    expect(compiled.resolved.executionSteps.map((step) => step.source))
      .toEqual(['discoveredPrerequisite', 'authored']);
    expect(compiled.resolved.executionSteps[0]).toMatchObject({ locator: {
      validatedForm: { type: 'role', role: 'button', name: 'Open' } } });
    expect(compiled.resolved.executionSteps[1]).toMatchObject({ locator: {
      validatedForm: { type: 'role', role: 'link', name: 'Add/Remove Elements' } } });
    const accepted = await AcceptedResolvedTestSpecV8.fromStore(store, source.testSpecId,
      assembled.protectedArtifact().attempt.explorationAttemptId,
      compiled.compiler.compilerAttemptId);
    const passed = await executeResolvedTestSpecV8(fixture.factory, accepted);
    expect(passed.outcomes.map((entry) => entry.status))
      .toEqual(['OPERATION_SUCCEEDED', 'OPERATION_SUCCEEDED']);
    fixture.change(() => '<button>Wrong</button><a href="#done">Add/Remove Elements</a>');
    const failed = await executeResolvedTestSpecV8(fixture.factory, accepted);
    expect(failed.outcomes[0]).toMatchObject({ status: 'LOCATOR_BINDING_FAILED' });
    expect(failed.outcomes[1]).toMatchObject({ status: 'NOT_RUN', reason: 'DEPENDENCY_FAILED' });
  } finally {
    await mcp.close(); await fixture.close(); await rm(root, { recursive: true, force: true });
  }
});

test('v8 reconstructs durable frame and named scope, and rejects replay drift', async () => {
  for (const kind of ['frame', 'dialog'] as const) {
    const initial = kind === 'frame' ?
      '<iframe title="Payment" srcdoc="<button onclick=&quot;this.textContent=\'Done\'&quot;>Submit</button>"></iframe>' :
      '<div role="dialog" aria-label="Payment"><button onclick="this.textContent=\'Done\'">Submit</button></div>';
    const fixture = await site(() => initial);
    const root = await mkdtemp(path.join(tmpdir(), `identity-wp4a-${kind}-`));
    const clause = `Click the Submit button in Payment ${kind}.`;
    const base = action('submit', clause, 'Submit', 'button');
    const scope = [{ kind, description: 'Payment',
      sourceSpan: { start: clause.indexOf('Payment'),
        end: clause.indexOf('Payment') + 'Payment'.length } }];
    const source = { schemaVersion: '5', testSpecId: `identity-${kind}-v8`,
      sourceInstruction: clause, executionProfileRef: { id: 'identity-wp4a', version: '1' },
      startState: { url: fixture.url }, steps: [{ ...base,
        target: { ...base.target, scope: [{ kind, description: 'Payment' }] },
        actionTargetIntent: { ...base.actionTargetIntent, scope } }] };
    const profile = fixture.factory.catalog.resolve(source.executionProfileRef);
    const mcp = await McpExplorationSession.open(fixture.factory,
      source.executionProfileRef, profile, `attempt-${kind}-v8`);
    try {
      await mcp.navigate(fixture.url);
      const current = new CurrentStateExploration(mcp, source, `attempt-${kind}-v8`);
      const start = await current.observe();
      const observations = new TrustedObservationSessionV1(mcp, current);
      const assembler = new SuccessfulTraceAssemblerV4(source, { current, observations,
        strategyJournal: () => [], startedAt: new Date().toISOString(),
        startStateDigest: start.stateDigest, profileFingerprint: profile.fingerprint,
        signal: new AbortController().signal, completionState: () => 'running' });
      await current.act(await current.bind('submit', 'click', ref(start.snapshot, 'button', 'Submit')));
      assembler.appendCurrentStateAction(current.successfulActions.at(-1)!);
      const assembled = assembler.finalize({ finishedAt: new Date().toISOString() });
      const store = new LocalArtifactStore(root);
      await store.createJob(source, profile);
      await store.writeSuccessfulExplorationV4(assembled);
      const compiled = await compileSuccessfulTraceV4(fixture.factory, store, source.testSpecId,
        assembled.protectedArtifact().attempt.explorationAttemptId);
      expect(compiled.kind, compiled.kind === 'compiled' ? undefined :
        `${kind}: ${compiled.reason}`).toBe('compiled');
      if (compiled.kind !== 'compiled') throw new Error(`${kind} fixture did not compile`);
      const accepted = await AcceptedResolvedTestSpecV8.fromStore(store, source.testSpecId,
        assembled.protectedArtifact().attempt.explorationAttemptId,
        compiled.compiler.compilerAttemptId);
      const passed = await executeResolvedTestSpecV8(fixture.factory, accepted);
      expect(passed.outcomes[0]?.status).toBe('OPERATION_SUCCEEDED');
      fixture.change(() => kind === 'frame' ?
        '<iframe title="Wrong" srcdoc="<button>Submit</button>"></iframe>' :
        '<div role="dialog" aria-label="Payment"><button>Submit</button></div>' +
        '<div role="dialog" aria-label="Payment"></div>');
      const stopped = await executeResolvedTestSpecV8(fixture.factory, accepted);
      expect(stopped.outcomes[0]?.status).toBe('LOCATOR_BINDING_FAILED');
      expect(stopped.outcomes[0]?.status).not.toBe('QA_ASSERTION_FAILED');
    } finally {
      await mcp.close(); await fixture.close(); await rm(root, { recursive: true, force: true });
    }
  }
});
