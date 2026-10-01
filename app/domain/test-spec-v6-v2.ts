import { z } from 'zod';
import { ApprovedAbsoluteUrlSchema, AuthoredStepSchema, ExecutionProfileRefSchema } from './schema.js';
import { SourceSpanSchema } from './action-goal.js';
import { ActionGoalV2Schema, exactSourceSpan, invalidSource, uniqueIds, validateActionGoalV2 } from './action-goal-v2.js';
import { VerificationGoalSchema, verificationGoalFidelity } from './verification-goal.js';
import { NativeOptionVerificationGoalV2Schema, validateNativeOptionVerificationGoalV2 } from './native-option-verification-goal.js';

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const sourceText = z.string().min(1).max(1024).refine((value) => value.trim() === value);
export const LegacyDeferredAuthoredStepV2Schema = z.discriminatedUnion('type', [
  z.strictObject({ id: identifier, type: z.literal('navigate'), sourceText,
    sourceInstructionSpan: SourceSpanSchema, url: ApprovedAbsoluteUrlSchema }),
  ActionGoalV2Schema,
  VerificationGoalSchema.extend({ sourceInstructionSpan: SourceSpanSchema }),
]);
export const DeferredAuthoredStepV2Schema = z.union([LegacyDeferredAuthoredStepV2Schema, NativeOptionVerificationGoalV2Schema]);
const accountingBase = { sourceSpan: SourceSpanSchema, authoredText: z.string().min(1).max(16384) };
export const InstructionAccountingV2Schema = z.discriminatedUnion('classification', [
  z.strictObject({ ...accountingBase, classification: z.literal('clause'), stepId: identifier }),
  z.strictObject({ ...accountingBase, classification: z.literal('neutral') }),
  z.strictObject({ ...accountingBase, classification: z.literal('unresolved'),
    reason: z.enum(['unclassified_material', 'unclear_clause_linkage', 'authored_alternative']) }),
]);

/** New source-only successor. The old v6/v1 reader and adapter retain their meaning. */
export const TestSpecV6V2Schema = z.strictObject({
  schemaVersion: z.literal('6'), sourceContractVersion: z.literal('2'), testSpecId: identifier,
  sourceInstruction: z.string().min(1).max(16384), executionProfileRef: ExecutionProfileRefSchema,
  startState: z.strictObject({ url: z.union([ApprovedAbsoluteUrlSchema, z.literal('about:blank')]) }),
  steps: z.array(DeferredAuthoredStepV2Schema).min(1).max(100),
  instructionAccounting: z.array(InstructionAccountingV2Schema).min(1).max(301),
});
export type TestSpecV6V2 = z.infer<typeof TestSpecV6V2Schema>;
export type DeferredAuthoredStepV2 = z.infer<typeof DeferredAuthoredStepV2Schema>;

/** Parses a structurally valid draft; this never grants semantic or browser admission. */
export function parseTestSpecV6V2(input: unknown): TestSpecV6V2 {
  const spec = TestSpecV6V2Schema.parse(input);
  uniqueIds(spec.steps.map((step) => step.id), 'DUPLICATE_STEP_ID');
  let end = 0;
  const accountedSteps: string[] = [];
  for (const segment of spec.instructionAccounting) {
    exactSourceSpan(spec.sourceInstruction, segment.sourceSpan, segment.authoredText);
    if (segment.sourceSpan.start !== end) invalidSource('INCOMPLETE_OR_OVERLAPPING_INSTRUCTION_PARTITION');
    end = segment.sourceSpan.end;
    if (segment.classification !== 'clause') continue;
    const step = spec.steps[accountedSteps.length];
    if (!step || step.id !== segment.stepId || step.sourceText !== segment.authoredText ||
        step.sourceInstructionSpan.start !== segment.sourceSpan.start || step.sourceInstructionSpan.end !== segment.sourceSpan.end)
      invalidSource('CLAUSE_OWNERSHIP_OR_ORDER');
    accountedSteps.push(segment.stepId);
  }
  if (end !== spec.sourceInstruction.length || accountedSteps.length !== spec.steps.length)
    invalidSource('INCOMPLETE_INSTRUCTION_ACCOUNTING');
  for (const [index, step] of spec.steps.entries()) {
    exactSourceSpan(spec.sourceInstruction, step.sourceInstructionSpan, step.sourceText);
    if (step.type === 'action_goal') {
      validateActionGoalV2(step, spec.sourceInstruction, spec.steps.slice(0, index));
    } else if (step.type === 'verification_goal') {
      const previousIds = spec.steps.slice(0, index).map((prior) => prior.id);
      if ('verificationVersion' in step) validateNativeOptionVerificationGoalV2(step, spec.sourceInstruction, previousIds);
      else {
        const problem = verificationGoalFidelity(step, spec.sourceInstruction, previousIds);
        if (problem) invalidSource(problem);
      }
    } else {
      // Retain existing approved-URL and authored navigation policy; no new navigation semantics.
      const { sourceInstructionSpan: _span, ...navigation } = step;
      if (!AuthoredStepSchema.safeParse(navigation).success || !step.sourceText.includes(step.url))
        invalidSource('INVALID_NAVIGATION_SOURCE');
      if (!/^\s*(?:please\s+)?(?:go\s+to|navigate\s+to|open|visit)\s*[.!?]?\s*$/i.test(step.sourceText.replace(step.url, '')))
        invalidSource('AMBIGUOUS_NAVIGATION_CLAUSE');
    }
  }
  return spec;
}
