import { z } from 'zod';

/** Closed, safe diagnostic taxonomy. Detailed source/browser accounting stays private. */
export const DeferredWorkflowStopCodeV1Schema = z.enum([
  'INVALID_SOURCE_REPRESENTATION', 'SEMANTIC_INTERPRETATION_DISAGREEMENT', 'SEMANTIC_FIDELITY_MISMATCH',
  'SEMANTIC_INTERPRETATION_UNRESOLVED', 'UNSUPPORTED_AUTHORED_OPERATION', 'UNSUPPORTED_AUTHORED_CONSTRAINT', 'AUTHORED_AMBIGUITY',
  'PROVIDER_CONFIGURATION_ERROR', 'PROVIDER_INPUT_INVALID', 'PROVIDER_ERROR', 'PROVIDER_TIMEOUT', 'PROVIDER_REFUSAL',
  'PROVIDER_INCOMPLETE', 'PROVIDER_OUTPUT_INVALID', 'PROVIDER_RESPONSE_TOO_LARGE',
  'EXTRACTION_DEADLINE', 'INTERPRETATION_CANCELLED', 'EXTRACTION_ENVIRONMENT_ERROR',
  'NO_CANDIDATES', 'NON_UNIQUE', 'OPTION_ABSENT', 'OPTION_NON_UNIQUE', 'VALUE_NON_UNIQUE', 'OPTION_DISABLED', 'NOT_ACTIONABLE',
  'INVALID_REQUEST', 'OBLIGATION_MAPPING_MISMATCH', 'UNTRUSTED_EVIDENCE', 'UNSUPPORTED_OPERATION', 'UNSUPPORTED_CONTROL',
  'UNSUPPORTED_MAPPING', 'PENDING_OBLIGATIONS', 'SEMANTIC_DISAGREEMENT', 'ENDORSEMENT_REQUIRED', 'INVALID_GOAL',
  'MODEL_STOP', 'INPUT_LIMIT', 'INVALID_DECISION', 'PROVIDER_OR_ENVIRONMENT_STOP', 'STRATEGY_TIMEOUT',
  'EXECUTION_BUDGET', 'EXECUTION_ENVIRONMENT_STOP', 'EXECUTION_RETRY_EXHAUSTED', 'PROTECTED_READBACK_UNAVAILABLE',
  'RESULT_LIMIT', 'STALE_STATE', 'UNPROVEN_FRAME', 'QUERY_UNEVALUABLE', 'BROWSER_FAILURE', 'BUSY',
  'PROFILE_MISMATCH', 'SOURCE_CORRESPONDENCE', 'NON_UNIQUE_MATCH', 'TARGET_MISMATCH', 'LABEL_ASSOCIATION_MISMATCH',
  'OPTION_MAPPING_MISMATCH', 'FRAME_MISMATCH', 'INCOMPLETE_EVIDENCE', 'STALE_EVIDENCE', 'UNSUPPORTED_REPRESENTATION',
  'UNSUPPORTED_VERIFICATION', 'UNSUPPORTED_ACTIVATION', 'POST_EFFECT_UNPROVEN', 'ENVIRONMENT_FAILURE', 'CLEANUP_UNVERIFIED',
  'VERIFICATION_UNRESOLVED', 'VERIFICATION_UNSUPPORTED', 'TRACE_INTEGRITY_FAILED', 'PERSISTENCE_FAILED', 'CANCELLED',
  'SESSION_CLEANUP_FAILED', 'ENVIRONMENT_STOP',
]);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const DeferredWorkflowStageV1Schema = z.strictObject({
  integrationVersion: z.literal('1'), sourceSchemaVersion: z.literal('6'), sourceContractVersion: z.literal('2'),
  stage: z.enum(['interpretation', 'grounding', 'trace', 'compilation', 'environment', 'cancellation']),
  category: z.enum(['structural', 'semantic_disagreement', 'omission_fidelity', 'unresolved', 'authored_ambiguity',
    'unsupported_operation', 'unsupported_constraint', 'unsupported', 'provider_environment', 'provider', 'environment',
    'integrity', 'persistence', 'cancelled']),
  code: DeferredWorkflowStopCodeV1Schema, sourceDigest: digest, admissionDigest: digest.optional(), traceDigest: digest.optional(),
});
export type DeferredWorkflowStageV1 = z.infer<typeof DeferredWorkflowStageV1Schema>;
export function safeDeferredWorkflowStopCode(input: string): z.infer<typeof DeferredWorkflowStopCodeV1Schema> {
  const value = DeferredWorkflowStopCodeV1Schema.safeParse(input);
  return value.success ? value.data : 'ENVIRONMENT_STOP';
}
