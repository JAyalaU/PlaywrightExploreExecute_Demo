import { z } from 'zod';

const elapsed = z.number().int().min(0).max(86_400_000);
const limit = z.number().int().min(0).max(900_000);
const phase = z.enum(['primary', 'independent', 'admission']);
const origin = z.enum(['none', 'per_call', 'shared', 'cancellation']);

/** Restricted, payload-free interpretation timing. This grants no admission authority. */
export const DeferredInterpretationTimingV1Schema = z.strictObject({
  diagnosticVersion: z.literal('1'),
  phase,
  phaseElapsedMs: elapsed,
  totalElapsedMs: elapsed,
  perCallLimitMs: limit,
  sharedLimitMs: limit,
  remainingMs: limit,
  providerCompletedBeforeBoundary: z.boolean(),
  deadlineOrigin: origin,
  phases: z.array(z.strictObject({
    phase,
    elapsedMs: elapsed,
    allowedMs: limit,
    remainingAtStartMs: limit,
    providerCompletedBeforeBoundary: z.boolean(),
    deadlineOrigin: origin,
  })).min(1).max(3),
  /** Optional for pre-retry records. Restricted attempt accounting, never provider content. */
  attempts: z.array(z.strictObject({
    phase: z.enum(['primary', 'independent']),
    attempt: z.union([z.literal(1), z.literal(2)]),
    elapsedMs: elapsed,
    allowedMs: limit,
    remainingAtStartMs: limit,
    providerCompletedBeforeBoundary: z.boolean(),
    providerResponseState: z.enum(['completed', 'incomplete', 'unavailable']),
    outcome: z.enum(['valid_extraction', 'invalid_wire', 'invalid_structure', 'provider_stop',
      'deadline', 'cancelled', 'environment_stop']),
  })).max(4).optional(),
}).superRefine((value, ctx) => {
  const order = ['primary', 'independent', 'admission'];
  if (value.phases.at(-1)?.phase !== value.phase ||
    value.phases.some((entry, index) => entry.phase !== order[index]) ||
    value.phaseElapsedMs !== value.phases.at(-1)?.elapsedMs ||
    value.providerCompletedBeforeBoundary !== value.phases.at(-1)?.providerCompletedBeforeBoundary ||
    value.deadlineOrigin !== value.phases.at(-1)?.deadlineOrigin ||
    value.remainingMs > value.sharedLimitMs || value.perCallLimitMs < 1 || value.sharedLimitMs < 1)
    ctx.addIssue({ code: 'custom', message: 'Invalid interpretation timing sequence' });
  let primary = 0, independent = 0;
  for (const attempt of value.attempts ?? []) {
    if (attempt.phase === 'primary') {
      if (independent || attempt.attempt !== ++primary) ctx.addIssue({ code: 'custom', message: 'Invalid attempt order' });
    } else if (attempt.attempt !== ++independent || primary < 1) {
      ctx.addIssue({ code: 'custom', message: 'Invalid attempt order' });
    }
  }
});
export type DeferredInterpretationTimingV1 = z.infer<typeof DeferredInterpretationTimingV1Schema>;
