import { z } from 'zod';
import {
  ExecutionProfileRefSchema, LocatorFormSchema, TestSpecSchema, WaitConditionSchema,
  type TestSpec,
} from './schema.js';

/** Private, versioned contracts for the exploration/compilation migration. */
export const TARGET_BINDING_VERSION = '1' as const;
export const SUCCESSFUL_TRACE_VERSION = '1' as const;
export const SUCCESSFUL_TRACE_V2_VERSION = '2' as const;
export const BRANCH_DIAGNOSTIC_VERSION = '1' as const;
export const COMPILER_ATTEMPT_VERSION = '1' as const;
export const AGENTIC_ATTEMPT_VERSION = '3' as const;
export const AGENTIC_RESOLVED_VERSION = '6' as const;

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.iso.datetime();
const short = z.string().min(1).max(256);
const semanticText = z.string().min(1).max(512);
const httpUrl = z.url().max(2048).refine((value) => {
  const url = new URL(value);
  return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
}, 'Expected an absolute HTTP(S) URL without credentials');
const profile = ExecutionProfileRefSchema;
const owner = z.strictObject({
  testSpecId: id, explorationAttemptId: id, executionProfileRef: profile, profileFingerprint: digest,
});

export const ExplorationTargetBindingV1Schema = z.strictObject({
  bindingVersion: z.literal(TARGET_BINDING_VERSION), bindingId: id,
  ...owner.shape,
  sessionId: id, pageId: id, frameId: id, snapshotEpoch: z.number().int().nonnegative(),
  snapshotDigest: digest, selectedRef: id, originStepId: id,
  issuedAt: time,
  operation: z.enum(['click', 'fill', 'select_option', 'assert_visible', 'assert_text', 'assert_value', 'wait_for']),
  selectedNode: z.strictObject({ role: short, accessibleName: z.string().max(512),
    destination: httpUrl.optional() }),
  justificationCode: z.enum(['authored_target', 'discovered_prerequisite', 'assertion_target', 'wait_target']),
});
export type ExplorationTargetBindingV1 = z.infer<typeof ExplorationTargetBindingV1Schema>;

/** The caller supplies the active protected session's state; a stored ref alone grants no authority. */
export const ActiveBindingContextSchema = z.strictObject({
  ...owner.shape, sessionId: id, pageId: id, frameId: id,
  snapshotEpoch: z.number().int().nonnegative(), snapshotDigest: digest,
  selectedRef: id, selectedRefCount: z.literal(1),
  selectedNode: ExplorationTargetBindingV1Schema.shape.selectedNode,
  visible: z.boolean(), enabled: z.boolean(),
});
export type ActiveBindingContext = z.infer<typeof ActiveBindingContextSchema>;

const pathBase = {
  recordId: id, sequence: z.number().int().positive(), originStepId: id,
  source: z.enum(['authored', 'discoveredPrerequisite']),
  prerequisiteReasonCode: z.enum(['expose_target', 'reach_state']).optional(),
  preStateDigest: digest, postStateDigest: digest,
  observationDigest: digest,
  observedEffect: z.enum(['state_changed', 'state_unchanged']).optional(),
  evidenceRefs: z.array(z.string().regex(/^evidence\/attempt-[A-Za-z][A-Za-z0-9_-]*\/[A-Za-z][A-Za-z0-9_-]*\/content\.(?:json|txt|png|zip|webm)$/)).max(8).optional(),
};
const dataValue = z.union([z.string().max(2048), z.strictObject({ kind: z.literal('dataRef'), ref: id })]);
const targetOp = { bindingId: id };

export const SuccessfulPathRecordV1Schema = z.discriminatedUnion('type', [
  // A protected observation may detect an autonomous page transition between
  // authored operations. It is trace provenance, not an executable action.
  z.strictObject({ ...pathBase, type: z.literal('state_observed'), result: z.literal('observed') }),
  z.strictObject({ ...pathBase, type: z.literal('navigate'), url: httpUrl, result: z.literal('completed') }),
  z.strictObject({ ...pathBase, ...targetOp, type: z.literal('click'), result: z.literal('completed') }),
  z.strictObject({ ...pathBase, ...targetOp, type: z.literal('fill'), value: dataValue, result: z.literal('completed') }),
  z.strictObject({ ...pathBase, ...targetOp, type: z.literal('select_option'), value: dataValue, result: z.literal('completed') }),
  z.strictObject({ ...pathBase, type: z.literal('wait_for'), condition: WaitConditionSchema,
    timeoutPolicyRef: id, bindingId: id.optional(), result: z.literal('satisfied') }),
  z.strictObject({ ...pathBase, ...targetOp, type: z.literal('assert_visible'), result: z.enum(['passed', 'failed']) }),
  z.strictObject({ ...pathBase, ...targetOp, type: z.literal('assert_text'), expectedText: z.string().max(2048),
    match: z.enum(['exact', 'contains']), result: z.enum(['passed', 'failed']) }),
  z.strictObject({ ...pathBase, ...targetOp, type: z.literal('assert_value'), expectedValue: dataValue,
    result: z.enum(['passed', 'failed']) }),
  z.strictObject({ ...pathBase, type: z.literal('assert_url'), expectedUrl: z.string().min(1).max(2048),
    match: z.enum(['exact', 'pattern']), result: z.enum(['passed', 'failed']) }),
  z.strictObject({ ...pathBase, type: z.literal('assert_link_collection'), linkName: semanticText,
    expectedCount: z.literal(2), expectedHref: httpUrl, result: z.enum(['passed', 'failed']) }),
]);
export type SuccessfulPathRecordV1 = z.infer<typeof SuccessfulPathRecordV1Schema>;

export const SuccessfulExplorationTraceV1Schema = z.strictObject({
  traceVersion: z.literal(SUCCESSFUL_TRACE_VERSION), successfulTraceId: id, ...owner.shape,
  sessionId: id, startStateDigest: digest, finalStateDigest: digest,
  startedAt: time, finishedAt: time,
  bindings: z.array(ExplorationTargetBindingV1Schema).max(80),
  successfulPath: z.array(SuccessfulPathRecordV1Schema).min(1).max(80),
  completedOriginStepIds: z.array(id).min(1).max(80),
});
export type SuccessfulExplorationTraceV1 = z.infer<typeof SuccessfulExplorationTraceV1Schema>;

/** Cross-context ownership is separate from the session-local frameId in a v1 binding. */
export const FrameOwnershipV2Schema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('main'), observationDigest: digest }),
  z.strictObject({ kind: z.literal('nested'), anchors: z.array(z.strictObject({
    identity: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('title'), value: semanticText, exact: z.literal(true) }),
      z.strictObject({ kind: z.literal('testId'), value: short, exact: z.literal(true) }),
    ]),
    ownerSnapshotDigest: digest, observedMatchCount: z.literal(1),
  })).min(1).max(8) }),
  z.strictObject({ kind: z.literal('unproven'),
    reasonCode: z.enum(['ambiguous_anchor', 'unsupported_anchor', 'missing_attestation']) }),
]);
export type FrameOwnershipV2 = z.infer<typeof FrameOwnershipV2Schema>;

export const TraceBindingV2Schema = z.strictObject({
  ...ExplorationTargetBindingV1Schema.shape,
  frameOwnership: FrameOwnershipV2Schema,
});
export type TraceBindingV2 = z.infer<typeof TraceBindingV2Schema>;

/** A private protected-browser witness, tied to this transition and its exact condition. */
export const PassiveConditionWitnessV2Schema = z.strictObject({
  kind: z.literal('protected_condition_check'),
  traceRecordId: id, timeoutPolicyRef: id,
  conditionDigest: digest, observationDigest: digest, observedStateDigest: digest,
  observedAt: time, satisfied: z.literal(true),
});
export const SuccessfulPathRecordV2Schema = z.discriminatedUnion('type', [
  z.strictObject({ ...pathBase, type: z.literal('state_observed'), result: z.literal('observed'),
    condition: WaitConditionSchema, timeoutPolicyRef: id, bindingId: id.optional(),
    witness: PassiveConditionWitnessV2Schema }),
  SuccessfulPathRecordV1Schema.options[1],
  SuccessfulPathRecordV1Schema.options[2],
  SuccessfulPathRecordV1Schema.options[3],
  SuccessfulPathRecordV1Schema.options[4],
  SuccessfulPathRecordV1Schema.options[5],
  SuccessfulPathRecordV1Schema.options[6],
  SuccessfulPathRecordV1Schema.options[7],
  SuccessfulPathRecordV1Schema.options[8],
  SuccessfulPathRecordV1Schema.options[9],
  SuccessfulPathRecordV1Schema.options[10],
]);
export type SuccessfulPathRecordV2 = z.infer<typeof SuccessfulPathRecordV2Schema>;

export const SuccessfulExplorationTraceV2Schema = z.strictObject({
  traceVersion: z.literal(SUCCESSFUL_TRACE_V2_VERSION), successfulTraceId: id, ...owner.shape,
  sessionId: id, startStateDigest: digest, finalStateDigest: digest,
  startedAt: time, finishedAt: time,
  bindings: z.array(TraceBindingV2Schema).max(80),
  successfulPath: z.array(SuccessfulPathRecordV2Schema).min(1).max(80),
  completedOriginStepIds: z.array(id).min(1).max(80),
});
export type SuccessfulExplorationTraceV2 = z.infer<typeof SuccessfulExplorationTraceV2Schema>;

/** Failed and recovery branches live only in protected developer diagnostics. */
export const ExplorationBranchDiagnosticV1Schema = z.strictObject({
  diagnosticVersion: z.literal(BRANCH_DIAGNOSTIC_VERSION), diagnosticId: id,
  ...owner.shape, sessionId: id, branchOrdinal: z.number().int().positive().max(1000),
  originStepId: id, snapshotDigest: digest,
  branchKind: z.enum(['failed_candidate', 'recovery', 'abandoned']),
  decisionCode: z.enum(['inspect', 'act', 'observe', 'evaluate', 'retry', 'recover', 'stop']),
  resultCode: z.enum(['wrong_target', 'no_progress', 'stale_ref', 'action_failed', 'state_changed',
    'budget_exhausted', 'environment_failure', 'recovered']),
  recoveredToRecordId: id.optional(),
});
export type ExplorationBranchDiagnosticV1 = z.infer<typeof ExplorationBranchDiagnosticV1Schema>;

export const ExplorationAttemptV3Schema = z.discriminatedUnion('status', [
  z.strictObject({ attemptVersion: z.literal(AGENTIC_ATTEMPT_VERSION), ...owner.shape,
    status: z.literal('path_established'), successfulTraceId: id, startedAt: time, finishedAt: time }),
  z.strictObject({ attemptVersion: z.literal(AGENTIC_ATTEMPT_VERSION), ...owner.shape,
    status: z.enum(['path_unresolved', 'unsupported', 'environment_failed', 'cancelled']),
    reasonCode: z.enum(['TARGET_NOT_FOUND', 'BUDGET_EXHAUSTED', 'UNSUPPORTED_OPERATION',
      'NETWORK_POLICY_DENIED', 'BROWSER_UNAVAILABLE', 'PROVIDER_ERROR', 'PROVIDER_TIMEOUT',
      'MODEL_ERROR', 'CANCELLED']),
    startedAt: time, finishedAt: time }),
]);
export type ExplorationAttemptV3 = z.infer<typeof ExplorationAttemptV3Schema>;

export const CompilerCheckV1Schema = z.strictObject({
  checkId: id, traceRecordId: id,
  kind: z.enum(['closed_form', 'durable_identity', 'unique_match', 'selected_target',
    'profile_equivalence', 'ordered_postcondition']),
  result: z.enum(['passed', 'failed']),
  reasonCode: z.enum(['NONE', 'UNSUPPORTED_GRAMMAR', 'WEAK_IDENTITY', 'NON_UNIQUE_MATCH',
    'TARGET_MISMATCH', 'PROFILE_MISMATCH', 'POSTCONDITION_MISMATCH']),
  candidateDigest: digest.optional(),
  observedMatchCount: z.number().int().nonnegative().max(1000).optional(),
  selectedTargetMatches: z.boolean().optional(),
}).superRefine((check, context) => {
  if ((check.result === 'passed') !== (check.reasonCode === 'NONE')) {
    context.addIssue({ code: 'custom', path: ['reasonCode'], message: 'Check result and reason disagree' });
  }
  if (check.kind === 'unique_match' && (check.observedMatchCount === undefined ||
      (check.result === 'passed') !== (check.observedMatchCount === 1))) {
    context.addIssue({ code: 'custom', path: ['observedMatchCount'], message: 'Unique match check requires its count' });
  }
  if (check.kind === 'selected_target' && (check.selectedTargetMatches === undefined ||
      check.selectedTargetMatches !== (check.result === 'passed'))) {
    context.addIssue({ code: 'custom', path: ['selectedTargetMatches'], message: 'Target check requires correspondence' });
  }
});
export type CompilerCheckV1 = z.infer<typeof CompilerCheckV1Schema>;

export const CompilerAttemptV1Schema = z.strictObject({
  compilerVersion: z.literal(COMPILER_ATTEMPT_VERSION), compilerAttemptId: id,
  successfulTraceId: id, ...owner.shape, startedAt: time, finishedAt: time,
  checks: z.array(CompilerCheckV1Schema).min(1).max(480),
  result: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('accepted'), resolvedSpecId: id }),
    z.strictObject({ status: z.literal('rejected'), reasonCode: z.enum(['UNSUPPORTED_GRAMMAR',
      'WEAK_IDENTITY', 'NON_UNIQUE_MATCH', 'TARGET_MISMATCH', 'PROFILE_MISMATCH',
      'POSTCONDITION_MISMATCH', 'UNSUPPORTED_CAPABILITY']) }),
  ]),
});
export type CompilerAttemptV1 = z.infer<typeof CompilerAttemptV1Schema>;

/** V6 is deliberately separate: the existing runner still accepts only v2–v5. */
export const CompiledLocatorV1Schema = z.strictObject({
  origin: z.literal('verifiedTraceCompilation'),
  validatedForm: LocatorFormSchema,
  /** V6-only, root-to-leaf frame ownership independently verified by WP3. */
  framePath: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('title'), value: semanticText, exact: z.literal(true) }),
    z.strictObject({ kind: z.literal('testId'), value: short, exact: z.literal(true) }),
  ])).min(1).max(8).optional(),
  observed: z.strictObject({ role: short.optional(), accessibleName: z.string().max(512).optional(),
    matchCount: z.literal(1), selectedTargetMatches: z.literal(true) }),
  quality: z.strictObject({ status: z.literal('accepted'),
    identityBasis: z.enum(['role-and-accessible-name', 'scoped-role-and-accessible-name',
      'verified-label', 'verified-test-id']) }),
  rawMcpExpression: z.string().min(1).max(2048).optional(),
}).superRefine((locator, context) => {
  if (locator.framePath && locator.validatedForm.type === 'frame')
    context.addIssue({ code: 'custom', path: ['framePath'],
      message: 'V6 frame path and legacy frame locator cannot be combined' });
  let target = locator.validatedForm;
  while (target.type === 'frame' || target.type === 'within')
    target = target.target;
  const basis = locator.quality.identityBasis;
  const scoped = locator.validatedForm.type === 'within' || locator.validatedForm.type === 'frame' ||
    locator.framePath !== undefined;
  const valid = basis === 'role-and-accessible-name'
    ? !scoped && target.type === 'role' && target.exact === true &&
      target.role === locator.observed.role && target.name === locator.observed.accessibleName
    : basis === 'scoped-role-and-accessible-name'
      ? scoped && target.type === 'role' && target.exact === true &&
        target.role === locator.observed.role && target.name === locator.observed.accessibleName
      : basis === 'verified-label'
        ? target.type === 'label' && target.exact === true
        : target.type === 'testId';
  if (!valid) context.addIssue({ code: 'custom', path: ['quality', 'identityBasis'],
    message: 'Compiled locator identity basis contradicts its closed form or observed node' });
});
export type CompiledLocatorV1 = z.infer<typeof CompiledLocatorV1Schema>;

const compiledStepBase = {
  id, traceRecordId: id, originStepId: id,
  source: z.enum(['authored', 'discoveredPrerequisite']),
  prerequisiteReasonCode: z.enum(['expose_target', 'reach_state']).optional(),
};
const compiledTarget = { locatorId: id, locator: CompiledLocatorV1Schema };
export const CompiledExecutionStepV1Schema = z.discriminatedUnion('type', [
  z.strictObject({ ...compiledStepBase, type: z.literal('navigate'), url: httpUrl }),
  z.strictObject({ ...compiledStepBase, ...compiledTarget, type: z.literal('click') }),
  z.strictObject({ ...compiledStepBase, ...compiledTarget, type: z.literal('fill'), value: dataValue }),
  z.strictObject({ ...compiledStepBase, ...compiledTarget, type: z.literal('select_option'), value: dataValue }),
  z.strictObject({ ...compiledStepBase, ...compiledTarget, type: z.literal('assert_visible') }),
  z.strictObject({ ...compiledStepBase, ...compiledTarget, type: z.literal('assert_text'),
    expectedText: z.string().max(2048), match: z.enum(['exact', 'contains']) }),
  z.strictObject({ ...compiledStepBase, ...compiledTarget, type: z.literal('assert_value'), expectedValue: dataValue }),
  z.strictObject({ ...compiledStepBase, type: z.literal('assert_url'), expectedUrl: z.string().min(1).max(2048),
    match: z.enum(['exact', 'pattern']) }),
  z.strictObject({ ...compiledStepBase, type: z.literal('assert_link_collection'),
    linkName: semanticText, expectedCount: z.literal(2), expectedHref: httpUrl }),
  z.strictObject({ ...compiledStepBase, type: z.literal('wait_for'), condition: WaitConditionSchema,
    timeoutPolicyRef: id, locatorId: id.optional(), locator: CompiledLocatorV1Schema.optional() }),
]);
export type CompiledExecutionStepV1 = z.infer<typeof CompiledExecutionStepV1Schema>;

export const ResolvedTestSpecV6Schema = z.strictObject({
  schemaVersion: z.literal(AGENTIC_RESOLVED_VERSION), sourceSchemaVersion: TestSpecSchema.shape.schemaVersion,
  resolvedSpecId: id, ...owner.shape, successfulTraceId: id, compilerAttemptId: id,
  runtimeVersions: z.strictObject({ playwright: short, mcp: short, runner: short, compiler: short }),
  executionSteps: z.array(CompiledExecutionStepV1Schema).min(1).max(80),
});
export type ResolvedTestSpecV6 = z.infer<typeof ResolvedTestSpecV6Schema>;

export const AgenticOutcomeV1Schema = z.discriminatedUnion('boundary', [
  z.strictObject({ boundary: z.literal('exploration'), status: z.enum(['path_established', 'path_unresolved', 'unsupported']) }),
  z.strictObject({ boundary: z.literal('compilation'), status: z.enum(['accepted', 'durability_failed', 'unsupported']) }),
  z.strictObject({ boundary: z.literal('replay'), status: z.enum(['reproduced', 'not_reproduced', 'execution_failed']) }),
  z.strictObject({ boundary: z.literal('qa'), status: z.enum(['assertion_passed', 'assertion_failed']) }),
  z.strictObject({ boundary: z.literal('environment'), status: z.enum(['unavailable', 'policy_denied', 'cancelled']) }),
  z.strictObject({ boundary: z.literal('cleanup'), status: z.enum(['verified', 'unverified']) }),
]);
export type AgenticOutcomeV1 = z.infer<typeof AgenticOutcomeV1Schema>;

export interface AgenticContractContext {
  source: TestSpec;
  attempt: ExplorationAttemptV3;
  trace: SuccessfulExplorationTraceV1;
  compiler?: CompilerAttemptV1;
}
