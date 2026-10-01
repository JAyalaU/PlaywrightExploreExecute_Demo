import { expect, test } from '@playwright/test';
import { interpretDeferredActionTaskV2, projectActionSemanticStopV2 } from '../app/interpretation/deferred-action-v2-interpret.js';
import { createOpenAIActionSemanticExtractionModelsV2 } from '../app/interpretation/deferred-action-v2-adapters.js';
import { DeferredWorkflowPrivateAccountingV1Schema } from '../app/domain/deferred-workflow-accounting.js';
import { choose, spec } from './helpers/action-v2-fixtures.js';
import type { TestSpecV6V2, ActionGoalV2 } from '../app/domain/index.js';
import { unspannedWire } from './helpers/deferred-v3-wire.js';

const source = () => spec(choose('at'));
const request = (s: TestSpecV6V2) => ({ testSpecId: s.testSpecId, sourceInstruction: s.sourceInstruction,
  executionProfileRef: s.executionProfileRef, startState: s.startState });
const response = (s: TestSpecV6V2) => JSON.stringify({ kind: 'extraction', steps: s.steps,
  instructionAccounting: s.instructionAccounting });
async function direct(bad: TestSpecV6V2, phase: 'primary' | 'independent') {
  const valid = source(), calls: string[] = [];
  const models = { primary: { complete: async () => { calls.push('primary'); return response(phase === 'primary' ? bad : valid); } },
    independent: { complete: async () => { calls.push('independent'); return response(phase === 'independent' ? bad : valid); } } };
  const outcome = await interpretDeferredActionTaskV2(request(valid), models);
  expect(calls).toEqual(phase === 'primary' ? ['primary'] : ['primary', 'independent']);
  expect(outcome).toMatchObject({ kind: 'rejected', stop: { category: 'structural', stage: phase,
    code: 'INVALID_SOURCE_REPRESENTATION' }, structuralDiagnostic: { phase } });
  if (outcome.kind !== 'rejected') throw new Error('Expected structural stop');
  expect(outcome.timing?.phase).toBe(phase);
  const safe = projectActionSemanticStopV2(outcome);
  expect(safe).not.toHaveProperty('structuralDiagnostic');
  expect(JSON.stringify(safe)).not.toContain(valid.sourceInstruction);
  const accounting = DeferredWorkflowPrivateAccountingV1Schema.parse({ groundingAttempts: [], successfulWitnesses: [],
    interpretationTiming: outcome.timing, interpretationStructural: outcome.structuralDiagnostic });
  expect(accounting.interpretationStructural).toEqual(outcome.structuralDiagnostic);
  expect(JSON.stringify(accounting.interpretationStructural)).not.toMatch(/Country|Option 1|http|authoredText|sourceText|sourceInstruction|selector/);
  return outcome.structuralDiagnostic!;
}

for (const phase of ['primary', 'independent'] as const) {
  test(`${phase} span, source partition, ownership and argument failures have bounded private paths`, async () => {
    const span = source(); (span.steps[0] as ActionGoalV2).sourceAccounting[2]!.sourceSpan.end--;
    expect(await direct(span, phase)).toMatchObject({ component: 'span_provenance', issueCode: 'SPAN_OR_LITERAL_MISMATCH',
      path: { stepIndex: 0, stepType: 'action_goal' } });
    const partition = source(); partition.instructionAccounting[0]!.sourceSpan.end--;
    expect(await direct(partition, phase)).toMatchObject({ component: 'source_accounting',
      issueCode: 'SOURCE_ACCOUNTING_INVALID', path: { field: 'instructionAccounting', itemIndex: 0 } });
    const ownership = source(); (ownership.steps[0] as ActionGoalV2).obligations.find(o => o.kind === 'argument')!.sourceSegmentIds = ['p4'];
    expect(await direct(ownership, phase)).toMatchObject({ component: 'action_goal', issueCode: 'ACTION_OWNERSHIP_INVALID',
      path: { stepIndex: 0, stepType: 'action_goal' } });
    const argument = source(); const arg = (argument.steps[0] as ActionGoalV2).obligations.find(o => o.kind === 'argument');
    if (arg?.kind !== 'argument') throw new Error('Fixture'); arg.authoredText = 'PRIVATE_VALUE';
    expect(await direct(argument, phase)).toMatchObject({ component: 'action_goal', issueCode: 'ACTION_ARGUMENT_INVALID',
      path: { stepIndex: 0, field: 'obligations' } });
  });
}

test('native VerificationGoal v2 structural error identifies claim without option text', async () => {
  const text = 'Verify that Option 1 is selected.';
  const goal = { id: 'verify', type: 'verification_goal' as const, verificationVersion: '2' as const,
    sourceText: text, instruction: text, sourceInstructionSpan: { start: 0, end: text.length },
    claim: { kind: 'native_owned_option_selected' as const, optionLabel: 'Option 1',
      optionSourceSpan: { start: text.indexOf('Option 1'), end: text.indexOf('Option 1') + 8 },
      expectedSelected: true, controlConstraints: [] } };
  const valid: TestSpecV6V2 = { ...source(), sourceInstruction: text, steps: [goal],
    instructionAccounting: [{ classification: 'clause', stepId: goal.id, authoredText: text,
      sourceSpan: goal.sourceInstructionSpan }] };
  const bad = structuredClone(valid); (bad.steps[0] as typeof goal).claim.optionLabel = 'PRIVATE_OPTION';
  const models = { primary: { complete: async () => response(bad) }, independent: { complete: async () => response(valid) } };
  const result = await interpretDeferredActionTaskV2(request(valid), models);
  expect(result).toMatchObject({ kind: 'rejected', structuralDiagnostic: { phase: 'primary', component: 'span_provenance',
    issueCode: 'SPAN_OR_LITERAL_MISMATCH', path: { stepIndex: 0, stepType: 'verification_goal' } } });
  if (result.kind === 'rejected') expect(JSON.stringify(result.structuralDiagnostic)).not.toContain('PRIVATE_OPTION');
});

test('wire unknown field/version have safe machine codes through mocked adapter', async () => {
  const valid = source();
  for (const [edit, expectedCode] of [
    [(step: Record<string, unknown>) => { step.goalVersion = '999'; }, 'UNKNOWN_VERSION'],
    [(step: Record<string, unknown>) => { step.privateSelector = 'PRIVATE_SELECTOR'; }, 'UNKNOWN_FIELD'],
  ] as const) {
    const bad = structuredClone(valid);
    edit(bad.steps[0] as unknown as Record<string, unknown>);
    let calls = 0;
    const models = createOpenAIActionSemanticExtractionModelsV2({ apiKey: () => 'mock', fetchImpl: (async () => {
      calls++;
      const wire = unspannedWire(bad, 'primary');
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify(wire) }] }] }));
    }) as typeof fetch });
    const outcome = await interpretDeferredActionTaskV2(request(valid), models);
    expect(calls).toBe(1);
    expect(outcome).toMatchObject({ kind: 'rejected', stop: { code: 'INVALID_SOURCE_REPRESENTATION', stage: 'primary' },
      structuralDiagnostic: { component: 'wire_normalization', path: { stepIndex: 0, stepType: 'action_goal' } } });
    if (outcome.kind !== 'rejected') throw new Error('Expected structural stop');
    expect(outcome.structuralDiagnostic?.issueCode).toBe(expectedCode);
    expect(JSON.stringify(outcome.structuralDiagnostic)).not.toContain('PRIVATE_SELECTOR');
  }
});

test('private schema is closed, old accounting readable, and public stop cannot include diagnostics', async () => {
  const old = DeferredWorkflowPrivateAccountingV1Schema.parse({ groundingAttempts: [], successfulWitnesses: [] });
  expect(old).not.toHaveProperty('interpretationStructural');
  const bad = source(); (bad.steps[0] as ActionGoalV2).sourceStepId = 'wrong';
  const issue = await direct(bad, 'primary');
  expect(() => DeferredWorkflowPrivateAccountingV1Schema.parse({ groundingAttempts: [], successfulWitnesses: [],
    interpretationStructural: { ...issue, sourceText: 'PRIVATE' } })).toThrow();
});
