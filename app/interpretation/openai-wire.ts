import { z } from 'zod';
import { AuthoredStepSchema, TargetSchema, VerificationGoalSchema,
  ActionTargetIntentV1Schema } from '../domain/index.js';

// The provider requires every object property. Only Target.scope differs from
// the application shape: null on the wire means the optional field is absent.
const object = (properties: Record<string, unknown>) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
} as const);
const string = { type: 'string' } as const;
const literal = (value: string) => ({ type: 'string', enum: [value] } as const);
const reference = (name: string) => ({ $ref: `#/$defs/${name}` } as const);
const target = reference('target');
const value = reference('dataValue');
const step = (type: string, fields: Record<string, unknown>) => object({
  id: string, type: literal(type), sourceText: string, ...fields,
});

/** Strict Structured Outputs schemas; Responses transport adds these under text.format. */
export const INTERPRETATION_RESPONSE_FORMAT = {
  type: 'json_schema', name: 'qa_interpretation_v1', strict: true,
  schema: {
    ...object({ response: reference('response') }),
    $defs: {
      scope: object({
        kind: { type: 'string', enum: ['menu', 'dialog', 'region', 'row', 'frame'] },
        description: string,
      }),
      target: object({
        description: string,
        scope: {
          anyOf: [
            {
              type: 'array',
              items: reference('scope'),
            },
            {
              type: 'null',
            },
          ],
        },
      }),
      dataRef: object({ kind: literal('dataRef'), ref: string }),
      dataValue: { anyOf: [string, reference('dataRef')] },
      waitCondition: { anyOf: [
        object({ type: literal('target_visible'), target }),
        object({ type: literal('url_exact'), url: string }),
        object({ type: literal('url_pattern'), pattern: string }),
        object({ type: literal('target_value'), target, expectedValue: value }),
      ] },
      authoredStep: { anyOf: [
        step('navigate', { url: string }),
        step('click', { target }),
        step('fill', { target, value }),
        step('select_option', { target, value }),
        step('assert_visible', { target }),
        step('assert_text', { target, expectedText: string, match: { type: 'string', enum: ['exact', 'contains'] } }),
        step('assert_value', { target, expectedValue: value }),
        step('assert_url', { expectedUrl: string, match: { type: 'string', enum: ['exact', 'pattern'] } }),
        step('assert_link_collection', { linkName: string, expectedCount: { type: 'integer', enum: [2] }, expectedHref: string }),
        step('wait_for', { condition: reference('waitCondition'), timeoutPolicyRef: string }),
      ] },
      response: { anyOf: [
        object({ kind: literal('test_spec'), steps: { type: 'array', items: reference('authoredStep') } }),
        object({ kind: literal('ambiguous'), reason: string }),
        object({ kind: literal('unsupported'), reason: string }),
      ] },
    },
  },
} as const;

/** Agentic interpretation v2 adds intent-preserving goals without altering legacy wire v1. */
export const AGENTIC_INTERPRETATION_RESPONSE_FORMAT = {
  type: 'json_schema', name: 'qa_agentic_interpretation_v2', strict: true,
  schema: {
    ...INTERPRETATION_RESPONSE_FORMAT.schema,
    $defs: {
      ...INTERPRETATION_RESPONSE_FORMAT.schema.$defs,
      goalSubject: object({
        role: { type: ['string', 'null'], enum: ['button', 'link', 'dialog', 'row', 'textbox', 'checkbox', 'heading', null] },
        accessibleName: { type: ['string', 'null'] },
        scope: { anyOf: [{ type: 'array', items: reference('scope') }, { type: 'null' }] },
      }),
      goalIntent: { anyOf: [
        object({ kind: literal('presence'), expected: { type: 'string', enum: ['present', 'absent'] } }),
        object({ kind: literal('property'), property: { type: 'string', enum: ['visible', 'enabled', 'checked'] }, expected: { type: 'boolean' } }),
        object({ kind: literal('cardinality'), comparison: { type: 'string', enum: ['equal', 'at_least', 'at_most'] }, count: { type: 'integer' } }),
        object({ kind: literal('relationship'), relation: { type: 'string', enum: ['above', 'below', 'before', 'after'] }, other: string }),
        object({ kind: literal('temporal'), transition: { type: 'string', enum: ['appears', 'disappears'] } }),
      ] },
      authoredStep: { anyOf: [
        ...INTERPRETATION_RESPONSE_FORMAT.schema.$defs.authoredStep.anyOf,
        step('verification_goal', { instruction: string,
          subject: { anyOf: [reference('goalSubject'), { type: 'null' }] },
          intent: { anyOf: [reference('goalIntent'), { type: 'null' }] },
          dependsOnStepId: { type: ['string', 'null'] },
        }),
      ] },
    },
  },
} as const;

/** Opt-in v5 interpretation wire. Legacy and goal-directed v4 formats remain unchanged. */
export const STRUCTURED_ACTION_INTERPRETATION_RESPONSE_FORMAT = {
  type: 'json_schema', name: 'qa_structured_action_interpretation_v3', strict: true,
  schema: {
    ...AGENTIC_INTERPRETATION_RESPONSE_FORMAT.schema,
    $defs: {
      ...AGENTIC_INTERPRETATION_RESPONSE_FORMAT.schema.$defs,
      actionScope: object({ kind: { type: 'string', enum: ['menu', 'dialog', 'region', 'row', 'frame'] },
        description: string, sourceText: string }),
      actionRole: { anyOf: [
        object({ kind: literal('explicit'), value: { type: 'string', enum: [
          'button', 'link', 'textbox', 'checkbox', 'combobox', 'option', 'menuitem', 'radio',
        ] }, sourceText: string }),
        object({ kind: literal('unspecified') }),
      ] },
      actionIntent: object({ intentVersion: literal('1'), sourceStepId: string,
        operation: { type: 'string', enum: ['click', 'fill', 'select_option'] },
        role: reference('actionRole'), accessibleName: string, exact: { type: 'boolean', enum: [true] },
        nameSourceText: string,
        scope: { anyOf: [{ type: 'array', items: reference('actionScope') }, { type: 'null' }] },
      }),
      authoredStep: { anyOf: [
        step('navigate', { url: string }),
        step('click', { target, actionTargetIntent: reference('actionIntent') }),
        step('fill', { target, value, actionTargetIntent: reference('actionIntent') }),
        step('select_option', { target, value, actionTargetIntent: reference('actionIntent') }),
        step('verification_goal', { instruction: string,
          subject: { anyOf: [reference('goalSubject'), { type: 'null' }] },
          intent: { anyOf: [reference('goalIntent'), { type: 'null' }] },
          dependsOnStepId: { type: ['string', 'null'] },
        }),
      ] },
    },
  },
} as const;

export const STEP_DECISION_RESPONSE_FORMAT = {
  type: 'json_schema', name: 'qa_step_decision_v1', strict: true,
  schema: {
    ...object({ response: reference('decision') }),
    $defs: {
      decision: { anyOf: [
        object({ kind: literal('find'), text: string }),
        object({ kind: literal('wait'), text: string }),
        object({ kind: literal('prerequisite'), ref: string, element: string, reason: string, action: literal('click') }),
        object({ kind: literal('target'), ref: string, element: string }),
        object({ kind: literal('unresolved'), reason: { type: 'string', enum: [
          'AMBIGUOUS_TARGET', 'TARGET_NOT_FOUND', 'INSUFFICIENT_CONTEXT',
        ] } }),
      ] },
    },
  },
} as const;

/** The reviewed private M7-v3 decision vocabulary, separate from legacy M7 wire output. */
const agenticDecision = (kind: string, fields: Record<string, unknown>) => object({
  decisionVersion: literal('3'), kind: literal(kind), ...fields,
});
export const AGENTIC_DECISION_RESPONSE_FORMAT = {
  type: 'json_schema', name: 'agentic_exploration_decision_v3', strict: true,
  schema: object({ response: { anyOf: [
    agenticDecision('inspect', { focus: { type: ['string', 'null'] } }),
    agenticDecision('act', { ref: string,
      action: { type: 'string', enum: ['click', 'fill', 'select_option'] },
      source: { type: 'string', enum: ['authored', 'discovered_prerequisite'] },
      prerequisiteReasonCode: { type: ['string', 'null'], enum: ['expose_target', 'reach_state', null] },
      expectedEffect: literal('state_changed') }),
    agenticDecision('observe_target', { ref: string,
      operation: { type: 'string', enum: ['assert_visible', 'assert_text', 'assert_value', 'wait_for'] } }),
    agenticDecision('evaluate', { verdict: { type: 'string',
      enum: ['achieved', 'try_alternative', 'inspect', 'unresolved'] } }),
    agenticDecision('stop', { reason: { type: 'string',
      enum: ['TARGET_NOT_FOUND', 'UNSUPPORTED_OPERATION'] } }),
  ] } }),
} as const;

const wireTarget = z.strictObject({
  description: z.string(),
  scope: z.array(z.strictObject({
    kind: z.enum(['menu', 'dialog', 'region', 'row', 'frame']), description: z.string(),
  })).nullable(),
});
type WireTarget = z.infer<typeof wireTarget>;
const wireValue = z.union([z.string(), z.strictObject({ kind: z.literal('dataRef'), ref: z.string() })]);
const wireWait = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('target_visible'), target: wireTarget }),
  z.strictObject({ type: z.literal('url_exact'), url: z.string() }),
  z.strictObject({ type: z.literal('url_pattern'), pattern: z.string() }),
  z.strictObject({ type: z.literal('target_value'), target: wireTarget, expectedValue: wireValue }),
]);
const base = { id: z.string(), sourceText: z.string() };
const wireStep = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('navigate'), url: z.string() }),
  z.strictObject({ ...base, type: z.literal('click'), target: wireTarget }),
  z.strictObject({ ...base, type: z.literal('fill'), target: wireTarget, value: wireValue }),
  z.strictObject({ ...base, type: z.literal('select_option'), target: wireTarget, value: wireValue }),
  z.strictObject({ ...base, type: z.literal('assert_visible'), target: wireTarget }),
  z.strictObject({ ...base, type: z.literal('assert_text'), target: wireTarget, expectedText: z.string(), match: z.enum(['exact', 'contains']) }),
  z.strictObject({ ...base, type: z.literal('assert_value'), target: wireTarget, expectedValue: wireValue }),
  z.strictObject({ ...base, type: z.literal('assert_url'), expectedUrl: z.string(), match: z.enum(['exact', 'pattern']) }),
  z.strictObject({ ...base, type: z.literal('assert_link_collection'), linkName: z.string(), expectedCount: z.literal(2), expectedHref: z.string() }),
  z.strictObject({ ...base, type: z.literal('wait_for'), condition: wireWait, timeoutPolicyRef: z.string() }),
]);
const wireGoalSubject = z.strictObject({
  role: z.enum(['button', 'link', 'dialog', 'row', 'textbox', 'checkbox', 'heading']).nullable(),
  accessibleName: z.string().nullable(),
  scope: z.array(wireTarget.shape.scope.unwrap().element).nullable(),
});
const wireGoal = z.strictObject({ ...base, type: z.literal('verification_goal'), instruction: z.string(),
  subject: wireGoalSubject.nullable(), intent: z.union([
    z.strictObject({ kind: z.literal('presence'), expected: z.enum(['present', 'absent']) }),
    z.strictObject({ kind: z.literal('property'), property: z.enum(['visible', 'enabled', 'checked']), expected: z.boolean() }),
    z.strictObject({ kind: z.literal('cardinality'), comparison: z.enum(['equal', 'at_least', 'at_most']), count: z.number().int() }),
    z.strictObject({ kind: z.literal('relationship'), relation: z.enum(['above', 'below', 'before', 'after']), other: z.string() }),
    z.strictObject({ kind: z.literal('temporal'), transition: z.enum(['appears', 'disappears']) }),
  ]).nullable(), dependsOnStepId: z.string().nullable(),
});
const wireActionScope = z.strictObject({ kind: z.enum(['menu', 'dialog', 'region', 'row', 'frame']),
  description: z.string(), sourceText: z.string() });
const wireActionRole = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('explicit'), value: z.enum([
    'button', 'link', 'textbox', 'checkbox', 'combobox', 'option', 'menuitem', 'radio',
  ]), sourceText: z.string() }),
  z.strictObject({ kind: z.literal('unspecified') }),
]);
const wireActionIntent = z.strictObject({ intentVersion: z.literal('1'), sourceStepId: z.string(),
  operation: z.enum(['click', 'fill', 'select_option']), role: wireActionRole,
  accessibleName: z.string(), exact: z.literal(true), nameSourceText: z.string(),
  scope: z.array(wireActionScope).nullable(),
});
const wireStructuredStep = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('navigate'), url: z.string() }),
  z.strictObject({ ...base, type: z.literal('click'), target: wireTarget,
    actionTargetIntent: wireActionIntent }),
  z.strictObject({ ...base, type: z.literal('fill'), target: wireTarget, value: wireValue,
    actionTargetIntent: wireActionIntent }),
  z.strictObject({ ...base, type: z.literal('select_option'), target: wireTarget, value: wireValue,
    actionTargetIntent: wireActionIntent }),
]);
const wireStructuredInterpretation = z.strictObject({ response: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('test_spec'), steps: z.array(z.union([wireStructuredStep, wireGoal])) }),
  z.strictObject({ kind: z.literal('ambiguous'), reason: z.string() }),
  z.strictObject({ kind: z.literal('unsupported'), reason: z.string() }),
]) });
const wireAgenticInterpretation = z.strictObject({ response: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('test_spec'), steps: z.array(z.union([wireStep, wireGoal])) }),
  z.strictObject({ kind: z.literal('ambiguous'), reason: z.string() }),
  z.strictObject({ kind: z.literal('unsupported'), reason: z.string() }),
]) });
const wireInterpretation = z.strictObject({ response: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('test_spec'), steps: z.array(wireStep) }),
  z.strictObject({ kind: z.literal('ambiguous'), reason: z.string() }),
  z.strictObject({ kind: z.literal('unsupported'), reason: z.string() }),
]) });
const wireDecision = z.strictObject({ response: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('find'), text: z.string() }),
  z.strictObject({ kind: z.literal('wait'), text: z.string() }),
  z.strictObject({ kind: z.literal('prerequisite'), ref: z.string(), element: z.string(), reason: z.string(), action: z.literal('click') }),
  z.strictObject({ kind: z.literal('target'), ref: z.string(), element: z.string() }),
  z.strictObject({ kind: z.literal('unresolved'), reason: z.enum([
    'AMBIGUOUS_TARGET', 'TARGET_NOT_FOUND', 'INSUFFICIENT_CONTEXT',
  ]) }),
]) });

function normalizeTarget(input: WireTarget): z.infer<typeof TargetSchema> {
  return TargetSchema.parse({ description: input.description, ...(input.scope === null ? {} : { scope: input.scope }) });
}

/** Accept a parsed provider JSON value and return the exact JSON consumed by M7-A. */
export function normalizeInterpretationWire(input: unknown): string {
  const { response } = wireInterpretation.parse(input);
  if (response.kind !== 'test_spec') return JSON.stringify(response);
  const steps = response.steps.map((item) => {
    const withTarget = 'target' in item ? { ...item, target: normalizeTarget(item.target) } : item;
    const normalized = item.type === 'wait_for' && 'condition' in withTarget &&
      'target' in withTarget.condition
      ? { ...withTarget, condition: { ...withTarget.condition, target: normalizeTarget(withTarget.condition.target) } }
      : withTarget;
    return AuthoredStepSchema.parse(normalized);
  });
  return JSON.stringify({ kind: 'test_spec', steps });
}

export function normalizeAgenticInterpretationWire(input: unknown): string {
  const { response } = wireAgenticInterpretation.parse(input);
  if (response.kind !== 'test_spec') return JSON.stringify(response);
  const steps = response.steps.map((item) => {
    if (item.type !== 'verification_goal') {
      const withTarget = 'target' in item ? { ...item, target: normalizeTarget(item.target) } : item;
      const normalized = item.type === 'wait_for' && 'condition' in withTarget && 'target' in withTarget.condition
        ? { ...withTarget, condition: { ...withTarget.condition, target: normalizeTarget(withTarget.condition.target) } }
        : withTarget;
      return AuthoredStepSchema.parse(normalized);
    }
    const subject = item.subject === null ? undefined : {
      ...(item.subject?.role === null ? {} : { role: item.subject?.role }),
      ...(item.subject?.accessibleName === null ? {} : { accessibleName: item.subject?.accessibleName }),
      ...(item.subject?.scope === null ? {} : { scope: item.subject?.scope }),
    };
    return VerificationGoalSchema.parse({ id: item.id, type: item.type,
      sourceText: item.sourceText, instruction: item.instruction,
      ...(subject && Object.keys(subject).length ? { subject } : {}),
      ...(item.intent ? { intent: item.intent } : {}),
      ...(item.dependsOnStepId ? { dependsOnStepId: item.dependsOnStepId } : {}),
    });
  });
  return JSON.stringify({ kind: 'test_spec', steps });
}

function uniqueSpan(source: string, fragment: string): { start: number; end: number } {
  const start = source.indexOf(fragment);
  if (!fragment || start < 0 || source.indexOf(fragment, start + fragment.length) >= 0)
    throw new Error('Unproven authored span');
  return { start, end: start + fragment.length };
}

export function normalizeStructuredActionInterpretationWire(input: unknown): string {
  const { response } = wireStructuredInterpretation.parse(input);
  if (response.kind !== 'test_spec') return JSON.stringify(response);
  const steps = response.steps.map((item) => {
    if (item.type === 'verification_goal') {
      const goalWire = { response: { kind: 'test_spec', steps: [item] } };
      return (JSON.parse(normalizeAgenticInterpretationWire(goalWire)) as { steps: unknown[] }).steps[0];
    }
    if (item.type === 'navigate') return AuthoredStepSchema.parse(item);
    const { nameSourceText, scope, role, ...rest } = item.actionTargetIntent;
    const actionTargetIntent = ActionTargetIntentV1Schema.parse({ ...rest,
      nameSourceSpan: uniqueSpan(item.sourceText, nameSourceText),
      role: role.kind === 'explicit' ? { kind: 'explicit', value: role.value,
        sourceSpan: uniqueSpan(item.sourceText, role.sourceText) } : role,
      ...(scope === null ? {} : { scope: scope.map(({ sourceText, ...entry }) => ({ ...entry,
        sourceSpan: uniqueSpan(item.sourceText, sourceText) })) }),
    });
    return AuthoredStepSchema.parse({ ...item, target: normalizeTarget(item.target), actionTargetIntent });
  });
  return JSON.stringify({ kind: 'test_spec', steps });
}

/** Accept a parsed provider JSON value and return the exact JSON consumed by M7-B. */
export function normalizeStepDecisionWire(input: unknown): string {
  return JSON.stringify(wireDecision.parse(input).response);
}
