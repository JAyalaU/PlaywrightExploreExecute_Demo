import { z } from 'zod';
import { SemanticIntentFidelityVerdictV3Schema, SemanticIntentStepV3Schema } from '../domain/semantic-intent-v3.js';

export const SemanticIntentPrimaryWireV3Schema = z.strictObject({ response: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('extraction'), steps: z.array(SemanticIntentStepV3Schema).min(1).max(100) }),
  z.strictObject({ kind: z.literal('unresolved'), reasonCode: z.enum(['unclear_effect', 'unclear_reference',
    'unclassified_material', 'authored_alternative']) }),
  z.strictObject({ kind: z.literal('authored_ambiguity'), reasonCode: z.enum(['CONTRADICTORY_AUTHORED_EFFECTS',
    'MISSING_LITERAL_ARGUMENT', 'UNRESOLVED_ANTECEDENT', 'CONFLICTING_EXPLICIT_TARGETS']) }),
]) });
export const SemanticIntentFidelityWireV3Schema = z.strictObject({ response: SemanticIntentFidelityVerdictV3Schema });

/** Normalize only JSON Schema dialect features rejected by the current strict provider contract. */
function responseFormat(name: string, schema: z.ZodType) {
  const { $schema: _dialect, ...raw } = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' });
  const convert = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(convert);
    if (!value || typeof value !== 'object') return value;
    const node = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(node).flatMap(([key, child]) => {
      if (key === 'format' && child === 'uri') return [];
      if (key === 'const') return [['enum', [child]]];
      if (key === 'exclusiveMinimum' && node.type === 'integer' && typeof child === 'number')
        return [['minimum', child + 1]];
      return [[key === 'oneOf' ? 'anyOf' : key, convert(child)]];
    }));
  };
  return Object.freeze({ type: 'json_schema' as const, name, strict: true as const, schema: convert(raw) });
}
export const SEMANTIC_INTENT_PRIMARY_V3_FORMAT = responseFormat('qa_deferred_semantic_intent_primary_v2',
  SemanticIntentPrimaryWireV3Schema);
export const SEMANTIC_INTENT_FIDELITY_V3_FORMAT = responseFormat('qa_deferred_semantic_intent_fidelity_v2',
  SemanticIntentFidelityWireV3Schema);
