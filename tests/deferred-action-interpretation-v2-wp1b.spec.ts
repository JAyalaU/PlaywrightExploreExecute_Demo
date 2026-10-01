import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { createOpenAIActionSemanticExtractionModelsV2, interpretDeferredActionTaskV2,
  ACTION_V2_PRIMARY_RESPONSE_FORMAT, ACTION_V2_INDEPENDENT_RESPONSE_FORMAT,
  ACTION_V2_PRIMARY_SYSTEM_INSTRUCTION, ACTION_V2_INDEPENDENT_SYSTEM_INSTRUCTION,
  createOpenAIDeferredActionInterpretationModel, interpretDeferredActionTask,
  createOpenAIStructuredActionInterpretationModel, type InterpretationRequest } from '../app/interpretation/index.js';
import { projectActionSemanticStopV2, ActionSemanticInterpretationStopV2Schema } from '../app/interpretation/index.js';
import { ACTION_V2_SEMANTIC_CONTRACT } from '../app/interpretation/deferred-action-v2-contract.js';
import { requireTrustedSemanticAdmissionV2, buildActionObligationHandoffV2, validateActionObligationHandoffV2,
  type ActionGoalV2, type TestSpecV6V2, type TrustedSemanticAdmissionV2, type ActionObligationHandoffV2 } from '../app/domain/index.js';
import { activate, choose, relation, action, name, spec, rename } from './helpers/action-v2-fixtures.js';
import { unspannedWire, unspannedDecision } from './helpers/deferred-v3-wire.js';

type Body = { input: string; instructions: string; text: { format: { name: string; schema: unknown } }; store: boolean;
  tools: unknown[]; tool_choice: string; max_output_tokens: number };
export const primaryWire = (draft: TestSpecV6V2) => unspannedWire(draft, 'primary');
export const independentWire = (draft: TestSpecV6V2) => unspannedWire(draft, 'independent');
export function providerBody(wire: unknown) { return { status: 'completed', error: null, incomplete_details: null,
  output: [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(wire) }] }] }; }
export function request(draft: TestSpecV6V2): InterpretationRequest {
  const { testSpecId, sourceInstruction, executionProfileRef, startState } = draft;
  return { testSpecId, sourceInstruction, executionProfileRef, startState };
}
async function run(primary: TestSpecV6V2, independent = rename(primary),
  primaryOutput: unknown = primaryWire(primary), independentOutput: unknown = independentWire(independent)) {
  const bodies: Body[] = [];
  const decisionWire = (value: unknown) => {
    const response = (value as { response?: { sourceEvidence?: unknown } })?.response;
    return response?.sourceEvidence ? unspannedDecision(primary.sourceInstruction, response as Parameters<typeof unspannedDecision>[1]) : value;
  };
  const outputs = [decisionWire(primaryOutput), decisionWire(independentOutput)];
  const models = createOpenAIActionSemanticExtractionModelsV2({ apiKey: () => 'mock-key', fetchImpl: (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Body);
    return new Response(JSON.stringify(providerBody(outputs[bodies.length - 1])));
  }) as typeof fetch });
  return { result: await interpretDeferredActionTaskV2(request(primary), models), bodies };
}
const accepted = [activate(), activate('Activate'), choose('at'), choose('using'), choose('in', true), choose(), relation()];
for (const goal of accepted) test(`actual two Responses extractions admit source: ${goal.sourceText}`, async () => {
  const draft = spec(goal); const { result, bodies } = await run(draft);
  expect(result.kind).toBe('accepted'); expect(bodies).toHaveLength(2);
  if (result.kind !== 'accepted') throw new Error('Expected admission');
  requireTrustedSemanticAdmissionV2(result.admission);
  expect(result.testSpec).toBe(result.admission.spec);
  expect(result.testSpec.steps[0]).toEqual(goal);
  validateActionObligationHandoffV2(result.admission, result.handoff);
  expect(Object.isFrozen(result.admission.spec.steps[0])).toBe(true);
  expect(result.admission.record.versions.primaryExtractionVersion).toBe(ACTION_V2_PRIMARY_RESPONSE_FORMAT.name);
  expect(result.admission.record.versions.independentExtractionVersion).toBe(ACTION_V2_INDEPENDENT_RESPONSE_FORMAT.name);
  expect(bodies.map((body) => body.text.format.name)).toEqual([ACTION_V2_PRIMARY_RESPONSE_FORMAT.name, ACTION_V2_INDEPENDENT_RESPONSE_FORMAT.name]);
  for (const body of bodies) expect(body).toMatchObject({ input: draft.sourceInstruction, store: false, tools: [], tool_choice: 'none' });
  expect(bodies[1]!.instructions).toBe(ACTION_V2_INDEPENDENT_SYSTEM_INSTRUCTION);
  expect(bodies[1]!.input).not.toContain('sourceAccounting');
  expect(bodies[1]!.input).not.toContain(draft.testSpecId);
  if (goal.sourceText === 'Select Option 1.') expect((result.testSpec.steps[0] as ActionGoalV2).obligations.map((item) => item.kind)).toEqual(['effect', 'argument']);
  if (goal.sourceText.includes('Email')) expect((result.testSpec.steps[0] as ActionGoalV2).obligations.some((item) => item.kind === 'constraint' && item.constraint === 'name')).toBe(false);
});

test('absorbed Country and target-neutral ownership stop through actual adapter/admission', async () => {
  const faithful = spec(choose('at'));
  const absorbed = spec(action([['Choose', 'effect'], [' ', 'neutral'], ['Option 1 at the Country dropdown', 'argument'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option 1 at the Country dropdown', sourceSegmentIds: ['p2'] },
  ]));
  const lost = structuredClone(faithful); const g = lost.steps[0] as ActionGoalV2;
  g.obligations = g.obligations.filter((item) => ['e', 'a'].includes(item.id));
  g.sourceAccounting = g.sourceAccounting.map((item) => item.classification === 'target' || item.classification === 'context' ?
    { id: item.id, sourceSpan: item.sourceSpan, authoredText: item.authoredText, classification: 'neutral', obligationIds: [] } : item);
  for (const draft of [absorbed, lost]) {
    const { result, bodies } = await run(draft, faithful);
    expect(bodies).toHaveLength(2);
    expect(result).toMatchObject({ kind: 'rejected', stop: { category: 'omission_fidelity', code: 'SEMANTIC_FIDELITY_MISMATCH', detail: 'OBLIGATION_SET_MISMATCH', stage: 'admission' } });
    expect(result).not.toHaveProperty('admission'); expect(result).not.toHaveProperty('handoff');
  }
});

test('Country disappearance and illegal argument-target overlap reject mechanically before second call', async () => {
  const faithful = spec(choose('at'));
  for (const edit of [(g: ActionGoalV2) => { g.sourceAccounting.splice(4, 1); },
    (g: ActionGoalV2) => { g.sourceAccounting[4] = { ...g.sourceAccounting[4]!, classification: 'argument', obligationIds: ['a'] }; }]) {
    const bad = structuredClone(faithful); edit(bad.steps[0] as ActionGoalV2);
    const { result, bodies } = await run(bad, faithful);
    expect(bodies).toHaveLength(1);
    expect(result).toMatchObject({ kind: 'rejected', stop: { code: 'INVALID_SOURCE_REPRESENTATION', category: 'structural', stage: 'primary' } });
  }
});

test('copied Email target name disagrees with independently extracted relationship anchor', async () => {
  const faithful = spec(relation()); const wrong = structuredClone(faithful); const g = wrong.steps[0] as ActionGoalV2;
  g.anchors = []; g.obligations = g.obligations.filter((item) => item.kind !== 'relationship');
  g.obligations.push(name('emailName', ['p5'], 'Email'));
  g.sourceAccounting[4] = { ...g.sourceAccounting[4]!, classification: 'neutral', obligationIds: [] };
  g.sourceAccounting[5] = { ...g.sourceAccounting[5]!, classification: 'target', obligationIds: ['emailName'] };
  const { result, bodies } = await run(wrong, faithful);
  expect(bodies).toHaveLength(2);
  expect(result).toMatchObject({ kind: 'rejected', stop: { code: 'SEMANTIC_INTERPRETATION_DISAGREEMENT', category: 'semantic_disagreement' } });
});

test('malformed graph references, bounds and executable fields reject on either extraction', async () => {
  for (const position of ['primary', 'independent'] as const) {
    for (const mutate of [(g: ActionGoalV2) => { const n = g.obligations.find((o) => o.kind === 'constraint')!; n.sourceSegmentIds = ['missing']; },
      (g: ActionGoalV2) => { const a = g.obligations.find((o) => o.kind === 'argument')!; a.sourceSegmentIds = ['p4']; },
      (g: ActionGoalV2) => { g.sourceAccounting[0]!.authoredText = 'x'.repeat(1025); },
      (g: ActionGoalV2) => { Reflect.set(g, 'selector', '#Country'); },
      (g: ActionGoalV2) => { Reflect.set(g, 'approved', true); }]) {
      const faithful = spec(choose('at')); const bad = structuredClone(faithful); mutate(bad.steps[0] as ActionGoalV2);
      const { result, bodies } = position === 'primary' ? await run(bad, faithful) : await run(faithful, bad);
      expect(result).toMatchObject({ kind: 'rejected', stop: { code: 'INVALID_SOURCE_REPRESENTATION', category: 'structural', stage: position } });
      expect(bodies).toHaveLength(position === 'primary' ? 1 : 2);
    }
  }
});

function fill() { return action([['Fill', 'effect'], [' the ', 'neutral'], ['username', 'target'], [' ', 'neutral'], ['field', 'target'], [' with ', 'neutral'], ['Jorge', 'argument'], ['.', 'neutral']], [
  { id: 'e', kind: 'effect', effect: 'enter_text', sourceSegmentIds: ['p0'] },
  { id: 'o', kind: 'operation', operation: 'fill', sourceSegmentIds: ['p0'] }, name('n', ['p2'], 'username'),
  { id: 'r', kind: 'constraint', constraint: 'role', subject: { kind: 'target' }, polarity: 'positive', authoredText: 'field', sourceSegmentIds: ['p4'] },
  { id: 'a', kind: 'argument', purpose: 'entered_text', authoredText: 'Jorge', sourceSegmentIds: ['p6'] },
]); }
test('missing click or fill demand cannot acquire admission', async () => {
  for (const faithful of [spec(activate('Click')), spec(fill())]) {
    const wrong = structuredClone(faithful); const g = wrong.steps[0] as ActionGoalV2;
    g.obligations = g.obligations.filter((item) => item.kind !== 'operation'); g.sourceAccounting[0]!.obligationIds = ['e'];
    const { result } = await run(wrong, faithful);
    expect(result).toMatchObject({ kind: 'rejected', stop: { code: 'SEMANTIC_FIDELITY_MISMATCH' } });
  }
});

test('copied effect and polarity disagreements preserve semantic stop category', async () => {
  const faithful = spec(choose()); const changed = structuredClone(faithful); const g = changed.steps[0] as ActionGoalV2;
  const effect = g.obligations.find((item) => item.kind === 'effect')!; effect.effect = 'enter_text';
  const argument = g.obligations.find((item) => item.kind === 'argument')!; argument.purpose = 'entered_text';
  expect((await run(changed, faithful)).result).toMatchObject({ kind: 'rejected', stop: { code: 'SEMANTIC_INTERPRETATION_DISAGREEMENT' } });
  const positive = spec(activate()); const negative = structuredClone(positive);
  const constraint = (negative.steps[0] as ActionGoalV2).obligations.find((item) => item.kind === 'constraint')!; constraint.polarity = 'negative';
  expect((await run(positive, negative)).result).toMatchObject({ kind: 'rejected', stop: { code: 'SEMANTIC_INTERPRETATION_DISAGREEMENT' } });
});

test('valid unresolved drafts retain residual source and cannot hand off', async () => {
  const draft = spec(activate()); const g = draft.steps[0] as ActionGoalV2;
  g.obligations.splice(1, 1);
  g.sourceAccounting[2] = { ...g.sourceAccounting[2]!, classification: 'unresolved', obligationIds: [], reason: 'unclear_reference' };
  const { result, bodies } = await run(draft);
  expect(bodies).toHaveLength(2);
  expect(result).toMatchObject({ kind: 'rejected', sourceInstruction: 'Tap Save.', stop: { code: 'SEMANTIC_INTERPRETATION_UNRESOLVED', category: 'unresolved' }, drafts: { primary: draft } });
  expect(result).not.toHaveProperty('handoff');
});

test('authored ambiguity requires matching independently grounded reason and source evidence', async () => {
  const draft = spec(activate()); const decision = { response: { kind: 'authored_ambiguity', reasonCode: 'UNRESOLVED_ANTECEDENT',
    sourceEvidence: [{ sourceSpan: { start: 4, end: 8 }, authoredText: 'Save' }] } };
  expect((await run(draft, draft, decision, decision)).result).toMatchObject({ kind: 'rejected', stop: { code: 'AUTHORED_AMBIGUITY', category: 'authored_ambiguity' } });
  expect((await run(draft, draft, decision)).result).toMatchObject({ kind: 'rejected', stop: { code: 'SEMANTIC_INTERPRETATION_DISAGREEMENT' } });
  const different = structuredClone(decision); different.response.reasonCode = 'CONFLICTING_EXPLICIT_TARGETS';
  expect((await run(draft, draft, decision, different)).result).toMatchObject({ kind: 'rejected', stop: { code: 'SEMANTIC_INTERPRETATION_DISAGREEMENT' } });
  const fabricated = structuredClone(decision); fabricated.response.sourceEvidence[0]!.authoredText = 'Other';
  expect((await run(draft, draft, decision, fabricated)).result).toMatchObject({ kind: 'rejected', stop: { code: 'INVALID_SOURCE_REPRESENTATION', stage: 'independent' } });
  const unresolved = { response: { ...decision.response, kind: 'unresolved', reasonCode: 'unclear_reference' } };
  expect((await run(draft, draft, unresolved, unresolved)).result).toMatchObject({ kind: 'rejected', sourceInstruction: draft.sourceInstruction, stop: { code: 'SEMANTIC_INTERPRETATION_UNRESOLVED' } });
});

test('agreed unsupported operations and exclusions preserve distinct non-QA stops', async () => {
  const unsupported = spec(activate('Tap')); const g = unsupported.steps[0] as ActionGoalV2;
  g.obligations.push({ id: 'u', kind: 'unsupported_operation', sourceSegmentIds: ['p0'] }); g.sourceAccounting[0]!.obligationIds.push('u');
  expect((await run(unsupported)).result).toMatchObject({ kind: 'rejected', stop: { code: 'UNSUPPORTED_AUTHORED_OPERATION', category: 'unsupported_operation' } });
  const negative = spec(activate()); const n = (negative.steps[0] as ActionGoalV2).obligations.find((item) => item.kind === 'constraint')!; n.polarity = 'negative';
  expect((await run(negative)).result).toMatchObject({ kind: 'rejected', stop: { code: 'UNSUPPORTED_AUTHORED_CONSTRAINT', category: 'unsupported_constraint' } });
});

test('Unicode, quoted literals, repeated occurrences and multistage references use exact bytes and source links', async () => {
  const first = spec(activate('Tap', '保存😀'));
  expect((await run(first)).result.kind).toBe('accepted');
  const quoted = spec(action([['Enter', 'effect'], [' "', 'neutral'], ['  fetch("x")  ', 'argument'], ['".', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'enter_text', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: 'entered_text', authoredText: '  fetch("x")  ', sourceSegmentIds: ['p2'] },
  ]));
  expect((await run(quoted)).result.kind).toBe('accepted');
  const repeated = spec(action([['Set', 'effect'], [' ', 'neutral'], ['Save', 'target'], [' to ', 'neutral'], ['Save', 'argument'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'enter_text', sourceSegmentIds: ['p0'] }, name('n', ['p2'], 'Save'),
    { id: 'a', kind: 'argument', purpose: 'entered_text', authoredText: 'Save', sourceSegmentIds: ['p4'] },
  ]));
  expect((await run(repeated)).result.kind).toBe('accepted');
  const second = action([['Activate', 'effect'], [' ', 'neutral'], ['it', 'reference'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'activate', sourceSegmentIds: ['p0'] },
    { id: 'r', kind: 'reference', authoredText: 'it', sourceSegmentIds: ['p2'], antecedentStepId: 's1', antecedent: 'target' },
  ]);
  const gap = ' Subsequently, '; const offset = first.sourceInstruction.length + gap.length;
  second.id = 's2'; second.sourceStepId = 's2'; second.sourceInstructionSpan = { start: offset, end: offset + second.sourceText.length };
  first.steps.push(second); const before = first.sourceInstruction.length; first.sourceInstruction += gap + second.sourceText;
  first.instructionAccounting.push({ classification: 'neutral', sourceSpan: { start: before, end: offset }, authoredText: gap },
    { classification: 'clause', stepId: 's2', sourceSpan: second.sourceInstructionSpan, authoredText: second.sourceText });
  expect((await run(first)).result.kind).toBe('accepted');
  const bad = structuredClone(first); const ref = (bad.steps[1] as ActionGoalV2).obligations.find((item) => item.kind === 'reference')!; ref.antecedentStepId = 's2';
  expect((await run(first, bad)).result).toMatchObject({ kind: 'rejected', stop: { code: 'INVALID_SOURCE_REPRESENTATION' } });
});

test('admission handoff rejects forged authority and missing Country obligation before browser work', async () => {
  const draft = spec(choose('at')); const { result } = await run(draft);
  if (result.kind !== 'accepted') throw new Error('Expected admission');
  const forged = JSON.parse(JSON.stringify(result.admission)) as TrustedSemanticAdmissionV2;
  expect(() => buildActionObligationHandoffV2(forged)).toThrow('UNTRUSTED_SEMANTIC_ADMISSION');
  const missing = JSON.parse(JSON.stringify(result.handoff)) as ActionObligationHandoffV2; missing.goals[0]!.obligationIds.splice(2, 1);
  expect(() => validateActionObligationHandoffV2(result.admission, missing)).toThrow('INCOMPLETE_OR_CHANGED_OBLIGATION_HANDOFF');
});

test('both extractions can share an absorbed-Country mistake; agreement is not English intent proof', async () => {
  const wrong = spec(action([['Choose', 'effect'], [' ', 'neutral'], ['Option 1 at the Country dropdown', 'argument'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option 1 at the Country dropdown', sourceSegmentIds: ['p2'] },
  ]));
  expect((await run(wrong)).result.kind).toBe('accepted');
});

test('reviewed source contract excerpt is verbatim and both prompts fit bounded transport', () => {
  const architecture = readFileSync('docs/action-goal-semantic-fidelity-architecture.md', 'utf8');
  expect(ACTION_V2_SEMANTIC_CONTRACT).toBe(architecture.slice(architecture.indexOf('## 3.'), architecture.indexOf('## 5.')));
  for (const prompt of [ACTION_V2_PRIMARY_SYSTEM_INSTRUCTION, ACTION_V2_INDEPENDENT_SYSTEM_INSTRUCTION]) expect(prompt.length).toBeLessThanOrEqual(12288);
});

test('generated provider schemas are closed objects with all fields required and no unsupported unions', () => {
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value === null || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    expect(node).not.toHaveProperty('oneOf'); expect(node).not.toHaveProperty('allOf');
    if (node.type === 'object') {
      expect(node.additionalProperties).toBe(false);
      expect([...(node.required as string[])].sort()).toEqual(Object.keys(node.properties as object).sort());
    }
    Object.values(node).forEach(visit);
  };
  for (const format of [ACTION_V2_PRIMARY_RESPONSE_FORMAT, ACTION_V2_INDEPENDENT_RESPONSE_FORMAT]) {
    expect(format).toMatchObject({ type: 'json_schema', strict: true }); visit(format.schema);
  }
});

test('old/v5 adapters and new extraction formats reject each other instead of upgrading', async () => {
  const draft = spec(activate()); const config = { apiKey: () => 'mock-key',
    fetchImpl: (async () => new Response(JSON.stringify(providerBody(primaryWire(draft))))) as typeof fetch };
  const historical = await interpretDeferredActionTask(request(draft), createOpenAIDeferredActionInterpretationModel(config));
  expect(historical.kind).toBe('rejected');
  const v5 = createOpenAIStructuredActionInterpretationModel(config);
  await expect(v5.complete({ systemInstruction: 'test', userInstruction: draft.sourceInstruction, signal: new AbortController().signal })).rejects.toThrow('PROVIDER_OUTPUT_INVALID');
  const wrongIdentity = independentWire(draft);
  expect((await run(draft, draft, wrongIdentity)).result).toMatchObject({ kind: 'rejected', stop: { code: 'INVALID_SOURCE_REPRESENTATION' } });
  const historicalOutput = { response: { kind: 'test_spec', steps: [{ id: 's1', type: 'action_goal', goalVersion: '1' }] } };
  expect((await run(draft, draft, historicalOutput)).result).toMatchObject({ kind: 'rejected', stop: { code: 'INVALID_SOURCE_REPRESENTATION' } });
});

function choiceVariation(pieces: Parameters<typeof action>[0], effectIndex: number, argumentIndex: number, nameIndex: number,
  contextIndices: number[], roleIndex?: number) {
  return action(pieces, [
    { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: [`p${effectIndex}`] },
    { id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option 1', sourceSegmentIds: [`p${argumentIndex}`] },
    name('n', [`p${nameIndex}`], 'Country'),
    ...(contextIndices.length ? [{ id: 'c', kind: 'constraint' as const, constraint: 'context' as const,
      subject: { kind: 'target' as const }, polarity: 'positive' as const,
      sourceSegmentIds: contextIndices.map((i) => `p${i}`), authoredText: contextIndices.map((i) => pieces[i]![0]).join('') }] : []),
    ...(roleIndex === undefined ? [] : [{ id: 'r', kind: 'constraint' as const, constraint: 'role' as const,
      subject: { kind: 'target' as const }, polarity: 'positive' as const,
      sourceSegmentIds: [`p${roleIndex}`], authoredText: pieces[roleIndex]![0] }]),
  ]);
}
const variations = [
  choiceVariation([['Choose', 'effect'], [' ', 'neutral'], ['Option 1', 'argument'], [' using ', 'context'], ['Country', 'target'], ['.', 'neutral']], 0, 2, 4, [3, 4]),
  choiceVariation([['Choose', 'effect'], [' ', 'neutral'], ['Option 1', 'argument'], [' on the ', 'context'], ['Country', 'target'], [' ', 'context'], ['selector', 'target'], ['.', 'neutral']], 0, 2, 4, [3, 4, 5, 6], 6),
  choiceVariation([['Pick', 'effect'], [' ', 'neutral'], ['Option 1', 'argument'], [' for ', 'context'], ['Country', 'target'], ['.', 'neutral']], 0, 2, 4, [3, 4]),
  choiceVariation([['Set', 'effect'], [' ', 'neutral'], ['Country', 'target'], [' to ', 'neutral'], ['Option 1', 'argument'], ['.', 'neutral']], 0, 4, 2, []),
  choiceVariation([['In ', 'context'], ['Country', 'target'], [', ', 'neutral'], ['select', 'effect'], [' ', 'neutral'], ['Option 1', 'argument'], ['.', 'neutral']], 3, 5, 1, [0, 1]),
];
for (const goal of variations) test(`fixture-only contextual variation and absorbed/neutral rejection: ${goal.sourceText}`, async () => {
  const faithful = spec(goal); expect((await run(faithful)).result.kind).toBe('accepted');
  const neutral = structuredClone(faithful); const n = neutral.steps[0] as ActionGoalV2;
  n.obligations = n.obligations.filter((item) => ['effect', 'argument'].includes(item.kind));
  n.sourceAccounting = n.sourceAccounting.map((item) => ['target', 'context'].includes(item.classification) ?
    { id: item.id, sourceSpan: item.sourceSpan, authoredText: item.authoredText, classification: 'neutral', obligationIds: [] } : item);
  expect((await run(neutral, faithful)).result).toMatchObject({ kind: 'rejected', stop: { code: 'SEMANTIC_FIDELITY_MISMATCH' } });
  const absorbed = structuredClone(faithful); const g = absorbed.steps[0] as ActionGoalV2;
  const indices = g.sourceAccounting.flatMap((item, index) => ['target', 'context', 'argument'].includes(item.classification) ? [index] : []);
  const selected = g.sourceAccounting.slice(Math.min(...indices), Math.max(...indices) + 1).filter((item) => item.classification !== 'effect');
  g.obligations = g.obligations.filter((item) => item.kind === 'effect');
  g.obligations.push({ id: 'a', kind: 'argument', purpose: 'choice', authoredText: selected.map((item) => item.authoredText).join(''), sourceSegmentIds: selected.map((item) => item.id) });
  g.sourceAccounting = g.sourceAccounting.map((item) => selected.some((s) => s.id === item.id) ? { ...item, classification: 'argument', obligationIds: ['a'] } : item);
  const contiguous = selected.every((item, index) => index === 0 || selected[index - 1]!.sourceSpan.end === item.sourceSpan.start);
  expect((await run(absorbed, faithful)).result).toMatchObject({ kind: 'rejected', stop: contiguous ?
    { code: 'SEMANTIC_FIDELITY_MISMATCH', stage: 'admission' } :
    { code: 'INVALID_SOURCE_REPRESENTATION', stage: 'primary' } });
});

test('provider errors, refusal, incomplete and malformed outputs stop in either stage without fallback', async () => {
  const draft = spec(choose());
  const cases = [
    { body: { error: { message: 'private token secret' } }, status: 500, code: 'PROVIDER_ERROR', category: 'provider' },
    { body: { status: 'completed', error: null, incomplete_details: null, output: [{ type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'refusal', refusal: 'private token secret' }] }] }, status: 200, code: 'PROVIDER_REFUSAL', category: 'provider' },
    { body: { status: 'incomplete', error: null, incomplete_details: { reason: 'max_output_tokens' }, output: [] }, status: 200, code: 'PROVIDER_INCOMPLETE', category: 'provider' },
    { body: providerBody({ response: { kind: 'extraction', approved: true } }), status: 200, code: 'INVALID_SOURCE_REPRESENTATION', category: 'structural' },
  ];
  for (const stage of ['primary', 'independent'] as const) for (const failure of cases) {
    let calls = 0;
    const models = createOpenAIActionSemanticExtractionModelsV2({ apiKey: () => 'mock-key', fetchImpl: (async () => {
      calls++;
      return stage === 'independent' && calls === 1 ? new Response(JSON.stringify(providerBody(primaryWire(draft)))) :
        new Response(JSON.stringify(failure.body), { status: failure.status });
    }) as typeof fetch });
    const result = await interpretDeferredActionTaskV2(request(draft), models);
    expect(result).toMatchObject({ kind: 'rejected', stop: { stage, code: failure.code, category: failure.category } });
    expect(calls).toBe(stage === 'primary' ? 1 : 2);
    expect(result).not.toHaveProperty('handoff'); expect(JSON.stringify(result)).not.toContain('private token secret');
  }
});

test('per-call and total deadlines abort second transport without skipping admission or adding calls', async () => {
  const draft = spec(choose());
  for (const bounds of [{ perCallTimeoutMs: 30, totalTimeoutMs: 200 }, { perCallTimeoutMs: 200, totalTimeoutMs: 40 }]) {
    let calls = 0; let secondSignal: AbortSignal | undefined;
    const models = createOpenAIActionSemanticExtractionModelsV2({ apiKey: () => 'mock-key', fetchImpl: (async (_url, init) => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify(providerBody(primaryWire(draft))));
      secondSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => {}); // Transport deliberately ignores abort; application deadline must still settle.
    }) as typeof fetch });
    const result = await interpretDeferredActionTaskV2(request(draft), models, bounds);
    expect(result).toMatchObject({ kind: 'rejected', stop: { stage: 'independent', code: 'EXTRACTION_DEADLINE', category: 'environment' } });
    expect(secondSignal?.aborted).toBe(true); expect(calls).toBe(2); expect(result).not.toHaveProperty('handoff');
  }
});

test('cancellation in second extraction and provider configuration remain distinct environment stops', async () => {
  const draft = spec(choose()); let calls = 0; const controller = new AbortController();
  const models = createOpenAIActionSemanticExtractionModelsV2({ apiKey: () => 'mock-key', fetchImpl: (async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify(providerBody(primaryWire(draft))));
    controller.abort(); return new Promise<Response>(() => {});
  }) as typeof fetch });
  const cancelled = await interpretDeferredActionTaskV2(request(draft), models, { signal: controller.signal });
  expect(cancelled).toMatchObject({ kind: 'rejected', stop: { stage: 'independent', code: 'INTERPRETATION_CANCELLED', category: 'environment', retryable: false } });
  expect(calls).toBe(2);
  const notConfigured = createOpenAIActionSemanticExtractionModelsV2({ apiKey: () => undefined });
  expect(await interpretDeferredActionTaskV2(request(draft), notConfigured)).toMatchObject({ kind: 'rejected', stop: { code: 'PROVIDER_CONFIGURATION_ERROR', category: 'environment' } });
});

test('input/output bounds and caller mutation preserve trusted source snapshot', async () => {
  const draft = spec(choose()); let calls = 0; const input = request(draft);
  const models = createOpenAIActionSemanticExtractionModelsV2({ apiKey: () => 'mock-key', fetchImpl: (async () => {
    calls++;
    input.sourceInstruction = 'Changed'; input.executionProfileRef.version = '9';
    return new Response(JSON.stringify(providerBody(calls === 1 ? primaryWire(draft) : independentWire(draft))));
  }) as typeof fetch });
  const accepted = await interpretDeferredActionTaskV2(input, models);
  expect(accepted).toMatchObject({ kind: 'accepted', testSpec: { sourceInstruction: draft.sourceInstruction, executionProfileRef: { version: '1' } } });
  expect(calls).toBe(2);
  const huge = { ...request(draft), sourceInstruction: 'x'.repeat(16385) };
  expect(await interpretDeferredActionTaskV2(huge, models)).toMatchObject({ kind: 'rejected', stop: { detail: 'INVALID_REQUEST' } });
  expect(calls).toBe(2);
  calls = 0;
  expect(await interpretDeferredActionTaskV2(request(draft), models, { maxResponseChars: 10 })).toMatchObject({ kind: 'rejected', stop: { code: 'INVALID_SOURCE_REPRESENTATION', detail: 'OUTPUT_BOUND' } });
  await expect(interpretDeferredActionTaskV2(request(draft), models, { perCallTimeoutMs: 0 })).rejects.toThrow('Invalid extraction bounds');
});

test('safe stop projection excludes source/residual evidence and validates its closed outcome', async () => {
  const draft = spec(activate()); const decision = { response: { kind: 'unresolved', reasonCode: 'unclear_reference',
    sourceEvidence: [{ sourceSpan: { start: 4, end: 8 }, authoredText: 'Save' }] } };
  const { result } = await run(draft, draft, decision, decision);
  if (result.kind !== 'rejected') throw new Error('Expected stop');
  expect(result.decisions?.primary).toEqual(decision.response);
  expect(result.decisions?.independent).toEqual(decision.response);
  const safe = projectActionSemanticStopV2(result);
  expect(ActionSemanticInterpretationStopV2Schema.safeParse(safe).success).toBe(true);
  expect(safe).not.toHaveProperty('sourceInstruction'); expect(safe).not.toHaveProperty('drafts'); expect(safe).not.toHaveProperty('decisions');
  expect(JSON.stringify(safe)).not.toContain('Save');
  expect(ActionSemanticInterpretationStopV2Schema.safeParse({ ...safe, approved: true }).success).toBe(false);
});
