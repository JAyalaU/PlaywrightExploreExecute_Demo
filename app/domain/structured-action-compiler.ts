import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ActionTargetIntentV1 } from './action-target-intent.js';
import { CompiledExecutionStepV1Schema } from './agentic-contracts.js';
import { type ProtectedTraceActionIdentitySourceV4, parseSuccessfulExplorationTraceV4,
  type SuccessfulExplorationTraceV4 } from './agentic-trace-v3.js';
import { assertionFromStrategyV1, CompilerStrategyLinkV2Schema,
  ResolvedVerificationStepV7Schema } from './goal-directed-compiler.js';
import { ExecutionProfileRefSchema, type LocatorForm } from './schema.js';
import { ContractValidationError, parseTestSpec } from './validate.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const short = z.string().min(1).max(256);
const time = z.iso.datetime();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const hash = (a: unknown) => createHash('sha256').update(JSON.stringify(a)).digest('hex');
function requireFact(value: boolean, message: string): asserts value {
  if (!value) throw new ContractValidationError(message);
}
const unique = (values: readonly string[]) => new Set(values).size === values.length;

/** Deterministic projection of accepted semantic identity, with no authored prose input. */
export function structuredActionLocatorForm(intent: ActionTargetIntentV1, role: string): LocatorForm {
  let form: LocatorForm = { type: 'role', role, name: intent.accessibleName, exact: true };
  for (const part of [...(intent.scope ?? [])].reverse()) {
    if (part.kind === 'frame') continue;
    const scope: LocatorForm = part.kind === 'row' ?
      { type: 'rowWithCell', cellName: part.description } :
      { type: 'role', role: part.kind, name: part.description, exact: true };
    form = { type: 'within', scope, target: form };
  }
  return form;
}

export const CompilerActionIdentityLinkV3Schema = z.strictObject({
  traceRecordId: id, sourceStepId: id, requestedIntentDigest: digest,
  selectedWitnessDigest: digest, resolvedStepId: id.optional(),
});
export const CompilerCheckV3Schema =
  z.strictObject({ checkId: id, traceRecordId: id,
    kind: z.enum(['profile_equivalence', 'ordered_postcondition', 'closed_form',
      'selected_target', 'strategy_correspondence',
      'fresh_observation', 'deterministic_representation',
      'structured_identity', 'fresh_identity', 'prerequisite_identity']),
    result: z.enum(['passed', 'failed']),
    reasonCode: z.enum(['NONE', 'PROFILE_MISMATCH', 'POSTCONDITION_MISMATCH',
      'UNSUPPORTED_REPRESENTATION', 'UNSUPPORTED_TEMPORAL_REPLAY',
      'UNSUPPORTED_RELATIONSHIP', 'UNPROVEN_IDENTITY', 'NON_UNIQUE_MATCH',
      'TARGET_MISMATCH', 'OBSERVATION_MISMATCH', 'ENVIRONMENT_FAILURE']),
    candidateDigest: digest.optional(),
  }).superRefine((check, context) => {
    if ((check.result === 'passed') !== (check.reasonCode === 'NONE'))
      context.addIssue({ code: 'custom', path: ['reasonCode'], message: 'Check result and reason disagree' });
  });
const reason = z.enum(['UNSUPPORTED_REPRESENTATION', 'UNSUPPORTED_TEMPORAL_REPLAY',
  'UNSUPPORTED_RELATIONSHIP', 'UNPROVEN_IDENTITY', 'NON_UNIQUE_MATCH',
  'TARGET_MISMATCH', 'OBSERVATION_MISMATCH', 'PROFILE_MISMATCH',
  'POSTCONDITION_MISMATCH', 'ENVIRONMENT_FAILURE']);
export const CompilerAttemptV3Schema = z.strictObject({
  compilerVersion: z.literal('3'), compilerAttemptId: id, successfulTraceId: id,
  testSpecId: id, explorationAttemptId: id, executionProfileRef: ExecutionProfileRefSchema,
  profileFingerprint: digest, startedAt: time, finishedAt: time, freshSessionId: id,
  strategyLinks: z.array(CompilerStrategyLinkV2Schema).max(80),
  actionIdentityLinks: z.array(CompilerActionIdentityLinkV3Schema).max(80),
  checks: z.array(CompilerCheckV3Schema).min(1).max(480),
  result: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('accepted'), resolvedSpecId: id }),
    z.strictObject({ status: z.literal('rejected'), reasonCode: reason, failedTraceRecordId: id }),
  ]),
});
export type CompilerAttemptV3 = z.infer<typeof CompilerAttemptV3Schema>;

export const ResolvedTestSpecV8Schema = z.strictObject({
  schemaVersion: z.literal('8'), sourceSchemaVersion: z.literal('5'),
  resolvedSpecId: id, testSpecId: id, explorationAttemptId: id,
  successfulTraceId: id, compilerAttemptId: id,
  executionProfileRef: ExecutionProfileRefSchema, profileFingerprint: digest,
  runtimeVersions: z.strictObject({ playwright: short, mcp: short, runner: short,
    compiler: z.literal('3') }),
  executionSteps: z.array(z.discriminatedUnion('type', [
    ...CompiledExecutionStepV1Schema.options, ResolvedVerificationStepV7Schema,
  ])).min(1).max(80),
});
export type ResolvedTestSpecV8 = z.infer<typeof ResolvedTestSpecV8Schema>;

function inputs(sourceInput: unknown, attemptInput: unknown, traceInput: unknown,
  proof: ProtectedTraceActionIdentitySourceV4) {
  const source = parseTestSpec(sourceInput);
  requireFact(source.schemaVersion === '5', 'Compiler v3 requires TestSpec v5');
  return { source, trace: parseSuccessfulExplorationTraceV4(traceInput, source, attemptInput, proof) };
}

function validateCompiler(compiler: CompilerAttemptV3, source: ReturnType<typeof parseTestSpec>,
  trace: SuccessfulExplorationTraceV4): void {
  requireFact(compiler.testSpecId === source.testSpecId &&
    compiler.explorationAttemptId === trace.explorationAttemptId &&
    compiler.successfulTraceId === trace.successfulTraceId &&
    same(compiler.executionProfileRef, trace.executionProfileRef) &&
    compiler.profileFingerprint === trace.profileFingerprint &&
    compiler.freshSessionId !== trace.sessionId &&
    Date.parse(compiler.startedAt) >= Date.parse(trace.finishedAt) &&
    Date.parse(compiler.startedAt) <= Date.parse(compiler.finishedAt),
  'Compiler v3 source/profile/fresh-context mismatch');
  const records = new Set(trace.successfulPath.map((entry) => entry.recordId));
  requireFact(unique(compiler.checks.map((entry) => entry.checkId)) &&
    compiler.checks.every((entry) => records.has(entry.traceRecordId)),
  'Compiler v3 checks are duplicated or outside the path');
  const goals = trace.successfulPath.filter((entry) => entry.type === 'verification_goal');
  requireFact(compiler.strategyLinks.length === goals.length &&
    unique(compiler.strategyLinks.map((entry) => entry.traceRecordId)),
  'Compiler v3 strategy links incomplete');
  for (const goal of goals) {
    const link = compiler.strategyLinks.find((entry) => entry.traceRecordId === goal.recordId);
    requireFact(!!link && link.goalStepId === goal.goalStepId &&
      link.strategyDigest === goal.strategyDigest && same(link.observationIds, goal.observationIds),
    'Compiler v3 strategy link mismatch');
  }
  requireFact(compiler.actionIdentityLinks.length === trace.actionIdentityProofs.length &&
    unique(compiler.actionIdentityLinks.map((entry) => entry.traceRecordId)),
  'Compiler v3 action links incomplete');
  for (const action of trace.actionIdentityProofs) {
    const link = compiler.actionIdentityLinks.find((entry) => entry.traceRecordId === action.recordId);
    requireFact(!!link && link.sourceStepId === action.requestedIntent.sourceStepId &&
      link.requestedIntentDigest === hash(action.requestedIntent) &&
      link.selectedWitnessDigest === action.selectedWitness.witnessDigest,
    'Compiler v3 action link mismatch');
  }
  if (compiler.result.status === 'rejected') {
    const rejected = compiler.result;
    const failed = trace.successfulPath.find((entry) => entry.recordId === rejected.failedTraceRecordId);
    requireFact(!!failed && compiler.checks.some((entry) => entry.traceRecordId === failed.recordId &&
      entry.result === 'failed' && entry.reasonCode === rejected.reasonCode) &&
      (rejected.reasonCode !== 'UNSUPPORTED_TEMPORAL_REPLAY' ||
        failed.type === 'verification_goal' && failed.comparison.kind === 'transition') &&
      (rejected.reasonCode !== 'UNSUPPORTED_RELATIONSHIP' ||
        failed.type === 'verification_goal' && source.steps.some((step) =>
          step.id === failed.originStepId && step.type === 'verification_goal' &&
          step.intent?.kind === 'relationship')) &&
      compiler.strategyLinks.every((entry) => !entry.assertionStepId) &&
      compiler.actionIdentityLinks.every((entry) => !entry.resolvedStepId),
    'Rejected compiler v3 contains an accepted path or lacks failed check');
    return;
  }
  requireFact(compiler.checks.every((entry) => entry.result === 'passed') &&
    compiler.checks.some((entry) => entry.kind === 'profile_equivalence') &&
    trace.successfulPath.every((record) => compiler.checks.some((entry) =>
      entry.traceRecordId === record.recordId && entry.kind === 'ordered_postcondition')),
  'Accepted compiler v3 lacks complete checks');
  for (const goal of goals) {
    const assertion = assertionFromStrategyV1(goal);
    requireFact(!!assertion && !!compiler.strategyLinks.find((entry) =>
      entry.traceRecordId === goal.recordId)?.assertionStepId &&
      ['strategy_correspondence', 'fresh_observation', 'deterministic_representation'].every((kind) =>
        compiler.checks.some((entry) => entry.traceRecordId === goal.recordId &&
          entry.kind === kind && entry.result === 'passed')) &&
      compiler.checks.some((entry) => entry.traceRecordId === goal.recordId &&
        entry.kind === 'deterministic_representation' && entry.candidateDigest === hash(assertion)),
    'Accepted compiler v3 lacks verified goal projection');
  }
  for (const record of trace.successfulPath) {
    if (!('bindingId' in record) || !record.bindingId) continue;
    const structured = record.source === 'authored' &&
      ['click', 'fill', 'select_option'].includes(record.type);
    requireFact(compiler.checks.some((entry) => entry.traceRecordId === record.recordId &&
      entry.kind === (structured ? 'structured_identity' : 'prerequisite_identity') &&
      entry.result === 'passed') &&
      ['closed_form', 'fresh_identity', 'selected_target'].every((kind) =>
        compiler.checks.some((entry) => entry.traceRecordId === record.recordId &&
          entry.kind === kind && entry.result === 'passed' && !!entry.candidateDigest)),
    'Accepted compiler v3 lacks fresh structured action proof');
  }
}

export function parseCompilerAttemptV3(input: unknown, sourceInput: unknown,
  attemptInput: unknown, traceInput: unknown,
  proof: ProtectedTraceActionIdentitySourceV4): CompilerAttemptV3 {
  const { source, trace } = inputs(sourceInput, attemptInput, traceInput, proof);
  const compiler = CompilerAttemptV3Schema.parse(input);
  validateCompiler(compiler, source, trace);
  return compiler;
}

export function parseResolvedTestSpecV8(input: unknown, sourceInput: unknown,
  attemptInput: unknown, traceInput: unknown, proof: ProtectedTraceActionIdentitySourceV4,
  compilerInput: unknown): ResolvedTestSpecV8 {
  const { source, trace } = inputs(sourceInput, attemptInput, traceInput, proof);
  const compiler = CompilerAttemptV3Schema.parse(compilerInput);
  validateCompiler(compiler, source, trace);
  const resolved = ResolvedTestSpecV8Schema.parse(input);
  requireFact(compiler.result.status === 'accepted' &&
    resolved.resolvedSpecId === compiler.result.resolvedSpecId &&
    resolved.testSpecId === source.testSpecId &&
    resolved.explorationAttemptId === trace.explorationAttemptId &&
    resolved.successfulTraceId === trace.successfulTraceId &&
    resolved.compilerAttemptId === compiler.compilerAttemptId &&
    same(resolved.executionProfileRef, trace.executionProfileRef) &&
    resolved.profileFingerprint === trace.profileFingerprint &&
    resolved.executionSteps.length === trace.successfulPath.length &&
    unique(resolved.executionSteps.map((step) => step.id)),
  'Resolved v8 provenance or ordered path mismatch');
  for (const [index, step] of resolved.executionSteps.entries()) {
    const record = trace.successfulPath[index]!;
    requireFact(step.traceRecordId === record.recordId && step.originStepId === record.originStepId &&
      step.source === record.source &&
      (step.type === record.type || record.type === 'state_observed' && step.type === 'wait_for'),
    'Resolved v8 changed action/verification order');
    if (record.type === 'verification_goal') {
      requireFact(step.type === 'verification_goal' && step.goalStepId === record.goalStepId &&
        same(step.assertion, assertionFromStrategyV1(record)) &&
        compiler.strategyLinks.some((link) => link.traceRecordId === record.recordId &&
          link.assertionStepId === step.id),
      'Resolved v8 changed verification strategy');
      continue;
    }
    requireFact(step.type !== 'verification_goal' &&
      step.prerequisiteReasonCode === record.prerequisiteReasonCode,
    'Resolved v8 changed action source');
    for (const key of ['url', 'value', 'expectedText', 'expectedValue', 'expectedUrl', 'match',
      'linkName', 'expectedCount', 'expectedHref', 'condition', 'timeoutPolicyRef'] as const)
      if (key in record || key in step)
        requireFact(same(Reflect.get(record, key), Reflect.get(step, key)),
          `Resolved v8 changed traced ${key}`);
    if (record.type === 'state_observed')
      requireFact(step.type === 'wait_for', 'Passive transition lost its wait');
    if (!('bindingId' in record) || !record.bindingId) {
      requireFact(!('locator' in step && step.locator), 'Untargeted step gained a locator');
      continue;
    }
    requireFact('locator' in step && !!step.locator &&
      'locatorId' in step && !!step.locatorId &&
      step.locator.rawMcpExpression === undefined,
    'Targeted v8 step lacks a closed locator or carries an MCP expression');
    const binding = trace.bindings.find((entry) => entry.bindingId === record.bindingId);
    requireFact(!!binding && binding.frameOwnership.kind !== 'unproven' &&
      (binding.frameOwnership.kind === 'main' ? step.locator.framePath === undefined :
        same(step.locator.framePath, binding.frameOwnership.anchors.map((entry) => entry.identity))),
    'Resolved v8 changed protected frame identity');
    const candidate = hash(step.locator.framePath ?
      { form: step.locator.validatedForm, framePath: step.locator.framePath } :
      step.locator.validatedForm);
    requireFact(compiler.checks.some((entry) => entry.traceRecordId === record.recordId &&
      entry.kind === 'fresh_identity' && entry.result === 'passed' &&
      entry.candidateDigest === candidate),
    'Resolved v8 locator differs from fresh checked candidate');
    const proofRecord = trace.actionIdentityProofs.find((entry) => entry.recordId === record.recordId);
    if (proofRecord) {
      const intent = proofRecord.requestedIntent;
      let leaf = step.locator.validatedForm;
      while (leaf.type === 'within' || leaf.type === 'frame') leaf = leaf.target;
      requireFact(record.source === 'authored' && leaf.type === 'role' && leaf.exact === true &&
        same(step.locator.validatedForm,
          structuredActionLocatorForm(intent, proofRecord.selectedWitness.selectedRole)) &&
        leaf.name === intent.accessibleName && leaf.role === proofRecord.selectedWitness.selectedRole &&
        (intent.role.kind === 'unspecified' || intent.role.value === leaf.role) &&
        step.locator.observed.role === leaf.role &&
        step.locator.observed.accessibleName === leaf.name &&
        !!compiler.actionIdentityLinks.find((link) => link.traceRecordId === record.recordId &&
          link.resolvedStepId === step.id),
      'Resolved v8 weakened structured requested identity');
    } else {
      requireFact(record.source === 'discoveredPrerequisite',
        'Authored action lacks structured identity proof');
      requireFact(same(step.locator.validatedForm, { type: 'role',
        role: binding.selectedNode.role, name: binding.selectedNode.accessibleName, exact: true }) &&
        step.locator.observed.role === binding.selectedNode.role &&
        step.locator.observed.accessibleName === binding.selectedNode.accessibleName,
      'Prerequisite locator differs from its own protected selected-node identity');
    }
  }
  return resolved;
}
