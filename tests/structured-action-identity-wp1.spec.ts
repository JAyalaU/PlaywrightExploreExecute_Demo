import { test, expect } from '@playwright/test';
import { parseTestSpec } from '../app/domain/index.js';
import { interpretTask, normalizeStructuredActionInterpretationWire,
  STRUCTURED_ACTION_INTERPRETATION_RESPONSE_FORMAT, createOpenAIResponsesClient } from '../app/interpretation/index.js';

const profile = { id: 'desktop', version: '1' };
const name = 'Add/Remove Elements';
const phrasings = [
  ['Click the Add/Remove Elements link.', 'link'],
  ['Click on Add/Remove Elements.', null],
  ['Find Add/Remove Elements and open it.', null],
  ['Follow the link labeled Add/Remove Elements.', 'link'],
  ['Select the Add/Remove Elements hyperlink.', 'link'],
  ['Open Add/Remove Elements from the page.', null],
] as const;

function wireStep(clause: string, explicitRole: string | null = null) {
  return { id: 's1', type: 'click', sourceText: clause,
    target: { description: name, scope: null },
    actionTargetIntent: { intentVersion: '1', sourceStepId: 's1', operation: 'click',
      role: explicitRole ? { kind: 'explicit', value: 'link', sourceText: explicitRole } : { kind: 'unspecified' },
      accessibleName: name, exact: true, nameSourceText: name, scope: null },
  };
}

function spec(clause: string, step: unknown) {
  return { schemaVersion: '5', testSpecId: 'v5-action', sourceInstruction: clause,
    executionProfileRef: profile, startState: { url: 'about:blank' }, steps: [step] };
}

async function interpret(clause: string, action = wireStep(clause, clause.includes('hyperlink') ? 'hyperlink' :
  clause.includes('link') ? 'link' : null)) {
  return interpretTask({ sourceInstruction: clause, testSpecId: 'v5-action', executionProfileRef: profile,
    startState: { url: 'about:blank' } }, { complete: async ({ systemInstruction }) => {
    expect(systemInstruction).toContain('actionTargetIntent');
    return normalizeStructuredActionInterpretationWire({ response: { kind: 'test_spec', steps: [action] } });
  } }, { structuredActionIdentity: true });
}

test('six action paraphrases produce the same closed identity without compiler wording rules', async () => {
  expect(STRUCTURED_ACTION_INTERPRETATION_RESPONSE_FORMAT.name).toBe('qa_structured_action_interpretation_v3');
  for (const [clause, explicitRole] of phrasings) {
    const result = await interpret(clause, wireStep(clause, explicitRole === 'link' && clause.includes('hyperlink')
      ? 'hyperlink' : explicitRole));
    expect(result.kind, clause).toBe('accepted');
    if (result.kind !== 'accepted') continue;
    expect(result.testSpec.schemaVersion).toBe('5');
    expect(result.testSpec.steps[0]).toMatchObject({ type: 'click', actionTargetIntent: {
      intentVersion: '1', operation: 'click', accessibleName: name, exact: true,
      role: explicitRole ? { kind: 'explicit', value: 'link' } : { kind: 'unspecified' },
    } });
  }
});

test('action identity rejects operation, name, role, scope, and frame substitutions', () => {
  const clause = 'Click the Add/Remove Elements link.';
  const canonical = (JSON.parse(normalizeStructuredActionInterpretationWire({ response: {
    kind: 'test_spec', steps: [wireStep(clause, 'link')],
  } })) as { steps: Record<string, unknown>[] }).steps[0]!;
  expect(parseTestSpec(spec(clause, canonical)).schemaVersion).toBe('5');
  for (const changed of [
    { ...canonical, actionTargetIntent: { ...canonical.actionTargetIntent as object, operation: 'fill' } },
    { ...canonical, actionTargetIntent: { ...canonical.actionTargetIntent as object, accessibleName: 'Delete' } },
    { ...canonical, actionTargetIntent: { ...canonical.actionTargetIntent as object,
      role: { kind: 'explicit', value: 'button', sourceSpan: { start: 30, end: 34 } } } },
    { ...canonical, target: { description: 'Delete' } },
    { ...canonical, target: { description: name, scope: [{ kind: 'dialog', description: 'settings' }] },
      actionTargetIntent: { ...canonical.actionTargetIntent as object,
        scope: [{ kind: 'dialog', description: 'settings', sourceSpan: { start: 0, end: 8 } }] } },
    { ...canonical, target: { description: name, scope: [{ kind: 'frame', description: 'payment' }] },
      actionTargetIntent: { ...canonical.actionTargetIntent as object,
        scope: [{ kind: 'frame', description: 'payment', sourceSpan: { start: 0, end: 7 } }] } },
  ]) expect(() => parseTestSpec(spec(clause, changed))).toThrow();
});

test('ambiguous target and invented role fail closed at interpretation', async () => {
  const ambiguous = 'Click Save or Delete.';
  const result = await interpretTask({ sourceInstruction: ambiguous, testSpecId: 'ambiguous-action',
    executionProfileRef: profile, startState: { url: 'about:blank' } }, {
    complete: async () => normalizeStructuredActionInterpretationWire({ response: { kind: 'test_spec', steps: [
      { ...wireStep(ambiguous), target: { description: 'Save', scope: null },
        actionTargetIntent: { ...wireStep(ambiguous).actionTargetIntent, accessibleName: 'Save', nameSourceText: 'Save' } },
    ] } }),
  }, { structuredActionIdentity: true });
  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') expect(result.result.status).toBe('AMBIGUOUS_INSTRUCTION');
  const clause = 'Click on Add/Remove Elements.';
  const injected = wireStep(clause, 'link');
  expect(() => normalizeStructuredActionInterpretationWire({ response: {
    kind: 'test_spec', steps: [injected],
  } })).toThrow();
});

test('v5 action identity cannot select an explicitly excluded alternative', async () => {
  for (const clause of ['Click Cancel, not Save.', 'Click Cancel instead of Save.']) {
    const substituted = { ...wireStep(clause), target: { description: 'Save', scope: null },
      actionTargetIntent: { ...wireStep(clause).actionTargetIntent,
        accessibleName: 'Save', nameSourceText: 'Save' } };
    const result = await interpret(clause, substituted);
    expect(result.kind, clause).toBe('rejected');
    if (result.kind === 'rejected') expect(result.result.status).toBe('AMBIGUOUS_INSTRUCTION');
  }
  // A target name containing a negation word is still a valid literal name.
  const valid = 'Click the Not Now button.';
  const action = { ...wireStep(valid, 'button'), target: { description: 'Not Now', scope: null },
    actionTargetIntent: { ...wireStep(valid, 'button').actionTargetIntent,
      role: { kind: 'explicit', value: 'button', sourceText: 'button' },
      accessibleName: 'Not Now', nameSourceText: 'Not Now' } };
  expect((await interpret(valid, action)).kind).toBe('accepted');
});

test('prerequisite cannot masquerade as an authored action and v4 remains readable', () => {
  const clause = 'Click the Add/Remove Elements link.';
  const action = (JSON.parse(normalizeStructuredActionInterpretationWire({ response: {
    kind: 'test_spec', steps: [wireStep(clause, 'link')],
  } })) as { steps: Record<string, unknown>[] }).steps[0]!;
  expect(() => parseTestSpec(spec(clause, { ...action, source: 'discoveredPrerequisite' }))).toThrow();
  expect(() => parseTestSpec(spec(clause, { ...action, actionTargetIntent: undefined }))).toThrow();
  expect(() => parseTestSpec({ ...spec(clause, action), schemaVersion: '4' })).toThrow();
  const old = { schemaVersion: '4', testSpecId: 'old', sourceInstruction: 'Confirm Delete exists.',
    executionProfileRef: profile, startState: { url: 'about:blank' }, steps: [
      { id: 's1', type: 'verification_goal', sourceText: 'Confirm Delete exists.', instruction: 'Confirm Delete exists.' },
    ] };
  expect(parseTestSpec(old).schemaVersion).toBe('4');
});

test('v5 preserves VerificationGoal and rejects executable identity fields', () => {
  const clause = 'Click the Add/Remove Elements link.';
  const normalized = JSON.parse(normalizeStructuredActionInterpretationWire({ response: {
    kind: 'test_spec', steps: [wireStep(clause, 'link')],
  } })) as { steps: Record<string, unknown>[] };
  const goalText = 'Confirm Delete does not exist.';
  const combined = { schemaVersion: '5', testSpecId: 'v5-with-goal',
    sourceInstruction: `${clause}\n${goalText}`, executionProfileRef: profile,
    startState: { url: 'about:blank' }, steps: [...normalized.steps, {
      id: 's2', type: 'verification_goal', sourceText: goalText, instruction: goalText,
      intent: { kind: 'presence', expected: 'absent' }, dependsOnStepId: 's1',
    }] };
  expect(parseTestSpec(combined).steps[1]).toMatchObject({ type: 'verification_goal',
    intent: { kind: 'presence', expected: 'absent' } });
  expect(() => parseTestSpec({ ...combined, steps: [{ ...normalized.steps[0],
    actionTargetIntent: { ...normalized.steps[0]!.actionTargetIntent as object, selector: '#link' } },
  ] })).toThrow();
});

test('a role word inside the accessible name cannot fabricate an explicit role', () => {
  const clause = 'Click Button House.';
  const step = { ...wireStep(clause), target: { description: 'Button House', scope: null },
    actionTargetIntent: { ...wireStep(clause).actionTargetIntent,
      accessibleName: 'Button House', nameSourceText: 'Button House' } };
  const normalized = JSON.parse(normalizeStructuredActionInterpretationWire({ response: {
    kind: 'test_spec', steps: [step],
  } })) as { steps: unknown[] };
  expect(parseTestSpec(spec(clause, normalized.steps[0])).schemaVersion).toBe('5');
  const forged = { ...step, actionTargetIntent: { ...step.actionTargetIntent,
    role: { kind: 'explicit', value: 'button', sourceText: 'Button' } } };
  const forgedNormalized = JSON.parse(normalizeStructuredActionInterpretationWire({ response: {
    kind: 'test_spec', steps: [forged],
  } })) as { steps: unknown[] };
  expect(() => parseTestSpec(spec(clause, forgedNormalized.steps[0]))).toThrow();
});

test('v5 interpretation format traverses the closed stateless provider transport', async () => {
  const output = JSON.stringify({ response: { kind: 'ambiguous', reason: 'unknown target' } });
  const client = createOpenAIResponsesClient({ apiKey: () => 'test-secret',
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { text: { format: unknown }; tools: unknown[] };
      expect(body.text.format).toEqual(STRUCTURED_ACTION_INTERPRETATION_RESPONSE_FORMAT);
      expect(body.tools).toEqual([]);
      return new Response(JSON.stringify({ status: 'completed', error: null, incomplete_details: null,
        output: [{ type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text: output }] }] }), { status: 200 });
    }) as typeof fetch });
  expect(await client.complete({ systemInstruction: 'Interpret a task.', input: 'Click Save.',
    format: STRUCTURED_ACTION_INTERPRETATION_RESPONSE_FORMAT,
    signal: new AbortController().signal })).toEqual({ kind: 'completed', output });
});
