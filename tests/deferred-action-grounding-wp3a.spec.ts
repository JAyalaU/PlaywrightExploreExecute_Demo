import http from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElementHandle } from '@playwright/test';
import { ActionCandidateGroundingSessionV1, ActionCandidateGroundingError } from '../app/exploration/action-candidate-grounding.js';
import { McpExplorationSession } from '../app/exploration/mcp.js';
import { ProtectedContextFactory, ProfileCatalog } from '../app/profile/index.js';
import { admitActionSemanticsV2, type TrustedSemanticAdmissionV2 } from '../app/domain/action-semantic-admission.js';
import { candidateGroundingDigest as hash } from '../app/domain/action-candidate-grounding.js';
import type { GroundingCorrespondenceV1 } from '../app/domain/action-grounding-strategy.js';
import type { ActionGoalV2, TestSpecV6V2 } from '../app/domain/index.js';
import { executeActionGoalGroundingV1 } from '../app/interpretation/action-grounding-execution-controller.js';
import { SuccessfulTraceAssemblerV5, requireAssembledSuccessfulTraceV5, AssembledSuccessfulTraceV5,
  parseProtectedTraceCaptureBundleV5 } from '../app/exploration/trace-assembly-v5.js';
import { SuccessfulTraceV5Store, requireTrustedSuccessfulTraceReadbackV5,
  TrustedSuccessfulTraceReadbackV5 } from '../app/evidence/trace-store-v5.js';
import { TrustedObservationSessionV1 } from '../app/exploration/trusted-observation.js';
import { GoalDirectedVerificationControllerV1 } from '../app/interpretation/verification-strategy.js';
import { parseTestSpec } from '../app/domain/validate.js';
import { SuccessfulExplorationTraceV4Schema } from '../app/domain/agentic-trace-v3.js';
import { successfulTraceDigestV5 } from '../app/domain/agentic-trace-v5.js';
import { action, activate, choose } from './helpers/action-v2-fixtures.js';

const select = '<select><option value="">Choose</option><option value="runtime-1">Option 1</option></select>';
const fill = () => action([['Enter', 'effect'], [' ', 'neutral'], ['exact text', 'argument'], ['.', 'neutral']], [
  { id: 'e', kind: 'effect', effect: 'enter_text', sourceSegmentIds: ['p0'] },
  { id: 'a', kind: 'argument', purpose: 'entered_text', authoredText: 'exact text', sourceSegmentIds: ['p2'] },
]);
const check = (role: 'checkbox' | 'radio') => action([['Click', 'effect'], [' the ', 'neutral'], [role, 'target'], ['.', 'neutral']], [
  { id: 'e', kind: 'effect', effect: 'activate', sourceSegmentIds: ['p0'] },
  { id: 'o', kind: 'operation', operation: 'click', sourceSegmentIds: ['p0'] },
  { id: 'r', kind: 'constraint', constraint: 'role', subject: { kind: 'target' }, polarity: 'positive', authoredText: role, sourceSegmentIds: ['p2'] },
]);
const verification = (id = 'verify'): TestSpecV6V2['steps'][number] => ({ id, type: 'verification_goal',
  sourceText: 'Confirm the textbox is visible.', instruction: 'Confirm the textbox is visible.',
  subject: { role: 'textbox' }, intent: { kind: 'property', property: 'visible', expected: true },
  sourceInstructionSpan: { start: 0, end: 31 } });

async function harness(html: string, goalsInput: TestSpecV6V2['steps'] | ((url: string) => TestSpecV6V2['steps']) = [choose()]) {
  const server = http.createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end(html); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
  const url = `http://127.0.0.1:${address.port}/`;
  const goals = typeof goalsInput === 'function' ? goalsInput(url) : goalsInput;
  let end = 0;
  const steps = structuredClone(goals).map((g, index) => {
    if (index) end++;
    g.sourceInstructionSpan = { start: end, end: end + g.sourceText.length }; end += g.sourceText.length;
    return g;
  });
  const draft: TestSpecV6V2 = { schemaVersion: '6', sourceContractVersion: '2', testSpecId: 'trace-v5-fixture',
    sourceInstruction: steps.map((g) => g.sourceText).join(' '), executionProfileRef: { id: 'desktop', version: '1' },
    startState: { url }, steps, instructionAccounting: steps.flatMap((g, i) => [
      ...(i ? [{ classification: 'neutral' as const, sourceSpan: { start: g.sourceInstructionSpan.start - 1, end: g.sourceInstructionSpan.start }, authoredText: ' ' }] : []),
      { classification: 'clause' as const, stepId: g.id, sourceSpan: g.sourceInstructionSpan, authoredText: g.sourceText },
    ]) };
  const versions = { goalContractVersion: '2' as const, primaryExtractionVersion: 'mock_primary', independentExtractionVersion: 'mock_independent',
    primaryPromptVersion: 'mock_primary', independentPromptVersion: 'mock_independent' };
  const { schemaVersion: _schema, sourceContractVersion: _contract, steps: _steps, instructionAccounting: _accounting, ...metadata } = draft;
  const admission = admitActionSemanticsV2(metadata, draft, structuredClone(draft), versions);
  const factory = new ProtectedContextFactory(new ProfileCatalog([{
    id: 'desktop', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 3000, navigationMs: 5000, waits: { default: 3000 } }, networkPolicyRef: { id: 'local', version: '1' },
  }], [{ id: 'local', version: '1', destinations: [{ host: '127.0.0.1', ports: [address.port], addresses: ['127.0.0.1'] }] }]));
  const session = await McpExplorationSession.open(factory, draft.executionProfileRef, factory.catalog.resolve(draft.executionProfileRef), 'wp3a-attempt');
  await session.navigate(url);
  const runtime = new ActionCandidateGroundingSessionV1(session, admission, 'wp3a-attempt');
  const root = await mkdtemp(path.join(tmpdir(), 'trace-v5-'));
  return { admission, runtime, session, url, root, page: session.browserSession.context.pages()[0]!,
    close: async () => { await session.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true }); } };
}
type Run = Awaited<ReturnType<typeof harness>>;
function correspondence(goal: ActionGoalV2): GroundingCorrespondenceV1 {
  return goal.obligations.map((obligation) => {
    if (obligation.kind === 'effect' || obligation.kind === 'operation') return { obligation, realization: { kind: obligation.kind } };
    if (obligation.kind === 'argument') return { obligation, realization: { kind: 'literal' } };
    if (obligation.kind === 'constraint' && obligation.constraint === 'role') return { obligation,
      realization: obligation.authoredText === 'dropdown' ? { kind: 'role_semantic', role: 'combobox' } :
        { kind: 'role_exact', role: obligation.authoredText as 'checkbox' | 'radio' | 'textbox' } };
    if (obligation.kind === 'constraint' && obligation.constraint === 'name') return { obligation,
      realization: { kind: 'name_exact', name: obligation.authoredText } };
    if (obligation.kind === 'constraint' && obligation.constraint === 'context') return { obligation,
      realization: { kind: 'label', text: 'Country', sourceSegmentIds: ['p4'], sourceSpan: goal.sourceAccounting[4]!.sourceSpan } };
    return { obligation, realization: { kind: 'pending' } };
  });
}
async function execute(run: Run, id = 's1') {
  const sourceGoal = run.admission.spec.steps.find((g) => g.id === id);
  if (sourceGoal?.type !== 'action_goal') throw new Error('Missing source action');
  const goal = structuredClone(sourceGoal) as ActionGoalV2, entries = correspondence(goal);
  const effect = goal.obligations.find((o) => o.kind === 'effect');
  const operation = effect?.kind === 'effect' && effect.effect === 'choose' ? 'select_option' :
    effect?.kind === 'effect' && effect.effect === 'enter_text' ? 'fill' : 'click';
  return executeActionGoalGroundingV1({ admission: run.admission, runtime: run.runtime, goalId: id,
    model: { complete: async () => JSON.stringify({ decisionVersion: '5', kind: 'ground', goalId: id, operation, correspondence: entries }) },
    independentModel: { extract: async () => JSON.stringify({ mappingExtractionVersion: '1', goalId: id, correspondence: entries }) } });
}
async function success(run: Run, builder: SuccessfulTraceAssemblerV5) {
  const outcome = await execute(run);
  expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded');
  if (outcome.status !== 'succeeded') throw new Error('No successful witness');
  builder.appendActionGroundingWitness(outcome.witness); return outcome;
}
async function artifact(run: Run) {
  const builder = await SuccessfulTraceAssemblerV5.create(run);
  const outcome = await success(run, builder);
  return { assembled: await builder.finalize(), outcome };
}

for (const fixture of [
  { title: 'unnamed native dropdown choice', html: select, goal: choose(), effect: 'native_choice' },
  { title: 'Country constrained choice', html: '<label for="country">Country</label>' + select.replace('<select>', '<select id="country">') + select,
    goal: choose('at'), effect: 'native_choice' },
  { title: 'unnamed native textbox fill', html: '<input>', goal: fill(), effect: 'entered_text' },
  { title: 'checkbox activation', html: '<input type="checkbox">', goal: check('checkbox'), effect: 'native_activation' },
  { title: 'radio activation', html: '<input type="radio">', goal: check('radio'), effect: 'native_activation' },
] as const) test(`v5 persists trusted ${fixture.title} with exact protected records`, async () => {
  const run = await harness(fixture.html, [fixture.goal]);
  try {
    const { assembled, outcome } = await artifact(run), store = new SuccessfulTraceV5Store(run.root);
    const readback = await store.writeSuccessfulExplorationV5(assembled);
    const persisted = requireTrustedSuccessfulTraceReadbackV5(readback);
    expect(persisted.trace.traceVersion).toBe('5'); expect(persisted.trace.source).toEqual(run.admission.spec);
    expect(persisted.trace.semanticAdmission).toEqual(run.admission.record);
    expect(persisted.capture.actions).toHaveLength(1);
    expect(persisted.capture.actions[0]!.witness).toEqual(outcome.witness);
    expect(outcome.witness.postEffect.effect.kind).toBe(fixture.effect);
    await run.session.close(); // Durable readback never needs to recreate runtime authority.
    const reopened = new SuccessfulTraceV5Store(run.root);
    expect(requireTrustedSuccessfulTraceReadbackV5(await reopened.readSuccessfulExplorationV5('trace-v5-fixture', 'wp3a-attempt'))).toEqual(persisted);
    await expect(store.writeSuccessfulExplorationV5(assembled)).rejects.toThrow();
  } finally { await run.close(); }
});

test('deferred observations retain actual main/nested accessibility snapshot digest meaning', async () => {
  const run = await harness('<input aria-label="Main"><iframe title="Child" srcdoc="<input aria-label=\'Nested\'>"></iframe>');
  try {
    const observations = new TrustedObservationSessionV1(run.session, run.runtime);
    const main = await observations.observe({ kind: 'semantic_query', query: { role: 'textbox', frame: { kind: 'main' } } });
    expect(main.status).toBe('complete');
    const snapshot = await run.page.locator('body').ariaSnapshot({ timeout: 3000 });
    const expected = createHash('sha256').update(snapshot).digest('hex');
    expect(main.frame).toEqual({ kind: 'main', snapshotDigest: expected });
    const nested = await observations.observe({ kind: 'semantic_query', query: { role: 'textbox', frame: { kind: 'nested',
      anchors: [{ kind: 'title', value: 'Child', exact: true }] } } });
    expect(nested.status).toBe('complete'); expect(nested.frame.kind).toBe('nested');
    if (nested.frame.kind === 'nested') expect(nested.frame.anchors[0]!.ownerSnapshotDigest).toBe(expected);
    const state = await run.runtime.protectedTraceState(); expect(main.stateDigest).toBe(state.stateDigest);
    expect(main.pageId).toBe(state.pageId); expect(nested.pageId).toBe(state.pageId);
  } finally { await run.close(); }
});

test('two eligible dropdowns, prepared checks and unproven/failed returns cannot complete a trace', async () => {
  for (const mode of ['ambiguous', 'unproven', 'failed'] as const) {
    const run = await harness(mode === 'ambiguous' ? select + select : '<input>', [mode === 'ambiguous' ? choose() : fill()]);
    const prototype = Object.getPrototypeOf(await run.page.locator(mode === 'ambiguous' ? 'select' : 'input').first().elementHandle()) as ElementHandle;
    const original = prototype.fill;
    try {
      const builder = await SuccessfulTraceAssemblerV5.create(run);
      if (mode === 'unproven') prototype.fill = async () => {};
      if (mode === 'failed') prototype.fill = async () => { throw new Error('fixture dispatch failure'); };
      const outcome = await execute(run); expect(outcome.status).toBe('stop');
      if (outcome.status === 'stop' && mode !== 'ambiguous') expect(outcome.executionAttempts[0]!.status).toBe(mode === 'failed' ? 'failed' : 'executed_unproven');
      expect(run.runtime.protectedSuccessfulGroundingWitnesses()).toHaveLength(0);
      await expect(builder.finalize()).rejects.toThrow();
      const prepared = run.runtime.protectedPreparedGrounding(outcome.executionAttempts[0]?.strategyId ?? 'missing');
      expect(() => builder.appendActionGroundingWitness(prepared)).toThrow();
    } finally { prototype.fill = original; await run.close(); }
  }
});

test('unchanged-state pre-dispatch retries retain only the final successful strategy and execution', async () => {
  const run = await harness(select);
  try {
    const builder = await SuccessfulTraceAssemblerV5.create(run);
    const original = run.runtime.prepareGrounding.bind(run.runtime); let prepares = 0;
    run.runtime.prepareGrounding = async (...args) => { if (++prepares === 1) throw new ActionCandidateGroundingError('BUSY'); return original(...args); };
    const outcome = await success(run, builder); expect(prepares).toBe(2);
    const value = requireAssembledSuccessfulTraceV5(await builder.finalize());
    expect(value.capture.actions).toHaveLength(1); expect(value.capture.actions[0]!.execution).toEqual(outcome.witness.execution);
    expect(value.trace.successfulPath).toHaveLength(1);
    expect(JSON.stringify(value)).not.toContain('BUSY');
  } finally { await run.close(); }
});

test('unrecorded first-action drift cannot silently rebase the successful path', async () => {
  const run = await harness(select);
  try {
    const builder = await SuccessfulTraceAssemblerV5.create(run);
    await run.page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<p>Unrecorded change</p>'));
    const outcome = await execute(run); expect(outcome.status).toBe('succeeded');
    if (outcome.status === 'succeeded') expect(() => builder.appendActionGroundingWitness(outcome.witness)).toThrow('state chain');
    await expect(builder.finalize()).rejects.toThrow();
  } finally { await run.close(); }
});

test('source start URL mismatch and first-action navigation drift fail closed', async () => {
  const run = await harness(select);
  try {
    await run.page.goto(run.url + 'other');
    await expect(SuccessfulTraceAssemblerV5.create(run)).rejects.toThrow('start URL');
    await run.page.goto(run.url);
    const builder = await SuccessfulTraceAssemblerV5.create(run);
    await run.page.goto(run.url + 'other');
    const outcome = await execute(run);
    if (outcome.status === 'succeeded') expect(() => builder.appendActionGroundingWitness(outcome.witness)).toThrow('state chain');
  } finally { await run.close(); }
});

test('copied admission/runtime/observer/controller and Object.create assembler cannot mint origin', async () => {
  const run = await harness('<input>', [fill()]);
  try {
    await expect(SuccessfulTraceAssemblerV5.create({ ...run, admission: { spec: structuredClone(run.admission.spec), record: structuredClone(run.admission.record) } as TrustedSemanticAdmissionV2 })).rejects.toThrow();
    const fake = Object.create(ActionCandidateGroundingSessionV1.prototype) as ActionCandidateGroundingSessionV1;
    fake.protectedTraceOwner = run.runtime.protectedTraceOwner.bind(run.runtime);
    fake.protectedTraceState = run.runtime.protectedTraceState.bind(run.runtime);
    await expect(SuccessfulTraceAssemblerV5.create({ ...run, runtime: fake })).rejects.toThrow();
    expect(() => requireAssembledSuccessfulTraceV5(Object.create(AssembledSuccessfulTraceV5.prototype) as AssembledSuccessfulTraceV5)).toThrow();
    expect(() => requireTrustedSuccessfulTraceReadbackV5(Object.create(TrustedSuccessfulTraceReadbackV5.prototype) as TrustedSuccessfulTraceReadbackV5)).toThrow();
    const observations = new TrustedObservationSessionV1(run.session, run.runtime);
    const fakeObserver = Object.create(TrustedObservationSessionV1.prototype) as TrustedObservationSessionV1;
    fakeObserver.protectedDeferredOwner = () => {};
    expect(() => new GoalDirectedVerificationControllerV1(fakeObserver, run.runtime, { complete: async () => '' })).toThrow();
    const controller = new GoalDirectedVerificationControllerV1(observations, run.runtime, { complete: async () => '' });
    await expect(SuccessfulTraceAssemblerV5.create({ ...run, observations,
      verification: Object.create(GoalDirectedVerificationControllerV1.prototype) as GoalDirectedVerificationControllerV1 })).rejects.toThrow();
    const other = new TrustedObservationSessionV1(run.session, run.runtime);
    await expect(SuccessfulTraceAssemblerV5.create({ ...run, observations: other, verification: controller })).rejects.toThrow('observation owner');
  } finally { await run.close(); }
});

test('fake assembler protectedArtifact and copied schema-valid witness are not trusted writes/actions', async () => {
  const run = await harness(select);
  try {
    const { assembled, outcome } = await artifact(run), value = requireAssembledSuccessfulTraceV5(assembled);
    const fake = Object.create(AssembledSuccessfulTraceV5.prototype) as AssembledSuccessfulTraceV5;
    fake.protectedArtifact = () => structuredClone(value);
    await expect(new SuccessfulTraceV5Store(run.root).writeSuccessfulExplorationV5(fake)).rejects.toThrow('Untrusted');
    const forged = structuredClone(outcome.witness); forged.witnessId = 'fabricated-witness';
    const { witnessDigest: _digest, ...data } = forged; forged.witnessDigest = hash(data);
    expect(run.runtime.protectedActionGroundingWitness(forged.witnessId)).toBeUndefined();
    expect(() => new AssembledSuccessfulTraceV5(Symbol('fake'), value)).toThrow();
  } finally { await run.close(); }
});

test('schema-valid forged witness and overridden instance readbacks cannot enter actual assembler', async () => {
  const run = await harness(select);
  try {
    const builder = await SuccessfulTraceAssemblerV5.create(run), outcome = await execute(run);
    if (outcome.status !== 'succeeded') throw new Error('Missing fixture witness');
    const fake = structuredClone(outcome.witness); fake.witnessId = 'forged-private-readback';
    const { witnessDigest: _digest, ...data } = fake; fake.witnessDigest = hash(data);
    run.runtime.protectedActionGroundingWitness = () => fake;
    expect(() => builder.appendActionGroundingWitness(fake)).toThrow('untrusted');
    builder.appendActionGroundingWitness(outcome.witness);
    expect(requireAssembledSuccessfulTraceV5(await builder.finalize()).capture.actions[0]!.witness).toEqual(outcome.witness);
  } finally { await run.close(); }
});

for (const mutation of ['value', 'dom', 'navigation', 'revision'] as const)
  test(`cleanup-time ${mutation} drift has no trace retirement/currentness authority`, async () => {
    const run = await harness('<input>', [fill()]);
    const handle = await run.page.locator('input').elementHandle();
    const prototype = Object.getPrototypeOf(handle) as ElementHandle;
    const inputValue = prototype.inputValue;
    let changed = false;
    try {
      const builder = await SuccessfulTraceAssemblerV5.create(run);
      prototype.inputValue = async function (...args) {
        if (!changed && run.runtime.protectedSuccessfulGroundingWitnesses().length) {
          changed = true;
          if (mutation === 'value') await run.page.evaluate(() => { document.querySelector('input')!.value = 'late substitution'; });
          if (mutation === 'dom') await run.page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<p>late material</p>'));
          if (mutation === 'navigation') await run.page.goto(run.url + 'changed');
          if (mutation === 'revision') await run.session.snapshot();
        }
        return inputValue.apply(this, args);
      };
      const outcome = await execute(run); expect(outcome.status).toBe('succeeded'); expect(changed).toBe(true);
      if (outcome.status === 'succeeded') {
        expect(run.runtime.protectedActionGroundingRetirement(outcome.witness.witnessId)).toBeUndefined();
        expect(() => builder.appendActionGroundingWitness(outcome.witness)).toThrow();
      }
      await expect(builder.finalize()).rejects.toThrow();
    } finally { prototype.inputValue = inputValue; await handle?.dispose(); await run.close(); }
  });

test('cleanup after an issued retirement receipt cannot bypass final fresh trace-state proof', async () => {
  const run = await harness('<input>', [fill()]);
  const handle = await run.page.locator('input').elementHandle(), prototype = Object.getPrototypeOf(handle) as ElementHandle;
  const dispose = prototype.dispose; let changed = false;
  try {
    const builder = await SuccessfulTraceAssemblerV5.create(run);
    prototype.dispose = async function () {
      const witness = run.runtime.protectedSuccessfulGroundingWitnesses()[0];
      if (!changed && witness && run.runtime.protectedActionGroundingRetirement(witness.witnessId)) {
        changed = true; await run.page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<p>after receipt drift</p>'));
      }
      return dispose.call(this);
    };
    const outcome = await execute(run); expect(outcome.status).toBe('succeeded'); expect(changed).toBe(true);
    if (outcome.status === 'succeeded') builder.appendActionGroundingWitness(outcome.witness);
    await expect(builder.finalize()).rejects.toThrow('final state drift');
  } finally { prototype.dispose = dispose; await handle?.dispose(); await run.close(); }
});

test('recomputed retirement receipt cannot replace exact protected post/current-state handoff', async () => {
  const run = await harness(select);
  try {
    const { assembled } = await artifact(run), value = requireAssembledSuccessfulTraceV5(assembled);
    const record = value.trace.successfulPath[0]; if (record?.type !== 'action_goal') throw new Error('Missing action');
    record.retirement.postEffectDigest = 'f'.repeat(64);
    const { witnessDigest: _receipt, ...receiptData } = record.retirement; record.retirement.witnessDigest = hash(receiptData);
    value.capture.actions[0]!.retirement = structuredClone(record.retirement);
    const { traceDigest: _trace, ...data } = value.trace; value.trace.traceDigest = successfulTraceDigestV5(data);
    expect(() => parseProtectedTraceCaptureBundleV5(value.capture, value.trace)).toThrow();
  } finally { await run.close(); }
});

test('authored navigation and subsequent deferred choice preserve complete source/state order', async () => {
  const run = await harness(select, (url) => [{ id: 'go', type: 'navigate', sourceText: `Go to ${url}.`,
    sourceInstructionSpan: { start: 0, end: 1 }, url }, choose()]);
  try {
    const builder = await SuccessfulTraceAssemblerV5.create(run);
    await run.session.navigate(run.url); run.runtime.invalidate();
    await builder.appendObservedNavigation('go'); await success(run, builder);
    const value = requireAssembledSuccessfulTraceV5(await builder.finalize());
    expect(value.trace.successfulPath.map((r) => r.type)).toEqual(['navigate', 'action_goal']);
    expect(value.trace.successfulPath[1]!.preStateDigest).toBe(value.trace.successfulPath[0]!.postStateDigest);
  } finally { await run.close(); }
});

test('existing temporal verification preserves present/action/absent ordering alongside deferred activation', async () => {
  const present: TestSpecV6V2['steps'][number] = { id: 'present', type: 'verification_goal', sourceText: 'Confirm the Notice dialog exists.',
    instruction: 'Confirm the Notice dialog exists.', subject: { role: 'dialog', accessibleName: 'Notice' }, intent: { kind: 'presence', expected: 'present' },
    sourceInstructionSpan: { start: 0, end: 1 } };
  const disappears: TestSpecV6V2['steps'][number] = { id: 'disappears', type: 'verification_goal', sourceText: 'Confirm the Notice dialog disappears.',
    instruction: 'Confirm the Notice dialog disappears.', subject: { role: 'dialog', accessibleName: 'Notice' }, intent: { kind: 'temporal', transition: 'disappears' },
    dependsOnStepId: 's1', sourceInstructionSpan: { start: 0, end: 1 } };
  const run = await harness('<div role="dialog" aria-label="Notice">Notice</div><input type="checkbox" onclick="document.querySelector(\'div\').remove()">', [present, check('checkbox'), disappears]);
  try {
    const observations = new TrustedObservationSessionV1(run.session, run.runtime);
    const controller = new GoalDirectedVerificationControllerV1(observations, run.runtime, { complete: async ({ context }) => JSON.stringify(
      context.observations.length ? { decisionVersion: '4', kind: 'conclude', conclusion: 'satisfied', comparison:
        context.goal.id === 'present' ? { kind: 'count', observationId: context.observations.at(-1)!.observationId, operator: 'greater_than', expected: 0 } :
          { kind: 'transition', operator: 'disappears', earlierObservationId: context.priorObservations[0]!.observation.observationId,
            laterObservationId: context.observations.at(-1)!.observationId } } :
        { decisionVersion: '4', kind: 'observe', request: { kind: 'semantic_query', query: { role: 'dialog', name: 'Notice', frame: { kind: 'main' } } } }) });
    const builder = await SuccessfulTraceAssemblerV5.create({ ...run, observations, verification: controller });
    expect((await controller.evaluate(run.admission.spec.steps[0], 0)).conclusion).toBe('satisfied'); await builder.appendVerificationGoal('present');
    const outcome = await success(run, builder); controller.noteSuccessfulGroundingWitness(outcome.witness);
    expect((await controller.evaluate(run.admission.spec.steps[2], 2)).conclusion).toBe('satisfied'); await builder.appendVerificationGoal('disappears');
    const value = requireAssembledSuccessfulTraceV5(await builder.finalize());
    const last = value.trace.successfulPath[2]; expect(last?.type).toBe('verification_goal');
    if (last?.type === 'verification_goal' && !('verificationVersion' in last)) expect(last.temporal!.transitionRecordIds).toEqual([value.trace.successfulPath[1]!.recordId]);
  } finally { await run.close(); }
});

for (const mutation of ['dropped_obligation', 'changed_obligation', 'argument_substitution', 'frame', 'state', 'order', 'generic_activation', 'failed_execution', 'no_post_proof'] as const)
  test(`v5 rejects recomputed-digest ${mutation} evidence`, async () => {
    const run = await harness(select);
    try {
      const { assembled } = await artifact(run), value = requireAssembledSuccessfulTraceV5(assembled);
      const record = value.trace.successfulPath[0]; if (record?.type !== 'action_goal') throw new Error('Missing action');
      if (mutation === 'dropped_obligation') record.witness.preparation.correspondence.pop();
      if (mutation === 'changed_obligation') record.witness.preparation.sourceGoal.obligations[0] = { id: 'e', kind: 'effect', effect: 'activate', sourceSegmentIds: ['p0'] };
      if (mutation === 'argument_substitution') record.witness.execution.executableArgument = 'fabricated';
      if (mutation === 'frame') record.witness.postEffect.after.frameId = 'another-frame';
      if (mutation === 'state') record.preStateDigest = 'f'.repeat(64);
      if (mutation === 'order') record.sequence = 2;
      if (mutation === 'generic_activation') Reflect.set(record.witness.postEffect, 'effect', { kind: 'generic_activation', delivered: true });
      if (mutation === 'failed_execution') record.witness.execution.status = 'executed_unproven';
      if (mutation === 'no_post_proof') Reflect.deleteProperty(record.witness, 'postEffect');
      const { traceDigest: _digest, ...data } = value.trace; value.trace.traceDigest = successfulTraceDigestV5(data);
      expect(() => parseProtectedTraceCaptureBundleV5(value.capture, value.trace)).toThrow();
    } finally { await run.close(); }
  });

test('stored trace/capture authentication prevents source tamper, copied-root and namespace substitution', async () => {
  const run = await harness(select);
  try {
    const { assembled } = await artifact(run), store = new SuccessfulTraceV5Store(run.root);
    await store.writeSuccessfulExplorationV5(assembled);
    const file = path.join(run.root, 'deferred-successful-trace-v5', 'trace-v5-fixture', 'wp3a-attempt.json');
    const original = await readFile(file, 'utf8');
    const forged = JSON.parse(original) as { artifact: { trace: { traceDigest: string; source: { sourceInstruction: string } } }; namespace: string };
    forged.artifact.trace.source.sourceInstruction = 'Changed source';
    const { traceDigest: _digest, ...data } = forged.artifact.trace; forged.artifact.trace.traceDigest = successfulTraceDigestV5(data);
    await writeFile(file, JSON.stringify(forged)); await expect(store.readSuccessfulExplorationV5('trace-v5-fixture', 'wp3a-attempt')).rejects.toThrow('authentication');
    await writeFile(file, original); forged.namespace = 'agentic-explorations-v4';
    await writeFile(file, JSON.stringify(forged)); await expect(store.readSuccessfulExplorationV5('trace-v5-fixture', 'wp3a-attempt')).rejects.toThrow();
    await writeFile(file, original);
    const otherRoot = path.join(run.root, 'other-root'), otherStore = new SuccessfulTraceV5Store(otherRoot);
    await otherStore.writeSuccessfulExplorationV5(assembled);
    const otherFile = path.join(otherRoot, 'deferred-successful-trace-v5', 'trace-v5-fixture', 'wp3a-attempt.json');
    await copyFile(file, otherFile);
    await expect(otherStore.readSuccessfulExplorationV5('trace-v5-fixture', 'wp3a-attempt')).rejects.toThrow('authentication');
    await mkdir(path.join(run.root, 'deferred-successful-trace-v5', 'another-source'));
    await copyFile(file, path.join(run.root, 'deferred-successful-trace-v5', 'another-source', 'wp3a-attempt.json'));
    await expect(store.readSuccessfulExplorationV5('another-source', 'wp3a-attempt')).rejects.toThrow('owner');
  } finally { await run.close(); }
});

test('generic button/link and historical source/trace readers remain separate', async () => {
  for (const [goal, html] of [[activate('Click', 'Save'), '<button>Save</button>'],
    [activate('Open', 'Add/Remove Elements'), '<a href="#next">Add/Remove Elements</a>']] as const) {
    const run = await harness(html, [goal]);
    try {
      const builder = await SuccessfulTraceAssemblerV5.create(run), outcome = await execute(run);
      expect(outcome).toMatchObject({ status: 'stop', category: 'unsupported' });
      await expect(builder.finalize()).rejects.toThrow();
      expect(() => parseTestSpec(run.admission.spec)).toThrow();
      expect(SuccessfulExplorationTraceV4Schema.safeParse({ traceVersion: '5' }).success).toBe(false);
    } finally { await run.close(); }
  }
});
