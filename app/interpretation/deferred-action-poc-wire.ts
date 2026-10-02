import { z } from 'zod';
import { ApprovedAbsoluteUrlSchema } from '../domain/schema.js';
import { VerificationGoalIntentSchema, VerificationGoalSubjectSchema } from '../domain/verification-goal.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const phrase = z.string().min(1).max(512);
const dependency = id.nullable();
const action = z.strictObject({ id, type: z.literal('action_goal'),
  effect: z.enum(['activate', 'enter_text', 'choose']),
  explicitOperation: z.enum(['click', 'fill', 'select_option', 'unsupported']).nullable(),
  argument: z.strictObject({ purpose: z.enum(['entered_text', 'choice']), value: phrase }).nullable(),
  targetConstraints: z.array(z.strictObject({ kind: z.enum(['role', 'name', 'context', 'uniqueness']),
    value: phrase, polarity: z.enum(['positive', 'negative']) })).max(24),
  dependsOnStepId: dependency,
});
const navigation = z.strictObject({ id, type: z.literal('navigate'), url: ApprovedAbsoluteUrlSchema });
const verification = z.strictObject({ id, type: z.literal('verification_goal'), verificationVersion: z.null(),
  instruction: phrase, subject: VerificationGoalSubjectSchema.nullable(),
  intent: VerificationGoalIntentSchema.nullable(), dependsOnStepId: dependency });
const nativeVerification = z.strictObject({ id, type: z.literal('verification_goal'), verificationVersion: z.literal('2'),
  optionLabel: phrase, expectedSelected: z.boolean(),
  controlConstraints: z.array(z.strictObject({ kind: z.enum(['role', 'name', 'label']), text: phrase })).max(24),
  dependsOnStepId: dependency });
export const PocSemanticStepSchema = z.union([navigation, action, verification, nativeVerification]);
export const PocPrimaryWireSchema = z.strictObject({ response: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('extraction'), steps: z.array(PocSemanticStepSchema).min(1).max(100) }),
  z.strictObject({ kind: z.literal('unresolved'), reasonCode: z.enum(['unclear_operation', 'unclear_reference',
    'unclassified_material', 'authored_alternative']) }),
  z.strictObject({ kind: z.literal('authored_ambiguity'), reasonCode: z.enum(['CONTRADICTORY_AUTHORED_EFFECTS',
    'MISSING_LITERAL_ARGUMENT', 'UNRESOLVED_ANTECEDENT', 'CONFLICTING_EXPLICIT_TARGETS',
    'UNCLEAR_AUTHORED_ALTERNATIVES']) }),
]) });
export type PocPrimaryResponse = z.infer<typeof PocPrimaryWireSchema>['response'];

export const PocFidelityIssueSchema = z.strictObject({
  kind: z.enum(['missing_requirement', 'changed_literal', 'changed_polarity', 'changed_order',
    'invented_requirement', 'unsupported_meaning']),
  sourceStep: z.number().int().min(1).max(100).nullable(), summary: z.string().min(1).max(160),
});
export const PocFidelityWireSchema = z.strictObject({ response: z.strictObject({
  verdict: z.enum(['faithful', 'not_faithful']), issues: z.array(PocFidelityIssueSchema).max(8),
}) });
export type PocFidelityVerdict = z.infer<typeof PocFidelityWireSchema>['response'];

function format(name: string, schema: z.ZodType) {
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' });
  const providerSchema = (value: unknown, path = ''): unknown => {
    if (Array.isArray(value)) return value.map((item, index) => providerSchema(item, `${path}.${index}`));
    if (!value || typeof value !== 'object') return value;
    const node = value as Record<string, unknown>;
    const converted = Object.fromEntries(Object.entries(node).flatMap(([key, child]) => {
      if (key === 'format' && child === 'uri') return [];
      if (key === 'const') return [['enum', [child]]];
      if (key === 'exclusiveMinimum' && node.type === 'integer' && typeof child === 'number') return [['minimum', child + 1]];
      return [[key === 'oneOf' ? 'anyOf' : key, providerSchema(child, `${path}.${key}`)]];
    }));
    if (name === 'qa_deferred_semantic_poc_primary_v1' && path.endsWith('.properties.subject')) {
      // A non-null subject hint has three optional fields but must contain at least one.
      // Structured Outputs requires every property in each object branch to be required.
      // Expand the seven valid presence combinations; the existing null branch means no hint.
      const alternatives = converted.anyOf as Record<string, unknown>[];
      const subject = alternatives[0]!;
      const properties = subject.properties as Record<string, unknown>;
      const keys = Object.keys(properties);
      return { anyOf: [
        ...Array.from({ length: (1 << keys.length) - 1 }, (_, index) => {
          const present = keys.filter((_, bit) => ((index + 1) & (1 << bit)) !== 0);
          return { type: 'object', properties: Object.fromEntries(present.map((key) => [key, properties[key]])),
            required: present, additionalProperties: false };
        }),
        alternatives[1],
      ] };
    }
    return converted;
  };
  return Object.freeze({ type: 'json_schema' as const, name, strict: true as const, schema: providerSchema(jsonSchema) });
}
export const POC_PRIMARY_RESPONSE_FORMAT = format('qa_deferred_semantic_poc_primary_v1', PocPrimaryWireSchema);
export const POC_FIDELITY_RESPONSE_FORMAT = format('qa_deferred_semantic_poc_fidelity_v1', PocFidelityWireSchema);
