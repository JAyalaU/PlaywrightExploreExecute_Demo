import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CompiledExecutionStepV1Schema, type CompiledExecutionStepV1 } from './agentic-contracts.js';
import { SemanticObservationQueryV1Schema } from './observation-contracts.js';
import { parseSuccessfulExplorationTraceV3, type ProtectedTraceObservationSourceV3,
  type SuccessfulExplorationTraceV3, type SuccessfulVerificationRecordV3 } from './agentic-trace-v3.js';
import { ExecutionProfileRefSchema, type TestSpec } from './schema.js';
import { ContractValidationError, parseTestSpec } from './validate.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const short = z.string().min(1).max(256);
const time = z.iso.datetime();
const owner = z.strictObject({ testSpecId: id, explorationAttemptId: id,
  executionProfileRef: ExecutionProfileRefSchema, profileFingerprint: digest });
const assertionBase = { assertionVersion: z.literal('1'), sourceStrategyDigest: digest };

/** Closed replay language. No selector, expression, model text, or observation result is executable here. */
export const DeterministicVerificationAssertionV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({ ...assertionBase, kind: z.literal('semantic_count'),
    query: SemanticObservationQueryV1Schema,
    operator: z.enum(['equal', 'greater_than', 'at_least', 'at_most']),
    expected: z.number().int().min(0).max(10_000) }),
  z.strictObject({ ...assertionBase, kind: z.literal('unique_boolean_property'),
    query: SemanticObservationQueryV1Schema,
    property: z.enum(['visible', 'enabled', 'checked', 'expanded', 'selected']),
    expected: z.boolean() }),
  z.strictObject({ ...assertionBase, kind: z.literal('unique_string_property'),
    query: SemanticObservationQueryV1Schema, property: z.enum(['text', 'value']),
    operator: z.enum(['equal', 'contains']), expected: z.string().max(2048) }),
  z.strictObject({ ...assertionBase, kind: z.literal('url'),
    operator: z.enum(['equal', 'url_prefix']), expected: z.string().min(1).max(2048) })
    .superRefine((value, context) => {
      const pattern = value.operator === 'url_prefix';
      if (pattern ? !value.expected.endsWith('/*') ||
          value.expected.slice(0, -2).includes('*') || /[?#]/.test(value.expected) :
        value.expected.includes('*')) {
        context.addIssue({ code: 'custom', path: ['expected'], message: 'Invalid reviewed URL comparison' });
        return;
      }
      try {
        const url = new URL(pattern ? value.expected.slice(0, -1) : value.expected);
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname ||
          url.username || url.password || pattern && !url.pathname.endsWith('/'))
          throw new Error('Invalid reviewed URL');
      } catch {
        context.addIssue({ code: 'custom', path: ['expected'], message: 'Invalid reviewed URL comparison' });
      }
    }),
]);
export type DeterministicVerificationAssertionV1 = z.infer<typeof DeterministicVerificationAssertionV1Schema>;

export const ResolvedVerificationStepV7Schema = z.strictObject({
  id, traceRecordId: id, originStepId: id, source: z.literal('authored'),
  type: z.literal('verification_goal'), goalStepId: id,
  assertion: DeterministicVerificationAssertionV1Schema,
});
export const RESOLVED_TEST_SPEC_V7_VERSION = '7' as const;
export const ResolvedTestSpecV7Schema = z.strictObject({
  schemaVersion: z.literal(RESOLVED_TEST_SPEC_V7_VERSION), sourceSchemaVersion: z.literal('4'),
  resolvedSpecId: id, ...owner.shape, successfulTraceId: id, compilerAttemptId: id,
  runtimeVersions: z.strictObject({ playwright: short, mcp: short, runner: short, compiler: short }),
  executionSteps: z.array(z.discriminatedUnion('type', [
    ...CompiledExecutionStepV1Schema.options, ResolvedVerificationStepV7Schema,
  ])).min(1).max(80),
});
export type ResolvedTestSpecV7 = z.infer<typeof ResolvedTestSpecV7Schema>;

export const COMPILER_ATTEMPT_V2_VERSION = '2' as const;
export const CompilerCheckV2Schema = z.strictObject({
  checkId: id, traceRecordId: id,
  kind: z.enum(['profile_equivalence', 'ordered_postcondition', 'closed_form',
    'durable_identity', 'unique_match', 'selected_target', 'strategy_correspondence',
    'fresh_observation', 'deterministic_representation']),
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
export const CompilerStrategyLinkV2Schema = z.strictObject({
  traceRecordId: id, goalStepId: id, strategyDigest: digest,
  observationIds: z.array(id).min(1).max(8),
  assertionStepId: id.optional(),
});
export const CompilerAttemptV2Schema = z.strictObject({
  compilerVersion: z.literal(COMPILER_ATTEMPT_V2_VERSION), compilerAttemptId: id,
  successfulTraceId: id, ...owner.shape, startedAt: time, finishedAt: time,
  freshSessionId: id, strategyLinks: z.array(CompilerStrategyLinkV2Schema).max(80),
  checks: z.array(CompilerCheckV2Schema).min(1).max(480),
  result: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('accepted'), resolvedSpecId: id }),
    z.strictObject({ status: z.literal('rejected'), reasonCode: z.enum([
      'UNSUPPORTED_REPRESENTATION', 'UNSUPPORTED_TEMPORAL_REPLAY',
      'UNSUPPORTED_RELATIONSHIP', 'UNPROVEN_IDENTITY', 'NON_UNIQUE_MATCH',
      'TARGET_MISMATCH', 'OBSERVATION_MISMATCH', 'PROFILE_MISMATCH',
      'POSTCONDITION_MISMATCH', 'ENVIRONMENT_FAILURE']),
      failedTraceRecordId: id }),
  ]),
});
export type CompilerAttemptV2 = z.infer<typeof CompilerAttemptV2Schema>;

function requireFact(value: boolean, message: string): asserts value {
  if (!value) throw new ContractValidationError(message);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique = (values: readonly string[]) => new Set(values).size === values.length;

/** This projection is exact. An evaluated-false strategy retains the requested comparison. */
export function assertionFromStrategyV1(record: SuccessfulVerificationRecordV3):
  DeterministicVerificationAssertionV1 | undefined {
  const comparison = record.comparison;
  if (comparison.kind === 'transition') return undefined;
  const observation = record.observations.find((item) => item.observationId === comparison.observationId);
  if (!observation || observation.status !== 'complete') return undefined;
  const base = { assertionVersion: '1' as const, sourceStrategyDigest: record.strategyDigest };
  if (comparison.kind === 'count' && observation.request.kind === 'semantic_query' &&
      observation.result.kind === 'matches')
    return { ...base, kind: 'semantic_count', query: observation.request.query,
      operator: comparison.operator, expected: comparison.expected };
  if (comparison.kind === 'boolean' && observation.request.kind === 'target_property' &&
      observation.result.kind === 'property' && observation.result.property === comparison.property)
    return { ...base, kind: 'unique_boolean_property', query: observation.request.query,
      property: comparison.property, expected: comparison.expected };
  if (comparison.kind === 'string' && observation.request.kind === 'target_property' &&
      observation.result.kind === 'property' && comparison.property !== 'url' &&
      comparison.operator !== 'url_prefix' && observation.result.property === comparison.property)
    return { ...base, kind: 'unique_string_property', query: observation.request.query,
      property: comparison.property, operator: comparison.operator, expected: comparison.expected };
  if (comparison.kind === 'string' && comparison.property === 'url' &&
      comparison.operator !== 'contains' && observation.request.kind === 'current_url' &&
      observation.result.kind === 'url')
    return { ...base, kind: 'url', operator: comparison.operator, expected: comparison.expected };
  return undefined;
}

function validatedInputs(sourceInput: unknown, attemptInput: unknown, traceInput: unknown,
  protectedSource: ProtectedTraceObservationSourceV3) {
  const source = parseTestSpec(sourceInput);
  requireFact(source.schemaVersion === '4', 'Compiler v2 requires TestSpec v4');
  const trace = parseSuccessfulExplorationTraceV3(traceInput, source, attemptInput, protectedSource);
  return { source, trace };
}

function validateCompiler(compiler: CompilerAttemptV2, source: TestSpec,
  trace: SuccessfulExplorationTraceV3): void {
  requireFact(compiler.testSpecId === source.testSpecId &&
    compiler.explorationAttemptId === trace.explorationAttemptId &&
    compiler.successfulTraceId === trace.successfulTraceId &&
    same(compiler.executionProfileRef, trace.executionProfileRef) &&
    compiler.profileFingerprint === trace.profileFingerprint &&
    compiler.freshSessionId !== trace.sessionId &&
    Date.parse(compiler.startedAt) >= Date.parse(trace.finishedAt) &&
    Date.parse(compiler.startedAt) <= Date.parse(compiler.finishedAt),
  'Compiler v2 source, profile, fresh context, or time mismatch');
  requireFact(unique(compiler.checks.map((check) => check.checkId)) &&
    unique(compiler.strategyLinks.map((link) => link.goalStepId)) &&
    unique(compiler.strategyLinks.map((link) => link.traceRecordId)),
  'Duplicate compiler check or strategy link');
  const pathIds = new Set(trace.successfulPath.map((record) => record.recordId));
  requireFact(compiler.checks.every((check) => pathIds.has(check.traceRecordId)),
    'Compiler check outside successful path');
  const goals = trace.successfulPath.filter((record) => record.type === 'verification_goal');
  requireFact(compiler.strategyLinks.length === goals.length, 'Compiler omitted a verification strategy');
  for (const record of goals) {
    const link = compiler.strategyLinks.find((item) => item.traceRecordId === record.recordId);
    requireFact(!!link && link.goalStepId === record.goalStepId &&
      link.strategyDigest === record.strategyDigest &&
      same(link.observationIds, record.observationIds), 'Compiler strategy linkage differs from trace');
  }
  if (compiler.result.status === 'accepted') {
    requireFact(compiler.checks.every((check) => check.result === 'passed') &&
      trace.successfulPath.every((record) => compiler.checks.some((check) =>
        check.traceRecordId === record.recordId && check.kind === 'ordered_postcondition' &&
        check.result === 'passed')) &&
      compiler.checks.some((check) => check.kind === 'profile_equivalence' && check.result === 'passed'),
    'Accepted compiler lacks ordered/profile checks');
    requireFact(unique(compiler.strategyLinks.map((link) => link.assertionStepId ?? '')),
      'Accepted compiler reused an assertion step ID');
    for (const record of goals) {
      const projection = assertionFromStrategyV1(record);
      requireFact(projection !== undefined &&
        ['strategy_correspondence', 'fresh_observation', 'deterministic_representation'].every((kind) =>
          compiler.checks.some((check) => check.traceRecordId === record.recordId &&
            check.kind === kind && check.result === 'passed')) &&
        !!compiler.strategyLinks.find((link) => link.traceRecordId === record.recordId)?.assertionStepId &&
        compiler.checks.some((check) => check.traceRecordId === record.recordId &&
          check.kind === 'deterministic_representation' && check.candidateDigest === hash(projection)),
      'Accepted compiler lacks representable, freshly checked strategy');
    }
    for (const record of trace.successfulPath) {
      if (!('bindingId' in record) || !record.bindingId) continue;
      requireFact(['closed_form', 'durable_identity', 'unique_match', 'selected_target'].every((kind) =>
        compiler.checks.some((check) => check.traceRecordId === record.recordId &&
          check.kind === kind && check.result === 'passed' && !!check.candidateDigest)),
      'Accepted compiler lacks targeted action checks');
    }
  } else {
    const rejection = compiler.result;
    const failedRecord = trace.successfulPath.find((record) =>
      record.recordId === rejection.failedTraceRecordId);
    requireFact(!!failedRecord &&
      (rejection.reasonCode !== 'UNSUPPORTED_TEMPORAL_REPLAY' ||
        failedRecord.type === 'verification_goal' &&
        failedRecord.comparison.kind === 'transition') &&
      (rejection.reasonCode !== 'UNSUPPORTED_REPRESENTATION' ||
        failedRecord.type === 'verification_goal' &&
        assertionFromStrategyV1(failedRecord) === undefined) &&
      (rejection.reasonCode !== 'UNSUPPORTED_RELATIONSHIP' ||
        failedRecord.type === 'verification_goal' &&
        source.steps.some((step) => step.id === failedRecord.originStepId &&
          step.type === 'verification_goal' && step.intent?.kind === 'relationship')),
    'Compiler rejection reason does not match source strategy');
    requireFact(compiler.checks.some((check) => check.traceRecordId === rejection.failedTraceRecordId &&
      check.result === 'failed' && check.reasonCode === rejection.reasonCode),
    'Rejected compiler lacks matching failed check');
    requireFact(compiler.strategyLinks.every((link) => link.assertionStepId === undefined),
      'Rejected compiler cannot contain accepted assertions');
  }
}

export function parseCompilerAttemptV2(input: unknown, sourceInput: unknown,
  attemptInput: unknown, traceInput: unknown,
  protectedSource: ProtectedTraceObservationSourceV3): CompilerAttemptV2 {
  const { source, trace } = validatedInputs(sourceInput, attemptInput, traceInput, protectedSource);
  const compiler = CompilerAttemptV2Schema.parse(input);
  validateCompiler(compiler, source, trace);
  return compiler;
}

export function parseResolvedTestSpecV7(input: unknown, sourceInput: unknown,
  attemptInput: unknown, traceInput: unknown, protectedSource: ProtectedTraceObservationSourceV3,
  compilerInput: unknown): ResolvedTestSpecV7 {
  const { source, trace } = validatedInputs(sourceInput, attemptInput, traceInput, protectedSource);
  const compiler = CompilerAttemptV2Schema.parse(compilerInput);
  validateCompiler(compiler, source, trace);
  const resolved = ResolvedTestSpecV7Schema.parse(input);
  requireFact(compiler.result.status === 'accepted' &&
    compiler.result.resolvedSpecId === resolved.resolvedSpecId &&
    resolved.testSpecId === source.testSpecId &&
    resolved.explorationAttemptId === trace.explorationAttemptId &&
    resolved.successfulTraceId === trace.successfulTraceId &&
    resolved.compilerAttemptId === compiler.compilerAttemptId &&
    same(resolved.executionProfileRef, trace.executionProfileRef) &&
    resolved.profileFingerprint === trace.profileFingerprint &&
    resolved.executionSteps.length === trace.successfulPath.length &&
    unique(resolved.executionSteps.map((step) => step.id)) &&
    unique(resolved.executionSteps.flatMap((step) => 'locatorId' in step && step.locatorId ?
      [step.locatorId] : [])),
  'Resolved v7 compiler/source/path linkage mismatch');
  for (const [index, step] of resolved.executionSteps.entries()) {
    const record = trace.successfulPath[index]!;
    requireFact(step.traceRecordId === record.recordId &&
      step.originStepId === record.originStepId && step.source === record.source &&
      (step.type === record.type || record.type === 'state_observed' && step.type === 'wait_for'),
    'Resolved v7 changed successful path order or operation');
    if (record.type === 'verification_goal') {
      requireFact(step.type === 'verification_goal' && step.goalStepId === record.goalStepId &&
        same(step.assertion, assertionFromStrategyV1(record)) &&
        compiler.strategyLinks.some((link) => link.traceRecordId === record.recordId &&
          link.assertionStepId === step.id) &&
        compiler.checks.some((check) => check.traceRecordId === record.recordId &&
          check.kind === 'deterministic_representation' && check.result === 'passed' &&
          check.candidateDigest === hash(step.assertion)),
      'Resolved v7 assertion weakens or changes the trusted strategy');
    } else {
      requireFact(step.type !== 'verification_goal', 'Action became verification');
      validateActionStep(step, record, trace, compiler);
    }
  }
  return resolved;
}

function validateActionStep(step: CompiledExecutionStepV1,
  record: Exclude<SuccessfulExplorationTraceV3['successfulPath'][number],
    { type: 'verification_goal' }>, trace: SuccessfulExplorationTraceV3,
  compiler: CompilerAttemptV2): void {
  requireFact(step.prerequisiteReasonCode === record.prerequisiteReasonCode,
    'Resolved v7 changed prerequisite reason');
  if (step.type === 'wait_for')
    requireFact(('target' in step.condition) === (step.locator !== undefined &&
      step.locatorId !== undefined), 'Resolved v7 wait locator disagrees with condition');
  if ('locator' in step && step.locator) {
    requireFact('bindingId' in record && !!record.bindingId,
      'Compiled action locator has no successful current-state binding');
    const binding = trace.bindings.find((item) => item.bindingId === record.bindingId);
    requireFact(!!binding && binding.frameOwnership.kind !== 'unproven',
      'Compiled action locator lacks proven protected frame ownership');
    requireFact(binding.frameOwnership.kind === 'main' ? step.locator.framePath === undefined :
      same(step.locator.framePath, binding.frameOwnership.anchors.map((anchor) => anchor.identity)),
    'Compiled action frame path differs from protected trace');
    const candidate = hash(step.locator.framePath ?
      { form: step.locator.validatedForm, framePath: step.locator.framePath } :
      step.locator.validatedForm);
    requireFact(['closed_form', 'durable_identity', 'unique_match', 'selected_target'].every((kind) =>
      compiler.checks.some((check) => check.traceRecordId === record.recordId &&
        check.kind === kind && check.result === 'passed' && check.candidateDigest === candidate)),
    'Resolved v7 action locator differs from independently checked candidate');
  }
  if ('bindingId' in record && record.bindingId && !('locator' in step && step.locator))
    throw new ContractValidationError('Targeted trace action lacks a compiled locator');
  if (record.type === 'state_observed')
    requireFact(step.type === 'wait_for' && same(step.condition, record.condition) &&
      step.timeoutPolicyRef === record.timeoutPolicyRef,
    'Passive transition requires its recorded deterministic wait');
  for (const key of ['url', 'value', 'expectedText', 'expectedValue', 'expectedUrl', 'match',
    'linkName', 'expectedCount', 'expectedHref', 'condition', 'timeoutPolicyRef'] as const)
    if (key in record || key in step)
      requireFact(same(Reflect.get(record, key), Reflect.get(step, key)),
        `Resolved v7 changed traced ${key}`);
}
