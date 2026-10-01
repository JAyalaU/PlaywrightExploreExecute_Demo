import { test, expect } from '@playwright/test';
import { createOpenAIDeferredActionInterpretationModel,
  interpretDeferredActionTask, createOpenAIActionSemanticExtractionModelsV2,
  interpretDeferredActionTaskV2 } from '../app/interpretation/index.js';
import { action, choose, spec } from './helpers/action-v2-fixtures.js';
import { unspannedWire } from './helpers/deferred-v3-wire.js';

function providerBody(output: unknown) {
  return { status: 'completed', error: null, incomplete_details: null,
    output: [{ type: 'message', status: 'completed', role: 'assistant', content: [
      { type: 'output_text', text: JSON.stringify(output) },
    ] }] };
}

test('historical ActionGoal v1 remains readable with its recorded absorbed-target defect', async () => {
  // Historical evidence only. This adapter cannot grant successor semantic admission.
  const source = 'Choose Option 1 at the Country dropdown.';
  const output = { response: { kind: 'test_spec', steps: [{
    id: 's1', type: 'action_goal', goalVersion: '1', sourceStepId: 's1', sourceText: source,
    sourceInstructionSpan: { start: 0, end: 40 },
    effect: 'choose', effectSourceSpan: { start: 0, end: 6 }, explicitOperation: null,
    argument: { purpose: 'choice', authoredText: 'Option 1 at the Country dropdown',
      sourceSpan: { start: 7, end: 39 } },
    targetConstraints: [], prerequisiteContext: null,
  }] } };
  const model = createOpenAIDeferredActionInterpretationModel({ apiKey: () => 'mock-key',
    fetchImpl: (async () => new Response(JSON.stringify(providerBody(output)))) as typeof fetch });
  const result = await interpretDeferredActionTask({ sourceInstruction: source, testSpecId: 'wp1-gate',
    executionProfileRef: { id: 'desktop', version: '1' }, startState: { url: 'about:blank' } }, model);

  expect(result.kind).toBe('accepted');
  expect(result).not.toHaveProperty('admission');
});

test('successor rejects absorbed dropdown wording after source-first extraction through actual adapters', async () => {
  const bad = spec(action([['Choose', 'effect'], [' ', 'neutral'], ['Option 1 at the Country dropdown', 'argument'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option 1 at the Country dropdown', sourceSegmentIds: ['p2'] },
  ]));
  const faithful = spec(choose('at')); let calls = 0;
  const outputs = [unspannedWire(bad, 'primary'), unspannedWire(faithful, 'independent')];
  const models = createOpenAIActionSemanticExtractionModelsV2({ apiKey: () => 'mock-key', fetchImpl: (async () => {
    const output = outputs[calls++]!;
    return new Response(JSON.stringify(providerBody(output)));
  }) as typeof fetch });
  const { testSpecId, sourceInstruction, executionProfileRef, startState } = bad;
  const result = await interpretDeferredActionTaskV2({ testSpecId, sourceInstruction, executionProfileRef, startState }, models);
  expect(calls).toBe(2);
  expect(result).toMatchObject({ kind: 'rejected', stop: { stage: 'admission', code: 'SEMANTIC_FIDELITY_MISMATCH' } });
  expect(result).not.toHaveProperty('admission'); expect(result).not.toHaveProperty('handoff');
});
