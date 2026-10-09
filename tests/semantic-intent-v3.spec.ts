import { expect, test } from '@playwright/test';
import { parseSemanticIntentTestSpecV3, requireTrustedSemanticIntentAdmissionV3,
  type SemanticIntentStepV3 } from '../app/domain/semantic-intent-v3.js';
import { interpretSemanticIntentV3, normalizeSemanticIntentV3, semanticIntentFidelityProjectionV3,
  type SemanticIntentModelsV3 } from '../app/interpretation/semantic-intent-v3.js';
import { SEMANTIC_INTENT_FIDELITY_V3_FORMAT, SEMANTIC_INTENT_PRIMARY_V3_FORMAT,
  SemanticIntentPrimaryWireV3Schema } from '../app/interpretation/semantic-intent-v3-wire.js';
import { createOpenAISemanticIntentModelsV3 } from '../app/interpretation/semantic-intent-v3-adapters.js';
import { semanticIntentCanonicalDigestV3 } from '../app/interpretation/semantic-intent-v3-relations.js';

const root = 'https://the-internet.herokuapp.com/';
const dropdownInstruction = [
  `Go to ${root}`,
  'Find and click the link with the text: "Dropdown"',
  `Confirm it takes you to ${root}dropdown`,
  'From the dropdown, select Option 1.',
  'Verify that Option 1 is selected.',
].map((clause, index) => `${index + 1}. ${clause}`).join('\n');
const source = (instruction: string) => ({ testSpecId: 'intent-fixture', sourceInstruction: instruction,
  executionProfileRef: { id: 'desktop', version: '1' }, startState: { url: 'about:blank' } });
const target = (category: string | null, exactName: string | null = null, ordinal: number | null = null,
  relation: 'unspecified' | 'same_as_step' | 'created_by_step' | 'any_matching' = 'unspecified',
  relatedStepId: string | null = null, context: string | null = null) =>
  ({ category, exactName, context, ordinal, relation, relatedStepId });
const nav = (id: string, url = root): SemanticIntentStepV3 => ({ id, type: 'navigate', authoredText: `Go to ${url}`,
  url, dependsOnStepId: null });
const act = (id: string, authoredText: string, t: ReturnType<typeof target>,
  desiredEffect: 'activate' | 'choose' | 'set_value' | 'set_checked',
  value: string | null = null, checkedState: boolean | null = null,
  dependsOnStepId: string | null = null, authoredMechanic: 'click' | 'type' | 'press' | null = null): SemanticIntentStepV3 =>
  ({ id, type: 'action_intent', authoredText, target: t, desiredEffect, value, checkedState,
    authoredMechanic, dependsOnStepId });
const verify = (id: string, authoredText: string, subject: ReturnType<typeof target> | null,
  observable: 'exists' | 'visible' | 'enabled' | 'checked' | 'selected' | 'value' | 'url' | 'cardinality',
  expected: boolean | string | number, dependsOnStepId: string | null,
  comparator: 'equals' | 'at_least' | 'at_most' = 'equals'): SemanticIntentStepV3 =>
  ({ id, type: 'verification_intent', authoredText, subject, observable, comparator, expected, dependsOnStepId });

const fixtures = [
  { name: 'Dropdown', instruction: dropdownInstruction, steps: [
    nav('s1'), act('s2', 'Find and click the link with the text: "Dropdown"', target('link', 'Dropdown'),
      'activate', null, null, 's1', 'click'),
    verify('s3', 'Verify destination URL', null, 'url', `${root}dropdown`, 's2'),
    act('s4', 'Select Option 1 from the dropdown', target('dropdown', null, null, 'unspecified', null,
      'From the dropdown'), 'choose', 'Option 1', null, 's3'),
    verify('s5', 'Verify Option 1 is selected', target('option', 'Option 1', null, 'same_as_step', 's4'),
      'selected', true, 's4') ] },
  { name: 'Add/Remove simple', instruction: `Go to ${root}\nFind and click the link with the text: "Add/Remove Elements"\nConfirm it takes you to ${root}add_remove_elements/\nClick the "Add Element" button.\nVerify that a "Delete" button appears.\nClick the "Delete" button.\nVerify that the "Delete" button is no longer present.`, steps: [
    nav('s1'), act('s2', 'Click Add/Remove Elements link', target('link', 'Add/Remove Elements'),
      'activate', null, null, 's1', 'click'),
    verify('s3', 'Confirm destination URL', null, 'url', `${root}add_remove_elements/`, 's2'),
    act('s4', 'Click Add Element button', target('button', 'Add Element'), 'activate', null, null, 's3', 'click'),
    verify('s5', 'Delete button appears', target('button', 'Delete'), 'exists', true, 's4'),
    act('s6', 'Click Delete button', target('button', 'Delete'), 'activate', null, null, 's5', 'click'),
    verify('s7', 'Delete button absent', target('button', 'Delete'), 'exists', false, 's6') ] },
  { name: 'Add/Remove two Delete buttons', instruction: `Go to ${root}\nClick the "Add/Remove Elements" link.\nClick "Add Element" twice.\nVerify there are two "Delete" buttons.\nClick one of the "Delete" buttons.\nVerify one "Delete" button remains.`, steps: [
    nav('s1'), act('s2', 'Click Add/Remove Elements link', target('link', 'Add/Remove Elements'),
      'activate', null, null, 's1', 'click'),
    act('s3', 'Click Add Element first time', target('button', 'Add Element'),
      'activate', null, null, 's2', 'click'),
    act('s4', 'Click Add Element second time', target('button', 'Add Element'),
      'activate', null, null, 's3', 'click'),
    verify('s5', 'Two Delete buttons', target('button', 'Delete'), 'cardinality', 2, 's4'),
    act('s6', 'Click one Delete button', target('button', 'Delete', null, 'any_matching'),
      'activate', null, null, 's5', 'click'),
    verify('s7', 'One Delete button remains', target('button', 'Delete'), 'cardinality', 1, 's6') ] },
  { name: 'Checkboxes', instruction: `Go to ${root}\nFind and click the link with the text: "Checkboxes"\nConfirm it takes you to ${root}checkboxes\nCheck checkbox 1.\nVerify that checkbox 1 is checked.\nUncheck checkbox 2.\nVerify that checkbox 2 is unchecked.`, steps: [
    nav('s1'), act('s2', 'Click Checkboxes link', target('link', 'Checkboxes'), 'activate', null, null, 's1', 'click'),
    verify('s3', 'Confirm destination URL', null, 'url', `${root}checkboxes`, 's2'),
    act('s4', 'Check checkbox 1', target('checkbox', null, 1), 'set_checked', null, true, 's3'),
    verify('s5', 'Checkbox 1 checked', target('checkbox', null, 1), 'checked', true, 's4'),
    act('s6', 'Uncheck checkbox 2', target('checkbox', null, 2), 'set_checked', null, false, 's5'),
    verify('s7', 'Checkbox 2 unchecked', target('checkbox', null, 2), 'checked', false, 's6') ] },
  { name: 'Dynamic Controls', instruction: `Go to ${root}\nFind and click the link with the text: "Dynamic Controls"\nConfirm it takes you to ${root}dynamic_controls\nClick the "Remove" button.\nVerify that the checkbox is no longer present.\nClick the "Add" button.\nVerify that the checkbox is present again.\nClick the "Enable" button.\nVerify that the text input is enabled.\nClick the "Disable" button.\nVerify that the text input is disabled.`, steps: [
    nav('s1'), act('s2', 'Click Dynamic Controls link', target('link', 'Dynamic Controls'),
      'activate', null, null, 's1', 'click'),
    verify('s3', 'Confirm destination URL', null, 'url', `${root}dynamic_controls`, 's2'),
    act('s4', 'Click Remove', target('button', 'Remove'), 'activate', null, null, 's3', 'click'),
    verify('s5', 'Checkbox absent', target('checkbox'), 'exists', false, 's4'),
    act('s6', 'Click Add', target('button', 'Add'), 'activate', null, null, 's5', 'click'),
    verify('s7', 'Checkbox present', target('checkbox'), 'exists', true, 's6'),
    act('s8', 'Click Enable', target('button', 'Enable'), 'activate', null, null, 's7', 'click'),
    verify('s9', 'Text input enabled', target('text input'), 'enabled', true, 's8'),
    act('s10', 'Click Disable', target('button', 'Disable'), 'activate', null, null, 's9', 'click'),
    verify('s11', 'Text input disabled', target('text input'), 'enabled', false, 's10') ] },
] as const;

function mockedModels(steps: readonly SemanticIntentStepV3[], originalSteps: readonly SemanticIntentStepV3[],
  originalInstruction: string): SemanticIntentModelsV3 {
  return { primary: { complete: async () => JSON.stringify({ response: { kind: 'extraction', steps } }) },
    reviewer: { complete: async ({ userInstruction }) => {
      const payload = JSON.parse(userInstruction) as { originalInstruction: string;
        semanticIntent: { steps: unknown[] } };
      const expected = semanticIntentFidelityProjectionV3(normalizeSemanticIntentV3(source(originalInstruction),
        { response: { kind: 'extraction', steps: originalSteps } }));
      const faithful = payload.originalInstruction === originalInstruction &&
        JSON.stringify(payload.semanticIntent) === JSON.stringify(expected);
      return JSON.stringify({ response: faithful ? { verdict: 'faithful', issues: [] } :
        { verdict: 'not_faithful', issues: [{ kind: 'invented_requirement', sourceStep: null,
          summary: 'Semantic intent differs from the authored fixture.' }] } });
    } } };
}

for (const fixture of fixtures) test(`${fixture.name}: offline extraction and independent fidelity preserve each authored step`, async () => {
  const result = await interpretSemanticIntentV3(source(fixture.instruction),
    mockedModels(fixture.steps, fixture.steps, fixture.instruction));
  expect(result.kind).toBe('accepted');
  if (result.kind !== 'accepted') return;
  expect(result.admission.spec.steps).toEqual(fixture.steps);
  expect(result.admission.spec).toMatchObject({ schemaVersion: '7', sourceContractVersion: '3',
    normalizationVersion: 'semantic_intent_normalization_v2' });
  expect(result.admission.record).toMatchObject({ admissionVersion: '3', versions: {
    goalContractVersion: '3', primaryExtractionVersion: SEMANTIC_INTENT_PRIMARY_V3_FORMAT.name,
    independentExtractionVersion: SEMANTIC_INTENT_FIDELITY_V3_FORMAT.name } });
  expect(() => requireTrustedSemanticIntentAdmissionV3(result.admission)).not.toThrow();
});

test('repeated Delete retains any-matching ambiguity without invented ordinal or locator', () => {
  const fixture = fixtures[2];
  const spec = normalizeSemanticIntentV3(source(fixture.instruction),
    { response: { kind: 'extraction', steps: fixture.steps } });
  const action = spec.steps[5];
  expect(action?.type).toBe('action_intent');
  if (action?.type !== 'action_intent') return;
  expect(action.target).toMatchObject({ relation: 'any_matching', ordinal: null, exactName: 'Delete' });
  expect(JSON.stringify(action)).not.toMatch(/locator|nth\(|\.first|selector/);
});

test('authored repetition and complete-set counts have one canonical relation and digest', () => {
  const instruction = `Go to ${root}\nFind and activate the link named "Add/Remove Elements".\n` +
    `Verify that the current URL is ${root}add_remove_elements/\n` +
    'Activate the "Add Element" button twice.\n' +
    'Verify that exactly two "Delete" buttons exist.\n' +
    'Activate the first "Delete" button.\n' +
    'Verify that exactly one "Delete" button exists.';
  const steps: SemanticIntentStepV3[] = [
    nav('n1'), act('a2', 'Activate link', target('link', 'Add/Remove Elements'), 'activate', null, null, 'n1'),
    verify('v3', 'Verify URL', null, 'url', `${root}add_remove_elements/`, 'a2'),
    act('a4', 'Add first', target('button', 'Add Element'), 'activate', null, null, 'v3'),
    act('a5', 'Add second', target('button', 'Add Element'), 'activate', null, null, 'a4'),
    verify('v6', 'Count two Delete', target('button', 'Delete'), 'cardinality', 2, 'a5'),
    act('a7', 'First Delete', target('button', 'Delete', 1), 'activate', null, null, 'v6'),
    verify('v8', 'Count one Delete', target('button', 'Delete'), 'cardinality', 1, 'a7'),
  ];
  const canonical = normalizeSemanticIntentV3(source(instruction),
    { response: { kind: 'extraction', steps } });
  const digest = semanticIntentCanonicalDigestV3(canonical);
  for (const relation of ['unspecified', 'same_as_step', 'any_matching'] as const) {
    const variant = steps.map((step, index) => index === 4 && step.type === 'action_intent' ?
      { ...step, target: target('button', 'Add Element', null, relation,
        relation === 'same_as_step' ? 'a4' : null) } :
      index === 6 && step.type === 'action_intent' ?
        { ...step, target: target('button', 'Delete', 1, 'any_matching') } :
      (index === 5 || index === 7) && step.type === 'verification_intent' ?
        { ...step, subject: target('button', 'Delete', null, 'any_matching') } : step);
    const normalized = normalizeSemanticIntentV3(source(instruction),
      { response: { kind: 'extraction', steps: variant } });
    expect(normalized.steps).toEqual(steps);
    expect(semanticIntentCanonicalDigestV3(normalized)).toBe(digest);
    const firstDelete = normalized.steps[6];
    expect(firstDelete?.type === 'action_intent' ? firstDelete.target.ordinal : null).toBe(1);
  }
  const differentIdentity = { ...canonical, testSpecId: 'different-id',
    steps: canonical.steps.map((step, index) => ({ ...step, id: `other${index + 1}`,
      dependsOnStepId: step.dependsOnStepId ? `other${index}` : null,
      ...(step.type === 'action_intent' ? { target: { ...step.target,
        relatedStepId: step.target.relatedStepId ? `other${index}` : null } } : {}),
      ...(step.type === 'verification_intent' && step.subject ? { subject: { ...step.subject,
        relatedStepId: step.subject.relatedStepId ? `other${index}` : null } } : {}),
    })) as SemanticIntentStepV3[] };
  expect(semanticIntentCanonicalDigestV3(differentIdentity)).toBe(digest);
});

test('authored first ordinal overrides any-matching model candidate before semantic validation', async () => {
  const instruction = `Go to ${root}\nActivate the first "Delete" button.`;
  const steps: SemanticIntentStepV3[] = [nav('s1'),
    act('s2', 'First Delete', target('button', 'Delete', 1), 'activate', null, null, 's1')];
  const candidate = steps.map((step) => step.type === 'action_intent' ?
    { ...step, target: { ...step.target, relation: 'any_matching' as const } } : step);
  const expected = normalizeSemanticIntentV3(source(instruction),
    { response: { kind: 'extraction', steps } });
  const canonical = normalizeSemanticIntentV3(source(instruction),
    { response: { kind: 'extraction', steps: candidate } });
  expect(canonical).toEqual(expected);
  expect(semanticIntentCanonicalDigestV3(canonical)).toBe(semanticIntentCanonicalDigestV3(expected));
  expect(canonical.steps[1]).toMatchObject({ target: { ordinal: 1, relation: 'unspecified' },
    desiredEffect: 'activate' });
  const accepted = await interpretSemanticIntentV3(source(instruction),
    mockedModels(candidate, steps, instruction));
  expect(accepted.kind).toBe('accepted');
  if (accepted.kind === 'accepted') expect(accepted.admission.spec).toEqual(expected);
});

test('malformed candidate references stop before relation canonicalization', async () => {
  const instruction = `Go to ${root}\nActivate the first "Delete" button.`;
  const run = (step: SemanticIntentStepV3) => interpretSemanticIntentV3(source(instruction), {
    primary: { complete: async () => JSON.stringify({ response: { kind: 'extraction',
      steps: [nav('s1'), step] } }) },
    reviewer: { complete: async () => { throw new Error('Reviewer must not run'); } },
  });
  for (const relatedStepId of ['missing', 's1']) {
    const result = await run(act('s2', 'First Delete', target('button', 'Delete', 1,
      'any_matching', relatedStepId), 'activate', null, null, 's1'));
    expect(result).toMatchObject({ kind: 'rejected', code: 'INVALID_SOURCE_REPRESENTATION',
      normalizationDiagnostic: { phase: 'spec_cross_step', predicate: 'INVALID_TARGET_RELATION',
        stepIndex: 1, fieldFamily: 'relation' } });
  }
});

test('explicit one-of, same target, created-by and selected-option ownership survive canonicalization', () => {
  const cases = [
    { instruction: `Go to ${root}\nActivate the "Delete" button.\nActivate one of the "Delete" buttons.`,
      last: act('s3', 'Any Delete', target('button', 'Delete'), 'activate', null, null, 's2'),
      expected: { relation: 'any_matching', relatedStepId: null } },
    { instruction: `Go to ${root}\nActivate the "Control" button.\nActivate that same "Control" button.`,
      last: act('s3', 'Same Control', target('button', 'Control'), 'activate', null, null, 's2'),
      expected: { relation: 'same_as_step', relatedStepId: 's2' } },
    { instruction: `Go to ${root}\nActivate the "Add" button.\nActivate the button just added.`,
      last: act('s3', 'Created control', target('button'), 'activate', null, null, 's2'),
      expected: { relation: 'created_by_step', relatedStepId: 's2' } },
  ] as const;
  for (const fixture of cases) {
    const steps: SemanticIntentStepV3[] = [nav('s1'),
      act('s2', 'First action', target('button', fixture.expected.relation === 'created_by_step' ? 'Add' :
        fixture.expected.relation === 'any_matching' ? 'Delete' : 'Control'),
      'activate', null, null, 's1'), fixture.last];
    const normalized = normalizeSemanticIntentV3(source(fixture.instruction),
      { response: { kind: 'extraction', steps } });
    const last = normalized.steps[2];
    expect(last?.type === 'action_intent' ? last.target : null).toMatchObject(fixture.expected);
  }
  const dropdown = fixtures[0];
  const spec = normalizeSemanticIntentV3(source(dropdown.instruction),
    { response: { kind: 'extraction', steps: dropdown.steps } });
  const selected = spec.steps[4];
  expect(selected?.type === 'verification_intent' ? selected.subject : null).toMatchObject({
    relation: 'same_as_step', relatedStepId: 's4' });
});

test('normalization rejection exposes only closed phase, predicate, step and field family', async () => {
  const instruction = `Go to ${root}\nActivate the "Control" button.`;
  const first = nav('s1');
  const run = (step: unknown) => interpretSemanticIntentV3(source(instruction), {
    primary: { complete: async () => JSON.stringify({ response: { kind: 'extraction',
      steps: [first, step] } }) },
    reviewer: { complete: async () => { throw new Error('Reviewer must not run'); } },
  });
  const invalidDependency = await run(act('s2', 'Control', target('button', 'Control'),
    'activate', null, null, 'missing'));
  expect(invalidDependency).toMatchObject({ kind: 'rejected', code: 'INVALID_SOURCE_REPRESENTATION',
    normalizationDiagnostic: { phase: 'spec_cross_step', predicate: 'INVALID_STEP_DEPENDENCY',
      stepIndex: 1, fieldFamily: 'dependency' } });
  const candidateRelation = normalizeSemanticIntentV3(source(instruction),
    { response: { kind: 'extraction', steps: [first, act('s2', 'Control',
      target('button', 'Control', null, 'same_as_step'), 'activate', null, null, 's1')] } });
  expect(candidateRelation.steps[1]).toMatchObject({ target: { relation: 'unspecified',
    relatedStepId: null } });
  const invalidEffect = await run({ ...act('s2', 'Control', target('button', 'Control'),
    'activate', null, null, 's1'), desiredEffect: 'unsupported' });
  expect(invalidEffect).toMatchObject({ kind: 'rejected', code: 'PROVIDER_OUTPUT_INVALID' });
  const invalidActionArgument = await run(act('s2', 'Control', target('button', 'Control'),
    'set_checked', null, null, 's1'));
  expect(invalidActionArgument).toMatchObject({ kind: 'rejected', code: 'INVALID_SOURCE_REPRESENTATION',
    normalizationDiagnostic: { phase: 'spec_cross_step', predicate: 'INVALID_ACTION_EFFECT_ARGUMENT',
      stepIndex: 1, fieldFamily: 'action_argument' } });
  const invalidCount = await run(verify('s2', 'Count controls', target('button', 'Control'),
    'cardinality', 'two', 's1'));
  expect(invalidCount).toMatchObject({ kind: 'rejected', code: 'INVALID_SOURCE_REPRESENTATION',
    normalizationDiagnostic: { phase: 'spec_cross_step', predicate: 'INVALID_CARDINALITY_VALUE',
      stepIndex: 1, fieldFamily: 'verification_value' } });
  if (invalidDependency.kind === 'rejected')
    expect(JSON.stringify(invalidDependency.normalizationDiagnostic)).not.toContain('Control');
});

test('unaccounted repetition and contradictory source relations reject with separate closed reasons', async () => {
  const steps: SemanticIntentStepV3[] = [nav('s1'),
    act('s2', 'Control', target('button', 'Control'), 'activate', null, null, 's1')];
  const model = (candidate: SemanticIntentStepV3[]) => ({
    primary: { complete: async () => JSON.stringify({ response: { kind: 'extraction', steps: candidate } }) },
    reviewer: { complete: async () => { throw new Error('Reviewer must not run'); } },
  });
  const malformed = await interpretSemanticIntentV3(source(`Go to ${root}\nActivate the "Control" button twice.`),
    model(steps));
  expect(malformed).toMatchObject({ kind: 'rejected', code: 'INVALID_SOURCE_REPRESENTATION',
    normalizationDiagnostic: { phase: 'relation_canonicalization',
      predicate: 'MALFORMED_REPETITION_EXPANSION', fieldFamily: 'relation' } });
  const contradictory = await interpretSemanticIntentV3(source(`Go to ${root}\n` +
    'Activate the "Control" button.\nActivate one of the same "Control" buttons.'),
  model([...steps, act('s3', 'Other Control', target('button', 'Control'), 'activate', null, null, 's2')]));
  expect(contradictory).toMatchObject({ kind: 'rejected', code: 'INVALID_SOURCE_REPRESENTATION',
    normalizationDiagnostic: { phase: 'relation_canonicalization',
      predicate: 'CONTRADICTORY_TARGET_CONSTRAINTS', stepIndex: 2, fieldFamily: 'relation' } });
  const oneOfFirst = await interpretSemanticIntentV3(source(`Go to ${root}\n` +
    'Activate one of the first "Delete" buttons.'), model([nav('s1'),
    act('s2', 'One of first Delete', target('button', 'Delete', 1, 'any_matching'),
      'activate', null, null, 's1')]));
  expect(oneOfFirst).toMatchObject({ kind: 'rejected', code: 'INVALID_SOURCE_REPRESENTATION',
    normalizationDiagnostic: { phase: 'relation_canonicalization',
      predicate: 'INVALID_ORDINAL_RELATION_COMBINATION', stepIndex: 1, fieldFamily: 'ordinal' } });
});

test('verification wording twice does not expand action slots or misassign one-of ownership', () => {
  const steps: SemanticIntentStepV3[] = [nav('s1'),
    verify('s2', 'Action happened twice', target('button', 'Delete'), 'exists', true, 's1'),
    act('s3', 'Choose Delete', target('button', 'Delete'), 'activate', null, null, 's2')];
  for (const verification of ['Verify that the action happened twice.',
    'Check that the action happened twice.']) {
    const instruction = `Go to ${root}\n${verification}\nActivate one of the "Delete" buttons.`;
    const spec = normalizeSemanticIntentV3(source(instruction),
      { response: { kind: 'extraction', steps } });
    const action = spec.steps[2];
    expect(action?.type === 'action_intent' ? action.target.relation : null).toBe('any_matching');
  }
});

test('matching slot count cannot grant a relation to a different named target', async () => {
  const instruction = `Go to ${root}\nActivate the "Add" button.\n` +
    'Activate one of the "Delete" buttons.';
  const steps: SemanticIntentStepV3[] = [nav('s1'),
    act('s2', 'Add', target('button', 'Add'), 'activate', null, null, 's1'),
    act('s3', 'Wrong name', target('button', 'Add'), 'activate', null, null, 's2')];
  const result = await interpretSemanticIntentV3(source(instruction), {
    primary: { complete: async () => JSON.stringify({ response: { kind: 'extraction', steps } }) },
    reviewer: { complete: async () => { throw new Error('Reviewer must not run'); } },
  });
  expect(result).toMatchObject({ kind: 'rejected', code: 'INVALID_SOURCE_REPRESENTATION',
    normalizationDiagnostic: { phase: 'relation_canonicalization',
      predicate: 'CLAUSE_OWNERSHIP_UNRESOLVED', stepIndex: 2, fieldFamily: 'relation' } });
});

test('intent vocabulary covers state setting and all requested resulting-state predicates', () => {
  const t = target('control');
  const steps: SemanticIntentStepV3[] = [
    act('a1', 'Activate control', t, 'activate'),
    act('a2', 'Choose Option 1', t, 'choose', 'Option 1'),
    act('a3', 'Set value hello', t, 'set_value', 'hello'),
    act('a4', 'Check control', t, 'set_checked', null, true),
    act('a5', 'Uncheck control', t, 'set_checked', null, false),
    ...(['exists', 'visible', 'enabled', 'checked', 'selected'] as const).flatMap((observable) =>
      [true, false].map((expected, index) => verify(`v${observable}${index}`, `${observable} ${expected}`,
        t, observable, expected, null))),
    verify('vvalue', 'Value equals hello', t, 'value', 'hello', null),
    verify('vurl', 'URL equals destination', null, 'url', `${root}dropdown`, null),
    verify('vcount', 'Two controls', t, 'cardinality', 2, null),
  ];
  const spec = normalizeSemanticIntentV3(source('Vocabulary fixture'),
    { response: { kind: 'extraction', steps } });
  expect(spec.steps).toHaveLength(18);
  expect(spec.steps).toEqual(steps);
});

test('negative fidelity fixtures reject invented name and ordinal, click substitution, lost polarity and count', async () => {
  const checkbox = fixtures[3];
  const dynamic = fixtures[4];
  const repeated = fixtures[2];
  const dropdown = fixtures[0];
  const mutations = [
    { fixture: dropdown, steps: dropdown.steps.map((step) => step.id === 's4' && step.type === 'action_intent' ?
      { ...step, target: target('dropdown', 'From the dropdown', null, 'unspecified', null,
        'From the dropdown') } : step) },
    { fixture: dynamic, steps: dynamic.steps.map((step) => step.id === 's9' && step.type === 'verification_intent' ?
      { ...step, subject: target('text input', 'text input') } : step) },
    { fixture: checkbox, steps: checkbox.steps.map((step) => step.id === 's4' && step.type === 'action_intent' ?
      { ...step, target: target('checkbox', null, 2) } : step) },
    { fixture: checkbox, steps: checkbox.steps.map((step) => step.id === 's4' && step.type === 'action_intent' ?
      { ...step, desiredEffect: 'activate', checkedState: null, authoredMechanic: 'click' } : step) },
    { fixture: checkbox, steps: checkbox.steps.map((step) => step.id === 's7' && step.type === 'verification_intent' ?
      { ...step, expected: true } : step) },
    { fixture: dynamic, steps: dynamic.steps.map((step) => step.id === 's5' && step.type === 'verification_intent' ?
      { ...step, expected: true } : step) },
    { fixture: dynamic, steps: dynamic.steps.map((step) => step.id === 's11' && step.type === 'verification_intent' ?
      { ...step, expected: true } : step) },
    { fixture: repeated, steps: repeated.steps.map((step) => step.id === 's5' && step.type === 'verification_intent' ?
      { ...step, expected: 1 } : step) },
    { fixture: repeated, steps: repeated.steps.map((step) => step.id === 's6' && step.type === 'action_intent' ?
      { ...step, target: target('button', 'Delete', 1) } : step) },
  ];
  for (const [mutationIndex, { fixture, steps }] of mutations.entries()) {
    const result = await interpretSemanticIntentV3(source(fixture.instruction),
      mockedModels(steps as SemanticIntentStepV3[], fixture.steps, fixture.instruction));
    expect(result).toMatchObject({ kind: 'rejected', code: mutationIndex === 8 ?
      'INVALID_SOURCE_REPRESENTATION' : 'SEMANTIC_FIDELITY_MISMATCH' });
    if (mutationIndex === 8) expect(result).toMatchObject({ normalizationDiagnostic: {
      phase: 'relation_canonicalization', predicate: 'INVALID_ORDINAL_RELATION_COMBINATION',
      stepIndex: 5, fieldFamily: 'ordinal' } });
  }
});

test('invalid semantic dimensions and malformed wire stop before fidelity admission', async () => {
  const checkbox = fixtures[3];
  const malformed = checkbox.steps.map((step) => step.id === 's4' && step.type === 'action_intent' ?
    { ...step, checkedState: null } : step);
  expect(await interpretSemanticIntentV3(source(checkbox.instruction),
    mockedModels(malformed as SemanticIntentStepV3[], checkbox.steps, checkbox.instruction)))
    .toMatchObject({ kind: 'rejected', code: 'INVALID_SOURCE_REPRESENTATION' });
  expect(SemanticIntentPrimaryWireV3Schema.safeParse({ response: { kind: 'extraction',
    steps: [{ ...checkbox.steps[0], operation: 'click' }] } }).success).toBe(false);
  expect(() => parseSemanticIntentTestSpecV3({ ...source(checkbox.instruction), schemaVersion: '6',
    sourceContractVersion: '2', semanticMode: 'intent_v2', normalizationVersion: 'semantic_intent_normalization_v2',
    steps: checkbox.steps })).toThrow();
});

test('exact authored URL and choice literals reject a falsely faithful review', async () => {
  const fixture = fixtures[0];
  for (const mutation of [
    fixture.steps.map((step) => step.id === 's3' && step.type === 'verification_intent' ?
      { ...step, expected: `${root}wrong` } : step),
    fixture.steps.map((step) => step.id === 's4' && step.type === 'action_intent' ?
      { ...step, value: 'Option 2' } : step),
  ]) {
    const result = await interpretSemanticIntentV3(source(fixture.instruction), {
      primary: { complete: async () => JSON.stringify({ response: { kind: 'extraction', steps: mutation } }) },
      reviewer: { complete: async () => JSON.stringify({ response: { verdict: 'faithful', issues: [] } }) },
    });
    expect(result).toMatchObject({ kind: 'rejected', code: 'SEMANTIC_FIDELITY_MISMATCH' });
  }
});

test('both strict provider schemas contain only fully required object properties', () => {
  for (const format of [SEMANTIC_INTENT_PRIMARY_V3_FORMAT, SEMANTIC_INTENT_FIDELITY_V3_FORMAT]) {
    const allowed = new Set(['type', 'enum', 'properties', 'required', 'additionalProperties',
      'items', 'anyOf', '$ref', '$defs', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
      'minItems', 'maxItems']);
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== 'object') return;
      const node = value as Record<string, unknown>;
      for (const key of Object.keys(node)) if (!['properties', '$defs'].includes(key))
        expect(allowed.has(key), `Unsupported provider JSON Schema keyword ${key}`).toBe(true);
      if (node.type === 'object') {
        expect(node.additionalProperties).toBe(false);
        expect(node.required).toEqual(Object.keys(node.properties as Record<string, unknown>));
      }
      expect(node).not.toHaveProperty('oneOf');
      expect(node).not.toHaveProperty('const');
      for (const [key, child] of Object.entries(node)) {
        if (key === 'properties' || key === '$defs') Object.values(child as Record<string, unknown>).forEach(visit);
        else if (key === 'items' || key === 'anyOf') visit(child);
      }
    };
    expect((format.schema as { type: string }).type).toBe('object');
    visit(format.schema);
  }
});

test('mocked provider transport carries the two new schema identities and no browser call', async () => {
  const fixture = fixtures[3];
  const formats: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init!.body)) as { text: { format: { name: string } } };
    formats.push(body.text.format.name);
    const output = formats.length === 1 ? JSON.stringify({ response: { kind: 'extraction', steps: fixture.steps } }) :
      JSON.stringify({ response: { verdict: 'faithful', issues: [] } });
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant',
      status: 'completed', content: [{ type: 'output_text', text: output }] }] }), { status: 200 });
  };
  const result = await interpretSemanticIntentV3(source(fixture.instruction),
    createOpenAISemanticIntentModelsV3({ apiKey: () => 'mock-only', fetchImpl }));
  expect(result.kind).toBe('accepted');
  expect(formats).toEqual([SEMANTIC_INTENT_PRIMARY_V3_FORMAT.name, SEMANTIC_INTENT_FIDELITY_V3_FORMAT.name]);
});
