import { expect, test } from '@playwright/test';
import { parseTestSpecV6V2, type ActionGoalV2, type TestSpecV6V2 } from '../app/domain/index.js';
import { createOpenAIActionSemanticExtractionModelsV2 } from '../app/interpretation/deferred-action-v2-adapters.js';
import { interpretDeferredActionTaskV2 } from '../app/interpretation/deferred-action-v2-interpret.js';
import { normalizeIndependentActionExtractionV5Wire, normalizePrimaryActionExtractionV5Wire,
  normalizePrimaryActionExtractionV4Wire,
  normalizePrimaryActionExtractionV3Wire, normalizePrimaryActionExtractionV2Wire,
  ACTION_V2_PRIMARY_RESPONSE_FORMAT,
  ACTION_V2_INDEPENDENT_RESPONSE_FORMAT } from '../app/interpretation/deferred-action-v2-wire.js';
import { action, choose, name, relation, spec } from './helpers/action-v2-fixtures.js';
import { unspannedWire, unspannedWireV3, unspannedWireV4 } from './helpers/deferred-v3-wire.js';

const clone = <T>(value: T): T => structuredClone(value);
function responseBody(wire: unknown) { return { status: 'completed', error: null, incomplete_details: null,
  output: [{ type: 'message', status: 'completed', role: 'assistant',
    content: [{ type: 'output_text', text: JSON.stringify(wire) }] }] }; }
async function interpret(primary: TestSpecV6V2, independent: TestSpecV6V2 = clone(primary),
  provided?: { primary?: unknown; independent?: unknown }) {
  const calls: { input: string; text: { format: { name: string } } }[] = [];
  const outputs = [provided?.primary ?? unspannedWire(primary, 'primary'),
    provided?.independent ?? unspannedWire(independent, 'independent')];
  const models = createOpenAIActionSemanticExtractionModelsV2({ apiKey: () => 'mock', fetchImpl: (async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(responseBody(outputs[calls.length - 1])));
  }) as typeof fetch });
  const { testSpecId, sourceInstruction, executionProfileRef, startState } = primary;
  return { result: await interpretDeferredActionTaskV2({ testSpecId, sourceInstruction, executionProfileRef, startState }, models), calls };
}

function liveFiveSteps(): TestSpecV6V2 {
  const clauses = [
    'Go to https://the-internet.herokuapp.com/',
    'Find and click the link with the text: "Dropdown"',
    'Confirm it takes you to https://the-internet.herokuapp.com/dropdown',
    'From the dropdown, select Option 1.',
    'Verify that Option 1 is selected.',
  ];
  const exactTask = clauses.map((clause, i) => `${i + 1}. ${clause}`).join('\n');
  const link = action([['Find and click', 'effect'], [' the ', 'neutral'], ['link', 'target'],
    [' with the text: "', 'neutral'], ['Dropdown', 'target'], ['"', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'activate', sourceSegmentIds: ['p0'] },
    { id: 'o', kind: 'operation', operation: 'click', sourceSegmentIds: ['p0'] },
    { id: 'r', kind: 'constraint', constraint: 'role', subject: { kind: 'target' }, polarity: 'positive',
      authoredText: 'link', sourceSegmentIds: ['p2'] }, name('n', ['p4'], 'Dropdown'),
  ]);
  const choose = action([['From the ', 'context'], ['dropdown', 'target'], [', ', 'neutral'],
    ['select', 'effect'], [' ', 'neutral'], ['Option 1', 'argument'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: ['p3'] },
    { id: 'r', kind: 'constraint', constraint: 'role', subject: { kind: 'target' }, polarity: 'positive',
      authoredText: 'dropdown', sourceSegmentIds: ['p1'] },
    { id: 'c', kind: 'constraint', constraint: 'context', subject: { kind: 'target' }, polarity: 'positive',
      authoredText: 'From the dropdown', sourceSegmentIds: ['p0', 'p1'] },
    { id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option 1', sourceSegmentIds: ['p5'] },
  ]);
  const steps: TestSpecV6V2['steps'] = [
    { id: 's1', type: 'navigate', sourceText: clauses[0]!, sourceInstructionSpan: { start: 0, end: 1 },
      url: 'https://the-internet.herokuapp.com/' },
    { ...link, id: 's2', sourceStepId: 's2' },
    { id: 's3', type: 'verification_goal', sourceText: clauses[2]!, instruction: clauses[2]!,
      sourceInstructionSpan: { start: 0, end: 1 } },
    { ...choose, id: 's4', sourceStepId: 's4' },
    { id: 's5', type: 'verification_goal', verificationVersion: '2', sourceText: clauses[4]!,
      instruction: clauses[4]!, sourceInstructionSpan: { start: 0, end: 1 },
      claim: { kind: 'native_owned_option_selected', optionLabel: 'Option 1', expectedSelected: true,
        optionSourceSpan: { start: 12, end: 20 }, controlConstraints: [] } },
  ];
  const accounting: TestSpecV6V2['instructionAccounting'] = [];
  let cursor = 0;
  for (const [i, clause] of clauses.entries()) {
    const prefix = `${i + 1}. `;
    accounting.push({ classification: 'neutral', authoredText: prefix,
      sourceSpan: { start: cursor, end: cursor + prefix.length } }); cursor += prefix.length;
    const span = { start: cursor, end: cursor + clause.length };
    steps[i]!.sourceInstructionSpan = span;
    accounting.push({ classification: 'clause', stepId: steps[i]!.id, authoredText: clause, sourceSpan: span });
    cursor = span.end;
    if (i < clauses.length - 1) { accounting.push({ classification: 'neutral', authoredText: '\n',
      sourceSpan: { start: cursor, end: cursor + 1 } }); cursor++; }
  }
  return { schemaVersion: '6', sourceContractVersion: '2', testSpecId: 'exactLiveFive',
    sourceInstruction: exactTask, executionProfileRef: { id: 'desktop', version: '1' },
    startState: { url: 'about:blank' }, steps, instructionAccounting: accounting };
}

test('exact five-step live source and URLs survive both offsetless extractions and admission', async () => {
  const draft = liveFiveSteps();
  const primaryWire = unspannedWire(draft, 'primary') as { response: any };
  const independentWire = unspannedWire(draft, 'independent') as { response: any };
  for (const wire of [primaryWire, independentWire]) {
    const wireSteps = wire.response.steps ?? wire.response.clauses;
    for (const segment of wire.response.instructionAccounting) {
      if (segment.classification === 'clause') expect(segment).not.toHaveProperty('stepId');
    }
    for (const step of wireSteps) {
      expect(step).not.toHaveProperty('sourceText');
      if (step.type === 'action_goal') {
        expect(step).not.toHaveProperty('sourceStepId');
        for (const segment of step.sourceAccounting) expect(segment).not.toHaveProperty('obligationIds');
        for (const item of [...step.obligations, ...step.anchors]) expect(item).not.toHaveProperty('authoredText');
      }
      if (step.type === 'verification_goal') expect(step).not.toHaveProperty('instruction');
    }
    expect(wireSteps[4].claim).not.toHaveProperty('optionLabel');
  }
  expect(draft.sourceInstruction).toBe('1. Go to https://the-internet.herokuapp.com/\n' +
    '2. Find and click the link with the text: "Dropdown"\n' +
    '3. Confirm it takes you to https://the-internet.herokuapp.com/dropdown\n' +
    '4. From the dropdown, select Option 1.\n' +
    '5. Verify that Option 1 is selected.');
  const { result, calls } = await interpret(draft);
  expect(calls).toHaveLength(2);
  expect(calls.map((call) => call.input)).toEqual([draft.sourceInstruction, draft.sourceInstruction]);
  expect(calls.map((call) => call.text.format.name)).toEqual([
    ACTION_V2_PRIMARY_RESPONSE_FORMAT.name, ACTION_V2_INDEPENDENT_RESPONSE_FORMAT.name]);
  expect(result.kind).toBe('accepted');
  if (result.kind === 'accepted') {
    expect(result.testSpec.sourceInstruction).toBe(draft.sourceInstruction);
    expect(result.testSpec.steps.map((step) => step.sourceText)).toEqual(draft.steps.map((step) => step.sourceText));
    expect(result.testSpec.steps[0]).toMatchObject({ url: 'https://the-internet.herokuapp.com/' });
    expect(result.testSpec.steps[2]!.sourceText).toContain('https://the-internet.herokuapp.com/dropdown');
    const link = result.testSpec.steps[1];
    if (!link || link.type !== 'action_goal') throw new Error('Expected link ActionGoal');
    expect(link.sourceStepId).toBe(link.id);
    expect(link.sourceAccounting[0]!.obligationIds).toEqual(['e', 'o']);
    expect(link.anchors).toEqual([]);
    expect(link.obligations.find((item) => item.kind === 'constraint' && item.constraint === 'name'))
      .toMatchObject({ authoredText: 'Dropdown' });
    const choice = result.testSpec.steps[3];
    if (!choice || choice.type !== 'action_goal') throw new Error('Expected choice ActionGoal');
    expect(choice.sourceAccounting[1]!.obligationIds).toEqual(['r', 'c']);
    expect(choice.obligations.find((item) => item.kind === 'argument'))
      .toMatchObject({ authoredText: 'Option 1' });
    const verification = result.testSpec.steps[4];
    if (!verification || verification.type !== 'verification_goal' || !('verificationVersion' in verification))
      throw new Error('Expected native VerificationGoal');
    expect(verification.claim.optionLabel).toBe('Option 1');
    expect(result.testSpec.instructionAccounting.filter((item) => item.classification === 'clause')
      .map((item) => item.stepId)).toEqual(draft.steps.map((step) => step.id));
  }
});

test('UTF-16 boundaries, CRLF, repeated text and punctuation derive from ordered reconstruction', () => {
  const goal = action([['Set', 'effect'], [' ', 'neutral'], ['Save😀', 'target'], [' to ', 'neutral'],
    ['Save😀', 'argument'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'enter_text', sourceSegmentIds: ['p0'] },
    name('n', ['p2'], 'Save😀'),
    { id: 'a', kind: 'argument', purpose: 'entered_text', authoredText: 'Save😀', sourceSegmentIds: ['p4'] },
  ]);
  const draft = spec(goal); const prefix = '1. '; const suffix = '\r\n2. Save😀';
  draft.sourceInstruction = prefix + goal.sourceText + suffix;
  draft.steps[0]!.sourceInstructionSpan = { start: prefix.length, end: prefix.length + goal.sourceText.length };
  draft.instructionAccounting = [
    { classification: 'neutral', authoredText: prefix, sourceSpan: { start: 0, end: prefix.length } },
    { classification: 'clause', stepId: goal.id, authoredText: goal.sourceText,
      sourceSpan: draft.steps[0]!.sourceInstructionSpan },
    { classification: 'neutral', authoredText: suffix,
      sourceSpan: { start: prefix.length + goal.sourceText.length, end: draft.sourceInstruction.length } },
  ];
  const normalized = JSON.parse(normalizePrimaryActionExtractionV5Wire(unspannedWire(draft, 'primary'), draft.sourceInstruction));
  const segments = normalized.steps[0].sourceAccounting;
  expect(segments[2].sourceSpan).toEqual({ start: 4, end: 10 });
  expect(segments[4].sourceSpan).toEqual({ start: 14, end: 20 });
  expect(normalized.steps[0].sourceInstructionSpan).toEqual(draft.steps[0]!.sourceInstructionSpan);
  expect(normalized.instructionAccounting.at(-1).sourceSpan.end).toBe(draft.sourceInstruction.length);
  expect(() => parseTestSpecV6V2({ ...draft, steps: normalized.steps,
    instructionAccounting: normalized.instructionAccounting })).not.toThrow();
});

test('new wire rejects omissions, rewrites, reorder, duplicate, empty and model offsets on either extraction', () => {
  for (const format of [ACTION_V2_PRIMARY_RESPONSE_FORMAT, ACTION_V2_INDEPENDENT_RESPONSE_FORMAT]) {
    const schema = JSON.stringify(format.schema);
    expect(schema).not.toContain('sourceSpan');
    expect(schema).not.toContain('sourceInstructionSpan');
    expect(schema).not.toContain('optionSourceSpan');
  }
  const draft = spec(action([['Select', 'effect'], [' ', 'neutral'], ['Option 1', 'argument'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option 1', sourceSegmentIds: ['p2'] },
  ]));
  const good = unspannedWire(draft, 'primary') as { response: any };
  const edits: ((wire: typeof good) => void)[] = [
    (wire) => { wire.response.instructionAccounting[0].authoredText = 'Select Option 1'; },
    (wire) => { wire.response.instructionAccounting[0].authoredText = 'select Option 1.'; },
    (wire) => { wire.response.steps[0].sourceAccounting[1].authoredText = '  '; },
    (wire) => { wire.response.steps[0].sourceAccounting.reverse(); },
    (wire) => { wire.response.steps[0].sourceAccounting[2].authoredText = 'Option 1Option 1'; },
    (wire) => { wire.response.steps[0].sourceAccounting[1].authoredText = ''; },
    (wire) => { wire.response.steps[0].sourceInstructionSpan = { start: 0, end: 16 }; },
    (wire) => { wire.response.steps[0].sourceAccounting[0].sourceSpan = { start: 0, end: 6 }; },
    (wire) => { wire.response.instructionAccounting[0].sourceSpan = { start: 0, end: 16 }; },
  ];
  for (const edit of edits) {
    const wire = clone(good); edit(wire);
    expect(() => normalizePrimaryActionExtractionV5Wire(wire, draft.sourceInstruction)).toThrow();
    const independent = { response: { ...wire.response, kind: 'source_extraction', clauses: wire.response.steps } };
    delete (independent.response as any).steps;
    expect(() => normalizeIndependentActionExtractionV5Wire(independent, draft.sourceInstruction)).toThrow();
  }
  const oldWire = { response: { ...good.response, steps: draft.steps,
    instructionAccounting: draft.instructionAccounting } };
  expect(() => normalizePrimaryActionExtractionV2Wire(oldWire)).not.toThrow();
  expect(() => normalizePrimaryActionExtractionV5Wire(oldWire, draft.sourceInstruction)).toThrow();
  const v3Wire = unspannedWireV3(draft, 'primary');
  expect(() => normalizePrimaryActionExtractionV3Wire(v3Wire, draft.sourceInstruction)).not.toThrow();
  expect(() => normalizePrimaryActionExtractionV5Wire(v3Wire, draft.sourceInstruction)).toThrow();
});

test('nested native claim and decision evidence use full exact partitions without model offsets', () => {
  const draft = liveFiveSteps();
  const wire = unspannedWire(draft, 'primary') as { response: any };
  const normalized = JSON.parse(normalizePrimaryActionExtractionV5Wire(wire, draft.sourceInstruction));
  expect(normalized.steps[4].claim.optionSourceSpan).toEqual({ start: 12, end: 20 });
  for (const edit of [
    (value: any) => { value.response.steps[4].claim.claimAccounting[0].authoredText = 'Verify'; },
    (value: any) => { value.response.steps[4].claim.optionSourceSpan = { start: 12, end: 20 }; },
    (value: any) => { value.response.steps[4].claim.claimAccounting[1].controlIndex = 0; },
  ]) {
    const changed = clone(wire); edit(changed);
    expect(() => normalizePrimaryActionExtractionV5Wire(changed, draft.sourceInstruction)).toThrow();
  }
  const decision = { response: { kind: 'unresolved', reasonCode: 'unclear_reference', sourcePartition: [
    { classification: 'neutral', authoredText: draft.sourceInstruction.slice(0, 3) },
    { classification: 'evidence', authoredText: draft.sourceInstruction.slice(3) },
  ] } };
  expect(JSON.parse(normalizePrimaryActionExtractionV5Wire(decision, draft.sourceInstruction)).sourceEvidence[0].sourceSpan)
    .toEqual({ start: 3, end: draft.sourceInstruction.length });
  decision.response.sourcePartition[0]!.authoredText = '1.';
  expect(() => normalizePrimaryActionExtractionV5Wire(decision, draft.sourceInstruction)).toThrow();
});

test('text-exact but semantically wrong ownership reaches independent semantic comparison', async () => {
  const faithful = spec(action([['Choose', 'effect'], [' ', 'neutral'], ['Option 1', 'argument'], [' at the ', 'context'],
    ['Country', 'target'], [' ', 'context'], ['dropdown', 'target'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option 1', sourceSegmentIds: ['p2'] },
    name('n', ['p4'], 'Country'),
    { id: 'r', kind: 'constraint', constraint: 'role', subject: { kind: 'target' }, polarity: 'positive',
      authoredText: 'dropdown', sourceSegmentIds: ['p6'] },
    { id: 'c', kind: 'constraint', constraint: 'context', subject: { kind: 'target' }, polarity: 'positive',
      authoredText: ' at the Country dropdown', sourceSegmentIds: ['p3', 'p4', 'p5', 'p6'] },
  ]));
  const wrong = spec(action([['Choose', 'effect'], [' ', 'neutral'], ['Option 1 at the Country dropdown', 'argument'],
    ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option 1 at the Country dropdown', sourceSegmentIds: ['p2'] },
  ]));
  const { result, calls } = await interpret(wrong, faithful);
  expect(calls).toHaveLength(2);
  expect(result).toMatchObject({ kind: 'rejected', stop: { stage: 'admission', code: 'SEMANTIC_FIDELITY_MISMATCH' } });
});

test('malformed obligation references stop mechanically in the affected extraction phase', async () => {
  const draft = spec(choose('at'));
  for (const phase of ['primary', 'independent'] as const) {
    for (const ids of [['missing'], ['p2', 'p2'], ['p4', 'p2'], ['p2', 'p4']]) {
      const wire = unspannedWire(draft, phase) as { response: any };
      const step = (wire.response.steps ?? wire.response.clauses)[0];
      step.obligations.find((item: { kind: string }) => item.kind === 'argument').sourceSegmentIds = ids;
      const { result, calls } = await interpret(draft, draft, { [phase]: wire });
      expect(calls).toHaveLength(phase === 'primary' ? 1 : 2);
      expect(result).toMatchObject({ kind: 'rejected', stop: { stage: phase,
        category: 'structural', code: 'INVALID_SOURCE_REPRESENTATION' } });
    }
  }
});

test('closed successor wire rejects model-supplied duplicate text and keeps previous offsetless reader distinct', () => {
  const draft = liveFiveSteps();
  const good = unspannedWire(draft, 'primary') as { response: any };
  for (const edit of [
    (wire: typeof good) => { wire.response.steps[1].obligations[2].authoredText = 'Invented'; },
    (wire: typeof good) => { wire.response.steps[3].obligations.at(-1).authoredText = 'Option 2'; },
    (wire: typeof good) => { wire.response.steps[1].sourceText = 'Invented'; },
    (wire: typeof good) => { wire.response.steps[2].instruction = 'Invented'; },
    (wire: typeof good) => { wire.response.steps[4].claim.optionLabel = 'Invented'; },
  ]) {
    const wire = clone(good); edit(wire);
    expect(() => normalizePrimaryActionExtractionV5Wire(wire, draft.sourceInstruction)).toThrow();
  }
  const previousV3 = unspannedWireV3(draft, 'primary');
  const previousV4 = unspannedWireV4(draft, 'primary');
  expect(() => normalizePrimaryActionExtractionV3Wire(previousV3, draft.sourceInstruction)).not.toThrow();
  expect(() => normalizePrimaryActionExtractionV4Wire(previousV4, draft.sourceInstruction)).not.toThrow();
  expect(() => normalizePrimaryActionExtractionV5Wire(previousV4, draft.sourceInstruction)).toThrow();
  expect(() => normalizePrimaryActionExtractionV4Wire(good, draft.sourceInstruction)).toThrow();
});

test('native option and control text are canonically sourced by classified claim segments', () => {
  const sourceText = 'Verify that Option 1 in Country is selected.';
  const optionStart = sourceText.indexOf('Option 1'), controlStart = sourceText.indexOf('Country');
  const verification: TestSpecV6V2['steps'][number] = { id: 'verify', type: 'verification_goal',
    verificationVersion: '2', sourceText, instruction: sourceText,
    sourceInstructionSpan: { start: 0, end: sourceText.length }, claim: {
      kind: 'native_owned_option_selected', optionLabel: 'Option 1', expectedSelected: true,
      optionSourceSpan: { start: optionStart, end: optionStart + 8 },
      controlConstraints: [{ kind: 'label', text: 'Country', sourceSpan: { start: controlStart, end: controlStart + 7 } }],
    } };
  const draft: TestSpecV6V2 = { ...spec(action([['Select', 'effect'], [' ', 'neutral'], ['Option 1', 'argument'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: 'choice', sourceSegmentIds: ['p2'], authoredText: 'Option 1' },
  ])), sourceInstruction: sourceText, steps: [verification],
  instructionAccounting: [{ classification: 'clause', stepId: 'verify', authoredText: sourceText,
    sourceSpan: { start: 0, end: sourceText.length } }] };
  const wire = unspannedWire(draft, 'primary') as { response: any };
  expect(wire.response.steps[0].claim).not.toHaveProperty('optionLabel');
  expect(wire.response.steps[0].claim.controlConstraints[0]).not.toHaveProperty('text');
  const canonical = JSON.parse(normalizePrimaryActionExtractionV5Wire(wire, sourceText));
  expect(canonical.steps[0].claim).toMatchObject({ optionLabel: 'Option 1',
    controlConstraints: [{ kind: 'label', text: 'Country' }] });
  const changed = clone(wire);
  changed.response.steps[0].claim.claimAccounting[3].controlIndex = 1;
  expect(() => normalizePrimaryActionExtractionV5Wire(changed, sourceText)).toThrow();
  const injected = clone(wire);
  injected.response.steps[0].claim.controlConstraints[0].text = 'Fabricated';
  expect(() => normalizePrimaryActionExtractionV5Wire(injected, sourceText)).toThrow();
});

test('forward-only graph rejects dangling, duplicate, cross-clause, illegal and unowned material refs', async () => {
  const draft = spec(choose('at'));
  for (const phase of ['primary', 'independent'] as const) {
    for (const edit of [
      (step: any) => { step.obligations.find((item: any) => item.kind === 'argument').sourceSegmentIds = ['missing']; },
      (step: any) => { step.obligations.find((item: any) => item.kind === 'argument').sourceSegmentIds = ['p2', 'p2']; },
      (step: any) => { step.obligations.find((item: any) => item.kind === 'argument').sourceSegmentIds = ['p4']; },
      (step: any) => { step.obligations.find((item: any) => item.kind === 'argument').sourceSegmentIds = ['p1']; },
      (step: any) => { step.obligations = step.obligations.filter((item: any) => item.kind !== 'argument'); },
    ]) {
      const wire = unspannedWire(draft, phase) as { response: any };
      edit((wire.response.steps ?? wire.response.clauses)[0]);
      const { result, calls } = await interpret(draft, draft, { [phase]: wire });
      expect(calls).toHaveLength(phase === 'primary' ? 1 : 2);
      expect(result).toMatchObject({ kind: 'rejected', stop: { stage: phase,
        category: 'structural', code: 'INVALID_SOURCE_REPRESENTATION' } });
    }
  }
  const five = liveFiveSteps();
  const crossClause = unspannedWire(five, 'primary') as { response: any };
  const link = crossClause.response.steps[1], choice = crossClause.response.steps[3];
  link.sourceAccounting[4].id = 'onlyLinkClause';
  link.obligations.find((item: any) => item.kind === 'constraint' && item.constraint === 'name')
    .sourceSegmentIds = ['onlyLinkClause'];
  choice.obligations.find((item: any) => item.kind === 'argument').sourceSegmentIds = ['onlyLinkClause'];
  expect(() => normalizePrimaryActionExtractionV5Wire(crossClause, five.sourceInstruction)).toThrow();
  const canonical = JSON.parse(normalizePrimaryActionExtractionV5Wire(unspannedWire(draft, 'primary'), draft.sourceInstruction));
  const changed = clone({ ...draft, steps: canonical.steps, instructionAccounting: canonical.instructionAccounting });
  (changed.steps[0] as ActionGoalV2).sourceAccounting[2]!.obligationIds = [];
  expect(() => parseTestSpecV6V2(changed)).toThrow();
});

test('new provider wire rejects reverse fields; v8/v4 reader remains separately usable', () => {
  const draft = liveFiveSteps();
  const current = unspannedWire(draft, 'primary') as { response: any };
  for (const edit of [
    (wire: typeof current) => { wire.response.steps[1].sourceStepId = 's2'; },
    (wire: typeof current) => { wire.response.steps[1].sourceAccounting[0].obligationIds = ['e', 'o']; },
    (wire: typeof current) => { wire.response.instructionAccounting[1].stepId = 's1'; },
  ]) {
    const wire = clone(current); edit(wire);
    expect(() => normalizePrimaryActionExtractionV5Wire(wire, draft.sourceInstruction)).toThrow();
  }
  const oldPrimary = unspannedWireV4(draft, 'primary');
  const oldIndependent = unspannedWireV4(draft, 'independent');
  expect(() => normalizePrimaryActionExtractionV4Wire(oldPrimary, draft.sourceInstruction)).not.toThrow();
  expect(() => normalizePrimaryActionExtractionV5Wire(oldPrimary, draft.sourceInstruction)).toThrow();
  expect(() => normalizeIndependentActionExtractionV5Wire(oldIndependent, draft.sourceInstruction)).toThrow();
});

test('wrong but internally valid forward ownership reaches independent semantic admission', async () => {
  const faithful = spec(choose('at'));
  const primary = unspannedWire(faithful, 'primary') as { response: any };
  const step = primary.response.steps[0];
  const country = step.sourceAccounting.find((item: { authoredText: string }) => item.authoredText === 'Country');
  country.classification = 'neutral';
  step.obligations = step.obligations.filter((item: { kind: string; constraint?: string }) =>
    item.kind !== 'constraint' || item.constraint !== 'name');
  const context = step.obligations.find((item: { kind: string; constraint?: string }) =>
    item.kind === 'constraint' && item.constraint === 'context');
  context.sourceSegmentIds = context.sourceSegmentIds.filter((id: string) => id !== country.id);
  const { result, calls } = await interpret(faithful, faithful, { primary });
  expect(calls).toHaveLength(2);
  expect(result).toMatchObject({ kind: 'rejected', stop: { stage: 'admission',
    category: 'omission_fidelity', code: 'SEMANTIC_FIDELITY_MISMATCH' } });
});

test('relationship anchor extent and target ownership remain independent forward choices', async () => {
  const faithful = spec(relation());
  const { result } = await interpret(faithful);
  expect(result.kind).toBe('accepted');
  if (result.kind !== 'accepted') return;
  const goal = result.testSpec.steps[0];
  if (!goal || goal.type !== 'action_goal') throw new Error('Expected ActionGoal');
  expect(goal.anchors).toEqual([{ id: 'email', sourceSegmentIds: ['p5'], authoredText: 'Email' }]);
  expect(goal.obligations.find((item) => item.kind === 'relationship')).toMatchObject({
    anchorId: 'email', sourceSegmentIds: ['p4', 'p5'], authoredText: 'next to Email',
  });
  expect(goal.sourceAccounting[2]!.obligationIds).toEqual(['r']);
  expect(goal.sourceAccounting[5]!.obligationIds).toEqual(['l']);
  const wrong = clone(faithful), changed = wrong.steps[0] as ActionGoalV2;
  changed.anchors = [];
  changed.obligations = changed.obligations.filter((item) => item.kind !== 'relationship');
  changed.obligations.push(name('emailName', ['p5'], 'Email'));
  changed.sourceAccounting[4] = { ...changed.sourceAccounting[4]!, classification: 'neutral', obligationIds: [] };
  changed.sourceAccounting[5] = { ...changed.sourceAccounting[5]!, classification: 'target', obligationIds: ['emailName'] };
  const compared = await interpret(wrong, faithful);
  expect(compared.calls).toHaveLength(2);
  expect(compared.result).toMatchObject({ kind: 'rejected', stop: { stage: 'admission',
    code: 'SEMANTIC_INTERPRETATION_DISAGREEMENT' } });
});
