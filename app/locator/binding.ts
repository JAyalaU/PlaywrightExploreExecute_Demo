import { z } from 'zod';

/** Raw locator binding facts. M4 maps these to operation-specific outcomes. */
export const BindingResultSchema = z.discriminatedUnion('reason', [
  z.strictObject({ reason: z.literal('BOUND'), matchCount: z.literal(1), observedTargetMatches: z.literal(true) }),
  z.strictObject({ reason: z.literal('NO_MATCH'), matchCount: z.literal(0) }),
  z.strictObject({ reason: z.literal('AMBIGUOUS_MATCH'), matchCount: z.number().int().min(2) }),
  z.strictObject({ reason: z.literal('IDENTITY_MISMATCH'), matchCount: z.literal(1), observedTargetMatches: z.literal(false) }),
  z.strictObject({ reason: z.literal('FRAME_RESOLUTION_FAILED') }),
  z.strictObject({ reason: z.literal('UNSUPPORTED_FORM') }),
  z.strictObject({ reason: z.literal('EVALUATION_FAILED') }),
]);

export type BindingResult = z.infer<typeof BindingResultSchema>;

/** Classify measured facts only; no browser access or QA operation semantics. */
export function bindingResultFromObservation(matchCount: number, observedTargetMatches?: boolean): BindingResult {
  if (!Number.isSafeInteger(matchCount) || matchCount < 0) throw new RangeError('matchCount must be a nonnegative safe integer');
  if (matchCount === 0) {
    if (observedTargetMatches !== undefined) throw new TypeError('Zero matches cannot have a target comparison');
    return { reason: 'NO_MATCH', matchCount: 0 };
  }
  if (matchCount > 1) {
    if (observedTargetMatches !== undefined) throw new TypeError('Ambiguous matches cannot have a target comparison');
    return { reason: 'AMBIGUOUS_MATCH', matchCount };
  }
  if (observedTargetMatches === undefined) throw new TypeError('A unique match requires a target comparison');
  return observedTargetMatches
    ? { reason: 'BOUND', matchCount: 1, observedTargetMatches: true }
    : { reason: 'IDENTITY_MISMATCH', matchCount: 1, observedTargetMatches: false };
}
