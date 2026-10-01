import { z } from 'zod';
import { SourceSpanSchema } from './action-goal.js';
import { exactSourceSpan, invalidSource, uniqueIds } from './action-goal-v2.js';

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const literal = z.string().min(1).max(512);
const sourceText = z.string().min(1).max(1024).refine((value) => value.trim() === value);
export const NativeOptionControlConstraintV2Schema = z.strictObject({
  kind: z.enum(['role', 'name', 'label']), text: literal, sourceSpan: SourceSpanSchema,
});
/** Authored option subject and owner constraints; no browser identity/value or acceptance fields. */
export const NativeOptionVerificationGoalV2Schema = z.strictObject({
  verificationVersion: z.literal('2'), type: z.literal('verification_goal'), id: identifier,
  sourceText, instruction: sourceText, sourceInstructionSpan: SourceSpanSchema,
  dependsOnStepId: identifier.optional(),
  claim: z.strictObject({
    kind: z.literal('native_owned_option_selected'), optionLabel: literal, optionSourceSpan: SourceSpanSchema,
    expectedSelected: z.boolean(), controlConstraints: z.array(NativeOptionControlConstraintV2Schema).max(24),
  }),
});
export type NativeOptionVerificationGoalV2 = z.infer<typeof NativeOptionVerificationGoalV2Schema>;

/** Mechanical source linkage only. Polarity and ownership require independent semantic agreement. */
export function validateNativeOptionVerificationGoalV2(goal: NativeOptionVerificationGoalV2,
  sourceInstruction: string, previousStepIds: readonly string[] = []): void {
  NativeOptionVerificationGoalV2Schema.parse(goal);
  exactSourceSpan(sourceInstruction, goal.sourceInstructionSpan, goal.sourceText);
  if (goal.instruction !== goal.sourceText) invalidSource('TRANSFORMED_NATIVE_VERIFICATION_CLAUSE');
  if (goal.dependsOnStepId && !previousStepIds.includes(goal.dependsOnStepId))
    invalidSource('INVALID_NATIVE_VERIFICATION_DEPENDENCY');
  exactSourceSpan(goal.sourceText, goal.claim.optionSourceSpan, goal.claim.optionLabel);
  const constraints = goal.claim.controlConstraints;
  uniqueIds(constraints.map((item) => `${item.kind}:${item.text}`), 'DUPLICATE_NATIVE_CONTROL_CONSTRAINT');
  uniqueIds(constraints.map((item) => `${item.sourceSpan.start}:${item.sourceSpan.end}`), 'DUPLICATE_NATIVE_CONSTRAINT_OCCURRENCE');
  for (const kind of ['role', 'name'] as const) {
    if (constraints.filter((item) => item.kind === kind).length > 1)
      invalidSource('CONTRADICTORY_NATIVE_CONTROL_CONSTRAINT');
  }
  let priorEnd = -1;
  for (const constraint of constraints) {
    exactSourceSpan(goal.sourceText, constraint.sourceSpan, constraint.text);
    if (constraint.sourceSpan.start < priorEnd) invalidSource('OVERLAPPING_OR_UNORDERED_NATIVE_CONTROL_CONSTRAINTS');
    priorEnd = constraint.sourceSpan.end;
    if (constraint.kind === 'role' && constraint.text !== 'combobox' && constraint.text !== 'listbox')
      invalidSource('UNREVIEWED_NATIVE_CHOICE_ROLE');
    if (constraint.sourceSpan.start < goal.claim.optionSourceSpan.end &&
        constraint.sourceSpan.end > goal.claim.optionSourceSpan.start)
      invalidSource('NATIVE_OPTION_CONTROL_OWNERSHIP_OVERLAP');
  }
}
