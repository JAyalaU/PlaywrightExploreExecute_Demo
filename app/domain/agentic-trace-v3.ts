import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SuccessfulExplorationTraceV2Schema, SuccessfulPathRecordV2Schema } from './agentic-contracts.js';
import { parseExplorationAttemptV3 } from './agentic-validate.js';
import { TrustedObservationResultV1Schema, type TrustedObservationResultV1 } from './observation-contracts.js';
import { type TestSpec } from './schema.js';
import { ContractValidationError, parseTestSpec } from './validate.js';
import { VerificationComparisonV1Schema, type VerificationComparisonV1 } from './verification-comparison.js';
import type { SuccessfulVerificationStrategyV1 } from '../interpretation/verification-strategy.js';
import { ActionIdentityWitnessV1Schema, parseActionIdentityWitnessV1,
  type ActionIdentityWitnessV1 } from './action-identity-witness.js';
import { ACTION_IDENTITY_ELIGIBLE_ROLES_V1 } from './action-target-intent.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Verification is a read-only path entry. It never carries a replay operator or QA verdict. */
export const SuccessfulVerificationRecordV3Schema = z.strictObject({
  type: z.literal('verification_goal'), recordId: id, sequence: z.number().int().positive(),
  source: z.literal('authored'), originStepId: id, goalStepId: id, goalDigest: digest,
  preStateDigest: digest, postStateDigest: digest,
  strategyDigest: digest, actionOrdinal: z.number().int().nonnegative(),
  observationIds: z.array(id).min(1).max(8),
  observations: z.array(TrustedObservationResultV1Schema).min(1).max(8),
  comparison: VerificationComparisonV1Schema, evaluated: z.boolean(),
  conclusion: z.enum(['satisfied', 'unsatisfied']),
  temporal: z.strictObject({ earlierObservationId: id, laterObservationId: id,
    transitionRecordIds: z.array(id).min(1).max(80) }).optional(),
});
export type SuccessfulVerificationRecordV3 = z.infer<typeof SuccessfulVerificationRecordV3Schema>;

export const SuccessfulPathRecordV3Schema = z.discriminatedUnion('type', [
  ...SuccessfulPathRecordV2Schema.options, SuccessfulVerificationRecordV3Schema,
]);
export type SuccessfulPathRecordV3 = z.infer<typeof SuccessfulPathRecordV3Schema>;

export const SUCCESSFUL_TRACE_V3_VERSION = '3' as const;
export const SuccessfulExplorationTraceV3Schema = z.strictObject({
  ...SuccessfulExplorationTraceV2Schema.shape,
  traceVersion: z.literal(SUCCESSFUL_TRACE_V3_VERSION),
  successfulPath: z.array(SuccessfulPathRecordV3Schema).min(1).max(80),
});
export type SuccessfulExplorationTraceV3 = z.infer<typeof SuccessfulExplorationTraceV3Schema>;

/** V4 keeps the ordered v3 action/verification path and adds requested/selected action proofs. */
export const SuccessfulExplorationTraceV4Schema = z.strictObject({
  ...SuccessfulExplorationTraceV3Schema.shape,
  traceVersion: z.literal('4'),
  actionIdentityProofs: z.array(z.strictObject({ recordId: id,
    requestedIntent: ActionIdentityWitnessV1Schema.shape.requestedIntent,
    selectedWitness: ActionIdentityWitnessV1Schema })).max(80),
});
export type SuccessfulExplorationTraceV4 = z.infer<typeof SuccessfulExplorationTraceV4Schema>;

/** Supplied only by the protected assembler, never by M7 or serialized trace input. */
export interface ProtectedTraceObservationSourceV3 {
  readObservation(observationId: string, goalStepId: string): {
    record: TrustedObservationResultV1;
    actionOrdinal: number;
    /** Number of successful path records completed when the fact was captured. */
    pathPosition: number;
    /** Protected action-path digest at capture. WP2 uses a separate state digest domain. */
    pathStateDigest: string;
    currentAtCapture: boolean;
    currentAtGoal: boolean;
  } | undefined;
  readStrategy(goalStepId: string): SuccessfulVerificationStrategyV1 | undefined;
}
export interface ProtectedTraceActionIdentitySourceV4 extends ProtectedTraceObservationSourceV3 {
  readActionWitness(bindingId: string): ActionIdentityWitnessV1 | undefined;
}

function requireFact(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ContractValidationError(message);
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function hash(a: unknown): string { return createHash('sha256').update(JSON.stringify(a)).digest('hex'); }
function unique(values: readonly string[], label: string): void {
  requireFact(new Set(values).size === values.length, `Duplicate ${label}`);
}
function operands(comparison: VerificationComparisonV1): string[] {
  return comparison.kind === 'transition' ?
    [comparison.earlierObservationId, comparison.laterObservationId] : [comparison.observationId];
}
function observedValue(record: TrustedObservationResultV1): number | boolean | string {
  requireFact(record.status === 'complete' && record.result.kind !== 'snapshot',
    'Verification observation is incomplete or not evidence grade');
  const result = record.result;
  requireFact(result.complete, 'Verification observation is incomplete');
  if (result.kind === 'matches') return result.count;
  requireFact(result.kind === 'url' || typeof result.value !== 'object',
    'Semantic object is not a comparison operand');
  return result.value as boolean | string;
}
function evaluate(comparison: VerificationComparisonV1, observations: readonly TrustedObservationResultV1[]): boolean {
  const later = observations.at(-1)!;
  if (comparison.kind === 'transition') {
    const earlier = observations[0]!;
    requireFact(earlier.status === 'complete' && later.status === 'complete' &&
      earlier.result.kind === 'matches' && later.result.kind === 'matches' &&
      earlier.request.kind === 'semantic_query' && later.request.kind === 'semantic_query' &&
      same(earlier.request.query, later.request.query), 'Temporal observations have incompatible queries');
    return comparison.operator === 'disappears' ?
      earlier.result.count > 0 && later.result.count === 0 :
      earlier.result.count === 0 && later.result.count > 0;
  }
  const value = observedValue(later);
  if (comparison.kind === 'count') {
    requireFact(later.status === 'complete' && later.result.kind === 'matches' &&
      later.request.kind === 'semantic_query', 'Count requires complete semantic query');
    const count = later.result.count;
    return comparison.operator === 'equal' ? count === comparison.expected :
      comparison.operator === 'greater_than' ? count > comparison.expected :
        comparison.operator === 'at_least' ? count >= comparison.expected : count <= comparison.expected;
  }
  if (comparison.kind === 'boolean') {
    requireFact(later.status === 'complete' && later.result.kind === 'property' &&
      later.request.kind === 'target_property' && later.result.property === comparison.property &&
      later.result.matchCount === 1 && typeof value === 'boolean',
    'Boolean comparison requires a unique matching property');
    return value === comparison.expected;
  }
  requireFact(later.status === 'complete' && typeof value === 'string' &&
    (comparison.property === 'url' ? later.result.kind === 'url' && later.request.kind === 'current_url' :
      later.result.kind === 'property' && later.request.kind === 'target_property' &&
      later.result.property === comparison.property), 'String comparison operand mismatch');
  requireFact(comparison.property === 'url' ? comparison.operator !== 'contains' :
    comparison.operator !== 'url_prefix', 'Unsupported string comparison');
  if (comparison.operator === 'url_prefix') {
    requireFact(comparison.expected.endsWith('/*') && !comparison.expected.slice(0, -2).includes('*'),
      'Invalid URL prefix');
    return value.startsWith(comparison.expected.slice(0, -1));
  }
  return comparison.operator === 'equal' ? value === comparison.expected :
    value.includes(comparison.expected);
}

function queryProven(record: TrustedObservationResultV1, goal: Extract<TestSpec['steps'][number],
  { type: 'verification_goal' }>): void {
  if (record.request.kind === 'current_url') {
    requireFact(!goal.subject, 'URL observation cannot prove a target subject');
    requireFact(record.frame.kind === 'main', 'URL frame provenance is unproven');
    return;
  }
  requireFact(record.request.kind === 'semantic_query' || record.request.kind === 'target_property',
    'Verification query is not evidence grade');
  const query = record.request.query;
  const subject = goal.subject;
  if (subject?.role) requireFact(query.role === subject.role, 'Verification role differs from goal');
  else requireFact(new RegExp(`\\b${query.role}\\b`, 'i').test(goal.sourceText) ||
    query.role === 'dialog' && /\bmodal\b/i.test(goal.sourceText),
  'Verification role is not authored');
  if (subject?.accessibleName)
    requireFact(query.name === subject.accessibleName, 'Verification name differs from goal');
  if (query.name) requireFact(goal.sourceText.toLocaleLowerCase('en-US').includes(
    query.name.toLocaleLowerCase('en-US')), 'Verification name is not authored');
  const authoredFrames = (subject?.scope ?? []).filter((scope) => scope.kind === 'frame');
  const authoredScopes = (subject?.scope ?? []).filter((scope) => scope.kind !== 'frame');
  requireFact(same(subject?.scope ?? [], [...authoredFrames, ...authoredScopes]),
    'Authored frame/scope order is not representable');
  requireFact((query.within ?? []).length === authoredScopes.length,
    'Verification scope is not proven');
  for (const [index, scope] of authoredScopes.entries()) {
    const selected = query.within?.[index];
    requireFact(!!selected && selected.kind === scope.kind &&
      (selected.kind === 'row' ? selected.cellName : selected.name) === scope.description,
    'Verification scope name or order differs from authored hint');
  }
  if (query.frame.kind === 'main') {
    requireFact(authoredFrames.length === 0 && record.frame.kind === 'main',
      'Observation frame owner differs from authored scope');
  } else {
    const anchors = query.frame.anchors;
    requireFact(authoredFrames.length === anchors.length &&
      authoredFrames.every((scope, index) => scope?.description === anchors[index]?.value) &&
      record.frame.kind === 'nested' &&
      same(anchors, record.frame.anchors.map(({ kind, value, exact }) =>
        ({ kind, value, exact }))) &&
      record.frame.anchors.every((anchor) => anchor.observedMatchCount === 1),
    'Nested frame ownership is unproven');
  }
}

/** Does not read the browser; the protected source attests capture and goal-time freshness. */
export function parseSuccessfulExplorationTraceV3(input: unknown, sourceInput: unknown,
  attemptInput: unknown, protectedSource: ProtectedTraceObservationSourceV3): SuccessfulExplorationTraceV3 {
  requireFact(!!protectedSource && typeof protectedSource.readObservation === 'function' &&
    typeof protectedSource.readStrategy === 'function', 'Protected observation source is required');
  const source = parseTestSpec(sourceInput);
  requireFact(source.schemaVersion === '4', 'Trace v3 requires TestSpec v4');
  const attempt = parseExplorationAttemptV3(attemptInput, source);
  const trace = SuccessfulExplorationTraceV3Schema.parse(input);
  validateSuccessfulPath(trace, source, attempt, protectedSource);
  return trace;
}

function validateSuccessfulPath(trace: SuccessfulExplorationTraceV3 | SuccessfulExplorationTraceV4,
  source: TestSpec, attempt: ReturnType<typeof parseExplorationAttemptV3>,
  protectedSource: ProtectedTraceObservationSourceV3): void {
  requireFact(attempt.status === 'path_established' &&
    attempt.successfulTraceId === trace.successfulTraceId &&
    trace.testSpecId === source.testSpecId && trace.testSpecId === attempt.testSpecId &&
    trace.explorationAttemptId === attempt.explorationAttemptId &&
    same(trace.executionProfileRef, source.executionProfileRef) &&
    same(trace.executionProfileRef, attempt.executionProfileRef) &&
    trace.profileFingerprint === attempt.profileFingerprint &&
    trace.sessionId.length > 0, 'Trace source/attempt ownership mismatch');
  requireFact(Date.parse(attempt.startedAt) <= Date.parse(trace.startedAt) &&
    Date.parse(trace.startedAt) <= Date.parse(trace.finishedAt) &&
    Date.parse(trace.finishedAt) <= Date.parse(attempt.finishedAt), 'Trace time outside attempt');
  requireFact(same(trace.completedOriginStepIds, source.steps.map((step) => step.id)),
    'Trace does not account for authored steps in order');
  unique(trace.successfulPath.map((record) => record.recordId), 'trace record ID');
  unique(trace.bindings.map((binding) => binding.bindingId), 'trace binding ID');
  const bindingById = new Map(trace.bindings.map((binding) => [binding.bindingId, binding]));
  const usedBindings = new Set<string>();
  let state = trace.startStateDigest;
  let authoredIndex = 0;
  for (const [index, record] of trace.successfulPath.entries()) {
    requireFact(record.sequence === index + 1 && record.preStateDigest === state,
      'Trace sequence or state chain invalid');
    if (record.type === 'verification_goal') {
      requireFact(record.postStateDigest === state,
        'Verification changed or misordered state');
    } else {
      if (record.observedEffect)
        requireFact(record.observedEffect === (record.preStateDigest === record.postStateDigest ?
          'state_unchanged' : 'state_changed'), 'Action effect contradicts state chain');
      for (const ref of record.evidenceRefs ?? [])
        requireFact(ref.startsWith(`evidence/attempt-${trace.explorationAttemptId}/`),
          'Evidence reference owner mismatch');
      const bindingId = 'bindingId' in record ? record.bindingId : undefined;
      if (bindingId) {
        const binding = bindingById.get(bindingId);
        requireFact(!!binding && !usedBindings.has(bindingId) &&
          binding.originStepId === record.originStepId && binding.operation === record.type &&
          binding.sessionId === trace.sessionId && binding.testSpecId === trace.testSpecId &&
          binding.explorationAttemptId === trace.explorationAttemptId &&
          binding.profileFingerprint === trace.profileFingerprint &&
          same(binding.executionProfileRef, trace.executionProfileRef) &&
          Date.parse(binding.issuedAt) >= Date.parse(trace.startedAt) &&
          Date.parse(binding.issuedAt) <= Date.parse(trace.finishedAt),
        'Action binding missing, reused, or mismatched');
        usedBindings.add(bindingId);
        if (trace.traceVersion === '4')
          requireFact(binding.justificationCode === (record.source === 'authored' ?
            'authored_target' : 'discovered_prerequisite'),
          'V4 action source and protected binding justification differ');
        if (binding.frameOwnership.kind === 'main')
          requireFact(binding.frameOwnership.observationDigest === binding.snapshotDigest,
            'Main action frame provenance mismatch');
        if (binding.frameOwnership.kind === 'nested')
          requireFact(binding.frameOwnership.anchors.every((anchor) => anchor.observedMatchCount === 1),
            'Nested action frame provenance ambiguous');
      } else if (['click', 'fill', 'select_option', 'assert_visible', 'assert_text',
        'assert_value'].includes(record.type) || record.type === 'wait_for' &&
          'target' in record.condition || record.type === 'state_observed' &&
          'target' in record.condition)
        throw new ContractValidationError('Targeted action lacks binding');
      if (record.type === 'state_observed') {
        requireFact(record.source === 'discoveredPrerequisite' &&
          record.prerequisiteReasonCode === 'reach_state' &&
          record.preStateDigest !== record.postStateDigest &&
          record.witness.traceRecordId === record.recordId &&
          record.witness.observationDigest === record.observationDigest &&
          record.witness.observedStateDigest === record.postStateDigest &&
          record.witness.conditionDigest === hash(record.condition) &&
          record.witness.timeoutPolicyRef === record.timeoutPolicyRef &&
          Date.parse(record.witness.observedAt) >= Date.parse(trace.startedAt) &&
          Date.parse(record.witness.observedAt) <= Date.parse(trace.finishedAt),
        'Passive action witness mismatch');
      }
    }
    state = record.postStateDigest;
    const authored = source.steps[authoredIndex];
    requireFact(!!authored && record.originStepId === authored.id,
      'Trace step is absent or out of authored order');
    if (record.source === 'discoveredPrerequisite') {
      requireFact(!!record.prerequisiteReasonCode &&
        !record.type.startsWith('assert_'), 'Invalid discovered prerequisite');
      continue;
    }
    requireFact(record.type === authored.type, 'Trace changed authored operation');
    if (record.type === 'verification_goal' && authored.type === 'verification_goal') {
      validateSuccessfulVerificationRecordV3(record, authored, trace, attempt, protectedSource,
        trace.successfulPath.slice(0, index));
    } else if (record.type !== 'verification_goal') {
      requireFact(record.prerequisiteReasonCode === undefined, 'Authored action has prerequisite reason');
      if (record.type === 'navigate' && authored.type === 'navigate')
        requireFact(record.url === authored.url, 'Trace changed authored URL');
      if ((record.type === 'fill' || record.type === 'select_option') && authored.type === record.type)
        requireFact(same(record.value, authored.value), 'Trace changed authored value');
      if (record.type === 'assert_text' && authored.type === 'assert_text')
        requireFact(record.expectedText === authored.expectedText && record.match === authored.match,
          'Trace changed authored text assertion');
      if (record.type === 'assert_url' && authored.type === 'assert_url')
        requireFact(record.expectedUrl === authored.expectedUrl && record.match === authored.match,
          'Trace changed authored URL assertion');
      if (record.type === 'assert_value' && authored.type === 'assert_value')
        requireFact(same(record.expectedValue, authored.expectedValue), 'Trace changed authored value assertion');
      if (record.type === 'assert_link_collection' && authored.type === 'assert_link_collection')
        requireFact(record.linkName === authored.linkName && record.expectedCount === authored.expectedCount &&
          record.expectedHref === authored.expectedHref, 'Trace changed authored link assertion');
      if (record.type === 'wait_for' && authored.type === 'wait_for')
        requireFact(same(record.condition, authored.condition) &&
          record.timeoutPolicyRef === authored.timeoutPolicyRef, 'Trace changed authored wait');
    }
    authoredIndex++;
  }
  requireFact(authoredIndex === source.steps.length && state === trace.finalStateDigest &&
    usedBindings.size === trace.bindings.length,
  'Trace omitted authored step, changed final state, or includes abandoned binding');
}

/** Readback validation never treats trace-embedded witnesses as authority. */
export function parseSuccessfulExplorationTraceV4(input: unknown, sourceInput: unknown,
  attemptInput: unknown, protectedSource: ProtectedTraceActionIdentitySourceV4): SuccessfulExplorationTraceV4 {
  requireFact(!!protectedSource && typeof protectedSource.readObservation === 'function' &&
    typeof protectedSource.readStrategy === 'function' &&
    typeof protectedSource.readActionWitness === 'function', 'Protected v4 sources required');
  const source = parseTestSpec(sourceInput);
  requireFact(source.schemaVersion === '5', 'Trace v4 requires TestSpec v5');
  const attempt = parseExplorationAttemptV3(attemptInput, source);
  const trace = SuccessfulExplorationTraceV4Schema.parse(input);
  validateSuccessfulPath(trace, source, attempt, protectedSource);
  unique(trace.actionIdentityProofs.map((proof) => proof.recordId), 'action identity proof record');
  unique(trace.actionIdentityProofs.map((proof) => proof.selectedWitness.witnessId), 'action identity witness');
  const required = trace.successfulPath.filter((record) => record.source === 'authored' &&
    (record.type === 'click' || record.type === 'fill' || record.type === 'select_option'));
  requireFact(trace.actionIdentityProofs.length === required.length,
    'Every authored target action requires one identity proof');
  for (const record of required) {
    const step = source.steps.find((item) => item.id === record.originStepId);
    const proof = trace.actionIdentityProofs.find((item) => item.recordId === record.recordId);
    requireFact(!!step && (step.type === 'click' || step.type === 'fill' || step.type === 'select_option') &&
      !!step.actionTargetIntent && !!proof && 'bindingId' in record,
    'Authored action identity missing');
    const witness = parseActionIdentityWitnessV1(proof.selectedWitness);
    const trusted = protectedSource.readActionWitness(record.bindingId!);
    const binding = trace.bindings.find((item) => item.bindingId === record.bindingId);
    requireFact(!!trusted && same(trusted, witness) && !!binding &&
      same(proof.requestedIntent, step.actionTargetIntent) &&
      same(witness.requestedIntent, proof.requestedIntent) &&
      witness.bindingId === binding.bindingId &&
      witness.sourceStepId === step.id && witness.operation === record.type &&
      witness.selectedRef === binding.selectedRef &&
      witness.selectedRole === binding.selectedNode.role &&
      witness.selectedAccessibleName === binding.selectedNode.accessibleName &&
      witness.snapshotEpoch === binding.snapshotEpoch &&
      witness.snapshotDigest === binding.snapshotDigest &&
      witness.pageId === binding.pageId && witness.frameId === binding.frameId &&
      witness.sessionId === trace.sessionId && witness.testSpecId === trace.testSpecId &&
      witness.explorationAttemptId === trace.explorationAttemptId &&
      witness.profileFingerprint === trace.profileFingerprint &&
      same(witness.executionProfileRef, trace.executionProfileRef) &&
      same(witness.frameOwnership, binding.frameOwnership) &&
      witness.stateDigest === record.preStateDigest &&
      Date.parse(witness.observedAt) >= Date.parse(trace.startedAt) &&
      Date.parse(witness.observedAt) >= Date.parse(binding.issuedAt) &&
      Date.parse(witness.observedAt) <= Date.parse(binding.issuedAt) + 10_000 &&
      Date.parse(witness.observedAt) <= Date.parse(trace.finishedAt),
    'Authored action identity witness mismatch');
    const intent = proof.requestedIntent;
    const eligibleRoles = ACTION_IDENTITY_ELIGIBLE_ROLES_V1[record.type];
    requireFact(intent.sourceStepId === step.id && intent.operation === record.type &&
      eligibleRoles.some((role) => role === witness.selectedRole) &&
      intent.accessibleName === witness.selectedAccessibleName &&
      (intent.role.kind === 'unspecified' || intent.role.value === witness.selectedRole) &&
      same(witness.scope ?? [], intent.scope ?? []) &&
      witness.frameOwnership.kind !== 'unproven' &&
      binding.frameOwnership.kind !== 'unproven' &&
      witness.eligibleMatchCount === 1 && witness.selectedReferenceMatches,
    'Requested action identity differs from selected node');
    const frames = (intent.scope ?? []).filter((part) => part.kind === 'frame');
    if (witness.frameOwnership.kind === 'main')
      requireFact(frames.length === 0, 'Authored frame scope changed');
    else if (witness.frameOwnership.kind === 'nested')
      requireFact(frames.length === witness.frameOwnership.anchors.length &&
        frames.every((part, index) => witness.frameOwnership.kind === 'nested' &&
          witness.frameOwnership.anchors[index]?.identity.kind === 'title' &&
          witness.frameOwnership.anchors[index]?.identity.value === part.description),
      'Authored frame scope changed');
  }
  requireFact(trace.actionIdentityProofs.every((proof) => required.some((record) =>
    record.recordId === proof.recordId)), 'Prerequisite claimed authored target identity');
  return trace;
}

/** Shared reviewed verification semantics; caller separately proves runtime origin. */
export function validateSuccessfulVerificationRecordV3(record: SuccessfulVerificationRecordV3,
  goal: Extract<TestSpec['steps'][number], { type: 'verification_goal' }>,
  trace: Pick<SuccessfulExplorationTraceV3, 'testSpecId' | 'explorationAttemptId' | 'sessionId' |
    'executionProfileRef' | 'profileFingerprint' | 'startStateDigest' | 'startedAt' | 'finishedAt'>,
  attempt: { startedAt: string; finishedAt: string },
  protectedSource: ProtectedTraceObservationSourceV3,
  pathPrefix: readonly { recordId: string; preStateDigest: string; postStateDigest: string }[]): void {
  requireFact(record.goalStepId === goal.id && record.goalDigest === hash(goal) &&
    record.conclusion === (record.evaluated ? 'satisfied' : 'unsatisfied'),
  'Verification goal or conclusion mismatch');
  const ids = operands(record.comparison);
  requireFact(same(record.observationIds, ids) &&
    record.observations.length === ids.length, 'Verification observation references missing or out of order');
  unique(ids, 'verification observation ID');
  const strategy = protectedSource.readStrategy(goal.id);
  requireFact(!!strategy && strategy.strategyDigest === record.strategyDigest &&
    strategy.goalStepId === goal.id && strategy.testSpecId === trace.testSpecId &&
    strategy.explorationAttemptId === trace.explorationAttemptId &&
    strategy.sessionId === trace.sessionId && strategy.actionOrdinal === record.actionOrdinal &&
    same(strategy.observationIds, ids) && same(strategy.comparison, record.comparison) &&
    strategy.evaluated === record.evaluated && strategy.conclusion === record.conclusion,
  'Verification strategy is missing or differs from protected journal');
  const { strategyDigest, ...strategyData } = strategy;
  requireFact(hash(strategyData) === strategyDigest, 'Verification journal digest mismatch');
  const captureOrdinals: number[] = [];
  const capturePositions: number[] = [];
  for (const [index, observation] of record.observations.entries()) {
    const id = ids[index]!;
    const trusted = protectedSource.readObservation(id, goal.id);
    requireFact(!!trusted && trusted.currentAtCapture &&
      trusted.record.observationId === id && same(trusted.record, observation),
    'Verification observation is missing or differs from protected runtime');
    requireFact(observation.status === 'complete' && observation.result.kind !== 'snapshot' &&
      observation.result.complete && observation.testSpecId === trace.testSpecId &&
      observation.explorationAttemptId === trace.explorationAttemptId &&
      observation.sessionId === trace.sessionId &&
      observation.executionProfileRef.id === trace.executionProfileRef.id &&
      observation.executionProfileRef.version === trace.executionProfileRef.version &&
      observation.profileFingerprint === trace.profileFingerprint &&
      observation.pageId === strategy.pageId &&
      Date.parse(observation.observedAt) >= Date.parse(trace.startedAt) &&
      Date.parse(observation.observedAt) <= Date.parse(trace.finishedAt) &&
      Date.parse(observation.observedAt) >= Date.parse(attempt.startedAt) &&
      Date.parse(observation.observedAt) <= Date.parse(attempt.finishedAt),
    'Verification observation owner, time, or completeness mismatch');
    // WP2 signs the pre-schema runtime construction order. Exact comparison
    // against its protected source record is the authority; reserializing the
    // parsed object would invent a different digest preimage.
    requireFact(Number.isInteger(trusted.actionOrdinal) && trusted.actionOrdinal >= 0 &&
      trusted.actionOrdinal <= record.actionOrdinal &&
      Number.isInteger(trusted.pathPosition) && trusted.pathPosition >= 0 &&
      trusted.pathPosition <= pathPrefix.length &&
      (trusted.pathPosition === 0 ? trace.startStateDigest :
        pathPrefix[trusted.pathPosition - 1]?.postStateDigest) === trusted.pathStateDigest,
    'Observation capture is outside its protected state');
    const compact = strategy.observations[index];
    requireFact(!!compact && compact.observationId === id &&
      same(compact.request, observation.request) &&
      same(compact.result, observation.result.kind === 'property' ?
        { kind: 'property', property: observation.result.property,
          value: observation.result.value, complete: true } : observation.result) &&
      compact.witnessDigest === observation.witnessDigest &&
      compact.sessionId === observation.sessionId && compact.pageId === observation.pageId &&
      compact.stateEpoch === observation.stateEpoch &&
      compact.mutationEpoch === observation.mutationEpoch &&
      compact.stateDigest === observation.stateDigest &&
      compact.observedAt === observation.observedAt && same(compact.frame, observation.frame),
    'Verification observation differs from successful strategy');
    queryProven(observation, goal);
    captureOrdinals.push(trusted.actionOrdinal);
    capturePositions.push(trusted.pathPosition);
    if (index === ids.length - 1)
      requireFact(trusted.currentAtGoal && trusted.actionOrdinal === record.actionOrdinal &&
        trusted.pathPosition === pathPrefix.length &&
        trusted.pathStateDigest === record.preStateDigest,
      'Latest verification evidence was stale at goal completion');
    else requireFact(record.comparison.kind === 'transition',
      'Historical evidence is only allowed for temporal verification');
  }
  if (record.comparison.kind === 'transition') {
    const earlier = record.observations[0]!;
    const later = record.observations[1]!;
    const between = pathPrefix.slice(capturePositions[0], capturePositions[1])
      .filter((entry) => entry.preStateDigest !== entry.postStateDigest);
    requireFact(!!record.temporal &&
      record.temporal.earlierObservationId === earlier.observationId &&
      record.temporal.laterObservationId === later.observationId &&
      capturePositions[0]! < capturePositions[1]! &&
      captureOrdinals[0]! < captureOrdinals[1]! &&
      same(record.temporal.transitionRecordIds, between.map((entry) => entry.recordId)) &&
      earlier.sessionId === later.sessionId && earlier.pageId === later.pageId &&
      earlier.stateEpoch < later.stateEpoch &&
      earlier.mutationEpoch < later.mutationEpoch &&
      Date.parse(earlier.observedAt) < Date.parse(later.observedAt) &&
      (goal.intent?.kind !== 'temporal' || goal.intent.transition === record.comparison.operator),
    'Temporal strategy lacks a valid present/action/absent transition');
  } else requireFact(record.temporal === undefined, 'Non-temporal comparison carries historical linkage');
  if (goal.intent?.kind === 'presence')
    requireFact(record.comparison.kind === 'count' &&
      (goal.intent.expected === 'absent' ? record.comparison.operator === 'equal' &&
        record.comparison.expected === 0 : record.comparison.operator === 'greater_than' &&
        record.comparison.expected === 0 || record.comparison.operator === 'at_least' &&
        record.comparison.expected === 1), 'Verification polarity changed');
  if (goal.intent?.kind === 'cardinality')
    requireFact(record.comparison.kind === 'count' &&
      record.comparison.operator === goal.intent.comparison &&
      record.comparison.expected === goal.intent.count, 'Cardinality goal changed');
  if (goal.intent?.kind === 'property')
    requireFact(record.comparison.kind === 'boolean' &&
      record.comparison.property === goal.intent.property &&
      record.comparison.expected === goal.intent.expected, 'Property goal changed');
  if (goal.intent?.kind === 'temporal')
    requireFact(record.comparison.kind === 'transition', 'Temporal intent was reduced to final state');
  if (goal.intent?.kind === 'relationship')
    throw new ContractValidationError('Unsupported relationship cannot enter successful trace');
  requireFact(record.evaluated === evaluate(record.comparison, record.observations),
    'Verification result disagrees with trusted observations');
}
