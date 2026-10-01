import { z } from 'zod';
import { ApprovedAbsoluteUrlSchema, AuthoredStepSchema, ExecutionProfileRefSchema } from './schema.js';
import { ActionGoalV1Schema, SourceSpanSchema, actionGoalFidelity, sourceSpanText } from './action-goal.js';
import { VerificationGoalSchema, verificationGoalFidelity } from './verification-goal.js';
import { ContractValidationError } from './validate.js';

export const DEFERRED_ACTION_GOAL_SCHEMA_VERSION = '6' as const;
const sourceText = z.string().min(1).max(1024).refine((value) => value.trim() === value);
export const DeferredAuthoredStepSchema = z.discriminatedUnion('type', [
  z.strictObject({ id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128), type: z.literal('navigate'),
    sourceText, sourceInstructionSpan: SourceSpanSchema, url: ApprovedAbsoluteUrlSchema }),
  ActionGoalV1Schema,
  VerificationGoalSchema.extend({ sourceInstructionSpan: SourceSpanSchema }),
]);

/** Deliberately separate from TestSpecSchema: no existing route accepts v6. */
export const TestSpecV6Schema = z.strictObject({
  schemaVersion: z.literal(DEFERRED_ACTION_GOAL_SCHEMA_VERSION),
  testSpecId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128),
  sourceInstruction: z.string().min(1).max(16384),
  executionProfileRef: ExecutionProfileRefSchema,
  startState: z.strictObject({ url: z.union([ApprovedAbsoluteUrlSchema, z.literal('about:blank')]) }),
  steps: z.array(DeferredAuthoredStepSchema).min(1).max(100),
});
export type TestSpecV6 = z.infer<typeof TestSpecV6Schema>;
export type DeferredAuthoredStep = z.infer<typeof DeferredAuthoredStepSchema>;

const emptyGap = (gap: string) => !gap.replace(/\b(?:and|then|please)\b|\d+[.)]/gi, '').replace(/[\s.,;:!?()-]/g, '');
function navigationFidelity(step: Extract<DeferredAuthoredStep, { type: 'navigate' }>): string | undefined {
  const { sourceInstructionSpan: _span, ...legacyNavigation } = step;
  if (!AuthoredStepSchema.safeParse(legacyNavigation).success) return 'INVALID_NAVIGATION_SOURCE';
  if (!step.sourceText.includes(step.url)) return 'NAVIGATION_URL_NOT_AUTHORED';
  const outsideUrl = step.sourceText.replace(step.url, '');
  if (!/^\s*(?:please\s+)?(?:go\s+to|navigate\s+to|open|visit)\s*[.!?]?\s*$/i.test(outsideUrl))
    return 'AMBIGUOUS_NAVIGATION_CLAUSE';
  return undefined;
}
export function parseTestSpecV6(input: unknown): TestSpecV6 {
  const spec = TestSpecV6Schema.parse(input);
  const seen = new Set<string>();
  let end = 0;
  for (const [index, step] of spec.steps.entries()) {
    if (seen.has(step.id)) throw new ContractValidationError(`Duplicate authored step ID: ${step.id}`);
    seen.add(step.id);
    if (step.sourceInstructionSpan.start < end ||
        sourceSpanText(spec.sourceInstruction, step.sourceInstructionSpan) !== step.sourceText ||
        !emptyGap(spec.sourceInstruction.slice(end, step.sourceInstructionSpan.start)))
      throw new ContractValidationError(`Step ${step.id}: SOURCE_CLAUSE_OWNERSHIP_OR_ORDER`);
    end = step.sourceInstructionSpan.end;
    const problem = step.type === 'action_goal' ? actionGoalFidelity(step, spec.sourceInstruction) :
      step.type === 'verification_goal' ? verificationGoalFidelity(step, spec.sourceInstruction,
        spec.steps.slice(0, index).map((prior) => prior.id)) :
      navigationFidelity(step);
    if (problem) throw new ContractValidationError(`Step ${step.id}: ${problem}`);
  }
  if (!emptyGap(spec.sourceInstruction.slice(end))) throw new ContractValidationError('UNOWNED_SOURCE_CLAUSE');
  return spec;
}
