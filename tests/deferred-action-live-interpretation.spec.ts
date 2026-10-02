import { expect, test } from '@playwright/test';
import { createOpenAIPocSemanticModels } from '../app/interpretation/deferred-action-poc-adapters.js';
import { interpretDeferredActionTaskPoc, POC_PRIMARY_SYSTEM_INSTRUCTION,
  POC_FIDELITY_SYSTEM_INSTRUCTION } from '../app/interpretation/deferred-action-poc-interpret.js';
import { PocFidelityWireSchema, PocPrimaryWireSchema } from '../app/interpretation/deferred-action-poc-wire.js';
import { normalizePocSemanticExtraction, pocReviewerProjection } from '../app/interpretation/deferred-action-poc-normalize.js';
import { deferredFiveStepSource } from './helpers/deferred-five-step-source.js';

const liveGate = process.env.PLAYWRIGHT_DEMO_LIVE_LLM_TESTS === '1';
test.beforeEach(() => {
  test.skip(!liveGate, 'Set PLAYWRIGHT_DEMO_LIVE_LLM_TESTS=1 to authorize live deferred interpretation.');
  expect(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY must be configured for live interpretation.').toBeTruthy();
  test.setTimeout(900_000);
});

function models() { return createOpenAIPocSemanticModels({ apiKey: () => process.env.OPENAI_API_KEY }); }
function request() {
  const { testSpecId, sourceInstruction, executionProfileRef, startState } = deferredFiveStepSource();
  return { testSpecId, sourceInstruction, executionProfileRef, startState };
}

test('live primary call extracts five structured semantic steps', async () => {
  const source = request();
  const output = await models().primary.complete({ systemInstruction: POC_PRIMARY_SYSTEM_INSTRUCTION,
    userInstruction: source.sourceInstruction, signal: AbortSignal.timeout(180_000) });
  const response = PocPrimaryWireSchema.parse(JSON.parse(output)).response;
  expect(response.kind).toBe('extraction');
  if (response.kind !== 'extraction') return;
  const spec = normalizePocSemanticExtraction(source, response);
  expect(spec.steps).toHaveLength(5);
  expect(spec.steps.map((step) => step.type)).toEqual(['navigate', 'action_goal', 'verification_goal',
    'action_goal', 'verification_goal']);
});

test('live fresh fidelity reviewer accepts the structured five-step task', async () => {
  const source = request(), model = models();
  const primary = PocPrimaryWireSchema.parse(JSON.parse(await model.primary.complete({
    systemInstruction: POC_PRIMARY_SYSTEM_INSTRUCTION, userInstruction: source.sourceInstruction,
    signal: AbortSignal.timeout(180_000) }))).response;
  expect(primary.kind).toBe('extraction');
  if (primary.kind !== 'extraction') return;
  const spec = normalizePocSemanticExtraction(source, primary);
  const reviewed = PocFidelityWireSchema.parse(JSON.parse(await model.reviewer.complete({
    systemInstruction: POC_FIDELITY_SYSTEM_INSTRUCTION,
    userInstruction: JSON.stringify({ originalInstruction: source.sourceInstruction,
      testSpec: pocReviewerProjection(spec) }), signal: AbortSignal.timeout(180_000) }))).response;
  expect(reviewed).toEqual({ verdict: 'faithful', issues: [] });
});

test('live full interpretation admits all five intended operations before browser work', async () => {
  const outcome = await interpretDeferredActionTaskPoc(request(), models());
  expect(outcome.kind).toBe('accepted');
  if (outcome.kind !== 'accepted') return;
  const steps = outcome.testSpec.steps;
  expect(steps).toHaveLength(5);
  expect(steps[0]).toMatchObject({ type: 'navigate', url: 'https://the-internet.herokuapp.com/' });
  expect(steps[1]).toMatchObject({ type: 'action_goal', obligations: expect.arrayContaining([
    expect.objectContaining({ kind: 'effect', effect: 'activate' }),
    expect.objectContaining({ kind: 'constraint', constraint: 'role', authoredText: 'link' }),
    expect.objectContaining({ kind: 'constraint', constraint: 'name', authoredText: 'Dropdown' })]) });
  expect(steps[2]).toMatchObject({ type: 'verification_goal', instruction: expect.stringContaining('/dropdown') });
  expect(steps[3]).toMatchObject({ type: 'action_goal', obligations: expect.arrayContaining([
    expect.objectContaining({ kind: 'effect', effect: 'choose' }),
    expect.objectContaining({ kind: 'constraint', constraint: 'role', authoredText: 'dropdown' }),
    expect.objectContaining({ kind: 'argument', authoredText: 'Option 1' })]) });
  if (steps[3]?.type === 'action_goal') expect(steps[3].obligations.filter((item) =>
    item.kind === 'constraint' && item.constraint === 'name')).toEqual([]);
  expect(steps[4]).toMatchObject({ type: 'verification_goal', claim: {
    kind: 'native_owned_option_selected', optionLabel: 'Option 1', expectedSelected: true } });
  if (steps[4]?.type === 'verification_goal' && 'verificationVersion' in steps[4]) {
    expect(steps[4].claim.controlConstraints).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'name', text: 'dropdown' })]));
    expect(steps[4].claim.controlConstraints.every((item) => item.kind === 'role')).toBe(true);
  }
});
