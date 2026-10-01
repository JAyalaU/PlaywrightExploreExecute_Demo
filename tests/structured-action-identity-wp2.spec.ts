import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CurrentStateExploration, McpExplorationSession, SuccessfulTraceAssemblerV3,
  SuccessfulTraceAssemblerV4, compileSuccessfulTraceV4,
  TrustedObservationSessionV1 } from '../app/exploration/index.js';
import { LocalArtifactStore } from '../app/evidence/index.js';
import { GoalDirectedVerificationControllerV1, type AgenticVerificationModelV4,
  type VerificationDecisionContextV4 } from '../app/interpretation/verification-strategy.js';
import { ProfileCatalog, ProtectedContextFactory } from '../app/profile/index.js';
import { parseActionIdentityWitnessV1, parseCompilerAttemptV3,
  parseResolvedTestSpecV8, parseSuccessfulExplorationTraceV4 } from '../app/domain/index.js';
import { parseProtectedTraceCaptureBundleV4 } from '../app/exploration/trace-assembly-v4.js';

function action(id: string, clause: string, name: string, role?: 'link' | 'button') {
  const nameStart = clause.indexOf(name);
  const roleText = role === 'link' ? 'link' : role === 'button' ? 'button' : undefined;
  const roleStart = roleText ? clause.indexOf(roleText, nameStart + name.length) : -1;
  return { id, type: 'click', sourceText: clause, target: { description: name },
    actionTargetIntent: { intentVersion: '1', sourceStepId: id, operation: 'click',
      role: roleText ? { kind: 'explicit', value: roleText,
        sourceSpan: { start: roleStart, end: roleStart + roleText.length } } : { kind: 'unspecified' },
      accessibleName: name, exact: true,
      nameSourceSpan: { start: nameStart, end: nameStart + name.length } } };
}
function goal(id: string, clause: string, name: string, expected: 'present' | 'absent') {
  return { id, type: 'verification_goal', sourceText: clause, instruction: clause,
    subject: { role: 'button', accessibleName: name }, intent: { kind: 'presence', expected } };
}
function selected(snapshot: string, role: string, name: string, index = 0) {
  const refs = [...snapshot.matchAll(new RegExp(`${role} "${name}" \\[ref=([A-Za-z][A-Za-z0-9_-]*)\\]`, 'g'))];
  if (!refs[index]) throw new Error(`Missing ${role} ${name} ref`);
  return refs[index]![1]!;
}
async function fixture(html?: string) {
  let content = html;
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(content ?? (request.url === '/elements' ?
      `<button onclick="document.body.insertAdjacentHTML('beforeend', '<button>Delete</button>')">Add Element</button>` :
      '<a href="/elements">Add/Remove Elements</a>'));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  const url = `http://127.0.0.1:${address.port}/`;
  const factory = new ProtectedContextFactory(new ProfileCatalog([{
    id: 'identity-wp2', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 },
    locale: 'en-US', timeoutPolicy: { actionMs: 5000, navigationMs: 5000,
      waits: { default: 3000 } }, networkPolicyRef: { id: 'identity-policy', version: '1' },
  }], [{ id: 'identity-policy', version: '1', destinations: [{ host: '127.0.0.1',
    ports: [address.port], addresses: ['127.0.0.1'] }] }]));
  const closeServer = async () => { server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done())); };
  return { url, factory, closeServer, setHtml: (value: string) => { content = value; } };
}
async function opened(source: object, site: Awaited<ReturnType<typeof fixture>>) {
  const profile = site.factory.catalog.resolve({ id: 'identity-wp2', version: '1' });
  const session = await McpExplorationSession.open(site.factory,
    { id: 'identity-wp2', version: '1' }, profile, 'attempt-identity');
  await session.navigate(site.url);
  const current = new CurrentStateExploration(session, source, 'attempt-identity');
  return { profile, session, current, close: async () => { await session.close(); await site.closeServer(); } };
}
function oneActionSource(url: string, clause: string, role?: 'link' | 'button') {
  return { schemaVersion: '5', testSpecId: 'identity-one', sourceInstruction: clause,
    executionProfileRef: { id: 'identity-wp2', version: '1' }, startState: { url },
    steps: [action('link', clause, 'Add/Remove Elements', role)] };
}

test('protected binding proves explicit role/name and rejects zero, duplicate, and wrong ref', async () => {
  const site = await fixture();
  const run = await opened(oneActionSource(site.url, 'Click the Add/Remove Elements link.', 'link'), site);
  try {
    const view = await run.current.observe();
    const ref = selected(view.snapshot, 'link', 'Add/Remove Elements');
    const binding = await run.current.bind('link', 'click', ref);
    const witness = run.current.traceActionIdentityWitness(binding);
    expect(witness).toMatchObject({ sourceStepId: 'link', selectedRole: 'link',
      selectedAccessibleName: 'Add/Remove Elements', eligibleMatchCount: 1,
      selectedReferenceMatches: true, frameOwnership: { kind: 'main' } });
    expect(parseActionIdentityWitnessV1(witness)).toEqual(witness);
    expect(() => parseActionIdentityWitnessV1({ ...witness, selectedRole: 'button' })).toThrow();
    await run.current.act(binding);
    expect(run.current.successfulActions[0]?.identityWitness).toEqual(witness);
    await expect(run.current.act(binding)).rejects.toMatchObject({ reason: 'STALE_BINDING' });
  } finally { await run.close(); }
  for (const html of ['<button>Elsewhere</button>',
    '<a>Add/Remove Elements</a><a>Add/Remove Elements</a>',
    '<button>Add/Remove Elements</button>']) {
    const other = await fixture(html);
    const owned = await opened(oneActionSource(other.url, 'Click the Add/Remove Elements link.', 'link'), other);
    try {
      const view = await owned.current.observe();
      const candidate = /\[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(view.snapshot)?.[1];
      expect(candidate).toBeTruthy();
      await expect(owned.current.bind('link', 'click', candidate!)).rejects.toBeTruthy();
      expect(owned.current.successfulActions).toHaveLength(0);
    } finally { await owned.close(); }
  }
});

test('unspecified role requires one match across every eligible semantic role', async () => {
  for (const [html, allowed] of [
    ['<a href="#a">Add/Remove Elements</a>', true],
    ['<a href="#a">Add/Remove Elements</a><button>Add/Remove Elements</button>', false],
    ['<a href="#a">Add/Remove Elements</a><a href="#b">Add/Remove Elements</a>', false],
  ] as const) {
    const site = await fixture(html);
    const run = await opened(oneActionSource(site.url, 'Click on Add/Remove Elements.'), site);
    try {
      const view = await run.current.observe();
      const link = selected(view.snapshot, 'link', 'Add/Remove Elements');
      if (allowed) {
        const witness = run.current.traceActionIdentityWitness(await run.current.bind('link', 'click', link));
        expect(witness.requestedIntent.role.kind).toBe('unspecified');
        expect(witness.eligibleMatchCount).toBe(1);
      } else await expect(run.current.bind('link', 'click', link)).rejects.toBeTruthy();
    } finally { await run.close(); }
  }
});

test('prerequisite is separately grounded and cannot inherit authored identity', async () => {
  const site = await fixture('<button>Add/Remove Elements</button><a>Add/Remove Elements</a>');
  const run = await opened(oneActionSource(site.url, 'Click the Add/Remove Elements link.', 'link'), site);
  try {
    const view = await run.current.observe();
    const observations = new TrustedObservationSessionV1(run.session, run.current);
    const assembler = new SuccessfulTraceAssemblerV4(run.current.source, {
      current: run.current, observations, strategyJournal: () => [],
      startedAt: new Date().toISOString(), startStateDigest: view.stateDigest,
      profileFingerprint: run.profile.fingerprint,
      signal: new AbortController().signal, completionState: () => 'running',
    });
    const button = selected(view.snapshot, 'button', 'Add/Remove Elements');
    const prerequisite = await run.current.bind('link', 'click', button, 'discovered_prerequisite');
    expect(() => run.current.traceActionIdentityWitness(prerequisite)).toThrow();
    const record = await run.current.act(prerequisite);
    expect(record.source).toBe('discoveredPrerequisite');
    expect(run.current.successfulActions[0]?.identityWitness).toBeUndefined();
    expect(run.current.successfulActions[0]?.binding.selectedNode.role).toBe('button');
    assembler.appendCurrentStateAction(run.current.successfulActions[0]!, 'expose_target');
    expect(() => assembler.finalize({ finishedAt: new Date().toISOString() })).toThrow();
  } finally { await run.close(); }
});

test('a discovered prerequisite can precede, but cannot replace, the authored action in v4', async () => {
  const site = await fixture('<button onclick="document.getElementById(\'target\').hidden=false">Open</button>' +
    '<a id="target" href="#done" hidden>Add/Remove Elements</a>');
  const source = oneActionSource(site.url, 'Click the Add/Remove Elements link.', 'link');
  const run = await opened(source, site);
  const root = await mkdtemp(path.join(tmpdir(), 'identity-prerequisite-'));
  try {
    const start = await run.current.observe();
    const observations = new TrustedObservationSessionV1(run.session, run.current);
    const assembler = new SuccessfulTraceAssemblerV4(source, { current: run.current, observations,
      strategyJournal: () => [], startedAt: new Date().toISOString(),
      startStateDigest: start.stateDigest, profileFingerprint: run.profile.fingerprint,
      signal: new AbortController().signal, completionState: () => 'running' });
    const prerequisite = await run.current.bind('link', 'click', selected(start.snapshot, 'button', 'Open'),
      'discovered_prerequisite');
    await run.current.act(prerequisite);
    assembler.appendCurrentStateAction(run.current.successfulActions.at(-1)!, 'expose_target');
    const view = await run.current.observe();
    const authored = await run.current.bind('link', 'click',
      selected(view.snapshot, 'link', 'Add/Remove Elements'));
    await run.current.act(authored);
    assembler.appendCurrentStateAction(run.current.successfulActions.at(-1)!);
    const assembled = assembler.finalize({ finishedAt: new Date().toISOString() });
    const trace = assembled.protectedArtifact().trace;
    expect(trace.successfulPath.map((record) => record.source))
      .toEqual(['discoveredPrerequisite', 'authored']);
    expect(trace.actionIdentityProofs).toHaveLength(1);
    expect(trace.actionIdentityProofs[0]?.recordId).toBe(trace.successfulPath[1]?.recordId);
    expect(trace.bindings[0]?.selectedNode.accessibleName).toBe('Open');
    expect(trace.bindings[1]?.selectedNode.accessibleName).toBe('Add/Remove Elements');
    const store = new LocalArtifactStore(root);
    await store.createJob(source, run.profile);
    await store.writeSuccessfulExplorationV4(assembled);
    const compiled = await compileSuccessfulTraceV4(site.factory, store, source.testSpecId,
      assembled.protectedArtifact().attempt.explorationAttemptId);
    expect(compiled.kind).toBe('compiled');
    if (compiled.kind === 'compiled') {
      expect(compiled.resolved.executionSteps.map((step) => step.source))
        .toEqual(['discoveredPrerequisite', 'authored']);
      expect(compiled.compiler.actionIdentityLinks).toHaveLength(1);
    }
  } finally { await run.close(); await rm(root, { recursive: true, force: true }); }
});

async function oneActionCompilation(clause: string, role: 'link' | undefined,
  freshHtml?: string) {
  const site = await fixture('<a href="/elements">Add/Remove Elements</a>');
  const name = 'Add/Remove Elements';
  const nameStart = clause.indexOf(name);
  const roleLiteral = role === 'link' && clause.toLowerCase().includes('hyperlink') ?
    'hyperlink' : role;
  const roleStart = roleLiteral ? clause.toLowerCase().indexOf(roleLiteral) : -1;
  const step = { id: 'link', type: 'click', sourceText: clause,
    target: { description: name }, actionTargetIntent: { intentVersion: '1',
      sourceStepId: 'link', operation: 'click',
      role: role ? { kind: 'explicit', value: role,
        sourceSpan: { start: roleStart, end: roleStart + roleLiteral!.length } } :
        { kind: 'unspecified' }, accessibleName: name, exact: true,
      nameSourceSpan: { start: nameStart, end: nameStart + name.length } } };
  const source = { schemaVersion: '5', testSpecId: 'identity-compile-one',
    sourceInstruction: clause, executionProfileRef: { id: 'identity-wp2', version: '1' },
    startState: { url: site.url }, steps: [step] };
  const run = await opened(source, site);
  const root = await mkdtemp(path.join(tmpdir(), 'identity-compiler-'));
  try {
    const store = new LocalArtifactStore(root);
    await store.createJob(source, run.profile);
    const start = await run.current.observe();
    const observations = new TrustedObservationSessionV1(run.session, run.current);
    const assembler = new SuccessfulTraceAssemblerV4(source, { current: run.current, observations,
      strategyJournal: () => [], startedAt: new Date().toISOString(),
      startStateDigest: start.stateDigest, profileFingerprint: run.profile.fingerprint,
      signal: new AbortController().signal, completionState: () => 'running' });
    const binding = await run.current.bind('link', 'click',
      selected(start.snapshot, 'link', 'Add/Remove Elements'));
    await run.current.act(binding);
    assembler.appendCurrentStateAction(run.current.successfulActions.at(-1)!);
    const assembled = assembler.finalize({ finishedAt: new Date().toISOString() });
    await store.writeSuccessfulExplorationV4(assembled);
    if (freshHtml) site.setHtml(freshHtml);
    const result = await compileSuccessfulTraceV4(site.factory, store, source.testSpecId,
      assembled.protectedArtifact().attempt.explorationAttemptId);
    if (result.kind !== 'compiled') expect(await store.readCompilerAttemptV3(source.testSpecId,
      assembled.protectedArtifact().attempt.explorationAttemptId,
      result.compiler.compilerAttemptId)).toEqual(result.compiler);
    return { result, trace: assembled.protectedArtifact().trace };
  } finally { await run.close(); await rm(root, { recursive: true, force: true }); }
}

test('compiler v3 action identity is independent of equivalent authored phrasing', async () => {
  const forms = [
    ['Click the Add/Remove Elements link.', 'link'],
    ['Click on Add/Remove Elements.', undefined],
    ['Find Add/Remove Elements and open it.', undefined],
    ['Follow the link labeled Add/Remove Elements.', 'link'],
    ['Select the Add/Remove Elements hyperlink.', 'link'],
    ['Open Add/Remove Elements from the page.', undefined],
  ] as const;
  const locators = [];
  for (const [clause, role] of forms) {
    const { result } = await oneActionCompilation(clause, role);
    expect(result.kind).toBe('compiled');
    if (result.kind === 'compiled') {
      const step = result.resolved.executionSteps[0]!;
      expect(step.type).toBe('click');
      if (step.type === 'click') locators.push(step.locator.validatedForm);
    }
  }
  expect(locators).toHaveLength(6);
  expect(locators[1]).toEqual(locators[0]);
  expect(locators[2]).toEqual(locators[0]);
  for (const locator of locators.slice(3)) expect(locator).toEqual(locators[0]);
});

test('compiler v3 fails closed on fresh zero, duplicate, or role-substituted target', async () => {
  for (const [html, reason] of [
    ['<button>Elsewhere</button>', 'TARGET_MISMATCH'],
    ['<a href="/elements">Add/Remove Elements</a><a href="/elements">Add/Remove Elements</a>',
      'NON_UNIQUE_MATCH'],
    ['<button>Add/Remove Elements</button>', 'TARGET_MISMATCH'],
  ] as const) {
    const { result } = await oneActionCompilation('Click the Add/Remove Elements link.', 'link', html);
    expect(result.kind).toBe('compilation_stop');
    if (result.kind !== 'compiled') expect(result.reason).toBe(reason);
  }
  for (const [html, reason] of [
    ['<a href="/elements">Add/Remove Elements</a><button>Add/Remove Elements</button>',
      'NON_UNIQUE_MATCH'],
    ['<button>Add/Remove Elements</button>', 'TARGET_MISMATCH'],
  ] as const) {
    const { result } = await oneActionCompilation('Click on Add/Remove Elements.', undefined, html);
    expect(result.kind).toBe('compilation_stop');
    if (result.kind !== 'compiled') expect(result.reason).toBe(reason);
  }
});

test('new compiler route has no authored-language identity parser', async () => {
  const code = await readFile(new URL('../app/exploration/trace-compiler-v4.ts', import.meta.url), 'utf8');
  for (const forbidden of ['authoredIdentity', 'authoredActionIdentityV3',
    'parseAuthoredRoleNameIdentity', 'formFor', 'sourceText'])
    expect(code).not.toContain(forbidden);
});

test('v4 temporal strategy stops as compilation unsupported without a v8 artifact', async () => {
  const site = await fixture('<div role="dialog" aria-label="Confirm">' +
    '<button onclick="this.closest(\'[role=dialog]\').remove()">Close</button></div>');
  const close = action('close', 'Click the Close button.', 'Close', 'button');
  const first = { id: 'present', type: 'verification_goal',
    sourceText: 'Confirm the Confirm dialog exists.',
    instruction: 'Confirm the Confirm dialog exists.',
    subject: { role: 'dialog', accessibleName: 'Confirm' },
    intent: { kind: 'presence', expected: 'present' } };
  const later = { id: 'disappears', type: 'verification_goal',
    sourceText: 'Make sure the Confirm dialog disappears.',
    instruction: 'Make sure the Confirm dialog disappears.',
    subject: { role: 'dialog', accessibleName: 'Confirm' },
    intent: { kind: 'temporal', transition: 'disappears' } };
  const steps = [first, close, later];
  const source = { schemaVersion: '5', testSpecId: 'identity-temporal',
    sourceInstruction: steps.map((step) => step.sourceText).join(' '),
    executionProfileRef: { id: 'identity-wp2', version: '1' },
    startState: { url: site.url }, steps };
  const run = await opened(source, site);
  const root = await mkdtemp(path.join(tmpdir(), 'identity-temporal-'));
  try {
    const store = new LocalArtifactStore(root);
    await store.createJob(source, run.profile);
    const start = await run.current.observe();
    const observations = new TrustedObservationSessionV1(run.session, run.current);
    let earlierId = '';
    let decision = 0;
    const model: AgenticVerificationModelV4 = { complete: async ({ context }) => {
      const turn = decision++;
      if (turn === 0 || turn === 2) return JSON.stringify({ decisionVersion: '4',
        kind: 'observe', request: { kind: 'semantic_query', query: {
          role: 'dialog', name: 'Confirm', frame: { kind: 'main' } } } });
      if (turn === 1) {
        earlierId = context.observations.at(-1)!.observationId;
        return JSON.stringify({ decisionVersion: '4', kind: 'conclude',
          conclusion: 'satisfied', comparison: { kind: 'count',
            observationId: earlierId, operator: 'greater_than', expected: 0 } });
      }
      return JSON.stringify({ decisionVersion: '4', kind: 'conclude',
        conclusion: 'satisfied', comparison: { kind: 'transition',
          earlierObservationId: earlierId,
          laterObservationId: context.observations.at(-1)!.observationId,
          operator: 'disappears' } });
    } };
    const controller = new GoalDirectedVerificationControllerV1(observations, run.current, model);
    const assembler = new SuccessfulTraceAssemblerV4(source, { current: run.current, observations,
      strategyJournal: () => controller.successfulStrategies,
      startedAt: new Date().toISOString(), startStateDigest: start.stateDigest,
      profileFingerprint: run.profile.fingerprint,
      signal: new AbortController().signal, completionState: () => 'running' });
    expect((await controller.evaluate(first, 0)).conclusion).toBe('satisfied');
    await assembler.appendVerificationGoal('present');
    const view = await run.current.observe();
    const binding = await run.current.bind('close', 'click', selected(view.snapshot, 'button', 'Close'));
    const actionRecord = await run.current.act(binding);
    assembler.appendCurrentStateAction(run.current.successfulActions.at(-1)!);
    controller.noteSuccessfulAction(actionRecord);
    expect((await controller.evaluate(later, 2)).conclusion).toBe('satisfied');
    await assembler.appendVerificationGoal('disappears');
    const assembled = assembler.finalize({ finishedAt: new Date().toISOString() });
    await store.writeSuccessfulExplorationV4(assembled);
    const compilation = await compileSuccessfulTraceV4(site.factory, store, source.testSpecId,
      assembled.protectedArtifact().attempt.explorationAttemptId);
    expect(compilation.kind).toBe('compilation_unsupported');
    if (compilation.kind !== 'compiled') {
      expect(compilation.reason).toBe('UNSUPPORTED_TEMPORAL_REPLAY');
      expect(compilation.compiler.result.status).toBe('rejected');
      await expect(store.readCompiledExplorationV8(source.testSpecId,
        assembled.protectedArtifact().attempt.explorationAttemptId,
        compilation.compiler.compilerAttemptId)).rejects.toThrow();
    }
  } finally { await run.close(); await rm(root, { recursive: true, force: true }); }
});

test('evaluated-false v4 verification compiles its predicate without a QA verdict', async () => {
  const site = await fixture('<button>Other</button>');
  const step = goal('presence', 'Confirm Delete button exists.', 'Delete', 'present');
  const source = { schemaVersion: '5', testSpecId: 'identity-false-goal',
    sourceInstruction: step.sourceText, executionProfileRef: { id: 'identity-wp2', version: '1' },
    startState: { url: site.url }, steps: [step] };
  const run = await opened(source, site);
  const root = await mkdtemp(path.join(tmpdir(), 'identity-false-goal-'));
  try {
    const store = new LocalArtifactStore(root);
    await store.createJob(source, run.profile);
    const start = await run.current.observe();
    const observations = new TrustedObservationSessionV1(run.session, run.current);
    let decision = 0;
    const model: AgenticVerificationModelV4 = { complete: async ({ context }) =>
      JSON.stringify(decision++ === 0 ? { decisionVersion: '4', kind: 'observe',
        request: { kind: 'semantic_query', query: { role: 'button', name: 'Delete',
          frame: { kind: 'main' } } } } : { decisionVersion: '4', kind: 'conclude',
            conclusion: 'unsatisfied', comparison: { kind: 'count',
              observationId: context.observations.at(-1)!.observationId,
              operator: 'greater_than', expected: 0 } }) };
    const controller = new GoalDirectedVerificationControllerV1(observations, run.current, model);
    const assembler = new SuccessfulTraceAssemblerV4(source, { current: run.current, observations,
      strategyJournal: () => controller.successfulStrategies,
      startedAt: new Date().toISOString(), startStateDigest: start.stateDigest,
      profileFingerprint: run.profile.fingerprint, signal: new AbortController().signal,
      completionState: () => 'running' });
    expect((await controller.evaluate(step, 0)).conclusion).toBe('unsatisfied');
    await assembler.appendVerificationGoal(step.id);
    const assembled = assembler.finalize({ finishedAt: new Date().toISOString() });
    await store.writeSuccessfulExplorationV4(assembled);
    const compiled = await compileSuccessfulTraceV4(site.factory, store, source.testSpecId,
      assembled.protectedArtifact().attempt.explorationAttemptId);
    expect(compiled.kind).toBe('compiled');
    if (compiled.kind === 'compiled') {
      expect(compiled.resolved.executionSteps[0]).toMatchObject({ type: 'verification_goal',
        assertion: { kind: 'semantic_count', operator: 'greater_than', expected: 0 } });
      expect('qa' in compiled).toBe(false);
    }
  } finally { await run.close(); await rm(root, { recursive: true, force: true }); }
});

test('v5 binding is operation, reference, and epoch specific with no v3 fallback', async () => {
  const site = await fixture('<a href="#a">Add/Remove Elements</a><button>Other</button>');
  const source = oneActionSource(site.url, 'Click the Add/Remove Elements link.', 'link');
  const run = await opened(source, site);
  try {
    const view = await run.current.observe();
    await expect(run.current.bind('link', 'click', selected(view.snapshot, 'button', 'Other')))
      .rejects.toBeTruthy();
    await expect(run.current.bind('link', 'fill', selected(view.snapshot, 'link', 'Add/Remove Elements')))
      .rejects.toBeTruthy();
    const binding = await run.current.bind('link', 'click', selected(view.snapshot, 'link', 'Add/Remove Elements'));
    await expect(run.current.act({ ...binding, sessionId: 'session-forged' }))
      .rejects.toMatchObject({ reason: 'STALE_BINDING' });
    await expect(run.current.act({ ...binding, selectedRef: 'ref-forged' }))
      .rejects.toMatchObject({ reason: 'STALE_BINDING' });
    await expect(run.current.act({ ...binding, operation: 'fill' }, 'value'))
      .rejects.toMatchObject({ reason: 'STALE_BINDING' });
    await run.current.observe();
    await expect(run.current.act(binding)).rejects.toMatchObject({ reason: 'STALE_BINDING' });
    const fresh = await run.current.bind('link', 'click', selected(view.snapshot, 'link', 'Add/Remove Elements'));
    await run.session.browserSession.context.pages()[0]!.locator('a').evaluate((node) => {
      node.textContent = 'Changed';
    });
    await expect(run.current.act(fresh)).rejects.toMatchObject({ reason: 'STALE_BINDING' });
    const observations = new TrustedObservationSessionV1(run.session, run.current);
    expect(() => new SuccessfulTraceAssemblerV3(source, { current: run.current, observations,
      strategyJournal: () => [], startedAt: new Date().toISOString(),
      startStateDigest: view.stateDigest, profileFingerprint: run.profile.fingerprint,
      signal: new AbortController().signal, completionState: () => 'running' })).toThrow();
  } finally { await run.close(); }
});

test('v5 binding proves nested frame and reviewed scope ownership', async () => {
  for (const [html, kind, accepted] of [
    ['<iframe title="Payment" srcdoc="<button onclick=&quot;this.textContent=\'Done\'&quot;>Submit</button>"></iframe>', 'frame', true],
    ['<iframe title="Other" srcdoc="<button onclick=&quot;this.textContent=\'Done\'&quot;>Submit</button>"></iframe>', 'frame', false],
    ['<div role="dialog" aria-label="Payment"><button onclick="this.textContent=\'Done\'">Submit</button></div>', 'dialog', true],
    ['<div role="dialog" aria-label="Other"><button onclick="this.textContent=\'Done\'">Submit</button></div>', 'dialog', false],
  ] as const) {
    const site = await fixture(html);
    const clause = `Click the Submit button in Payment ${kind}.`;
    const base = action('submit', clause, 'Submit', 'button');
    const position = clause.indexOf('Payment');
    const scope = [{ kind, description: 'Payment',
      sourceSpan: { start: position, end: position + 'Payment'.length } }];
    const source = { schemaVersion: '5', testSpecId: `identity-${kind}`,
      sourceInstruction: clause, executionProfileRef: { id: 'identity-wp2', version: '1' },
      startState: { url: site.url }, steps: [{ ...base,
        target: { ...base.target, scope: [{ kind, description: 'Payment' }] },
        actionTargetIntent: { ...base.actionTargetIntent, scope } }] };
    const run = await opened(source, site);
    const root = await mkdtemp(path.join(tmpdir(), `identity-${kind}-compiler-`));
    try {
      const view = await run.current.observe();
      const ref = selected(view.snapshot, 'button', 'Submit');
      if (accepted) {
        const startedAt = new Date().toISOString();
        const binding = await run.current.bind('submit', 'click', ref);
        expect(run.current.traceActionIdentityWitness(binding).frameOwnership.kind)
          .toBe(kind === 'frame' ? 'nested' : 'main');
        const observations = new TrustedObservationSessionV1(run.session, run.current);
        const assembler = new SuccessfulTraceAssemblerV4(source, { current: run.current, observations,
          strategyJournal: () => [], startedAt,
          startStateDigest: view.stateDigest, profileFingerprint: run.profile.fingerprint,
          signal: new AbortController().signal, completionState: () => 'running' });
        await run.current.act(binding);
        assembler.appendCurrentStateAction(run.current.successfulActions.at(-1)!);
        const assembled = assembler.finalize({ finishedAt: new Date().toISOString() });
        const store = new LocalArtifactStore(root);
        await store.createJob(source, run.profile);
        await store.writeSuccessfulExplorationV4(assembled);
        const compiled = await compileSuccessfulTraceV4(site.factory, store, source.testSpecId,
          assembled.protectedArtifact().attempt.explorationAttemptId);
        expect(compiled.kind).toBe('compiled');
        if (compiled.kind === 'compiled') {
          const step = compiled.resolved.executionSteps[0]!;
          expect(step.type).toBe('click');
          if (step.type === 'click') expect(step.locator.validatedForm.type).toBe(kind === 'frame' ?
            'role' : 'within');
        }
        site.setHtml(kind === 'frame' ?
          '<iframe title="Other" srcdoc="<button>Submit</button>"></iframe>' :
          '<div role="dialog" aria-label="Other"><button>Submit</button></div>');
        const drifted = await compileSuccessfulTraceV4(site.factory, store, source.testSpecId,
          assembled.protectedArtifact().attempt.explorationAttemptId);
        expect(drifted.kind).toBe('compilation_stop');
        if (drifted.kind !== 'compiled') expect(drifted.reason).toBe('UNPROVEN_IDENTITY');
      } else await expect(run.current.bind('submit', 'click', ref)).rejects.toBeTruthy();
    } finally { await run.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test('Add/Remove v5 actions and verification goals assemble and persist an ordered v4 trace', async () => {
  const site = await fixture();
  const go = { id: 'go', type: 'navigate', sourceText: `Go to ${site.url}.`, url: site.url };
  const link = action('link', 'Click the Add/Remove Elements link.', 'Add/Remove Elements', 'link');
  const add = action('add', 'Click the Add Element button.', 'Add Element', 'button');
  const steps = [go, link,
    goal('add-goal', 'Confirm Add Element button exists.', 'Add Element', 'present'),
    goal('absence', 'Confirm Delete button does not exist.', 'Delete', 'absent'), add,
    goal('presence', 'Confirm Delete button exists.', 'Delete', 'present')];
  const source = { schemaVersion: '5', testSpecId: 'identity-add-remove',
    sourceInstruction: steps.map((step) => step.sourceText).join(' '),
    executionProfileRef: { id: 'identity-wp2', version: '1' }, startState: { url: site.url }, steps };
  const run = await opened(source, site);
  const root = await mkdtemp(path.join(tmpdir(), 'identity-wp2-'));
  try {
    const store = new LocalArtifactStore(root);
    await store.createJob(source, run.profile);
    const start = await run.current.observe();
    const observations = new TrustedObservationSessionV1(run.session, run.current);
    const decisions = [
      { name: 'Add Element', operator: 'greater_than', expected: 0 },
      { name: 'Delete', operator: 'equal', expected: 0 },
      { name: 'Delete', operator: 'greater_than', expected: 0 },
    ];
    let decisionIndex = 0;
    const model: AgenticVerificationModelV4 = { complete: async ({ context }) => {
      const selected = decisions[Math.floor(decisionIndex / 2)]!;
      const response = decisionIndex++ % 2 === 0 ? { decisionVersion: '4', kind: 'observe',
        request: { kind: 'semantic_query', query: { role: 'button', name: selected.name,
          frame: { kind: 'main' } } } } : { decisionVersion: '4', kind: 'conclude',
            conclusion: 'satisfied', comparison: { kind: 'count',
              observationId: context.observations.at(-1)!.observationId,
              operator: selected.operator, expected: selected.expected } };
      return JSON.stringify(response);
    } };
    const controller = new GoalDirectedVerificationControllerV1(observations, run.current, model);
    const assembler = new SuccessfulTraceAssemblerV4(source, { current: run.current, observations,
      strategyJournal: () => controller.successfulStrategies,
      startedAt: new Date().toISOString(), startStateDigest: start.stateDigest,
      profileFingerprint: run.profile.fingerprint, signal: new AbortController().signal,
      completionState: () => 'running' });
    await run.session.navigate(site.url); run.current.invalidate();
    let view = await run.current.observe();
    await assembler.appendObservedRecord({ type: 'navigate', recordId: 'record-go', sequence: 1,
      source: 'authored', originStepId: 'go', preStateDigest: start.stateDigest,
      postStateDigest: view.stateDigest, observationDigest: view.snapshotDigest,
      url: site.url, result: 'completed' });
    const linkBinding = await run.current.bind('link', 'click', selected(view.snapshot, 'link', 'Add/Remove Elements'));
    const linkRecord = await run.current.act(linkBinding);
    assembler.appendCurrentStateAction(run.current.successfulActions.at(-1)!);
    controller.noteSuccessfulAction(linkRecord);
    for (const index of [2, 3]) {
      expect((await controller.evaluate(steps[index]!, index)).conclusion).toBe('satisfied');
      await assembler.appendVerificationGoal(steps[index]!.id);
    }
    view = await run.current.observe();
    const addBinding = await run.current.bind('add', 'click', selected(view.snapshot, 'button', 'Add Element'));
    const addRecord = await run.current.act(addBinding);
    assembler.appendCurrentStateAction(run.current.successfulActions.at(-1)!);
    controller.noteSuccessfulAction(addRecord);
    expect((await controller.evaluate(steps[5]!, 5)).conclusion).toBe('satisfied');
    await assembler.appendVerificationGoal('presence');
    const assembled = assembler.finalize({ finishedAt: new Date().toISOString() });
    const artifact = assembled.protectedArtifact();
    const protectedSource = parseProtectedTraceCaptureBundleV4(artifact.capture, artifact.trace).source;
    for (const changed of [
      { sourceStepId: 'other' }, { selectedRole: 'button' },
      { selectedAccessibleName: 'Wrong' }, { sessionId: 'session-wrong' },
      { pageId: 'page-wrong' }, { frameId: 'frame-wrong' },
      { stateDigest: 'f'.repeat(64) }, { mutationEpoch: 900 },
      { selectedRef: 'ref-wrong' }, { eligibleMatchCount: 0 },
    ]) {
      const tampered = structuredClone(artifact.trace);
      tampered.actionIdentityProofs[0]!.selectedWitness = {
        ...tampered.actionIdentityProofs[0]!.selectedWitness, ...changed } as never;
      expect(() => parseSuccessfulExplorationTraceV4(tampered, source, artifact.attempt,
        protectedSource)).toThrow();
    }
    for (const change of [
      (trace: typeof artifact.trace) => { trace.actionIdentityProofs.pop(); },
      (trace: typeof artifact.trace) => { trace.actionIdentityProofs.push(trace.actionIdentityProofs[0]!); },
      (trace: typeof artifact.trace) => { trace.successfulPath.splice(1, 1); },
      (trace: typeof artifact.trace) => { [trace.successfulPath[1], trace.successfulPath[2]] =
        [trace.successfulPath[2]!, trace.successfulPath[1]!]; },
      (trace: typeof artifact.trace) => { trace.successfulPath[1]!.source = 'discoveredPrerequisite'; },
    ]) {
      const tampered = structuredClone(artifact.trace);
      change(tampered);
      expect(() => parseSuccessfulExplorationTraceV4(tampered, source, artifact.attempt,
        protectedSource)).toThrow();
    }
    const persisted = await store.writeSuccessfulExplorationV4(assembled);
    expect(persisted.trace.traceVersion).toBe('4');
    expect(persisted.trace.successfulPath.map((record) => record.originStepId))
      .toEqual(steps.map((step) => step.id));
    expect(persisted.trace.actionIdentityProofs.map((proof) => proof.requestedIntent.accessibleName))
      .toEqual(['Add/Remove Elements', 'Add Element']);
    expect((await store.readSuccessfulExplorationV4(source.testSpecId, persisted.attempt.explorationAttemptId)).trace)
      .toEqual(persisted.trace);
    const compilation = await compileSuccessfulTraceV4(site.factory, store, source.testSpecId,
      persisted.attempt.explorationAttemptId);
    expect(compilation.kind).toBe('compiled');
    if (compilation.kind === 'compiled') {
      expect(compilation.resolved.schemaVersion).toBe('8');
      expect(compilation.resolved.executionSteps.map((step) => step.type))
        .toEqual(['navigate', 'click', 'verification_goal', 'verification_goal',
          'click', 'verification_goal']);
      expect(compilation.resolved.executionSteps.filter((step) => step.type === 'verification_goal')
        .map((step) => step.assertion.kind)).toEqual(['semantic_count', 'semantic_count',
          'semantic_count']);
      expect(compilation.compiler.actionIdentityLinks).toHaveLength(2);
      expect(await store.readCompiledExplorationV8(source.testSpecId,
        persisted.attempt.explorationAttemptId, compilation.compiler.compilerAttemptId))
        .toEqual({ compiler: compilation.compiler, resolved: compilation.resolved });
      const proof = await store.readSuccessfulExplorationV4Proof(source.testSpecId,
        persisted.attempt.explorationAttemptId);
      const tamperedCompiler = structuredClone(compilation.compiler);
      tamperedCompiler.actionIdentityLinks[0]!.requestedIntentDigest = 'f'.repeat(64);
      expect(() => parseCompilerAttemptV3(tamperedCompiler, source, persisted.attempt,
        persisted.trace, proof)).toThrow();
      const tamperedResolved = structuredClone(compilation.resolved);
      const actionStep = tamperedResolved.executionSteps[1]!;
      if (actionStep.type !== 'click') throw new Error('Expected compiled link click');
      actionStep.locator.validatedForm = { type: 'role', role: 'button',
        name: 'Add/Remove Elements', exact: true };
      actionStep.locator.observed.role = 'button';
      expect(() => parseResolvedTestSpecV8(tamperedResolved, source, persisted.attempt,
        persisted.trace, proof, compilation.compiler)).toThrow();
      const rawExpression = structuredClone(compilation.resolved);
      const rawAction = rawExpression.executionSteps[1]!;
      if (rawAction.type !== 'click') throw new Error('Expected compiled link click');
      rawAction.locator.rawMcpExpression = 'untrusted-model-expression';
      expect(() => parseResolvedTestSpecV8(rawExpression, source, persisted.attempt,
        persisted.trace, proof, compilation.compiler)).toThrow();
    }
    expect(() => parseSuccessfulExplorationTraceV4({ ...persisted.trace,
      actionIdentityProofs: [] }, source, persisted.attempt,
    { readObservation: () => undefined, readStrategy: () => undefined,
      readActionWitness: () => undefined })).toThrow();
  } finally { await run.close(); await rm(root, { recursive: true, force: true }); }
});
