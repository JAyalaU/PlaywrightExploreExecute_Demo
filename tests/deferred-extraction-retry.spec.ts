import { expect, test } from '@playwright/test';
import { createOpenAIActionSemanticExtractionModelsV2 } from '../app/interpretation/deferred-action-v2-adapters.js';
import { interpretDeferredActionTaskV2, projectActionSemanticStopV2,
  DEFERRED_INTERPRETATION_DEADLINE_POLICY } from '../app/interpretation/deferred-action-v2-interpret.js';
import { DeferredWorkflowPrivateAccountingV1Schema } from '../app/domain/deferred-workflow-accounting.js';
import type { ActionGoalV2 } from '../app/domain/action-goal-v2.js';
import { choose, spec } from './helpers/action-v2-fixtures.js';
import { unspannedWire } from './helpers/deferred-v3-wire.js';
import { ModelCompletionFailure } from '../app/interpretation/model-failure.js';

const draft = spec(choose());
const request = { testSpecId: draft.testSpecId, sourceInstruction: draft.sourceInstruction,
  executionProfileRef: draft.executionProfileRef, startState: draft.startState };
const primary = JSON.stringify(unspannedWire(draft, 'primary'));
const independent = JSON.stringify(unspannedWire(draft, 'independent'));
function body(text: string) { return { status: 'completed', error: null, incomplete_details: null,
  output: [{ type: 'message', status: 'completed', role: 'assistant',
    content: [{ type: 'output_text', text }] }] }; }
function models(responses: unknown[]) {
  const sent: { instructions: string; input: string; text: { format: { name: string } } }[] = [];
  const configured = createOpenAIActionSemanticExtractionModelsV2({ apiKey: () => 'mock-only',
    fetchImpl: (async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(responses[sent.length - 1]));
    }) as typeof fetch });
  return { configured, sent };
}

test('completed malformed primary response receives one fresh same-contract retry', async () => {
  const { configured, sent } = models([body('{'), body(primary), body(independent)]);
  const result = await interpretDeferredActionTaskV2(request, configured);
  expect(result.kind).toBe('accepted');
  expect(sent).toHaveLength(3);
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[2]!.text.format.name).not.toBe(sent[0]!.text.format.name);
  expect(sent[2]!.input).toBe(draft.sourceInstruction);
  if (result.kind === 'accepted') expect(result.timing.attempts?.map((item) => item.outcome)).toEqual([
    'invalid_wire', 'valid_extraction', 'valid_extraction']);
});

test('completed malformed independent response retries without primary draft or browser context', async () => {
  const { configured, sent } = models([body(primary), body('{'), body(independent)]);
  const result = await interpretDeferredActionTaskV2(request, configured);
  expect(result.kind).toBe('accepted');
  expect(sent).toHaveLength(3);
  expect(sent[2]).toEqual(sent[1]);
  expect(sent[2]!.input).toBe(draft.sourceInstruction);
  expect(sent[2]!.input).not.toContain('sourceAccounting');
});

test('two malformed primary responses stop structurally with bounded private attempt accounting', async () => {
  const { configured, sent } = models([body('{'), body('{')]);
  const result = await interpretDeferredActionTaskV2(request, configured);
  expect(result).toMatchObject({ kind: 'rejected', stop: { stage: 'primary', category: 'structural',
    code: 'INVALID_SOURCE_REPRESENTATION' }, timing: { attempts: [
      { phase: 'primary', attempt: 1, outcome: 'invalid_wire', providerCompletedBeforeBoundary: true,
        providerResponseState: 'completed' },
      { phase: 'primary', attempt: 2, outcome: 'invalid_wire', providerCompletedBeforeBoundary: true,
        providerResponseState: 'completed' },
    ] } });
  expect(sent).toHaveLength(2);
  if (result.kind !== 'rejected') throw new Error('Expected rejection');
  const privateRecord = DeferredWorkflowPrivateAccountingV1Schema.parse({ groundingAttempts: [], successfulWitnesses: [],
    interpretationTiming: result.timing, interpretationStructural: result.structuralDiagnostic });
  expect(privateRecord.interpretationTiming?.attempts).toHaveLength(2);
  expect(JSON.stringify(privateRecord)).not.toContain(draft.sourceInstruction);
  expect(projectActionSemanticStopV2(result)).not.toHaveProperty('timing');
  expect(JSON.stringify(projectActionSemanticStopV2(result))).not.toContain('attempts');
  expect(DEFERRED_INTERPRETATION_DEADLINE_POLICY).toEqual({ perCallMs: 180_000, maxAttemptsPerPhase: 2,
    headroomMs: 60_000, sharedMs: 780_000 });
});

test('valid JSON with malformed closed wire schema does not retry', async () => {
  const { configured, sent } = models([body(JSON.stringify({ response: { kind: 'extraction', steps: [] } }))]);
  const result = await interpretDeferredActionTaskV2(request, configured);
  expect(result).toMatchObject({ kind: 'rejected', stop: { stage: 'primary', category: 'structural' },
    timing: { attempts: [{ outcome: 'invalid_structure' }] } });
  expect(sent).toHaveLength(1);
});

test('valid JSON with wrong source accounting does not retry', async () => {
  const wrong = structuredClone(unspannedWire(draft, 'primary')) as { response: {
    steps: { sourceAccounting: { authoredText: string }[] }[] } };
  wrong.response.steps[0]!.sourceAccounting[0]!.authoredText += 'fabricated';
  const { configured, sent } = models([body(JSON.stringify(wrong))]);
  const result = await interpretDeferredActionTaskV2(request, configured);
  expect(result).toMatchObject({ kind: 'rejected', stop: { stage: 'primary', category: 'structural' },
    timing: { attempts: [{ outcome: 'invalid_structure' }] } });
  expect(sent).toHaveLength(1);
});

test('valid JSON with dangling ActionGoal graph reference does not retry', async () => {
  const wrong = structuredClone(unspannedWire(draft, 'primary')) as {
    response: { steps: { obligations: { sourceSegmentIds: string[] }[] }[] } };
  wrong.response.steps[0]!.obligations[0]!.sourceSegmentIds = ['missing'];
  const { configured, sent } = models([body(JSON.stringify(wrong))]);
  expect(await interpretDeferredActionTaskV2(request, configured)).toMatchObject({ kind: 'rejected',
    stop: { stage: 'primary', category: 'structural' }, timing: { attempts: [{ outcome: 'invalid_structure' }] } });
  expect(sent).toHaveLength(1);
});

test('valid JSON without the required model response is structural and does not retry', async () => {
  const { configured, sent } = models([body('{}')]);
  expect(await interpretDeferredActionTaskV2(request, configured)).toMatchObject({ kind: 'rejected',
    stop: { stage: 'primary', category: 'structural' }, timing: { attempts: [{ outcome: 'invalid_structure' }] } });
  expect(sent).toHaveLength(1);
});

test('independent receives at most one malformed-response retry', async () => {
  const { configured, sent } = models([body(primary), body('{'), body('{')]);
  expect(await interpretDeferredActionTaskV2(request, configured)).toMatchObject({ kind: 'rejected',
    stop: { stage: 'independent', category: 'structural' }, timing: { attempts: [
      { phase: 'primary', attempt: 1, outcome: 'valid_extraction' },
      { phase: 'independent', attempt: 1, outcome: 'invalid_wire' },
      { phase: 'independent', attempt: 2, outcome: 'invalid_wire' },
    ] } });
  expect(sent).toHaveLength(3);
});

test('provider incomplete, refusal, and HTTP failure never retry', async () => {
  const incomplete = { status: 'incomplete', error: null, incomplete_details: { reason: 'max_output_tokens' }, output: [] };
  const refusal = { status: 'completed', error: null, incomplete_details: null,
    output: [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] }] };
  for (const response of [incomplete, refusal]) {
    const { configured, sent } = models([response]);
    const result = await interpretDeferredActionTaskV2(request, configured);
    expect(result).toMatchObject({ kind: 'rejected', stop: { stage: 'primary', category: 'provider' },
      timing: { attempts: [{ outcome: 'provider_stop', providerCompletedBeforeBoundary: true,
        providerResponseState: response === incomplete ? 'incomplete' : 'completed' }] } });
    expect(sent).toHaveLength(1);
  }
  let calls = 0;
  const http = createOpenAIActionSemanticExtractionModelsV2({ apiKey: () => 'mock-only',
    fetchImpl: (async () => { calls++; return new Response('', { status: 503 }); }) as typeof fetch });
  expect(await interpretDeferredActionTaskV2(request, http)).toMatchObject({ kind: 'rejected',
    stop: { stage: 'primary', code: 'PROVIDER_ERROR' } });
  expect(calls).toBe(1);
});

test('semantic disagreement does not trigger a retry', async () => {
  const changed = structuredClone(draft);
  const goal = changed.steps[0] as ActionGoalV2;
  const effect = goal.obligations.find((item) => item.kind === 'effect')!;
  effect.effect = 'enter_text';
  const argument = goal.obligations.find((item) => item.kind === 'argument')!;
  argument.purpose = 'entered_text';
  const { configured, sent } = models([body(primary), body(JSON.stringify(unspannedWire(changed, 'independent')))]);
  const result = await interpretDeferredActionTaskV2(request, configured);
  expect(result).toMatchObject({ kind: 'rejected', stop: { stage: 'admission', category: 'semantic_disagreement' } });
  expect(sent).toHaveLength(2);
});

test('cancellation takes precedence over a malformed response and prevents retry', async () => {
  const controller = new AbortController(); let calls = 0;
  const result = await interpretDeferredActionTaskV2(request, {
    primary: { complete: async () => { calls++; controller.abort(); throw new ModelCompletionFailure('PROVIDER_OUTPUT_INVALID', true); } },
    independent: { complete: async () => { calls++; return independent; } },
  }, { signal: controller.signal });
  expect(result).toMatchObject({ kind: 'rejected', stop: { stage: 'primary', code: 'INTERPRETATION_CANCELLED' } });
  expect(calls).toBe(1);
});
