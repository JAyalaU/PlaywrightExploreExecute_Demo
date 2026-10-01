import { expect, test } from '@playwright/test';
import { AuthoredStepSchema, WaitConditionSchema } from '../app/domain/index.js';
import {
  INTERPRETATION_RESPONSE_FORMAT, STEP_DECISION_RESPONSE_FORMAT,
  normalizeInterpretationWire, normalizeStepDecisionWire,
  interpretTask, createStepDecision,
} from '../app/interpretation/index.js';

type Schema = Record<string, unknown>;

function checkStrictSchema(schema: Schema, root: Schema): void {
  const allowed = new Set(['type', 'enum', 'properties', 'required', 'additionalProperties',
    'items', 'anyOf', '$ref', '$defs']);
  for (const key of Object.keys(schema)) expect(allowed.has(key), `Unsupported keyword ${key}`).toBe(true);
  if (schema.$ref) {
    expect(typeof schema.$ref).toBe('string');
    expect((root.$defs as Record<string, unknown>)[(schema.$ref as string).replace('#/$defs/', '')]).toBeDefined();
    return;
  }
  if (schema.type === 'object') {
    const props = schema.properties as Record<string, Schema>;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(props));
    for (const child of Object.values(props)) checkStrictSchema(child, root);
  }
  if (schema.items) checkStrictSchema(schema.items as Schema, root);
  if (schema.anyOf) for (const child of schema.anyOf as Schema[]) checkStrictSchema(child, root);
  if (schema.$defs) for (const child of Object.values(schema.$defs as Record<string, Schema>)) checkStrictSchema(child, root);
}

function matchesSchema(value: unknown, schema: Schema, root: Schema): boolean {
  if (schema.$ref) return matchesSchema(value,
    (root.$defs as Record<string, Schema>)[(schema.$ref as string).replace('#/$defs/', '')]!, root);
  if (schema.anyOf) return (schema.anyOf as Schema[]).some((item) => matchesSchema(value, item, root));
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) return false;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => type === 'null' ? value === null :
      type === 'integer' ? Number.isInteger(value) :
      type === 'array' ? Array.isArray(value) : type === 'object' ?
        value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === type)) return false;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    const record = value as Record<string, unknown>;
    const props = schema.properties as Record<string, Schema>;
    if ((schema.required as string[]).some((key) => !(key in record))) return false;
    if (schema.additionalProperties === false && Object.keys(record).some((key) => !(key in props))) return false;
    return Object.entries(record).every(([key, item]) => matchesSchema(item, props[key]!, root));
  }
  if (Array.isArray(value) && schema.items) return value.every((item) => matchesSchema(item, schema.items as Schema, root));
  return true;
}

const target = { description: 'Save', scope: null };
const scopedTarget = { description: 'Save', scope: [{ kind: 'dialog', description: 'Profile' }] };
const dataRef = { kind: 'dataRef', ref: 'username' };
const sourceText = 'Select Save';
const step = (type: string, fields: Record<string, unknown>) => ({ id: `step_${type}`, type, sourceText, ...fields });
const waitConditions = [
  { type: 'target_visible', target },
  { type: 'url_exact', url: 'https://example.com' },
  { type: 'url_pattern', pattern: 'https://example.com/*' },
  { type: 'target_value', target: scopedTarget, expectedValue: 'Saved' },
];
const cases = [
  step('navigate', { url: 'https://example.com' }),
  step('click', { target }),
  step('fill', { target: scopedTarget, value: dataRef }),
  step('select_option', { target, value: 'admin' }),
  step('assert_visible', { target }),
  step('assert_text', { target, expectedText: 'Saved', match: 'contains' }),
  step('assert_value', { target, expectedValue: dataRef }),
  step('assert_url', { expectedUrl: 'https://example.com/*', match: 'pattern' }),
  step('assert_link_collection', { linkName: 'Frank da Cruz', expectedCount: 2, expectedHref: 'https://example.com/' }),
  ...waitConditions.map((condition, index) => ({ id: `step_wait_${index}`, type: 'wait_for', sourceText,
    condition, timeoutPolicyRef: 'default' })),
];

test('P2-1A formats obey supported strict-schema shape and close every object', () => {
  for (const format of [INTERPRETATION_RESPONSE_FORMAT, STEP_DECISION_RESPONSE_FORMAT]) {
    expect(format.type).toBe('json_schema');
    expect(format.strict).toBe(true);
    expect(format.schema.type).toBe('object');
    expect(format.schema).not.toHaveProperty('anyOf');
    checkStrictSchema(format.schema, format.schema);
  }
});

test('P2-1A supports every authored operation and wait variant without widening M7', () => {
  const root = INTERPRETATION_RESPONSE_FORMAT.schema;
  expect([...new Set(cases.map((item) => item.type))].sort()).toEqual(
    AuthoredStepSchema.options.map((option) => option.shape.type.value)
      .filter((type) => type !== 'verification_goal').sort(),
  );
  expect(waitConditions.map((condition) => condition.type).sort()).toEqual(
    WaitConditionSchema.options.map((option) => option.shape.type.value).sort(),
  );
  for (const authored of cases) {
    const wire = { response: { kind: 'test_spec', steps: [authored] } };
    expect(matchesSchema(wire, root, root), authored.type).toBe(true);
    const normalized = JSON.parse(normalizeInterpretationWire(wire)) as { steps: unknown[] };
    expect(AuthoredStepSchema.safeParse(normalized.steps[0]).success).toBe(true);
  }
  const normalizedScoped = JSON.parse(normalizeInterpretationWire({ response: {
    kind: 'test_spec', steps: [step('click', { target: scopedTarget })],
  } })) as { steps: { target: unknown }[] };
  expect(normalizedScoped.steps[0]?.target).toEqual(scopedTarget);
  const allScopes = { description: 'Save', scope: ['menu', 'dialog', 'region', 'row', 'frame']
    .map((kind) => ({ kind, description: `${kind} context` })) };
  const scopeWire = { response: { kind: 'test_spec', steps: [step('click', { target: allScopes })] } };
  expect(matchesSchema(scopeWire, root, root)).toBe(true);
  expect(JSON.parse(normalizeInterpretationWire(scopeWire)).steps[0].target).toEqual(allScopes);
  const normalizedNull = JSON.parse(normalizeInterpretationWire({ response: {
    kind: 'test_spec', steps: [step('click', { target })],
  } })) as { steps: { target: unknown }[] };
  expect(normalizedNull.steps[0]?.target).toEqual({ description: 'Save' });
});

test('P2-1A interpretation variants reach unchanged M7 outcomes', async () => {
  const request = {
    sourceInstruction: sourceText, testSpecId: 'test_wire',
    executionProfileRef: { id: 'desktop', version: '1' }, startState: { url: 'about:blank' },
  };
  for (const [kind, expected] of [
    ['ambiguous', 'AMBIGUOUS_INSTRUCTION'], ['unsupported', 'INTERPRETATION_FAILED'],
  ] as const) {
    const wire = { response: { kind, reason: 'Cannot complete this request' } };
    expect(matchesSchema(wire, INTERPRETATION_RESPONSE_FORMAT.schema, INTERPRETATION_RESPONSE_FORMAT.schema)).toBe(true);
    const outcome = await interpretTask(request, { complete: async () => normalizeInterpretationWire(wire) });
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') expect(outcome.result.status).toBe(expected);
  }
  const accepted = await interpretTask(request, { complete: async () => normalizeInterpretationWire({
    response: { kind: 'test_spec', steps: [step('click', { target })] },
  }) });
  expect(accepted.kind).toBe('accepted');
});

test('P2-1A decision variants reach unchanged M7 checks', async () => {
  const decisions = [
    { kind: 'find', text: 'Save' },
    { kind: 'wait', text: 'Save' },
    { kind: 'prerequisite', ref: 'e2', element: 'Save button', reason: 'Open menu', action: 'click' },
    { kind: 'target', ref: 'e2', element: 'Save button' },
    { kind: 'unresolved', reason: 'TARGET_NOT_FOUND' },
  ];
  for (const response of decisions) {
    const wire = { response };
    expect(matchesSchema(wire, STEP_DECISION_RESPONSE_FORMAT.schema, STEP_DECISION_RESPONSE_FORMAT.schema)).toBe(true);
    const decide = createStepDecision({ complete: async () => normalizeStepDecisionWire(wire) }, { retryCount: 0 });
    const resolved = await decide({
      step: { id: 's1', type: 'click', sourceText, target: { description: 'Save' } },
      priorOutcomes: [], currentUrl: 'https://example.com', snapshot: '- button "Save" [ref=e2]',
      prerequisites: 0, alternativeAttempt: false,
    });
    expect(resolved).toEqual(response);
  }
});

test('P2-1A rejects extra fields, missing fields, malformed nullable fields and unsupported variants', () => {
  const invalidInterpretation = [
    { response: { kind: 'test_spec', steps: [step('click', { target: { description: 'Save' } })] } },
    { response: { kind: 'test_spec', steps: [step('click', { target: { description: 'Save', scope: 'dialog' } })] } },
    { response: { kind: 'test_spec', steps: [step('click', { target: { ...target, selector: '#save' } })] } },
    { response: { kind: 'test_spec', steps: [step('click', { target, url: 'https://example.com' })] } },
    { response: { kind: 'test_spec', steps: [step('wait_for', { condition: { type: 'url_exact', url: 'https://example.com', target }, timeoutPolicyRef: 'default' })] } },
    { response: { kind: 'test_spec', steps: [step('hover', { target })] } },
    { response: { kind: 'test_spec', steps: null } },
    { response: { kind: 'ambiguous', reason: 'unclear', steps: [] } },
    { response: { kind: 'unsupported', reason: null } },
    { response: { kind: 'test_spec', steps: [step('click', { target })] }, tools: ['browser_evaluate'] },
  ];
  for (const invalid of invalidInterpretation) {
    expect(matchesSchema(invalid, INTERPRETATION_RESPONSE_FORMAT.schema, INTERPRETATION_RESPONSE_FORMAT.schema)).toBe(false);
    expect(() => normalizeInterpretationWire(invalid)).toThrow();
  }
  for (const invalid of [
    { response: { kind: 'target', ref: 'e2', element: 'Save', selector: '#save' } },
    { response: { kind: 'prerequisite', ref: 'e2', element: 'Save', reason: 'Open menu', action: null } },
    { response: { kind: 'browser_evaluate', expression: 'document.cookie' } },
    { response: { kind: 'unresolved', reason: 'OTHER' } },
  ]) {
    expect(matchesSchema(invalid, STEP_DECISION_RESPONSE_FORMAT.schema, STEP_DECISION_RESPONSE_FORMAT.schema)).toBe(false);
    expect(() => normalizeStepDecisionWire(invalid)).toThrow();
  }
});

test('P2-1A keeps semantic rejection in the existing application validators', async () => {
  expect(() => normalizeInterpretationWire({ response: { kind: 'test_spec', steps: [
    step('click', { target: { description: 'locator("#save")', scope: null } }),
  ] } })).toThrow();
  const wire = { response: { kind: 'target', ref: 'e999', element: 'Save' } };
  const decide = createStepDecision({ complete: async () => normalizeStepDecisionWire(wire) }, { retryCount: 0 });
  await expect(decide({
    step: { id: 's1', type: 'click', sourceText, target: { description: 'Save' } },
    priorOutcomes: [], currentUrl: 'https://example.com', snapshot: '- button "Save" [ref=e2]',
    prerequisites: 0, alternativeAttempt: false,
  })).rejects.toMatchObject({ code: 'REF_OUTSIDE_BOUNDED_CONTEXT' });
});
