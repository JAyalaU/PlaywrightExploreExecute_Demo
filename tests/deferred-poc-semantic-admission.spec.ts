import { expect, test } from '@playwright/test';
import { ActionGoalV2Schema, parseTestSpecV6V2, validateActionGoalV2,
  validateSemanticAdmissionReadbackV2 } from '../app/domain/index.js';
import { interpretDeferredActionTaskPoc, POC_FIDELITY_SYSTEM_INSTRUCTION, POC_PRIMARY_SYSTEM_INSTRUCTION,
  type PocSemanticModels } from '../app/interpretation/deferred-action-poc-interpret.js';
import { normalizePocSemanticExtraction, pocReviewerProjection } from '../app/interpretation/deferred-action-poc-normalize.js';
import { createOpenAIPocSemanticModels } from '../app/interpretation/deferred-action-poc-adapters.js';
import { projectActionSemanticStopV2 } from '../app/interpretation/deferred-action-v2-interpret.js';
import { POC_FIDELITY_RESPONSE_FORMAT, POC_PRIMARY_RESPONSE_FORMAT,
  PocPrimaryWireSchema } from '../app/interpretation/deferred-action-poc-wire.js';
import { deferredFiveStepSource } from './helpers/deferred-five-step-source.js';

const draft = deferredFiveStepSource();
const request = (sourceInstruction = draft.sourceInstruction) => ({ testSpecId: 'poc-review', sourceInstruction,
  executionProfileRef: draft.executionProfileRef, startState: draft.startState });
const steps = [
  { id: 's1', type: 'navigate', url: 'https://the-internet.herokuapp.com/' },
  { id: 's2', type: 'action_goal', effect: 'activate', explicitOperation: 'click', argument: null,
    targetConstraints: [{ kind: 'role', value: 'link', polarity: 'positive' },
      { kind: 'name', value: 'Dropdown', polarity: 'positive' }], dependsOnStepId: null },
  { id: 's3', type: 'verification_goal', verificationVersion: null,
    instruction: 'Verify the resulting URL is https://the-internet.herokuapp.com/dropdown',
    subject: null, intent: null, dependsOnStepId: 's2' },
  { id: 's4', type: 'action_goal', effect: 'choose', explicitOperation: 'select_option',
    argument: { purpose: 'choice', value: 'Option 1' },
    targetConstraints: [{ kind: 'role', value: 'dropdown', polarity: 'positive' }], dependsOnStepId: null },
  { id: 's5', type: 'verification_goal', verificationVersion: '2', optionLabel: 'Option 1',
    expectedSelected: true, controlConstraints: [], dependsOnStepId: 's4' },
] as const;
const primary = (value: unknown = steps) => JSON.stringify({ response: { kind: 'extraction', steps: value } });

test('primary provider schema keeps all valid ordinary verification subject hints in strict branches', () => {
  type JsonSchema = { type?: string; properties?: Record<string, JsonSchema>; required?: string[];
    additionalProperties?: boolean; anyOf?: JsonSchema[]; items?: JsonSchema };
  const schema = POC_PRIMARY_RESPONSE_FORMAT.schema as JsonSchema;
  const objects: JsonSchema[] = [];
  const visit = (node: JsonSchema): void => {
    if (node.type === 'object') objects.push(node);
    Object.values(node.properties ?? {}).forEach(visit);
    node.anyOf?.forEach(visit);
    if (node.items) visit(node.items);
  };
  visit(schema);
  for (const object of objects) {
    expect(object.additionalProperties).toBe(false);
    expect(object.required).toEqual(Object.keys(object.properties ?? {}));
  }
  const subjectBranches = schema.properties!.response!.anyOf![0]!.properties!.steps!.items!
    .anyOf![2]!.properties!.subject!.anyOf!;
  expect(subjectBranches).toHaveLength(8); // Seven nonempty hints plus null.
  const samples = { role: 'link', accessibleName: 'Dropdown',
    scope: [{ kind: 'region', description: 'Results' }] };
  const keys = Object.keys(samples) as (keyof typeof samples)[];
  for (let mask = 1; mask < 8; mask++) {
    const present = keys.filter((_, bit) => (mask & (1 << bit)) !== 0);
    const hint = Object.fromEntries(present.map((key) => [key, samples[key]]));
    expect(subjectBranches.some((branch) => branch.type === 'object' &&
      JSON.stringify(branch.required) === JSON.stringify(present))).toBe(true);
    expect(PocPrimaryWireSchema.safeParse({ response: { kind: 'extraction', steps: [
      { id: 's1', type: 'verification_goal', verificationVersion: null,
        instruction: 'Verify the link in Results', subject: hint, intent: null, dependsOnStepId: null },
    ] } }).success).toBe(true);
  }
  expect(subjectBranches.some((branch) => branch.type === 'null')).toBe(true);
  expect(PocPrimaryWireSchema.safeParse({ response: { kind: 'extraction', steps: [
    { id: 's1', type: 'verification_goal', verificationVersion: null,
      instruction: 'Verify the link', subject: {}, intent: null, dependsOnStepId: null },
  ] } }).success).toBe(false);
});
const faithful = JSON.stringify({ response: { verdict: 'faithful', issues: [] } });
const unfaithful = (kind: string, summary: string) => JSON.stringify({ response: { verdict: 'not_faithful',
  issues: [{ kind, sourceStep: 3, summary }] } });
function models(primaryOutput = primary(), reviewOutput = faithful, inputs: string[] = []): PocSemanticModels {
  return { primary: { complete: async ({ userInstruction }) => { inputs.push(userInstruction); return primaryOutput; } },
    reviewer: { complete: async ({ userInstruction }) => { inputs.push(userInstruction); return reviewOutput; } } };
}

test('five-step PoC extraction admits semantic operations and preserves original source digest/readback', async () => {
  const inputs: string[] = [];
  const result = await interpretDeferredActionTaskPoc(request(), models(primary(), faithful, inputs));
  expect(result.kind).toBe('accepted');
  if (result.kind !== 'accepted') return;
  expect(result.testSpec.sourceInstruction).toBe(draft.sourceInstruction);
  expect(result.testSpec.semanticMode).toBe('poc_v1');
  expect(result.testSpec.instructionAccounting).toEqual([]);
  expect(result.testSpec.steps.map((step) => step.type)).toEqual(['navigate', 'action_goal', 'verification_goal',
    'action_goal', 'verification_goal']);
  expect(result.testSpec.steps[0]).toMatchObject({ url: 'https://the-internet.herokuapp.com/' });
  expect(result.testSpec.steps[1]).toMatchObject({ obligations: expect.arrayContaining([
    expect.objectContaining({ kind: 'effect', effect: 'activate' }),
    expect.objectContaining({ kind: 'constraint', constraint: 'name', authoredText: 'Dropdown' })]) });
  expect(result.testSpec.steps[2]).toMatchObject({ instruction: expect.stringContaining('/dropdown') });
  expect(result.testSpec.steps[3]).toMatchObject({ obligations: expect.arrayContaining([
    expect.objectContaining({ kind: 'argument', authoredText: 'Option 1' })]) });
  expect(result.testSpec.steps[4]).toMatchObject({ claim: { kind: 'native_owned_option_selected',
    optionLabel: 'Option 1', expectedSelected: true, controlConstraints: [] } });
  expect(parseTestSpecV6V2(result.testSpec)).toEqual(result.testSpec);
  expect(validateSemanticAdmissionReadbackV2(result.admission.record, result.testSpec, result.admission)).toBe(result.admission);
  expect(inputs).toHaveLength(2);
  const reviewInput = JSON.parse(inputs[1]!) as Record<string, unknown>;
  expect(reviewInput.originalInstruction).toBe(draft.sourceInstruction);
  expect(JSON.stringify(reviewInput.testSpec)).not.toContain('sourceSegmentIds');
  expect(JSON.stringify(reviewInput.testSpec)).not.toContain('sourceSpan');
  expect(JSON.stringify(reviewInput.testSpec)).not.toContain('obligationIds');
  expect(reviewInput.testSpec).toMatchObject({ steps: [
    { type: 'navigate' },
    { target: { controlTypeOrRole: [{ value: 'link' }], exactAccessibleNameOrText: [{ value: 'Dropdown' }] } },
    { type: 'verification_goal' },
    { target: { controlTypeOrRole: [{ value: 'dropdown' }], exactAccessibleNameOrText: [] },
      argument: { purpose: 'choice', value: 'Option 1' } },
    { ownerControl: { controlTypeOrRole: [], exactAccessibleName: [], explicitLabel: [] },
      dependsOnStepId: 's4' },
  ] });
});

test('harmless punctuation, numbering, whitespace and paraphrase do not gate a faithful verdict', async () => {
  const variants = [draft.sourceInstruction.replace('selected.', 'selected'),
    draft.sourceInstruction.replace(/^[1-5]\. /gm, '').replace(/\n/g, '\r\n'),
    draft.sourceInstruction.replace('Find and click the link with the text:', 'Activate the link named'),
    draft.sourceInstruction.replace('select Option 1', 'SELECT option 1')];
  for (const source of variants) {
    const result = await interpretDeferredActionTaskPoc(request(source), models());
    expect(result.kind).toBe('accepted');
  }
  expect(POC_FIDELITY_SYSTEM_INSTRUCTION).toMatch(/punctuation, whitespace, list numbering/);
  expect(POC_FIDELITY_SYSTEM_INSTRUCTION).toMatch(/harmless paraphrases/);
});

test('control-category nouns and authored names remain separate in primary and reviewer contracts', () => {
  expect(POC_PRIMARY_SYSTEM_INSTRUCTION).toContain('Generic UI nouns');
  expect(POC_PRIMARY_SYSTEM_INSTRUCTION).toContain('do not by themselves assert an exact accessible name');
  expect(POC_PRIMARY_SYSTEM_INSTRUCTION).toContain('do not copy a prior action target into the assertion');
  expect(POC_FIDELITY_SYSTEM_INSTRUCTION).toContain('An invented exact name or label is a material narrowing');
  expect(POC_FIDELITY_SYSTEM_INSTRUCTION).toContain('Dropping an authored name or label');
  expect(POC_FIDELITY_SYSTEM_INSTRUCTION).toContain('an empty ownerControl constraint set is faithful');

  const cases = [
    { source: 'From the dropdown, select Option 1.', effect: 'choose', role: 'dropdown',
      name: null, context: 'From the dropdown', argument: 'Option 1' },
    { source: 'Select Option 1 from the Country dropdown.', effect: 'choose', role: 'dropdown',
      name: 'Country', context: 'from the Country dropdown', argument: 'Option 1' },
    { source: 'Click the link with the text "Dropdown".', effect: 'activate', role: 'link',
      name: 'Dropdown', context: null, argument: null },
    { source: 'Click the button.', effect: 'activate', role: 'button',
      name: null, context: null, argument: null },
    { source: 'Click Save.', effect: 'activate', role: null,
      name: 'Save', context: null, argument: null },
  ] as const;
  for (const item of cases) {
    const step = { id: 's1', type: 'action_goal', effect: item.effect,
      explicitOperation: item.effect === 'choose' ? 'select_option' : 'click',
      argument: item.argument ? { purpose: 'choice', value: item.argument } : null,
      targetConstraints: [
        ...(item.role ? [{ kind: 'role', value: item.role, polarity: 'positive' }] : []),
        ...(item.name ? [{ kind: 'name', value: item.name, polarity: 'positive' }] : []),
        ...(item.context ? [{ kind: 'context', value: item.context, polarity: 'positive' }] : []),
      ], dependsOnStepId: null };
    const response = PocPrimaryWireSchema.parse({ response: { kind: 'extraction', steps: [step] } }).response;
    expect(response.kind).toBe('extraction');
    if (response.kind !== 'extraction') continue;
    const spec = normalizePocSemanticExtraction(request(item.source), response);
    const projected = pocReviewerProjection(spec) as { steps: { target: {
      controlTypeOrRole: { value: string }[]; exactAccessibleNameOrText: { value: string }[];
      context: { value: string }[] }; argument: { value: string } | null }[] };
    expect(projected.steps[0]!.target.controlTypeOrRole.map((v) => v.value)).toEqual(item.role ? [item.role] : []);
    expect(projected.steps[0]!.target.exactAccessibleNameOrText.map((v) => v.value)).toEqual(item.name ? [item.name] : []);
    expect(projected.steps[0]!.target.context.map((v) => v.value)).toEqual(item.context ? [item.context] : []);
    expect(projected.steps[0]!.argument?.value ?? null).toBe(item.argument);
  }
});

test('native selected-option owner role cannot borrow a prior dropdown noun', () => {
  const borrowed = steps.map((step) => step.id === 's5' ? { ...step,
    controlConstraints: [{ kind: 'role', text: 'dropdown' }] } : step);
  const response = PocPrimaryWireSchema.parse({ response: { kind: 'extraction', steps: borrowed } }).response;
  expect(response.kind).toBe('extraction');
  if (response.kind !== 'extraction') return;
  expect(() => normalizePocSemanticExtraction(request(), response)).toThrow('UNREVIEWED_NATIVE_CHOICE_ROLE');
});

test('reviewer rejects invented and dropped exact names, and accepts a faithful control role', async () => {
  const invented = steps.map((step) => step.id === 's4' ? { ...step,
    targetConstraints: [{ kind: 'role', value: 'dropdown', polarity: 'positive' },
      { kind: 'name', value: 'dropdown', polarity: 'positive' }] } : step);
  const dropped = steps.map((step) => step.id === 's2' ? { ...step,
    targetConstraints: [{ kind: 'role', value: 'link', polarity: 'positive' }] } : step);
  for (const [candidate, summary] of [
    [invented, 'A control type was promoted to an exact accessible name.'],
    [dropped, 'The authored Dropdown link text constraint was removed.'],
  ] as const) {
    const result = await interpretDeferredActionTaskPoc(request(), models(primary(candidate),
      unfaithful('changed_literal', summary)));
    expect(result).toMatchObject({ kind: 'rejected', stop: { code: 'SEMANTIC_FIDELITY_MISMATCH' },
      fidelityIssues: [{ summary }] });
  }
  const faithfulRole = await interpretDeferredActionTaskPoc(request(), models());
  expect(faithfulRole.kind).toBe('accepted');
});

test('reviewer blocks omitted assertion, invented click and reversed negation', async () => {
  for (const [kind, summary] of [
    ['missing_requirement', 'The required URL verification is missing.'],
    ['invented_requirement', 'An extra click was introduced.'],
    ['changed_polarity', 'The selected-state assertion was reversed.'],
  ]) {
    const result = await interpretDeferredActionTaskPoc(request(), models(primary(), unfaithful(kind!, summary!)));
    expect(result).toMatchObject({ kind: 'rejected', stop: { code: 'SEMANTIC_FIDELITY_MISMATCH',
      category: 'omission_fidelity', stage: 'admission' }, fidelityIssues: [{ kind, summary }] });
    if (result.kind === 'rejected') expect(JSON.stringify(projectActionSemanticStopV2(result))).not.toContain(summary);
  }
});

test('explicit Option 1 and URL changes fail even if reviewer says faithful; target name change follows reviewer', async () => {
  const mutations = [
    steps.map((step) => step.id === 's4' ? { ...step, argument: { purpose: 'choice', value: 'Option 2' } } : step),
    steps.map((step) => step.id === 's3' ? { ...step, instruction: 'Verify the resulting URL is https://example.com/dropdown' } : step),
  ];
  for (const mutation of mutations) {
    const result = await interpretDeferredActionTaskPoc(request(), models(primary(mutation)));
    expect(result).toMatchObject({ kind: 'rejected', stop: { code: 'SEMANTIC_FIDELITY_MISMATCH' } });
  }
  const renamed = steps.map((step) => step.id === 's2' ? { ...step,
    targetConstraints: [{ kind: 'role', value: 'link', polarity: 'positive' },
      { kind: 'name', value: 'Select', polarity: 'positive' }] } : step);
  expect(await interpretDeferredActionTaskPoc(request(), models(primary(renamed),
    unfaithful('changed_literal', 'The explicit Dropdown target name changed.')))).toMatchObject({
      kind: 'rejected', stop: { code: 'SEMANTIC_FIDELITY_MISMATCH' } });
});

test('explicit entered value changes fail despite a faithful reviewer', async () => {
  const source = 'Enter "hello" into the textbox.';
  const changed = primary([{ id: 's1', type: 'action_goal', effect: 'enter_text',
    explicitOperation: 'fill', argument: { purpose: 'entered_text', value: 'world' },
    targetConstraints: [{ kind: 'role', value: 'textbox', polarity: 'positive' }], dependsOnStepId: null }]);
  const result = await interpretDeferredActionTaskPoc(request(source), models(changed));
  expect(result).toMatchObject({ kind: 'rejected', stop: { code: 'SEMANTIC_FIDELITY_MISMATCH' } });
});

test('unusable reviewer and malformed extraction stop before browser work', async () => {
  const unusable = await interpretDeferredActionTaskPoc(request(), models(primary(), '{'));
  expect(unusable).toMatchObject({ kind: 'rejected', stop: { stage: 'independent', category: 'provider' } });
  const invalid = await interpretDeferredActionTaskPoc(request(), models(primary([{ id: 's1', type: 'navigate',
    url: 'https://the-internet.herokuapp.com/', extra: true }])));
  expect(invalid).toMatchObject({ kind: 'rejected', stop: { stage: 'primary', category: 'structural' } });
});

test('standalone semantic-mode spoof and historical source mismatch remain strict', async () => {
  const result = await interpretDeferredActionTaskPoc(request(), models());
  expect(result.kind).toBe('accepted');
  if (result.kind !== 'accepted') return;
  const action = result.testSpec.steps[1];
  expect(action?.type).toBe('action_goal');
  if (action?.type !== 'action_goal') return;
  expect(() => validateActionGoalV2(ActionGoalV2Schema.parse(action), draft.sourceInstruction)).toThrow('UNTRUSTED_SEMANTIC_SOURCE_MODE');
  const untagged = JSON.parse(JSON.stringify(result.testSpec)) as Record<string, unknown>;
  delete untagged.semanticMode;
  expect(() => parseTestSpecV6V2(untagged)).toThrow();
  const historical = deferredFiveStepSource();
  historical.steps[0]!.sourceText += '.';
  expect(() => parseTestSpecV6V2(historical)).toThrow();
});

test('mocked transport uses two distinct closed formats and no browser calls', async () => {
  const formats: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init!.body)) as { text: { format: { name: string } } };
    formats.push(body.text.format.name);
    const output = formats.length === 1 ? primary() : faithful;
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant',
      status: 'completed', content: [{ type: 'output_text', text: output }] }] }), { status: 200 });
  };
  const result = await interpretDeferredActionTaskPoc(request(), createOpenAIPocSemanticModels({
    apiKey: () => 'mock-only', fetchImpl }));
  expect(result.kind).toBe('accepted');
  expect(formats).toEqual([POC_PRIMARY_RESPONSE_FORMAT.name, POC_FIDELITY_RESPONSE_FORMAT.name]);
});
