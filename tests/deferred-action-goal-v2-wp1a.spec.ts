import { test, expect } from '@playwright/test';
import { ActionGoalV2Schema, parseTestSpecV6V2, parseTestSpecV6, admitActionSemanticsV2,
  buildActionObligationHandoffV2, validateActionObligationHandoffV2, validateSemanticAdmissionReadbackV2,
  requireTrustedSemanticAdmissionV2, SemanticAdmissionRecordV2Schema,
  type ActionGoalV2, type ActionObligationV2, type ActionSourceSegmentV2, type TestSpecV6V2,
  type TrustedSemanticAdmissionV2 } from '../app/domain/index.js';

type Piece = readonly [string, ActionSourceSegmentV2['classification']];
function action(pieces: readonly Piece[], obligations: ActionObligationV2[], anchors: ActionGoalV2['anchors'] = []): ActionGoalV2 {
  let end = 0;
  return { id: 's1', sourceStepId: 's1', type: 'action_goal', goalVersion: '2',
    sourceText: pieces.map(([text]) => text).join(''), sourceInstructionSpan: { start: 0, end: pieces.reduce((n, [text]) => n + text.length, 0) },
    obligations, anchors, sourceAccounting: pieces.map(([authoredText, classification], index) => {
      const start = end; end += authoredText.length;
      const base = { id: `p${index}`, sourceSpan: { start, end }, authoredText };
      return classification === 'unresolved' ? { ...base, classification, obligationIds: [], reason: 'unclassified_material' } :
        { ...base, classification, obligationIds: obligations.filter((item) => item.sourceSegmentIds.includes(base.id)).map((item) => item.id) };
    }) };
}
const name = (id: string, sourceSegmentIds: string[], authoredText: string): ActionObligationV2 => ({
  id, kind: 'constraint', constraint: 'name', subject: { kind: 'target' }, polarity: 'positive', sourceSegmentIds, authoredText,
});
const effect = (word: ActionObligationV2 & { kind: 'effect' }) => word;
function activate(verb = 'Tap', target = 'Save'): ActionGoalV2 {
  return action([[verb, 'effect'], [' ', 'neutral'], [target, 'target'], ['.', 'neutral']], [
    effect({ id: 'e', kind: 'effect', effect: 'activate', sourceSegmentIds: ['p0'] }), name('n', ['p2'], target),
    ...(verb === 'Click' ? [{ id: 'o', kind: 'operation' as const, operation: 'click' as const, sourceSegmentIds: ['p0'] }] : []),
  ]);
}
function choose(connector?: string, leading = false): ActionGoalV2 {
  if (!connector) return action([['Select', 'effect'], [' ', 'neutral'], ['Option 1', 'argument'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option 1', sourceSegmentIds: ['p2'] },
  ]);
  const pieces: Piece[] = leading ? [['In the ', 'context'], ['Country', 'target'], [' ', 'context'], ['dropdown', 'target'],
    [', ', 'neutral'], ['choose', 'effect'], [' ', 'neutral'], ['Option 1', 'argument'], ['.', 'neutral']] :
    [['Choose', 'effect'], [' ', 'neutral'], ['Option 1', 'argument'], [` ${connector} the `, 'context'],
      ['Country', 'target'], [' ', 'context'], ['dropdown', 'target'], ['.', 'neutral']];
  const contextIds = leading ? ['p0', 'p1', 'p2', 'p3'] : ['p3', 'p4', 'p5', 'p6'];
  return action(pieces, [
    { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: [leading ? 'p5' : 'p0'] },
    { id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option 1', sourceSegmentIds: [leading ? 'p7' : 'p2'] },
    name('n', [leading ? 'p1' : 'p4'], 'Country'),
    { id: 'r', kind: 'constraint', constraint: 'role', subject: { kind: 'target' }, polarity: 'positive',
      sourceSegmentIds: [leading ? 'p3' : 'p6'], authoredText: 'dropdown' },
    { id: 'c', kind: 'constraint', constraint: 'context', subject: { kind: 'target' }, polarity: 'positive',
      sourceSegmentIds: contextIds, authoredText: contextIds.map((id) => pieces[Number(id.slice(1))]![0]).join('') },
  ]);
}
function relation(): ActionGoalV2 {
  return action([['Click', 'effect'], [' the ', 'neutral'], ['button', 'target'], [' ', 'neutral'],
    ['next to ', 'relationship'], ['Email', 'relationship'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'activate', sourceSegmentIds: ['p0'] },
    { id: 'o', kind: 'operation', operation: 'click', sourceSegmentIds: ['p0'] },
    { id: 'r', kind: 'constraint', constraint: 'role', subject: { kind: 'target' }, polarity: 'positive', sourceSegmentIds: ['p2'], authoredText: 'button' },
    { id: 'l', kind: 'relationship', subject: { kind: 'target' }, anchorId: 'email', polarity: 'positive', sourceSegmentIds: ['p4', 'p5'], authoredText: 'next to Email' },
  ], [{ id: 'email', sourceSegmentIds: ['p5'], authoredText: 'Email' }]);
}
function spec(goal: ActionGoalV2): TestSpecV6V2 {
  return { schemaVersion: '6', sourceContractVersion: '2', testSpecId: 'test', sourceInstruction: goal.sourceText,
    executionProfileRef: { id: 'desktop', version: '1' }, startState: { url: 'about:blank' }, steps: [goal],
    instructionAccounting: [{ classification: 'clause', stepId: goal.id, sourceSpan: goal.sourceInstructionSpan, authoredText: goal.sourceText }] };
}
const versions = { goalContractVersion: '2' as const, primaryExtractionVersion: 'primary-v2', independentExtractionVersion: 'source-first-v2',
  primaryPromptVersion: 'primary-p1', independentPromptVersion: 'independent-p1' };
function admit(primary: TestSpecV6V2, independent: unknown = structuredClone(primary)) {
  const { testSpecId, sourceInstruction, executionProfileRef, startState } = primary;
  return admitActionSemanticsV2({ testSpecId, sourceInstruction, executionProfileRef, startState }, primary, independent, versions);
}
function rename(specInput: TestSpecV6V2): TestSpecV6V2 {
  const copy = structuredClone(specInput);
  const steps = new Map(copy.steps.map((step) => [step.id, `renamed_${step.id}`]));
  for (const step of copy.steps) {
    const oldId = step.id; step.id = steps.get(oldId)!;
    if (step.type !== 'action_goal') continue;
    step.sourceStepId = step.id;
    const ids = new Map([...step.sourceAccounting, ...step.obligations, ...step.anchors].map((item) => [item.id, `x_${item.id}`]));
    for (const segment of step.sourceAccounting) { segment.id = ids.get(segment.id)!; segment.obligationIds = segment.obligationIds.map((id) => ids.get(id)!).reverse(); }
    for (const anchor of step.anchors) { anchor.id = ids.get(anchor.id)!; anchor.sourceSegmentIds = anchor.sourceSegmentIds.map((id) => ids.get(id)!); }
    for (const item of step.obligations) {
      item.id = ids.get(item.id)!; item.sourceSegmentIds = item.sourceSegmentIds.map((id) => ids.get(id)!);
      if (item.kind === 'relationship') item.anchorId = ids.get(item.anchorId)!;
      if (item.kind === 'constraint' && item.subject.kind === 'anchor') item.subject.anchorId = ids.get(item.subject.anchorId)!;
      if (item.kind === 'reference') item.antecedentStepId = steps.get(item.antecedentStepId)!;
      if (item.kind === 'prerequisite') item.dependsOnStepId = steps.get(item.dependsOnStepId)!;
      if (item.kind === 'contrast') item.obligationIds = item.obligationIds.map((id) => ids.get(id)!).reverse();
    }
    step.obligations.reverse(); step.anchors.reverse();
  }
  for (const segment of copy.instructionAccounting) if (segment.classification === 'clause') segment.stepId = steps.get(segment.stepId)!;
  return copy;
}

for (const goal of [activate(), activate('Activate'), choose('at'), choose('using'), choose('in', true), choose(), relation()]) {
  test(`mechanical draft and matching extraction gate: ${goal.sourceText}`, () => {
    const draft = spec(goal);
    expect(parseTestSpecV6V2(draft)).toEqual(draft);
    expect(admit(draft, rename(draft)).record.admissionVersion).toBe('2');
  });
}

test('effect and role wording have no lexical whitelist; literal code is inert data', () => {
  const goal = action([['入力', 'effect'], [' ', 'neutral'], ['fetch("x")', 'argument'], [' to ', 'neutral'], ['保存', 'target']], [
    { id: 'e', kind: 'effect', effect: 'enter_text', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: 'entered_text', authoredText: 'fetch("x")', sourceSegmentIds: ['p2'] }, name('n', ['p4'], '保存'),
  ]);
  expect(admit(spec(goal)).spec.steps[0]).toEqual(goal);
});

test('absorbed Country, neutral Country and missing demanded mechanism fail independent agreement', () => {
  const faithful = spec(choose('at'));
  const absorbed = spec(action([['Choose', 'effect'], [' ', 'neutral'], ['Option 1 at the Country dropdown', 'argument'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option 1 at the Country dropdown', sourceSegmentIds: ['p2'] },
  ]));
  expect(() => admit(absorbed, faithful)).toThrow('SEMANTIC_FIDELITY_MISMATCH');
  const neutral = structuredClone(faithful); const goal = neutral.steps[0] as ActionGoalV2;
  goal.obligations = goal.obligations.filter((item) => ['e', 'a'].includes(item.id));
  goal.sourceAccounting = goal.sourceAccounting.map((item) => item.classification === 'target' || item.classification === 'context' ?
    { id: item.id, sourceSpan: item.sourceSpan, authoredText: item.authoredText, classification: 'neutral', obligationIds: [] } : item);
  expect(() => admit(neutral, faithful)).toThrow('SEMANTIC_FIDELITY_MISMATCH');
  const click = spec(activate('Click')); const omitted = structuredClone(click); const oldGoal = omitted.steps[0] as ActionGoalV2;
  oldGoal.obligations = oldGoal.obligations.filter((item) => item.kind !== 'operation');
  oldGoal.sourceAccounting[0]!.obligationIds = ['e'];
  expect(() => admit(omitted, click)).toThrow('SEMANTIC_FIDELITY_MISMATCH');
});

test('Email anchor cannot acquire target ownership through overlapping copied provenance', () => {
  const goal = relation(); goal.obligations.push(name('wrong', ['p5'], 'Email')); goal.sourceAccounting[5]!.obligationIds.push('wrong');
  expect(() => parseTestSpecV6V2(spec(goal))).toThrow('ILLEGAL_SEGMENT_OWNER');
  const wrong = activate('Click', 'Email');
  expect(() => admit(spec(relation()), spec(wrong))).toThrow('INVALID_SOURCE_REPRESENTATION');
  expect(relation().obligations.filter((item) => item.kind === 'constraint' && item.constraint === 'name')).toEqual([]);
  const wrongOwnership = relation(); wrongOwnership.anchors = [];
  wrongOwnership.obligations = wrongOwnership.obligations.filter((item) => item.kind !== 'relationship');
  wrongOwnership.obligations.push(name('emailName', ['p5'], 'Email'));
  wrongOwnership.sourceAccounting[4] = { id: 'p4', classification: 'neutral', authoredText: 'next to ', sourceSpan: wrongOwnership.sourceAccounting[4]!.sourceSpan, obligationIds: [] };
  wrongOwnership.sourceAccounting[5] = { id: 'p5', classification: 'target', authoredText: 'Email', sourceSpan: wrongOwnership.sourceAccounting[5]!.sourceSpan, obligationIds: ['emailName'] };
  expect(parseTestSpecV6V2(spec(wrongOwnership))).toBeTruthy();
  expect(() => admit(spec(wrongOwnership), spec(relation()))).toThrow('SEMANTIC_INTERPRETATION_DISAGREEMENT');
});

test('copied effect/purpose or polarity disagreements stop without semantic guessing', () => {
  const primary = spec(choose()); const changedEffect = structuredClone(primary); const goal = changedEffect.steps[0] as ActionGoalV2;
  const e = goal.obligations.find((item) => item.kind === 'effect')!; e.effect = 'enter_text';
  const a = goal.obligations.find((item) => item.kind === 'argument')!; a.purpose = 'entered_text';
  expect(parseTestSpecV6V2(changedEffect)).toBeTruthy();
  expect(() => admit(primary, changedEffect)).toThrow('SEMANTIC_INTERPRETATION_DISAGREEMENT');
  const positive = spec(activate()); const negative = structuredClone(positive);
  const n = (negative.steps[0] as ActionGoalV2).obligations.find((item) => item.kind === 'constraint')!; n.polarity = 'negative';
  expect(() => admit(positive, negative)).toThrow('SEMANTIC_INTERPRETATION_DISAGREEMENT');
});

test('source digest preserves distinct lone UTF-16 surrogates', () => {
  expect(admit(spec(activate('Tap', '\ud800'))).record.sourceDigest)
    .not.toBe(admit(spec(activate('Tap', '\ud801'))).record.sourceDigest);
});

test('exact literal bytes, repeated occurrence and UTF-16 Unicode offsets survive admission', () => {
  const goal = activate('Tap', '保存😀');
  expect(admit(spec(goal)).spec.sourceInstruction).toBe('Tap 保存😀.');
  const changed = structuredClone(goal); const target = changed.obligations.find((item) => item.kind === 'constraint')!;
  target.authoredText = '保存';
  expect(() => parseTestSpecV6V2(spec(changed))).toThrow('OBLIGATION_NOT_AUTHORED');
  const split = structuredClone(goal); split.sourceAccounting[2]!.sourceSpan.end -= 1;
  split.sourceAccounting[2]!.authoredText = '保存\ud83d';
  expect(() => parseTestSpecV6V2(spec(split))).toThrow('SPAN_OR_LITERAL_MISMATCH');
  const repeated = action([['Set', 'effect'], [' ', 'neutral'], ['Save', 'target'], [' to ', 'neutral'], ['Save', 'argument'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'enter_text', sourceSegmentIds: ['p0'] }, name('n', ['p2'], 'Save'),
    { id: 'a', kind: 'argument', purpose: 'entered_text', authoredText: 'Save', sourceSegmentIds: ['p4'] },
  ]);
  expect(admit(spec(repeated)).spec.steps[0]).toEqual(repeated);
});

test('quoted whitespace and punctuation are accounted without literal normalization', () => {
  const goal = action([['Enter', 'effect'], [' "', 'neutral'], ['  Jorge  ', 'argument'], ['".', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'enter_text', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: 'entered_text', authoredText: '  Jorge  ', sourceSegmentIds: ['p2'] },
  ]);
  expect(admit(spec(goal)).record.acceptedTestSpecDigest).toHaveLength(64);
  const wrong = structuredClone(goal); const arg = wrong.obligations.find((item) => item.kind === 'argument')!;
  arg.authoredText = 'Jorge'; expect(() => parseTestSpecV6V2(spec(wrong))).toThrow('OBLIGATION_NOT_AUTHORED');
});

for (const gap of [' ', ' and ', '\r\n\t', '-', '\u200b', '\u{1f600}']) {
  test(`literal provenance rejects omitted intervening source ${JSON.stringify(gap)}`, () => {
    for (const purpose of ['choice', 'entered_text'] as const) {
      const goal = action([['Set', 'effect'], [' ', 'neutral'], ['A', 'argument'], [gap, 'neutral'], ['B', 'argument'], ['.', 'neutral']], [
        { id: 'e', kind: 'effect', effect: purpose === 'choice' ? 'choose' : 'enter_text', sourceSegmentIds: ['p0'] },
        { id: 'a', kind: 'argument', purpose, authoredText: 'AB', sourceSegmentIds: ['p2', 'p4'] },
      ]);
      expect(() => parseTestSpecV6V2(spec(goal))).toThrow('NONCONTIGUOUS_ARGUMENT_PROVENANCE');
      expect(() => admit(spec(goal))).toThrow('INVALID_SOURCE_REPRESENTATION');
    }
  });
}

test('literal occurrence cannot be borrowed from elsewhere to justify discontiguous provenance', () => {
  const goal = action([['Set', 'effect'], [' ', 'neutral'], ['AB', 'target'], [' to ', 'neutral'],
    ['A', 'argument'], [' ', 'neutral'], ['B', 'argument'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'enter_text', sourceSegmentIds: ['p0'] }, name('n', ['p2'], 'AB'),
    { id: 'a', kind: 'argument', purpose: 'entered_text', authoredText: 'AB', sourceSegmentIds: ['p4', 'p6'] },
  ]);
  expect(goal.sourceText).toContain('AB');
  expect(() => parseTestSpecV6V2(spec(goal))).toThrow('NONCONTIGUOUS_ARGUMENT_PROVENANCE');
});

test('adjacent multi-span literal preserves Unicode, repeated occurrences and every intervening byte through handoff', () => {
  const literal = 'Caf\u00e9\u{1f600}\r\n\tCaf\u00e9\u{1f600}';
  const goal = action([['Fill', 'effect'], [' ', 'neutral'], [literal, 'target'], [' with "', 'neutral'],
    ['Caf\u00e9', 'argument'], ['\u{1f600}', 'argument'], ['\r\n\t', 'argument'], ['Caf\u00e9', 'argument'], ['\u{1f600}', 'argument'], ['".', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'enter_text', sourceSegmentIds: ['p0'] }, name('n', ['p2'], literal),
    { id: 'a', kind: 'argument', purpose: 'entered_text', authoredText: literal, sourceSegmentIds: ['p4', 'p5', 'p6', 'p7', 'p8'] },
  ]);
  expect(parseTestSpecV6V2(spec(goal))).toEqual(spec(goal));
  const trusted = admit(spec(goal), rename(spec(goal)));
  const handoff = buildActionObligationHandoffV2(trusted);
  expect(() => validateActionObligationHandoffV2(trusted, handoff)).not.toThrow();
  const accepted = trusted.spec.steps[0] as ActionGoalV2;
  expect(accepted.obligations.find((item) => item.kind === 'argument')?.authoredText).toBe(literal);
  const reversed = structuredClone(goal);
  reversed.obligations.find((item) => item.kind === 'argument')!.sourceSegmentIds.reverse();
  expect(() => parseTestSpecV6V2(spec(reversed))).toThrow('UNKNOWN_OR_UNORDERED_PROVENANCE');
});

test('non-literal context obligations retain ordered separated source spans', () => {
  const goal = action([['Click', 'effect'], [' ', 'neutral'], ['the ', 'context'], ['Save', 'target'],
    [' ', 'neutral'], ['button', 'target'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'activate', sourceSegmentIds: ['p0'] },
    { id: 'o', kind: 'operation', operation: 'click', sourceSegmentIds: ['p0'] }, name('n', ['p3'], 'Save'),
    { id: 'r', kind: 'constraint', constraint: 'role', subject: { kind: 'target' }, polarity: 'positive', authoredText: 'button', sourceSegmentIds: ['p5'] },
    { id: 'c', kind: 'constraint', constraint: 'context', subject: { kind: 'target' }, polarity: 'positive', authoredText: 'the button', sourceSegmentIds: ['p2', 'p5'] },
  ]);
  expect(parseTestSpecV6V2(spec(goal))).toEqual(spec(goal));
  expect(admit(spec(goal), rename(spec(goal))).record.admissionVersion).toBe('2');
});

test('mechanical malformed accounting, provenance, graph, bounds and closed fields reject', () => {
  const bad: Array<(goal: ActionGoalV2) => void> = [
    (goal) => { goal.sourceAccounting.splice(1, 1); },
    (goal) => { goal.sourceAccounting[1]!.sourceSpan.start = 0; },
    (goal) => { goal.sourceAccounting[2]!.authoredText = 'Cancel'; },
    (goal) => { goal.sourceAccounting[2]!.sourceSpan.end = 999; },
    (goal) => { goal.sourceStepId = 'different'; },
    (goal) => { goal.sourceAccounting[2]!.obligationIds = ['missing']; },
    (goal) => { goal.obligations[1]!.sourceSegmentIds = ['p0']; },
    (goal) => { goal.obligations.push({ id: 'ref', kind: 'reference', authoredText: 'Save', sourceSegmentIds: ['p2'], antecedentStepId: 's1', antecedent: 'target' });
      goal.sourceAccounting[2] = { ...goal.sourceAccounting[2]!, classification: 'reference', obligationIds: ['ref'] }; goal.obligations.splice(1, 1); },
    (goal) => { goal.obligations.push({ id: 'op', kind: 'operation', operation: 'fill', sourceSegmentIds: ['p0'] }); goal.sourceAccounting[0]!.obligationIds.push('op'); },
  ];
  for (const mutate of bad) { const goal = activate(); mutate(goal); expect(() => parseTestSpecV6V2(spec(goal))).toThrow(); }
  expect(ActionGoalV2Schema.safeParse({ ...activate(), selector: '#save' }).success).toBe(false);
  expect(ActionGoalV2Schema.safeParse({ ...activate(), approved: true }).success).toBe(false);
  expect(() => parseTestSpecV6V2({ ...spec(activate()), instructionAccounting: [] })).toThrow();
  const tooMany = activate(); tooMany.anchors = Array.from({ length: 25 }, (_, i) => ({ id: `a${i}`, sourceSegmentIds: ['p2'], authoredText: 'Save' }));
  expect(ActionGoalV2Schema.safeParse(tooMany).success).toBe(false);
});

test('residual clause and instruction text remain valid drafts but cannot gain admission', () => {
  const goal = activate(); goal.sourceAccounting[2] = { ...goal.sourceAccounting[2]!, classification: 'unresolved', obligationIds: [], reason: 'unclear_reference' };
  goal.obligations.splice(1, 1); const draft = spec(goal);
  expect(parseTestSpecV6V2(draft)).toEqual(draft);
  expect(() => admit(draft)).toThrow('SEMANTIC_INTERPRETATION_UNRESOLVED');
  const gapDraft = spec(activate()); gapDraft.sourceInstruction += ' maybe';
  gapDraft.instructionAccounting.push({ classification: 'unresolved', sourceSpan: { start: goal.sourceText.length, end: gapDraft.sourceInstruction.length },
    authoredText: ' maybe', reason: 'unclear_clause_linkage' });
  expect(parseTestSpecV6V2(gapDraft)).toEqual(gapDraft);
  expect(() => admit(gapDraft)).toThrow('SEMANTIC_INTERPRETATION_UNRESOLVED');
});

function multistage(): TestSpecV6V2 {
  const first = activate('Click'); const second = action([['Activate', 'effect'], [' ', 'neutral'], ['it', 'reference'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'activate', sourceSegmentIds: ['p0'] },
    { id: 'ref', kind: 'reference', sourceSegmentIds: ['p2'], authoredText: 'it', antecedentStepId: 's1', antecedent: 'target' },
  ]);
  const gap = ' Afterwards, '; const offset = first.sourceText.length + gap.length;
  second.id = 's2'; second.sourceStepId = 's2'; second.sourceInstructionSpan = { start: offset, end: offset + second.sourceText.length };
  const draft = spec(first); draft.sourceInstruction += gap + second.sourceText; draft.steps.push(second);
  draft.instructionAccounting.push({ classification: 'neutral', authoredText: gap, sourceSpan: { start: first.sourceText.length, end: offset } },
    { classification: 'clause', stepId: 's2', authoredText: second.sourceText, sourceSpan: second.sourceInstructionSpan });
  return draft;
}
test('instruction connector variations and backward reference IDs compare by occurrence', () => {
  const draft = multistage(); expect(admit(draft, rename(draft)).record.admissionVersion).toBe('2');
  const wrong = structuredClone(draft); const second = wrong.steps[1] as ActionGoalV2;
  const ref = second.obligations.find((item) => item.kind === 'reference')!; ref.antecedentStepId = 's2';
  expect(() => parseTestSpecV6V2(wrong)).toThrow('INVALID_BACKWARD_ACTION_REFERENCE');
  ref.antecedentStepId = 's1'; ref.antecedent = 'argument';
  expect(() => parseTestSpecV6V2(wrong)).toThrow('INVALID_BACKWARD_ACTION_REFERENCE');
  const omitted = structuredClone(draft); omitted.instructionAccounting.splice(1, 1);
  expect(() => parseTestSpecV6V2(omitted)).toThrow('INCOMPLETE_OR_OVERLAPPING_INSTRUCTION_PARTITION');
});

test('navigation and verification retain their existing contract beside v2 action admission', () => {
  const navText = 'Go to https://example.com/.';
  const actionGoal = activate('Click');
  const verificationText = 'Confirm the Save button exists.';
  const source = `${navText} Next, ${actionGoal.sourceText} Finally, ${verificationText}`;
  const actionStart = navText.length + ' Next, '.length;
  actionGoal.sourceInstructionSpan = { start: actionStart, end: actionStart + actionGoal.sourceText.length };
  const verifyStart = actionGoal.sourceInstructionSpan.end + ' Finally, '.length;
  const draft = spec(actionGoal); draft.sourceInstruction = source;
  draft.steps = [
    { id: 'nav', type: 'navigate', sourceText: navText, sourceInstructionSpan: { start: 0, end: navText.length }, url: 'https://example.com/' },
    actionGoal,
    { id: 'verify', type: 'verification_goal', sourceText: verificationText, instruction: verificationText,
      sourceInstructionSpan: { start: verifyStart, end: source.length }, subject: { role: 'button', accessibleName: 'Save' },
      intent: { kind: 'presence', expected: 'present' }, dependsOnStepId: actionGoal.id },
  ];
  draft.instructionAccounting = [
    { classification: 'clause', stepId: 'nav', authoredText: navText, sourceSpan: { start: 0, end: navText.length } },
    { classification: 'neutral', authoredText: ' Next, ', sourceSpan: { start: navText.length, end: actionStart } },
    { classification: 'clause', stepId: actionGoal.id, authoredText: actionGoal.sourceText, sourceSpan: actionGoal.sourceInstructionSpan },
    { classification: 'neutral', authoredText: ' Finally, ', sourceSpan: { start: actionGoal.sourceInstructionSpan.end, end: verifyStart } },
    { classification: 'clause', stepId: 'verify', authoredText: verificationText, sourceSpan: { start: verifyStart, end: source.length } },
  ];
  // Renaming helper also needs to remap the unchanged verification dependency.
  const independent = rename(draft);
  const verify = independent.steps[2]!; if (verify.type === 'verification_goal') verify.dependsOnStepId = 'renamed_s1';
  expect(admit(draft, independent).spec.steps).toHaveLength(3);
  const changed = structuredClone(draft); const badVerification = changed.steps[2]!;
  if (badVerification.type === 'verification_goal' && !('verificationVersion' in badVerification)) badVerification.intent = { kind: 'presence', expected: 'absent' };
  expect(() => parseTestSpecV6V2(changed)).toThrow('POLARITY_CONTRADICTION');
  const nav = changed.steps[0]!; if (nav.type === 'navigate') nav.url = 'https://user:password@example.com/';
  expect(() => parseTestSpecV6V2(changed)).toThrow();
});

test('relationship endpoints, reverse provenance and exact source boundaries cannot drift', () => {
  const unknownAnchor = relation(); const r = unknownAnchor.obligations.find((item) => item.kind === 'relationship')!;
  r.anchorId = 'unknown'; expect(() => parseTestSpecV6V2(spec(unknownAnchor))).toThrow();
  const missingReciprocal = activate(); missingReciprocal.sourceAccounting[2] = {
    ...missingReciprocal.sourceAccounting[2]!, classification: 'neutral', obligationIds: [],
  };
  expect(() => parseTestSpecV6V2(spec(missingReciprocal))).toThrow('MISSING_RECIPROCAL_OWNERSHIP');
  const faithful = spec(activate()); const changedBoundary = structuredClone(faithful); const goal = changedBoundary.steps[0] as ActionGoalV2;
  goal.sourceAccounting[1]!.sourceSpan.end += 1; goal.sourceAccounting[1]!.authoredText = ' S';
  goal.sourceAccounting[2]!.sourceSpan.start += 1; goal.sourceAccounting[2]!.authoredText = 'ave';
  const n = goal.obligations.find((item) => item.kind === 'constraint')!; n.authoredText = 'ave';
  expect(parseTestSpecV6V2(changedBoundary)).toBeTruthy();
  expect(() => admit(faithful, changedBoundary)).toThrow('SEMANTIC_INTERPRETATION_DISAGREEMENT');
});

test('unsupported mechanisms, exclusions and contrast remain source drafts and stop admission', () => {
  const unsupported = activate(); unsupported.obligations.push({ id: 'u', kind: 'unsupported_operation', sourceSegmentIds: ['p0'] });
  unsupported.sourceAccounting[0]!.obligationIds.push('u');
  expect(parseTestSpecV6V2(spec(unsupported))).toBeTruthy(); expect(() => admit(spec(unsupported))).toThrow('UNSUPPORTED_AUTHORED_OPERATION');
  const negative = activate(); const n = negative.obligations.find((item) => item.kind === 'constraint')!; n.polarity = 'negative';
  expect(() => admit(spec(negative))).toThrow('UNSUPPORTED_AUTHORED_CONSTRAINT');
  const contrast = action([['Tap', 'effect'], [' ', 'neutral'], ['Save', 'target'], [' rather than ', 'polarity'], ['Cancel', 'target']], [
    { id: 'e', kind: 'effect', effect: 'activate', sourceSegmentIds: ['p0'] }, name('save', ['p2'], 'Save'), name('cancel', ['p4'], 'Cancel'),
    { id: 'c', kind: 'contrast', sourceSegmentIds: ['p3'], authoredText: ' rather than ', obligationIds: ['save', 'cancel'] },
  ]);
  expect(parseTestSpecV6V2(spec(contrast))).toBeTruthy(); expect(() => admit(spec(contrast))).toThrow('UNSUPPORTED_AUTHORED_CONSTRAINT');
});

test('trusted source metadata, frozen admission, forged JSON and changed readback enforce authority', () => {
  const draft = spec(choose('at')); const trusted = admit(draft); const independent = structuredClone(draft);
  independent.executionProfileRef.version = '2'; expect(() => admit(draft, independent)).toThrow('INVALID_SOURCE_REPRESENTATION');
  independent.executionProfileRef.version = '1'; independent.startState.url = 'https://example.com/';
  expect(() => admit(draft, independent)).toThrow('INVALID_SOURCE_REPRESENTATION');
  expect(Object.isFrozen(trusted.spec.steps[0])).toBe(true);
  expect(() => { Reflect.set(trusted.spec, 'sourceInstruction', 'changed'); }).not.toThrow();
  expect(trusted.spec.sourceInstruction).toBe(draft.sourceInstruction);
  const record = JSON.parse(JSON.stringify(trusted.record)); expect(SemanticAdmissionRecordV2Schema.safeParse(record).success).toBe(true);
  const forged = { spec: draft, record } as unknown as TrustedSemanticAdmissionV2;
  expect(() => requireTrustedSemanticAdmissionV2(forged)).toThrow('UNTRUSTED_SEMANTIC_ADMISSION');
  expect(() => buildActionObligationHandoffV2(forged)).toThrow('UNTRUSTED_SEMANTIC_ADMISSION');
  expect(validateSemanticAdmissionReadbackV2(record, draft, trusted)).toBe(trusted);
  record.versions.primaryPromptVersion = 'changed';
  expect(() => validateSemanticAdmissionReadbackV2(record, draft, trusted)).toThrow('SEMANTIC_ADMISSION_READBACK_MISMATCH');
});

test('handoff includes every obligation and immutable admission/source digest; Country loss rejects', () => {
  const trusted = admit(spec(choose('at'))); const handoff = buildActionObligationHandoffV2(trusted);
  expect(() => validateActionObligationHandoffV2(trusted, handoff)).not.toThrow();
  const missing = JSON.parse(JSON.stringify(handoff)); missing.goals[0].obligationIds.splice(2, 1);
  expect(() => validateActionObligationHandoffV2(trusted, missing)).toThrow('INCOMPLETE_OR_CHANGED_OBLIGATION_HANDOFF');
  const altered = structuredClone(handoff); Reflect.set(altered, 'admissionDigest', '0'.repeat(64));
  expect(() => validateActionObligationHandoffV2(trusted, altered)).toThrow('INCOMPLETE_OR_CHANGED_OBLIGATION_HANDOFF');
});

test('v1/v6 stays separately readable; neither reader silently upgrades the other', () => {
  const source = 'Click Save.'; const old = { schemaVersion: '6', testSpecId: 'old', sourceInstruction: source,
    executionProfileRef: { id: 'desktop', version: '1' }, startState: { url: 'about:blank' }, steps: [
      { id: 's1', type: 'action_goal', goalVersion: '1', sourceStepId: 's1', sourceText: source,
        sourceInstructionSpan: { start: 0, end: source.length }, effect: 'activate', effectSourceSpan: { start: 0, end: 5 },
        explicitOperation: { operation: 'click', sourceSpan: { start: 0, end: 5 } },
        targetConstraints: [{ kind: 'name', authoredText: 'Save', sourceSpan: { start: 6, end: 10 }, polarity: 'positive' }] },
    ] };
  expect(parseTestSpecV6(old).steps[0]?.type).toBe('action_goal');
  expect(() => parseTestSpecV6V2(old)).toThrow(); expect(() => parseTestSpecV6(spec(activate('Click')))).toThrow();
});

test('correlated semantic mistakes can agree; mechanical admission is not English intent proof', () => {
  const wrong = spec(action([['Choose', 'effect'], [' ', 'neutral'], ['Option 1 at the Country dropdown', 'argument'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option 1 at the Country dropdown', sourceSegmentIds: ['p2'] },
  ]));
  expect(admit(wrong).record.admissionVersion).toBe('2');
});
