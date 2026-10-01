import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);

/** A bounded exploration comparison, not a deterministic replay assertion. */
export const VerificationComparisonV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('count'), observationId: identifier,
    operator: z.enum(['equal', 'greater_than', 'at_least', 'at_most']),
    expected: z.number().int().min(0).max(10_000) }),
  z.strictObject({ kind: z.literal('boolean'), observationId: identifier,
    property: z.enum(['visible', 'enabled', 'checked', 'expanded', 'selected']), expected: z.boolean() }),
  z.strictObject({ kind: z.literal('string'), observationId: identifier,
    property: z.enum(['text', 'value', 'url']), operator: z.enum(['equal', 'contains', 'url_prefix']),
    expected: z.string().max(2048) }),
  z.strictObject({ kind: z.literal('transition'), earlierObservationId: identifier,
    laterObservationId: identifier, operator: z.enum(['appears', 'disappears']) }),
]);
export type VerificationComparisonV1 = z.infer<typeof VerificationComparisonV1Schema>;
