import { test, expect } from '@playwright/test';
import { parseTestSpec, parseTestSpecV6, ActionGoalV1Schema, type ActionGoalV1 } from '../app/domain/index.js';

const span = (source: string, phrase: string, start = 0) => {
  const at = source.indexOf(phrase, start);
  if (at < 0) throw new Error(`Missing fixture phrase ${phrase}`);
  return { start: at, end: at + phrase.length };
};
type Constraint = readonly [ActionGoalV1['targetConstraints'][number]['kind'], string];
function goal(source: string, effect: ActionGoalV1['effect'], verb: string,
  constraints: readonly Constraint[] = [], argument?: string): ActionGoalV1 {
  const operation = verb === 'Click' ? 'click' : verb === 'Fill' ? 'fill' : undefined;
  return { id: 's1', type: 'action_goal', goalVersion: '1', sourceStepId: 's1', sourceText: source,
    sourceInstructionSpan: { start: 0, end: source.length }, effect, effectSourceSpan: span(source, verb),
    ...(operation ? { explicitOperation: { operation, sourceSpan: span(source, verb) } } : {}),
    ...(argument ? { argument: { purpose: effect === 'choose' ? 'choice' : 'entered_text',
      authoredText: argument, sourceSpan: span(source, argument, effect === 'enter_text' && verb === 'Fill'
        ? source.indexOf('with') : 0) } } : {}),
    targetConstraints: constraints.map(([kind, authoredText]) => ({ kind, authoredText,
      sourceSpan: span(source, authoredText), polarity: 'positive' as const })).sort((a, b) => a.sourceSpan.start - b.sourceSpan.start),
  };
}
function spec(sourceInstruction: string, steps: unknown[]) {
  return { schemaVersion: '6', testSpecId: 'deferred-test', sourceInstruction,
    executionProfileRef: { id: 'desktop', version: '1' }, startState: { url: 'about:blank' }, steps };
}
const examples = [
  goal('Click the Save button.', 'activate', 'Click', [['name', 'Save'], ['role', 'button']]),
  goal('Click Save.', 'activate', 'Click', [['name', 'Save']]),
  goal('Select Option 1.', 'choose', 'Select', [], 'Option 1'),
  goal('Choose Option 1 from the Country dropdown.', 'choose', 'Choose', [
    ['context', 'from the Country dropdown'], ['name', 'Country'], ['role', 'dropdown']], 'Option 1'),
  goal('Fill the username field with Jorge.', 'enter_text', 'Fill', [['name', 'username'], ['role', 'field']], 'Jorge'),
  goal('Enter Jorge in the only text field.', 'enter_text', 'Enter', [
    ['context', 'in the only text field'], ['uniqueness', 'only text field'], ['role', 'text field']], 'Jorge'),
  goal('Click the button next to Email.', 'activate', 'Click', [['role', 'button'], ['relationship', 'next to Email'], ['name', 'Email']]),
];

test('v6 preserves named, role-only, context, relationship and unnamed choice source intents', () => {
  for (const example of examples) expect(parseTestSpecV6(spec(example.sourceText, [example])).steps[0]).toEqual(example);
  const dropdown = parseTestSpecV6(spec(examples[2]!.sourceText, [examples[2]!])).steps[0];
  expect(dropdown).toMatchObject({ effect: 'choose', argument: { authoredText: 'Option 1' }, targetConstraints: [] });
  expect(dropdown).not.toHaveProperty('explicitOperation');
  const unnamed = goal('Click the only button.', 'activate', 'Click', [['uniqueness', 'only button'], ['role', 'button']]);
  expect(parseTestSpecV6(spec(unnamed.sourceText, [unnamed])).steps).toHaveLength(1);
});

test('ordered activation and choice goals preserve explicitly authored stages without inferring prerequisites', () => {
  for (const [firstText, constraints, secondText, choice] of [
    ['Open the only dropdown', [['uniqueness', 'only dropdown'], ['role', 'dropdown']], 'choose Option 2.', 'Option 2'],
    ['Open the menu', [['role', 'menu']], 'choose Settings.', 'Settings'],
  ] as const) {
    const source = `${firstText} and ${secondText}`;
    const first = goal(firstText, 'activate', 'Open', constraints);
    const second = goal(secondText, 'choose', 'choose', [], choice);
    second.id = second.sourceStepId = 's2';
    second.sourceInstructionSpan = span(source, secondText);
    expect(parseTestSpecV6(spec(source, [first, second])).steps).toHaveLength(2);
    expect(() => parseTestSpecV6(spec(source, [second, first]))).toThrow('OWNERSHIP_OR_ORDER');
  }
});

test('effect does not weaken explicit Click or Fill and does not invent native select operation', () => {
  for (const example of [examples[0]!, examples[4]!]) {
    const { explicitOperation: _operation, ...weakened } = example;
    expect(() => parseTestSpecV6(spec(example.sourceText, [weakened]))).toThrow('EXPLICIT_OPERATION_OMITTED');
  }
  const choice = examples[2]!;
  expect(() => parseTestSpecV6(spec(choice.sourceText, [{ ...choice,
    explicitOperation: { operation: 'select_option', sourceSpan: choice.effectSourceSpan } }]))).toThrow('OPERATION_CONTRADICTION');
});

test('target and literal argument cannot be interchanged or conflated', () => {
  const choice = examples[2]!;
  expect(() => parseTestSpecV6(spec(choice.sourceText, [{ ...choice,
    targetConstraints: [{ kind: 'name', authoredText: 'Option 1', sourceSpan: choice.argument!.sourceSpan, polarity: 'positive' }] }]))).toThrow('CONFLATION');
  const fill = examples[4]!;
  expect(() => parseTestSpecV6(spec(fill.sourceText, [{ ...fill,
    argument: { ...fill.argument!, authoredText: 'username', sourceSpan: span(fill.sourceText, 'username') },
    targetConstraints: [{ kind: 'name', authoredText: 'Jorge', sourceSpan: span(fill.sourceText, 'Jorge'), polarity: 'positive' }] }]))).toThrow('CONFLATION');
  const multi = goal('Choose Option 1 from Country.', 'choose', 'Choose', [['name', 'Country']], 'Option 1');
  expect(() => parseTestSpecV6(spec(multi.sourceText, [{ ...multi,
    argument: { ...multi.argument!, authoredText: 'Option', sourceSpan: span(multi.sourceText, 'Option') },
    targetConstraints: [...multi.targetConstraints, { kind: 'name', authoredText: '1', sourceSpan: span(multi.sourceText, '1'), polarity: 'positive' }] }]))).toThrow('CONFLATION');
});

test('quoted argument delimiters and entered whitespace remain literal data', () => {
  const choice = goal('Choose "Made in USA" from the Country dropdown.', 'choose', 'Choose', [
    ['context', 'from the Country dropdown'], ['name', 'Country'], ['role', 'dropdown']], 'Made in USA');
  const input = goal('Enter "Sign in" in the only text field.', 'enter_text', 'Enter', [
    ['context', 'in the only text field'], ['uniqueness', 'only text field'], ['role', 'text field']], 'Sign in');
  const whitespace = goal('Fill the field with " Jorge ".', 'enter_text', 'Fill', [['role', 'field']], ' Jorge ');
  const quotedActionWords = goal('Fill the field with "Jorge and click Save".', 'enter_text', 'Fill', [['role', 'field']], 'Jorge and click Save');
  for (const action of [choice, input, whitespace, quotedActionWords])
    expect(parseTestSpecV6(spec(action.sourceText, [action])).steps[0]).toEqual(action);
});

test('fabricated names/browser facts, omitted role/name/context, and semantic camouflage reject', () => {
  const named = examples[0]!;
  for (const constraints of [[], named.targetConstraints.filter((c) => c.kind !== 'role'),
    named.targetConstraints.filter((c) => c.kind !== 'name'),
    named.targetConstraints.map((c) => c.kind === 'role' ? { ...c, kind: 'name' } : c),
    named.targetConstraints.map((c) => c.kind === 'name' ? { ...c, kind: 'context' } : c)]) {
    expect(() => parseTestSpecV6(spec(named.sourceText, [{ ...named, targetConstraints: constraints }]))).toThrow();
  }
  const choice = examples[2]!;
  expect(() => parseTestSpecV6(spec(choice.sourceText, [{ ...choice, accessibleName: 'dropdown' }]))).toThrow();
  expect(() => parseTestSpecV6(spec(choice.sourceText, [{ ...choice,
    targetConstraints: [{ kind: 'name', authoredText: 'Country', sourceSpan: { start: 7, end: 14 }, polarity: 'positive' }] }]))).toThrow();
  const contextual = examples[3]!;
  expect(() => parseTestSpecV6(spec(contextual.sourceText, [{ ...contextual,
    targetConstraints: [] }]))).toThrow();
  expect(() => parseTestSpecV6(spec(named.sourceText, [{ ...named, targetConstraints: [],
    prerequisiteContext: { authoredText: 'the Save button', sourceSpan: span(named.sourceText, 'the Save button') } }]))).toThrow();
  const scoped = goal('Click Save in the Billing dialog.', 'activate', 'Click', [
    ['name', 'Save in the Billing dialog'], ['role', 'dialog']]);
  expect(() => parseTestSpecV6(spec(scoped.sourceText, [scoped]))).toThrow();
});

test('contradictory goals and negation fail closed; quoted polarity names remain literal', () => {
  for (const [source, constraints] of [
    ['Click Save or Delete.', [['name', 'Save'], ['name', 'Delete']]],
    ['Do not Click Save.', [['name', 'Save']]],
    ['Click the Save button link.', [['name', 'Save'], ['role', 'button'], ['role', 'link']]],
    ['Click and fill Save.', [['name', 'Save']]],
    ['Click Save and fill Delete.', [['name', 'Save and fill Delete']]],
    ['Click Save and fill username with Jorge.', [['name', 'Save and fill username with Jorge']]],
  ] as const) {
    const candidate = goal(source, 'activate', 'Click', constraints);
    expect(() => parseTestSpecV6(spec(source, [candidate]))).toThrow();
  }
  const literalName = goal('Click "Not Now".', 'activate', 'Click', [['name', 'Not Now']]);
  expect(parseTestSpecV6(spec(literalName.sourceText, [literalName])).steps).toHaveLength(1);
  const quotedWords = goal('Click "Button House and fill or Not Now".', 'activate', 'Click', [['name', 'Button House and fill or Not Now']]);
  expect(parseTestSpecV6(spec(quotedWords.sourceText, [quotedWords])).steps).toHaveLength(1);
  const bare = goal('Click.', 'activate', 'Click');
  expect(() => parseTestSpecV6(spec(bare.sourceText, [bare]))).toThrow('MISSING_AUTHORED_TARGET');
  for (const action of [
    goal('Choose Option 1 and choose Option 2.', 'choose', 'Choose', [], 'Option 1 and choose Option 2'),
    goal('Fill the username field with Jorge and click Save.', 'enter_text', 'Fill', [['name', 'username'], ['role', 'field']], 'Jorge and click Save'),
  ]) expect(() => parseTestSpecV6(spec(action.sourceText, [action]))).toThrow('MULTIPLE_ACTION_EFFECTS');
});

test('literal input is inert data while semantic selectors, code and unknown fields reject', () => {
  const literalInput = goal('Fill the field with page.evaluate("x").', 'enter_text', 'Fill', [['role', 'field']], 'page.evaluate("x")');
  expect(parseTestSpecV6(spec(literalInput.sourceText, [literalInput])).steps).toHaveLength(1);
  const bad = goal('Click #save.', 'activate', 'Click', [['name', '#save']]);
  expect(() => parseTestSpecV6(spec(bad.sourceText, [bad]))).toThrow();
  for (const extra of ['selector', 'locator', 'frameTitle', 'optionValue', 'javascript', 'compilerInstruction'])
    expect(ActionGoalV1Schema.safeParse({ ...examples[2], [extra]: 'x' }).success).toBe(false);
  expect(ActionGoalV1Schema.safeParse({ ...examples[0], sourceText: 'x'.repeat(1025) }).success).toBe(false);
});

test('spans, duplicate constraints, source ownership and dropped clauses fail closed', () => {
  const action = examples[1]!;
  for (const changed of [
    { ...action, sourceStepId: 'other' },
    { ...action, sourceInstructionSpan: { start: 1, end: action.sourceText.length } },
    { ...action, effectSourceSpan: { start: 100, end: 105 } },
    { ...action, targetConstraints: [...action.targetConstraints, ...action.targetConstraints] },
  ]) expect(() => parseTestSpecV6(spec(action.sourceText, [changed]))).toThrow();
  expect(() => parseTestSpecV6(spec(`${action.sourceText} Click Delete.`, [action]))).toThrow('UNOWNED_SOURCE_CLAUSE');
  expect(() => parseTestSpecV6(spec(action.sourceText, [action, action]))).toThrow('Duplicate');
});

test('navigation retains absolute authored URLs; VerificationGoal semantics and dependencies are unchanged', () => {
  const navigation = 'Go to https://example.com/.';
  const verification = 'Confirm Delete does not exist.';
  const source = `${navigation}\n${verification}`;
  const steps = [{ id: 's1', type: 'navigate', sourceText: navigation, sourceInstructionSpan: span(source, navigation), url: 'https://example.com/' },
    { id: 's2', type: 'verification_goal', sourceText: verification, sourceInstructionSpan: span(source, verification),
      instruction: verification, intent: { kind: 'presence', expected: 'absent' }, dependsOnStepId: 's1' }];
  expect(parseTestSpecV6(spec(source, steps)).steps).toHaveLength(2);
  expect(() => parseTestSpecV6(spec(source, [{ ...steps[0], url: 'javascript:alert(1)' }, steps[1]]))).toThrow();
  expect(() => parseTestSpecV6(spec(source, [steps[0], { ...steps[1], intent: { kind: 'presence', expected: 'present' } }]))).toThrow('POLARITY');
});

test('historical readers stay closed; no silent v5 action to goal conversion', () => {
  expect(() => parseTestSpec(spec(examples[1]!.sourceText, [examples[1]!]))).toThrow();
  expect(() => parseTestSpecV6({ ...spec(examples[1]!.sourceText, [examples[1]!]), schemaVersion: '5' })).toThrow();
  for (const version of ['2', '3', '4', '5']) {
    const clause = version === '2' || version === '3' ? 'Go to https://example.com/.' : 'Confirm Save exists.';
    const step = version === '2' || version === '3' ? { id: 's1', type: 'navigate', sourceText: clause, url: 'https://example.com/' } :
      { id: 's1', type: 'verification_goal', sourceText: clause, instruction: clause };
    expect(parseTestSpec({ ...spec(clause, [step]), schemaVersion: version }).schemaVersion).toBe(version);
  }
});
