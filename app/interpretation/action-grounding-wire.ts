import { z } from 'zod';
import { ActionGroundingDecisionV5Schema, IndependentGroundingExtractionV1Schema } from '../domain/action-grounding-strategy.js';

/** Provider strict schema encodes optional fields as required nulls. Domain parsing remains authoritative. */
function strictWire(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictWire);
  if (!schema || typeof schema !== 'object') return schema;
  const value = schema as Record<string, unknown>;
  const result: Record<string, unknown> = Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (key === '$schema' || key === 'format' && child === 'uri') return [];
    if (key === 'const') return [['enum', [child]]];
    if (key === 'exclusiveMinimum' && value.type === 'integer' && typeof child === 'number') return [['minimum', child + 1]];
    return [[key === 'oneOf' ? 'anyOf' : key, strictWire(child)]];
  }));
  if (value.type === 'object' && value.properties) {
    const required = new Set(value.required as string[] ?? []);
    result.properties = Object.fromEntries(Object.entries(value.properties as Record<string, unknown>).map(([key, child]) =>
      [key, required.has(key) ? strictWire(child) : { anyOf: [strictWire(child), { type: 'null' }] }]));
    result.required = Object.keys(value.properties as object); result.additionalProperties = false;
  }
  return result;
}
function format(name: string, schema: z.ZodType) {
  return Object.freeze({ type: 'json_schema' as const, name, strict: true as const,
    schema: strictWire(z.toJSONSchema(z.strictObject({ response: schema }), { target: 'draft-7', io: 'input' })) as Record<string, unknown> });
}
export const ACTION_GROUNDING_RESPONSE_FORMAT = format('qa_action_grounding_v5', ActionGroundingDecisionV5Schema);
export const ACTION_GROUNDING_INDEPENDENT_RESPONSE_FORMAT = format('qa_action_grounding_source_first_v1', IndependentGroundingExtractionV1Schema);
function absentNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(absentNulls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== null).map(([key, child]) => [key, absentNulls(child)]));
}
export function normalizeGroundingWire(value: unknown, independent: boolean): string {
  const response = z.strictObject({ response: z.unknown() }).parse(value).response;
  return JSON.stringify((independent ? IndependentGroundingExtractionV1Schema : ActionGroundingDecisionV5Schema).parse(absentNulls(response)));
}
