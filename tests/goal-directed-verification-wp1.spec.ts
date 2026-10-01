import { test, expect } from '@playwright/test';
import { parseTestSpec } from '../app/domain/index.js';
import { interpretTask, normalizeAgenticInterpretationWire,
  AGENTIC_INTERPRETATION_RESPONSE_FORMAT } from '../app/interpretation/index.js';

const profile = { id: 'desktop', version: '1' };
const task = [
  'Go to https://the-internet.herokuapp.com/.',
  'Locate the link that says Add/Remove Elements and click it.',
  'Locate the button with the text "Add Element". Confirm it exists.',
  'Confirm a button with the text "Delete" does not exist.',
  'Click the "Add Element" button.',
  'Confirm a button with the text "Delete" exists.',
].join('\n');
const goal = (id: string, sourceText: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: 'verification_goal', sourceText, instruction: sourceText, ...extra });
const source = (instruction: string, steps: unknown[], version = '4') => ({
  schemaVersion: version, testSpecId: 'test-goal-wp1', sourceInstruction: instruction,
  executionProfileRef: profile, startState: { url: 'about:blank' }, steps,
});

test('Add/Remove interpretation preserves ordered actions and goals without an assertion operator', async () => {
  const steps = [
    { id: 's1', type: 'navigate', sourceText: 'Go to https://the-internet.herokuapp.com/.', url: 'https://the-internet.herokuapp.com/' },
    { id: 's2', type: 'click', sourceText: 'Locate the link that says Add/Remove Elements and click it.', target: { description: 'Add/Remove Elements link' } },
    goal('s3', 'Locate the button with the text "Add Element". Confirm it exists.',
      { subject: { role: 'button', accessibleName: 'Add Element' }, intent: { kind: 'presence', expected: 'present' } }),
    goal('s4', 'Confirm a button with the text "Delete" does not exist.',
      { subject: { role: 'button', accessibleName: 'Delete' }, intent: { kind: 'presence', expected: 'absent' } }),
    { id: 's5', type: 'click', sourceText: 'Click the "Add Element" button.', target: { description: 'Add Element button' } },
    goal('s6', 'Confirm a button with the text "Delete" exists.',
      { subject: { role: 'button', accessibleName: 'Delete' }, intent: { kind: 'presence', expected: 'present' }, dependsOnStepId: 's5' }),
  ];
  const outcome = await interpretTask({ sourceInstruction: task, testSpecId: 'test-goal-wp1',
    executionProfileRef: profile, startState: { url: 'about:blank' } },
  { complete: async ({ systemInstruction }) => {
    expect(systemInstruction).toContain('Do not select a deterministic assertion operator');
    expect(systemInstruction).toContain('Do not split off "Confirm it exists."');
    return JSON.stringify({ kind: 'test_spec', steps });
  } }, { goalDirected: true });
  expect(outcome.kind).toBe('accepted');
  if (outcome.kind !== 'accepted') return;
  expect(outcome.testSpec.schemaVersion).toBe('4');
  expect(outcome.testSpec.steps.map((step) => step.type)).toEqual([
    'navigate', 'click', 'verification_goal', 'verification_goal', 'click', 'verification_goal',
  ]);
  expect(outcome.testSpec.steps[3]).toMatchObject({ intent: { kind: 'presence', expected: 'absent' } });
  expect(JSON.stringify(outcome.testSpec)).not.toContain('assert_visible');
  expect(JSON.stringify(outcome.testSpec)).not.toContain('match-count');
});

test('numbered Add/Remove task keeps the locator and pronoun verification in one goal', async () => {
  const numbered = task.split('\n').map((line, index) => `${index + 1}. ${line}`).join('\n');
  const clause = 'Locate the button with the text "Add Element". Confirm it exists.';
  const result = await interpretTask({ sourceInstruction: numbered, testSpecId: 'numbered-goal',
    executionProfileRef: profile, startState: { url: 'about:blank' } },
  { complete: async () => JSON.stringify({ kind: 'test_spec', steps: [
    { id: 's1', type: 'navigate', sourceText: 'Go to https://the-internet.herokuapp.com/.',
      url: 'https://the-internet.herokuapp.com/' },
    { id: 's2', type: 'click', sourceText: 'Locate the link that says Add/Remove Elements and click it.',
      target: { description: 'Add/Remove Elements link' } },
    goal('s3', clause, { subject: { role: 'button', accessibleName: 'Add Element' },
      intent: { kind: 'presence', expected: 'present' } }),
    goal('s4', 'Confirm a button with the text "Delete" does not exist.',
      { subject: { role: 'button', accessibleName: 'Delete' }, intent: { kind: 'presence', expected: 'absent' } }),
    { id: 's5', type: 'click', sourceText: 'Click the "Add Element" button.',
      target: { description: 'Add Element button' } },
    goal('s6', 'Confirm a button with the text "Delete" exists.',
      { subject: { role: 'button', accessibleName: 'Delete' }, intent: { kind: 'presence', expected: 'present' } }),
  ] }) }, { goalDirected: true });
  expect(result.kind).toBe('accepted');
  if (result.kind !== 'accepted') return;
  expect(result.testSpec.steps[2]).toMatchObject({ type: 'verification_goal', sourceText: clause,
    instruction: clause, subject: { role: 'button', accessibleName: 'Add Element' } });
  expect(result.testSpec.steps[3]).toMatchObject({ type: 'verification_goal',
    intent: { kind: 'presence', expected: 'absent' } });
});

test('standalone pronoun goal is still rejected as materially ambiguous', async () => {
  const instruction = 'Locate the button with the text "Add Element". Confirm it exists.';
  const result = await interpretTask({ sourceInstruction: instruction, testSpecId: 'split-goal',
    executionProfileRef: profile, startState: { url: 'about:blank' } },
  { complete: async () => JSON.stringify({ kind: 'test_spec', steps: [
    goal('s1', 'Confirm it exists.'),
  ] }) }, { goalDirected: true });
  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') expect(result.result.status).toBe('AMBIGUOUS_INSTRUCTION');
});

test('unanticipated verification goals need no deterministic assertion type', () => {
  for (const clause of [
    'Confirm a button with the text "Delete" does not exist.',
    'Confirm a button with the text "Delete" exists.',
    'Verify the Save button is disabled.',
    'Verify there are exactly three rows.',
    'Make sure the modal disappears.',
    'Check that Alice appears above Bob.',
  ]) {
    const parsed = parseTestSpec(source(clause, [goal('s1', clause)]));
    expect(parsed.steps[0]?.type).toBe('verification_goal');
    expect(parsed.steps[0]?.sourceText).toBe(clause);
  }
  const state = 'Verify the Save button is disabled.';
  expect(parseTestSpec(source(state, [goal('s1', state,
    { intent: { kind: 'property', property: 'enabled', expected: false } })])).steps[0])
    .toMatchObject({ intent: { kind: 'property', expected: false } });
  const count = 'Verify there are exactly three rows.';
  expect(parseTestSpec(source(count, [goal('s1', count,
    { intent: { kind: 'cardinality', comparison: 'equal', count: 3 } })])).steps[0])
    .toMatchObject({ intent: { kind: 'cardinality', count: 3 } });
  const temporal = 'Make sure the modal disappears.';
  expect(parseTestSpec(source(temporal, [goal('s1', temporal,
    { intent: { kind: 'temporal', transition: 'disappears' } })])).steps[0])
    .toMatchObject({ intent: { kind: 'temporal', transition: 'disappears' } });
});

test('fidelity rejects polarity, subject, role, clause, scope, and temporal transformations', () => {
  const absent = 'Confirm a button with the text "Delete" does not exist.';
  const base = { subject: { role: 'button', accessibleName: 'Delete' } };
  for (const changed of [
    goal('s1', absent, { ...base, intent: { kind: 'presence', expected: 'present' } }),
    goal('s1', absent, { ...base, intent: { kind: 'property', property: 'visible', expected: true } }),
    goal('s1', absent, { subject: { role: 'button', accessibleName: 'Save' } }),
    goal('s1', absent, { subject: { role: 'link', accessibleName: 'Delete' } }),
    goal('s1', absent, { instruction: 'Confirm Delete exists.' }),
    goal('s1', 'Confirm Delete exists.'),
    goal('s1', absent, { dependsOnStepId: 'later' }),
    goal('s1', absent, { subject: { role: 'button', scope: [{ kind: 'dialog', description: 'settings' }] } }),
  ]) expect(() => parseTestSpec(source(absent, [changed]))).toThrow();
  const temporal = 'Make sure the modal disappears.';
  expect(() => parseTestSpec(source(temporal, [goal('s1', temporal,
    { intent: { kind: 'presence', expected: 'absent' } })]))).toThrow();
  const uncertain = 'Verify Save in the settings dialog or account dialog is disabled.';
  expect(() => parseTestSpec(source(uncertain, [goal('s1', uncertain, { subject: {
    role: 'dialog', accessibleName: 'settings', scope: [{ kind: 'dialog', description: 'settings' }],
  } })]))).toThrow();
  const mixed = 'Confirm a button with text "Delete" does not exist and Save is visible.';
  expect(() => parseTestSpec(source(mixed, [goal('s1', mixed, {
    subject: { role: 'button', accessibleName: 'Delete' },
    intent: { kind: 'property', property: 'visible', expected: true },
  })]))).toThrow();
});

test('ambiguous goal fails closed and old TestSpecs stay readable', async () => {
  const clause = 'Confirm it.';
  const result = await interpretTask({ sourceInstruction: clause, testSpecId: 'test-goal-wp1',
    executionProfileRef: profile, startState: { url: 'about:blank' } },
  { complete: async () => JSON.stringify({ kind: 'test_spec', steps: [goal('s1', clause)] }) },
  { goalDirected: true });
  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') expect(result.result.status).toBe('AMBIGUOUS_INSTRUCTION');
  const action = { id: 's1', type: 'click', sourceText: 'Click Save.', target: { description: 'Save' } };
  expect(parseTestSpec(source('Click Save.', [action], '2')).schemaVersion).toBe('2');
  const link = { id: 's1', type: 'assert_link_collection', sourceText: 'Verify two links.',
    linkName: 'Example', expectedCount: 2, expectedHref: 'https://example.com/' };
  expect(parseTestSpec(source('Verify two links.', [link], '3')).schemaVersion).toBe('3');
  expect(() => parseTestSpec(source(clause, [goal('s1', clause)], '2'))).toThrow();
});

test('released interpretation cannot route a VerificationGoal into the v2/v6 workflow', async () => {
  const clause = 'Confirm a button with the text "Delete" does not exist.';
  const result = await interpretTask({ sourceInstruction: clause, testSpecId: 'test-old-route',
    executionProfileRef: profile, startState: { url: 'about:blank' } },
  { complete: async () => JSON.stringify({ kind: 'test_spec', steps: [goal('s1', clause,
    { intent: { kind: 'presence', expected: 'absent' } })] }) });
  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.result.status).toBe('INTERPRETATION_FAILED');
    expect(result.result.reason).toBe('UNSUPPORTED_REQUEST');
  }
});

test('agentic v2 provider wire normalizes nullable goal hints and keeps closed fields', () => {
  expect(AGENTIC_INTERPRETATION_RESPONSE_FORMAT.name).toBe('qa_agentic_interpretation_v2');
  const clause = 'Verify the Save button is disabled.';
  const wire = { response: { kind: 'test_spec', steps: [{ id: 's1', type: 'verification_goal',
    sourceText: clause, instruction: clause, subject: { role: 'button', accessibleName: 'Save', scope: null },
    intent: { kind: 'property', property: 'enabled', expected: false }, dependsOnStepId: null }] } };
  const normalized = JSON.parse(normalizeAgenticInterpretationWire(wire)) as { steps: unknown[] };
  expect(parseTestSpec(source(clause, normalized.steps)).steps[0]).toMatchObject({
    type: 'verification_goal', subject: { role: 'button', accessibleName: 'Save' },
    intent: { kind: 'property', property: 'enabled', expected: false },
  });
  expect(() => normalizeAgenticInterpretationWire({ response: { kind: 'test_spec', steps: [
    { ...wire.response.steps[0], selector: '#save' },
  ] } })).toThrow();
});
