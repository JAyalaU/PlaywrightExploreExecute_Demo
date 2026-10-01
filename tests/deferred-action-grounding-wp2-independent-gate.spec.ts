import http from 'node:http';
import { once } from 'node:events';
import { expect, test } from '@playwright/test';
import { ActionCandidateGroundingSessionV1 } from '../app/exploration/action-candidate-grounding.js';
import { McpExplorationSession } from '../app/exploration/mcp.js';
import { ProtectedContextFactory, ProfileCatalog } from '../app/profile/index.js';
import type { GroundingCorrespondenceV1 } from '../app/domain/action-grounding-strategy.js';
import { executeActionGoalGroundingV1 } from '../app/interpretation/action-grounding-execution-controller.js';
import { createOpenAIActionSemanticExtractionModelsV2, interpretDeferredActionTaskV2 } from '../app/interpretation/index.js';
import type { ActionGoalV2, TestSpecV6V2 } from '../app/domain/index.js';
import { action, activate, choose } from './helpers/action-v2-fixtures.js';

const optionSelect = '<select><option value="">Choose</option><option value="dom-choice-1">Option 1</option></select>';

function draftFor(source: ActionGoalV2, url: string): TestSpecV6V2 {
  return { schemaVersion: '6', sourceContractVersion: '2', testSpecId: 'wp2-gate', sourceInstruction: source.sourceText,
    executionProfileRef: { id: 'desktop', version: '1' }, startState: { url }, steps: [structuredClone(source)],
    instructionAccounting: [{ classification: 'clause', stepId: source.id,
      sourceSpan: { start: 0, end: source.sourceText.length }, authoredText: source.sourceText }] };
}

function extractionWire(draft: TestSpecV6V2, independent: boolean) {
  return independent
    ? { response: { kind: 'source_extraction', clauses: draft.steps, instructionAccounting: draft.instructionAccounting } }
    : { response: { kind: 'extraction', steps: draft.steps, instructionAccounting: draft.instructionAccounting } };
}

async function harness(html: string, goal: ActionGoalV2, independentGoal: ActionGoalV2 = goal) {
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('loopback fixture port unavailable');
  const url = `http://127.0.0.1:${addr.port}/`;
  const draft = draftFor(goal, url), independentDraft = draftFor(independentGoal, url);
  const responseInputs: string[] = [], responseInstructions: string[] = [];
  const adapters = createOpenAIActionSemanticExtractionModelsV2({ apiKey: () => 'mock-key', fetchImpl: (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string; instructions: string };
    responseInputs.push(body.input); responseInstructions.push(body.instructions);
    const wire = extractionWire(responseInputs.length === 1 ? draft : independentDraft, responseInputs.length !== 1);
    return new Response(JSON.stringify({ status: 'completed', error: null, incomplete_details: null,
      output: [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(wire) }] }] }));
  }) as typeof fetch });
  const interpreted = await interpretDeferredActionTaskV2({ testSpecId: draft.testSpecId, sourceInstruction: draft.sourceInstruction,
    executionProfileRef: draft.executionProfileRef, startState: draft.startState }, adapters);
  if (interpreted.kind !== 'accepted') throw new Error(`mocked source admission did not accept: ${JSON.stringify(interpreted.stop)}`);
  const factory = new ProtectedContextFactory(new ProfileCatalog([{
    id: 'desktop', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 3000, navigationMs: 5000, waits: { default: 3000 } }, networkPolicyRef: { id: 'local', version: '1' },
  }], [{ id: 'local', version: '1', destinations: [{ host: '127.0.0.1', ports: [addr.port], addresses: ['127.0.0.1'] }] }]));
  const session = await McpExplorationSession.open(factory, interpreted.admission.spec.executionProfileRef,
    factory.catalog.resolve(interpreted.admission.spec.executionProfileRef), 'wp2-independent-gate');
  await session.navigate(url);
  const runtime = new ActionCandidateGroundingSessionV1(session, interpreted.admission, 'wp2-independent-gate');
  return { admission: interpreted.admission, goal: interpreted.admission.spec.steps[0] as ActionGoalV2,
    runtime, session, page: session.browserSession.context.pages()[0]!, responseInputs, responseInstructions,
    close: async () => { await session.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); } };
}

function correspondence(goal: ActionGoalV2, labelContext = false): GroundingCorrespondenceV1 {
  return goal.obligations.map((obligation) => {
    if (obligation.kind === 'effect' || obligation.kind === 'operation') return { obligation, realization: { kind: obligation.kind } };
    if (obligation.kind === 'argument') return { obligation, realization: { kind: 'literal' } };
    if (obligation.kind === 'constraint' && obligation.constraint === 'role') return { obligation,
      realization: obligation.authoredText === 'dropdown' ? { kind: 'role_semantic', role: 'combobox' } : { kind: 'role_exact', role: 'textbox' } };
    if (obligation.kind === 'constraint' && (obligation.constraint === 'name' || obligation.constraint === 'context')) return { obligation,
      realization: labelContext || obligation.constraint === 'context'
        ? (() => { const sourceSegment = goal.sourceAccounting.find((segment) => segment.authoredText === 'Country');
          return sourceSegment ? { kind: 'label' as const, text: 'Country', sourceSegmentIds: [sourceSegment.id],
            sourceSpan: sourceSegment.sourceSpan } : { kind: 'pending' as const }; })()
        : { kind: 'name_exact', name: obligation.authoredText } };
    return { obligation, realization: { kind: 'pending' } };
  });
}

function mappingModels(run: Awaited<ReturnType<typeof harness>>, entries: GroundingCorrespondenceV1,
  independentEntries = entries, operation: 'click' | 'select_option' = 'select_option') {
  const primaryContexts: unknown[] = [], independentContexts: unknown[] = [];
  return { primaryContexts, independentContexts,
    model: { complete: async ({ context }: { context: unknown }) => {
      primaryContexts.push(structuredClone(context));
      const value = context as { goal?: { id?: string } };
      return JSON.stringify({ decisionVersion: '5', kind: 'ground', goalId: value.goal?.id ?? run.goal.id, operation, correspondence: entries });
    } },
    independentModel: { extract: async ({ context }: { context: unknown }) => {
      independentContexts.push(structuredClone(context));
      return JSON.stringify({ mappingExtractionVersion: '1', goalId: run.goal.id, correspondence: independentEntries });
    } } };
}

test('end-to-end Select Option 1 uses two source extractions, no target name, and a runtime-derived value', async () => {
  const run = await harness(optionSelect, choose());
  try {
    expect(run.responseInputs).toEqual([run.goal.sourceText, run.goal.sourceText]);
    expect(run.responseInstructions[0]).not.toBe(run.responseInstructions[1]);
    const entries = correspondence(run.goal), models = mappingModels(run, entries, entries, 'select_option');
    const outcome = await executeActionGoalGroundingV1({ admission: run.admission, goalId: run.goal.id, runtime: run.runtime,
      model: models.model, independentModel: models.independentModel });
    expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded');
    expect(models.independentContexts).toHaveLength(0); // Exact typed literal mapping requires no semantic inference.
    expect((models.primaryContexts[0] as { goal: ActionGoalV2 }).goal.obligations.map((item) => item.kind)).toEqual(['effect', 'argument']);
    if (outcome.status === 'succeeded') {
      expect(outcome.witness.preparation.candidateObservation.predicate.names).toEqual([]);
      expect(outcome.witness.preparation.argument).toMatchObject({ kind: 'native_choice', authoredText: 'Option 1', executableValue: 'dom-choice-1' });
      expect(outcome.witness.postEffect.effect).toMatchObject({ kind: 'native_choice', value: 'dom-choice-1' });
      expect(outcome.witness.preparation.correspondence.map((item) => item.obligation.id).sort()).toEqual(['a', 'e']);
      expect(run.runtime.protectedActionGroundingWitness(outcome.witness.witnessId)).toEqual(outcome.witness);
    }
    expect(await run.page.locator('select').inputValue()).toBe('dom-choice-1');
  } finally { await run.close(); }
});

test('the identical unqualified choice stops before mutation when two dropdowns own Option 1', async () => {
  const run = await harness(optionSelect + optionSelect.replace('dom-choice-1', 'other-dom-choice'), choose());
  try {
    const models = mappingModels(run, correspondence(run.goal), correspondence(run.goal), 'select_option');
    const outcome = await executeActionGoalGroundingV1({ admission: run.admission, goalId: run.goal.id, runtime: run.runtime,
      model: models.model, independentModel: models.independentModel });
    expect(outcome).toMatchObject({ status: 'stop', category: 'unresolved', reason: 'NON_UNIQUE' });
    expect(await run.page.locator('select').nth(0).inputValue()).toBe('');
    expect(await run.page.locator('select').nth(1).inputValue()).toBe('');
  } finally { await run.close(); }
});

test('Country constrained choice is independently endorsed and narrows only by owned label evidence', async () => {
  const source = choose('at');
  const html = '<label for="country">Country</label><select id="country"><option value="">Choose</option><option value="country-value">Option 1</option></select>' + optionSelect;
  const run = await harness(html, source);
  try {
    const entries = correspondence(run.goal, true), models = mappingModels(run, entries, entries, 'select_option');
    const outcome = await executeActionGoalGroundingV1({ admission: run.admission, goalId: run.goal.id, runtime: run.runtime,
      model: models.model, independentModel: models.independentModel });
    expect(models.independentContexts).toHaveLength(1);
    const independentContext = models.independentContexts[0] as Record<string, unknown>;
    expect(independentContext).toHaveProperty('sourceInstruction', run.admission.spec.sourceInstruction);
    for (const forbidden of ['decision', 'correspondence', 'priorCandidate', 'selectedRef', 'browserState', 'snapshot'])
      expect(independentContext).not.toHaveProperty(forbidden);
    expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded');
    if (outcome.status === 'succeeded') {
      expect(outcome.witness.preparation.candidateObservation).toMatchObject({ count: 2 });
      expect(outcome.witness.preparation.labelEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ count: 1 })]));
      expect(outcome.witness.preparation.correspondence).toHaveLength(entries.length);
    }
    expect(await run.page.locator('#country').inputValue()).toBe('country-value');
    expect(await run.page.locator('select').nth(1).inputValue()).toBe('');
  } finally { await run.close(); }
});

test('same admitted mapping with discrepant independent endorsement cannot dispatch', async () => {
  const source = choose('at');
  const run = await harness('<label for="country">Country</label><select id="country">' +
    '<option value="">Choose</option><option value="country-value">Option 1</option></select>', source);
  try {
    const entries = correspondence(run.goal, true), disagreement = structuredClone(entries);
    const context = disagreement.find((item) => item.obligation.kind === 'constraint' && item.obligation.constraint === 'context');
    if (!context || context.obligation.kind !== 'constraint') throw new Error('fixture context obligation missing');
    context.realization = { kind: 'pending' };
    const models = mappingModels(run, entries, disagreement, 'select_option');
    const outcome = await executeActionGoalGroundingV1({ admission: run.admission, goalId: run.goal.id, runtime: run.runtime,
      model: models.model, independentModel: models.independentModel });
    expect(outcome).toMatchObject({ status: 'stop', category: 'semantic_disagreement' });
    expect(await run.page.locator('select').inputValue()).toBe('');
  } finally { await run.close(); }
});

for (const activation of [
  { source: activate('Click', 'Save'), html: '<button onclick="this.textContent=\'changed\'">Save</button>', expected: 'Save' },
  { source: activate('Open', 'Add/Remove Elements'), html: '<a href="#opened" onclick="this.textContent=\'changed\'">Add/Remove Elements</a>', expected: 'Add/Remove Elements' },
] as const) test(`actual source/admission path stops generic ${activation.source.sourceText} before mutation`, async () => {
  const run = await harness(activation.html, activation.source);
  try {
    const models = mappingModels(run, correspondence(run.goal), correspondence(run.goal), 'click');
    const initialUrl = run.page.url();
    const outcome = await executeActionGoalGroundingV1({ admission: run.admission, goalId: run.goal.id, runtime: run.runtime,
      model: models.model, independentModel: models.independentModel });
    expect(outcome).toMatchObject({ status: 'stop', category: 'unsupported', reason: 'UNSUPPORTED_OPERATION',
      executionAttempts: [{ status: 'rejected', attempted: false, reason: 'UNSUPPORTED_OPERATION' }] });
    expect(outcome).not.toHaveProperty('witness');
    expect(await run.page.locator(activation.html.startsWith('<button') ? 'button' : 'a').textContent()).toBe(activation.expected);
    expect(run.page.url()).toBe(initialUrl);
    expect(models.primaryContexts).toHaveLength(1);
  } finally { await run.close(); }
});
