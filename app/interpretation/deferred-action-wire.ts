import { z } from 'zod';
import { ActionGoalV1Schema, DeferredAuthoredStepSchema, SourceSpanSchema,
  VerificationGoalSchema } from '../domain/index.js';
import { AGENTIC_INTERPRETATION_RESPONSE_FORMAT } from './openai-wire.js';

const object = (properties: Record<string, unknown>) => ({ type: 'object', properties,
  required: Object.keys(properties), additionalProperties: false } as const);
const string = { type: 'string' } as const;
const literal = (value: string) => ({ type: 'string', enum: [value] } as const);
const ref = (name: string) => ({ $ref: `#/$defs/${name}` } as const);
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });
const base = { id: string, sourceText: string, sourceInstructionSpan: ref('sourceSpan') };

export const DEFERRED_ACTION_AMBIGUITY_CODES = [
  'CONTRADICTORY_AUTHORED_EFFECTS', 'MISSING_LITERAL_ARGUMENT',
  'UNRESOLVED_ANTECEDENT', 'CONFLICTING_EXPLICIT_TARGETS', 'UNCLEAR_AUTHORED_CLAUSES',
] as const;

/** New format only: provider optionals are required nullable fields, never v5 identities. */
export const DEFERRED_ACTION_INTERPRETATION_RESPONSE_FORMAT = {
  type: 'json_schema', name: 'qa_deferred_action_interpretation_v4', strict: true,
  schema: {
    ...object({ response: ref('response') }),
    $defs: {
      sourceSpan: object({ start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 } }),
      scope: AGENTIC_INTERPRETATION_RESPONSE_FORMAT.schema.$defs.scope,
      goalSubject: AGENTIC_INTERPRETATION_RESPONSE_FORMAT.schema.$defs.goalSubject,
      goalIntent: AGENTIC_INTERPRETATION_RESPONSE_FORMAT.schema.$defs.goalIntent,
      authoredPhrase: object({ authoredText: string, sourceSpan: ref('sourceSpan') }),
      explicitOperation: object({ operation: { type: 'string', enum: ['click', 'fill', 'select_option'] }, sourceSpan: ref('sourceSpan') }),
      argument: object({ purpose: { type: 'string', enum: ['entered_text', 'choice'] },
        authoredText: string, sourceSpan: ref('sourceSpan') }),
      targetConstraint: object({ kind: { type: 'string', enum: ['role', 'name', 'context', 'relationship', 'uniqueness'] },
        authoredText: string, sourceSpan: ref('sourceSpan'), polarity: literal('positive') }),
      authoredStep: { anyOf: [
        object({ ...base, type: literal('navigate'), url: string }),
        object({ ...base, type: literal('action_goal'), goalVersion: literal('1'), sourceStepId: string,
          effect: { type: 'string', enum: ['activate', 'enter_text', 'choose'] }, effectSourceSpan: ref('sourceSpan'),
          explicitOperation: nullable(ref('explicitOperation')), argument: nullable(ref('argument')),
          targetConstraints: { type: 'array', items: ref('targetConstraint') }, prerequisiteContext: nullable(ref('authoredPhrase')) }),
        object({ ...base, type: literal('verification_goal'), instruction: string,
          subject: nullable(ref('goalSubject')), intent: nullable(ref('goalIntent')), dependsOnStepId: { type: ['string', 'null'] } }),
      ] },
      response: { anyOf: [
        object({ kind: literal('test_spec'), steps: { type: 'array', items: ref('authoredStep') } }),
        object({ kind: literal('ambiguous'), reasonCode: { type: 'string', enum: DEFERRED_ACTION_AMBIGUITY_CODES }, reason: string }),
        object({ kind: literal('unsupported'), reason: string }),
      ] },
    },
  },
} as const;

const subjectShape = VerificationGoalSchema.shape.subject.unwrap().shape;
const wireSubject = z.strictObject({ role: subjectShape.role.unwrap().nullable(),
  accessibleName: subjectShape.accessibleName.unwrap().nullable(), scope: subjectShape.scope.unwrap().nullable() });
const wireAction = ActionGoalV1Schema.extend({
  explicitOperation: ActionGoalV1Schema.shape.explicitOperation.unwrap().nullable(),
  argument: ActionGoalV1Schema.shape.argument.unwrap().nullable(),
  prerequisiteContext: ActionGoalV1Schema.shape.prerequisiteContext.unwrap().nullable(),
});
const wireGoal = VerificationGoalSchema.extend({ sourceInstructionSpan: SourceSpanSchema,
  subject: wireSubject.nullable(), intent: VerificationGoalSchema.shape.intent.unwrap().nullable(),
  dependsOnStepId: VerificationGoalSchema.shape.dependsOnStepId.unwrap().nullable(),
});
export const DeferredInterpretationWireSchema = z.strictObject({ response: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('test_spec'), steps: z.array(z.union([
    DeferredAuthoredStepSchema.options[0], wireAction, wireGoal,
  ])).min(1).max(100) }),
  z.strictObject({ kind: z.literal('ambiguous'), reasonCode: z.enum(DEFERRED_ACTION_AMBIGUITY_CODES),
    reason: z.string().trim().min(1).max(500) }),
  z.strictObject({ kind: z.literal('unsupported'), reason: z.string().trim().min(1).max(500) }),
]) });

/** Exact provider spans are retained; no first-occurrence resolution or source rewriting. */
export function normalizeDeferredActionInterpretationWire(input: unknown): string {
  const { response } = DeferredInterpretationWireSchema.parse(input);
  if (response.kind !== 'test_spec') return JSON.stringify(response);
  const steps = response.steps.map((item) => {
    if (item.type === 'navigate') return item;
    if (item.type === 'action_goal') {
      const { explicitOperation, argument, prerequisiteContext, ...rest } = item;
      return DeferredAuthoredStepSchema.parse({ ...rest,
        ...(explicitOperation === null ? {} : { explicitOperation }),
        ...(argument === null ? {} : { argument }),
        ...(prerequisiteContext === null ? {} : { prerequisiteContext }) });
    }
    const { subject, intent, dependsOnStepId, ...rest } = item;
    const normalizedSubject = subject === null ? undefined : {
      ...(subject.role === null ? {} : { role: subject.role }),
      ...(subject.accessibleName === null ? {} : { accessibleName: subject.accessibleName }),
      ...(subject.scope === null ? {} : { scope: subject.scope }),
    };
    return DeferredAuthoredStepSchema.parse({ ...rest,
      ...(normalizedSubject && Object.keys(normalizedSubject).length ? { subject: normalizedSubject } : {}),
      ...(intent === null ? {} : { intent }), ...(dependsOnStepId === null ? {} : { dependsOnStepId }) });
  });
  return JSON.stringify({ kind: 'test_spec', steps });
}
