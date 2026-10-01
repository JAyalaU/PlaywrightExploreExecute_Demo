import { z } from 'zod';

const qualityCode = z.enum([
  'UNSUPPORTED_GRAMMAR', 'WEAK_IDENTITY', 'TEST_ID_PROVENANCE_UNVERIFIED',
  'NON_UNIQUE_MATCH', 'TARGET_MISMATCH',
]);

/** Private developer record. Closed enums prevent model or page text entering this artifact. */
export const M7DecisionDiagnosticSchema = z.strictObject({
  schemaVersion: z.literal('1'),
  explorationAttemptId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  originStepId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  executionStepId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  callOrdinal: z.number().int().min(1).max(1000),
  snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
  retryMode: z.enum(['none', 'same_node_refinement', 'different_node_selection']),
  retryCodes: z.array(qualityCode).max(5),
  rejectionCodes: z.array(qualityCode).max(5),
  decisionKind: z.enum(['none', 'find', 'wait', 'prerequisite', 'target', 'unresolved']),
  selectedReferenceRelation: z.enum(['absent', 'same', 'different']),
  validationCode: z.enum([
    'accepted', 'MODEL_TIMEOUT', 'MODEL_ERROR', 'MODEL_OUTPUT_INVALID',
    'REF_OUTSIDE_BOUNDED_CONTEXT', 'DECISION_LIMIT_EXCEEDED',
    'LOCATOR_REFINEMENT_CONTEXT_INVALID', 'REPEATED_CANDIDATE_NO_NEW_EVIDENCE',
    'REFINEMENT_REQUIRES_SAME_NODE', 'SELECTION_REQUIRES_DIFFERENT_NODE',
    'RESOLVER_REJECTED',
  ]),
  resultCode: z.enum([
    'none', 'OPERATION_SUCCEEDED', 'TARGET_RESOLUTION_FAILED',
    'LOCATOR_GENERATION_FAILED', 'LOCATOR_QUALITY_FAILED', 'MCP_EXPLORATION_FAILED',
  ]),
  resolverOutcome: z.enum([
    'decision_failed', 'find', 'wait', 'unresolved', 'closed_zero_match',
    'quality_retry', 'quality_failed', 'raw_accepted', 'role_name_projected',
    'row_scope_projected', 'prerequisite_completed', 'resolver_failed',
  ]),
});

export type M7DecisionDiagnostic = z.infer<typeof M7DecisionDiagnosticSchema>;
