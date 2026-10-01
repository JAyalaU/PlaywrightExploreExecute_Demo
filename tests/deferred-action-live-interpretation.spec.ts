import { expect, test } from '@playwright/test';
import { createOpenAIActionSemanticExtractionModelsV2 } from '../app/interpretation/deferred-action-v2-adapters.js';
import { interpretDeferredActionTaskV2, ACTION_V2_PRIMARY_SYSTEM_INSTRUCTION,
  ACTION_V2_INDEPENDENT_SYSTEM_INSTRUCTION } from '../app/interpretation/deferred-action-v2-interpret.js';
import { ActionExtractionV2ResponseSchema } from '../app/interpretation/deferred-action-v2-wire.js';
import { deferredFiveStepSource } from './helpers/deferred-five-step-source.js';

const liveGate = process.env.PLAYWRIGHT_DEMO_LIVE_LLM_TESTS === '1';
test.beforeEach(() => {
  test.skip(!liveGate, 'Set PLAYWRIGHT_DEMO_LIVE_LLM_TESTS=1 to authorize live deferred interpretation.');
  expect(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY must be configured for live interpretation.').toBeTruthy();
  test.setTimeout(900_000);
});

function models() {
  return createOpenAIActionSemanticExtractionModelsV2({ apiKey: () => process.env.OPENAI_API_KEY });
}

function request(draft: ReturnType<typeof deferredFiveStepSource>) {
  const { testSpecId, sourceInstruction, executionProfileRef, startState } = draft;
  return { testSpecId, sourceInstruction, executionProfileRef, startState };
}

test('live primary extraction returns a source-accounted extraction', async () => {
  const draft = deferredFiveStepSource();
  const output = await models().primary.complete({ systemInstruction: ACTION_V2_PRIMARY_SYSTEM_INSTRUCTION,
    userInstruction: draft.sourceInstruction, signal: AbortSignal.timeout(180_000) });
  const parsed = ActionExtractionV2ResponseSchema.parse(JSON.parse(output));
  expect(parsed.kind).toBe('extraction');
  if (parsed.kind !== 'extraction') return;
  expect(parsed.steps).toHaveLength(5);
  expect(parsed.steps.map((step) => step.sourceText)).toEqual(draft.steps.map((step) => step.sourceText));
});

test('live independent source-first extraction accepts only the authored source input', async () => {
  const draft = deferredFiveStepSource();
  const output = await models().independent.complete({ systemInstruction: ACTION_V2_INDEPENDENT_SYSTEM_INSTRUCTION,
    userInstruction: draft.sourceInstruction, signal: AbortSignal.timeout(180_000) });
  const parsed = ActionExtractionV2ResponseSchema.parse(JSON.parse(output));
  expect(parsed.kind).toBe('extraction');
  if (parsed.kind !== 'extraction') return;
  expect(parsed.steps).toHaveLength(5);
  expect(parsed.steps.map((step) => step.sourceText)).toEqual(draft.steps.map((step) => step.sourceText));
});

test('live independent semantic admission accepts agreeing source extractions', async () => {
  const draft = deferredFiveStepSource();
  const outcome = await interpretDeferredActionTaskV2(request(draft), models());
  expect(outcome.kind).toBe('accepted');
  if (outcome.kind !== 'accepted') return;
  expect(outcome.testSpec.sourceInstruction).toBe(draft.sourceInstruction);
  expect(outcome.testSpec.steps).toHaveLength(5);
  expect(outcome.admission.record.versions.primaryExtractionVersion).toBeTruthy();
  expect(outcome.admission.record.versions.independentExtractionVersion).toBeTruthy();
});

test('live exact five-step task preserves authored order and source through admission', async () => {
  const draft = deferredFiveStepSource();
  expect(draft.sourceInstruction).toBe('1. Go to https://the-internet.herokuapp.com/\n' +
    '2. Find and click the link with the text: "Dropdown"\n' +
    '3. Confirm it takes you to https://the-internet.herokuapp.com/dropdown\n' +
    '4. From the dropdown, select Option 1.\n' +
    '5. Verify that Option 1 is selected.');
  const outcome = await interpretDeferredActionTaskV2(request(draft), models());
  expect(outcome.kind).toBe('accepted');
  if (outcome.kind !== 'accepted') return;
  expect(outcome.testSpec.sourceInstruction).toBe(draft.sourceInstruction);
  expect(outcome.testSpec.steps.map((step) => step.sourceText)).toEqual(draft.steps.map((step) => step.sourceText));
  expect(outcome.testSpec.steps[4]).toMatchObject({ type: 'verification_goal',
    claim: { kind: 'native_owned_option_selected', optionLabel: 'Option 1', expectedSelected: true } });
});
