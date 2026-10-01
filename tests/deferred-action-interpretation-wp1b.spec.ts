import { test, expect } from '@playwright/test';
import { type ActionGoalV1 } from '../app/domain/index.js';
import { createOpenAIDeferredActionInterpretationModel, createOpenAIResponsesClient,
  DEFERRED_ACTION_INTERPRETATION_RESPONSE_FORMAT, DEFERRED_ACTION_INTERPRETATION_SYSTEM_INSTRUCTION,
  interpretDeferredActionTask, interpretTask, type OpenAIResponseDiagnostic,
  normalizeDeferredActionInterpretationWire } from '../app/interpretation/index.js';

const profile = { id: 'desktop', version: '1' };
const span = (source: string, text: string, at = 0) => {
  const start = source.indexOf(text, at);
  if (start < 0) throw new Error('Missing fixture source');
  return { start, end: start + text.length };
};
type Constraint = readonly [ActionGoalV1['targetConstraints'][number]['kind'], string];
function action(source: string, effect: ActionGoalV1['effect'], verb: string,
  constraints: readonly Constraint[] = [], argument?: string) {
  return { id: 's1', type: 'action_goal', goalVersion: '1', sourceStepId: 's1', sourceText: source,
    sourceInstructionSpan: { start: 0, end: source.length }, effect, effectSourceSpan: span(source, verb),
    explicitOperation: /^(?:click|fill|select_option)$/i.test(verb) ? {
      operation: verb.toLowerCase(), sourceSpan: span(source, verb) } : null,
    argument: argument === undefined ? null : { purpose: effect === 'choose' ? 'choice' : 'entered_text',
      authoredText: argument, sourceSpan: span(source, argument, verb === 'Fill' ? source.indexOf('with') : 0) },
    targetConstraints: constraints.map(([kind, authoredText]) => ({ kind, authoredText,
      sourceSpan: span(source, authoredText), polarity: 'positive' })).sort((a, b) => a.sourceSpan.start - b.sourceSpan.start),
    prerequisiteContext: null };
}
const examples = [
  action('Click the Save button.', 'activate', 'Click', [['name', 'Save'], ['role', 'button']]),
  action('Click Save.', 'activate', 'Click', [['name', 'Save']]),
  action('Select Option 1.', 'choose', 'Select', [], 'Option 1'),
  action('Choose Option 1 from the Country dropdown.', 'choose', 'Choose', [
    ['context', 'from the Country dropdown'], ['name', 'Country'], ['role', 'dropdown']], 'Option 1'),
  action('Fill the username field with Jorge.', 'enter_text', 'Fill', [['name', 'username'], ['role', 'field']], 'Jorge'),
  action('Enter Jorge in the only text field.', 'enter_text', 'Enter', [
    ['context', 'in the only text field'], ['uniqueness', 'only text field'], ['role', 'text field']], 'Jorge'),
  action('Click the only button.', 'activate', 'Click', [['uniqueness', 'only button'], ['role', 'button']]),
];
const request = (sourceInstruction: string) => ({ sourceInstruction, testSpecId: 'deferred',
  executionProfileRef: profile, startState: { url: 'about:blank' } });
function providerBody(output: unknown) {
  return { status: 'completed', error: null, incomplete_details: null,
    output: [{ type: 'message', status: 'completed', role: 'assistant', content: [
      { type: 'output_text', text: JSON.stringify(output) },
    ] }] };
}
function harness(output: unknown, httpStatus = 200) {
  const calls: Record<string, unknown>[] = [];
  const model = createOpenAIDeferredActionInterpretationModel({ apiKey: () => 'mock-key',
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(body);
      expect(body.instructions).toBe(DEFERRED_ACTION_INTERPRETATION_SYSTEM_INSTRUCTION);
      expect(body.text).toEqual({ format: DEFERRED_ACTION_INTERPRETATION_RESPONSE_FORMAT });
      expect(body.tools).toEqual([]);
      expect(body.tool_choice).toBe('none');
      expect(body.store).toBe(false);
      return new Response(JSON.stringify(providerBody(output)), { status: httpStatus });
    }) as typeof fetch });
  return { model, calls };
}
async function run(source: string, steps: unknown[]) {
  const { model, calls } = harness({ response: { kind: 'test_spec', steps } });
  const result = await interpretDeferredActionTask(request(source), model);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.input).toBe(source);
  return result;
}

for (const example of examples) {
  test(`actual adapter preserves source intent: ${example.sourceText}`, async () => {
    const result = await run(example.sourceText, [example]);
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    expect(result.testSpec).toMatchObject({ schemaVersion: '6', sourceInstruction: example.sourceText,
      executionProfileRef: profile, startState: { url: 'about:blank' } });
    const { explicitOperation, argument, prerequisiteContext: _context, ...rest } = example;
    expect(result.testSpec.steps[0]).toEqual({ ...rest,
      ...(explicitOperation === null ? {} : { explicitOperation }), ...(argument === null ? {} : { argument }) });
  });
}

test('Select Option 1 stays a choice argument without control name or select mechanics', async () => {
  const choice = examples[2]!;
  const result = await run(choice.sourceText, [choice]);
  expect(result.kind).toBe('accepted');
  if (result.kind !== 'accepted') return;
  expect(result.testSpec.steps[0]).toMatchObject({ type: 'action_goal', effect: 'choose',
    argument: { purpose: 'choice', authoredText: 'Option 1' }, targetConstraints: [] });
  for (const field of ['explicitOperation', 'accessibleName', 'role', 'optionValue', 'target'])
    expect(result.testSpec.steps[0]).not.toHaveProperty(field);
  const demanded = action('select_option Option 1.', 'choose', 'select_option', [], 'Option 1');
  const constrained = await run(demanded.sourceText, [demanded]);
  expect(constrained.kind).toBe('accepted');
  if (constrained.kind === 'accepted') expect(constrained.testSpec.steps[0])
    .toMatchObject({ effect: 'choose', explicitOperation: { operation: 'select_option' }, argument: { authoredText: 'Option 1' } });
});

test('multi-stage open/choose uses ordered source goals without fake target/prerequisite', async () => {
  for (const [first, constraints, second, literal] of [
    ['Open the only dropdown', [['uniqueness', 'only dropdown'], ['role', 'dropdown']], 'choose Option 2.', 'Option 2'],
    ['Open the menu', [['role', 'menu']], 'choose Settings.', 'Settings'],
  ] as const) {
    const source = `${first} and ${second}`;
    const stage1 = action(first, 'activate', 'Open', constraints);
    const stage2 = { ...action(second, 'choose', 'choose', [], literal), id: 's2', sourceStepId: 's2',
      sourceInstructionSpan: span(source, second) };
    const result = await run(source, [stage1, stage2]);
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') continue;
    expect(result.testSpec.steps.map((step) => step.id)).toEqual(['s1', 's2']);
    expect(result.testSpec.steps[1]).toMatchObject({ effect: 'choose', argument: { authoredText: literal }, targetConstraints: [] });
    expect(result.testSpec.steps[0]).not.toHaveProperty('explicitOperation');
    expect(result.testSpec.steps[1]).not.toHaveProperty('prerequisiteContext');
    expect((await run(source, [stage2, stage1]))).toMatchObject({ kind: 'rejected', result: { reason: 'INVALID_TEST_SPEC' } });
  }
});

test('related target wording preserves the relation anchor without turning it into the target name', async () => {
  const source = 'Click the button next to Email.';
  const related = action(source, 'activate', 'Click', [
    ['role', 'button'], ['relationship', 'next to Email'],
  ]);
  const result = await run(source, [related]);
  expect(result.kind).toBe('accepted');
  if (result.kind !== 'accepted') return;
  expect(result.testSpec.steps[0]).toMatchObject({
    type: 'action_goal',
    effect: 'activate',
    explicitOperation: { operation: 'click' },
    targetConstraints: [
      { kind: 'role', authoredText: 'button' },
      { kind: 'relationship', authoredText: 'next to Email' },
    ],
  });
  expect(result.testSpec.steps[0]).not.toHaveProperty('accessibleName');
});

test('literal text and exact occurrence/UTF-16 source ownership survive normalization', async () => {
  const clause = 'Click "💾 Save".';
  const source = `${clause}\n${clause}`;
  const first = action(clause, 'activate', 'Click', [['name', '💾 Save']]);
  const second = { ...first, id: 's2', sourceStepId: 's2', sourceInstructionSpan: span(source, clause, clause.length) };
  expect((await run(source, [first, second])).kind).toBe('accepted');
  expect(await run(source, [first, { ...second, sourceInstructionSpan: first.sourceInstructionSpan }]))
    .toMatchObject({ kind: 'rejected', result: { reason: 'INVALID_TEST_SPEC' } });
  const quoted = action('Fill the field with " Jorge ".', 'enter_text', 'Fill', [['role', 'field']], ' Jorge ');
  const result = await run(quoted.sourceText, [quoted]);
  expect(result.kind).toBe('accepted');
  if (result.kind === 'accepted') expect(result.testSpec.steps[0]).toMatchObject({ argument: { authoredText: ' Jorge ' } });
});

test('provider facts, code, and old v5 steps are rejected without another model call', async () => {
  const choice = examples[2]!;
  for (const changed of [
    { ...choice, accessibleName: 'Dropdown' }, { ...choice, selector: '#dropdown' },
    { ...choice, optionValue: '1' }, { ...choice, frameTitle: 'Main' },
    { id: 's1', type: 'select_option', sourceText: choice.sourceText,
      target: { description: 'dropdown', scope: null }, value: '1' },
  ]) expect(await run(choice.sourceText, [changed]))
    .toMatchObject({ kind: 'rejected', result: { status: 'INTERPRETATION_FAILED', reason: 'PROVIDER_OUTPUT_INVALID' } });
});

test('source fidelity rejection is validation failure, not authored or browser ambiguity', async () => {
  const named = examples[0]!;
  const choice = examples[2]!;
  const context = examples[3]!;
  for (const [source, changed] of [
    [named.sourceText, { ...named, explicitOperation: null }],
    [named.sourceText, { ...named, targetConstraints: named.targetConstraints.filter((c) => c.kind !== 'role') }],
    [named.sourceText, { ...named, targetConstraints: named.targetConstraints.filter((c) => c.kind !== 'name') }],
    [context.sourceText, { ...context, targetConstraints: context.targetConstraints.filter((c) => c.kind !== 'context') }],
    [choice.sourceText, { ...choice, targetConstraints: [{ kind: 'name', authoredText: 'Option 1',
      sourceSpan: choice.argument!.sourceSpan, polarity: 'positive' }] }],
    [choice.sourceText, { ...choice, targetConstraints: [{ kind: 'name', authoredText: 'dropdown',
      sourceSpan: { start: 7, end: 15 }, polarity: 'positive' }] }],
    [choice.sourceText, { ...choice, explicitOperation: { operation: 'select_option', sourceSpan: choice.effectSourceSpan } }],
    [named.sourceText, { ...named, effectSourceSpan: { start: 100, end: 105 } }],
  ] as const) expect(await run(source, [changed])).toMatchObject({ kind: 'rejected', result: {
    status: 'INTERPRETATION_FAILED', reason: 'INVALID_TEST_SPEC' } });
});

test('authored ambiguity/unsupported are typed; unresolved pronouns cannot fake names', async () => {
  for (const [source, code] of [
    ['Click Save or Delete.', 'CONFLICTING_EXPLICIT_TARGETS'],
    ['Fill the username field.', 'MISSING_LITERAL_ARGUMENT'],
    ['Click it.', 'UNRESOLVED_ANTECEDENT'],
  ]) {
    const { model, calls } = harness({ response: { kind: 'ambiguous', reasonCode: code, reason: 'Authored meaning cannot be preserved.' } });
    expect(await interpretDeferredActionTask(request(source!), model)).toMatchObject({ kind: 'rejected', result: {
      status: 'AMBIGUOUS_INSTRUCTION', reason: 'MATERIAL_AMBIGUITY' } });
    expect(calls).toHaveLength(1);
  }
  const pronoun = action('Click it.', 'activate', 'Click', [['name', 'it']]);
  expect(await run(pronoun.sourceText, [pronoun])).toMatchObject({ kind: 'rejected', result: { status: 'AMBIGUOUS_INSTRUCTION' } });
  for (const sourceReference of [
    action('Click on it.', 'activate', 'Click', [['context', 'on it']]),
    action('Click the button next to it.', 'activate', 'Click', [['role', 'button'], ['relationship', 'next to it']]),
  ]) expect(await run(sourceReference.sourceText, [sourceReference]))
    .toMatchObject({ kind: 'rejected', result: { status: 'AMBIGUOUS_INSTRUCTION' } });
  const quotedName = action('Click on "it".', 'activate', 'Click', [['context', 'on "it"'], ['name', 'it']]);
  expect((await run(quotedName.sourceText, [quotedName])).kind).toBe('accepted');
  const quotedAstralName = action('Click Save in "💾 it".', 'activate', 'Click', [
    ['name', 'Save'], ['context', 'in "💾 it"'], ['name', '💾 it']]);
  expect((await run(quotedAstralName.sourceText, [quotedAstralName])).kind).toBe('accepted');
  const source = 'Click Save. Click it.';
  const recovered = await run(source, [examples[1]!, { ...pronoun, id: 's2', sourceStepId: 's2',
    sourceInstructionSpan: span(source, pronoun.sourceText) }]);
  expect(recovered.kind).toBe('accepted');
  if (recovered.kind === 'accepted') expect(recovered.testSpec.steps[1]).toMatchObject({
    sourceText: 'Click it.', targetConstraints: [{ kind: 'name', authoredText: 'it', sourceSpan: span('Click it.', 'it') }],
  });
  const roleAntecedent = `${examples[6]!.sourceText} Click it.`;
  expect((await run(roleAntecedent, [examples[6]!, { ...pronoun, id: 's2', sourceStepId: 's2',
    sourceInstructionSpan: span(roleAntecedent, pronoun.sourceText) }])).kind).toBe('accepted');
  const contradictory = action('Click Save or Delete.', 'activate', 'Click', [['name', 'Save'], ['name', 'Delete']]);
  expect(await run(contradictory.sourceText, [contradictory])).toMatchObject({ kind: 'rejected', result: { reason: 'INVALID_TEST_SPEC' } });
  const { model, calls } = harness({ response: { kind: 'unsupported', reason: 'Authored drag operation is outside the reviewed source vocabulary.' } });
  expect(await interpretDeferredActionTask(request('Drag the file.'), model)).toMatchObject({ kind: 'rejected', result: { reason: 'UNSUPPORTED_REQUEST' } });
  expect(calls).toHaveLength(1);
});

test('unknown browser identity is outside the closed pre-browser ambiguity codes', async () => {
  const { model, calls } = harness({ response: { kind: 'ambiguous', reasonCode: 'UNKNOWN_ACCESSIBLE_NAME', reason: 'No named dropdown.' } });
  expect(await interpretDeferredActionTask(request('Select Option 1.'), model)).toMatchObject({ kind: 'rejected', result: { reason: 'PROVIDER_OUTPUT_INVALID' } });
  expect(calls).toHaveLength(1);
  for (const fragment of ['Missing target accessible name', 'unknown browser role', 'native-versus-custom', 'protected grounding'])
    expect(DEFERRED_ACTION_INTERPRETATION_SYSTEM_INSTRUCTION).toContain(fragment);
});

test('navigation and verification hints/dependencies preserve existing semantics', async () => {
  const navText = 'Go to https://example.com/.';
  const actionText = 'Click Save.';
  const verifyText = 'Confirm Delete does not exist.';
  const source = `${navText}\n${actionText}\n${verifyText}`;
  const steps = [
    { id: 's1', type: 'navigate', sourceText: navText, sourceInstructionSpan: span(source, navText), url: 'https://example.com/' },
    { ...examples[1]!, id: 's2', sourceStepId: 's2', sourceInstructionSpan: span(source, actionText) },
    { id: 's3', type: 'verification_goal', sourceText: verifyText, instruction: verifyText,
      sourceInstructionSpan: span(source, verifyText), subject: { role: null, accessibleName: 'Delete', scope: null },
      intent: { kind: 'presence', expected: 'absent' }, dependsOnStepId: 's2' },
  ];
  const result = await run(source, steps);
  expect(result.kind).toBe('accepted');
  if (result.kind === 'accepted') expect(result.testSpec.steps[2]).toMatchObject({ type: 'verification_goal',
    subject: { accessibleName: 'Delete' }, intent: { kind: 'presence', expected: 'absent' }, dependsOnStepId: 's2' });
  expect(await run(source, [steps[0], steps[1], { ...steps[2], intent: { kind: 'presence', expected: 'present' } }]))
    .toMatchObject({ kind: 'rejected', result: { reason: 'INVALID_TEST_SPEC' } });
  expect(await run(source, [steps[0], steps[1], { ...steps[2], dependsOnStepId: 'future' }]))
    .toMatchObject({ kind: 'rejected', result: { reason: 'INVALID_TEST_SPEC' } });
});

test('strict schema closes every object and limits steps to the v6 source language', () => {
  expect(DEFERRED_ACTION_INTERPRETATION_RESPONSE_FORMAT.name).toBe('qa_deferred_action_interpretation_v4');
  function check(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(check); return; }
    if (!value || typeof value !== 'object') return;
    const schema = value as Record<string, unknown>;
    if (schema.type === 'object') {
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toEqual(Object.keys(schema.properties as object));
    }
    Object.values(schema).forEach(check);
  }
  check(DEFERRED_ACTION_INTERPRETATION_RESPONSE_FORMAT.schema);
  expect(DEFERRED_ACTION_INTERPRETATION_RESPONSE_FORMAT.schema.$defs.authoredStep.anyOf.map((entry) => entry.properties.type))
    .toEqual([{ type: 'string', enum: ['navigate'] }, { type: 'string', enum: ['action_goal'] }, { type: 'string', enum: ['verification_goal'] }]);
  expect(DEFERRED_ACTION_INTERPRETATION_SYSTEM_INSTRUCTION.length).toBeLessThanOrEqual(8192);
});

test('transport accepts only reviewed format identity and tags failures as interpretation', async () => {
  const events: OpenAIResponseDiagnostic[] = [];
  let calls = 0;
  const client = createOpenAIResponsesClient({ apiKey: () => 'mock-key', diagnostic: (event) => events.push(event),
    fetchImpl: (async () => { calls += 1; return new Response('{}', { status: 503 }); }) as typeof fetch });
  expect(await client.complete({ systemInstruction: DEFERRED_ACTION_INTERPRETATION_SYSTEM_INSTRUCTION,
    input: 'Click Save.', format: DEFERRED_ACTION_INTERPRETATION_RESPONSE_FORMAT, signal: new AbortController().signal }))
    .toEqual({ kind: 'failure', code: 'PROVIDER_ERROR' });
  expect(events[0]).toMatchObject({ stage: 'interpretation', code: 'PROVIDER_ERROR' });
  expect(await client.complete({ systemInstruction: 'Interpret.', input: 'Click Save.',
    format: { ...DEFERRED_ACTION_INTERPRETATION_RESPONSE_FORMAT }, signal: new AbortController().signal }))
    .toEqual({ kind: 'failure', code: 'PROVIDER_INPUT_INVALID' });
  expect(calls).toBe(1);
});

test('provider timeout/refusal/incomplete remain sanitized non-QA stops with no fallback', async () => {
  for (const [body, code] of [
    [{ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }, 'PROVIDER_INCOMPLETE'],
    [{ status: 'completed', output: [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'refusal', refusal: 'private text' }] }] }, 'PROVIDER_REFUSAL'],
  ] as const) {
    let calls = 0;
    const model = createOpenAIDeferredActionInterpretationModel({ apiKey: () => 'mock-key',
      fetchImpl: (async () => { calls += 1; return new Response(JSON.stringify(body)); }) as typeof fetch });
    const result = await interpretDeferredActionTask(request('Click Save.'), model);
    expect(result).toMatchObject({ kind: 'rejected', result: { status: 'INTERPRETATION_FAILED', reason: code } });
    expect(JSON.stringify(result)).not.toContain('private text');
    expect(calls).toBe(1);
  }
  let signal: AbortSignal | undefined;
  let calls = 0;
  const model = createOpenAIDeferredActionInterpretationModel({ apiKey: () => 'mock-key', fetchImpl: (async (_url, init) => {
    calls += 1; signal = init?.signal ?? undefined;
    return await new Promise<Response>(() => undefined);
  }) as typeof fetch });
  expect(await interpretDeferredActionTask(request('Click Save.'), model, { timeoutMs: 10 }))
    .toMatchObject({ kind: 'rejected', result: { reason: 'MODEL_TIMEOUT', retryable: true } });
  expect(signal?.aborted).toBe(true);
  expect(calls).toBe(1);
});

test('bounds and historical entrypoint reject v6 instead of accepting another route', async () => {
  const { model, calls } = harness({ response: { kind: 'test_spec', steps: [examples[1]] } });
  expect(await interpretDeferredActionTask(request('Click Save.'), model, { maxResponseChars: 10 }))
    .toMatchObject({ kind: 'rejected', result: { reason: 'MALFORMED_MODEL_OUTPUT' } });
  expect(calls).toHaveLength(1);
  let called = false;
  expect(await interpretDeferredActionTask(request('x'.repeat(16385)), { complete: async () => { called = true; return ''; } }))
    .toMatchObject({ kind: 'rejected', result: { reason: 'INVALID_REQUEST' } });
  expect(called).toBe(false);
  const legacy = await interpretTask(request('Click Save.'), { complete: async () => normalizeDeferredActionInterpretationWire({
    response: { kind: 'test_spec', steps: [examples[1]] },
  }) }, { structuredActionIdentity: true });
  expect(legacy).toMatchObject({ kind: 'rejected', result: { reason: 'MALFORMED_MODEL_OUTPUT' } });
});
