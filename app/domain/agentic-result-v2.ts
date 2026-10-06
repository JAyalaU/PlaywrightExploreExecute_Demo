import { z } from 'zod';
import { ExecutionProfileRefSchema } from './schema.js';
import { DeferredWorkflowStageV1Schema } from './deferred-workflow.js';

const id = z.string().max(128).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const profileRef = ExecutionProfileRefSchema.refine((value) => value.id.length <= 128 && value.version.length <= 64);
export const AgenticSafeReasonV2Schema = z.enum([
  'TARGET_NOT_FOUND', 'BUDGET_EXHAUSTED', 'UNSAFE_RECOVERY', 'UNSUPPORTED_OPERATION',
  'UNSUPPORTED_CAPABILITY', 'PROVIDER_ERROR', 'PROVIDER_TIMEOUT', 'MODEL_ERROR',
  'MODEL_TIMEOUT', 'BROWSER_UNAVAILABLE', 'NETWORK_POLICY_DENIED', 'UNSUPPORTED_GRAMMAR',
  'WEAK_IDENTITY', 'NON_UNIQUE_MATCH', 'TARGET_MISMATCH', 'PROFILE_MISMATCH',
  'POSTCONDITION_MISMATCH', 'COMPILER_ENVIRONMENT_UNAVAILABLE', 'REPLAY_ENVIRONMENT_UNAVAILABLE',
  'NO_MATCH', 'AMBIGUOUS_MATCH', 'FRAME_RESOLUTION_FAILED', 'WAIT_CONDITION_TIMEOUT',
  'UNKNOWN_TIMEOUT_POLICY', 'REPLAY_EXECUTION_FAILED', 'EVALUATION_FAILED',
  'REPLAY_OUTCOMES_DISAGREE', 'NOT_VISIBLE', 'TEXT_MISMATCH', 'VALUE_MISMATCH',
  'URL_MISMATCH', 'LINK_COUNT_MISMATCH', 'LINK_DESTINATION_MISMATCH',
  'SESSION_CLEANUP_FAILED', 'CANCELLED', 'REDACTED_REASON',
  'INVALID_TEST_SPEC', 'MATERIAL_AMBIGUITY', 'MALFORMED_MODEL_OUTPUT',
]);
export type AgenticSafeReasonV2 = z.infer<typeof AgenticSafeReasonV2Schema>;
export function safeAgenticReasonV2(input: string | undefined): AgenticSafeReasonV2 {
  const parsed = AgenticSafeReasonV2Schema.safeParse(input);
  return parsed.success ? parsed.data : 'REDACTED_REASON';
}

export const AgenticTerminalV2Schema = z.discriminatedUnion('status', [
  z.strictObject({ stage: z.literal('interpretation'), status: z.literal('INTERPRETATION_FAILED'), reason: z.enum(['INVALID_TEST_SPEC', 'MALFORMED_MODEL_OUTPUT', 'REDACTED_REASON']) }),
  z.strictObject({ stage: z.literal('interpretation'), status: z.literal('AMBIGUOUS_INSTRUCTION'), reason: z.enum(['MATERIAL_AMBIGUITY', 'REDACTED_REASON']) }),
  z.strictObject({ stage: z.literal('exploration'), status: z.literal('EXPLORATION_UNRESOLVED'), reason: z.enum(['TARGET_NOT_FOUND', 'BUDGET_EXHAUSTED', 'UNSAFE_RECOVERY', 'REDACTED_REASON']) }),
  z.strictObject({ stage: z.literal('exploration'), status: z.literal('EXPLORATION_UNSUPPORTED'), reason: z.enum(['UNSUPPORTED_OPERATION', 'UNSUPPORTED_CAPABILITY', 'REDACTED_REASON']) }),
  z.strictObject({ stage: z.literal('compilation'), status: z.literal('COMPILATION_FAILED'), reason: z.enum(['UNSUPPORTED_GRAMMAR', 'WEAK_IDENTITY', 'NON_UNIQUE_MATCH', 'TARGET_MISMATCH', 'PROFILE_MISMATCH', 'POSTCONDITION_MISMATCH', 'REDACTED_REASON']) }),
  z.strictObject({ stage: z.literal('compilation'), status: z.literal('COMPILATION_UNSUPPORTED'), reason: z.enum(['UNSUPPORTED_CAPABILITY', 'REDACTED_REASON']) }),
  z.strictObject({ stage: z.literal('replay'), status: z.literal('REPLAY_BINDING_FAILED'), reason: z.enum(['NO_MATCH', 'AMBIGUOUS_MATCH', 'FRAME_RESOLUTION_FAILED', 'TARGET_MISMATCH', 'REDACTED_REASON']) }),
  z.strictObject({ stage: z.literal('replay'), status: z.literal('REPLAY_WAIT_FAILED'), reason: z.enum(['WAIT_CONDITION_TIMEOUT', 'NO_MATCH', 'FRAME_RESOLUTION_FAILED', 'UNKNOWN_TIMEOUT_POLICY', 'REDACTED_REASON']) }),
  z.strictObject({ stage: z.literal('replay'), status: z.literal('REPLAY_EXECUTION_FAILED'), reason: z.enum(['REPLAY_EXECUTION_FAILED', 'EVALUATION_FAILED', 'REDACTED_REASON']) }),
  z.strictObject({ stage: z.literal('reproducibility'), status: z.literal('REPRODUCIBILITY_FAILED'), reason: z.literal('REPLAY_OUTCOMES_DISAGREE') }),
  z.strictObject({ stage: z.literal('execution'), status: z.literal('EXECUTION_REPRODUCED'), reason: z.literal('NO_ASSERTIONS') }),
  z.strictObject({ stage: z.literal('qa'), status: z.literal('QA_ASSERTION_PASSED') }),
  z.strictObject({ stage: z.literal('qa'), status: z.literal('QA_ASSERTION_FAILED'), reason: z.enum(['NO_MATCH', 'NOT_VISIBLE', 'TEXT_MISMATCH', 'VALUE_MISMATCH', 'URL_MISMATCH', 'LINK_COUNT_MISMATCH', 'LINK_DESTINATION_MISMATCH', 'REDACTED_REASON']) }),
  z.strictObject({ stage: z.literal('environment'), status: z.literal('ENVIRONMENT_FAILED'), reason: z.enum(['MODEL_ERROR', 'MODEL_TIMEOUT', 'PROVIDER_ERROR', 'PROVIDER_TIMEOUT', 'BROWSER_UNAVAILABLE', 'NETWORK_POLICY_DENIED', 'COMPILER_ENVIRONMENT_UNAVAILABLE', 'REPLAY_ENVIRONMENT_UNAVAILABLE', 'SESSION_CLEANUP_FAILED', 'REDACTED_REASON']) }),
  z.strictObject({ stage: z.literal('cancellation'), status: z.literal('CANCELLED'), reason: z.literal('CANCELLED') }),
]);
export const ResultRecordV2Schema = z.strictObject({
  resultVersion: z.literal('2'), workflowVersion: z.enum(['agentic-exploration-v1', 'goal-directed-v1', 'structured-action-v1', 'deferred-action-v1', 'semantic-general-v1']),
  testSpecId: id, executionProfileRef: profileRef, profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  presentationMode: z.enum(['headless', 'headed']),
  observation: z.enum(['unobserved', 'no_intervention', 'intervened', 'observational']),
  explorationAttemptId: id.optional(), successfulTraceId: id.optional(),
  compilerAttemptId: id.optional(), resolvedSpecId: id.optional(),
  executionRunIds: z.array(id).max(2), terminal: AgenticTerminalV2Schema,
  cleanup: z.enum(['not_started', 'verified', 'unverified']),
  deferredStage: DeferredWorkflowStageV1Schema.optional(),
  deferredReplay: z.strictObject({ orchestrationVersion: z.literal('1'), orchestrationId: id,
    sourceSchemaVersion: z.literal('6'), sourceContractVersion: z.literal('2'), traceVersion: z.literal('5'),
    compilerVersion: z.literal('4'), resolvedSchemaVersion: z.literal('9'), runnerVersion: z.literal('9'),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), admissionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    traceDigest: z.string().regex(/^[a-f0-9]{64}$/), compilerDigest: z.string().regex(/^[a-f0-9]{64}$/),
    resolvedDigest: z.string().regex(/^[a-f0-9]{64}$/), orchestrationDigest: z.string().regex(/^[a-f0-9]{64}$/),
    executionSessionIds: z.array(id).max(2), runDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(2),
  }).optional(),
  semanticReplay: z.strictObject({ sourceSchemaVersion: z.literal('7'), sourceContractVersion: z.literal('3'),
    groundingVersion: z.literal('semantic_capability_discovery_v1'),
    traceVersion: z.literal('semantic_grounded_trace_v1'), compilerVersion: z.literal('5'),
    resolvedSchemaVersion: z.literal('10'), runnerVersion: z.literal('10'),
    replayPairVersion: z.literal('2'), orchestrationId: id, traceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    resolvedDigest: z.string().regex(/^[a-f0-9]{64}$/), pairDigest: z.string().regex(/^[a-f0-9]{64}$/),
    executionSessionIds: z.array(id.nullable()).max(2), runDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(2),
  }).optional(),
}).superRefine((value, issue) => {
  const fail = (path: string, message: string): void => issue.addIssue({ code: 'custom', path: [path], message });
  const runs = value.executionRunIds;
  if ((value.workflowVersion === 'deferred-action-v1') !== (!!value.deferredReplay || !!value.deferredStage) ||
    !!value.deferredReplay && !!value.deferredStage)
    fail('deferredReplay', 'Deferred route requires isolated version and artifact linkage');
  if (value.workflowVersion === 'semantic-general-v1' ?
      (!!value.resolvedSpecId !== !!value.semanticReplay || !!value.deferredReplay || !!value.deferredStage) :
      !!value.semanticReplay)
    fail('semanticReplay', 'Semantic route requires isolated v10 replay linkage');
  if (value.semanticReplay && (value.semanticReplay.runDigests.length !== runs.length ||
    value.semanticReplay.executionSessionIds.length !== runs.length ||
    new Set(value.semanticReplay.executionSessionIds.filter(Boolean)).size !==
      value.semanticReplay.executionSessionIds.filter(Boolean).length ||
    value.terminal.stage === 'qa' && value.semanticReplay.executionSessionIds.some(id => id === null)))
    fail('semanticReplay', 'Semantic replay linkage must match fresh run count');
  if (value.deferredStage && (runs.length || value.resolvedSpecId ||
    !['interpretation', 'exploration', 'compilation', 'environment', 'cancellation'].includes(value.terminal.stage)))
    fail('deferredStage', 'Pre-replay stops cannot claim resolved execution or QA');
  if (value.deferredStage) {
    const d = value.deferredStage;
    if (['grounding', 'trace', 'compilation'].includes(d.stage) && (!d.admissionDigest || !value.explorationAttemptId) ||
      d.stage === 'compilation' && (!d.traceDigest || !value.successfulTraceId) ||
      value.successfulTraceId && !d.traceDigest || value.explorationAttemptId && !d.admissionDigest ||
      d.traceDigest && !value.successfulTraceId || d.stage === 'interpretation' &&
      (d.admissionDigest || d.traceDigest || value.explorationAttemptId || value.compilerAttemptId))
      fail('deferredStage', 'Deferred stage/source admission and stored artifact linkage mismatch');
  }
  if (value.deferredReplay && (value.deferredReplay.runDigests.length !== runs.length ||
    new Set(value.deferredReplay.executionSessionIds).size !== value.deferredReplay.executionSessionIds.length))
    fail('deferredReplay', 'Deferred run/session linkage must be distinct and total');
  if (value.deferredReplay && ['qa', 'reproducibility', 'execution'].includes(value.terminal.stage) &&
    value.deferredReplay.executionSessionIds.length !== 2)
    fail('deferredReplay', 'Completed deferred agreement requires two fresh sessions');
  if (value.terminal.stage === 'execution' && (value.workflowVersion !== 'deferred-action-v1' ||
    runs.length !== 2 || value.cleanup !== 'verified' || !value.resolvedSpecId))
    fail('terminal', 'Reproducible execution requires two deferred runs with verified cleanup');
  if (new Set(runs).size !== runs.length) fail('executionRunIds', 'Fresh replay IDs must differ');
  if ((value.presentationMode === 'headed') !== (value.observation === 'observational'))
    fail('observation', 'Headed result must remain observational');
  if (value.successfulTraceId && !value.explorationAttemptId) fail('successfulTraceId', 'Trace requires attempt');
  if (value.compilerAttemptId && !value.successfulTraceId) fail('compilerAttemptId', 'Compiler requires trace');
  if (value.resolvedSpecId && !value.compilerAttemptId) fail('resolvedSpecId', 'Resolved spec requires compiler');
  if (runs.length && !value.resolvedSpecId) fail('executionRunIds', 'Runs require an accepted resolved artifact');
  if (value.terminal.stage === 'qa' || value.terminal.stage === 'reproducibility') {
    if (runs.length !== 2 || !value.resolvedSpecId || value.cleanup !== 'verified')
      fail('terminal', 'QA or reproducibility requires two persisted runs and verified cleanup');
  }
  if (value.terminal.stage === 'exploration' && !value.explorationAttemptId) fail('explorationAttemptId', 'Exploration stop requires attempt');
  if (value.terminal.stage === 'compilation' && !value.compilerAttemptId) fail('compilerAttemptId', 'Compilation stop requires stored attempt');
  if (value.terminal.stage === 'replay' && !value.resolvedSpecId) fail('resolvedSpecId', 'Replay stop requires a resolved artifact');
  if (value.cleanup === 'unverified' && (value.terminal.stage !== 'environment' || value.terminal.reason !== 'SESSION_CLEANUP_FAILED'))
    fail('cleanup', 'Unverified cleanup requires environment overlay');
});
export type ResultRecordV2 = z.infer<typeof ResultRecordV2Schema>;
export function parseResultRecordV2(input: unknown): ResultRecordV2 { return ResultRecordV2Schema.parse(input); }
