import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { NativeOptionVerificationGoalV2Schema, validateNativeOptionVerificationGoalV2,
  type NativeOptionVerificationGoalV2 } from '../app/domain/native-option-verification-goal.js';
import { type TestSpecV6V2, parseTestSpecV6V2 } from '../app/domain/test-spec-v6-v2.js';
import { VerificationGoalSchema } from '../app/domain/verification-goal.js';
import { canonicalSemanticProjectionV2, admitActionSemanticsV2, validateSemanticAdmissionReadbackV2 } from '../app/domain/action-semantic-admission.js';
import { createOpenAIActionSemanticExtractionModelsV2 } from '../app/interpretation/deferred-action-v2-adapters.js';
import { interpretDeferredActionTaskV2, ACTION_V2_ADMISSION_VERSIONS } from '../app/interpretation/deferred-action-v2-interpret.js';
import { LegacyPrimaryActionExtractionV2WireSchema, ACTION_V2_PRIMARY_RESPONSE_FORMAT,
  ACTION_V2_INDEPENDENT_RESPONSE_FORMAT, LEGACY_ACTION_V2_PRIMARY_RESPONSE_FORMAT,
  LEGACY_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT } from '../app/interpretation/deferred-action-v2-wire.js';
import { NATIVE_OPTION_VERIFICATION_SOURCE_CONTRACT } from '../app/interpretation/deferred-action-v2-contract.js';
import { forwardInstructionAccounting, unspannedStep } from './helpers/deferred-v3-wire.js';

function goal(text = 'Verify that Option 1 is selected.', optionLabel = 'Option 1', expectedSelected = true): NativeOptionVerificationGoalV2 {
  const start = text.indexOf(optionLabel);
  return { verificationVersion: '2', type: 'verification_goal', id: 'verify', sourceText: text, instruction: text,
    sourceInstructionSpan: { start: 0, end: text.length }, claim: { kind: 'native_owned_option_selected', optionLabel,
      optionSourceSpan: { start, end: start + optionLabel.length }, expectedSelected, controlConstraints: [] } };
}
function spec(g: NativeOptionVerificationGoalV2): TestSpecV6V2 {
  return { schemaVersion: '6', sourceContractVersion: '2', testSpecId: 'native', sourceInstruction: g.sourceText,
    executionProfileRef: { id: 'desktop', version: '1' }, startState: { url: 'about:blank' }, steps: [g],
    instructionAccounting: [{ classification: 'clause', stepId: g.id, authoredText: g.sourceText, sourceSpan: g.sourceInstructionSpan }] };
}
async function run(primary: TestSpecV6V2, independent = structuredClone(primary)) {
  const bodies: { input: string; text: { format: { name: string } } }[] = [];
  const models = createOpenAIActionSemanticExtractionModelsV2({ apiKey: () => 'mock', fetchImpl: (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const wireSteps = (s: TestSpecV6V2) => s.steps.map(unspannedStep);
    const accounting = (s: TestSpecV6V2) => forwardInstructionAccounting(s.instructionAccounting);
    const response = bodies.length === 1 ? { kind: 'extraction', steps: wireSteps(primary), instructionAccounting: accounting(primary) } :
      { kind: 'source_extraction', clauses: wireSteps(independent), instructionAccounting: accounting(independent) };
    return new Response(JSON.stringify({ status: 'completed', error: null, incomplete_details: null,
      output: [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ response }) }] }] }));
  }) as typeof fetch });
  const { testSpecId, sourceInstruction, executionProfileRef, startState } = primary;
  return { outcome: await interpretDeferredActionTaskV2({ testSpecId, sourceInstruction, executionProfileRef, startState }, models), bodies };
}

for (const g of [goal(), goal('Verify that Option 2 is selected.', 'Option 2'),
  goal('Verify that Option 1 is not selected.', 'Option 1', false),
  goal('Corroborate Winter 🐟 remained chosen.', 'Winter 🐟')]) {
  test(`native source admission through two mocked Responses: ${g.sourceText}`, async () => {
    const independent = spec(g); independent.steps[0]!.id = 'other'; independent.instructionAccounting[0]!.classification === 'clause' &&
      (independent.instructionAccounting[0]!.stepId = 'other');
    const { outcome, bodies } = await run(spec(g), independent);
    expect(outcome.kind).toBe('accepted'); expect(bodies).toHaveLength(2);
    expect(bodies.map((body) => body.text.format.name)).toEqual(['qa_deferred_action_interpretation_v9', 'qa_deferred_action_source_first_v5']);
    expect(bodies[1]!.input).toBe(g.sourceText); expect(bodies[1]!.input).not.toContain('claim');
    if (outcome.kind === 'accepted') expect(outcome.admission.record.versions).toEqual(ACTION_V2_ADMISSION_VERSIONS);
  });
}

test('native source agreement preserves polarity, exact occurrence and owner constraints', async () => {
  const base = goal('Verify Option 1 versus Option 1 in Country is selected.');
  base.claim.controlConstraints = [{ kind: 'label', text: 'Country', sourceSpan: { start: base.sourceText.indexOf('Country'), end: base.sourceText.indexOf('Country') + 7 } }];
  for (const edit of [(g: NativeOptionVerificationGoalV2) => { g.claim.expectedSelected = false; },
    (g: NativeOptionVerificationGoalV2) => { const start = g.sourceText.lastIndexOf('Option 1'); g.claim.optionSourceSpan = { start, end: start + 8 }; },
    (g: NativeOptionVerificationGoalV2) => { g.claim.controlConstraints[0]!.kind = 'name'; }]) {
    const changed = structuredClone(base); edit(changed);
    expect((await run(spec(base), spec(changed))).outcome).toMatchObject({ kind: 'rejected', stop: { code: 'SEMANTIC_INTERPRETATION_DISAGREEMENT' } });
  }
  const omitted = structuredClone(base); omitted.claim.controlConstraints = [];
  expect((await run(spec(base), spec(omitted))).outcome).toMatchObject({ kind: 'rejected', stop: { code: 'SEMANTIC_FIDELITY_MISMATCH' } });
  const labelSource = 'Verify Option 1 rather than Option 2 is selected.';
  const labelPrimary = goal(labelSource), labelIndependent = goal(labelSource, 'Option 2');
  expect(() => parseTestSpecV6V2(spec(labelIndependent))).not.toThrow();
  expect((await run(spec(labelPrimary), spec(labelIndependent))).outcome).toMatchObject({ kind: 'rejected', stop: { code: 'SEMANTIC_INTERPRETATION_DISAGREEMENT' } });
});

test('malformed identical extractions cannot gain admission or model value authority', async () => {
  for (const edit of [(g: NativeOptionVerificationGoalV2) => { g.dependsOnStepId = 'later'; },
    (g: NativeOptionVerificationGoalV2) => { Reflect.set(g.claim, 'value', '1'); },
    (g: NativeOptionVerificationGoalV2) => { Reflect.set(g, 'approved', true); },
    (g: NativeOptionVerificationGoalV2) => { g.claim.controlConstraints = [{ kind: 'name', text: 'Option 1', sourceSpan: { ...g.claim.optionSourceSpan } }]; }]) {
    const bad = goal(); edit(bad); const { outcome, bodies } = await run(spec(bad));
    expect(outcome).toMatchObject({ kind: 'rejected', stop: { code: 'INVALID_SOURCE_REPRESENTATION', stage: 'primary' } });
    expect(bodies).toHaveLength(1); expect(outcome).not.toHaveProperty('admission');
  }
});

test('duplicate/conflicting constraints and foreign role data reject mechanically', () => {
  const g = goal('Verify Option 1 in Country combobox listbox is selected.');
  const span = (text: string) => ({ start: g.sourceText.indexOf(text), end: g.sourceText.indexOf(text) + text.length });
  for (const constraints of [
    [{ kind: 'label', text: 'Country', sourceSpan: span('Country') }, { kind: 'label', text: 'Country', sourceSpan: span('Country') }],
    [{ kind: 'role', text: 'combobox', sourceSpan: span('combobox') }, { kind: 'role', text: 'listbox', sourceSpan: span('listbox') }],
    [{ kind: 'role', text: 'Country', sourceSpan: span('Country') }],
  ] as NativeOptionVerificationGoalV2['claim']['controlConstraints'][]) {
    g.claim.controlConstraints = constraints;
    expect(() => validateNativeOptionVerificationGoalV2(g, g.sourceText)).toThrow();
  }
  g.claim.controlConstraints = [{ kind: 'role', text: 'combobox', sourceSpan: span('combobox') }];
  expect(() => parseTestSpecV6V2(spec(g))).not.toThrow();
});

test('partial owner overlaps and partial option-owner overlaps are rejected', () => {
  const g = goal('Verify Option 1 in Country combobox is selected.');
  const start = g.sourceText.indexOf('Country');
  g.claim.controlConstraints = [{ kind: 'name', text: 'Country combobox', sourceSpan: { start, end: start + 16 } },
    { kind: 'label', text: 'Country', sourceSpan: { start, end: start + 7 } }];
  expect(() => parseTestSpecV6V2(spec(g))).toThrow('OVERLAPPING_OR_UNORDERED');
  g.claim.controlConstraints = [{ kind: 'label', text: '1 in Country', sourceSpan: { start: g.sourceText.indexOf('1 in'), end: start + 7 } }];
  expect(() => parseTestSpecV6V2(spec(g))).toThrow('OWNERSHIP_OVERLAP');
});

test('source order and backward dependencies remain canonically linked across local IDs', () => {
  const first = goal('Verify that Option 1 is selected.');
  const second = goal('Verify that Option 2 is not selected.', 'Option 2', false);
  second.id = 'second'; second.dependsOnStepId = first.id;
  second.sourceInstructionSpan = { start: first.sourceText.length + 1, end: first.sourceText.length + 1 + second.sourceText.length };
  const draft = spec(first); draft.sourceInstruction = `${first.sourceText} ${second.sourceText}`; draft.steps.push(second);
  draft.instructionAccounting.push({ classification: 'neutral', authoredText: ' ', sourceSpan: { start: first.sourceText.length, end: first.sourceText.length + 1 } },
    { classification: 'clause', stepId: second.id, authoredText: second.sourceText, sourceSpan: second.sourceInstructionSpan });
  expect(() => parseTestSpecV6V2(draft)).not.toThrow();
  const renamed = structuredClone(draft); renamed.steps[0]!.id = 'renamed_first'; renamed.steps[1]!.id = 'renamed_second';
  const dependency = renamed.steps[1]!; if (dependency.type === 'verification_goal') dependency.dependsOnStepId = 'renamed_first';
  for (const part of renamed.instructionAccounting) if (part.classification === 'clause') part.stepId = part.stepId === first.id ? 'renamed_first' : 'renamed_second';
  expect(canonicalSemanticProjectionV2(parseTestSpecV6V2(renamed))).toEqual(canonicalSemanticProjectionV2(draft));
  const changedOrder = structuredClone(draft); changedOrder.steps.reverse();
  expect(() => parseTestSpecV6V2(changedOrder)).toThrow('CLAUSE_OWNERSHIP_OR_ORDER');
  const forward = structuredClone(draft); const forwardFirst = forward.steps[0]!;
  if (forwardFirst.type === 'verification_goal') forwardFirst.dependsOnStepId = 'second';
  expect(() => parseTestSpecV6V2(forward)).toThrow('DEPENDENCY');
});

test('unresolved native source is preserved as a typed extraction stop, never admitted', async () => {
  const g = goal(); let calls = 0;
  const models = createOpenAIActionSemanticExtractionModelsV2({ apiKey: () => 'mock', fetchImpl: (async () => {
    calls++;
    const response = { kind: 'unresolved', reasonCode: 'unclassified_material',
      sourcePartition: [{ classification: 'evidence', authoredText: g.sourceText }] };
    return new Response(JSON.stringify({ status: 'completed', error: null, incomplete_details: null,
      output: [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ response }) }] }] }));
  }) as typeof fetch });
  const { testSpecId, sourceInstruction, executionProfileRef, startState } = spec(g);
  const outcome = await interpretDeferredActionTaskV2({ testSpecId, sourceInstruction, executionProfileRef, startState }, models);
  expect(outcome).toMatchObject({ kind: 'rejected', stop: { code: 'SEMANTIC_INTERPRETATION_UNRESOLVED', stage: 'admission' } });
  expect(outcome).not.toHaveProperty('admission'); expect(calls).toBe(2);
});

test('native tags retain separate old readers/formats and verbatim reviewed source contract', () => {
  const g = goal(); expect(NativeOptionVerificationGoalV2Schema.safeParse(g).success).toBe(true);
  expect(VerificationGoalSchema.safeParse(g).success).toBe(false);
  expect(LegacyPrimaryActionExtractionV2WireSchema.safeParse({ response: { kind: 'extraction',
    steps: [{ ...g, dependsOnStepId: null }], instructionAccounting: spec(g).instructionAccounting } }).success).toBe(false);
  expect(LEGACY_ACTION_V2_PRIMARY_RESPONSE_FORMAT.name).toBe('qa_deferred_action_interpretation_v5');
  expect(LEGACY_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT.name).toBe('qa_deferred_action_source_first_v1');
  expect(ACTION_V2_PRIMARY_RESPONSE_FORMAT.name).not.toBe(LEGACY_ACTION_V2_PRIMARY_RESPONSE_FORMAT.name);
  expect(ACTION_V2_INDEPENDENT_RESPONSE_FORMAT.name).not.toBe(LEGACY_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT.name);
  const reviewed = readFileSync('docs/selected-option-verification-review.md', 'utf8');
  expect(NATIVE_OPTION_VERIFICATION_SOURCE_CONTRACT).toBe(reviewed.slice(reviewed.indexOf('Introduce a tagged native-choice verification source branch'), reviewed.indexOf('## Trusted observation contract')));
});

test('native admission and readback reject relabeling the capability with older extraction/prompt versions', async () => {
  const draft = spec(goal()); const { testSpecId, sourceInstruction, executionProfileRef, startState } = draft;
  const trusted = { testSpecId, sourceInstruction, executionProfileRef, startState };
  const oldVersions = { goalContractVersion: '2' as const, primaryExtractionVersion: 'qa_deferred_action_interpretation_v5',
    independentExtractionVersion: 'qa_deferred_action_source_first_v1', primaryPromptVersion: 'action_v2_primary_p1', independentPromptVersion: 'action_v2_source_first_p1' };
  for (const versions of [oldVersions, { ...ACTION_V2_ADMISSION_VERSIONS, independentPromptVersion: 'action_v2_source_first_p1' }]) {
    expect(() => admitActionSemanticsV2(trusted, draft, draft, versions)).toThrow('INVALID_SOURCE_REPRESENTATION');
  }
  const { outcome } = await run(draft); if (outcome.kind !== 'accepted') throw new Error('Expected actual admission');
  const record = { ...structuredClone(outcome.admission.record), versions: oldVersions };
  expect(() => validateSemanticAdmissionReadbackV2(record, draft, outcome.admission)).toThrow('INVALID_SOURCE_REPRESENTATION');
  expect(validateSemanticAdmissionReadbackV2(outcome.admission.record, draft, outcome.admission)).toBe(outcome.admission);
});
