import { createHash } from 'node:crypto';
import {
  ActiveBindingContextSchema, AgenticOutcomeV1Schema, CompilerAttemptV1Schema,
  ExplorationAttemptV3Schema, ExplorationBranchDiagnosticV1Schema,
  ExplorationTargetBindingV1Schema, ResolvedTestSpecV6Schema,
  SuccessfulExplorationTraceV1Schema, SuccessfulExplorationTraceV2Schema,
  type CompilerAttemptV1, type ExplorationAttemptV3,
  type ExplorationBranchDiagnosticV1, type ExplorationTargetBindingV1,
  type ResolvedTestSpecV6, type SuccessfulExplorationTraceV1, type SuccessfulExplorationTraceV2,
} from './agentic-contracts.js';
import { type AuthoredStep } from './schema.js';
import { ContractValidationError, parseTestSpec } from './validate.js';

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ContractValidationError(message);
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function unique(values: readonly string[], label: string): void {
  requireCondition(new Set(values).size === values.length, `Duplicate ${label}`);
}
function sameOwner(a: { testSpecId: string; explorationAttemptId: string;
  executionProfileRef: unknown; profileFingerprint: string }, b: typeof a): boolean {
  return a.testSpecId === b.testSpecId && a.explorationAttemptId === b.explorationAttemptId &&
    same(a.executionProfileRef, b.executionProfileRef) && a.profileFingerprint === b.profileFingerprint;
}
function timeOrdered(startedAt: string, finishedAt: string): boolean {
  return Date.parse(startedAt) <= Date.parse(finishedAt);
}
function formDigest(form: unknown): string {
  return createHash('sha256').update(JSON.stringify(form)).digest('hex');
}
function targetOf(step: AuthoredStep): unknown {
  return step.type === 'wait_for' && 'target' in step.condition ? step.condition.target :
    'target' in step ? step.target : undefined;
}

export function parseExplorationAttemptV3(input: unknown, sourceInput: unknown): ExplorationAttemptV3 {
  const source = parseTestSpec(sourceInput);
  const attempt = ExplorationAttemptV3Schema.parse(input);
  requireCondition(attempt.testSpecId === source.testSpecId &&
    same(attempt.executionProfileRef, source.executionProfileRef), 'Exploration attempt source/profile mismatch');
  requireCondition(timeOrdered(attempt.startedAt, attempt.finishedAt), 'Exploration attempt time order invalid');
  if (attempt.status === 'path_unresolved')
    requireCondition(attempt.reasonCode === 'TARGET_NOT_FOUND' || attempt.reasonCode === 'BUDGET_EXHAUSTED',
      'Unresolved attempt reason mismatch');
  if (attempt.status === 'unsupported')
    requireCondition(attempt.reasonCode === 'UNSUPPORTED_OPERATION', 'Unsupported attempt reason mismatch');
  if (attempt.status === 'cancelled')
    requireCondition(attempt.reasonCode === 'CANCELLED', 'Cancelled attempt reason mismatch');
  if (attempt.status === 'environment_failed')
    requireCondition(attempt.reasonCode === 'NETWORK_POLICY_DENIED' ||
      attempt.reasonCode === 'BROWSER_UNAVAILABLE', 'Environmental attempt reason mismatch');
  return attempt;
}

/** Recheck against the current protected session immediately before acting. */
export function parseCurrentTargetBinding(input: unknown, activeInput: unknown,
  sourceInput: unknown): ExplorationTargetBindingV1 {
  const source = parseTestSpec(sourceInput);
  const binding = ExplorationTargetBindingV1Schema.parse(input);
  const active = ActiveBindingContextSchema.parse(activeInput);
  requireCondition(binding.testSpecId === source.testSpecId &&
    same(binding.executionProfileRef, source.executionProfileRef), 'Target binding source/profile mismatch');
  requireCondition(sameOwner(binding, active) && binding.sessionId === active.sessionId &&
    binding.pageId === active.pageId && binding.frameId === active.frameId &&
    binding.snapshotEpoch === active.snapshotEpoch && binding.snapshotDigest === active.snapshotDigest &&
    binding.selectedRef === active.selectedRef && same(binding.selectedNode, active.selectedNode),
  'Target binding stale or outside active protected session');
  if (binding.operation === 'click' || binding.operation === 'fill' || binding.operation === 'select_option')
    requireCondition(active.visible && active.enabled, 'Action target is not currently actionable');
  const authored = source.steps.find((step) => step.id === binding.originStepId);
  requireCondition(!!authored, 'Target binding origin absent');
  requireCondition(binding.justificationCode === 'discovered_prerequisite' ||
    (authored?.type === binding.operation && targetOf(authored) !== undefined),
  'Target binding operation or authored target mismatch');
  return binding;
}

export function parseSuccessfulExplorationTraceV1(input: unknown, sourceInput: unknown,
  attemptInput: unknown): SuccessfulExplorationTraceV1 {
  const source = parseTestSpec(sourceInput);
  const attempt = parseExplorationAttemptV3(attemptInput, source);
  const trace = SuccessfulExplorationTraceV1Schema.parse(input);
  requireCondition(attempt.status === 'path_established' &&
    attempt.successfulTraceId === trace.successfulTraceId && sameOwner(trace, attempt),
  'Successful trace and exploration attempt linkage mismatch');
  requireCondition(trace.sessionId.length > 0 && timeOrdered(trace.startedAt, trace.finishedAt) &&
    Date.parse(trace.startedAt) >= Date.parse(attempt.startedAt) &&
    Date.parse(trace.finishedAt) <= Date.parse(attempt.finishedAt), 'Successful trace time/session invalid');
  requireCondition(same(trace.completedOriginStepIds, source.steps.map((step) => step.id)),
    'Successful trace does not complete authored goals in order');
  unique(trace.bindings.map((binding) => binding.bindingId), 'target binding ID');
  unique(trace.successfulPath.map((record) => record.recordId), 'successful path record ID');
  const bindingMap = new Map(trace.bindings.map((binding) => [binding.bindingId, binding]));
  const usedBindings = new Set<string>();
  const authoredCounts = new Map<string, number>();
  let authoredIndex = 0;
  let state = trace.startStateDigest;
  for (const [index, record] of trace.successfulPath.entries()) {
    requireCondition(record.sequence === index + 1 && record.preStateDigest === state,
      'Successful path order or state chain invalid');
    if (record.observedEffect !== undefined)
      requireCondition(record.observedEffect === (record.preStateDigest === record.postStateDigest ?
        'state_unchanged' : 'state_changed'), 'Successful path observed effect contradicts state digests');
    unique(record.evidenceRefs ?? [], 'successful path evidence reference');
    requireCondition((record.evidenceRefs ?? []).every((ref) => ref.startsWith(
      `evidence/attempt-${trace.explorationAttemptId}/`)), 'Successful path evidence owner mismatch');
    state = record.postStateDigest;
    const authored = source.steps[authoredIndex];
    requireCondition(!!authored && record.originStepId === authored.id,
      'Successful path goal linkage is absent or out of order');
    if (record.source === 'authored') {
      requireCondition(record.prerequisiteReasonCode === undefined,
        'Authored path record cannot carry a prerequisite reason');
      requireCondition(record.type === authored.type, 'Successful path changed authored operation');
      authoredCounts.set(authored.id, (authoredCounts.get(authored.id) ?? 0) + 1);
      if (record.type === 'navigate' && authored.type === 'navigate')
        requireCondition(record.url === authored.url, 'Successful path changed authored URL');
      if ((record.type === 'fill' || record.type === 'select_option') && authored.type === record.type)
        requireCondition(same(record.value, authored.value), 'Successful path changed authored value');
      if (record.type === 'assert_url' && authored.type === 'assert_url')
        requireCondition(record.expectedUrl === authored.expectedUrl && record.match === authored.match,
          'Successful path changed authored URL assertion');
      if (record.type === 'assert_text' && authored.type === 'assert_text')
        requireCondition(record.expectedText === authored.expectedText && record.match === authored.match,
          'Successful path changed authored text assertion');
      if (record.type === 'assert_value' && authored.type === 'assert_value')
        requireCondition(same(record.expectedValue, authored.expectedValue), 'Successful path changed authored value assertion');
      if (record.type === 'assert_link_collection' && authored.type === 'assert_link_collection')
        requireCondition(record.linkName === authored.linkName && record.expectedCount === authored.expectedCount &&
          record.expectedHref === authored.expectedHref, 'Successful path changed link collection assertion');
      if (record.type === 'wait_for' && authored.type === 'wait_for')
        requireCondition(same(record.condition, authored.condition) &&
          record.timeoutPolicyRef === authored.timeoutPolicyRef, 'Successful path changed authored wait');
      authoredIndex += 1;
    } else {
      requireCondition(record.prerequisiteReasonCode !== undefined,
        'Discovered prerequisite requires a closed reason code');
      requireCondition(!record.type.startsWith('assert_'), 'Exploratory prerequisite cannot be an assertion');
    }
    if ('bindingId' in record && record.bindingId !== undefined) {
      const binding = bindingMap.get(record.bindingId);
      requireCondition(!!binding && sameOwner(binding, trace) && binding.sessionId === trace.sessionId &&
        binding.originStepId === record.originStepId && binding.operation === record.type,
      'Successful path binding mismatch');
      usedBindings.add(record.bindingId);
    } else if (record.type === 'click' || record.type === 'fill' || record.type === 'select_option' ||
      record.type === 'assert_visible' || record.type === 'assert_text' || record.type === 'assert_value' ||
      (record.type === 'wait_for' && 'target' in record.condition)) {
      throw new ContractValidationError('Targeted successful path operation lacks a binding');
    }
    if (record.type === 'wait_for' && !('target' in record.condition) && record.bindingId !== undefined)
      throw new ContractValidationError('URL wait cannot carry a target binding');
  }
  requireCondition(state === trace.finalStateDigest && authoredIndex === source.steps.length &&
    source.steps.every((step) => authoredCounts.get(step.id) === 1),
  'Successful path does not contain exactly one final operation per authored goal');
  requireCondition(usedBindings.size === trace.bindings.length,
    'Successful trace contains binding from an unsuccessful or unrecorded branch');
  return trace;
}

/** V2 keeps v1 goal/state validation, then validates the added protected provenance. */
export function parseSuccessfulExplorationTraceV2(input: unknown, sourceInput: unknown,
  attemptInput: unknown): SuccessfulExplorationTraceV2 {
  const trace = SuccessfulExplorationTraceV2Schema.parse(input);
  const passiveBindings = new Set(trace.successfulPath.flatMap((record) =>
    record.type === 'state_observed' && record.bindingId ? [record.bindingId] : []));
  const v1Projection = {
    ...trace, traceVersion: '1',
    bindings: trace.bindings.filter((binding) => !passiveBindings.has(binding.bindingId))
      .map(({ frameOwnership: _frameOwnership, ...binding }) => binding),
    successfulPath: trace.successfulPath.map((record) => {
      if (record.type !== 'state_observed') return record;
      const { condition: _condition, timeoutPolicyRef: _timeoutPolicyRef,
        bindingId: _bindingId, witness: _witness, ...historical } = record;
      return historical;
    }),
  };
  parseSuccessfulExplorationTraceV1(v1Projection, sourceInput, attemptInput);
  const attempt = parseExplorationAttemptV3(attemptInput, sourceInput);
  const bindings = new Map(trace.bindings.map((binding) => [binding.bindingId, binding]));
  const used = new Set<string>();
  for (const binding of trace.bindings) {
    requireCondition(Date.parse(binding.issuedAt) >= Date.parse(trace.startedAt) &&
      Date.parse(binding.issuedAt) <= Date.parse(trace.finishedAt),
    'V2 binding issue time outside protected attempt');
    if (binding.frameOwnership.kind === 'main')
      requireCondition(binding.frameOwnership.observationDigest === binding.snapshotDigest,
        'Main-frame attestation is not bound to the selected snapshot');
    if (binding.frameOwnership.kind === 'nested')
      requireCondition(binding.frameOwnership.anchors.every((anchor) =>
        anchor.observedMatchCount === 1), 'Nested frame anchor is ambiguous');
  }
  for (const record of trace.successfulPath) {
    if ('bindingId' in record && record.bindingId) {
      requireCondition(!used.has(record.bindingId), 'V2 target binding reused by multiple records');
      used.add(record.bindingId);
    }
    if (record.type !== 'state_observed') continue;
    requireCondition(record.source === 'discoveredPrerequisite' &&
      record.prerequisiteReasonCode === 'reach_state' &&
      record.preStateDigest !== record.postStateDigest,
    'Passive transition must be a changed-state discovered prerequisite');
    const witness = record.witness;
    requireCondition(witness.traceRecordId === record.recordId &&
      witness.timeoutPolicyRef === record.timeoutPolicyRef &&
      witness.conditionDigest === formDigest(record.condition) &&
      witness.observationDigest === record.observationDigest &&
      witness.observedStateDigest === record.postStateDigest &&
      Date.parse(witness.observedAt) >= Date.parse(trace.startedAt) &&
      Date.parse(witness.observedAt) <= Date.parse(trace.finishedAt) &&
      Date.parse(witness.observedAt) >= Date.parse(attempt.startedAt) &&
      Date.parse(witness.observedAt) <= Date.parse(attempt.finishedAt),
    'Passive transition condition lacks a linked protected satisfied observation');
    const targeted = 'target' in record.condition;
    requireCondition(targeted === (record.bindingId !== undefined),
      'Passive transition target/binding mismatch');
    if (record.bindingId) {
      const binding = bindings.get(record.bindingId);
      requireCondition(!!binding && sameOwner(binding, trace) &&
        binding.sessionId === trace.sessionId && binding.originStepId === record.originStepId &&
        binding.operation === 'wait_for' && Date.parse(binding.issuedAt) <= Date.parse(witness.observedAt),
      'Passive transition target witness has no current protected binding');
    }
  }
  requireCondition(used.size === trace.bindings.length,
    'V2 trace contains a binding outside its successful path');
  return trace;
}

export function parseExplorationBranchDiagnosticV1(input: unknown,
  sourceInput: unknown, attemptInput: unknown): ExplorationBranchDiagnosticV1 {
  const source = parseTestSpec(sourceInput);
  const attempt = parseExplorationAttemptV3(attemptInput, source);
  const diagnostic = ExplorationBranchDiagnosticV1Schema.parse(input);
  requireCondition(sameOwner(diagnostic, attempt) &&
    source.steps.some((step) => step.id === diagnostic.originStepId),
  'Private branch diagnostic owner or goal mismatch');
  return diagnostic;
}

export function parseCompilerAttemptV1(input: unknown, traceInput: unknown,
  sourceInput: unknown, attemptInput: unknown): CompilerAttemptV1 {
  const trace = (traceInput as { traceVersion?: unknown })?.traceVersion === '2' ?
    parseSuccessfulExplorationTraceV2(traceInput, sourceInput, attemptInput) :
    parseSuccessfulExplorationTraceV1(traceInput, sourceInput, attemptInput);
  const compiler = CompilerAttemptV1Schema.parse(input);
  requireCondition(compiler.successfulTraceId === trace.successfulTraceId && sameOwner(compiler, trace),
    'Compiler attempt trace/profile linkage mismatch');
  requireCondition(timeOrdered(compiler.startedAt, compiler.finishedAt) &&
    Date.parse(compiler.startedAt) >= Date.parse(trace.finishedAt), 'Compiler attempt time order invalid');
  unique(compiler.checks.map((check) => check.checkId), 'compiler check ID');
  const pathIds = new Set(trace.successfulPath.map((record) => record.recordId));
  requireCondition(compiler.checks.every((check) => pathIds.has(check.traceRecordId)),
    'Compiler check references a record outside the successful path');
  if (compiler.result.status === 'accepted') {
    requireCondition(compiler.checks.every((check) => check.result === 'passed'),
      'Accepted compiler attempt contains a failed check');
    for (const record of trace.successfulPath.filter((entry) => 'bindingId' in entry && entry.bindingId)) {
      const checks = compiler.checks.filter((check) => check.traceRecordId === record.recordId);
      requireCondition(['closed_form', 'durable_identity', 'unique_match', 'selected_target'].every((kind) =>
        checks.some((check) => check.kind === kind && check.result === 'passed' && !!check.candidateDigest)),
      'Accepted compiler attempt lacks targeted verification checks');
    }
    requireCondition(compiler.checks.some((check) => check.kind === 'profile_equivalence' && check.result === 'passed') &&
      trace.successfulPath.every((record) => compiler.checks.some((check) =>
        check.traceRecordId === record.recordId && check.kind === 'ordered_postcondition' && check.result === 'passed')),
    'Accepted compiler attempt lacks profile or ordered postcondition checks');
  } else {
    requireCondition(compiler.checks.some((check) => check.result === 'failed'),
      'Rejected compiler attempt requires a failed check');
  }
  return compiler;
}

export function parseResolvedTestSpecV6(input: unknown, sourceInput: unknown,
  attemptInput: unknown, traceInput: unknown, compilerInput: unknown): ResolvedTestSpecV6 {
  const source = parseTestSpec(sourceInput);
  const trace = (traceInput as { traceVersion?: unknown })?.traceVersion === '2' ?
    parseSuccessfulExplorationTraceV2(traceInput, source, attemptInput) :
    parseSuccessfulExplorationTraceV1(traceInput, source, attemptInput);
  const compiler = parseCompilerAttemptV1(compilerInput, trace, source, attemptInput);
  const resolved = ResolvedTestSpecV6Schema.parse(input);
  // Historical v1 passive observations contain digests only. V2 carries the
  // witnessed closed condition that WP3 must preserve as an ordered wait.
  requireCondition(trace.traceVersion === '2' ||
    !trace.successfulPath.some((record) => record.type === 'state_observed'),
    'Passive state transition has no verified closed replay representation');
  requireCondition(compiler.result.status === 'accepted' &&
    compiler.result.resolvedSpecId === resolved.resolvedSpecId &&
    resolved.successfulTraceId === trace.successfulTraceId &&
    resolved.compilerAttemptId === compiler.compilerAttemptId &&
    resolved.sourceSchemaVersion === source.schemaVersion && sameOwner(resolved, trace),
  'Resolved v6 trace/compiler/source/profile linkage mismatch');
  unique(resolved.executionSteps.map((step) => step.id), 'v6 execution step ID');
  unique(resolved.executionSteps.flatMap((step) => 'locatorId' in step && step.locatorId ? [step.locatorId] : []),
    'v6 locator ID');
  requireCondition(resolved.executionSteps.length === trace.successfulPath.length,
    'Resolved v6 must compile the entire successful path');
  for (const [index, step] of resolved.executionSteps.entries()) {
    const record = trace.successfulPath[index];
    requireCondition(!!record && step.traceRecordId === record.recordId &&
      step.originStepId === record.originStepId && step.source === record.source &&
      (step.type === record.type || (trace.traceVersion === '2' &&
        record.type === 'state_observed' && step.type === 'wait_for')),
      'Resolved v6 path order/source mismatch');
    requireCondition(step.source === 'authored' ? step.prerequisiteReasonCode === undefined :
      step.prerequisiteReasonCode !== undefined, 'Resolved v6 prerequisite reason mismatch');
    requireCondition(step.prerequisiteReasonCode === record.prerequisiteReasonCode,
      'Resolved v6 changed traced prerequisite reason');
    if (step.type === 'wait_for') {
      requireCondition(('target' in step.condition) === (step.locator !== undefined && step.locatorId !== undefined),
        'Resolved v6 wait locator does not match wait condition');
    }
    if ('locator' in step && step.locator) {
      requireCondition('bindingId' in record && !!record.bindingId,
        'Compiled locator has no successful current-state binding');
      const binding = trace.bindings.find((entry) => entry.bindingId === record.bindingId);
      requireCondition(!!binding, 'Compiled locator binding missing');
      if (trace.traceVersion === '2') {
        const v2Binding = trace.bindings.find((entry) => entry.bindingId === record.bindingId);
        requireCondition(!!v2Binding && v2Binding.frameOwnership.kind !== 'unproven',
          'Unproven frame ownership cannot authorize v6');
        requireCondition(v2Binding.frameOwnership.kind === 'main' ?
          step.locator.framePath === undefined :
          same(step.locator.framePath, v2Binding.frameOwnership.anchors.map((anchor) => anchor.identity)),
        'Compiled frame path differs from protected trace provenance');
      }
      const candidate = formDigest(step.locator.framePath ?
        { form: step.locator.validatedForm, framePath: step.locator.framePath } :
        step.locator.validatedForm);
      requireCondition(['closed_form', 'durable_identity', 'unique_match', 'selected_target'].every((kind) =>
        compiler.checks.some((check) => check.traceRecordId === record.recordId &&
          check.kind === kind && check.result === 'passed' && check.candidateDigest === candidate)),
      'Resolved v6 locator differs from independently checked candidate');
    }
    if ('bindingId' in record && record.bindingId && !('locator' in step && step.locator)) {
      throw new ContractValidationError('Targeted trace action lacks a compiled locator');
    }
    if (trace.traceVersion === '2' && record.type === 'state_observed' && 'condition' in record) {
      requireCondition(step.type === 'wait_for' && same(step.condition, record.condition) &&
        step.timeoutPolicyRef === record.timeoutPolicyRef,
      'Passive transition requires its recorded deterministic wait');
    }
    for (const key of ['url', 'value', 'expectedText', 'expectedValue', 'expectedUrl', 'match',
      'linkName', 'expectedCount', 'expectedHref', 'condition', 'timeoutPolicyRef'] as const) {
      if (key in record || key in step) {
        requireCondition(same(Reflect.get(record, key), Reflect.get(step, key)),
          `Resolved v6 changed traced ${key}`);
      }
    }
  }
  return resolved;
}

export function assertImmutableAgenticArtifact(previous: { [key: string]: unknown },
  candidate: { [key: string]: unknown }, idField: string): void {
  requireCondition(typeof previous[idField] === 'string' && typeof candidate[idField] === 'string',
    'Immutable artifact ID is missing');
  if (previous[idField] === candidate[idField] && !same(previous, candidate))
    throw new ContractValidationError(`Changed artifact requires a new ${idField}`);
}

export function parseAgenticOutcomeV1(input: unknown) { return AgenticOutcomeV1Schema.parse(input); }
