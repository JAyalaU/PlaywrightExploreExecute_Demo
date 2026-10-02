import { test, expect } from '@playwright/test';
import { createOpenAIActionSemanticExtractionModelsV2, interpretDeferredActionTaskV2 } from '../app/interpretation/index.js';
import type { ActionGoalV2, TestSpecV6V2 } from '../app/domain/index.js';
import { action, spec } from './helpers/action-v2-fixtures.js';
import { unspannedWire } from './helpers/deferred-v3-wire.js';
import type { InterpretationRequest } from '../app/interpretation/index.js';

const primaryWire = (draft: TestSpecV6V2) => unspannedWire(draft, 'primary');
const independentWire = (draft: TestSpecV6V2) => unspannedWire(draft, 'independent');
const providerBody = (wire: unknown) => ({ status: 'completed', error: null, incomplete_details: null,
  output: [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(wire) }] }] });
function request(draft: TestSpecV6V2): InterpretationRequest {
  const { testSpecId, sourceInstruction, executionProfileRef, startState } = draft;
  return { testSpecId, sourceInstruction, executionProfileRef, startState };
}

async function actualAdapter(primary: TestSpecV6V2, independent: TestSpecV6V2 = primary) {
  const wires = [primaryWire(primary), independentWire(independent)];
  const bodies: Array<Record<string, unknown>> = [];
  const models = createOpenAIActionSemanticExtractionModelsV2({ apiKey: () => 'gate-mock-key', fetchImpl: (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(providerBody(wires[bodies.length - 1])));
  }) as typeof fetch });
  return { outcome: await interpretDeferredActionTaskV2(request(primary), models), bodies };
}

test('source-first extraction sees only source and contract while independent formats admit paraphrase without lexical authority', async () => {
  const cases = [
    action([['Tap', 'effect'], [' ', 'neutral'], ['Save', 'target'], ['.', 'neutral']], [
      { id: 'e', kind: 'effect', effect: 'activate', sourceSegmentIds: ['p0'] },
      { id: 'n', kind: 'constraint', constraint: 'name', subject: { kind: 'target' }, polarity: 'positive', authoredText: 'Save', sourceSegmentIds: ['p2'] },
    ]),
    action([['Choose', 'effect'], [' ', 'neutral'], ['Option 1', 'argument'], [' using ', 'context'], ['Country', 'target'], [' dropdown', 'target'], ['.', 'neutral']], [
      { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: ['p0'] },
      { id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option 1', sourceSegmentIds: ['p2'] },
      { id: 'n', kind: 'constraint', constraint: 'name', subject: { kind: 'target' }, polarity: 'positive', authoredText: 'Country', sourceSegmentIds: ['p4'] },
      { id: 'r', kind: 'constraint', constraint: 'role', subject: { kind: 'target' }, polarity: 'positive', authoredText: ' dropdown', sourceSegmentIds: ['p5'] },
      { id: 'c', kind: 'constraint', constraint: 'context', subject: { kind: 'target' }, polarity: 'positive', authoredText: ' using Country dropdown', sourceSegmentIds: ['p3', 'p4', 'p5'] },
    ]),
  ];
  const source = spec(cases[0]!);
  const second = spec(cases[1]!);
  const result = await actualAdapter(second);
  expect(result.outcome.kind).toBe('accepted');
  expect(result.bodies).toHaveLength(2);
  expect(result.bodies.map((body) => (body.text as { format: { name: string } }).format.name)).toEqual([
    'qa_deferred_action_interpretation_v10', 'qa_deferred_action_source_first_v6',
  ]);
  expect(result.bodies[0]!.input).toBe(second.sourceInstruction);
  expect(result.bodies[1]!.input).toBe(second.sourceInstruction);
  expect(JSON.stringify(result.bodies[1])).not.toContain(JSON.stringify(primaryWire(source)));
  expect(JSON.stringify(result.bodies[1])).not.toContain('executionProfileRef');
  expect(JSON.stringify(result.bodies[1]!.input)).toBe(JSON.stringify(second.sourceInstruction));
});

test('faithful source-first Country ownership rejects a primary that absorbs Country into the literal', async () => {
  const faithful = spec(action([['Choose', 'effect'], [' ', 'neutral'], ['Option 1', 'argument'], [' at ', 'context'],
    ['Country', 'target'], [' dropdown', 'target'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option 1', sourceSegmentIds: ['p2'] },
    { id: 'n', kind: 'constraint', constraint: 'name', subject: { kind: 'target' }, polarity: 'positive', authoredText: 'Country', sourceSegmentIds: ['p4'] },
    { id: 'r', kind: 'constraint', constraint: 'role', subject: { kind: 'target' }, polarity: 'positive', authoredText: ' dropdown', sourceSegmentIds: ['p5'] },
    { id: 'c', kind: 'constraint', constraint: 'context', subject: { kind: 'target' }, polarity: 'positive', authoredText: ' at Country dropdown', sourceSegmentIds: ['p3', 'p4', 'p5'] },
  ]));
  const absorbed = structuredClone(faithful);
  const goal = absorbed.steps[0] as ActionGoalV2;
  goal.obligations = goal.obligations.filter((item) => item.kind === 'effect');
  goal.obligations.push({ id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option 1 at Country dropdown',
    sourceSegmentIds: ['p2', 'p3', 'p4', 'p5'] });
  goal.sourceAccounting = goal.sourceAccounting.map((segment) => ['p2', 'p3', 'p4', 'p5'].includes(segment.id) ?
    { ...segment, classification: 'argument' as const, obligationIds: ['a'] } : segment);
  const { outcome, bodies } = await actualAdapter(absorbed, faithful);
  expect(bodies).toHaveLength(2);
  expect(outcome).toMatchObject({ kind: 'rejected', stop: { category: 'omission_fidelity', code: 'SEMANTIC_FIDELITY_MISMATCH' } });
});

test('legacy ActionGoal v1 cannot mint the new trusted semantic admission or trigger a fallback call', async () => {
  const current = spec(action([['Select', 'effect'], [' ', 'neutral'], ['Option 1', 'argument'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option 1', sourceSegmentIds: ['p2'] },
  ]));
  let calls = 0;
  const models = createOpenAIActionSemanticExtractionModelsV2({ apiKey: () => 'gate-mock-key', fetchImpl: (async () => {
    calls++;
    return new Response(JSON.stringify(providerBody({ response: { kind: 'test_spec', schemaVersion: '6',
      steps: [{ id: 's1', type: 'action_goal', goalVersion: '1' }] } })));
  }) as typeof fetch });
  const outcome = await interpretDeferredActionTaskV2(request(current), models);
  expect(outcome).toMatchObject({ kind: 'rejected', stop: { category: 'structural', code: 'INVALID_SOURCE_REPRESENTATION', stage: 'primary' } });
  expect(calls).toBe(1);
  expect(outcome).not.toHaveProperty('admission');
});

test('fragmented primary literal rejects mechanically before faithful independent extraction', async () => {
  const faithful = spec(action([['Select', 'effect'], [' ', 'neutral'], ['Option and 1', 'argument'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option and 1', sourceSegmentIds: ['p2'] },
  ]));
  const fragmented = structuredClone(faithful);
  const goal = fragmented.steps[0] as ActionGoalV2;
  goal.obligations.find((item) => item.kind === 'argument')!.authoredText = 'Option1';
  goal.obligations.find((item) => item.kind === 'argument')!.sourceSegmentIds = ['p2', 'p4'];
  goal.sourceAccounting = [
    { id: 'p0', sourceSpan: { start: 0, end: 6 }, authoredText: 'Select', classification: 'effect', obligationIds: ['e'] },
    { id: 'p1', sourceSpan: { start: 6, end: 7 }, authoredText: ' ', classification: 'neutral', obligationIds: [] },
    { id: 'p2', sourceSpan: { start: 7, end: 13 }, authoredText: 'Option', classification: 'argument', obligationIds: ['a'] },
    { id: 'p3', sourceSpan: { start: 13, end: 18 }, authoredText: ' and ', classification: 'neutral', obligationIds: [] },
    { id: 'p4', sourceSpan: { start: 18, end: 19 }, authoredText: '1', classification: 'argument', obligationIds: ['a'] },
    { id: 'p5', sourceSpan: { start: 19, end: 20 }, authoredText: '.', classification: 'neutral', obligationIds: [] },
  ];
  // The exact concatenation of referenced spans is "Option1", which never occurs in the source clause.
  const { outcome, bodies } = await actualAdapter(fragmented, faithful);
  expect(outcome).toMatchObject({ kind: 'rejected', stop: { category: 'structural',
    code: 'INVALID_SOURCE_REPRESENTATION', stage: 'primary' } });
  expect(bodies).toHaveLength(1);
  expect(outcome).not.toHaveProperty('admission');
  const independentFailure = await actualAdapter(faithful, fragmented);
  expect(independentFailure.outcome).toMatchObject({ kind: 'rejected', stop: { category: 'structural',
    code: 'INVALID_SOURCE_REPRESENTATION', stage: 'independent' } });
  expect(independentFailure.bodies).toHaveLength(2);
  expect(independentFailure.outcome).not.toHaveProperty('admission');
});

test('identical fragmented literal extractions are rejected because the assembled argument is not authored contiguously', async () => {
  const source = spec(action([['Select', 'effect'], [' ', 'neutral'], ['Option', 'argument'], [' and ', 'neutral'],
    ['1', 'argument'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option1', sourceSegmentIds: ['p2', 'p4'] },
  ]));
  const { outcome, bodies } = await actualAdapter(source);
  expect(outcome).toMatchObject({ kind: 'rejected', stop: { category: 'structural', code: 'INVALID_SOURCE_REPRESENTATION', stage: 'primary' } });
  expect(bodies).toHaveLength(1);
  expect(outcome).not.toHaveProperty('admission');
});
